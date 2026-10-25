import {
  FINISHED,
  StoreRevoked,
  type CancelResult,
  type DiscardResult,
  type MarkDoneResult,
  type PauseResult,
  type Scheduler,
  winnerOnly,
} from "@seance/scheduler";
import {
  APP_ID,
  MAX_PAUSE_HOLDS,
  parseDiscardRequest,
  parsePauseRequest,
  parsePushSubscribeRequest,
  parsePushUnsubscribeRequest,
  parseQueueRequest,
  parseResumeRequest,
  parseTaskRef,
  parseTaskRequest,
  PUSH_MAX_SUBSCRIPTIONS,
  QUEUE_MAX_TASKS,
  QUEUE_PROMPT_PREVIEW,
  quote,
  REPLY_JSON_BUDGET,
  TASK_FAILURE_LIMITS,
  type Decision,
  type DiscardResponse,
  type PauseHold,
  type PauseResponse,
  type Plain,
  type PushSubscribeResponse,
  type PushUnsubscribeResponse,
  type QueueResponse,
  type RoutePreviewResponse,
  type SchedulerError,
  type SchedulerErrorCode,
  type SchedulerOp,
  type Task,
  type TaskResponse,
  type UnreadableTaskRef,
} from "@seance/shared";
import { daemonSink, queueAudit } from "./audit.ts";
import { log } from "./log.ts";
import type { SettingsState, SettingsUpdate, TermSettings } from "./settings.ts";

/**
 * An app's requests to the scheduler term (DESIGN.md, Scheduler, "The leader"):
 * who may ask, what each op answers, and how the answer leaves. `leader.ts`
 * runs the term and hands each request here through `requestHandler`.
 */

const audit = queueAudit(daemonSink);

function schedulerError(code: SchedulerErrorCode, message: string): SchedulerError {
  return { ok: false, code, message };
}

/** `only` narrows to those ids (an unknown one simply is not in the reply); absent, the whole queue. */
function queueView(scheduler: Scheduler, now: number, only?: readonly string[]): QueueResponse {
  const wanted = only === undefined ? null : new Set(only);
  const tasks = wanted === null ? scheduler.tasks() : scheduler.tasks().filter((t) => wanted.has(t.id));
  const unreadable = scheduler
    .unreadable()
    .map(({ id, version, reason }): UnreadableTaskRef => ({ taskId: id, version, reason }));
  return boundedQueue(tasks, (id) => scheduler.lastDecision(id), now, scheduler.holds(), unreadable);
}

/** Where the decision is still live: why a task waits, or where it is going. */
const LIVE_DECISION: ReadonlySet<Task["state"]> = new Set(["ready", "reserved"]);

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** A task as `queue` shows it before its decision is chosen: the prompt cut to a preview (a finished task has none). */
function undecided(task: Task): Task {
  const { decision: _, spec, ...rest } = task;
  const { prompt } = spec;
  return { ...rest, spec: prompt === undefined ? spec : { ...spec, prompt: prompt.slice(0, QUEUE_PROMPT_PREVIEW) } };
}

function rank(t: Task): number {
  return FINISHED.includes(t.state) ? 2 : t.escalated === true ? 0 : 1;
}

/**
 * What the reply keeps when the store holds more than `QUEUE_MAX_TASKS`: what
 * still needs someone first — an escalated `needs-input` task, then the rest of
 * the unfinished, newest first — and finished tasks after, newest first. The
 * store holds far more than the reply, and a task waiting on a person must not
 * fall off behind twenty newer finished ones.
 */
function byRelevance(a: Task, b: Task): number {
  return rank(a) - rank(b) || b.createdAt - a.createdAt;
}

/**
 * Most relevant first (`byRelevance`) and bounded, prompts cut, with every hold in force (at most
 * `MAX_PAUSE_HOLDS`, taken off the budget first: a reader refuses a reply that
 * drops one) and every unreadable record (at most `MAX_TASKS`, the store's own
 * bound, also taken off first: each is one a person may discard). Full decisions are filled against
 * `REPLY_JSON_BUDGET`, live ones first and then newest first; the rest go out
 * `winnerOnly`. Where even those overrun it — every bounded field near its cap —
 * the oldest tasks are left out, finished ones before live ones. Exported for
 * its test: a daemon test cannot build a `Scheduler`.
 */
