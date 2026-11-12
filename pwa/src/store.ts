import type {
  AttachmentRef,
  AutonomyLevel,
  DepAfter,
  MetricsErrorCode,
  MetricsReply,
  MetricsRequest,
  RescanResponse,
  SessionsResponse,
  SpawnClient,
  StoreRefusal,
  Task,
  TaskCreated,
  TaskSpec,
  TaskUntil,
} from "@seance/shared";
import {
  ATTACHMENT_LIMITS,
  DEFAULT_AUTONOMY,
  failureReasonText,
  queuedTask,
  RequestFailure,
  sentence,
  storeErrorText,
  storeFullUnreadableText,
  TASK_REQUEST_LIMITS,
  TASK_SPEC_LIMITS,
  taskRequest,
  withAutonomy,
  withReportInstruction,
  type RelayClient,
} from "@seance/shared";
import {
  AUTONOMY_LABELS,
  DEFAULT_FORM,
  DEFAULT_HISTORY_RANGE,
  HELD_MAX,
  heldOrder,
  heldStale,
  RANGE_SPANS,
  RESCAN_IDLE,
  TARGET_METRICS,
  type Effort,
  type HeldTask,
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
import {
  admitFiles,
  manifestOf,
  notAttachedText,
  uploadFailureShort,
  uploadRefusalText,
  type PickedFile,
  type UploadState,
} from "./attachments.ts";
import type { ReceivedShare } from "./share-inbox.ts";
import { accountSeries } from "./chart.ts";
import { SchedulerStore, STORE_UNREADABLE } from "./scheduler-store.ts";
import { taskTitle } from "./task-title.ts";
import type { AppState } from "./view.ts";
import {
  ATTACHMENTS_NOT_HELD,
  ATTACHMENTS_UNAVAILABLE,
  canHold,
  attachmentsWithdrawn,
  deriveAttachmentsAvailability,
  deriveAutoAvailability,
  derivePinAccountAvailability,
  derivePinProblem,
  deriveReportedAvailability,
  heldNeedsLeader,
  leaderVerified,
  resolveRepo,
  scopedRepos,
  settlesOnReport,
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

const REPORTED_UNAVAILABLE = "The scheduler's leader doesn't take tasks that settle on a done report yet.";

/** How long a cleared prompt stays recoverable. Undo instead of a confirm dialog. */
export const UNDO_WINDOW_MS = 6000;

const unqueued = (message: string): Verdict => ({ kind: "unqueued", message, mayHaveLanded: false });

const LOCKED_NOTICE = "Files can't be added once Queue is pressed.";

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
   * whenever the socket isn't open, which keeps every re-dial a full refresh;
   * a resume that finds the socket live keeps it, since the registry pushes
   * kept coming on that socket.
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
  /**
   * Held tasks go out once per socket, when its registry settles (the leader's
   * capabilities are read from it), never on every relay change: a send that
   * timed out would otherwise go again on each status beat.
   */
  #sentOnSettle = false;
  #sendingHeld = false;
  /** Taps made while a re-dial settles, each waiting to learn whether it reconnected (`#submit`). */
  #settleWaiters: (() => void)[] = [];
  /** Whether the leader was verified at the last relay change: held tasks needing one go when it is. */
  #leaderWasVerified = false;
  /** Held task ids sent on this socket; a retry takes its own back out. */
  #triedOnSocket = new Set<string>();
  /** The abort handle of each upload in flight, by file key: removing the file cuts it off. */
  readonly #uploadAborts = new Map<string, AbortController>();
  /** Whether an upload is in flight. Checked and set synchronously, so a file added as one ends is never missed. */
  #pumping = false;
  /** Set by a refusal that every later file would meet too (allowance, key, no relay); cleared by a Queue press or a pick. */
  /** Why the pump stopped; a reopened socket lifts `unreachable` only, the other two wait for a press or a pick. */
  #pumpHalted: "allowance_exhausted" | "unauthorized" | "unreachable" | null = null;
  /** A Queue press waiting for the uploads to go idle (`#awaitUploads`). */
  #uploadIdleWaiters: (() => void)[] = [];
  readonly #queue: SchedulerStore;
  readonly #accounts: AccountStore;

  constructor(client: RelayClient, form: PersistedForm = DEFAULT_FORM, held: readonly HeldTask[] = []) {
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
      autonomy: DEFAULT_AUTONOMY,
      promptUndo: null,
      sheet: null,
      settings: false,
      machines: false,
      history: null,
      spawning: false,
      rescan: RESCAN_IDLE,
      verdict: null,
      held,
      preview: null,
      sessions: {},
      queue: false,
      wide: false,
      queueView: null,
      focusedTask: null,
      taskAction: null,
      queueNotice: null,
      startNowRefusal: null,
      pausing: false,
      discarding: false,
      accounts: { aliases: {}, nameable: client.accountsNamed, saving: null, notice: null },
      attachments: [],
      attachNotice: null,
      heldDropped: [],
      awaitingUploads: false,
    };
  }

  getState = (): AppState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Wires up relay and lifecycle listeners; returns a disposer. */
  attach(): () => void {
    // Here, not in the constructor: the persistence wiring subscribes in between, so the drop reaches storage.
    this.#dropStaleHeld();
    const unsubscribe = this.#client.subscribe(() => this.#onRelay());
    let hiddenAt: number | null = null;
    let attached = true;
    const onVisibility = (): void => {
      if (document.visibilityState !== "visible") {
        hiddenAt = Date.now();
        return;
      }
      // An installed PWA is suspended constantly and the socket dies silently,
      // so a resume can't trust it: the client probes it, or re-dials outright
      // after a long hide. Wall-clock time, since a suspended page's timers and
      // monotonic clocks may not have moved; unknown counts as long.
      const hiddenMs = hiddenAt === null ? Infinity : Date.now() - hiddenAt;
      hiddenAt = null;
      void this.#client.reconnectIfStale(hiddenMs).then((outcome) => {
        // A re-dial's reopen (`#onRelay`) reads everything again by itself, and a
        // tab hidden again before the pong keeps what it missed for the next show.
        if (outcome !== "live" || !attached || document.visibilityState !== "visible") return;
        const relay = this.#client.getState();
        if (relay.status !== "open") return;
        this.#queue.onShown(relay);
        this.#accounts.onShown();
      });
    };
    document.addEventListener("visibilitychange", onVisibility);
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
      attached = false;
      document.removeEventListener("visibilitychange", onVisibility);
      this.#disarmUndo();
      this.#queue.dispose();
      this.#accounts.dispose();
    };
  }

  /** Same object back when nothing moved: `useState` bails out on reference equality. */
  #patch(next: Partial<AppState>): void {
    const keys = Object.keys(next) as readonly (keyof AppState)[];
    if (keys.every((key) => Object.is(this.#state[key], next[key]))) return;
    // The lock notice is true only while the press is out; a press that ended must not leave it up.
    const unlocked = this.#state.spawning && next.spawning === false && next.attachNotice === undefined;
    this.#state = {
      ...this.#state,
      ...next,
      ...(unlocked && this.#state.attachNotice === LOCKED_NOTICE ? { attachNotice: null } : {}),
    };
    for (const listener of this.#listeners) listener();
  }

  #onRelay(): void {
    const relay = this.#client.getState();
    const socketBack = relay.status === "open" && this.#state.relay.status !== "open";
    // Pruned in the same patch as the registry that justifies it: patched apart,
    // subscribers get one render where the machine is gone but the selection
    // still names it.
    // Only an authoritative registry may prune — while it is unsettled an empty
    // `machines` means "no push yet", not "every machine vanished".
    this.#patch({ relay, ...(relay.registrySettled ? this.#pruneGone(relay.machines) : {}) });
    // Files admitted while attaching wasn't offered (a share at boot, a pick in a re-dial) start once it is.
    // An upload is its own HTTP request, so a dropped socket doesn't cut it (the create is re-checked after
    // the wait). One going while a verified leader stops taking files is cut: its object may land, but no create follows.
    if (attachmentsWithdrawn(relay)) for (const controller of this.#uploadAborts.values()) controller.abort();
    // The network that failed an upload is likely back with the socket.
    if (socketBack && this.#pumpHalted === "unreachable") this.#pumpHalted = null;
    this.#pumpUploads();
    const decided = relay.status === "open" ? relay.registrySettled : !relay.settling;
    if (decided && this.#settleWaiters.length > 0) {
      const waiters = this.#settleWaiters;
      this.#settleWaiters = [];
      for (const resolve of waiters) resolve();
    }
    if (relay.status !== "open") {
      // Forgotten rather than kept: the re-dial's registry names the same
      // machines, so leaving the map in place means nothing ever counts as
      // woken again and the session lists stay at whatever the very first
      // connect saw.
      this.#wokenAt = new Map();
      this.#queue.onDrop();
      this.#wasOpen = false;
      this.#sentOnSettle = false;
      this.#leaderWasVerified = false;
      this.#triedOnSocket = new Set();
      return;
    }
    const verified = leaderVerified(relay);
    const leaderArrived = verified && !this.#leaderWasVerified;
    this.#leaderWasVerified = verified;
    if (relay.registrySettled && (!this.#sentOnSettle || leaderArrived)) {
      this.#sentOnSettle = true;
      void this.#sendHeld();
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

  /**
   * Adds picked, pasted or dropped files as far as the limits allow, says why the
   * rest were left out, and starts uploading them. Ignored once Queue is pressed:
   * the list is what is being sent.
   */
  addFiles(files: readonly File[]): void {
    if (files.length === 0) return;
    if (this.#state.spawning) {
      this.#patch({ attachNotice: LOCKED_NOTICE });
      return;
    }
    this.#admit(files, [], []);
  }

  /**
   * A share from the OS share sheet, drained at boot (share-inbox.ts). Its text goes
   * after the prompt, never over it; its files meet the same limits as a pick, and the
   * notice adds the clauses the worker refused and whatever of the share didn't arrive.
   */
  receiveShare(share: ReceivedShare): void {
    if (share.text !== "") {
      const { prompt } = this.#state.form;
      this.setPrompt(prompt === "" ? share.text : `${prompt}\n\n${share.text}`);
    }
    this.#admit(share.files, share.refused, share.problems);
  }

  #admit(files: readonly File[], refusedBefore: readonly string[], problems: readonly string[]): void {
    const before = this.#state.attachments;
    const { files: next, refused } = admitFiles(before, files);
    const sentences = [notAttachedText([...new Set([...refusedBefore, ...refused])]), ...problems].filter(
      (s) => s !== null,
    );
    if (next.length > before.length) this.#pumpHalted = null;
    this.#patch({ attachments: next, attachNotice: sentences.length === 0 ? null : sentences.join(" ") });
    // route-preview filters on the flag; it changes only when the list empties or fills.
    if (before.length === 0 && next.length > 0) void this.refreshPreview();
    this.#pumpUploads();
  }

  /** Also mid-upload, which it aborts, and while Queue waits on uploads; never once the create is out. */
  removeFile(key: string): void {
    if (this.#state.spawning && !this.#state.awaitingUploads) return;
    this.#uploadAborts.get(key)?.abort();
    if (this.#pumpHalted === "unreachable") this.#pumpHalted = null;
    const next = this.#state.attachments.filter((f) => f.key !== key);
    this.#patch({ attachments: next, attachNotice: null });
    if (next.length === 0) void this.refreshPreview();
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

  setAutonomy(autonomy: AutonomyLevel): void {
    this.#patch({ autonomy });
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
      focusedTask: null,
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

  /** Marks a task for the Queue screen to bring into view (a notification's link); `clearFocus` ends it. */
  focusTask(taskId: string): void {
    this.#patch({ focusedTask: taskId });
  }

  clearFocus(): void {
    if (this.#state.focusedTask !== null) this.#patch({ focusedTask: null });
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

  runNow(taskId: string): Promise<void> {
    return this.#queue.runNow(taskId);
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
      // A notification's focus never listed (the task was pruned) must not scroll some later visit.
      this.#patch({ queue: false, queueNotice: null, focusedTask: null });
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
   * `runNow`: a Start now, the same task with a `run-now` once it is `ready`.
   * With the socket down the task is held instead (`canHold`), and a Start now is a plain queue:
   * a `run-now` sent whenever the app next reconnects would skip the caps at a moment nobody chose.
   */
  async #submit(runNow: boolean): Promise<void> {
    const { relay } = this.#state;
    const holding = canHold(relay);
    if ((!holding && !deriveAutoAvailability(relay).available) || this.#state.spawning) return;
    // A resume's re-dial reconnects within a second or two (both settle windows are 1.5 s), so a tap
    // in it waits as "Queuing…" for the outcome rather than holding: holding would announce "not
    // connected" a moment before sending anyway.
    if (holding && relay.settling) {
      this.#patch({ spawning: true });
      await new Promise<void>((resolve) => {
        this.#settleWaiters.push(resolve);
      });
      this.#patch({ spawning: false });
      await this.#submit(runNow);
      return;
    }
    const first = this.#prepare();
    if (first.kind !== "ready") {
      if (first.kind === "refused") this.#showVerdict(unqueued(first.message));
      return;
    }
    let prepared = first;
    let attachments: readonly AttachmentRef[] | undefined;
    if (first.attaching) {
      const waited = await this.#awaitUploads();
      if (waited === null) return;
      // The wait can be long and the form stays live: whatever changed in it (prompt, pins, deps) or in the
      // relay (leader, socket) is what the task is built from, under the same checks as at the press.
      const again = this.#prepare();
      if (again.kind !== "ready" || !again.attaching) {
        this.#patch({ spawning: false });
        // A silent stop is possible here that wasn't at the press (the repo left scope during the wait).
        this.#showVerdict(
          unqueued(
            again.kind === "refused"
              ? again.message
              : "The form changed while the files uploaded and no repo is in scope now. Nothing was queued.",
          ),
        );
        return;
      }
      prepared = again;
      attachments = waited;
    }
    const task = queuedTask(prepared.spec(attachments), Date.now());
    if (prepared.holding) this.#hold(task);
    else await this.#enqueue(task, runNow);
  }

  /**
   * The checks a Queue press makes, and the spec they allow, from the form and relay as they stand now:
   * run at the press and again once uploads settle. `silent` is a stop with no verdict (no repo in scope).
   */
  #prepare():
    | { readonly kind: "refused"; readonly message: string }
    | { readonly kind: "silent" }
    | {
        readonly kind: "ready";
        readonly holding: boolean;
        readonly attaching: boolean;
        readonly spec: (attachments: readonly AttachmentRef[] | undefined) => TaskSpec;
      } {
    const { relay, form } = this.#state;
    const holding = canHold(relay);
    if (!holding && !deriveAutoAvailability(relay).available) return { kind: "silent" };
    const refused = (message: string) => ({ kind: "refused", message }) as const;
    // The leader bounds what it reads; past the bound it would skip the task, and the store's refusal blames versions.
    // The button blocks these too; a form that changed since it rendered is stopped here. Before the repo
    // check: a pin nothing satisfies leaves no repo in scope, and that silence would hide the reason.
    const problem = derivePinProblem(relay, form, this.#state.accounts.aliases);
    if (problem !== null) return refused(`${problem.text}.`);
    const repo = resolveRepo(scopedRepos(relay.machines, form), form);
    if (repo === null) return { kind: "silent" };
    const reported = form.until === "reported";
    // An older leader would drop `until` and hold a `done` edge unreadable, so neither is written to one.
    // A held task is checked when it is sent: no relay, no leader to ask.
    if (
      !holding &&
      (reported || form.after.some((dep) => dep.after === "done")) &&
      !deriveReportedAvailability(relay)
    ) {
      return refused(`${REPORTED_UNAVAILABLE} Update seanced on its machine, or pick another setting.`);
    }
    if (reported && form.prompt.trim() === "") {
      return refused("A task that settles on its done report needs a prompt: the session is told in it to report.");
    }
    const attaching = this.#state.attachments.length > 0;
    if (attaching && !deriveAttachmentsAvailability(relay)) {
      return refused(`${holding ? ATTACHMENTS_NOT_HELD : ATTACHMENTS_UNAVAILABLE}.`);
    }
    const { autonomy } = this.#state;
    const level = withAutonomy<Pick<TaskSpec, "autonomy" | "plan">>(autonomy === DEFAULT_AUTONOMY ? {} : { autonomy });
    // The form has no `plan` of its own, so the level can't contradict it; refused rather than dropped if it ever does.
    if (level === null) return refused(`${AUTONOMY_LABELS[autonomy]} can't be sent with this task's plan mode.`);
    const request = taskRequest(form, repo.origin, true);
    // Appended here so the length below is the one the leader reads; it never rewrites a prompt.
    const prompt = reported && request.prompt !== undefined ? withReportInstruction(request.prompt) : request.prompt;
    const length = prompt?.length ?? 0;
    // A task carrying files takes a shorter prompt: the manifest shares the record's create cap.
    const bound = attaching ? ATTACHMENT_LIMITS.prompt : TASK_REQUEST_LIMITS.prompt;
    if (length > bound) {
      const instruction = reported ? " (with the instruction to report, which is added)" : "";
      const files = attaching ? " beside attached files" : "";
      return refused(
        `The prompt is ${length} characters${instruction}; the scheduler takes at most ${bound}${files}. Shorten it, or use \`seanced spawn --now\` on the machine.`,
      );
    }
    // Only ids: an alias or email is display text and never goes in a record.
    const pin = {
      ...(form.machine === null ? {} : { deviceId: form.machine }),
      ...(form.account === null ? {} : { account: form.account }),
    };
    return {
      kind: "ready",
      holding,
      attaching,
      spec: (attachments) => ({
        ...request,
        // Only off the default: a `checkpoint` task's record stays what it was before levels existed.
        ...level,
        ...(prompt === undefined ? {} : { prompt }),
        ...(form.machine === null && form.account === null ? {} : { pin }),
        client: "pwa" satisfies SpawnClient,
        ...(form.after.length === 0 ? {} : { deps: form.after }),
        ...(reported ? { until: form.until } : {}),
        ...(attachments === undefined ? {} : { attachments }),
      }),
    };
  }

  /** Keeps `task` on this phone, clearing the form as a stored one does; it is sent when a registry next settles. */
  #hold(task: Task): void {
    const { held } = this.#state;
    if (held.length >= HELD_MAX) {
      this.#showVerdict({
        kind: "unqueued",
        message: `${HELD_MAX} tasks are held on this phone already. Discard one, or wait for the relay.`,
        mayHaveLanded: false,
      });
      return;
    }
    this.#queue.stopFollowing();
    this.#patch({ held: [...held, { task, failure: null, sending: false }] });
    this.#clearFormFor(task);
    this.#showVerdict({ kind: "held", task });
  }

  /** The form after `task` was stored or held: deps and `until` belong to that task. */
  #clearFormFor(task: Task): void {
    this.#disarmUndo();
    const { form } = this.#state;
    // Only the files this task carries leave the form: a retry's task names the ones it was built with.
    const sent = new Set(task.spec.attachments?.map((ref) => ref.id));
    this.#patch({
      form: {
        ...form,
        prompt: "",
        after: [],
        until: "merged",
      },
      autonomy: DEFAULT_AUTONOMY,
      promptUndo: null,
      attachments: this.#state.attachments.filter((f) => f.upload.kind !== "stored" || !sent.has(f.upload.id)),
      attachNotice: null,
    });
  }

  /** Why the store refused a create, as the verdict and a held row say it. */
  #refusalText(code: StoreRefusal["code"]): string {
    const unreadable = code === "store_full" ? this.#queue.unreadableCount() : 0;
    return unreadable > 0
      ? `${sentence(storeFullUnreadableText(unreadable))} Clear them on the Queue screen, then try again.`
      : sentence(storeErrorText(code));
  }

  /**
   * Sends every held task that has not failed, oldest first, one at a time. Single-flight; a task
   * retried mid-pass is picked up by the same pass. A send whose answer never came stays held
   * without a failure, and is not sent again on this socket: its resend on the next answers
   * `landedEarlier` if it had landed. One needing a verified leader (`heldNeedsLeader`) is passed
   * over until there is one, never failed on a leader that is only asleep or unverified; one past
   * `HELD_MAX_AGE_MS` is dropped unsent.
   */
  async #sendHeld(): Promise<void> {
    if (this.#sendingHeld) return;
    this.#sendingHeld = true;
    try {
      for (;;) {
        const { relay } = this.#state;
        if (relay.status !== "open" || !relay.registrySettled) return;
        // Read each turn: a socket that settled while a send was out swapped the set, and this pass serves it too.
        const tried = this.#triedOnSocket;
        this.#dropStaleHeld();
        const verified = leaderVerified(relay);
        const next = this.#state.held.find(
          (entry) =>
            entry.failure === null &&
            !entry.sending &&
            !tried.has(entry.task.id) &&
            (verified || !heldNeedsLeader(entry.task)),
        );
        if (next === undefined) return;
        tried.add(next.task.id);
        // oxlint-disable-next-line no-await-in-loop -- sequential on purpose: batch order, one create at a time
        await this.#sendOne(next.task);
      }
    } finally {
      this.#sendingHeld = false;
    }
  }

  async #sendOne(task: Task): Promise<void> {
    if (settlesOnReport(task) && !deriveReportedAvailability(this.#state.relay)) {
      this.#heldFailed(task, `${REPORTED_UNAVAILABLE} Try again once it does, or discard it.`);
      return;
    }
    // Held without a leader to ask, like a done report; the sealer's exclave guard still covers an older leader.
    if (task.spec.pin?.account !== undefined && derivePinAccountAvailability(this.#state.relay) !== "available") {
      this.#heldFailed(
        task,
        "The scheduler's leader doesn't take account pins yet. Update seanced on its machine, or discard it.",
      );
      return;
    }
    this.#patchHeld(task.id, { sending: true });
    let reply: TaskCreated | StoreRefusal | null;
    try {
      reply = await this.#client.createTask(task);
    } catch {
      // Timed out or dropped: it may have landed, and the resend on the next socket says which.
      this.#patchHeld(task.id, { sending: false });
      return;
    }
    if (reply === null) this.#heldFailed(task, STORE_UNREADABLE);
    else if (!reply.ok) this.#heldFailed(task, this.#refusalText(reply.code));
    else this.#heldLanded(task);
  }

  /** Drops held tasks past the age limit, failed or waiting, and names them in `heldDropped`. */
  #dropStaleHeld(): void {
    const now = Date.now();
    const stale = this.#state.held.filter((entry) => !entry.sending && heldStale(entry.task, now));
    if (stale.length === 0) return;
    const gone = new Set(stale.map((entry) => entry.task.id));
    this.#setHeld(
      this.#state.held.filter((entry) => !gone.has(entry.task.id)),
      [...this.#state.heldDropped, ...stale.map((entry) => taskTitle(entry.task))],
    );
  }

  dismissHeldDropped(): void {
    if (this.#state.heldDropped.length > 0) this.#patch({ heldDropped: [] });
  }

  /**
   * Sets the held list when tasks may have left it without landing here (discarded, dropped, or gone
   * from another tab's write). A held verdict for one that left is closed: this tab can't tell which
   * of those it was, so it claims nothing. Closed only as the top layer, the only place it opens.
   */
  #setHeld(held: readonly HeldTask[], heldDropped: readonly string[] = this.#state.heldDropped): void {
    this.#patch({ held, heldDropped });
    const { verdict } = this.#state;
    if (verdict?.kind !== "held" || held.some((entry) => entry.task.id === verdict.task.id)) return;
    if (this.#openLayers() === 1) this.dismissLayer();
  }

  /**
   * Takes the list another tab wrote (`trackHeld`). A task this tab is sending stays, flagged, until
   * its answer: dropping it would not stop it landing. Sends what came in when this tab's relay is
   * up: the writer may have held it on a dead socket, and nothing else here would send it before
   * this tab's own reconnect. A task both send answers `landedEarlier` the second time.
   */
  adoptHeld(incoming: readonly HeldTask[]): void {
    const current = this.#state.held;
    const sending = new Set(current.filter((entry) => entry.sending).map((entry) => entry.task.id));
    const ids = new Set(incoming.map((entry) => entry.task.id));
    const held = [
      ...incoming.map((entry) => (sending.has(entry.task.id) ? { ...entry, sending: true } : entry)),
      ...current.filter((entry) => entry.sending && !ids.has(entry.task.id)),
    ].toSorted(heldOrder);
    const same =
      held.length === current.length &&
      held.every((entry, i) => {
        const was = current[i];
        return was !== undefined && was.task.id === entry.task.id && was.failure === entry.failure;
      });
    if (!same) this.#setHeld(held);
    void this.#sendHeld();
  }

  #patchHeld(taskId: string, next: Partial<Pick<HeldTask, "failure" | "sending">>): void {
    const held = this.#state.held.map((entry) => (entry.task.id === taskId ? { ...entry, ...next } : entry));
    this.#patch({ held });
  }

  #heldFailed(task: Task, failure: string): void {
    this.#patchHeld(task.id, { failure, sending: false });
    const { verdict } = this.#state;
    if (verdict?.kind !== "held" || verdict.task.id !== task.id) return;
    this.#patch({
      verdict: {
        kind: "unqueued",
        message: `${failure} It's kept on this phone: retry or discard it on the form.`,
        mayHaveLanded: false,
      },
    });
  }

  /** Stored: off the phone, and a held verdict still up for it follows it as a queued one. */
  #heldLanded(task: Task): void {
    this.#patch({ held: this.#state.held.filter((entry) => entry.task.id !== task.id) });
    const { verdict } = this.#state;
    if (verdict?.kind !== "held" || verdict.task.id !== task.id) return;
    this.#queue.stopFollowing();
    this.#patch({ verdict: { kind: "queued", task } });
    this.#queue.startFollowing(task, false);
  }

  /** Clears a held task's failure and sends it if the relay is up; otherwise it waits like any held task. */
  retryHeld(taskId: string): void {
    const entry = this.#state.held.find((candidate) => candidate.task.id === taskId);
    if (entry === undefined || entry.sending) return;
    this.#patchHeld(taskId, { failure: null });
    this.#triedOnSocket.delete(taskId);
    void this.#sendHeld();
  }

  /** Never one being sent: its create is already out, and dropping it here would not stop it landing. */
  discardHeld(taskId: string): void {
    const held = this.#state.held.filter((entry) => entry.task.id !== taskId || entry.sending);
    if (held.length !== this.#state.held.length) this.#setHeld(held);
  }

  /**
   * Uploads waiting files one at a time, in list order, while attaching is offered:
   * each holds its file and the sealed copy in memory, and the phone's uplink is the
   * bottleneck, so parallel uploads would not finish the set sooner. Wakes the
   * Queue press's waiters once nothing is left it can start.
   */
  #pumpUploads(): void {
    if (this.#pumping) return;
    const next =
      deriveAttachmentsAvailability(this.#state.relay) && this.#pumpHalted === null
        ? this.#state.attachments.find((f) => f.upload.kind === "waiting")
        : undefined;
    if (next === undefined) {
      const waiters = this.#uploadIdleWaiters;
      this.#uploadIdleWaiters = [];
      for (const resolve of waiters) resolve();
      return;
    }
    this.#pumping = true;
    void this.#uploadOne(next).finally(() => {
      this.#pumping = false;
      this.#pumpUploads();
    });
  }

  /** Seals and uploads one file, recording where it got; a removed file's outcome is dropped. Never rejects. */
  async #uploadOne(picked: PickedFile): Promise<void> {
    const { key } = picked;
    const controller = new AbortController();
    this.#uploadAborts.set(key, controller);
    this.#setUpload(key, { kind: "uploading", percent: 0 });
    try {
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = new Uint8Array(await picked.file.arrayBuffer());
      } catch {
        this.#setUpload(key, {
          kind: "failed",
          short: "couldn't read the file",
          message:
            "Couldn't read a file from this device. Remove the one marked failed and attach it again. Nothing was queued.",
        });
        return;
      }
      const reply = await this.#client.uploadAttachment(bytes, {
        signal: controller.signal,
        // Short of 100 until the relay answers `201`: the last byte sent is not a stored file.
        onProgress: (sent, total) =>
          this.#setUpload(key, {
            kind: "uploading",
            percent: total > 0 ? Math.min(99, Math.floor((sent / total) * 100)) : 0,
          }),
      });
      if (reply.ok) this.#setUpload(key, { kind: "stored", id: reply.id, hash: reply.hash });
      // A removed file's outcome is dropped by #setUpload; one still on the form goes back in line.
      else if (reply.code === "aborted") this.#setUpload(key, { kind: "waiting" });
      else {
        if (reply.code === "allowance_exhausted" || reply.code === "unauthorized" || reply.code === "unreachable") {
          this.#pumpHalted = reply.code;
        }
        this.#setUpload(key, {
          kind: "failed",
          short: uploadFailureShort(reply),
          message: uploadRefusalText(reply),
        });
      }
    } catch (err) {
      this.#setUpload(key, {
        kind: "failed",
        short: "upload failed",
        message: `Couldn't upload a file (${String(err)}). Nothing was queued.`,
      });
    } finally {
      this.#uploadAborts.delete(key);
    }
  }

  /** Patches one file's upload state; nothing for a file since removed, or a percent that didn't move. */
  #setUpload(key: string, upload: UploadState): void {
    const current = this.#state.attachments.find((f) => f.key === key);
    if (current === undefined) return;
    if (upload.kind === "uploading" && current.upload.kind === "uploading" && current.upload.percent === upload.percent)
      return;
    this.#patch({ attachments: this.#state.attachments.map((f) => (f.key === key ? { ...f, upload } : f)) });
  }

  /**
   * A Queue press with files: failed ones go again under fresh ids, and the press
   * waits until nothing is uploading. Answers the manifest once every file still on
   * the form is stored, or null when
   * nothing is to be queued (also when every file was removed meanwhile), the verdict already saying why.
   */
  async #awaitUploads(): Promise<readonly AttachmentRef[] | null> {
    this.#pumpHalted = null;
    this.#patch({
      spawning: true,
      awaitingUploads: true,
      verdict: null,
      attachments: this.#state.attachments.map((f) =>
        f.upload.kind === "failed" ? { ...f, upload: { kind: "waiting" } } : f,
      ),
    });
    await new Promise<void>((resolve) => {
      this.#uploadIdleWaiters.push(resolve);
      this.#pumpUploads();
    });
    const files = this.#state.attachments;
    const manifest = manifestOf(files);
    // Still spawning on success: the create follows at once, and the button must not offer a second submit between.
    if (manifest !== null && manifest.length === 0) {
      // Every file was removed during the wait: the press asked for a task with files, so it ends here.
      this.#patch({ awaitingUploads: false, spawning: false, attachNotice: "No files left. Nothing was queued." });
      return null;
    }
    if (manifest !== null) {
      this.#patch({ awaitingUploads: false });
      return manifest;
    }
    const failed = files.map((f) => f.upload).find((upload) => upload.kind === "failed");
    this.#patch({ awaitingUploads: false, spawning: false });
    this.#showVerdict({
      kind: "unqueued",
      // Files still waiting: attaching stopped being offered mid-wait (a re-dial, or a leader without it).
      message:
        failed?.kind === "failed"
          ? failed.message
          : "Not every file uploaded: the connection or the scheduler's leader changed. Nothing was queued; files already uploaded aren't sent again.",
      mayHaveLanded: false,
    });
    return null;
  }

  /**
   * Puts `task` in the store. A retry re-sends the same task: its id is the
   * key, so a put that had landed answers `landedEarlier` and cannot queue it
   * twice.
   */
  async #enqueue(task: Task, runNow: boolean): Promise<void> {
    this.#queue.stopFollowing();
    const again = runNow ? { runNow: true as const } : {};
    this.#patch({ spawning: true, verdict: null });
    try {
      const reply = await this.#client.createTask(task);
      if (reply === null) {
        this.#showVerdict({ kind: "unqueued", message: STORE_UNREADABLE, mayHaveLanded: true, retry: task, ...again });
      } else if (!reply.ok) {
        // A refusal says nothing was stored. Only a full store or a busy minute is worth asking again.
        const retryable = reply.code === "rate_limited" || reply.code === "store_full";
        this.#showVerdict({
          kind: "unqueued",
          message: this.#refusalText(reply.code),
          mayHaveLanded: false,
          ...(retryable ? { retry: task, ...again } : {}),
        });
      } else {
        this.#clearFormFor(task);
        this.#showVerdict({ kind: "queued", task });
        this.#queue.startFollowing(task, runNow);
      }
    } catch (err) {
      // An error that is no `RequestFailure` says nothing about whether it went out, so it may have.
      const failure = err instanceof RequestFailure ? err : new RequestFailure("dropped", String(err));
      // A timeout or a socket closing after the send may have come after the relay stored it.
      const mayHaveLanded = failure.reason === "timeout" || failure.reason === "dropped";
      this.#showVerdict({
        kind: "unqueued",
        message: enqueueFailureText(failure),
        mayHaveLanded,
        retry: task,
        ...again,
      });
    } finally {
      this.#patch({ spawning: false });
    }
  }

  async spawn(): Promise<void> {
    await this.#submit(false);
  }

  /** Queues the form as `spawn` does, then asks the leader to skip the queue for it (`run-now`). */
  async startNow(): Promise<void> {
    await this.#submit(true);
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
    const { retry } = verdict;
    if (retry === undefined) return;
    // The leader may have changed since the first try: files go only to a verified leader that takes them.
    if (retry.spec.attachments !== undefined && !deriveAttachmentsAvailability(this.#state.relay)) {
      this.#showVerdict({ ...verdict, message: `${ATTACHMENTS_UNAVAILABLE}.` });
      return;
    }
    await this.#enqueue(retry, verdict.runNow === true);
  }

  reconnect(): void {
    this.#client.reconnect();
  }
}
