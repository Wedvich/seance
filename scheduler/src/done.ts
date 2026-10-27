import {
  isPrReadable,
  PR_STATUS_REFRESH_MS,
  SIGKILL_STATUS,
  wantsPrReading,
  type BranchState,
  type PrStatus,
  type TaskProgress,
} from "@seance/shared";
import { advance, PLACED, type Task, type TaskFields } from "./task.ts";

/**
 * Done detection (docs/scheduler.md, "Done detection"): a task's PR and branch
 * as its machine reports them — live (`session-event`, `branch-state`) or read
 * back after a gap (`SessionsResponse.progress`) — and what they make of it.
 * Pure: the scheduler writes what these return.
 */

type Progress = Pick<TaskProgress, "prUrl" | "branch" | "pushed" | "merged" | "reported" | "exit" | "oomKill">;

/**
 * What `entry` may say of `task`. A `here` task's branch is the checkout's,
 * often the default branch — pushed, and trivially merged — so neither counts:
 * its `opened` comes from its PR, its `merged` only at `done`.
 */
function trusted(task: Task, entry: Progress): Progress {
  if (task.spec.mode !== "here") return entry;
  const { pushed: _pushed, merged: _merged, ...rest } = entry;
  return rest;
}

/** Whether `entry` moves the task onto a branch other than the one recorded. */
function switched(task: Task, entry: Progress): boolean {
  return entry.branch !== undefined && task.branch !== undefined && entry.branch !== task.branch;
}

/**
 * `task` with `entry` applied: a newer PR URL or branch, and `pushed` once true.
 * None goes back within one branch, so the first report of a pushed branch with
 * a PR releases `after: "opened"` for good; a different branch starts unpushed,
 * since the old one's push says nothing of it. The same object when `entry`
 * says nothing new.
 */
function absorb(task: Task, entry: Progress): Task {
  const moved = switched(task, entry);
  const { pushed: _pushed, ...unpushed } = task;
  const base: Task = moved ? unpushed : task;
  const fields: TaskFields = {
    ...(entry.prUrl === undefined || entry.prUrl === base.prUrl ? {} : { prUrl: entry.prUrl }),
    ...(entry.branch === undefined || entry.branch === base.branch ? {} : { branch: entry.branch }),
    ...(entry.pushed === true && base.pushed !== true ? { pushed: true } : {}),
  };
  return moved || Object.keys(fields).length > 0 ? { ...base, ...fields } : task;
}

/**
 * Whether a `merged` verdict may be believed: only of a branch seen pushed.
 * Reap's `Merged` reads a branch with no commits past the default branch as
 * merged (an ancestor), which is every task branch before its first commit; a
 * pushed one has work on it. `pushed` is per branch (`absorb`) and stays true
 * once seen, so a remote branch deleted after its merge still reads as pushed on
 * takeover. A PR URL is no evidence: it is not tied to a branch, so after a
 * switch it is the old branch's.
 */
function hasWork(after: Task): boolean {
  return after.pushed === true;
}

/** `until: "reported"` (#21): a merge settles nothing there; the session's report, or its exit, does. */
function settlesOnReport(task: Task): boolean {
  return task.spec.until === "reported";
}

/** A believed merge recorded on a task it does not settle; the same object when already recorded. */
function mergedOpen(task: Task): Task {
  return task.merged === true ? task : { ...task, merged: true };
}

/**
 * A placed or `awaiting-merge` task with `entry` applied: its fields recorded,
 * and a believed merge making it `done` (`doneBy: "merged"`) — a session still
 * running included, since what it was for has landed. Under `until: "reported"`
 * a merge is only recorded (`Task.merged`), and the session's report
 * (`entry.reported`) settles it `done` by `reported`; a report under
 * `until: "merged"` is ignored. Unchanged (the same object) when `entry` says
 * nothing new.
 */
export function progressed(task: Task, entry: Progress | undefined): Task {
  if (entry === undefined) return task;
  const seen = trusted(task, entry);
  const next = absorb(task, seen);
  const merged = seen.merged === true && hasWork(next);
  if (!settlesOnReport(next)) return merged ? advance(next, "done", { doneBy: "merged" }) : next;
  const settleable = PLACED.includes(next.state) || next.state === "awaiting-merge";
  if (seen.reported === true && settleable) return advance(next, "done", { doneBy: "reported" });
  return merged ? mergedOpen(next) : next;
}

/**
 * A task whose session ended, with `fields` (the event's or the answer's) and
 * the machine's `progress` entry, if any: merged → `done` by `merged`; a PR
 * open → `awaiting-merge`, which frees its slot and keeps `after: "merged"`
 * dependents waiting; neither, and a nonzero exit → `failed`
 * (`session_failed`), which fails its dependents; neither and no such exit
 * (0, or none known) → `done` by `session`. The exit counts only there: what
 * a merge or a PR shows landed stands however the session ended. Under
 * `until: "reported"` the session's report comes first (`done` by `reported`),
 * and a merge is recorded and falls through to the PR check instead of
 * settling; a PR-less exit still settles as above, since a lying report can do
 * no more than exiting can.
 */
