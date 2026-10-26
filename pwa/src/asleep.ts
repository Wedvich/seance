import type { Machine, Task } from "@seance/shared";

// Leaf module: view.ts and decision-view.ts both read it, and decision-view imports view.

/** States whose headline says the machine is asleep: a session may be alive there, waiting on the lid. */
const SLEEP_AWARE: ReadonlySet<Task["state"]> = new Set(["reserved", "running", "needs-input", "lost"]);

/**
 * The task's machine when it is listed and not `connected` as this client sees
 * it — the signal the Machines card's "asleep" reads, never the relay flag alone
 * (DESIGN.md, "The Queue screen"). A derived view: the leader's state is unchanged.
 */
export function sleepingMachine(task: Task, machines: readonly Machine[]): Machine | undefined {
  if (!SLEEP_AWARE.has(task.state)) return undefined;
  const at = task.assignment ?? task.reservation;
  if (at === undefined) return undefined;
  const machine = machines.find((m) => m.deviceId === at.deviceId);
  return machine?.connected === false ? machine : undefined;
}

/** True when the task's machine is asleep: its row moves to Asleep and reads differently on the Queue screen. */
export function machineAsleep(task: Task, machines: readonly Machine[]): boolean {
  return sleepingMachine(task, machines) !== undefined;
}

/** An escalated task the phone can answer now: one on a sleeping machine waits for the lid. */
export function needsAttention(tasks: readonly Task[], machines: readonly Machine[]): boolean {
  return tasks.some((t) => t.state === "needs-input" && t.escalated === true && !machineAsleep(t, machines));
}
