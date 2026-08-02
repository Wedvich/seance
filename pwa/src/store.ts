import type { RepoEntry, RescanResponse, SessionsResponse, SpawnRequest, SpawnResponse } from "@seance/shared";
import { RequestFailure, type RelayClient } from "./relay/client.ts";
import {
  DEFAULT_FORM,
  type Effort,
  type Model,
  type PendingSpawn,
  type PersistedForm,
  type SheetKind,
  type Verdict,
} from "./state.ts";
import type { AppState } from "./view.ts";
import { resolveMachine, resolveRepo } from "./view.ts";

/**
 * Owns the screen's state and the orchestration the transport deliberately
 * doesn't: which machines to ask for sessions, when to refresh, and what a
 * spawn outcome means.
 *
 * It also pushes history entries when a layer opens, so Android back closes the
 * sheet, leaves settings, or leaves the verdict instead of exiting the app.
 * Keeping that here rather than in a component is what keeps push and pop
 * symmetrical.
 */
export class Store {
  readonly #client: RelayClient;
  readonly #listeners = new Set<() => void>();
  #state: AppState;
  /**
   * deviceId -> lastSeen when its sessions were last requested. Keyed on
   * lastSeen (advanced only by a register at the relay) rather than the
   * connected flag, so a proven-offline mark clearing does not read as a wake —
   * blaming a slow machine, re-polling it, and timing out again is a loop.
   * Entries survive a machine going offline for the same reason. Emptied
   * whenever the socket isn't open, which keeps every re-dial a full refresh.
   */
  #wokenAt = new Map<string, number>();
  #pending: PendingSpawn | null = null;