export function ended(task: Task, entry: Progress | undefined, fields: TaskFields = {}): Task {
  const view: Task = { ...task, ...fields };
  const seen = entry === undefined ? undefined : trusted(view, entry);
  const known = seen === undefined ? view : absorb(view, seen);
  if (settlesOnReport(known) && seen?.reported === true) return advance(known, "done", { doneBy: "reported" });
  const merged = seen?.merged === true && hasWork(known);
  if (merged && !settlesOnReport(known)) return advance(known, "done", { doneBy: "merged" });
  const open = merged ? mergedOpen(known) : known;
  if (open.prUrl !== undefined) return advance(open, "awaiting-merge");
  const exit = seen?.exit;
  if (exit !== undefined && exit !== 0) {
    const missing = settlesOnReport(known) ? "did not report done" : "reported no pull request";
    const message = `its session exited with status ${exit} and ${missing}`;
    // `exit` too, so readers word it without parsing the message (an older one keeps only the message).
    const oom = exit === SIGKILL_STATUS && seen?.oomKill !== undefined ? { oomKill: seen.oomKill } : {};
    return advance(open, "failed", { failure: { code: "session_failed", message, exit, ...oom } });
  }
  return advance(open, "done", { doneBy: "session" });
}

/**
 * A live `branch-state`, from the machine that sealed it (`from`). Only the
 * machine the task was placed on may move it, as for a session event; a
 * reservation is left to its verdict. A merge settles it as `progressed` says.
 */
export function branchChange(task: Task, state: BranchState, from: string): Task | null {
  if (task.state !== "awaiting-merge" && !PLACED.includes(task.state)) return null;
  if (task.assignment?.deviceId !== from) return null;
  const next = progressed(task, {
    branch: state.branch,
    ...(state.pushed ? { pushed: true } : {}),
    ...(state.merged ? { merged: true } : {}),
  });
  return next === task ? null : next;
}

/**
 * The leader's forge reading of `prUrl` (`daemon/src/pr-status.ts`), applied to
 * `task`: recorded as `Task.pr`, and a merge into the default branch settling it
 * `done` by `merged` — a session still running included, so a placed task is
 * marked `leftRunning` as `markDone` marks a `lost` one. A `stacked` merge (into
 * another PR's branch) is recorded and settles nothing: the work is not on the
 * default branch, and a dependent would be released on nothing. Under `until: "reported"` a merge is only recorded
 * (`Task.merged`), as `progressed` does. `closed` is recorded and moves
 * nothing. Null when it changes nothing: the task finished, waiting or
 * reserved (no session to have opened a PR yet), `prUrl` no longer the one read,
 * or an unchanged reading still inside `PR_STATUS_REFRESH_MS`.
 *
 * No `trusted`/`hasWork`/branch gate, unlike `progressed`: the forge answers
 * for the exact PR the session reported, so a `here` task settles too, and
 * /ship opens PRs from branches it creates by hand, so the recorded `branch`
 * cannot be required to match the PR's head. The cost is that `absorb` keeps
 * `prUrl` across a branch switch (DESIGN.md, "PR status").
 *
 * No ordering check on `status.at` against the stored one: within a term the
 * poller never overlaps, `#update` is serialised per task, and an ended term's
 * write is refused by the term fence, so it would only compare two leaders'
 * clocks — which drift — and could block a merge for good. A reading behind the
 * stored `at` just counts as not fresh.
 */
export function prChange(task: Task, prUrl: string, status: PrStatus): Task | null {
  if (task.prUrl !== prUrl) return null;
  if (!wantsPrReading(task)) return null;
  const pr: PrStatus = {
    state: status.state,
    ...(status.checks === undefined ? {} : { checks: status.checks }),
    ...(status.stacked === undefined ? {} : { stacked: status.stacked }),
    at: status.at,
  };
  // A finished task's one reading is for its chip alone: nothing is left for a merge to settle.
  if (!isPrReadable(task.state)) return { ...task, pr };
  const landed = status.state === "merged" && status.stacked !== true;
  const settles = landed && !settlesOnReport(task);
  const marks = landed && settlesOnReport(task) && task.merged !== true;
  const same =
    task.pr?.state === status.state && task.pr?.checks === status.checks && task.pr?.stacked === status.stacked;
  const fresh = task.pr !== undefined && status.at >= task.pr.at && status.at - task.pr.at < PR_STATUS_REFRESH_MS;
  // A merged chip never greys (`PR_STATUS_STALE_MS`), so an unchanged one needs no refresh write.
  if (same && (fresh || status.state === "merged") && !settles && !marks) return null;
  const recorded: Task = { ...task, pr };
  if (!landed) return recorded;
  if (settlesOnReport(task)) return mergedOpen(recorded);
  // The session is left alive, as for a `branch-state` settle; a placed task says so, as a lost one does.
  const placed = PLACED.includes(task.state);
  // Its own reading is the fresh one `advance` would drop: kept.
  return { ...advance(recorded, "done", { doneBy: "merged", ...(placed ? { leftRunning: true } : {}) }), pr };
}

/**
 * `after` without `pr` when it moved `prUrl` off `before`'s: a reading speaks
 * only for the URL it was taken for, and `prUrl` changes in several paths
 * (`absorb`, a resumed `progress` entry), so this holds at the write boundary.
 */
export function prBound(before: Task, after: Task): Task {
  if (after.prUrl === before.prUrl || after.pr === undefined) return after;
  const { pr: _pr, ...rest } = after;
  return rest;
}
