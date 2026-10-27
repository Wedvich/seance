import { reasonText, TASK_FAILURE_LIMITS, type Decision, type TaskFailureCode } from "@seance/shared";
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
 * `lost` and `awaiting-merge` are never pruned and hold no slot, but outlive
 * every term: past their bound they fail,
 * which also fails their waiting dependents. A `ready` continuation fails past
 * `continueExpiryMs` since `createdAt`: its machine never took it. Its message
 * names that machine's rejections from `decision`, the leader's last in-memory one. `lost` ages from when its machine
 * went away, `awaiting-merge` from `endedAt` (an older leader's record has none:
 * `createdAt`, which is never later). Null when nothing is due.
 */
export function expiry(
  task: Task,
  now: number,
  config: Pick<SchedulerConfig, "lostExpiryMs" | "mergeExpiryMs" | "continueExpiryMs">,
  decision?: Decision,
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
    const unreported = task.spec.until === "reported";
    return fail(
      task,
      "merge_expired",
      unreported ? `${age} and it was never reported done` : `${age} and no merge of its pull request was seen`,
    );
  }
  if (task.state === "ready" && task.spec.continues !== undefined) {
    if (now - task.createdAt <= config.continueExpiryMs) return null;
    const { at } = task.spec.continues;
    // Exact target only: the device's other exclaves are rejected `continue_elsewhere`, which says nothing of why this one never took it.
    const exact = (decision?.candidates ?? []).filter((c) => c.deviceId === at.deviceId && c.exclave === at.exclave);
    const reasons = [...new Set(exact.flatMap((c) => c.rejected.map(reasonText)))];
    // A fleet-wide hold (pause, version floor, caps, quota) also keeps it `ready`, and the clock does not stop for it.
    const why = reasons.length > 0 ? reasons.join(", ") : "its machine never took it";
    return fail(
      task,
      "continue_expired",
      `the session it continues was not resumed within ${days(config.continueExpiryMs)} days: ${why}; the task it continues may be continued again while its machine still holds its launch (a week)`,
    );
  }
  return null;
}