export function boundedQueue(
  all: readonly Task[],
  decisionOf: (id: string) => Decision | undefined,
  now: number,
  holds: readonly PauseHold[] = [],
  unreadable: readonly UnreadableTaskRef[] = [],
): QueueResponse {
  const newest = all.toSorted(byRelevance).slice(0, QUEUE_MAX_TASKS).map(undecided);
  const decisions = new Map<string, { readonly whole: Decision; readonly cut: Decision }>();
  const sizes = new Map<string, number>();
  for (const task of newest) {
    const whole = decisionOf(task.id);
    const cut = whole === undefined ? undefined : winnerOnly(whole);
    if (whole !== undefined && cut !== undefined) decisions.set(task.id, { whole, cut });
    sizes.set(task.id, jsonBytes(withDecision(task, cut)));
  }
  // Every trimmed record is counted up front, so a full one only ever replaces its own.
  let left =
    REPLY_JSON_BUDGET -
    jsonBytes(holds) -
    (unreadable.length === 0 ? 0 : jsonBytes(unreadable)) -
    newest.reduce((sum, task) => sum + (sizes.get(task.id) ?? 0), 0);
  const byClaim = [
    ...newest.filter((t) => LIVE_DECISION.has(t.state)),
    ...newest.filter((t) => !LIVE_DECISION.has(t.state)),
  ];
  // From the back of the claim order, so what a verdict or MCP's placement poll follows goes last.
  const kept = new Set(newest.map((t) => t.id));
  for (const task of byClaim.toReversed()) {
    if (left >= 0) break;
    kept.delete(task.id);
    left += sizes.get(task.id) ?? 0;
  }
  const full = new Set<string>();
  for (const task of byClaim) {
    if (!kept.has(task.id)) continue;
    const decision = decisions.get(task.id);
    if (decision === undefined || decision.cut === decision.whole) continue;
    const extra = jsonBytes(decision.whole) - jsonBytes(decision.cut);
    if (extra > left) continue;
    left -= extra;
    full.add(task.id);
  }
  return {
    tasks: newest
      .filter((task) => kept.has(task.id))
      .map((task) => {
        const decision = decisions.get(task.id);
        return withDecision(task, full.has(task.id) ? decision?.whole : decision?.cut);
      }),
    at: now,
    holds,
    ...(unreadable.length === 0 ? {} : { unreadable }),
  };
}

function withDecision(task: Task, decision: Decision | undefined): Task {
  return decision === undefined ? task : { ...task, decision };
}

/** What answering one app request reads: the term's scheduler and the request it answers. */
interface Asked {
  readonly scheduler: Scheduler;
  /** The request's own id, which the audit line carries so the app's side can find it. */
  readonly id: string;
  readonly now: number;
  readonly tick: () => void;
  readonly settings: () => TermSettings | null;
  readonly settingsState: () => SettingsState;
}

const PAUSE_REFUSALS: Record<Exclude<PauseResult, { readonly ok: true }>["code"], SchedulerError> = {
  reset_unknown: schedulerError("reset_unknown", "no quota reading says when that account resets"),
  conflict: schedulerError("conflict", "the pause record changed while this ran; ask again"),
  full: schedulerError("invalid_request", `the queue holds at most ${MAX_PAUSE_HOLDS - 1} account holds`),
};

/** A `pause` or `resume` answered and audited: the holds after it, or why not. */
async function held(
  op: "pause" | "resume",
  id: string,
  account: string | undefined,
  result: PauseResult,
): Promise<PauseResponse | SchedulerError> {
  if (!result.ok) {
    await audit.refused(op, id, result.code, { account });
    return PAUSE_REFUSALS[result.code];
  }
  await audit.held(op, id, account);
  return { holds: result.holds };
}

