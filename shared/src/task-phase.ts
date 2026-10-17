import { TASK_STATES, type TaskState } from "./types.ts";

/**
 * Where a task stands, coarser than its state: what the scheduler, the PWA and
 * `seanced mcp` each ask of one ("is it placed?", "can a follower stop?") as one
 * table, so they cannot drift apart as M3's states start moving. The
 * scheduler's own rules — the edges, which states hold a slot — stay in
 * `scheduler/src/task.ts`.
 *
 * - `waiting`: no machine chosen yet (`queued` and `blocked` wait on more than capacity).
 * - `dispatching`: reserved on a machine, its spawn out.
 * - `placed`: its session was put on a machine and may still be running there.
 * - `ended`: its session ended, with something still to happen (a merge).
 * - `finished`: nothing left to happen.
 */
export type TaskPhase = "waiting" | "dispatching" | "placed" | "ended" | "finished";

export const TASK_PHASES = {
  queued: "waiting",
  blocked: "waiting",
  ready: "waiting",
  reserved: "dispatching",
  running: "placed",
  "needs-input": "placed",
  lost: "placed",
  "awaiting-merge": "ended",
  done: "finished",
  failed: "finished",
  cancelled: "finished",
} as const satisfies Record<TaskState, TaskPhase>;

export function statesIn(phase: TaskPhase): readonly TaskState[] {
  return TASK_STATES.filter((state) => TASK_PHASES[state] === phase);
}

/** A machine was chosen for it: its decision says where it went, not where it would. */
export function isRouted(state: TaskState): boolean {
  return TASK_PHASES[state] !== "waiting";
}

/** Past its way to a machine: a follower waiting to see where it landed can stop. */
export function isSettled(state: TaskState): boolean {
  const phase = TASK_PHASES[state];
  return phase !== "waiting" && phase !== "dispatching";
}
