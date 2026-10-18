import {
  FINISHED,
  StoreRevoked,
  type CancelResult,
  type MarkDoneResult,
  type PauseResult,
  type Scheduler,
  winnerOnly,
} from "@seance/scheduler";
import {
  APP_ID,
  MAX_PAUSE_HOLDS,
  parsePauseRequest,
  parseQueueRequest,
  parseResumeRequest,
  parseTaskRef,
  parseTaskRequest,
  QUEUE_MAX_TASKS,
  QUEUE_PROMPT_PREVIEW,
  quote,
  TASK_FAILURE_LIMITS,
  type Decision,
  type PauseHold,
  type PauseResponse,
  type Plain,
  type QueueResponse,
  type RoutePreviewResponse,
  type SchedulerError,
  type SchedulerErrorCode,
  type SchedulerOp,
  type Task,
  type TaskResponse,
} from "@seance/shared";
import { daemonSink, queueAudit } from "./audit.ts";
import { log } from "./log.ts";

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
  return boundedQueue(tasks, (id) => scheduler.lastDecision(id), now, scheduler.holds());
}

/**
 * UTF-8 bytes of task JSON one `queue` reply may carry. Sealing is base64 of
 * the whole `Plain`, 4/3 of it, against `ENVELOPE_MAX_CT_LENGTH`'s 65 536:
 * 44 000 seals to about 58 900, leaving room for the wrapper and a prompt
 * preview's multi-byte characters.
 */
const QUEUE_REPLY_BUDGET = 44_000;

/** Where the decision is still live: why a task waits, or where it is going. */
const LIVE_DECISION: ReadonlySet<Task["state"]> = new Set(["ready", "reserved"]);

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** A task as `queue` shows it before its decision is chosen: the prompt cut to a preview. */
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
 * drops one). Full decisions are filled against
 * `QUEUE_REPLY_BUDGET`, live ones first and then newest first; the rest go out
 * `winnerOnly`. Where even those overrun it — every bounded field near its cap —
 * the oldest tasks are left out, finished ones before live ones. Exported for
 * its test: a daemon test cannot build a `Scheduler`.
 */
export function boundedQueue(
  all: readonly Task[],
  decisionOf: (id: string) => Decision | undefined,
  now: number,
  holds: readonly PauseHold[] = [],
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
  let left = QUEUE_REPLY_BUDGET - jsonBytes(holds) - newest.reduce((sum, task) => sum + (sizes.get(task.id) ?? 0), 0);
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
  const { term, now, tick } = ctx;
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
        ? await answer({ scheduler: ctx.scheduler(), id: plain.id, now: now(), tick }, op, plain.payload)
        : schedulerError("not_ready", `term ${term} is still taking over`);
    } catch (err) {
      if (err instanceof StoreRevoked) {
        // The write was refused or never sent, so the app may ask the next leader.
        ctx.fail(err);
        payload = schedulerError("not_leader", "this daemon's term has ended");
      } else {
        log.error(`scheduler: ${quote(op)} crashed: ${String(err)}`);
        // Cut so a crash reply never outgrows the frame and gets swapped for `too_large` by `#sealReply`: that code means the reply was too big after the work was done, and a crash is not that.
        payload = schedulerError("internal_error", String(err).slice(0, TASK_FAILURE_LIMITS.message));
      }
    }
    await ctx.reply(from, { id: crypto.randomUUID(), ts: Date.now(), op, re: plain.id, payload });
  };
}