const MARK_DONE_REFUSALS: Record<Exclude<MarkDoneResult, { readonly ok: true }>["code"], SchedulerError> = {
  not_found: schedulerError("task_not_found", "the leader holds no task by that id"),
  dispatching: schedulerError("dispatching", "its spawn is in flight; ask again once it lands"),
  finished: schedulerError("finished", "the task has already finished"),
  despawn_failed: schedulerError("despawn_failed", "its machine did not end the session; the task is unchanged"),
  conflict: schedulerError("conflict", "the task changed while it was marked done; ask again"),
  // A transport code, so MCP adds its "may have landed anyway": the despawn did run. Asking again is safe.
  unrecorded: schedulerError(
    "internal_error",
    "its session may already have ended, but marking it done was not recorded before this daemon's term ended; check the queue, then mark it done again if it still shows",
  ),
};

const DISCARD_REFUSALS: Record<Exclude<DiscardResult, { readonly ok: true }>["code"], SchedulerError> = {
  not_found: schedulerError("task_not_found", "the leader holds no unreadable record by that id"),
  conflict: schedulerError("conflict", "the record is at another version now; read the queue again"),
};

const CANCEL_REFUSALS: Record<Exclude<CancelResult, { readonly ok: true }>["code"], SchedulerError> = {
  not_found: schedulerError("task_not_found", "the leader holds no task by that id"),
  dispatching: schedulerError("dispatching", "its spawn is in flight; ask again once it lands"),
  finished: schedulerError("finished", "the task has already finished"),
  despawn_failed: schedulerError("despawn_failed", "its machine did not end the session; the task is unchanged"),
  conflict: schedulerError("conflict", "the task changed while the cancel ran; ask again"),
  // A transport code, so MCP adds its "may have landed anyway": the despawn did run. Asking again is safe.
  unrecorded: schedulerError(
    "internal_error",
    "its session may already have ended, but the cancel was not recorded before this daemon's term ended; check the queue, then cancel again if it still shows",
  ),
};

type PushOp = "push-subscribe" | "push-unsubscribe";

const SETTINGS_UNAVAILABLE = (): SchedulerError =>
  schedulerError("settings_unavailable", "this term cannot use its settings record, so push is off");

/** The term's settings holder for a push op, or why not: `not_ready` until the first load decides, then `settings_unavailable` (audited). */
async function pushSettings(asked: Asked, op: PushOp): Promise<TermSettings | SchedulerError> {
  const settings = asked.settings();
  const state = asked.settingsState();
  if (state === "pending") return schedulerError("not_ready", "this term has not read its settings yet");
  if (settings !== null && state !== "unavailable") return settings;
  await audit.refused(op, asked.id, "settings_unavailable");
  return SETTINGS_UNAVAILABLE();
}

/**
 * A settings write the holder refused, answered and audited. The audit's code is the reply's, so a
 * line and the answer it records never disagree. The store's own code stays out of both: a settings
 * fault never carries a record's content into a reply.
 */
async function settingsRefused(
  op: PushOp,
  requestId: string,
  code: Extract<SettingsUpdate, { readonly ok: false }>["code"],
  failed: string,
): Promise<SchedulerError> {
  const reply =
    code === "conflict"
      ? schedulerError("conflict", "the settings record changed while this ran; ask again")
      : code === "unavailable"
        ? SETTINGS_UNAVAILABLE()
        : schedulerError("internal_error", failed);
  await audit.refused(op, requestId, reply.code);
  return reply;
}

/**
 * An app's request to a running term (DESIGN.md, Scheduler, "The leader").
 * The payload is untrusted input to a PSK holder that acts on it, so it is
 * parsed into a fresh value before anything reads it.
 */
