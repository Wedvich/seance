import { newestLanded, TASK_PHASES, waitingContinuation, type Task } from "@seance/shared";
import { holder } from "./deps.ts";

/**
 * Where a session message to `to` goes (DESIGN.md, "Session messages", "Cross-machine"). `held`: the task is
 * waiting for a machine, and nothing is kept. `ended`: its record holds no placement to ask. `unknown`: no such
 * task, or a chain that cannot be read to its end.
 */
export type MessageRoute =
  | {
      readonly kind: "forward";
      readonly taskId: string;
      readonly deviceId: string;
      /** The record is finished: the target daemon answers a live pane `delivered`, never `held` for want of one. */
      readonly settled: boolean;
    }
  | { readonly kind: "held"; readonly taskId: string }
  | { readonly kind: "ended"; readonly taskId: string }
  | { readonly kind: "unknown" };

/**
 * Pure: the task the message reaches and the machine holding it, from the leader's own list. A `superseded` task
 * follows its `successor` chain as its dependents do (`holder`); a finished one follows its newest landed
 * continuation. A finished task that held a placement is forwarded rather than answered `ended`: a session often
 * outlives its record's `done`, and the same-machine path delivers to it, so the machine it ran on decides.
 */
export function resolveMessageTarget(to: string, tasks: readonly Task[]): MessageRoute {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  let current = byId.get(to);
  while (current !== undefined) {
    if (visited.has(current.id)) return { kind: "unknown" };
    visited.add(current.id);
    switch (TASK_PHASES[current.state]) {
      case "waiting":
      case "dispatching":
        return { kind: "held", taskId: current.id };
      case "placed":
        return current.assignment === undefined
          ? { kind: "held", taskId: current.id }
          : { kind: "forward", taskId: current.id, deviceId: current.assignment.deviceId, settled: false };
      case "ended":
      case "finished": {
        if (current.state === "superseded") {
          const next = holder(current, byId);
          if (next === null) return { kind: "unknown" };
          current = next;
          continue;
        }
        const landed = newestLanded(current, tasks);
        if (landed !== undefined && landed.id !== current.id) {
          current = landed;
          continue;
        }
        const waiting = waitingContinuation(current, tasks);
        if (waiting !== undefined) return { kind: "held", taskId: waiting.id };
        return current.assignment === undefined
          ? { kind: "ended", taskId: current.id }
          : { kind: "forward", taskId: current.id, deviceId: current.assignment.deviceId, settled: true };
      }
    }
  }
  return { kind: "unknown" };
}
