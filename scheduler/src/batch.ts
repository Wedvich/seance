import type { BatchStrategy, Reason } from "@seance/shared";
import { codeUnitOrder } from "./order.ts";
import { FINISHED, IN_FLIGHT, type Task, type TaskState } from "./task.ts";

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

/**
 * What a batch's bound counts: in flight, and `lost` — its session may still
 * run on a machine that only sleeps. The global cap leaves `lost` out so a
 * forgotten machine cannot pin it; a batch's own serialization has no such reason.
 */
const BATCH_HELD: ReadonlySet<TaskState> = new Set([...IN_FLIGHT, "lost"]);

/** Past its session: finished, or `awaiting-merge` (no slot, no session). */
export function over(t: Task): boolean {
  return FINISHED.includes(t.state) || t.state === "awaiting-merge";
}

/**
 * `cap_reached` scope `batch` when `task`'s batch already holds its bound, or,
 * for `sequential`, `batch_order` while a lower-`index` member the scheduler
 * holds is not over yet — one unroutable this pass or `blocked` holds the next,
 * so `index` order is what runs, not whichever member routes first. It names
 * the nearest such index, the one `orderEdges` waits on. Order is among held
 * members: a lower index never put, not yet refreshed, or pruned holds
 * nothing, so gaps, 1-based numbering and pruning never wedge a batch, and the
 * cost is the members, not the `index`.
 */
export function batchCap(task: Task, tasks: readonly Task[]): Reason | null {
  const { batch } = task.spec;
  if (batch === undefined) return null;
  const members = tasks.some((t) => t.id === task.id) ? tasks : [...tasks, task];
  const strategy = strategyOf(batch.id, members);
  const max = strategy === undefined ? null : bound(strategy);
  if (max === null) return null;
  const others = tasks.filter((t) => t.id !== task.id && t.spec.batch?.id === batch.id);
  const held = others.filter((t) => BATCH_HELD.has(t.state)).length;
  if (held >= max) return { code: "cap_reached", inFlight: held, max, scope: "batch" };
  if (strategy?.mode !== "sequential") return null;
  const earlier = others.filter((t) => indexOf(t) < batch.index && !over(t)).map(indexOf);
  return earlier.length === 0 ? null : { code: "batch_order", index: Math.max(...earlier) };
}

/**
 * For each `sequential` member not over, the held members it waits on for
 * order: those of the nearest lower `index` not over — the rest are reached
 * through them, so a loop through any lower member is a loop through these.
 * Lets cycle detection see an order wait as an edge.
 */
export function orderEdges(tasks: readonly Task[]): ReadonlyMap<string, readonly string[]> {
  const byBatch = new Map<string, Task[]>();
  for (const t of tasks) {
    const id = t.spec.batch?.id;
    if (id === undefined || over(t)) continue;
    byBatch.set(id, [...(byBatch.get(id) ?? []), t]);
  }
  const out = new Map<string, readonly string[]>();
  for (const [id, members] of byBatch) {
    if (strategyOf(id, tasks)?.mode !== "sequential") continue;
    const sorted = members.toSorted((a, b) => indexOf(a) - indexOf(b));
    let previous: readonly string[] = [];
    let group: string[] = [];
    let groupIndex = Number.NaN;
    for (const t of sorted) {
      if (indexOf(t) !== groupIndex) {
        previous = group;
        group = [];
        groupIndex = indexOf(t);
      }
      out.set(t.id, previous);
      group.push(t.id);
    }
  }
  return out;
}

function indexOf(t: Task): number {
  return t.spec.batch?.index ?? 0;
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
