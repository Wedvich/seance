import { newestLanded, TASK_PHASES, type ContinuedBy } from "@seance/shared";
import type { Task } from "./task.ts";

/**
 * The write that keeps an `awaiting-merge` task's `continuedBy` pointer true to its chain, or null when it is.
 * The leader holds every task, so it alone can name the newest continuation that landed (`newestLanded`); a
 * client's list is bounded and may leave it out. Recomputed every pass, so it covers every path a continuation
 * lands by (spawn verdict, session event, takeover) and a pointer an older leader dropped.
 *
 * `live` while that continuation is dispatching or placed. A new continuation (the pointer's task changed)
 * also drops `prAlert`: the user tapped Continue after that alert, and a continuation that ends without a new
 * head must be able to alert again. `live` flipping alone does not, or a stamp written while the chain is quiet
 * would be cleared every pass.
 */
export function continuedChange(task: Task, tasks: readonly Task[]): Task | null {
  if (task.state !== "awaiting-merge") return null;
  const landed = newestLanded(task, tasks);
  const phase = landed === undefined ? undefined : TASK_PHASES[landed.state];
  const want: ContinuedBy | undefined =
    landed === undefined
      ? undefined
      : {
          task: landed.id,
          createdAt: landed.createdAt,
          ...(phase === "dispatching" || phase === "placed" ? { live: true as const } : {}),
        };
  const have = task.continuedBy;
  if (want?.task === have?.task && want?.createdAt === have?.createdAt && want?.live === have?.live) return null;
  const { continuedBy: _had, prAlert, ...rest } = task;
  const moved = want?.task !== have?.task;
  return {
    ...rest,
    ...(want === undefined ? {} : { continuedBy: want }),
    ...(prAlert === undefined || moved ? {} : { prAlert }),
  };
}
