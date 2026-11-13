import { CAPABILITIES, closedAt, type DrainRefusal, type Machine } from "@seance/shared";
import type { SchedulerConfig } from "./config.ts";
import type { Task } from "./task.ts";

/**
 * The drain's outside pass dedupe and clock (docs/drain.md §4 step B; DESIGN.md, "Closing a machine"):
 * pure, so the leader only does the I/O. A stamp on the task (`Task.drained`) says which close an
 * attempt was for and when, so one close costs one attempt per `drainRetryMs`, across terms. Named
 * so it never reads as `Scheduler.drain()`, the test quiescence helper.
 */

/**
 * How long after `cl` the leader leaves a machine's sessions to pass themselves. The one predicate:
 * "wait or pass now" is decided here and nowhere else.
 */
export function drainWaitMs(_machine: Machine, config: SchedulerConfig): number {
  // Every machine gets the grace in this build, so a mistaken close is recoverable and a session may pass
  // itself; the session ask (`CAPABILITIES.drainAsk`) and `now` revisit it with step A.
  return config.drainSelfPassMs;
}

/** Whether `task` on `machine` is owed a drain pass now. */
export function drainDue(task: Task, machine: Machine, now: number, config: SchedulerConfig): boolean {
  const cl = closedAt(machine);
  if (cl === null || !machine.connected) return false;
  if (machine.capabilities?.includes(CAPABILITIES.successor) !== true) return false;
  if (task.assignment?.deviceId !== machine.deviceId) return false;
  if (task.state !== "running" && task.state !== "needs-input") return false;
  if (task.spec.mode === "here" || task.successor !== undefined) return false;
  if (now < cl + drainWaitMs(machine, config)) return false;
  const stamp = task.drained;
  if (stamp === undefined || stamp.at !== cl) return true;
  return stamp.held !== true && now - stamp.tried >= config.drainRetryMs;
}

/** The change function for `#update`: the write-ahead stamp, null when the task is no longer due. */
export function stampDrain(task: Task, machine: Machine, now: number, config: SchedulerConfig): Task | null {
  const cl = closedAt(machine);
  if (cl === null || !drainDue(task, machine, now, config)) return null;
  return { ...task, drained: { at: cl, tried: now } };
}

/**
 * The refusal written into the stamp of the attempt at `cl`; `held` marks an answer that may follow the
 * successor's create. Null when it is not ours to write: another close's stamp, a finished task, or one
 * that already carries a `successor`.
 */
export function stampDrainRefusal(task: Task, cl: number, outcome: DrainRefusal | "held"): Task | null {
  const stamp = task.drained;
  if (stamp?.at !== cl || task.successor !== undefined) return null;
  if (task.state !== "running" && task.state !== "needs-input") return null;
  return {
    ...task,
    drained: {
      at: stamp.at,
      tried: stamp.tried,
      ...(outcome === "held" ? { held: true as const } : { refused: outcome }),
    },
  };
}
