import { isBranchName, type Placement, type TaskSpec } from "@seance/shared";
import { holder } from "./deps.ts";
import type { Task } from "./task.ts";

/**
 * Where a task's worktree starts (DESIGN.md, Scheduler, "Stacking"; decided #4):
 * - `branch`: its stacking predecessor's pushed, unmerged branch, and where that predecessor ran;
 * - `nothing`: that predecessor finished with no PR or pushed branch to stack on (mark-done, a no-PR
 *   session end, a `here` task) — the default branch, and the session is told so;
 * - `default`: no stacking predecessor, or one whose PR merged — the default branch holds its work, and
 *   its branch may already be deleted.
 */
export type Stack =
  | { readonly on: "branch"; readonly branch: string; readonly at?: Placement }
  | { readonly on: "nothing" }
  | { readonly on: "default" };

const DEFAULT: Stack = { on: "default" };

/**
 * Whether the spec can stack at all: a fresh worktree task with an `after: "opened"` edge. Read from the
 * spec alone, so routing's capability filter never disagrees with the dispatch that follows it, whatever
 * its predecessor did in between. A continuation resumes its own worktree, and a successor its
 * predecessor's branch.
 */
export function mayStack(spec: TaskSpec): boolean {
  return (
    spec.mode === "worktree" &&
    spec.continues === undefined &&
    spec.succeeds === undefined &&
    (spec.deps ?? []).some((d) => d.after === "opened")
  );
}

/**
 * The task's stack now. The predecessor is its first `after: "opened"` dep in `deps` order, followed
 * through a pass chain (`holder`) to the task holding the work. Read at dispatch, after admission
 * released every edge, so an unreadable or missing predecessor is not expected; it starts from the
 * default branch rather than hold a task admission let go.
 */
export function stackOf(task: Task, byId: ReadonlyMap<string, Task>): Stack {
  if (!mayStack(task.spec)) return DEFAULT;
  const first = (task.spec.deps ?? []).find((d) => d.after === "opened");
  const direct = first === undefined ? undefined : byId.get(first.task);
  const pred = direct === undefined ? null : holder(direct, byId);
  if (pred === null) return DEFAULT;
  if (merged(pred)) return DEFAULT;
  if (pred.pushed !== true || pred.spec.mode === "here" || !isBranchName(pred.branch)) return { on: "nothing" };
  const at = pred.assignment;
  return {
    on: "branch",
    branch: pred.branch,
    ...(at === undefined ? {} : { at: { deviceId: at.deviceId, exclave: at.exclave } }),
  };
}

/**
 * Its PR landed on the default branch. A merge into a stacked parent's branch (`pr.stacked`) is not one:
 * the default branch lacks the work, and the branch still stacks.
 */
function merged(task: Task): boolean {
  if (task.state === "done" && task.doneBy === "merged") return true;
  if (task.pr?.state === "merged") return task.pr.stacked !== true;
  return task.merged === true;
}
