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
 *
 * `lost` is held, not terminal, and has no edge back to `ready`: its session
 * may still be alive on a machine that is only asleep, and a second dispatch
 * would be its twin. Only that machine's answer moves it — a session carrying
 * the task id (`running`), an event from it, or no such session (`done`, as
 * takeover settles a running task whose session is gone).
 */
export const TRANSITIONS = {
  ready: ["reserved", "cancelled"],
  reserved: ["running", "needs-input", "done", "ready", "failed", "cancelled"],
  running: ["needs-input", "lost", "done", "failed", "cancelled"],
  "needs-input": ["running", "lost", "done", "failed", "cancelled"],
  lost: ["running", "needs-input", "done"],
  done: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<TaskState, readonly TaskState[]>;

/**
 * States that hold a concurrency slot and count toward projected usage. Not
 * `lost`: a forgotten machine would otherwise hold its slots for good.
 */
export const IN_FLIGHT: readonly TaskState[] = ["reserved", "running", "needs-input"];

/** States with nothing left to happen. */
export const FINISHED: readonly TaskState[] = ["done", "failed", "cancelled"];

export function canTransition(from: TaskState, to: TaskState): boolean {
  const allowed: readonly TaskState[] = TRANSITIONS[from];
  return allowed.includes(to);
}

/**
 * The one way a task changes state. An illegal move is a scheduler bug, not
 * an input error, so it throws rather than returning a code. Leaving
 * `reserved` drops the reservation; returning to `ready` drops the assignment;
 * leaving `lost` drops when its machine went absent.
 */
export function advance(task: Task, to: TaskState, fields: Partial<Omit<Task, "id" | "spec" | "state">> = {}): Task {
  if (!canTransition(task.state, to)) throw new Error(`task ${task.id}: ${task.state} → ${to} is not a transition`);
  const { reservation, assignment, absentSince: _absent, ...rest } = task;
  return {
    ...rest,
    ...(to === "reserved" && reservation !== undefined ? { reservation } : {}),
    ...(to !== "ready" && assignment !== undefined ? { assignment } : {}),
    ...fields,
    state: to,
  };
}
