import {
  SCHEDULER_ERROR_CODES,
  EXIT_STATUS_MAX,
  STORE_ERROR_CODES,
  STORE_TOMBSTONE_MS,
  TASK_FAILURE_CODES,
  TRANSPORT_ERROR_CODES,
  type Reason,
  type SchedulerErrorCode,
  type StoreErrorCode,
  type TaskFailureCode,
  type TaskUntil,
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
  task_not_found: "the scheduler holds no such task",
  dispatching: "the task is starting on a machine right now; try again in a moment",
  finished: "the task has already finished",
  not_waiting: "the task is not waiting for a slot — it is still waiting on its dependencies, or already placed",
  unplaceable: "something besides the concurrency caps keeps it from every machine — see why it waits",
  despawn_failed: "its session could not be ended — its machine refused or is offline; nothing changed",
  conflict: "the task changed while this was on its way; try again",
  reset_unknown: "no quota reading says when that account resets, so it can't be paused until then",
  internal_error: "the scheduler hit an error",
  too_large: "the scheduler's answer was too large to send back",
  subscriptions_full: "the scheduler already holds as many push subscriptions as it keeps; remove one first",
};

/** A refusal's line; a code this build does not know is named rather than guessed at. */
export function schedulerErrorText(code: string): string {
  const known = SCHEDULER_ERROR_CODES.find((c) => c === code);
  return known === undefined
    ? `the scheduler refused it with a code this build does not know (${code})`
    : SCHEDULER_ERROR_TEXT[known];
}

const STORE_ERROR_TEXT: Record<StoreErrorCode, string> = {
  version_conflict: "an earlier attempt already stored it",
  not_leader: "the relay refused the write — this end and the relay probably run different versions",
  forbidden: "the relay refused the write — this end and the relay probably run different versions",
  invalid_request:
    "the task did not pass the checks every reader applies (a field past its bound, a batch index past the limit, or this end and the leader on different versions)",
  too_large: "the task is too large to store — shorten the prompt",
  rate_limited: "too many tasks queued from this connection in the last minute; wait a minute",
  store_full: "the queue is full; the scheduler prunes finished tasks as it runs — try again later",
};

/** A relay store refusal of an enqueue, worded once for the PWA and `seanced mcp`. */
export function storeErrorText(code: string): string {
  const known = STORE_ERROR_CODES.find((c) => c === code);
  return known === undefined
    ? `the relay refused it with a code this build does not know (${code})`
    : STORE_ERROR_TEXT[known];
}

/**
 * `store_full` while the leader lists records it cannot read: those hold slots
 * no prune frees, so `storeErrorText`'s "try again later" would never come true.
 */
export function storeFullUnreadableText(unreadable: number): string {
  const records = unreadable === 1 ? "1 of its records" : `${unreadable} of its records`;
  return `the queue is full, and ${records} cannot be read (junk, or sealed under an earlier key), which no prune frees`;
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
      return reason.field === "deviceId" ? "not the pinned machine" : "not the pinned account";
    case "avoided":
      return "the task avoids this machine";
    case "repo_absent":
      return "no clone of this repo there";
    case "continue_elsewhere":
      return "the session it continues ran elsewhere";
    case "continue_unsupported":
      return "its daemon can't continue a session yet (needs seanced update)";
    case "auth_missing":
      return "not signed in";
    case "auth_expired":
      return "its login has expired (needs /login)";
    case "skill_absent":
      return `the ${reason.skill} skill is not installed there`;
    case "base_unpushed":
      return "the branch it stacks on is not pushed, and sits on another exclave";
    case "quota_unknown":
      return reason.why === "trimmed"
        ? "its account's quota was trimmed from the latest status"
        : "its account's quota has never been observed";
    case "quota_over_line": {
      const line = `${reason.window} quota would reach ${Math.round(reason.projectedPct)}%`;
      return reason.creditsSpent === true ? `${line}, and its credits are spent` : line;
    }
    case "model_not_included":
      return `its seat bills ${reason.model} to credits`;
    case "cap_reached":
      if (reason.scope === "account")
        return `${reason.inFlight} of ${reason.max} auto tasks already in flight on its account`;
      return `${reason.inFlight} of ${reason.max} auto tasks already in flight`;
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
  session_failed: "its session exited with an error and reported no pull request",
  continue_expired: "the continuation was not placed in time, so the scheduler stopped waiting for it",
  queue_expired: `it sat in the queue over ${Math.round(STORE_TOMBSTONE_MS / DAY_MS)} days, too long to start safely`,
};

