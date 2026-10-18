import {
  SCHEDULER_ERROR_CODES,
  STORE_TOMBSTONE_MS,
  TASK_FAILURE_CODES,
  TRANSPORT_ERROR_CODES,
  type Reason,
  type SchedulerErrorCode,
  type TaskFailureCode,
  type TransportErrorCode,
} from "./types.ts";

/**
 * What a scheduler answer means to whoever asked, worded once for every app-role
 * surface — the PWA, `seanced mcp`, any later client — so they cannot drift
 * apart. Each line is a lowercase clause; a surface that shows it alone makes
 * it a sentence (`sentence`), and adds its own next step around it.
 */

/** Every code worded, so a new one fails the build here rather than reading blank somewhere. */
const SCHEDULER_ERROR_TEXT: Record<SchedulerErrorCode, string> = {
  not_leader: "the scheduler moved to another machine while this was on its way; try again",
  not_ready: "the scheduler is still taking over after a leader change; try again in a few seconds",
  invalid_request:
    "the scheduler refused the request as malformed — this end and the leader probably run different seanced versions",
  queue_full:
    "the scheduler already holds as many unfinished tasks as it will take; wait for some to start, or pick a machine",
  task_not_found: "the scheduler holds no such task",
  dispatching: "the task is starting on a machine right now; try again in a moment",
  finished: "the task has already finished",
  despawn_failed: "its machine refused to end the session; nothing changed",
  conflict: "the task changed while this was on its way; try again",
  reset_unknown: "no quota reading says when that account resets, so it can't be paused until then",
  internal_error: "the scheduler hit an error",
  too_large: "the scheduler's answer was too large to send back",
};

/** A refusal's line; a code this build does not know is named rather than guessed at. */
export function schedulerErrorText(code: string): string {
  const known = SCHEDULER_ERROR_CODES.find((c) => c === code);
  return known === undefined
    ? `the scheduler refused it with a code this build does not know (${code})`
    : SCHEDULER_ERROR_TEXT[known];
}

/**
 * A transport error judges the reply, not the request: a crashed handler may have
 * got as far as acting, and `too_large` is a reply that would not fit after the
 * work was done. So the request may have landed.
 */
export function isTransportError(code: string): code is TransportErrorCode {
  return TRANSPORT_ERROR_CODES.some((c) => c === code);
}

/** One clause per routing reason, all of them: a record carries every reason that applied. */
export function reasonText(reason: Reason): string {
  switch (reason.code) {
    case "offline":
      return "offline";
    case "status_stale":
      return "no fresh status, so its load is unknown";
    case "task_id_unsupported":
      return "its daemon predates task ids";
    case "exclaves_unknown":
      return "its daemon reports no exclaves";
    case "disk_low":
      return `disk nearly full (${reason.freeMib} MiB free)`;
    case "pressure_unknown":
      return "it reports no CPU or memory load";
    case "pin_mismatch":
      return reason.field === "deviceId" ? "not the pinned machine" : "not the pinned exclave";
    case "repo_absent":
      return "no clone of this repo there";
    case "auth_missing":
      return "not signed in";
    case "quota_unknown":
      return reason.why === "trimmed"
        ? "its account's quota was trimmed from the latest status"
        : "its account's quota has never been observed";
    case "quota_over_line":
      return `${reason.window} quota would reach ${Math.round(reason.projectedPct)}%`;
    case "cap_reached":
      if (reason.scope === "account")
        return `${reason.inFlight} of ${reason.max} auto tasks already in flight on its account`;
      if (reason.scope === "batch") return `${reason.inFlight} of ${reason.max} of its batch already in flight`;
      return `${reason.inFlight} of ${reason.max} auto tasks already in flight`;
    case "batch_order":
      return `its batch runs in order, and it waits for batch member #${reason.index}, earlier in its order`;
    case "paused": {
      const why = reason.until === "reset" ? "until its quota resets" : "until resumed";
      return reason.scope === "account" ? `its account is paused ${why}` : `the queue is paused ${why}`;
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every scheduler-set failure worded, as for error codes. */
const TASK_FAILURE_TEXT: Record<TaskFailureCode, string> = {
  dispatch_unconfirmed:
    "its machine could not say whether the session started, so the scheduler will not start it again",
  dependency_failed: "a task it depends on failed or was cancelled",
  dependency_missing: "a task it depends on is not in the queue",
  dependency_cycle: "its dependencies wait on each other in a loop",
  lost_expired:
    "its machine stayed away too long, so the scheduler stopped waiting for it — its session may still be running there",
  merge_expired: "no merge of its pull request was seen in time, so the scheduler stopped waiting for one",
  queue_expired: `it sat in the queue over ${Math.round(STORE_TOMBSTONE_MS / DAY_MS)} days, too long to start safely`,
};

/** A scheduler-set failure's line; null for any other code — a daemon's spawn refusal, or one minted later. */
export function taskFailureText(code: string): string | null {
  const known = TASK_FAILURE_CODES.find((c) => c === code);
  return known === undefined ? null : TASK_FAILURE_TEXT[known];
}

/** A clause shown on its own: capitalized and closed. */
export function sentence(clause: string): string {
  const text = `${clause.charAt(0).toUpperCase()}${clause.slice(1)}`;
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}