async function answer(asked: Asked, op: SchedulerOp, payload: unknown): Promise<unknown> {
  const { scheduler, id, tick } = asked;
  switch (op) {
    case "queue": {
      // An unreadable filter is a malformed request, never "everything".
      const request = parseQueueRequest(payload);
      if (request === null) return schedulerError("invalid_request", "malformed queue request");
      return queueView(scheduler, asked.now, request.tasks);
    }
    case "route-preview": {
      const request = parseTaskRequest(payload);
      if (request === null) return schedulerError("invalid_request", "malformed route-preview request");
      const reply: RoutePreviewResponse = { decision: scheduler.preview(request) };
      return reply;
    }
    case "cancel": {
      const ref = parseTaskRef(payload);
      if (ref === null) return schedulerError("invalid_request", "malformed cancel request");
      const result = await scheduler.cancel(ref.taskId);
      if (!result.ok) {
        await audit.refused("cancel", id, result.code, { taskId: ref.taskId });
        return CANCEL_REFUSALS[result.code];
      }
      await audit.cancelled(id, result.task);
      // A cancelled task frees its slot for whatever waits.
      tick();
      const reply: TaskResponse = { task: result.task };
      return reply;
    }
    case "pause": {
      const request = parsePauseRequest(payload);
      if (request === null) return schedulerError("invalid_request", "malformed pause request");
      return held(op, id, request.account, await scheduler.pause(request));
    }
    case "resume": {
      const request = parseResumeRequest(payload);
      if (request === null) return schedulerError("invalid_request", "malformed resume request");
      const reply = await held(op, id, request.account, await scheduler.resume(request));
      // What the hold kept waiting is placed now rather than on the next 30s tick.
      tick();
      return reply;
    }
    case "mark-done": {
      const ref = parseTaskRef(payload);
      if (ref === null) return schedulerError("invalid_request", "malformed mark-done request");
      const result = await scheduler.markDone(ref.taskId);
      if (!result.ok) {
        await audit.refused("mark-done", id, result.code, { taskId: ref.taskId });
        return MARK_DONE_REFUSALS[result.code];
      }
      await audit.markedDone(id, result.task);
      // What waited on it (an `after: merged` dependent) is released now rather than on the next 30s tick.
      tick();
      const reply: TaskResponse = { task: result.task };
      return reply;
    }
    case "push-subscribe": {
      const request = parsePushSubscribeRequest(payload);
      if (request === null) return schedulerError("invalid_request", "malformed push-subscribe request");
      const settings = await pushSettings(asked, op);
      if ("ok" in settings) return settings;
      // An object, not a flag: TS would narrow a `let` to its initial value across the callback.
      const outcome = { full: false };
      const result = await settings.update((record) => {
        const current = record.subscriptions ?? [];
        const same = current.find((sub) => sub.endpoint === request.endpoint);
        // Already held as it is: no write, and no version bump for a browser that asks at every boot.
        if (same?.keys.p256dh === request.keys.p256dh && same.keys.auth === request.keys.auth) return null;
        // A browser can re-key one endpoint: the new keys replace the old.
        const others = current.filter((sub) => sub.endpoint !== request.endpoint);
        if (others.length >= PUSH_MAX_SUBSCRIPTIONS) {
          outcome.full = true;
          return null;
        }
        const { version: _version, ...rest } = record;
        return { ...rest, subscriptions: [...others, request] };
      });
      if (result.ok && outcome.full) {
        await audit.refused("push-subscribe", id, "subscriptions_full");
        return schedulerError(
          "subscriptions_full",
          `the leader holds ${PUSH_MAX_SUBSCRIPTIONS} push subscriptions already`,
        );
      }
      if (!result.ok) return settingsRefused(op, id, result.code, "the subscription could not be stored");
      await audit.subscribed(id);
      const reply: PushSubscribeResponse = { endpoint: request.endpoint };
      return reply;
    }
    case "push-unsubscribe": {
      const request = parsePushUnsubscribeRequest(payload);
      if (request === null) return schedulerError("invalid_request", "malformed push-unsubscribe request");
      const settings = await pushSettings(asked, op);
      if ("ok" in settings) return settings;
      const result = await settings.update((record) => {
        const current = record.subscriptions ?? [];
        const kept = current.filter((sub) => sub.endpoint !== request.endpoint);
        // Not held: no write and no version bump, so asking twice (or for a pruned one) is harmless.
        if (kept.length === current.length) return null;
        const { version: _version, ...rest } = record;
        return { ...rest, subscriptions: kept };
      });
      if (!result.ok) return settingsRefused(op, id, result.code, "the subscription could not be removed");
      await audit.unsubscribed(id);
      const reply: PushUnsubscribeResponse = { endpoint: request.endpoint };
      return reply;
    }
    case "discard": {
      const request = parseDiscardRequest(payload);
      if (request === null) return schedulerError("invalid_request", "malformed discard request");
      const result = await scheduler.discard(request.taskId, request.version);
      if (!result.ok) {
        await audit.refused("discard", id, result.code, { taskId: request.taskId });
        return DISCARD_REFUSALS[result.code];
      }
      await audit.discarded(id, request.taskId, request.version);
      // No tick: an unreadable record held nothing back but a slot in the store, and an app's create takes that.
      const reply: DiscardResponse = { taskId: request.taskId };
      return reply;
    }
  }
}

