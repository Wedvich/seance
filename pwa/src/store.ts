import type {
  Machine,
  MetricsErrorCode,
  MetricsReply,
  MetricsRequest,
  RepoEntry,
  RescanResponse,
  PauseHold,
  QueueChanged,
  SchedulerAvailability,
  SessionsResponse,
  SpawnClient,
  SpawnRequest,
  SpawnResponse,
  Task,
  TaskRequest,
} from "@seance/shared";
import {
  failureReasonText,
  isSettled,
  isTransportError,
  QUEUE_MAX_TASKS,
  queuedTask,
  RequestFailure,
  schedulerErrorText,
  sentence,
  storeErrorText,
  TASK_REQUEST_LIMITS,
  type RelayClient,
} from "@seance/shared";
import {
  DEFAULT_FORM,
  RANGE_SPANS,
  TARGET_METRICS,
  type Effort,
  type FollowEnd,
  type HistoryRange,
  type HistoryResult,
  type HistoryTarget,
  type HistoryView,
  type Model,
  type PendingSpawn,
  type PersistedForm,
  type PreviewState,
  type QueueState,
  type SheetKind,
  type TaskAction,
  type Verdict,
} from "./state.ts";
import { accountSeries } from "./chart.ts";
import type { AppState } from "./view.ts";
import { autoRepos, deriveAutoAvailability, resolveAutoRepo, resolveMachine, resolveRepo } from "./view.ts";

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

const SCHEDULER_UNREADABLE = "Couldn't read the scheduler's answer. Update seanced and the app to matching versions.";
const STORE_UNREADABLE = "Couldn't read the relay's answer. Update the app and the relay to matching versions.";

/** Shown after a queue action whose answer never came: the leader may have acted. */
const MAY_HAVE_LANDED_HINT = " — refresh to see whether it landed";

/**
 * A queued task is followed while it is still on its way to a machine: the
 * leader's `queue-changed` nudge re-reads it at once, and the verdict also
 * re-reads `queue` this often, this many times, until the task is placed or
 * settled. The poll is the fallback for a nudge that never came (a leader that
 * sends none, or one lost while the socket was down), and bounded so a task no
 * machine can take does not keep the phone asking. A poll that finds no leader
 * is not counted: the task waits in the relay's queue, and so does the verdict.
 */
export const QUEUE_POLL_MS = 2_000;
export const QUEUE_POLLS = 30;

/** A preview answered `not_ready` (takeover still running) is asked again this often, this many times. */
export const PREVIEW_RETRY_MS = 1_000;
const PREVIEW_RETRIES = 10;

/**
 * What would answer a preview: a new leader, or the same one verified at last,
 * asks again. Never "", which is what a drop resets the last-asked key to.
 */
/** The leader refuses a named read past `QUEUE_MAX_TASKS`: one that long is read whole instead. */
function capNamed(tasks: readonly string[]): readonly string[] | null {
  return tasks.length > QUEUE_MAX_TASKS ? null : tasks;
}

/** How a followed task's last poll ends the verdict's follow: a refusal as it was worded, else by whether it was answered. */
function followEnd(read: { readonly task: Task } | FollowEnd | "missed" | "waiting"): FollowEnd {
  if (typeof read === "object" && !("task" in read)) return read;
  return { kind: read === "missed" ? "unanswered" : "stopped" };
}

function schedulerKey(scheduler: SchedulerAvailability): string {
  return scheduler.kind === "none" ? "none" : `${scheduler.kind}:${scheduler.deviceId}:${scheduler.term}`;
}

/**
 * What a preview reads besides the leader: who is connected and which repos
 * each holds. A status beat moves neither, so it asks nothing.
 */
function fleetKey(machines: readonly Machine[]): string {
  return machines
    .map((m) => `${m.deviceId}:${m.connected ? 1 : 0}:${m.repos.map((r) => r.origin ?? "").join(",")}`)
    .join(";");
}