  constructor(client: RelayClient, form: PersistedForm = DEFAULT_FORM, pending: PendingSpawn | null = null) {
    this.#client = client;
    this.#pending = pending;
    this.#state = {
      relay: client.getState(),
      form,
      sheet: null,
      settings: false,
      spawning: false,
      rescanning: false,
      rescan: "idle",
      verdict: null,
      sessions: {},
    };
  }

  getState = (): AppState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Wires up relay and lifecycle listeners; returns a disposer. */
  attach(): () => void {
    const unsubscribe = this.#client.subscribe(() => this.#onRelay());
    const onVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      // An installed PWA is suspended constantly and the socket dies silently,
      // so a resume has to re-dial before anything else can be trusted.
      this.#client.reconnect();
    };
    document.addEventListener("visibilitychange", onVisible);
    this.#onRelay();
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }

  /** Same object back when nothing moved: `useState` bails out on reference equality. */
  #patch(next: Partial<AppState>): void {
    const keys = Object.keys(next) as readonly (keyof AppState)[];
    if (keys.every((key) => Object.is(this.#state[key], next[key]))) return;
    this.#state = { ...this.#state, ...next };
    for (const listener of this.#listeners) listener();
  }

  #onRelay(): void {
    const relay = this.#client.getState();
    this.#patch({ relay });
    if (relay.status !== "open") {
      // Forgotten rather than kept: a resume re-dials unconditionally and the
      // registry that follows names the same machines, so leaving the map in
      // place means nothing ever counts as woken again and the session lists
      // stay at whatever the very first connect saw.
      this.#wokenAt = new Map();
      return;
    }

    const connected = relay.machines.filter((machine) => machine.connected);
    const woken = connected.filter((machine) => this.#wokenAt.get(machine.deviceId) !== machine.lastSeen);
    for (const machine of connected) this.#wokenAt.set(machine.deviceId, machine.lastSeen);
    if (woken.length > 0) void this.#fetchSessions(woken.map((machine) => machine.deviceId));
    if (this.#pending !== null) void this.#reconcile();
  }

  async #fetchSessions(deviceIds: readonly string[]): Promise<void> {
    await Promise.all(
      deviceIds.map(async (deviceId) => {
        try {
          const reply = await this.#client.request<SessionsResponse>(deviceId, "sessions", {});
          this.#patch({
            sessions: { ...this.#state.sessions, [deviceId]: { sessions: reply.sessions, at: reply.at } },
          });
        } catch {
          // "unknown" rather than zero: an unanswered machine is not an idle one.
          // Skipped once it already reads that, or a machine that keeps timing
          // out re-renders the app on every attempt to say the same thing.
          if (this.#state.sessions[deviceId] === "unknown") return;
          this.#patch({ sessions: { ...this.#state.sessions, [deviceId]: "unknown" } });
        }
      }),
    );
  }

  /**
   * A spawn reply is lost if the app is backgrounded while the daemon works, and
   * a blind relay cannot queue it. The honest recovery is to ask the machine what
   * is running rather than guess, or claim a failure that may be a live session.
   */
  async #reconcile(): Promise<void> {
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    const machine = this.#state.relay.machines.find((entry) => entry.deviceId === pending.machineId);
    let count: number | null = null;
    try {
      const reply = await this.#client.request<SessionsResponse>(pending.machineId, "sessions", {});
      count = reply.sessions.length;
      this.#patch({
        sessions: { ...this.#state.sessions, [pending.machineId]: { sessions: reply.sessions, at: reply.at } },
      });
    } catch {
      count = null;
    }
    this.#showVerdict({
      kind: "unknown",
      reason: "dropped",
      machine: machine?.name ?? "that machine",
      sessionCount: count,
    });
    this.#patch({ spawning: false });
  }

  setPrompt(prompt: string): void {
    this.#patch({ form: { ...this.#state.form, prompt } });
  }

  /** Restores that machine's last repo (falling back to its first) and clears any verdict. */
  selectMachine(machineId: string): void {
    this.#patch({ form: { ...this.#state.form, machineId }, verdict: null });
    this.dismissLayer();
  }

  /**
   * Drops an offline machine from the list. The sheet stays open: removing several
   * stale machines in a row is the normal case, and the list re-renders under it.
   */
  removeMachine(machineId: string): void {
    this.#client.hide(machineId);
  }

  selectRepo(repo: string): void {
    const { form, relay } = this.#state;
    // Keyed by the resolved machine, not form.machineId, which is null until picked.
    const machine = resolveMachine(relay, form.machineId);
    const repos = machine === null ? form.repos : { ...form.repos, [machine.deviceId]: repo };
    this.#patch({ form: { ...form, repos } });
    this.dismissLayer();
  }

  setModel(model: Model): void {
    this.#patch({ form: { ...this.#state.form, model } });
    this.dismissLayer();
  }

  setEffort(effort: Effort): void {
    this.#patch({ form: { ...this.#state.form, effort } });
    this.dismissLayer();
  }

  toggleWorktree(): void {
    this.#patch({ form: { ...this.#state.form, worktree: !this.#state.form.worktree } });
  }

  openSheet(sheet: SheetKind): void {
    history.pushState({ seance: "layer" }, "");
    this.#patch({ sheet });
  }

  /** The settings screen is a layer like the sheets: one entry, popped by back. */
  openSettings(): void {
    history.pushState({ seance: "layer" }, "");
    this.#patch({ settings: true });
  }

  /** Always via history, so the entry pushed when the layer opened is consumed. */
  dismissLayer(): void {
    if (this.#state.sheet === null && this.#state.verdict === null && !this.#state.settings) return;
    history.back();
  }

  /** Called from the popstate listener; clears whichever layer is showing. */
  onPopState(): void {
    const sheet = this.#state.sheet;
    if (sheet !== null) {
      // Cleared on the way out, not on the next open: a failure that landed while
      // another layer was up would otherwise be reset before it was ever shown.
      const rescan = sheet === "repo" && this.#state.rescan === "failed" ? "idle" : this.#state.rescan;
      this.#patch({ sheet: null, rescan });
      return;
    }
    if (this.#state.settings) {
      this.#patch({ settings: false });
      return;
    }
    if (this.#state.verdict !== null) this.#patch({ verdict: null });
  }

  #showVerdict(verdict: Verdict): void {
    history.pushState({ seance: "layer" }, "");
    this.#patch({ verdict });
  }

  async rescan(): Promise<void> {
    const machine = resolveMachine(this.#state.relay, this.#state.form.machineId);
    if (machine === null || this.#state.rescan === "scanning") return;
    this.#patch({ rescan: "scanning" });
    try {
      await this.#rescan(machine.deviceId);
      this.#patch({ rescan: "idle" });
    } catch {
      // The previous list stays in place — the truth we had — with the failure said inline.
      this.#patch({ rescan: "failed" });
    }
  }

  /**
   * The reply is the only report of a scan that changed nothing: the daemon
   * re-registers just when the repo set moved, so waiting for a registry push
   * would leave the row asserting the previous scan's time.
   */
  async #rescan(deviceId: string): Promise<readonly RepoEntry[]> {
    const reply = await this.#client.request<RescanResponse>(deviceId, "rescan", {});
    this.#client.applyScan(deviceId, reply.repos, reply.scannedAt);
    return reply.repos;
  }

  async spawn(): Promise<void> {
    const { relay, form } = this.#state;
    const machine = resolveMachine(relay, form.machineId);
    const repo = resolveRepo(machine, form);
    if (machine === null || repo === null || !machine.connected || this.#state.spawning) return;

    const prompt = form.prompt.trim();
    // `title` is deliberately absent: the daemon derives the window name from the
    // prompt slug, which is the shape the design shows.
    const request: SpawnRequest = {
      repo: repo.name,
      mode: form.worktree ? "worktree" : "here",
      model: form.model,
      effort: form.effort,
      ...(prompt === "" ? {} : { prompt }),
    };

    this.#pending = { machineId: machine.deviceId, repo: repo.name, requestedAt: Date.now() };
    this.#patch({ spawning: true, verdict: null });
    try {
      const reply = await this.#client.request<SpawnResponse>(machine.deviceId, "spawn", request);
      this.#pending = null;
      if (reply.ok) {
        // Cleared now rather than on "Start another": the success verdict never
        // shows the prompt and that button clears it anyway, so this only stops a
        // reload hours later from resurrecting a draft already acted on.
        this.#patch({
          form: { ...this.#state.form, prompt: "" },
          sessions: { ...this.#state.sessions, [machine.deviceId]: { sessions: reply.sessions, at: Date.now() } },
        });
        this.#showVerdict({
          kind: "ok",
          window: reply.window,
          ...(reply.note === undefined ? {} : { note: reply.note }),
          ...(prompt === "" ? {} : { prompt }),
        });
      } else {
        this.#showVerdict({ kind: "failed", code: reply.code, message: reply.message, repo: repo.name });
      }
    } catch (err) {
      const reason = err instanceof RequestFailure ? err.reason : "disconnected";
      if (reason === "offline" || reason === "unknown") {
        this.#pending = null;
        this.#showVerdict({ kind: "unknown", reason: "undelivered", machine: machine.name, sessionCount: null });
      } else {
        // Left pending on purpose: the daemon may well have started a session, and
        // #reconcile will ask once there is a socket again.
        this.#showVerdict({ kind: "unknown", reason: "dropped", machine: machine.name, sessionCount: null });
      }
    } finally {
      this.#patch({ spawning: false });
    }
  }

  /** Clears the prompt and returns to the form. */
  startAnother(): void {
    this.#patch({ form: { ...this.#state.form, prompt: "" } });
    this.dismissLayer();
  }

  /**
   * Restores the spawned prompt to the form and returns to it. Takes the verdict
   * the view rendered rather than reading state: the rendered one outlives
   * `state.verdict` by the exit animation, and a keyboard activation inside that
   * window would otherwise restore nothing.
   */
  reusePrompt(verdict: Verdict): void {
    if (verdict.kind === "ok" && verdict.prompt !== undefined) {
      this.#patch({ form: { ...this.#state.form, prompt: verdict.prompt } });
    }
    this.dismissLayer();
  }

  /**
   * A repo_not_found retry rescans first — the button says so — and checks the
   * fresh list before spawning again, so a repo that is really gone gets a
   * conclusive verdict instead of the same failure in a loop. Takes the rendered
   * verdict for the same reason `reusePrompt` does.
   */
  retrySpawn(verdict: Verdict): void {
    this.dismissLayer();
    if (verdict.kind === "failed" && verdict.code === "repo_not_found") {
      void this.#rescanThenRetry(verdict);
      return;
    }
    void this.spawn();
  }

  async #rescanThenRetry(verdict: Extract<Verdict, { kind: "failed" }>): Promise<void> {
    const machine = resolveMachine(this.#state.relay, this.#state.form.machineId);
    if (machine === null) return;
    // Not `spawning`: nothing has been sent to the daemon yet, and a rescan can
    // hold the button for its full timeout — "Starting…" over that is a claim
    // the app cannot back.
    this.#patch({ rescanning: true });
    let repos: readonly RepoEntry[];
    try {
      repos = await this.#rescan(machine.deviceId);
    } catch {
      // Spawning anyway would ask the daemon to resolve the repo against the very
      // cache this failed to refresh: a second failure known in advance, and one
      // that would look identical to the first.
      this.#patch({ rescanning: false });
      this.#showVerdict({ ...verdict, rescan: "unreachable" });
      return;
    }
    this.#patch({ rescanning: false });
    if (!repos.some((repo) => repo.name === verdict.repo)) {
      this.#showVerdict({ ...verdict, rescan: "missing" });
      return;
    }
    await this.spawn();
  }

  reconnect(): void {
    this.#client.reconnect();
  }

  get pendingSpawn(): PendingSpawn | null {
    return this.#pending;
  }
}
