import type {
  BatchStrategy,
  DepAfter,
  MetricsErrorCode,
  MetricsReply,
  MetricsRequest,
  RepoEntry,
  RescanResponse,
  SessionsResponse,
  SpawnClient,
  SpawnRequest,
  SpawnResponse,
  Task,
  TaskSpec,
  TaskUntil,
} from "@seance/shared";
import {
  failureReasonText,
  queuedTask,
  RequestFailure,
  sentence,
  storeErrorText,
  storeFullUnreadableText,
  TASK_REQUEST_LIMITS,
  TASK_SPEC_LIMITS,
  withReportInstruction,
  type RelayClient,
} from "@seance/shared";
import {
  DEFAULT_FORM,
  DEFAULT_HISTORY_RANGE,
  RANGE_SPANS,
  TARGET_METRICS,
  type Effort,
  type HistoryRange,
  type HistoryResult,
  type HistoryTarget,
  type HistoryView,
  type Model,
  type PendingSpawn,
  type PersistedForm,
  type SheetKind,
  type Verdict,
} from "./state.ts";
import { accountSeries } from "./chart.ts";
import { SchedulerStore, taskRequest } from "./scheduler-store.ts";
import type { AppState } from "./view.ts";
import {
  autoRepos,
  deriveAutoAvailability,
  deriveReportedAvailability,
  resolveAutoRepo,
  resolveMachine,
  resolveRepo,
} from "./view.ts";

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
/**
 * History outlives the layers it was pushed for: a reload (the service worker's
 * update, saving credentials) or Android restoring a discarded PWA brings the
 * app back on a layer entry with nothing open. Back from there lands on another
 * entry the app has nothing to close for, so it neither exits nor visibly does
 * anything. So each entry names the document that pushed it, and how many
 * layers were open while it was current: one this document didn't push is
 * stale by definition, and its depth is how far back its own base lies. Entries
 * pushed before either was recorded read as depth one, so a run of them is
 * still skipped, one per popstate.
 */
type LayerEntry = { readonly owner: unknown; readonly depth: number };

function layerEntry(state: unknown): LayerEntry | null {
  if (typeof state !== "object" || state === null || !("seance" in state) || state.seance !== "layer") return null;
  const depth = "depth" in state ? state.depth : undefined;
  return {
    owner: "owner" in state ? state.owner : undefined,
    depth: typeof depth === "number" && Number.isInteger(depth) && depth > 0 ? depth : 1,
  };
}

const HISTORY_UNREADABLE = "Couldn't read the machine's answer. Update seanced and the app to matching versions.";

const HISTORY_ERRORS: Record<MetricsErrorCode, string> = {
  too_large: "Too much history for one answer. 24h asks for the fewest points.",
  invalid_request: "The machine refused the request. Update seanced and the app to matching versions.",
  internal_error: "The machine couldn't read its history store.",
};

const STORE_UNREADABLE = "Couldn't read the relay's answer. Update the app and the relay to matching versions.";

/**
 * Why a create's answer never came, without the shared line's "may have
 * landed anyway" (the verdict says that once, in its own words) and without
 * the store frame a timeout's message names.
 */
function enqueueFailureText(failure: RequestFailure): string {
  if (failure.reason === "timeout") return "The relay did not answer in time.";
  if (failure.reason === "dropped") return "Lost the relay connection after the task was sent.";
  return sentence(failureReasonText(failure));
}

/** How long a cleared prompt stays recoverable. Undo instead of a confirm dialog. */
export const UNDO_WINDOW_MS = 6000;

export class Store {
  readonly #client: RelayClient;
  readonly #listeners = new Set<() => void>();
  #state: AppState;
  #undoTimer: ReturnType<typeof setTimeout> | null = null;
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
  /** The last range picked, so opening another chart keeps it; a reload starts on a day again. */
  #historyRange: HistoryRange = DEFAULT_HISTORY_RANGE;
  /** Tells this document's history entries from ones a previous load left behind. */
  readonly #owner = crypto.randomUUID();
  /**
   * The entry a retried verdict leaves behind, kept for whatever layer opens next.
   * Retry can't go back instead: the back is delivered later, and a verdict that
   * lands first (a rescan with no socket fails at once) would be the one it closes.
   */
  #held = false;
  /** Whether the socket was open at the last relay change, so a re-dial reads as one. */
  #wasOpen = false;
  readonly #queue: SchedulerStore;