/** A presence or repo change asks the preview again after this quiet, so a registry burst asks once. */
export const PREVIEW_DEBOUNCE_MS = 500;

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
  /** Tells this document's history entries from ones a previous load left behind. */
  readonly #owner = crypto.randomUUID();
  /**
   * The entry a retried verdict leaves behind, kept for whatever layer opens next.
   * Retry can't go back instead: the back is delivered later, and a verdict that
   * lands first (a rescan with no socket fails at once) would be the one it closes.
   */
  #held = false;
  /** The leader `auto` last previewed against: a new one, or one verified at last, asks again. */
  #previewedLeader = "";
  /** The fleet `auto` last previewed against (`fleetKey`). */
  #previewedFleet = "";
  #followTimer: ReturnType<typeof setTimeout> | null = null;
  /** The leader the Queue screen last read from: a new one asks again. */
  #queueLeader = "";
  /** The queue read loop while one is out: reads are single-flight, a later ask folds into `#queueTrailing`. */
  #queueRun: Promise<void> | null = null;
  /** What to read once the one in flight settles: the union of every ask meanwhile (null names the whole queue). */
  #queueTrailing: { readonly tasks: readonly string[] | null; readonly nudged: boolean } | null = null;
  /** The view a `loading` patch replaced, restored when the read fails with nobody looking. */
  #queuePrior: QueueState | null = null;
  /** Sequence of task reads: a poll answered after a newer read landed is stale. */
  #taskReadSeq = 0;
  #taskReadApplied = 0;
  /** Whether the socket was open at the last relay change, so a re-dial reads as one. */
  #wasOpen = false;
  #previewRetry: ReturnType<typeof setTimeout> | null = null;

  constructor(client: RelayClient, form: PersistedForm = DEFAULT_FORM, pending: PendingSpawn | null = null) {
    this.#client = client;
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
      queueView: null,
      taskAction: null,
      queueNotice: null,
      pausing: false,
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
    const unsubscribeQueue = this.#client.onQueueChanged((change) => this.#onQueueChanged(change));
    this.#skipStaleEntries();
    this.#onRelay();
    return () => {
      unsubscribe();
      unsubscribeQueue();
      document.removeEventListener("visibilitychange", onVisible);
      this.#disarmUndo();
      this.#stopFollowing();
      this.#stopPreviewRetry();
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
      // The leader usually survives a drop unchanged, so without this a preview
      // the drop failed mid-flight would never be asked again on reconnect.
      this.#previewedLeader = "";
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
    this.#catchUpQueue(relay.scheduler, reopened);
    if (!this.#state.form.auto) return;
    if (schedulerKey(relay.scheduler) !== this.#previewedLeader) void this.refreshPreview();
    else if (fleetKey(relay.machines) !== this.#previewedFleet) this.#askPreviewSoon();
  }

  /**
   * What a `queue-changed` nudge would have told, once the socket was down or a
   * leader changed: nudges sent meanwhile are lost, and the merge of named ids
   * never heals a task it was not told about, so the screen reads whole again.
   */
  #catchUpQueue(scheduler: SchedulerAvailability, reopened: boolean): void {
    const read =
      this.#watchesQueue() && (reopened || schedulerKey(scheduler) !== this.#queueLeader)
        ? this.refreshQueue(undefined, true)
        : null;
    const verdict = this.#state.verdict;
    if (reopened && verdict?.kind === "queued" && !isSettled(verdict.task.state)) {
      void this.#followedVia(verdict.task.id, read);
    }
  }

  #onQueueChanged(change: QueueChanged): void {
    const read = this.#watchesQueue() ? this.refreshQueue(change.tasks, true) : null;
    const verdict = this.#state.verdict;
    if (
      verdict?.kind === "queued" &&
      !isSettled(verdict.task.state) &&
      (change.tasks === undefined || change.tasks.includes(verdict.task.id))
    ) {
      void this.#followedVia(verdict.task.id, read);
    }
  }

  /**
   * Brings the followed task up to date: from the queue read already out for it
   * when that read lands a fresh copy, else with a read of its own (no read, or
   * one that failed or no longer lists it).
   */
  async #followedVia(taskId: string, read: Promise<void> | null): Promise<void> {
    const listed = (): Task | undefined => {
      const view = this.#state.queueView;
      return view?.kind === "ok" ? view.tasks.find((t) => t.id === taskId) : undefined;
    };
    if (read === null) return this.#refreshTask(taskId, null);
    const before = listed();
    await read;
    const fresh = listed();
    if (fresh === undefined || fresh === before) return this.#refreshTask(taskId, null);
    const verdict = this.#state.verdict;
    if (verdict?.kind !== "queued" || verdict.task.id !== taskId || isSettled(verdict.task.state)) return;
    this.#taskReadApplied = ++this.#taskReadSeq;
    if (isSettled(fresh.state)) this.#stopFollowing();
    if (fresh !== verdict.task) this.#patch({ verdict: { kind: "queued", task: fresh } });
  }

  /**
   * The Queue chip's attention dot reads from the list, so it is kept current
   * with the screen closed too, whenever a verified leader could answer.
   */
  #watchesQueue(): boolean {
    return this.#state.queue || (this.#state.relay.status === "open" && this.#state.relay.scheduler.kind === "ready");
  }

  /** Debounced: each change restarts the wait. */
  #askPreviewSoon(): void {
    this.#stopPreviewRetry();
    this.#previewRetry = setTimeout(() => {
      this.#previewRetry = null;
      void this.refreshPreview();
    }, PREVIEW_DEBOUNCE_MS);
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
   * Asks the leader what it would decide for the form as it stands, reserving
   * nothing. A reply that lands after the form moved on is dropped, as a chart's is.
   */
  async refreshPreview(attempt = 0): Promise<void> {
    this.#stopPreviewRetry();
    const { form, relay } = this.#state;
    this.#previewedLeader = schedulerKey(relay.scheduler);
    this.#previewedFleet = fleetKey(relay.machines);
    const repo = resolveAutoRepo(autoRepos(relay.machines), form);
    if (!form.auto || !deriveAutoAvailability(relay).available || repo === null) {
      this.#patch({ preview: null });
      return;
    }
    // A retry keeps showing the loading card it already shows; a re-ask for the same repo keeps
    // the decision on screen, so the card holds its height instead of collapsing to one line.
    const current = this.#state.preview;
    const same = current?.repo === repo.origin ? current : null;
    const previous = same?.kind === "ok" ? same.decision : same?.kind === "loading" ? same.previous : undefined;
    const asked: PreviewState =
      attempt > 0 && same?.kind === "loading"
        ? same
        : { kind: "loading", repo: repo.origin, ...(previous === undefined ? {} : { previous }) };
    this.#patch({ preview: asked });
    let result: PreviewState;
    try {
      const reply = await this.#client.routePreview(this.#taskRequest(repo.origin, false));
      if (reply === null) result = { kind: "failed", repo: repo.origin, message: SCHEDULER_UNREADABLE };
      else if ("ok" in reply) {
        // A leader that has just taken the role answers this until its takeover ends — seconds,
        // and the very moment a new leader makes the form ask — so it is waited out, not shown.
        if (reply.code === "not_ready" && attempt < PREVIEW_RETRIES) {
          if (this.#state.preview === asked) {
            this.#previewRetry = setTimeout(() => void this.refreshPreview(attempt + 1), PREVIEW_RETRY_MS);
          }
          return;
        }
        result = { kind: "failed", repo: repo.origin, message: sentence(schedulerErrorText(reply.code)) };
      } else result = { kind: "ok", repo: repo.origin, decision: reply.decision };
    } catch (err) {
      const text = err instanceof RequestFailure ? failureReasonText(err) : "the preview failed";
      result = { kind: "failed", repo: repo.origin, message: `${text.charAt(0).toUpperCase()}${text.slice(1)}` };
    }
    if (this.#state.preview !== asked) return;
    this.#patch({ preview: result });
  }

  #stopPreviewRetry(): void {
    if (this.#previewRetry !== null) clearTimeout(this.#previewRetry);
    this.#previewRetry = null;
  }

  /** The form as a `TaskRequest`; a preview leaves the prompt out, which routing never reads. */
  #taskRequest(origin: string, withPrompt: boolean): TaskRequest {
    const { form } = this.#state;
    const prompt = form.prompt.trim();
    return {
      repo: origin,
      mode: form.worktree ? "worktree" : "here",
      model: form.model,
      effort: form.effort,
      ...(withPrompt && prompt !== "" ? { prompt } : {}),
    };
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
  }

  /** The settings screen is a layer like the sheets: one entry, popped by back. */
  openSettings(): void {
    if (!this.#state.settings) this.#pushLayer();
    this.#patch({ settings: true });
  }

  /** Stacked over settings, its own entry: back returns to settings, not the form. */
  openMachines(): void {
    if (!this.#state.machines) this.#pushLayer();
    this.#patch({ machines: true });
  }

  /** The Queue screen is a layer like settings: one entry, popped by back. */
  openQueue(): void {
    if (!this.#state.queue) this.#pushLayer();
    this.#patch({ queue: true });
    void this.refreshQueue();
  }

  /**
   * Reads the leader's queue for the screen. `tasks` merges only those ids into
   * what is shown (a `queue-changed` named them), holds always replace; without
   * it, or with nothing to merge into, the whole queue is read. Never throws: a
   * failure is the screen's to word, and a list already read stays up under it.
   * `nudged` marks a read a `queue-changed` asked for: a takeover still running
   * answers it `not_ready`, and the takeover's own nudge reads again; it also
   * leaves an action's notice standing. Reads are single-flight: an ask made
   * while one is out folds into one trailing read, which settles every caller's
   * promise, and a person's own refresh keeps its notice behaviour in the fold.
   */
  refreshQueue(tasks?: readonly string[], nudged = false): Promise<void> {
    this.#queueLeader = schedulerKey(this.#state.relay.scheduler);
    if (this.#queueRun === null) {
      const run = this.#readQueueLoop(tasks ?? null, nudged);
      this.#queueRun = run;
      return run;
    }
    const held = this.#queueTrailing;
    const union =
      tasks === undefined || (held !== null && held.tasks === null)
        ? null
        : capNamed([...new Set([...(held?.tasks ?? []), ...tasks])]);
    this.#queueTrailing = { tasks: union, nudged: nudged && (held?.nudged ?? true) };
    this.#showQueueLoading();
    return this.#queueRun;
  }

  async #readQueueLoop(tasks: readonly string[] | null, nudged: boolean): Promise<void> {
    let ask = { tasks, nudged };
    try {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- single-flight: one read at a time
        await this.#readQueue(ask.tasks, ask.nudged);
        const trailing = this.#queueTrailing;
        this.#queueTrailing = null;
        if (trailing === null) return;
        ask = trailing;
      }
    } finally {
      // In the same turn as the last look at `#queueTrailing`: an ask after it must start a loop of its own.
      this.#queueRun = null;
    }
  }

  /** Only while the screen is open and has no list to show: a read nobody sees leaves no `loading` behind. */
  #showQueueLoading(): void {
    const view = this.#state.queueView;
    if (!this.#state.queue || (view !== null && view.kind !== "failed")) return;
    this.#queuePrior = view;
    this.#patch({ queueView: { kind: "loading" } });
  }

  async #readQueue(tasks: readonly string[] | null, nudged: boolean): Promise<void> {
    const current = this.#state.queueView;
    const named = tasks !== null && current?.kind === "ok" ? capNamed(tasks) : null;
    this.#showQueueLoading();
    let next: QueueState | { readonly notice: string } | null;
    try {
      const reply = await this.#client.queue(named === null ? {} : { tasks: named });
      if (reply === null) next = { notice: SCHEDULER_UNREADABLE };
      else if ("ok" in reply) {
        if (nudged && reply.code === "not_ready" && current?.kind === "ok") next = null;
        else next = { notice: sentence(schedulerErrorText(reply.code)) };
      } else if (named === null) next = { kind: "ok", tasks: reply.tasks, holds: reply.holds ?? [], at: reply.at };
      else {
        // An older leader ignores the filter and answers its newest: only the named ids are taken.
        const fresh = reply.tasks.filter((t) => named.includes(t.id));
        const shown = this.#state.queueView;
        const base = shown?.kind === "ok" ? shown.tasks : [];
        // A named id the reply lacks is gone (pruned, deleted), not unchanged.
        const merged = base.flatMap((t) => {
          const now = fresh.find((f) => f.id === t.id);
          if (now !== undefined) return [now];
          return named.includes(t.id) ? [] : [t];
        });
        const added = fresh.filter((f) => !base.some((t) => t.id === f.id));
        next = { kind: "ok", tasks: [...added, ...merged], holds: reply.holds ?? [], at: reply.at };
      }
    } catch (err) {
      const text = err instanceof RequestFailure ? failureReasonText(err) : "the queue could not be read";
      next = { notice: `${text.charAt(0).toUpperCase()}${text.slice(1)}` };
    }
    if (next !== null && !("notice" in next)) {
      this.#patch({ queueView: next, ...(nudged ? {} : { queueNotice: null }) });
      return;
    }
    const view = this.#state.queueView;
    // A read nobody is looking at has no one to tell, and leaves the view as it was.
    if (next === null || !this.#state.queue) {
      if (view?.kind === "loading") this.#patch({ queueView: this.#queuePrior });
      return;
    }
    // Keeps a list that was read: the status line says whether anyone is leading.
    if (view?.kind === "ok") this.#patch({ queueNotice: next.notice });
    else this.#patch({ queueView: { kind: "failed", message: next.notice } });
  }

  cancelTask(taskId: string): Promise<void> {
    return this.#actOnTask({ taskId, op: "cancel" });
  }

  markDone(taskId: string): Promise<void> {
    return this.#actOnTask({ taskId, op: "mark-done" });
  }

  async #actOnTask(action: TaskAction): Promise<void> {
    if (this.#state.taskAction !== null) return;
    this.#patch({ taskAction: action, queueNotice: null });
    let notice: string | null = null;
    try {
      const reply =
        action.op === "cancel" ? await this.#client.cancel(action.taskId) : await this.#client.markDone(action.taskId);
      if (reply === null) notice = `${SCHEDULER_UNREADABLE}${MAY_HAVE_LANDED_HINT}`;
      else if ("ok" in reply) {
        const landed = isTransportError(reply.code) ? MAY_HAVE_LANDED_HINT : "";
        notice = `${sentence(schedulerErrorText(reply.code))}${landed}`;
      } else this.#mergeTask(reply.task);
    } catch (err) {
      notice = this.#actionFailure(err);
    }
    this.#patch({ taskAction: null, queueNotice: notice });
  }

  /** The reply is the task as it now stands: shown at once, before any nudge says so. */
  #mergeTask(task: Task): void {
    const view = this.#state.queueView;
    if (view?.kind !== "ok") return;
    const known = view.tasks.some((t) => t.id === task.id);
    const tasks = known ? view.tasks.map((t) => (t.id === task.id ? task : t)) : [task, ...view.tasks];
    this.#patch({ queueView: { ...view, tasks } });
  }

  #actionFailure(err: unknown): string {
    const failure = err instanceof RequestFailure ? err : new RequestFailure("dropped", String(err));
    const text = failureReasonText(failure);
    const landed = failure.reason === "timeout" || failure.reason === "dropped" ? MAY_HAVE_LANDED_HINT : "";
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}${landed}`;
  }

  pauseQueue(): Promise<void> {
    return this.#setHolds(() => this.#client.pause({ until: "resume" }));
  }

  resumeQueue(account?: string): Promise<void> {
    return this.#setHolds(() => this.#client.resume(account === undefined ? {} : { account }));
  }

  async #setHolds(
    send: () => Promise<
      { readonly holds: readonly PauseHold[] } | { readonly ok: false; readonly code: string } | null
    >,
  ): Promise<void> {
    if (this.#state.pausing) return;
    this.#patch({ pausing: true, queueNotice: null });
    let notice: string | null = null;
    try {
      const reply = await send();
      if (reply === null) notice = `${SCHEDULER_UNREADABLE}${MAY_HAVE_LANDED_HINT}`;
      else if ("ok" in reply) notice = sentence(schedulerErrorText(reply.code));
      else {
        const view = this.#state.queueView;
        if (view?.kind === "ok") this.#patch({ queueView: { ...view, holds: reply.holds } });
        else void this.refreshQueue();
      }
    } catch (err) {
      notice = this.#actionFailure(err);
    }
    this.#patch({ pausing: false, queueNotice: notice });
  }

  /**
   * One chart at a time: a new pick replaces whatever is open or still loading.
   * The window ends on the tier's newest bucket, so it never ends mid-bucket.
   */
  async showHistory(target: HistoryTarget, range: HistoryRange): Promise<void> {
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
      const text = failureReasonText(err);
      return { kind: "failed", message: `${text.charAt(0).toUpperCase()}${text.slice(1)}` };
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
    const length = form.prompt.trim().length;
    if (length > TASK_REQUEST_LIMITS.prompt) {
      const message = `The prompt is ${length} characters; the scheduler takes at most ${TASK_REQUEST_LIMITS.prompt}. Shorten it, or pick a machine.`;
      this.#showVerdict({ kind: "unqueued", message, mayHaveLanded: false });
      return;
    }
    await this.#enqueue(queuedTask(this.#taskRequest(repo.origin, true), Date.now()));
  }

  /**
   * Puts `task` in the store. A retry re-sends the same task: its id is the
   * key, so a put that had landed answers `landedEarlier` and cannot queue it
   * twice.
   */
  async #enqueue(task: Task): Promise<void> {
    this.#stopFollowing();
    this.#patch({ spawning: true, verdict: null });
    try {
      const reply = await this.#client.createTask(task);
      if (reply === null) {
        this.#showVerdict({ kind: "unqueued", message: STORE_UNREADABLE, mayHaveLanded: true, retry: task });
      } else if (!reply.ok) {
        // A refusal says nothing was stored. Only a full store or a busy minute is worth asking again.
        const again = reply.code === "rate_limited" || reply.code === "store_full";
        this.#showVerdict({
          kind: "unqueued",
          message: sentence(storeErrorText(reply.code)),
          mayHaveLanded: false,
          ...(again ? { retry: task } : {}),
        });
      } else {
        this.#disarmUndo();
        this.#patch({ form: { ...this.#state.form, prompt: "" }, promptUndo: null });
        this.#showVerdict({ kind: "queued", task });
        this.#follow(task.id, QUEUE_POLLS);
      }
    } catch (err) {
      // An error that is no `RequestFailure` says nothing about whether it went out, so it may have.
      const failure = err instanceof RequestFailure ? err : new RequestFailure("dropped", String(err));
      // A timeout or a socket closing after the send may have come after the relay stored it.
      const mayHaveLanded = failure.reason === "timeout" || failure.reason === "dropped";
      const text = failureReasonText(failure);
      this.#showVerdict({
        kind: "unqueued",
        message: `${text.charAt(0).toUpperCase()}${text.slice(1)}`,
        mayHaveLanded,
        retry: task,
      });
    } finally {
      this.#patch({ spawning: false });
    }
  }

  /** Re-reads the queued task while its verdict is up and it has not reached a machine yet. */
  #follow(taskId: string, left: number): void {
    this.#stopFollowing();
    if (left <= 0) return;
    this.#followTimer = setTimeout(() => {
      this.#followTimer = null;
      void this.#refreshTask(taskId, left - 1);
    }, QUEUE_POLL_MS);
  }

  /**
   * One read of the followed task. `left` is the polls still to spend after
   * this one; null is a read a nudge or a reconnect asked for, which spends
   * none and leaves the poll timer as it is.
   */
  async #refreshTask(taskId: string, left: number | null): Promise<void> {
    const showing = (): Task | null => {
      const verdict = this.#state.verdict;
      return verdict?.kind === "queued" && verdict.task.id === taskId ? verdict.task : null;
    };
    if (showing() === null) return;
    const seq = ++this.#taskReadSeq;
    let read: { readonly task: Task } | FollowEnd | "missed" | "waiting";
    try {
      const reply = await this.#client.queue({ tasks: [taskId] });
      if (reply === null) read = { kind: "refused", message: SCHEDULER_UNREADABLE };
      // A takeover in progress is a poll lost, not an answer: the next one hears the new leader.
      else if ("ok" in reply) {
        read =
          reply.code === "not_ready"
            ? "missed"
            : { kind: "refused", message: sentence(schedulerErrorText(reply.code)) };
      } else {
        // An older leader ignores the filter, so the reply is searched; a task it lacks is a poll lost, never a verdict:
        // the store holds it, and the leader that takes it up next lists it.
        const task = reply.tasks.find((t) => t.id === taskId);
        read = task !== undefined ? { task } : "missed";
      }
    } catch (err) {
      // No leader to ask is no poll spent: the task waits in the relay's queue, and so does this.
      read =
        err instanceof RequestFailure && (err.reason === "no_leader" || err.reason === "leader_unverified")
          ? "waiting"
          : "missed";
    }
    const shown = showing();
    // A settled verdict is never walked back by a reply that was in flight when it settled.
    if (shown === null || isSettled(shown.state)) return;
    // Answered after a newer read landed: its task is older, but the poll chain it carries goes on.
    if (seq < this.#taskReadApplied) {
      if (left === null) return;
      if (read === "waiting") this.#follow(taskId, left + 1);
      else if (left > 0) this.#follow(taskId, left);
      else this.#patch({ verdict: { kind: "queued", task: shown, follow: followEnd(read) } });
      return;
    }
    // Only a read that carried the task is newer news than another's: a missed one says nothing.
    if (typeof read === "object" && "task" in read) this.#taskReadApplied = seq;
    const task = typeof read === "object" && "task" in read ? read.task : shown;
    if (typeof read === "object" && !("task" in read)) {
      if (left === null) return;
      this.#patch({ verdict: { kind: "queued", task, follow: read } });
      return;
    }
    if (isSettled(task.state)) {
      this.#stopFollowing();
      this.#patch({ verdict: { kind: "queued", task } });
      return;
    }
    if (left === null) {
      if (task !== shown) this.#patch({ verdict: { kind: "queued", task } });
      return;
    }
    if (read === "waiting") {
      this.#follow(taskId, left + 1);
      return;
    }
    if (left > 0) {
      if (task !== shown) this.#patch({ verdict: { kind: "queued", task } });
      this.#follow(taskId, left);
      return;
    }
    this.#patch({ verdict: { kind: "queued", task, follow: followEnd(read) } });
  }

  #stopFollowing(): void {
    if (this.#followTimer !== null) clearTimeout(this.#followTimer);
    this.#followTimer = null;
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
   * `state.verdict` by the exit animation, and a keyboard activation inside that
   * window would otherwise restore nothing.
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
