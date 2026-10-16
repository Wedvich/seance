import type { SpawnMode } from "@seance/shared";
import type { Decision } from "./route.ts";

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
} as const satisfies Record<string, readonly string[]>;

export type TaskState = keyof typeof TRANSITIONS;

/** States that hold a concurrency slot and count toward projected usage. */
export const IN_FLIGHT: readonly TaskState[] = ["reserved", "running", "needs-input"];

/** Where a session runs or ran: what pins, lineage and dependency distance are measured against. */
export interface Placement {
  readonly deviceId: string;
  readonly exclave: string;
}

/** What the person asked for. Everything the spawn carries except where it lands. */
export interface TaskSpec {
  /** `RepoEntry.origin` — the repo, not a machine's clone of it. */
  readonly repo: string;
  readonly mode: SpawnMode;
  readonly prompt?: string;
  readonly title?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly plan?: boolean;
  /** Restrict to a machine, an exclave name, or both; absent fields are free. */
  readonly pin?: { readonly deviceId?: string; readonly exclave?: string };
  /** The session this one continues — its owner gets the sticky bonus. */
  readonly lineage?: Placement;
  /** Where the work this task builds on lives (M3 fills it from deps); drives `dependency_distance`. */
  readonly base?: Placement;
}

/** A placement plus the machine-local clone name `spawn` takes. */
export interface Target extends Placement {
  readonly clone: string;
}

export interface Reservation extends Target {
  readonly expiresAt: number;
}

export interface Assignment extends Target {
  /** Absent when the daemon answered `task_running`, which names the pane only. */
  readonly window?: string;
  /** The session's pane id, when the daemon reported one. */
  readonly pane?: string;
}

export interface Task {
  readonly id: string;
  readonly spec: TaskSpec;
  readonly state: TaskState;
  readonly createdAt: number;
  readonly reservation?: Reservation;
  readonly assignment?: Assignment;
  /** The routing decision that placed it — written with the reservation, never per tick. */
  readonly decision?: Decision;
  readonly failure?: { readonly code: string; readonly message: string };
}

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
