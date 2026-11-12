import { sleepingMachine, type Machine, type Task } from "@seance/shared";

// Leaf module: view.ts and decision-view.ts both read it, and decision-view imports view.
// `sleepingMachine` itself is shared: `seanced mcp` marks the same tasks `away`.
export { sleepingMachine };

/** True when the task's machine is asleep: its row moves to Asleep and reads differently on the Queue screen. */
export function machineAsleep(task: Task, machines: readonly Machine[]): boolean {
  return sleepingMachine(task, machines) !== undefined;
}

/** An escalated task the phone can answer now: one on a sleeping machine waits for the lid. */
export function needsAttention(tasks: readonly Task[], machines: readonly Machine[]): boolean {
  return tasks.some((t) => t.state === "needs-input" && t.escalated === true && !machineAsleep(t, machines));
}
