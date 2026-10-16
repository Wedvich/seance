import type { Task, TaskState } from "@seance/shared";

// The task's shapes are wire types — `queue` replies carry them — so they live
// in the schema of record; this module owns only how a task moves.
export type { Assignment, Placement, Reservation, Target, Task, TaskSpec, TaskState } from "@seance/shared";

/**
 * M2's slice of the task lifecycle (docs/scheduler.md, "Task states"): no deps,
 * so no `queued`/`blocked`, and no done detection, so no `awaiting-merge` — a
 * session that ends is `done`. M3 widens this table; nothing else encodes it.
 *
 * `reserved` reaches `needs-input` and `done` directly, not only through
 * `running`: a session event for a reserved task is proof its spawn landed
 * even when the reply never came, and a session that already ended is one
 * observed transition, so one store write — a `running` written first would
 * record a state no one observed, at the cost of a second write.
 */
export const TRANSITIONS = {
  ready: ["reserved", "cancelled"],
  reserved: ["running", "needs-input", "done", "ready", "failed", "cancelled"],
  running: ["needs-input", "done", "failed", "cancelled"],
  "needs-input": ["running", "done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<TaskState, readonly TaskState[]>;

/** States that hold a concurrency slot and count toward projected usage. */
export const IN_FLIGHT: readonly TaskState[] = ["reserved", "running", "needs-input"];

export function canTransition(from: TaskState, to: TaskState): boolean {
  const allowed: readonly TaskState[] = TRANSITIONS[from];
  return allowed.includes(to);
}

/**
 * The one way a task changes state. An illegal move is a scheduler bug, not
 * an input error, so it throws rather than returning a code. Leaving
 * `reserved` drops the reservation; returning to `ready` drops the assignment.
 */
export function advance(task: Task, to: TaskState, fields: Partial<Omit<Task, "id" | "spec" | "state">> = {}): Task {
  if (!canTransition(task.state, to)) throw new Error(`task ${task.id}: ${task.state} → ${to} is not a transition`);
  const { reservation, assignment, ...rest } = task;
  return {
    ...rest,
    ...(to === "reserved" && reservation !== undefined ? { reservation } : {}),
    ...(to !== "ready" && assignment !== undefined ? { assignment } : {}),
    ...fields,
    state: to,
  };
}
