import { statesIn, type Task, type TaskState } from "@seance/shared";

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
 * `lost` is held, not terminal: its session may still be alive on a machine
 * that is only asleep, and a second dispatch would be its twin. Only that
 * machine's answer moves it — a session carrying the task id (`running`), an
 * event from it, or no such session — or a cancel, which cannot reach a
 * machine that is gone and so leaves its session as it is. A task lost from
 * `running` with no session is `done`, as takeover settles a running task whose
 * session is gone. One lost from `reserved` (`reservedAt` kept) never had its
 * spawn confirmed: with no session it is `ready` again only when the machine's
 * ledger proves the spawn never landed, and `failed` otherwise. `lost → ready`
 * is legal for that task alone, and `advance` refuses it for any other.
 *
 * M3's `queued`, `blocked` and `awaiting-merge` are in the schema already but
 * have no edges yet: nothing enters or leaves them until M3 item 4a does.
 */
export const TRANSITIONS = {
  queued: [],
  blocked: [],
  ready: ["reserved", "cancelled"],
  reserved: ["running", "needs-input", "done", "ready", "lost", "failed", "cancelled"],
  running: ["needs-input", "lost", "done", "failed", "cancelled"],
  "needs-input": ["running", "lost", "done", "failed", "cancelled"],
  "awaiting-merge": [],
  lost: ["running", "needs-input", "done", "ready", "failed", "cancelled"],
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
export const FINISHED: readonly TaskState[] = statesIn("finished");

/** States whose session was placed on a machine and may still be running there. */
export const PLACED: readonly TaskState[] = statesIn("placed");

export function canTransition(from: TaskState, to: TaskState): boolean {
  const allowed: readonly TaskState[] = TRANSITIONS[from];
  return allowed.includes(to);
}

/** A task lost from `reserved`: its spawn was never confirmed, so ledger proof may release it. */
export function isUnconfirmed(task: Task): boolean {
  return task.state === "lost" && task.reservedAt !== undefined;
}

/**
 * The one way a task changes state. An illegal move is a scheduler bug, not
 * an input error, so it throws rather than returning a code. Leaving
 * `reserved` drops the reservation; returning to `ready` drops the assignment;
 * leaving `lost` drops when its machine went absent; `reservedAt` survives only
 * from `reserved` into `lost`.
 */
export function advance(task: Task, to: TaskState, fields: Partial<Omit<Task, "id" | "spec" | "state">> = {}): Task {
  if (!canTransition(task.state, to)) throw new Error(`task ${task.id}: ${task.state} → ${to} is not a transition`);
  if (task.state === "lost" && to === "ready" && !isUnconfirmed(task)) {
    throw new Error(`task ${task.id}: a lost task that ran never returns to ready`);
  }
  const { reservation, assignment, absentSince: _absent, reservedAt, ...rest } = task;
  const keepsReservedAt = to === "reserved" || (to === "lost" && task.state === "reserved");
  return {
    ...rest,
    ...(to === "reserved" && reservation !== undefined ? { reservation } : {}),
    ...(keepsReservedAt && reservedAt !== undefined ? { reservedAt } : {}),
    ...(to !== "ready" && assignment !== undefined ? { assignment } : {}),
    ...fields,
    state: to,
  };
}
