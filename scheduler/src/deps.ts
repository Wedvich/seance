import {
  DEP_MISSING_GRACE_MS,
  STORE_TOMBSTONE_MS,
  TASK_FAILURE_LIMITS,
  type DepAfter,
  type TaskFailureCode,
} from "@seance/shared";
import { FINISHED, type Task } from "./task.ts";

/**
 * Admission and hand-declared dependencies (`TaskDep`, M3 PR 0b): which
 * waiting task may run, which waits on, and which never can. Pure: the
 * scheduler writes what `admission` returns.
 */

export type Admission =
  | { readonly state: "blocked" | "ready" }
  | {
      readonly state: "failed";
      readonly failure: { readonly code: TaskFailureCode; readonly message: string };
    };

type Judgement = Admission | { readonly state: "wait" };

/**
 * Whether `pred` releases an edge. `done` releases every edge, whatever settled
 * it — `mark-done` always wins. `opened` needs a PR and the branch pushed; a
 * `here` predecessor has no task branch, so its PR alone. `merged` is `done`,
 * or a recorded merge (`Task.merged`): under `until: "reported"` a merge settles
 * nothing but still releases its `merged` dependents. `done` releases only at
 * `done`, which for a `reported` task waits on its session's report.
 */
export function released(pred: Task, after: DepAfter): boolean {
  if (pred.state === "done") return true;
  if (after === "merged") return pred.merged === true;
  if (after !== "opened") return false;
  return pred.prUrl !== undefined && (pred.spec.mode === "here" || pred.pushed === true);
}

/**
 * The oldest a `queued` task may be and still be admitted. A day short of the
 * tombstone's life: the tombstone runs from the delete on the relay's clock,
 * this from `createdAt` on the creator's, which may be `REPLAY_WINDOW_MS`
 * ahead — so a task pruned soon after its create could otherwise be put back
 * the moment its tombstone lapses and still read young enough.
 */
export const ADMIT_MAX_AGE_MS = STORE_TOMBSTONE_MS - 24 * 60 * 60 * 1000;

/**
 * A `queued` task past `ADMIT_MAX_AGE_MS` is never admitted: its key's
 * tombstone may be gone, so it may be a pruned task's authentic version-1 blob
 * put back (`TaskRecord`). `admission` fails it `queue_expired`, so its
 * dependents fail with it and pruning can take it.
 */
export function isExpired(task: Task, now: number): boolean {
  return task.state === "queued" && now - task.createdAt > ADMIT_MAX_AGE_MS;
}

/**
 * Where each `queued` or `blocked` task moves now, only where that is a move.
 * A failure cascades within the one call — a dependent of a task failed here
 * fails here too — so a chain settles in one pass, not one link per pass. An
 * id held only as an unreadable record (`unreadable`) is in the store, so its
 * dependents wait rather than fail `dependency_missing`.
 */
export function admission(
  tasks: readonly Task[],
  unreadable: ReadonlySet<string>,
  now: number,
): ReadonlyMap<string, Admission> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const waiting = tasks.filter((t) => t.state === "queued" || t.state === "blocked");
  const out = new Map<string, Admission>();
  const failed = new Set<string>();
  const fail = (task: Task, code: TaskFailureCode, message: string): void => {
    out.set(task.id, { state: "failed", failure: { code, message: message.slice(0, TASK_FAILURE_LIMITS.message) } });
    failed.add(task.id);
  };

  for (const task of waiting) {
    if (isExpired(task, now)) fail(task, "queue_expired", "it was queued too long ago to be admitted");
  }

  // A task failed above is finished for the loop check, so its loop-mates fail `dependency_failed` below, not `dependency_cycle`.
  const loops = cycles(tasks.filter((t) => !failed.has(t.id)));
  for (const task of waiting) {
    const loop = loops.get(task.id);
    if (loop !== undefined && !failed.has(task.id)) {
      fail(task, "dependency_cycle", `its dependencies loop: ${loop.join(" → ")}`);
    }
  }

  const judge = (task: Task): Judgement => {
    let blocked = false;
    for (const dep of task.spec.deps ?? []) {
      const pred = byId.get(dep.task);
      if (pred === undefined) {
        if (unreadable.has(dep.task) || now - task.createdAt < DEP_MISSING_GRACE_MS) blocked = true;
        else return failure("dependency_missing", `its dependency ${dep.task} is not in the queue`);
      } else if (failed.has(pred.id) || pred.state === "failed" || pred.state === "cancelled") {
        return failure(
          "dependency_failed",
          `its dependency ${pred.id} ended ${failed.has(pred.id) ? "failed" : pred.state}`,
        );
      } else if (released(pred, dep.after)) {
        continue;
      } else {
        blocked = true;
      }
    }
    return { state: blocked ? "blocked" : "ready" };
  };

  // To a fixpoint: each round can only add failures, so it ends within one round per task.
  for (let changed = true; changed;) {
    changed = false;
    for (const task of waiting) {
      if (failed.has(task.id)) continue;
      const verdict = judge(task);
      if (verdict.state !== "failed") continue;
      fail(task, verdict.failure.code, verdict.failure.message);
      changed = true;
    }
  }
  for (const task of waiting) {
    if (failed.has(task.id)) continue;
    const verdict = judge(task);
    if (verdict.state === "wait" || verdict.state === task.state) continue;
    out.set(task.id, verdict);
  }
  return out;
}

function failure(code: TaskFailureCode, message: string): Judgement {
  return { state: "failed", failure: { code, message } };
}

/** Every id an unfinished task names: pruning must keep each, or its dependent fails `dependency_missing`. */
export function named(tasks: readonly Task[]): ReadonlySet<string> {
  return new Set(
    tasks.filter((t) => !FINISHED.includes(t.state)).flatMap((t) => (t.spec.deps ?? []).map((d) => d.task)),
  );
}

/**
 * Task id → the loop it is on, for every task on one: strongly connected
 * components of more than one task, or one with a self-edge (Tarjan's). Over
 * every held task, since an admitted task can sit on a loop a later create
 * closes.
 */
function cycles(tasks: readonly Task[]): ReadonlyMap<string, readonly string[]> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out = new Map<string, readonly string[]>();
  let next = 0;

  // A finished task's edges have released or failed its dependents, so they cannot be what a loop waits on.
  const edgesOf = (id: string): readonly string[] => {
    const task = byId.get(id);
    if (task === undefined || FINISHED.includes(task.state)) return [];
    return (task.spec.deps ?? []).map((d) => d.task);
  };

  const visit = (id: string): void => {
    index.set(id, next);
    low.set(id, next);
    next += 1;
    stack.push(id);
    onStack.add(id);
    for (const to of edgesOf(id)) {
      if (!byId.has(to)) continue;
      if (!index.has(to)) {
        visit(to);
        low.set(id, Math.min(low.get(id) ?? 0, low.get(to) ?? 0));
      } else if (onStack.has(to)) {
        low.set(id, Math.min(low.get(id) ?? 0, index.get(to) ?? 0));
      }
    }
    if (low.get(id) !== index.get(id)) return;
    const component: string[] = [];
    for (;;) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    const selfEdge = edgesOf(id).includes(id);
    if (component.length < 2 && !selfEdge) return;
    const loop = component.toReversed();
    for (const member of component) out.set(member, loop);
  };

  for (const task of tasks) if (!index.has(task.id)) visit(task.id);
  return out;
}
