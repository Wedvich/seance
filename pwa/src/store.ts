import type {
  DepAfter,
  MetricsErrorCode,
  MetricsReply,
  MetricsRequest,
  RescanResponse,
  SessionsResponse,
  SpawnClient,
  Task,
  TaskSpec,
  TaskUntil,
} from "@seance/shared";
import {
  BATCH_STRATEGY,
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
  RESCAN_IDLE,
  TARGET_METRICS,
  type Effort,
  type HistoryRange,
  type HistoryResult,
  type HistoryTarget,
  type HistoryView,
  type Model,
  type PersistedForm,
  type SheetKind,
  type Verdict,
} from "./state.ts";
import { AccountStore } from "./account-store.ts";
import { accountSeries } from "./chart.ts";
import { SchedulerStore, STORE_UNREADABLE, taskRequest } from "./scheduler-store.ts";
import type { AppState } from "./view.ts";
import {
  deriveAutoAvailability,
  derivePinProblem,
  deriveReportedAvailability,
  resolveRepo,
  scopedRepos,
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
  readonly #accounts: AccountStore;

  constructor(client: RelayClient, form: PersistedForm = DEFAULT_FORM) {
    this.#client = client;
    this.#queue = new SchedulerStore(
      client,
      () => this.#state,
      (next) => this.#patch(next),
    );
    this.#accounts = new AccountStore(
      client,
      () => this.#state,
      (next) => this.#patch(next),
    );
    this.#state = {
      relay: client.getState(),
      form,
      promptUndo: null,
      sheet: null,
      settings: false,
      machines: false,
      history: null,
      spawning: false,
      rescan: RESCAN_IDLE,
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
      accounts: { aliases: {}, nameable: client.accountsNamed, saving: null, notice: null },
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
    const unsubscribeAccounts = this.#client.onStoreChanged((key, version) =>
      this.#accounts.onStoreChanged(key, version),
    );
    this.#skipStaleEntries();
    this.#onRelay();
    return () => {
      unsubscribe();
      unsubscribeQueue();
      unsubscribeAccounts();
      document.removeEventListener("visibilitychange", onVisible);
      this.#disarmUndo();
      this.#queue.dispose();
      this.#accounts.dispose();
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
    this.#queue.onOpen(relay, reopened);
    this.#accounts.onOpen(reopened);
  }

  /**
   * Drops everything keyed by a deviceId the registry no longer lists — the
   * machine pick, the session list and the wake mark. Nothing brings that id
   * back: a reinstall mints a new one, so all of it is dead state. The account
   * pick stays: an account is no machine's, and one signed in nowhere shows as
   * that rather than silently turning to auto.
   * Doing it here rather than at the bin is what makes a refused or undelivered
   * forget leave the app untouched.
   */
  #pruneGone(machines: readonly { readonly deviceId: string }[]): Partial<AppState> {
    const live = new Set(machines.map((machine) => machine.deviceId));
    for (const deviceId of [...this.#wokenAt.keys()]) if (!live.has(deviceId)) this.#wokenAt.delete(deviceId);

    const { form, sessions } = this.#state;
    const kept = Object.fromEntries(Object.entries(sessions).filter(([id]) => live.has(id)));
    // Same objects back when nothing was dropped: #patch bails on identity.
    return {
      form: form.machine !== null && !live.has(form.machine) ? { ...form, machine: null } : form,
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

  /** Pins the machine (null is auto) and clears any verdict. The account pick stays: neither picker resets the other. */
  pickMachine(machine: string | null): void {
    this.#pick({ machine });
  }

  /** Pins the account (null is auto); see `pickMachine`. */
  pickAccount(account: string | null): void {
    this.#pick({ account });
  }

  #pick(pins: Partial<Pick<PersistedForm, "machine" | "account">>): void {
    // Counted before the patch: clearing the verdict here would otherwise leave
    // its entry behind once the sheet's back had been spent. Settings is not the
    // sheet's to close.
    const open = this.#sheetAndVerdictOpen();
    const { form, relay } = this.#state;
    const next = { ...form, ...pins };
    // The repo stays unless the new pins leave it no clone: then the first in scope takes over.
    const inScope = next.repo === null || scopedRepos(relay.machines, next).some((repo) => repo.origin === next.repo);
    this.#patch({ form: inScope ? next : { ...next, repo: null }, verdict: null });
    if (open > 0) history.go(-open);
    // Clears the preview when either is pinned: route-preview drops a pin.
    void this.refreshPreview();
  }

  /** The history entries a picker's pick closes. */
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

  /** `repo` is an origin: the choice is the form's, not a machine's. */
  selectRepo(repo: string): void {
    this.#patch({ form: { ...this.#state.form, repo } });
    this.dismissLayer();
    void this.refreshPreview();
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
   * The next enqueues join a new batch, numbered from 1. An open batch stays
   * open: a second tap must not renumber a batch already in flight.
   */
  startBatch(): void {
    const { form } = this.#state;
    if (form.batch === null) this.#patch({ form: { ...form, batch: { id: crypto.randomUUID(), next: 1 } } });
    this.dismissLayer();
  }

  endBatch(): void {
    this.#patch({ form: { ...this.#state.form, batch: null } });
    this.dismissLayer();
  }

  /**
   * "Follow up" on a queue row: the form takes that task as its one dependency.
   * The queue (and a verdict under it) closes like a machine pick's sheet does,
   * so the form is what shows; in the desktop layout the queue is a column and stays.
   * Both pickers go back to auto: a follow-up is placed by the scheduler like a fresh
   * task, not inherited onto the pins of whatever the form held before.
   */
  followUp(taskId: string): void {
    const { form, relay, queue, verdict } = this.#state;
    if (!deriveAutoAvailability(relay).available) return;
    const open = (queue ? 1 : 0) + (verdict === null ? 0 : 1);
    this.#patch({
      form: { ...form, machine: null, account: null, after: [{ task: taskId, after: "opened" }] },
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

  continueTask(taskId: string): Promise<void> {
    return this.#queue.continueTask(taskId);
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
      const rescan = sheet === "machine" && this.#state.rescan.kind === "failed" ? RESCAN_IDLE : this.#state.rescan;
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

  /** Names a Claude account (blank clears it); every client shows it. True when the name landed. */
  renameAccount(accountId: string, text: string): Promise<boolean> {
    return this.#accounts.rename(accountId, text);
  }

  dismissAccountNotice(): void {
    this.#accounts.dismissNotice();
  }

  #showVerdict(verdict: Verdict): void {
    if (this.#state.verdict === null) this.#pushLayer();
    this.#patch({ verdict });
  }

  /** One machine's `rescan`, from its row on the Machine sheet; only that row shows it scanning or failed. */
  async rescan(deviceId: string): Promise<void> {
    if (this.#state.rescan.kind === "scanning") return;
    this.#patch({ rescan: { kind: "scanning", deviceId } });
    try {
      await this.#rescan(deviceId);
      this.#patch({ rescan: RESCAN_IDLE });
    } catch {
      // The previous list stays in place — the truth we had — with the failure said inline.
      this.#patch({ rescan: { kind: "failed", deviceId } });
    }
  }

  /**
   * The reply is the only report of a scan that changed nothing: the daemon
   * re-registers just when the repo set moved, so waiting for a registry push
   * would leave the row asserting the previous scan's time.
   */
  async #rescan(deviceId: string): Promise<void> {
    const reply = await this.#client.request<RescanResponse>(deviceId, "rescan", {});
    if ("ok" in reply) throw new Error(reply.code);
    // A reply this build can't read is a failed rescan, not a shorter list.
    if (this.#client.applyScan(deviceId, reply) === null) throw new Error("unreadable rescan reply");
  }

  /**
   * Every spawn is a task written to the relay's store (`createTask`), which
   * answers for itself: no leader need be up, and whichever one leads next reads
   * it. A picked machine or account is a pin on it, never a direct spawn.
   */
  async #submit(): Promise<void> {
    const { relay, form } = this.#state;
    if (!deriveAutoAvailability(relay).available || this.#state.spawning) return;
    // The leader bounds what it reads; past the bound it would skip the task, and the store's refusal blames versions.
    const refusal = (message: string): void => this.#showVerdict({ kind: "unqueued", message, mayHaveLanded: false });
    // The button blocks these too; a form that changed since it rendered is stopped here. Before the repo
    // check: a pin nothing satisfies leaves no repo in scope, and that silence would hide the reason.
    const problem = derivePinProblem(relay, form, this.#state.accounts.aliases);
    if (problem !== null) {
      refusal(`${problem.text}.`);
      return;
    }
    const repo = resolveRepo(scopedRepos(relay.machines, form), form);
    if (repo === null) return;
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
        `The prompt is ${length} characters${instruction}; the scheduler takes at most ${TASK_REQUEST_LIMITS.prompt}. Shorten it, or use \`seanced spawn --now\` on the machine.`,
      );
      return;
    }
    const issue = form.linearIssue.trim();
    // Only ids: an alias or email is display text and never goes in a record.
    const pin = {
      ...(form.machine === null ? {} : { deviceId: form.machine }),
      ...(form.account === null ? {} : { account: form.account }),
    };
    const spec: TaskSpec = {
      ...request,
      ...(prompt === undefined ? {} : { prompt }),
      ...(form.machine === null && form.account === null ? {} : { pin }),
      client: "pwa" satisfies SpawnClient,
      ...(form.after.length === 0 ? {} : { deps: form.after }),
      ...(form.batch === null
        ? {}
        : { batch: { id: form.batch.id, index: form.batch.next, strategy: BATCH_STRATEGY } }),
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
    await this.#submit();
  }

  /** Clears the prompt and returns to the form. */
  startAnother(): void {
    this.setPrompt("");
    this.dismissLayer();
  }

  /**
   * Puts an unqueued verdict's task again. Takes the rendered verdict rather
   * than reading state: the rendered one outlives `state.verdict` by the frame a
   * view transition waits for its capture (app.tsx). The entry the verdict's
   * layer holds is kept for whatever layer the retry opens next, and given back
   * when it ends without one.
   */
  retrySpawn(verdict: Verdict): void {
    if (verdict.kind !== "unqueued") return;
    if (this.#state.verdict !== null) {
      this.#held = true;
      this.#patch({ verdict: null });
    }
    void this.retryEnqueue(verdict).finally(() => this.#releaseHeld());
  }

  /** Puts an unqueued verdict's task again; nothing to put leaves the form as the retry found it. */
  async retryEnqueue(verdict: Extract<Verdict, { kind: "unqueued" }>): Promise<void> {
    if (verdict.retry !== undefined) await this.#enqueue(verdict.retry);
  }

  reconnect(): void {
    this.#client.reconnect();
  }
}