/**
 * Signals by number, only where macOS and Linux agree: the daemon folds a signal
 * death into `128 + n` by its own host's numbering (`daemon/src/sessions.ts`), so
 * a number past these (10 is SIGUSR1 on Linux, SIGBUS on macOS) names nothing.
 */
const PORTABLE_SIGNALS: ReadonlyMap<number, string> = new Map([
  [1, "SIGHUP"],
  [2, "SIGINT"],
  [3, "SIGQUIT"],
  [4, "SIGILL"],
  [5, "SIGTRAP"],
  [6, "SIGABRT"],
  [8, "SIGFPE"],
  [9, "SIGKILL"],
  [11, "SIGSEGV"],
  [13, "SIGPIPE"],
  [14, "SIGALRM"],
  [15, "SIGTERM"],
]);

/** How a session ended, from `Task.failure.exit`: a clause after "its session", and a hint where one helps. */
export interface SessionExit {
  readonly clause: string;
  readonly hint?: string;
}

/** A status `Task.failure.exit` may hold; anything else (0, a negative, past a byte, a fraction) is no failure status. */
function failureStatus(exit: number | undefined): number | undefined {
  return exit !== undefined && Number.isInteger(exit) && exit >= 1 && exit <= EXIT_STATUS_MAX ? exit : undefined;
}

/** A status past 128 is the shell's `128 + signal`, so the session was ended from outside and wrote nothing at the end. */
export function endedBySignal(exit: number | undefined): boolean {
  const status = failureStatus(exit);
  return status !== undefined && status > 128;
}

/** What a task under `until: "reported"` lacked, beside a PR: the session's own report. */
function missing(until: TaskUntil | undefined): string {
  return until === "reported" ? "did not report done" : "reported no pull request";
}

/**
 * What `oomKill` (`Task.failure.oomKill`) makes of a SIGKILL. `true` names the
 * evidence, not the victim: an OOM kill counted in its cgroup while it died,
 * which on a unit install every session shares. `false` rules out only the
 * kernel's OOM killer — a userspace one (systemd-oomd, earlyoom) counts nothing.
 */
function sigkillHint(oomKill: boolean | undefined): string {
  if (oomKill === true) return "out of memory (the kernel's OOM killer fired as it died)";
  if (oomKill === false) return "not by the kernel's OOM killer";
  // The OOM killer sends SIGKILL; so can a person, hence "possibly".
  return "possibly out of memory";
}

/** `oomKill` is read only with a SIGKILL status, the one it is noted beside. */
export function sessionExit(exit?: number, oomKill?: boolean): SessionExit {
  const status = failureStatus(exit);
  if (status === undefined) return { clause: "exited with an error" };
  const signal = status > 128 ? PORTABLE_SIGNALS.get(status - 128) : undefined;
  if (signal === undefined) return { clause: `exited with status ${status}` };
  // Only SIGKILL cannot be caught: any other signal's status may be a process exiting on it by choice, so it never claims a kill.
  return signal === "SIGKILL"
    ? { clause: "was killed (SIGKILL)", hint: sigkillHint(oomKill) }
    : { clause: `ended on ${signal} (status ${status})` };
}

/**
 * A scheduler-set failure's line; null for any other code — a daemon's spawn refusal, or one minted later.
 * `exit` (`Task.failure.exit`) words a `session_failed` exactly, with `oomKill` (`Task.failure.oomKill`)
 * for a SIGKILL, and `until` (`TaskSpec.until`) what it lacked; without `exit`, or for any other code,
 * the line is the code's alone.
 */
export function taskFailureText(code: string, exit?: number, until?: TaskUntil, oomKill?: boolean): string | null {
  const known = TASK_FAILURE_CODES.find((c) => c === code);
  if (known === undefined) return null;
  if (known !== "session_failed") return TASK_FAILURE_TEXT[known];
  const { clause, hint } = sessionExit(exit, oomKill);
  return `its session ${clause}${hint === undefined ? "" : `, ${hint},`} and ${missing(until)}`;
}

/** A clause shown on its own: capitalized and closed. */
export function sentence(clause: string): string {
  const text = `${clause.charAt(0).toUpperCase()}${clause.slice(1)}`;
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}