/**
 * What the term hands its request handler. Read through getters: the handler
 * is built before the term's `Scheduler` and tick exist, since the leg that
 * delivers requests is, and reads them only once the term is running.
 */
export interface TermRequests {
  readonly term: number;
  readonly scheduler: () => Scheduler;
  /** True once takeover has ended and until the term does. */
  readonly running: () => boolean;
  readonly now: () => number;
  readonly tick: () => void;
  /** The term's settings holder; null when it has none (a test's term over a bare store). */
  readonly settings: () => TermSettings | null;
  /** `pending` until the term's first settings load decides: a push op meanwhile is `not_ready`. */
  readonly settingsState: () => SettingsState;
  /**
   * The term's own fault path: a `StoreRevoked` ends the term (`leader.ts`). It is the
   * relay's `not_leader` on a store write, or a store write that could not be sent at
   * all: no socket, a failed send, or the fenced store after the term ended
   * (`leader-adapters.ts`).
   */
  readonly fail: (err: unknown) => void;
  /** `LeaderOpts.reply`: the answer leaves on the daemon socket, not the term's leg. */
  readonly reply: (to: string, response: Plain) => Promise<boolean>;
}

/** One term's handler for an app's scheduler request, as the leg hands it over. */
export function requestHandler(ctx: TermRequests): (plain: Plain, op: SchedulerOp, from: string) => Promise<void> {
  const { term, now, tick, settings, settingsState } = ctx;
  // Only an app asks the scheduler anything; a daemon's envelope is an event.
  // Answered `not_ready` until takeover ends: before it the queue is the
  // store's unreconciled view, and a write would race the load.
  return async (plain: Plain, op: SchedulerOp, from: string): Promise<void> => {
    if (from !== APP_ID) {
      log.warn(`scheduler: dropped op=${quote(op)} from=${quote(from)} — requests come from apps only`);
      return;
    }
    log.info(`scheduler: request op=${quote(op)} id=${quote(plain.id)} term=${term}`);
    let payload: unknown;
    try {
      payload = ctx.running()
        ? await answer(
            { scheduler: ctx.scheduler(), id: plain.id, now: now(), tick, settings, settingsState },
            op,
            plain.payload,
          )
        : schedulerError("not_ready", `term ${term} is still taking over`);
    } catch (err) {
      if (err instanceof StoreRevoked) {
        // The write was refused or never sent, so the app may ask the next leader.
        ctx.fail(err);
        payload = schedulerError("not_leader", "this daemon's term has ended");
      } else {
        log.error(`scheduler: ${quote(op)} crashed: ${String(err)}`);
        // Cut so a crash reply never outgrows the frame and gets swapped for `too_large` by `#sealReply`: that code on a cancel or mark-done must mean it ran (the task's own reply was too big), and a crash is not.
        payload = schedulerError("internal_error", String(err).slice(0, TASK_FAILURE_LIMITS.message));
      }
    }
    await ctx.reply(from, { id: crypto.randomUUID(), ts: Date.now(), op, re: plain.id, payload });
  };
}
