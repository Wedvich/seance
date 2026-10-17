import type { Task } from "./task.ts";

/**
 * What the library tells its host as it happens, beside what the record shows:
 * a dispatch spending credits, and a task left waiting for input. The leader
 * logs each line; M4's Web Push sends the same alerts. `message` is a line for
 * a log — ids only, never a prompt or title.
 */
export type SchedulerAlert =
  | {
      readonly kind: "spill";
      readonly taskId: string;
      readonly accountId: string;
      readonly window: string;
      readonly projectedPct: number;
      readonly message: string;
    }
  | {
      readonly kind: "needs-input";
      readonly taskId: string;
      /** When it entered `needs-input`, ms. */
      readonly since: number;
      readonly message: string;
    };

/**
 * The needs-input clock rides the write that moves the state: entering
 * `needs-input` stamps `needsInputSince`, leaving it for any state but `lost`
 * clears it and `escalated`. `lost` keeps both: a machine's absence is not an
 * answer, and the wait resumes where it was when the machine returns. On the
 * record, so a new leader does not restart the clock.
 */
export function inputClock(task: Task, now: number): Task {
  if (task.state === "needs-input") {
    return task.needsInputSince === undefined ? { ...task, needsInputSince: now } : task;
  }
  if (task.state === "lost") return task;
  if (task.needsInputSince === undefined && task.escalated === undefined) return task;
  const { needsInputSince: _since, escalated: _escalated, ...rest } = task;
  return rest;
}

/**
 * A task waiting for input past `afterMs` is escalated, once per stay — never
 * killed, its slot kept (docs/scheduler.md, Settled defaults 5). One stamped by
 * no one (an older leader's record) has its clock started instead. Null when
 * nothing is due.
 */
export function escalation(task: Task, now: number, afterMs: number): Task | null {
  if (task.state !== "needs-input" || task.escalated === true) return null;
  if (task.needsInputSince === undefined) return { ...task, needsInputSince: now };
  return now - task.needsInputSince >= afterMs ? { ...task, escalated: true } : null;
}
