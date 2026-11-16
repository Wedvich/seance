import { schedulerRole, type Machine, type SchedulerAvailability } from "./app-client.ts";
import { schedulerErrorText, sentence } from "./scheduler-text.ts";
import { closedAt, drainStart } from "./status-reader.ts";
import type { DrainRefusal, SessionEntry, Task } from "./types.ts";

/**
 * What a closed machine's drain has done and what it is stuck on (docs/drain.md; DESIGN.md, "Closing
 * a machine"): the one rule the PWA, MCP and `seanced close --wait` share, computed from a queue
 * reply's tasks and the machine's `sessions` reply — the leader exposes nothing beyond the stamp on the
 * task record. Imports nothing that logs, since `seanced mcp` reaches it.
 */

export type DrainStuckReason = "here" | "untasked" | "unplaced" | "refused";

export interface DrainStuck {
  readonly taskId?: string;
  readonly reason: DrainStuckReason;
  /** The pass refusal behind `refused`. */
  readonly code?: DrainRefusal;
}

export interface DrainMoving {
  readonly taskId: string;
  readonly waitingOnYou: boolean;
  /**
   * The leader released its slot for sitting idle at its prompt (`QueueResponse.idle`): it will not finish on its own.
   * Lags the turn's end by the leader's `idleReleaseAfterMs` (10 minutes); nothing nearer reaches a client.
   */
  readonly idle: boolean;
}

export interface DrainView {
  /**
   * The drain has started (`drainStart`), or the caller knows it has. False on a soft close: nothing is asked or moved,
   * and `moving` is what still runs there, left to finish on its own.
   */
  readonly draining: boolean;
  readonly moving: readonly DrainMoving[];
  /** Successor ids created by this close's drain, placed or settled. */
  readonly moved: readonly string[];
  readonly stuck: readonly DrainStuck[];
  /** No live pane on the machine; null when its sessions could not be read. */
  readonly empty: boolean | null;
}

export interface DrainViewOptions {
  /**
   * Overrides the machine's own `cl` (`closedAt`): a client that has just closed it knows the time from the close
   * reply while its status may lag. Null reads it as open (no stamp and no successor counts), which is the confirm
   * sheet's prospective list.
   */
  readonly cl?: number | null;
  /** The caller knows the drain started (it just sent one) though the status may lag; else `drainStart` decides. */
  readonly draining?: boolean;
  /** `QueueResponse.idle`'s task ids. */
  readonly idle?: readonly string[];
}

/**
 * `sessions` may name a task the queue reply does not list: the reply is capped at `QUEUE_MAX_TASKS`,
 * so absence is no proof the pane is not a task, and it counts as moving.
 */
export function drainView(
  machine: Pick<Machine, "deviceId" | "status" | "capabilities">,
  tasks: readonly Task[],
  sessions: readonly SessionEntry[] | null,
  opts: DrainViewOptions = {},
): DrainView {
  const cl = opts.cl === undefined ? closedAt(machine) : opts.cl;
  const draining = opts.draining === true || drainStart(machine) !== null;
  const idle = new Set(opts.idle ?? []);
  const moving: DrainMoving[] = [];
  const moved: string[] = [];
  const stuck: DrainStuck[] = [];
  const counted = new Set<string>();
  const addMoved = (id: string): void => {
    if (!moved.includes(id)) moved.push(id);
  };

  for (const task of tasks) {
    if (task.assignment?.deviceId === machine.deviceId && (task.state === "running" || task.state === "needs-input")) {
      counted.add(task.id);
      if (task.successor !== undefined) {
        addMoved(task.successor);
      } else if (task.spec.mode === "here" && draining) {
        // On a soft close nothing moves, so a task run in place is only still running.
        stuck.push({ taskId: task.id, reason: "here" });
      } else if (cl !== null && task.drained?.at === cl && task.drained.refused !== undefined) {
        stuck.push({ taskId: task.id, reason: "refused", code: task.drained.refused });
      } else {
        moving.push({ taskId: task.id, waitingOnYou: task.state === "needs-input", idle: idle.has(task.id) });
      }
    }
    const { succeeds } = task.spec;
    if (
      cl !== null &&
      succeeds?.trigger === "drain" &&
      succeeds.at.deviceId === machine.deviceId &&
      task.createdAt >= cl
    ) {
      if (task.state === "queued" || task.state === "blocked" || task.state === "ready" || task.state === "reserved") {
        stuck.push({ taskId: task.id, reason: "unplaced" });
      } else {
        addMoved(task.id);
      }
    }
  }

  for (const session of sessions ?? []) {
    if (session.taskId === undefined) {
      stuck.push({ reason: "untasked" });
      continue;
    }
    if (counted.has(session.taskId)) continue;
    counted.add(session.taskId);
    moving.push({ taskId: session.taskId, waitingOnYou: false, idle: idle.has(session.taskId) });
  }

  // A successor still waiting for a machine is stuck, not moved: counted once.
  const unplaced = new Set(stuck.flatMap((s) => (s.reason === "unplaced" ? [s.taskId] : [])));
  return {
    draining,
    moving,
    moved: moved.filter((id) => !unplaced.has(id)),
    stuck,
    empty: sessions === null ? null : sessions.length === 0,
  };
}

/** The fixed words per stuck reason. */
export function drainStuckText(stuck: DrainStuck): string {
  switch (stuck.reason) {
    case "here":
      return "Can't move: runs in the clone";
    case "untasked":
      return "Not a task: close it yourself";
    case "unplaced":
      return "Moved, waiting for a machine";
    case "refused":
      return stuck.code === undefined ? "Refused" : sentence(schedulerErrorText(stuck.code));
  }
}

/**
 * Whether `machine` is the verified leader (a `lead-proof` sealed `from` it for the pushed term), never a
 * registry entry alone: closing it leaves it leading (docs/drain.md §6), so the queue goes down with it.
 */
export function leadsQueue(machine: Pick<Machine, "deviceId">, scheduler: SchedulerAvailability): boolean {
  return schedulerRole(machine.deviceId, scheduler) === "leader";
}

/**
 * The close's leader note, shared by the close sheet, `seanced close` and `set_machine_open`. No client can
 * see whether another nominee could take over (the relay keeps the signed roles and its allowlist), so it
 * claims neither way; and it is about the box going down while it leads, not about the drain.
 */
export function leaderCloseNote(name: string): string {
  return `${name} runs the queue: while it is down, the queue stops unless another machine can take over.`;
}

/**
 * One line for a row. Draining: "moving 3 · 1 stuck", "moving 1", "empty". Soft-closed, what it waits on: "running 2 ·
 * 1 idle at its prompt · 1 waiting on you". An idle or waiting session never finishes on its own, so that is the
 * owner's cue to drain.
 */
export function drainSummary(view: DrainView): string {
  if (view.empty === true) return "empty";
  const parts: string[] = [];
  if (view.draining) {
    if (view.moving.length > 0) parts.push(`moving ${view.moving.length}`);
  } else {
    const waiting = view.moving.filter((m) => m.waitingOnYou).length;
    const idle = view.moving.filter((m) => m.idle && !m.waitingOnYou).length;
    const running = view.moving.length - waiting - idle;
    if (running > 0) parts.push(`running ${running}`);
    if (idle > 0) parts.push(`${idle} idle at ${idle === 1 ? "its" : "their"} prompt`);
    if (waiting > 0) parts.push(`${waiting} waiting on you`);
  }
  if (view.stuck.length > 0) parts.push(`${view.stuck.length} stuck`);
  if (parts.length > 0) return parts.join(" · ");
  return view.empty === null ? "sessions unknown" : "waiting";
}
