import type { BatchStrategy, Reason } from "@seance/shared";
import { IN_FLIGHT, type Task } from "./task.ts";

/**
 * Batches (`BatchMembership`): no batch record exists, so a batch is the tasks
 * that name its id, and its strategy is the earliest-created member's.
 */

/** Members in flight at most; null is no batch-level bound (`auto`). */
function bound(strategy: BatchStrategy): number | null {
  if (strategy.mode === "sequential") return 1;
  if (strategy.mode === "parallel") return strategy.max;
  return null;
}

/** The earliest-created member's strategy — ties to the lower id, so every leader reads the same one. */
function strategyOf(batchId: string, tasks: readonly Task[]): BatchStrategy | undefined {
  return tasks
    .filter((t) => t.spec.batch?.id === batchId)
    .toSorted((a, b) => a.createdAt - b.createdAt || codeUnitOrder(a.id, b.id))[0]?.spec.batch?.strategy;
}

/** `cap_reached` scope `batch` when `task`'s batch already has its bound in flight; null otherwise. */
export function batchCap(task: Task, tasks: readonly Task[]): Reason | null {
  const { batch } = task.spec;
  if (batch === undefined) return null;
  const members = tasks.some((t) => t.id === task.id) ? tasks : [...tasks, task];
  const strategy = strategyOf(batch.id, members);
  const max = strategy === undefined ? null : bound(strategy);
  if (max === null) return null;
  const inFlight = tasks.filter(
    (t) => t.id !== task.id && t.spec.batch?.id === batch.id && IN_FLIGHT.includes(t.state),
  ).length;
  return inFlight >= max ? { code: "cap_reached", inFlight, max, scope: "batch" } : null;
}

/**
 * Ready tasks in the order a pass routes them: oldest first, except that a
 * batch's members go in `index` order, from where its oldest ready member
 * would have gone — so a `sequential` batch runs in the order it was given.
 */
export function dispatchOrder(ready: readonly Task[]): readonly Task[] {
  const since = new Map<string, number>();
  for (const t of ready) {
    const id = t.spec.batch?.id;
    if (id !== undefined) since.set(id, Math.min(since.get(id) ?? t.createdAt, t.createdAt));
  }
  const at = (t: Task): number => {
    const id = t.spec.batch?.id;
    return id === undefined ? t.createdAt : (since.get(id) ?? t.createdAt);
  };
  return ready.toSorted(
    (a, b) =>
      at(a) - at(b) ||
      codeUnitOrder(a.spec.batch?.id ?? "", b.spec.batch?.id ?? "") ||
      (a.spec.batch?.index ?? 0) - (b.spec.batch?.index ?? 0) ||
      a.createdAt - b.createdAt,
  );
}

function codeUnitOrder(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
