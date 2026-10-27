import type {
  Machine,
  PauseHold,
  QueueChanged,
  RelayState,
  SchedulerAvailability,
  Task,
  TaskRequest,
} from "@seance/shared";
import {
  continuationSpec,
  continueOffer,
  failureReasonText,
  isSettled,
  isTransportError,
  QUEUE_MAX_TASKS,
  queuedTask,
  RequestFailure,
  schedulerErrorText,
  sentence,
  storeErrorText,
  type RelayClient,
} from "@seance/shared";
import type { FollowEnd, PersistedForm, PreviewState, QueueState, TaskAction } from "./state.ts";
import type { AppState } from "./view.ts";
import { deriveAutoAvailability, deriveContinueAvailability, previewAsked, resolveRepo, scopedRepos } from "./view.ts";

/**
 * The app's side of the scheduler, apart from `Store`'s layers, form and
 * spawns: the Queue screen's reads and actions, the queued verdict's follow,
 * and the `auto` preview. What these show lives in the `AppState` its `Store`
 * holds, read and patched through the constructor's two seams; the fields here
 * are only the bookkeeping behind them (timers, read sequences, what was last
 * asked). Enqueueing stays in `Store`: its verdict is a layer.
 */

export const STORE_UNREADABLE = "Couldn't read the relay's answer. Update the app and the relay to matching versions.";

const CONTINUE_UNAVAILABLE =
  "No verified scheduler that can continue a session is leading right now. Try again once one is.";

const SCHEDULER_UNREADABLE = "Couldn't read the scheduler's answer. Update seanced and the app to matching versions.";

/** Closes the notice of a queue action whose answer never came: the leader may have acted. */
const REFRESH_HINT = "Refresh to see whether it did.";
const MAY_HAVE_LANDED = `It may have landed anyway. ${REFRESH_HINT}`;

/**
 * A scheduler read's failure, shown alone. A read has nothing to land, so the
 * shared line's "may have landed" for a timeout or a drop would mislead.
 */
function readFailureText(err: unknown, fallback: string): string {
  if (!(err instanceof RequestFailure)) return sentence(fallback);
  if (err.reason === "timeout") return "The scheduler did not answer in time.";
  if (err.reason === "dropped") return "Lost the relay connection before the answer came.";
  return sentence(failureReasonText(err));
}

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

/** The leader refuses a named read past `QUEUE_MAX_TASKS`: one that long is read whole instead. */
function capNamed(tasks: readonly string[]): readonly string[] | null {
  return tasks.length > QUEUE_MAX_TASKS ? null : tasks;
}

/**
 * One read of a followed task: the task itself, an end (a refusal, or the
 * store saying it is gone), `missed` (no answer), `unlisted` (answered without
 * it while the store still holds it) or `waiting` (no leader to ask).
 */
type FollowRead = { readonly task: Task } | FollowEnd | "missed" | "unlisted" | "waiting";

/** How a followed task's last poll ends the verdict's follow: an end as it was, else by what the poll heard. */
function followEnd(read: FollowRead): FollowEnd {
  if (typeof read === "object" && !("task" in read)) return read;
  if (read === "missed") return { kind: "unanswered" };
  return { kind: read === "unlisted" ? "unlisted" : "stopped" };
}

/**
 * What would answer a preview: a new leader, or the same one verified at last,
 * asks again. Never "", which is what a drop resets the last-asked key to.
 */
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

/** A hold decides a preview's answer as much as the fleet does. */
function holdsKey(holds: readonly PauseHold[]): string {
  return holds.map((h) => `${h.account ?? ""}:${h.until}:${h.resumeAt ?? ""}`).join(";");
}

/** A presence or repo change asks the preview again after this quiet, so a registry burst asks once. */
export const PREVIEW_DEBOUNCE_MS = 500;

