import type { Machine } from "./app-client.ts";
import { CAPABILITIES, type Target, type Task, type TaskFailureCode, type TaskSpec } from "./types.ts";

export type ContinueOffer =
  | { readonly ok: true; readonly at: Target }
  | { readonly ok: false; readonly reason: string };

/**
 * Failure codes of a continuation that ran in the worktree: it landed, so a session may
 * have written there. A positive list, so a future code, `continue_expired`,
 * `dispatch_unconfirmed`, `queue_expired`, the dependency codes and every daemon refusal
 * default to "did not take over": a false "did not take over" costs one daemon refusal,
 * a false "took over" strands the conversation.
 */
const LANDED_FAILURES: ReadonlySet<string> = new Set<TaskFailureCode>([
  "session_failed",
  "session_closed",
  "lost_expired",
  "merge_expired",
]);

/** The failures whose session can be resumed: it died, or its window was closed from outside. */
const RESUMABLE_FAILURES: ReadonlySet<string> = new Set<TaskFailureCode>(["session_failed", "session_closed"]);

/**
 * Whether continuation `y` holds the session of the task it continues. A queued
 * continuation may still fail unplaced, and cancelling it before it was placed frees the
 * offer; one that landed (placed, running, finished, or failed/cancelled after that)
 * has had the worktree, so the offer moves to it.
 */
function tookOver(y: Task): boolean {
  switch (y.state) {
    case "queued":
    case "blocked":
    case "ready":
      return false;
    case "failed":
      return LANDED_FAILURES.has(y.failure?.code ?? "");
    case "cancelled":
      return y.assignment !== undefined;
    default:
      return true;
  }
}

/**
 * The continuation of `task` still in the queue, among `tasks`, when none has taken over. It does
 * not hold the session (`tookOver`: it may never land), but a second Continue would only race it,
 * so the offer waits on it. A landed taker outranks it, so there is none then. Of several, the
 * oldest: the one the scheduler places first, whatever the list's order. One `QUEUE_MAX_TASKS`
 * left out of the list is invisible here, and the offer stands.
 */
export function waitingContinuation(task: Task, tasks: readonly Task[]): Task | undefined {
  const continuations = tasks.filter((other) => other.spec.continues?.task === task.id);
  if (continuations.some(tookOver)) return undefined;
  let oldest: Task | undefined;
  for (const other of continuations) {
    const waits = other.state === "queued" || other.state === "blocked" || other.state === "ready";
    if (waits && (oldest === undefined || other.createdAt < oldest.createdAt)) oldest = other;
  }
  return oldest;
}

/** The task-level eligibility `continueOffer` applies, so it can tell whether a taker would itself pass it. */
function sessionResumable(task: Task): boolean {
  if (task.state === "cancelled") return task.assignment !== undefined && task.endedAt === undefined;
  return task.state === "failed" && RESUMABLE_FAILURES.has(task.failure?.code ?? "");
}

/**
 * Whether a task's session can be resumed, and where: the one rule the PWA's button,
 * MCP's `continue_task` and `seanced continue` share so they cannot drift (DESIGN.md,
 * Daemon, "Continuing a session"). A task whose session failed (`session_failed`) or
 * whose window was closed from outside (`session_closed`), or
 * that was cancelled after it was placed, qualifies — the others may never have launched,
 * and the daemon's ledger would refuse them anyway. A cancelled task needs a machine
 * advertising `continueCancelled`. And only the newest landed task in a chain holds the
 * offer: `tasks` is the list the caller read it from, and a continuation that landed has
 * the worktree, so a second would only be refused by the daemon. One still waiting withholds
 * it too, until it lands or ends unplaced. Imports nothing that logs, since `seanced mcp`
 * reaches it.
 */
export function continueOffer(task: Task, machines: readonly Machine[], tasks: readonly Task[]): ContinueOffer {
  if (task.state === "cancelled") {
    if (task.assignment === undefined) {
      return { ok: false, reason: "a task cancelled before it started has no session to continue" };
    }
    if (task.endedAt !== undefined) {
      return {
        ok: false,
        reason: "its session had already finished before it was cancelled; use Follow up instead",
      };
    }
  } else if (task.state !== "failed" || !RESUMABLE_FAILURES.has(task.failure?.code ?? "")) {
    return {
      ok: false,
      reason:
        "only a task whose session failed or whose window was closed, or that was cancelled after it started, can be continued",
    };
  }
  const taker = tasks.find((other) => other.spec.continues?.task === task.id && tookOver(other));
  if (taker !== undefined) {
    const finished = taker.state === "failed" || taker.state === "cancelled";
    return {
      ok: false,
      reason: !finished
        ? "a continuation of it is already underway or finished"
        : sessionResumable(taker)
          ? `its session was taken over by task ${taker.id}; continue that one instead`
          : `its session was taken over by task ${taker.id}, which finished, so there is nothing left to continue`,
    };
  }
  const waiting = waitingContinuation(task, tasks);
  if (waiting !== undefined) {
    return { ok: false, reason: `already continuing as task ${waiting.id}, which is still waiting in the queue` };
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
  if (task.state === "cancelled" && machine.capabilities?.includes(CAPABILITIES.continueCancelled) !== true) {
    return {
      ok: false,
      reason: "the machine it ran on can't continue a cancelled session yet (needs seanced update)",
    };
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
