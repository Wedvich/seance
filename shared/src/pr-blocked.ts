import type { PrBlockedReason, PrStatus, Task } from "./types.ts";

/**
 * Why an open PR is stuck, or null. The first of these that holds: a merge conflict, a failing
 * required check, a branch behind its base, or `unarmed`: its required checks all passed and it
 * could merge, but nothing will merge it (no auto-merge or queue, no review asked for). A repo whose
 * head has no required check never reads `unarmed`; `BLOCKED` never does either, since something
 * else (a review, a missing check) is holding it. One rule for the scheduler (the alert), the PWA
 * (the chip and Continue) and MCP, so they cannot drift. Imports nothing that logs, since
 * `seanced mcp` reaches it.
 */
export function prBlocked(pr: PrStatus | undefined): PrBlockedReason | null {
  if (pr === undefined || pr.state !== "open") return null;
  if (pr.merge === "dirty") return "conflict";
  if (pr.required === "failing") return "checks";
  if (pr.merge === "behind") return "behind";
  const mergeable = pr.merge === "clean" || pr.merge === "has_hooks" || pr.merge === "unstable";
  if (pr.required === "passing" && mergeable && pr.armed !== true && pr.reviewRequested !== true) return "unarmed";
  return null;
}

/**
 * `prBlocked` of a task that waits on its PR's merge: `awaiting-merge` and not `until: "reported"`.
 * An `until: "reported"` task waits on its session's own report, which no Continue brief asks for
 * and which `hand_off_task` excludes, so it neither alerts nor is offered. Every surface reads
 * this, never `prBlocked` on a task directly.
 */
export function taskPrBlock(task: Pick<Task, "state" | "spec" | "pr">): PrBlockedReason | null {
  if (task.state !== "awaiting-merge" || task.spec.until === "reported") return null;
  return prBlocked(task.pr);
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/** Whether two readings say the same, `at` aside: what decides a stored reading needs rewriting. */
export function samePrReading(a: PrStatus | undefined, b: PrStatus): boolean {
  if (a === undefined) return false;
  return (
    a.state === b.state &&
    a.checks === b.checks &&
    a.stacked === b.stacked &&
    a.head === b.head &&
    a.required === b.required &&
    sameList(a.failing, b.failing) &&
    a.merge === b.merge &&
    a.armed === b.armed &&
    a.reviewRequested === b.reviewRequested
  );
}

/** A reading cut to what a chip shows, for a task the wide read does not cover (a finished one). */
export function prChipFields(pr: PrStatus): PrStatus {
  return {
    state: pr.state,
    ...(pr.checks === undefined ? {} : { checks: pr.checks }),
    ...(pr.stacked === undefined ? {} : { stacked: pr.stacked }),
    at: pr.at,
  };
}

const BLOCKED_SENTENCE: Record<PrBlockedReason, string> = {
  checks: "a required check failed on its head commit",
  conflict: "it has merge conflicts with its base branch",
  behind: "its branch is behind its base branch, which this repo requires to be up to date",
  unarmed:
    "its required checks passed but nothing will merge it: no auto-merge is armed and no review is requested. If this repo merges with auto-merge, arm it (gh pr merge --auto with the repo's merge method); otherwise say so and leave it for the user",
};

/**
 * What a continuation of a blocked `awaiting-merge` task opens with: fixed text, the PR URL (`https:`-checked
 * at parse), the reason and the failing check names (bounded and cleaned by `PR_FAILING_LIMITS`), never logs;
 * the session reads the rest with `gh`. It is in the record and the prompt, and the user's own note follows it.
 */
export function blockedBrief(task: Task, reason: PrBlockedReason): string {
  const failing = task.pr?.failing;
  return [
    `Its pull request ${task.prUrl ?? "(unknown)"} is blocked: ${BLOCKED_SENTENCE[reason]}.`,
    ...(failing === undefined || failing.length === 0 ? [] : [`Failing required checks: ${failing.join(", ")}.`]),
    "Read the PR's state with gh (gh pr view, gh pr checks, gh run view --log-failed), fix what blocks it in this worktree, and push to the same branch; do not open a new pull request. Once it is pushed and whatever merges it is in place, call hand_off_task as your last tool call.",
  ].join("\n");
}