/** The form as a `TaskRequest`; a preview leaves the prompt out, which routing never reads. */
export function taskRequest(form: PersistedForm, origin: string, withPrompt: boolean): TaskRequest {
  const prompt = form.prompt.trim();
  return {
    repo: origin,
    mode: form.worktree ? "worktree" : "here",
    model: form.model,
    effort: form.effort,
    ...(withPrompt && prompt !== "" ? { prompt } : {}),
  };
}

export class SchedulerStore {
  readonly #client: RelayClient;
  readonly #getState: () => AppState;
  readonly #patch: (next: Partial<AppState>) => void;
  /** The leader `auto` last previewed against: a new one, or one verified at last, asks again. */
  #previewedLeader = "";
  /** The fleet `auto` last previewed against (`fleetKey`). */
  #previewedFleet = "";
  #followTimer: ReturnType<typeof setTimeout> | null = null;
  /** The leader the Queue screen last read from: a new one asks again. */
  #queueLeader = "";
  /** The socket dropped since the last catch-up read: nudges sent meanwhile are lost, so the next verified leader is read whole. */
  #queueMissed = false;
  /**
   * Whether the notice up now is one a queue read set. Any read that lands
   * clears it, nudged or not: only an action's notice outlives a nudge's read.
   */
  #noticeFromRead = false;
  /** The queue read loop while one is out: reads are single-flight, a later ask folds into `#queueTrailing`. */
  #queueRun: Promise<void> | null = null;
  /** What to read once the one in flight settles: the union of every ask meanwhile (null names the whole queue). */
  #queueTrailing: { readonly tasks: readonly string[] | null; readonly nudged: boolean } | null = null;
  /** The view a `loading` patch replaced, restored when the read fails with nobody looking. */
  #queuePrior: QueueState | null = null;
  /** Sequence of task reads: a poll answered after a newer read landed is stale. */
  #taskReadSeq = 0;
  #taskReadApplied = 0;
  #previewRetry: ReturnType<typeof setTimeout> | null = null;

