import { TASK_STATES, type Task, type TaskState } from "./types.ts";

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

/**
 * A forge reading of the task's PR can change it: a session was placed (it may
 * have opened the PR) or ended with one open.
 */
export function isPrReadable(state: TaskState): boolean {
  const phase = TASK_PHASES[state];
  return phase === "placed" || phase === "ended";
}

/**
 * The leader's poller reads this task's PR: one a reading can change, or a
 * finished one without a merged reading — none yet, or one that can be stale
 * (taken while it ran, before `advance` dropped such readings) — so its chip
 * does not stay unknown or stale for good. A merge can't un-merge, so that
 * reading is final. The poller bounds a finished task to one read per term;
 * it and `prChange` both ask this, so what is polled is what can be applied.
 */
export function wantsPrReading(task: Pick<Task, "state" | "prUrl" | "pr">): boolean {
  if (task.prUrl === undefined) return false;
  return isPrReadable(task.state) || (TASK_PHASES[task.state] === "finished" && task.pr?.state !== "merged");
}