  constructor(client: RelayClient, form: PersistedForm = DEFAULT_FORM, pending: PendingSpawn | null = null) {
    this.#client = client;
    this.#queue = new SchedulerStore(
      client,
      () => this.#state,
      (next) => this.#patch(next),
    );
    this.#pending = pending;
    this.#state = {
      relay: client.getState(),
      form,
      promptUndo: null,
      sheet: null,
      settings: false,
      machines: false,
      history: null,
      spawning: false,
      rescanning: false,
      rescan: "idle",
      verdict: null,
      preview: null,
      sessions: {},
      queue: false,
      wide: false,
      queueView: null,
      taskAction: null,
      queueNotice: null,
      pausing: false,
      discarding: false,
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
    const unsubscribeQueue = this.#client.onQueueChanged((change) => this.#queue.onQueueChanged(change));
    this.#skipStaleEntries();
    this.#onRelay();
    return () => {
      unsubscribe();
      unsubscribeQueue();
      document.removeEventListener("visibilitychange", onVisible);
      this.#disarmUndo();
      this.#queue.dispose();
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
    // Pruned in the same patch as the registry that justifies it: patched apart,
    // subscribers get one render where the machine is gone but the selection
    // still names it.
    // Only an authoritative registry may prune — while it is unsettled an empty
    // `machines` means "no push yet", not "every machine vanished".
    this.#patch({ relay, ...(relay.registrySettled ? this.#pruneGone(relay.machines) : {}) });
    if (relay.status !== "open") {
      // Forgotten rather than kept: a resume re-dials unconditionally and the
      // registry that follows names the same machines, so leaving the map in
      // place means nothing ever counts as woken again and the session lists
      // stay at whatever the very first connect saw.
      this.#wokenAt = new Map();
      this.#queue.onDrop();
      this.#wasOpen = false;
      return;
    }
    const reopened = !this.#wasOpen;
    this.#wasOpen = true;

    const connected = relay.machines.filter((machine) => machine.connected);
    const woken = connected.filter((machine) => this.#wokenAt.get(machine.deviceId) !== machine.lastSeen);
    for (const machine of connected) this.#wokenAt.set(machine.deviceId, machine.lastSeen);
    if (woken.length > 0) void this.#fetchSessions(woken.map((machine) => machine.deviceId));
    // Never while the spawn is still in flight: any relay change (a status beat, a
    // registry push) lands here, and reconciling then spends the pending record on
    // a question the reply is about to answer — leaving nothing to reconcile if the
    // reply is the thing that gets dropped.
    if (this.#pending !== null && !this.#state.spawning) void this.#reconcile();
    this.#queue.onOpen(relay, reopened);
  }

  /**
   * Drops everything keyed by a deviceId the registry no longer lists — the
   * remembered repo, the selection, the session list and the wake mark. Nothing
   * brings that id back: a reinstall mints a new one, so all of it is dead state.
   * Doing it here rather than at the bin is what makes a refused or undelivered
   * forget leave the app untouched.
   */
  #pruneGone(machines: readonly { readonly deviceId: string }[]): Partial<AppState> {
    const live = new Set(machines.map((machine) => machine.deviceId));
    for (const deviceId of [...this.#wokenAt.keys()]) if (!live.has(deviceId)) this.#wokenAt.delete(deviceId);

    const { form, sessions } = this.#state;
    const repos = Object.fromEntries(Object.entries(form.repos).filter(([id]) => live.has(id)));
    const kept = Object.fromEntries(Object.entries(sessions).filter(([id]) => live.has(id)));
    const machineId = form.machineId !== null && !live.has(form.machineId) ? null : form.machineId;
    // Same objects back when nothing was dropped: #patch bails on identity.
    return {
      form:
        machineId === form.machineId && Object.keys(repos).length === Object.keys(form.repos).length
          ? form
          : { ...form, machineId, repos },
      sessions: Object.keys(kept).length === Object.keys(sessions).length ? sessions : kept,
    };
  }

  async #fetchSessions(deviceIds: readonly string[]): Promise<void> {
    await Promise.all(
      deviceIds.map(async (deviceId) => {
        try {
          const reply = await this.#client.request<SessionsResponse>(deviceId, "sessions", {});
          // A daemon refusal (`internal_error`, `too_large`) arrives as a reply,
          // not a throw: unchecked, `sessions` lands in state as undefined.
          if ("ok" in reply) throw new Error(reply.code);
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
      if ("ok" in reply) throw new Error(reply.code);
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

  /** Typing retires the offer: the stashed text is no longer what the field lost. */
  setPrompt(prompt: string): void {
    this.#disarmUndo();
    this.#patch({ form: { ...this.#state.form, prompt }, promptUndo: null });
  }

  /**
   * Empties the field at once and stashes what it held — no confirm dialog for
   * an action this cheap to take back.
   */
  clearPrompt(): void {
    const cleared = this.#state.form.prompt;
    if (cleared === "") return;
    this.#disarmUndo();
    this.#undoTimer = setTimeout(() => {
      this.#undoTimer = null;
      this.#patch({ promptUndo: null });
    }, UNDO_WINDOW_MS);
    this.#patch({ form: { ...this.#state.form, prompt: "" }, promptUndo: cleared });
  }

  undoClear(): void {
    const stashed = this.#state.promptUndo;
    if (stashed === null) return;
    this.#disarmUndo();
    this.#patch({ form: { ...this.#state.form, prompt: stashed }, promptUndo: null });
  }

  #disarmUndo(): void {
    if (this.#undoTimer === null) return;
    clearTimeout(this.#undoTimer);
    this.#undoTimer = null;
  }

  /** Restores that machine's last repo (falling back to its first) and clears any verdict. */
  selectMachine(machineId: string): void {
    // Counted before the patch: clearing the verdict here would otherwise leave
    // its entry behind once the sheet's back had been spent. Settings is not the
    // sheet's to close.
    const open = this.#sheetAndVerdictOpen();
    this.#patch({ form: { ...this.#state.form, machineId, auto: false }, verdict: null, preview: null });
    if (open > 0) history.go(-open);
  }

  /**
   * The picker's `auto`: the scheduler places the spawn. Refused only while the
   * relay is unreachable — the row is greyed then, and this is its backstop.
   */
  selectAuto(): void {
    if (!deriveAutoAvailability(this.#state.relay).available) return;
    const open = this.#sheetAndVerdictOpen();
    this.#patch({ form: { ...this.#state.form, auto: true }, verdict: null });
    if (open > 0) history.go(-open);
    void this.refreshPreview();
  }

  /** The history entries a machine pick closes. */
  #sheetAndVerdictOpen(): number {
    const { sheet, verdict } = this.#state;
    return (sheet === null ? 0 : 1) + (verdict === null ? 0 : 1);
  }

  /**
   * Forgets an offline machine at the relay, for every app rather than this one.
   * The sheet stays open: clearing several retired machines in a row is the
   * normal case, and the list re-renders under it when the relay pushes back.
   *
   * Request only: the state keyed by this deviceId goes in `#pruneGone`, when a
   * registry push says the entry is actually gone. A forget the relay refuses
   * (the machine reconnected) or one that never left a closed socket therefore
   * keeps the row, its remembered repo and the selection, rather than clearing
   * them against a machine that is still listed.
   */
  removeMachine(machineId: string): void {
    this.#client.forget(machineId);
  }

  /** On `auto`, `repo` is an origin, and the choice is the form's, not a machine's. */
  selectRepo(repo: string): void {
    const { form, relay } = this.#state;
    if (form.auto) {
      this.#patch({ form: { ...form, autoRepo: repo } });
      this.dismissLayer();
      void this.refreshPreview();
      return;
    }
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

  /** A layer already showing is replaced in place: one entry per layer, never two. */
  openSheet(sheet: SheetKind): void {
    if (this.#state.sheet === null) this.#pushLayer();
    this.#patch({ sheet });
    // The picker lists what the leader holds now, not what the Queue screen last read.
    if (sheet === "after") void this.refreshQueue();
  }

  /** Waits on `taskId` at `after`; an edge already held on it is replaced, never doubled. */
  addAfter(taskId: string, after: DepAfter): void {
    const { form } = this.#state;
    const others = form.after.filter((dep) => dep.task !== taskId);
    if (others.length >= TASK_SPEC_LIMITS.deps) return;
    this.#patch({ form: { ...form, after: [...others, { task: taskId, after }] } });
  }

  removeAfter(taskId: string): void {
    const { form } = this.#state;
    this.#patch({ form: { ...form, after: form.after.filter((dep) => dep.task !== taskId) } });
  }

  setUntil(until: TaskUntil): void {
    this.#patch({ form: { ...this.#state.form, until } });
  }

  setLinearIssue(linearIssue: string): void {
    this.#patch({ form: { ...this.#state.form, linearIssue: linearIssue.slice(0, TASK_SPEC_LIMITS.linearIssue) } });
  }

  /**
   * The next enqueues join a new batch of `strategy`, numbered from 1. The same
   * strategy again keeps the batch open: re-picking it must not renumber a
   * batch already in flight.
   */
  startBatch(strategy: BatchStrategy): void {
    const { form } = this.#state;
    const same = form.batch !== null && JSON.stringify(form.batch.strategy) === JSON.stringify(strategy);
    if (!same) this.#patch({ form: { ...form, batch: { id: crypto.randomUUID(), strategy, next: 1 } } });
    this.dismissLayer();
  }

  endBatch(): void {
    this.#patch({ form: { ...this.#state.form, batch: null } });
    this.dismissLayer();
  }

  /**
   * "Follow up" on a queue row: the form goes to `auto` with that task as its one
   * dependency. The queue (and a verdict under it) closes like a machine pick's
   * sheet does, so the form is what shows; in the desktop layout the queue is a
   * column and stays.
   */
  followUp(taskId: string): void {
    const { form, relay, queue, verdict } = this.#state;
    if (!deriveAutoAvailability(relay).available) return;
    const open = (queue ? 1 : 0) + (verdict === null ? 0 : 1);
    this.#patch({
      form: { ...form, auto: true, after: [{ task: taskId, after: "opened" }] },
      queue: false,
      queueNotice: null,
      verdict: null,
    });
    if (open > 0) history.go(-open);
    void this.refreshPreview();
  }

  /** The settings screen is a layer like the sheets: one entry, popped by back. */
  openSettings(): void {
    if (!this.#state.settings) this.#pushLayer();
    this.#patch({ settings: true });
  }

  /**
   * Flips the desktop layout. Turning wide reads the queue at once — its column
   * appears without the `openQueue` that would otherwise have asked.
   */
  setWide(wide: boolean): void {
    if (wide === this.#state.wide) return;
    this.#patch({ wide });
    if (wide) void this.refreshQueue();
  }

  /** The phone's Machines screen, from the header menu: one entry, popped by back. */
  openMachines(): void {
    if (!this.#state.machines) this.#pushLayer();
    this.#patch({ machines: true });
  }

  /** The Queue screen is a layer like settings: one entry, popped by back. */
  openQueue(): void {
    // Already a column beside the form: a layer there would be an invisible back stop.
    if (this.#state.wide) {
      void this.refreshQueue();
      return;
    }
    if (!this.#state.queue) this.#pushLayer();
    this.#patch({ queue: true });
    void this.refreshQueue();
  }

  /** See `SchedulerStore.refreshPreview`. */
  refreshPreview(attempt = 0): Promise<void> {
    return this.#queue.refreshPreview(attempt);
  }

  /** See `SchedulerStore.refreshQueue`. */
  refreshQueue(tasks?: readonly string[], nudged = false): Promise<void> {
    return this.#queue.refreshQueue(tasks, nudged);
  }

  cancelTask(taskId: string): Promise<void> {
    return this.#queue.cancelTask(taskId);
  }

  markDone(taskId: string): Promise<void> {
    return this.#queue.markDone(taskId);
  }

  pauseQueue(): Promise<void> {
    return this.#queue.pauseQueue();
  }

  resumeQueue(account?: string): Promise<void> {
    return this.#queue.resumeQueue(account);
  }

  discardUnreadable(): Promise<void> {
    return this.#queue.discardUnreadable();
  }

  /**
   * One chart at a time: a new pick replaces whatever is open or still loading.
   * The window ends on the tier's newest bucket, so it never ends mid-bucket.
   */
  async showHistory(target: HistoryTarget, pick?: HistoryRange): Promise<void> {
    const range = pick ?? this.#historyRange;
    this.#historyRange = range;
    const { span, step } = RANGE_SPANS[range];
    const to = Math.floor(Date.now() / 1000 / step) * step;
    const from = to - span + step;
    const asked: HistoryView = { target, range, from, to, step, result: { kind: "loading" } };
    this.#patch({ history: asked });
    const names = TARGET_METRICS[target.kind];
    // Only this account's series cross the wire; a daemon that predates `labels`
    // sends every exclave's, which `#fetchHistory` narrows all the same.
    const request: MetricsRequest =
      target.kind === "account"
        ? { from, to, step, names, labels: { account: target.accountId } }
        : { from, to, step, names };
    const result = await this.#fetchHistory(target, request);
    // A later pick or a closed screen has replaced the chart this answers.
    if (this.#state.history !== asked) return;
    this.#patch({ history: { ...asked, result } });
  }

  hideHistory(): void {
    this.#patch({ history: null });
  }

  async #fetchHistory(target: HistoryTarget, request: MetricsRequest): Promise<HistoryResult> {
    let reply: MetricsReply | null;
    try {
      reply = await this.#client.metrics(target.deviceId, request);
    } catch (err) {
      // Caught whole: the caller is fire-and-forget, so a rethrow would strand the chart on "Loading…".
      if (!(err instanceof RequestFailure)) return { kind: "failed", message: "Couldn't load the history." };
      // A read has nothing to land, so the timeout line's "may have landed" would mislead.
      if (err.reason === "timeout") return { kind: "failed", message: "No answer — the machine may be asleep." };
      // The shared line is a clause meant to follow a prefix; the chart shows it alone.
      return { kind: "failed", message: sentence(failureReasonText(err)) };
    }
    if (reply === null) return { kind: "failed", message: HISTORY_UNREADABLE };
    if ("ok" in reply) return { kind: "failed", message: HISTORY_ERRORS[reply.code] };
    const series = target.kind === "account" ? accountSeries(reply.series, target.accountId) : reply.series;
    return { kind: "ok", series };
  }

  /** Always via history, so the entry pushed when the layer opened is consumed. */
  dismissLayer(): void {
    if (this.#openLayers() === 0) return;
    history.back();
  }

  /**
   * Called from the popstate listener. Closes layers down to the depth of the
   * entry back landed on; every entry this document pushed sits above any it
   * didn't, so landing on a stale one closes them all and skips past it.
   */
  onPopState(): void {
    // Any traversal leaves the entry that was current, held or not.
    this.#held = false;
    const entry = layerEntry(history.state);
    const depth = entry !== null && entry.owner === this.#owner ? entry.depth : 0;
    while (this.#openLayers() > depth) this.#closeTopLayer();
    this.#skipStaleEntries();
  }

  #openLayers(): number {
    const { sheet, settings, machines, queue, verdict } = this.#state;
    return (
      (sheet === null ? 0 : 1) + (settings ? 1 : 0) + (machines ? 1 : 0) + (queue ? 1 : 0) + (verdict === null ? 0 : 1)
    );
  }

  /** Before the patch that opens the layer, so the depth counts it. */
  #pushLayer(): void {
    const entry = { seance: "layer", owner: this.#owner, depth: this.#openLayers() + 1 };
    if (this.#held) history.replaceState(entry, "");
    else history.pushState(entry, "");
    this.#held = false;
  }

  /** A retry that ended without a verdict gives its entry back, as a dismissal would have. */
  #releaseHeld(): void {
    if (!this.#held) return;
    this.#held = false;
    history.back();
  }

  /**
   * An entry deeper than what is open is skipped back to its match: another
   * document's (its depth counts from its own base), or this one's reached by
   * Forward after its layer closed, which can't be reopened from the entry alone.
   */
  #skipStaleEntries(): void {
    const entry = layerEntry(history.state);
    if (entry === null) return;
    const stale = entry.owner === this.#owner ? entry.depth - this.#openLayers() : entry.depth;
    if (stale > 0) history.go(-stale);
  }

  #closeTopLayer(): void {
    const sheet = this.#state.sheet;
    if (sheet !== null) {
      // Cleared on the way out, not on the next open: a failure that landed while
      // another layer was up would otherwise be reset before it was ever shown.
      const rescan = sheet === "repo" && this.#state.rescan === "failed" ? "idle" : this.#state.rescan;
      this.#patch({ sheet: null, rescan });
      return;
    }
    // Above settings, so it closes first.
    if (this.#state.machines) {
      this.#patch({ machines: false, history: null });
      return;
    }
    if (this.#state.settings) {
      this.#patch({ settings: false });
      return;
    }
    // Opened over a verdict, never under one, so it closes first.
    if (this.#state.queue) {
      this.#patch({ queue: false, queueNotice: null });
      return;
    }
    if (this.#state.verdict !== null) this.#patch({ verdict: null });
  }

  #showVerdict(verdict: Verdict): void {
    if (this.#state.verdict === null) this.#pushLayer();
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
    if ("ok" in reply) throw new Error(reply.code);
    const parsed = this.#client.applyScan(deviceId, reply);
    // A reply this build can't read is a failed rescan, not a shorter list.
    if (parsed === null) throw new Error("unreadable rescan reply");
    return parsed.repos;
  }

  /**
   * `auto` is a task written to the relay's store (`createTask`), which answers
   * for itself: no leader need be up, and whichever one leads next reads it. A
   * machine picked directly is the daemon's own spawn below.
   */
  async #submitAuto(): Promise<void> {
    const { relay, form } = this.#state;
    const repo = resolveAutoRepo(autoRepos(relay.machines), form);
    if (repo === null || !deriveAutoAvailability(relay).available || this.#state.spawning) return;
    // The leader bounds what it reads; past the bound it would skip the task, and the store's refusal blames versions.
    const refusal = (message: string): void => this.#showVerdict({ kind: "unqueued", message, mayHaveLanded: false });
    const reported = form.until === "reported";
    // An older leader would drop `until` and hold a `done` edge unreadable, so neither is written to one.
    if ((reported || form.after.some((dep) => dep.after === "done")) && !deriveReportedAvailability(relay)) {
      refusal(
        "The scheduler's leader doesn't take tasks that settle on a done report yet. Update seanced on its machine, or pick another setting.",
      );
      return;
    }
    if (reported && form.prompt.trim() === "") {
      refusal("A task that settles on its done report needs a prompt: the session is told in it to report.");
      return;
    }
    if (form.batch !== null && form.batch.next > TASK_SPEC_LIMITS.batchIndex) {
      refusal("This batch is full. End it and start another.");
      return;
    }
    const request = taskRequest(form, repo.origin, true);
    // Appended here so the length below is the one the leader reads; it never rewrites a prompt.
    const prompt = reported && request.prompt !== undefined ? withReportInstruction(request.prompt) : request.prompt;
    const length = prompt?.length ?? 0;
    if (length > TASK_REQUEST_LIMITS.prompt) {
      const instruction = reported ? " (with the instruction to report, which is added)" : "";
      refusal(
        `The prompt is ${length} characters${instruction}; the scheduler takes at most ${TASK_REQUEST_LIMITS.prompt}. Shorten it, or pick a machine.`,
      );
      return;
    }
    const issue = form.linearIssue.trim();
    const spec: TaskSpec = {
      ...request,
      ...(prompt === undefined ? {} : { prompt }),
      client: "pwa" satisfies SpawnClient,
      ...(form.after.length === 0 ? {} : { deps: form.after }),
      ...(form.batch === null
        ? {}
        : { batch: { id: form.batch.id, index: form.batch.next, strategy: form.batch.strategy } }),
      ...(reported ? { until: form.until } : {}),
      ...(issue === "" ? {} : { linear: { issue } }),
    };
    await this.#enqueue(queuedTask(spec, Date.now()));
  }

  /**
   * Puts `task` in the store. A retry re-sends the same task: its id is the
   * key, so a put that had landed answers `landedEarlier` and cannot queue it
   * twice.
   */
  async #enqueue(task: Task): Promise<void> {
    this.#queue.stopFollowing();
    this.#patch({ spawning: true, verdict: null });
    try {
      const reply = await this.#client.createTask(task);
      if (reply === null) {
        this.#showVerdict({ kind: "unqueued", message: STORE_UNREADABLE, mayHaveLanded: true, retry: task });
      } else if (!reply.ok) {
        // A refusal says nothing was stored. Only a full store or a busy minute is worth asking again.
        const again = reply.code === "rate_limited" || reply.code === "store_full";
        const unreadable = reply.code === "store_full" ? this.#queue.unreadableCount() : 0;
        this.#showVerdict({
          kind: "unqueued",
          message:
            unreadable > 0
              ? `${sentence(storeFullUnreadableText(unreadable))} Clear them on the Queue screen, then try again.`
              : sentence(storeErrorText(reply.code)),
          mayHaveLanded: false,
          ...(again ? { retry: task } : {}),
        });
      } else {
        this.#disarmUndo();
        const { form } = this.#state;
        // Deps, Linear and `until` belong to the task just stored; a batch spans enqueues, and its
        // counter moves only for the member it numbered, so a retry that lands twice moves it once.
        const { batch } = form;
        const counted = batch !== null && task.spec.batch?.id === batch.id && task.spec.batch.index === batch.next;
        this.#patch({
          form: {
            ...form,
            prompt: "",
            after: [],
            until: "merged",
            linearIssue: "",
            batch: counted ? { ...batch, next: batch.next + 1 } : batch,
          },
          promptUndo: null,
        });
        this.#showVerdict({ kind: "queued", task });
        this.#queue.startFollowing(task.id);
      }
    } catch (err) {
      // An error that is no `RequestFailure` says nothing about whether it went out, so it may have.
      const failure = err instanceof RequestFailure ? err : new RequestFailure("dropped", String(err));
      // A timeout or a socket closing after the send may have come after the relay stored it.
      const mayHaveLanded = failure.reason === "timeout" || failure.reason === "dropped";
      this.#showVerdict({ kind: "unqueued", message: enqueueFailureText(failure), mayHaveLanded, retry: task });
    } finally {
      this.#patch({ spawning: false });
    }
  }

  async spawn(): Promise<void> {
    if (this.#state.form.auto) {
      await this.#submitAuto();
      return;
    }
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
      client: "pwa" satisfies SpawnClient,
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
        this.#disarmUndo();
        this.#patch({
          form: { ...this.#state.form, prompt: "" },
          promptUndo: null,
          sessions: { ...this.#state.sessions, [machine.deviceId]: { sessions: reply.sessions, at: Date.now() } },
        });
        this.#showVerdict({
          kind: "ok",
          window: reply.window,
          ...(reply.note === undefined ? {} : { note: reply.note }),
          ...(reply.pending === true ? { pending: true as const } : {}),
          ...(prompt === "" ? {} : { prompt }),
        });
      } else {
        this.#showVerdict({ kind: "failed", code: reply.code, message: reply.message, repo: repo.name });
      }
    } catch (err) {
      const reason = err instanceof RequestFailure ? err.reason : "dropped";
      // "refused" belongs with the undeliverables: the relay answered that the
      // request did not land, so nothing can be running — and "disconnected"
      // never left the app at all.
      if (reason === "offline" || reason === "unknown" || reason === "refused" || reason === "disconnected") {
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
    this.setPrompt("");
    this.dismissLayer();
  }

  /**
   * Restores the spawned prompt to the form and returns to it. Takes the verdict
   * the view rendered rather than reading state: the rendered one outlives
   * `state.verdict` by the frame a view transition waits for its capture
   * (app.tsx), and a keyboard activation inside that window would otherwise
   * restore nothing.
   */
  reusePrompt(verdict: Verdict): void {
    if (verdict.kind === "ok" && verdict.prompt !== undefined) this.setPrompt(verdict.prompt);
    this.dismissLayer();
  }

  /**
   * A repo_not_found retry rescans first — the button says so — and checks the
   * fresh list before spawning again, so a repo that is really gone gets a
   * conclusive verdict instead of the same failure in a loop. Takes the rendered
   * verdict for the same reason `reusePrompt` does.
   */
  retrySpawn(verdict: Verdict): void {
    if (this.#state.verdict !== null) {
      this.#held = true;
      this.#patch({ verdict: null });
    }
    const retry =
      verdict.kind === "unqueued"
        ? this.retryEnqueue(verdict)
        : verdict.kind === "failed" && verdict.code === "repo_not_found"
          ? this.#rescanThenRetry(verdict)
          : this.spawn();
    void retry.finally(() => this.#releaseHeld());
  }

  /** Puts an unqueued verdict's task again; nothing to put leaves the form as the retry found it. */
  async retryEnqueue(verdict: Extract<Verdict, { kind: "unqueued" }>): Promise<void> {
    if (verdict.retry !== undefined) await this.#enqueue(verdict.retry);
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
