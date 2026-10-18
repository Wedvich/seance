import { TASK_FAILURE_LIMITS, type TaskFailureCode } from "@seance/shared";
import type { SchedulerConfig } from "./config.ts";
import { advance, type Task } from "./task.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const days = (ms: number): number => Math.round(ms / DAY_MS);

const iso = (at: number): string => new Date(at).toISOString();

/**
 * The merge clock rides the write that moves the state: entering `awaiting-merge`
 * stamps `endedAt`. Stamps only the transition, so a legacy `awaiting-merge`
 * record is never given a fresh clock by a later progress write.
 */
export function endClock(before: Task, after: Task, now: number): Task {
  if (after.state !== "awaiting-merge" || before.state === "awaiting-merge") return after;
  return { ...after, endedAt: now };
}

function fail(task: Task, code: TaskFailureCode, message: string): Task {
  const failure: { readonly code: TaskFailureCode; readonly message: string } = {
    code,
    message: message.slice(0, TASK_FAILURE_LIMITS.message),
  };
  return advance(task, "failed", { failure });
}

/**
 * `lost` and `awaiting-merge` are never pruned and hold no slot, but count
 * toward `MAX_ACTIVE_TASKS` and outlive every term: past their bound they fail,
 * which also fails their waiting dependents. `lost` ages from when its machine
 * went away, `awaiting-merge` from `endedAt` (an older leader's record has none:
 * `createdAt`, which is never later). Null when nothing is due.
 */
export function expiry(
  task: Task,
  now: number,
  config: Pick<SchedulerConfig, "lostExpiryMs" | "mergeExpiryMs">,
): Task | null {
  if (task.state === "lost") {
    const since = task.absentSince ?? task.createdAt;
    if (now - since <= config.lostExpiryMs) return null;
    // Without `absentSince` the clock is `createdAt`, which says when the task was made, not when its machine went away.
    const why =
      task.absentSince === undefined
        ? `its machine has not answered since before ${iso(since)}, over ${days(config.lostExpiryMs)} days ago`
        : `its machine went away ${iso(since)} and has not answered for it in over ${days(config.lostExpiryMs)} days`;
    return fail(task, "lost_expired", `${why}; any session it had may still be running there`);
  }
  if (task.state === "awaiting-merge") {
    const since = task.endedAt ?? task.createdAt;
    if (now - since <= config.mergeExpiryMs) return null;
    // Without `endedAt` (an older leader's record) the clock is `createdAt`: when the session ended is unknown.
    const age =
      task.endedAt === undefined
        ? `it was created over ${days(config.mergeExpiryMs)} days ago`
        : `its session ended over ${days(config.mergeExpiryMs)} days ago`;
    return fail(task, "merge_expired", `${age} and no merge of its pull request was seen`);
  }
  return null;
}
