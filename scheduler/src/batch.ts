import { codeUnitOrder } from "./order.ts";
import type { Task } from "./task.ts";

/**
 * Ready tasks in the order a pass routes them: oldest first, except that a
 * batch's members go together in `index` order, from where its oldest ready
 * member would have gone. A batch is a group (`BatchMembership`): this keeps
 * its members adjacent and in the order given, but holds none of them —
 * order between members is their `after` edges, concurrency the caps.
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
