import { statesIn, TASK_PHASES, type Task, type TaskState } from "@seance/shared";

// The task's shapes are wire types — `queue` replies carry them — so they live
// in the schema of record; this module owns only how a task moves.
export type { Assignment, Placement, Reservation, Target, Task, TaskSpec, TaskState } from "@seance/shared";

/**
 * The task lifecycle (DESIGN.md, Scheduler, "States"); nothing else encodes it.
 *
 * An app creates a task `queued`; only a leader's admission moves it on — to
 * `blocked` while a dependency edge waits, `ready` once none does, `failed`
 * when one never can (`TaskDep`). A session that ends with a PR open is
 * `awaiting-merge`: no slot held, and `after: "merged"` dependents still
 * blocked until a merge (or `mark-done`) makes it `done`.
 *
 * `reserved` reaches `needs-input`, `awaiting-merge` and `done` directly, not only through
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
 * `running` with no session has ended, as takeover settles a running task whose
 * session is gone (`awaiting-merge` with a PR open, `failed` on a nonzero exit, else `done`). One lost from `reserved` (`reservedAt` kept) never had its
 * spawn confirmed: with no session it is `ready` again only when the machine's
 * ledger proves the spawn never landed, and `failed` otherwise. `lost → ready`
 * is legal for that task alone, and `advance` refuses it for any other. `done` from `queued`, `blocked` or `ready` is `mark-done`'s alone: no signal ever settles never-placed work, and it always wins. `lost`
 * and `awaiting-merge` both fail past their expiry (`expiry.ts`).
 */
export const TRANSITIONS = {
  queued: ["blocked", "ready", "done", "failed", "cancelled"],
  blocked: ["ready", "done", "failed", "cancelled"],
  ready: ["reserved", "done", "cancelled"],
  reserved: ["running", "needs-input", "awaiting-merge", "done", "ready", "lost", "failed", "cancelled"],
  running: ["needs-input", "awaiting-merge", "lost", "done", "failed", "cancelled"],
  "needs-input": ["running", "awaiting-merge", "lost", "done", "failed", "cancelled"],
  "awaiting-merge": ["done", "failed", "cancelled"],
  lost: ["running", "needs-input", "awaiting-merge", "done", "ready", "failed", "cancelled"],
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

/**
 * A finished task keeps no prompt: nothing left reads it. The transcript on
 * the machine is the copy from when the task ran; one that never ran has none
 * (DESIGN.md, Threat model, "Assets"). Returns `task` itself when there is
 * nothing to drop, so callers can tell.
 */
export function forgetPrompt(task: Task): Task {
  if (!FINISHED.includes(task.state) || task.spec.prompt === undefined) return task;
  const { prompt: _prompt, ...rest } = task.spec;
  return { ...task, spec: rest };
}

/** States whose session was placed on a machine and may still be running there. */
export const PLACED: readonly TaskState[] = statesIn("placed");

/** What a transition may set beside the state. */
export type TaskFields = Partial<Omit<Task, "id" | "spec" | "state">>;

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
 * from `reserved` into `lost`. Finishing drops the PR reading (`pr`) unless it
 * is merged: any other reading can go stale (open, or closed and reopened) and
 * the poller reads the finished task once more (`wantsPrReading`), but a
 * merge can't un-merge.
 */
export function advance(task: Task, to: TaskState, fields: TaskFields = {}): Task {
  if (!canTransition(task.state, to)) throw new Error(`task ${task.id}: ${task.state} → ${to} is not a transition`);
  if (task.state === "lost" && to === "ready" && !isUnconfirmed(task)) {
    throw new Error(`task ${task.id}: a lost task that ran never returns to ready`);
  }
  const { reservation, assignment, absentSince: _absent, reservedAt, pr, remoteSession, ...rest } = task;
  const keepsReservedAt = to === "reserved" || (to === "lost" && task.state === "reserved");
  return {
    ...rest,
    ...(to === "reserved" && reservation !== undefined ? { reservation } : {}),
    ...(keepsReservedAt && reservedAt !== undefined ? { reservedAt } : {}),
    ...(to !== "ready" && assignment !== undefined ? { assignment } : {}),
    // A session's, as the assignment is: back to `ready`, the next session gets its own.
    ...(to !== "ready" && remoteSession !== undefined ? { remoteSession } : {}),
    ...(pr !== undefined && (TASK_PHASES[to] !== "finished" || pr.state === "merged") ? { pr } : {}),
    ...fields,
    state: to,
  };
}
