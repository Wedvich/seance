import type { Machine } from "./app-client.ts";
import { schedulerErrorText, sentence } from "./scheduler-text.ts";
import { closedAt } from "./status-reader.ts";
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
}

export interface DrainView {
  readonly moving: readonly DrainMoving[];
  /** Successor ids created by this close's drain, placed or settled. */
  readonly moved: readonly string[];
  readonly stuck: readonly DrainStuck[];
  /** No live pane on the machine; null when its sessions could not be read. */
  readonly empty: boolean | null;
}

/**
 * `cl` overrides the machine's own `cl` (`closedAt`): a client that has just closed it knows the time
 * from the close reply while its status may lag. Works on an open machine too (no `cl`: no stamp and
 * no successor counts), which is the confirm sheet's prospective list.
 *
 * `sessions` may name a task the queue reply does not list: the reply is capped at `QUEUE_MAX_TASKS`,
 * so absence is no proof the pane is not a task, and it counts as moving.
 */
export function drainView(
  machine: Pick<Machine, "deviceId" | "status">,
  tasks: readonly Task[],
  sessions: readonly SessionEntry[] | null,
  cl: number | null = closedAt(machine),
): DrainView {
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
      } else if (task.spec.mode === "here") {
        stuck.push({ taskId: task.id, reason: "here" });
      } else if (cl !== null && task.drained?.at === cl && task.drained.refused !== undefined) {
        stuck.push({ taskId: task.id, reason: "refused", code: task.drained.refused });
      } else {
        moving.push({ taskId: task.id, waitingOnYou: task.state === "needs-input" });
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
    moving.push({ taskId: session.taskId, waitingOnYou: false });
  }

  // A successor still waiting for a machine is stuck, not moved: counted once.
  const unplaced = new Set(stuck.flatMap((s) => (s.reason === "unplaced" ? [s.taskId] : [])));
  return {
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

/** One line for a row: "moving 3 · 1 stuck", "moving 1", "empty". */
export function drainSummary(view: DrainView): string {
  if (view.empty === true) return "empty";
  const parts: string[] = [];
  if (view.moving.length > 0) parts.push(`moving ${view.moving.length}`);
  if (view.stuck.length > 0) parts.push(`${view.stuck.length} stuck`);
  if (parts.length > 0) return parts.join(" · ");
  return view.empty === null ? "sessions unknown" : "waiting";
}
