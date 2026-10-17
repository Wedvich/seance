import { named } from "./deps.ts";
import { codeUnitOrder } from "./order.ts";
import { FINISHED, type Task } from "./task.ts";

/**
 * The finished tasks to delete so at most `keep` remain, oldest first. Never
 * one an unfinished task names: its dependent would fail `dependency_missing`
 * on work that was there. The store caps `task:` (`MAX_TASKS`) and an app's
 * create past it is `store_full`, which only this frees.
 */
export function prunable(tasks: readonly Task[], keep: number): readonly Task[] {
  const finished = tasks.filter((t) => FINISHED.includes(t.state));
  const excess = finished.length - keep;
  if (excess <= 0) return [];
  const kept = named(tasks);
  return finished
    .filter((t) => !kept.has(t.id))
    .toSorted((a, b) => a.createdAt - b.createdAt || codeUnitOrder(a.id, b.id))
    .slice(0, excess);
}
