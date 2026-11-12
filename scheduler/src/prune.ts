import { named } from "./deps.ts";
import { codeUnitOrder } from "./order.ts";
import { FINISHED, type Task } from "./task.ts";

/**
 * The finished continuations whose chain an unfinished task roots: each `continues` link, followed up through
 * `tasks`, reaches one. The leader walks that chain for an `awaiting-merge` task's `continuedBy`
 * (`newestLanded`), and a pruned link would break the walk and move the pointer back to the task. Bounded: such
 * a task fails `merge_expired` within days, after which its chain is prunable again.
 */
function chained(tasks: readonly Task[]): ReadonlySet<string> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const kept = new Set<string>();
  for (const task of tasks) {
    if (!FINISHED.includes(task.state) || task.spec.continues === undefined) continue;
    let up = byId.get(task.spec.continues.task);
    for (let step = 0; up !== undefined && step < tasks.length; step++) {
      if (!FINISHED.includes(up.state)) {
        kept.add(task.id);
        break;
      }
      up = up.spec.continues === undefined ? undefined : byId.get(up.spec.continues.task);
    }
  }
  return kept;
}

/** Every id pruning must keep: what an unfinished task names (`named`) and a finished link of a live chain. */
export function unprunable(tasks: readonly Task[]): ReadonlySet<string> {
  return new Set([...named(tasks), ...chained(tasks)]);
}

/**
 * The finished tasks to delete so at most `keep` remain, oldest first. Never
 * one an unfinished task names: its dependent would fail `dependency_missing`
 * on work that was there. Nor one in a continuation chain whose root is
 * unfinished, since the leader walks it for `continuedBy`. The store caps `task:` (`MAX_TASKS`) and an app's
 * create past it is `store_full`, which only this frees.
 */
export function prunable(tasks: readonly Task[], keep: number): readonly Task[] {
  const finished = tasks.filter((t) => FINISHED.includes(t.state));
  const excess = finished.length - keep;
  if (excess <= 0) return [];
  const held = unprunable(tasks);
  return finished
    .filter((t) => !held.has(t.id))
    .toSorted((a, b) => a.createdAt - b.createdAt || codeUnitOrder(a.id, b.id))
    .slice(0, excess);
}
