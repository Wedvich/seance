import type { Machine } from "./app-client.ts";
import { CAPABILITIES, type Target, type Task, type TaskSpec, type TaskState } from "./types.ts";

export type ContinueOffer =
  | { readonly ok: true; readonly at: Target }
  | { readonly ok: false; readonly reason: string };

/**
 * States in which a task that continues another has not (or no longer) taken the session. A
 * queued continuation may still fail unplaced, and cancelling it frees the offer; one that
 * failed or was cancelled left the worktree to be continued again.
 */
const NOT_CONTINUING: ReadonlySet<TaskState> = new Set<TaskState>([
  "queued",
  "blocked",
  "ready",
  "failed",
  "cancelled",
]);

/**
 * Whether a failed task's session can be resumed, and where: the one rule the
 * PWA's button, MCP's `continue_task` and `seanced continue` share so they
 * cannot drift (DESIGN.md, Daemon, "Continuing a failed task"). Only a
 * `session_failed` task qualifies — the others may never have launched, and the
 * daemon's ledger would refuse them anyway. And only once: `tasks` is the list the
 * caller read it from, and a continuation anywhere past the queue (placed, running,
 * waiting on a person, finished) has the worktree, so a second would only be
 * refused by the daemon. Imports nothing that logs, since `seanced mcp` reaches it.
 */
export function continueOffer(task: Task, machines: readonly Machine[], tasks: readonly Task[]): ContinueOffer {
  if (task.state !== "failed" || task.failure?.code !== "session_failed") {
    return { ok: false, reason: "only a task whose session ended in failure can be continued" };
  }
  if (tasks.some((other) => other.spec.continues?.task === task.id && !NOT_CONTINUING.has(other.state))) {
    return { ok: false, reason: "a continuation of it is already underway or finished" };
  }
  if (task.spec.mode === "here") {
    return { ok: false, reason: "a task run in place has no worktree of its own to continue" };
  }
  const { assignment } = task;
  if (assignment === undefined) return { ok: false, reason: "the task was never placed on a machine" };
  const machine = machines.find((m) => m.deviceId === assignment.deviceId);
  if (machine === undefined) return { ok: false, reason: "the machine it ran on is no longer listed" };
  if (machine.capabilities?.includes(CAPABILITIES.continueTask) !== true) {
    return { ok: false, reason: "the machine it ran on can't continue a session yet (needs seanced update)" };
  }
  return { ok: true, at: { deviceId: assignment.deviceId, exclave: assignment.exclave, clone: assignment.clone } };
}

/**
 * The spec of the task that continues `task`. Carries what shapes the session
 * (model, effort, plan, title) and what settles it (`until`, `linear`), and
 * nothing that places or orders it: the target is exact, and the old task's
 * dependents stay failed. The caller stamps `client`.
 */
export function continuationSpec(task: Task, at: Target, prompt?: string): TaskSpec {
  const { spec } = task;
  const note = prompt?.trim();
  return {
    repo: spec.repo,
    mode: "continue",
    ...(note === undefined || note === "" ? {} : { prompt: note }),
    ...(spec.title === undefined ? {} : { title: spec.title }),
    ...(spec.model === undefined ? {} : { model: spec.model }),
    ...(spec.effort === undefined ? {} : { effort: spec.effort }),
    ...(spec.plan === undefined ? {} : { plan: spec.plan }),
    ...(spec.until === undefined ? {} : { until: spec.until }),
    ...(spec.linear === undefined ? {} : { linear: spec.linear }),
    continues: { task: task.id, at },
  };
}