  constructor(client: RelayClient, getState: () => AppState, patch: (next: Partial<AppState>) => void) {
    this.#client = client;
    this.#getState = getState;
    // A read that sets the notice marks it as its own after patching; every other notice write unmarks it.
    this.#patch = (next) => {
      if ("queueNotice" in next) this.#noticeFromRead = false;
      patch(next);
    };
  }

  get #state(): AppState {
    return this.#getState();
  }

  /** The socket closed. */
  onDrop(): void {
    // The leader usually survives a drop unchanged, so without this a preview
    // the drop failed mid-flight would never be asked again on reconnect.
    this.#previewedLeader = "";
    this.#queueMissed = true;
  }

  /** A relay change with the socket open: `reopened` when it had been closed. */
  onOpen(relay: RelayState, reopened: boolean): void {
    this.#catchUpQueue(relay.scheduler, reopened);
    if (!previewAsked(this.#state.form)) return;
    if (schedulerKey(relay.scheduler) !== this.#previewedLeader) void this.refreshPreview();
    else if (fleetKey(relay.machines) !== this.#previewedFleet) this.#askPreviewSoon();
  }

  /** Stops every timer this holds: the follow's poll and the preview's retry or debounce. */
  dispose(): void {
    this.stopFollowing();
    this.stopPreviewRetry();
  }

  /** Starts following a task just queued, with the whole poll budget. */
  startFollowing(taskId: string): void {
    this.#follow(taskId, QUEUE_POLLS);
  }

  /**
   * What a `queue-changed` nudge would have told, once the socket was down or a
   * leader changed: nudges sent meanwhile are lost, and the merge of named ids
   * never heals a task it was not told about, so the screen reads whole again.
   */
  #catchUpQueue(scheduler: SchedulerAvailability, reopened: boolean): void {
    // Only a verified leader is asked: anything else is refused unsent, which
    // tells the screen nothing its status line doesn't — and every new term is
    // unverified until its `lead-proof` lands, so asking then raised a notice
    // on each takeover. The catch-up waits for the leader to verify instead.
    const due =
      scheduler.kind === "ready" &&
      this.#watchesQueue() &&
      (this.#queueMissed || schedulerKey(scheduler) !== this.#queueLeader);
    if (due) this.#queueMissed = false;
    const read = due ? this.refreshQueue(undefined, true) : null;
    const verdict = this.#state.verdict;
    if (reopened && verdict?.kind === "queued" && !isSettled(verdict.task.state)) {
      void this.#followedVia(verdict.task.id, read);
    }
  }

  onQueueChanged(change: QueueChanged): void {
    // Showing the tab again re-dials (`attach`), and the reopen reads the whole queue and the followed task.
    if (document.visibilityState !== "visible") return;
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
    if (isSettled(fresh.state)) this.stopFollowing();
    if (fresh !== verdict.task) this.#patch({ verdict: { kind: "queued", task: fresh } });
  }

  /**
   * The Queue chip's attention dot reads from the list, so it is kept current
   * with the screen closed too, whenever a verified leader could answer.
   */
  #watchesQueue(): boolean {
    return (
      this.#queueOnScreen() || (this.#state.relay.status === "open" && this.#state.relay.scheduler.kind === "ready")
    );
  }

  /** Debounced: each change restarts the wait. */
  #askPreviewSoon(): void {
    this.stopPreviewRetry();
    this.#previewRetry = setTimeout(() => {
      this.#previewRetry = null;
      void this.refreshPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  #queueOnScreen(): boolean {
    return this.#state.queue || this.#state.wide;
  }

  /**
   * Asks the leader what it would decide for the form as it stands, reserving
   * nothing. A reply that lands after the form moved on is dropped, as a chart's is.
   */
  async refreshPreview(attempt = 0): Promise<void> {
    this.stopPreviewRetry();
    const { form, relay } = this.#state;
    this.#previewedLeader = schedulerKey(relay.scheduler);
    this.#previewedFleet = fleetKey(relay.machines);
    const repo = resolveRepo(scopedRepos(relay.machines, form), form);
    if (!previewAsked(form) || !deriveAutoAvailability(relay).available || repo === null) {
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
      const reply = await this.#client.routePreview(taskRequest(this.#state.form, repo.origin, false));
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
      result = { kind: "failed", repo: repo.origin, message: readFailureText(err, "the preview failed") };
    }
    if (this.#state.preview !== asked) return;
    this.#patch({ preview: result });
  }

  stopPreviewRetry(): void {
    if (this.#previewRetry !== null) clearTimeout(this.#previewRetry);
    this.#previewRetry = null;
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
    if (!this.#queueOnScreen() || (view !== null && view.kind !== "failed")) return;
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
      } else if (named === null) {
        next = {
          kind: "ok",
          tasks: reply.tasks,
          holds: reply.holds ?? [],
          unreadable: reply.unreadable ?? [],
          at: reply.at,
          skew: reply.at - Date.now(),
        };
      } else {
        // An older leader ignores the filter and answers its newest: only the named ids are taken.
        const fresh = reply.tasks.filter((t) => named.includes(t.id));
        const listed = this.#state.queueView;
        const absent = named.filter(
          (id) => !fresh.some((f) => f.id === id) && listed?.kind === "ok" && listed.tasks.some((t) => t.id === id),
        );
        const gone = await this.#goneFromStore(absent);
        const shown = this.#state.queueView;
        const base = shown?.kind === "ok" ? shown.tasks : [];
        const merged = base.flatMap((t) => {
          const now = fresh.find((f) => f.id === t.id);
          if (now !== undefined) return [now];
          return gone.has(t.id) ? [] : [t];
        });
        const added = fresh.filter((f) => !base.some((t) => t.id === f.id));
        // Unreadable records come whole whatever was named, as holds do.
        next = {
          kind: "ok",
          tasks: [...added, ...merged],
          holds: reply.holds ?? [],
          unreadable: reply.unreadable ?? [],
          at: reply.at,
          skew: reply.at - Date.now(),
        };
      }
    } catch (err) {
      next = { notice: readFailureText(err, "the queue could not be read") };
    }
    if (next !== null && !("notice" in next)) {
      const before = this.#state.queueView;
      this.#patch({ queueView: next, ...(nudged && !this.#noticeFromRead ? {} : { queueNotice: null }) });
      // Another device's pause or resume, or a reset lifting a hold. A first read has nothing to
      // compare: the preview was asked under whatever holds stood.
      if (previewAsked(this.#state.form) && before?.kind === "ok" && holdsKey(before.holds) !== holdsKey(next.holds)) {
        this.#askPreviewSoon();
      }
      return;
    }
    const view = this.#state.queueView;
    // A read nobody is looking at has no one to tell, and leaves the view as it was.
    if (next === null || !this.#queueOnScreen()) {
      if (view?.kind === "loading") this.#patch({ queueView: this.#queuePrior });
      return;
    }
    // Keeps a list that was read: the status line says whether anyone is leading.
    if (view?.kind === "ok") {
      this.#patch({ queueNotice: next.notice });
      this.#noticeFromRead = true;
    } else this.#patch({ queueView: { kind: "failed", message: next.notice } });
  }

  /**
   * Whether the relay's store still holds a task the leader answered without.
   * A `queue` reply can leave out a task it was asked for — its byte budget
   * drops records, and a leader lists a create only once it has read it — so
   * an answer without it says nothing either way; the store does. Null when
   * the store could not say.
   */
  async #inStore(taskId: string): Promise<boolean | null> {
    try {
      const reply = await this.#client.getTask(taskId);
      return reply === null || !reply.ok ? null : reply.task !== null;
    } catch {
      return null;
    }
  }

  /** The ids among `taskIds` the store holds no record of; one it could not answer for is kept. */
  async #goneFromStore(taskIds: readonly string[]): Promise<ReadonlySet<string>> {
    const held = await Promise.all(taskIds.map((id) => this.#inStore(id)));
    return new Set(taskIds.filter((_, i) => held[i] === false));
  }

  cancelTask(taskId: string): Promise<void> {
    return this.#actOnTask({ taskId, op: "cancel" });
  }

  markDone(taskId: string): Promise<void> {
    return this.#actOnTask({ taskId, op: "mark-done" });
  }

  /** Places a task the concurrency caps alone hold, past them; the reply is the task as reserved. */
  runNow(taskId: string): Promise<void> {
    return this.#actOnTask({ taskId, op: "run-now" });
  }

  /**
   * Writes a new task that picks up a failed or cancelled one's session where it stopped, through the same
   * `createTask` an enqueue uses: the leader dispatches it to the machine the old one ran on.
   */
  continueTask(taskId: string): Promise<void> {
    return this.#actOnTask({ taskId, op: "continue" });
  }

  async #continue(taskId: string): Promise<string | null> {
    const view = this.#state.queueView;
    const failed = view?.kind === "ok" ? view.tasks.find((t) => t.id === taskId) : undefined;
    if (failed === undefined) return "That task is no longer listed.";
    // The button was gated on this when drawn; the leader may have changed or gone since the tap.
    if (!deriveContinueAvailability(this.#state.relay)) return CONTINUE_UNAVAILABLE;
    const offer = continueOffer(failed, this.#state.relay.machines, view?.kind === "ok" ? view.tasks : []);
    if (!offer.ok) return sentence(offer.reason);
    const task = queuedTask({ ...continuationSpec(failed, offer.at), client: "pwa" }, Date.now());
    const reply = await this.#client.createTask(task);
    if (reply === null) return `${STORE_UNREADABLE} ${MAY_HAVE_LANDED}`;
    if (!reply.ok) return sentence(storeErrorText(reply.code));
    this.#mergeTask(task);
    return null;
  }

  async #actOnTask(action: TaskAction): Promise<void> {
    if (this.#state.taskAction !== null) return;
    this.#patch({ taskAction: action, queueNotice: null });
    let notice: string | null = null;
    try {
      if (action.op === "continue") {
        notice = await this.#continue(action.taskId);
        this.#patch({ taskAction: null, queueNotice: notice });
        return;
      }
      const send = { cancel: "cancel", "mark-done": "markDone", "run-now": "runNow" } as const;
      const reply = await this.#client[send[action.op]](action.taskId);
      if (reply === null) notice = `${SCHEDULER_UNREADABLE} ${MAY_HAVE_LANDED}`;
      else if ("ok" in reply) {
        const text = sentence(schedulerErrorText(reply.code));
        notice = isTransportError(reply.code) ? `${text} ${MAY_HAVE_LANDED}` : text;
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
    const text = sentence(failureReasonText(failure));
    // The shared line for these two already says the request may have landed.
    return failure.reason === "timeout" || failure.reason === "dropped" ? `${text} ${REFRESH_HINT}` : text;
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
      if (reply === null) notice = `${SCHEDULER_UNREADABLE} ${MAY_HAVE_LANDED}`;
      else if ("ok" in reply) notice = sentence(schedulerErrorText(reply.code));
      else {
        const view = this.#state.queueView;
        if (view?.kind === "ok") this.#patch({ queueView: { ...view, holds: reply.holds } });
        else void this.refreshQueue();
        if (previewAsked(this.#state.form)) void this.refreshPreview();
      }
    } catch (err) {
      notice = this.#actionFailure(err);
    }
    this.#patch({ pausing: false, queueNotice: notice });
  }

  /**
   * Discards every record the last read listed as unreadable, one at a time,
   * then reads the whole queue again, so what is still listed is what is left.
   * A record already gone is what was asked for; any other refusal, or a lost
   * answer, stops it and becomes the notice.
   */
  async discardUnreadable(): Promise<void> {
    const view = this.#state.queueView;
    if (this.#state.discarding || view?.kind !== "ok" || view.unreadable.length === 0) return;
    this.#patch({ discarding: true, queueNotice: null });
    let notice: string | null = null;
    for (const { taskId, version } of view.unreadable) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one at a time: the leader serializes store writes anyway
        const reply = await this.#client.discard({ taskId, version });
        if (reply === null) notice = `${SCHEDULER_UNREADABLE} ${MAY_HAVE_LANDED}`;
        else if ("ok" in reply && reply.code !== "task_not_found") {
          const text = sentence(schedulerErrorText(reply.code));
          notice = isTransportError(reply.code) ? `${text} ${MAY_HAVE_LANDED}` : text;
        }
      } catch (err) {
        notice = this.#actionFailure(err);
      }
      if (notice !== null) break;
    }
    this.#patch({ discarding: false });
    await this.refreshQueue();
    // After the read, which clears the notice when it lands.
    if (notice !== null) this.#patch({ queueNotice: notice });
  }

  /** How many unreadable records the last queue read listed; zero when there is no read to go by. */
  unreadableCount(): number {
    const view = this.#state.queueView;
    return view?.kind === "ok" ? view.unreadable.length : 0;
  }

  /** Re-reads the queued task while its verdict is up and it has not reached a machine yet. */
  #follow(taskId: string, left: number): void {
    this.stopFollowing();
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
    let read: FollowRead;
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
        // An older leader ignores the filter, so the reply is searched. One that lacks the task was answered
        // all the same; only the store says whether the task is gone, and the Queue screen asks it the same way.
        const task = reply.tasks.find((t) => t.id === taskId);
        if (task !== undefined) read = { task };
        else {
          const stored = await this.#inStore(taskId);
          read = stored === false ? { kind: "gone" } : stored === true ? "unlisted" : "missed";
        }
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
      // A nudge's refused read leaves the poll chain to ask again; a task gone from the store is final.
      if (left === null && read.kind !== "gone") return;
      this.stopFollowing();
      this.#patch({ verdict: { kind: "queued", task, follow: read } });
      return;
    }
    if (isSettled(task.state)) {
      this.stopFollowing();
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

  stopFollowing(): void {
    if (this.#followTimer !== null) clearTimeout(this.#followTimer);
    this.#followTimer = null;
  }
}
