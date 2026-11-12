import {
  isPrReadable,
  primaryPr,
  PR_STATUS_REFRESH_MS,
  prChipFields,
  samePrReading,
  SIGKILL_STATUS,
  TASK_PRS_MAX,
  TASK_PRS_MAX_LENGTH,
  taskPrs,
  readsPrWhileWaiting,
  wantsPrReading,
  type BranchState,
  type PrStatus,
  type TaskPr,
  type TaskProgress,
} from "@seance/shared";
import { advance, PLACED, type Task, type TaskFields } from "./task.ts";

/**
 * Done detection (docs/scheduler.md, "Done detection"): a task's PR and branch
 * as its machine reports them — live (`session-event`, `branch-state`) or read
 * back after a gap (`SessionsResponse.progress`) — and what they make of it.
 * Pure: the scheduler writes what these return.
 */

type Progress = Pick<
  TaskProgress,
  "prUrl" | "branch" | "pushed" | "merged" | "reported" | "exit" | "oomKill" | "vanished"
>;

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

/**
 * `prs` within `TASK_PRS_MAX` and `TASK_PRS_MAX_LENGTH`: the oldest that is not the primary
 * dropped first. Dropping one that is not the primary never changes which is.
 */
function capped(prs: readonly TaskPr[]): readonly TaskPr[] {
  const primary = primaryPr(prs);
  let kept = prs;
  const length = (list: readonly TaskPr[]): number => list.reduce((sum, pr) => sum + pr.url.length, 0);
  while (kept.length > 1 && (kept.length > TASK_PRS_MAX || length(kept) > TASK_PRS_MAX_LENGTH)) {
    const oldest = kept.findIndex((pr) => pr.url !== primary);
    kept = kept.toSpliced(oldest, 1);
  }
  return kept;
}

/**
 * A task's PR fields for `prs`: its primary as `prUrl`, and the list itself only when it says more
 * than that — two or more, or a closed flag. An unwritten list is an explicit `undefined`, so
 * every `{ ...task, ...fields }` merge drops a stale one instead of keeping it beside a new
 * `prUrl`. A lone URL past `TASK_PRS_MAX_LENGTH` is no list either: the parser would refuse it.
 */
function prFields(prs: readonly TaskPr[]): Pick<Task, "prUrl" | "prs"> {
  const prUrl = primaryPr(prs);
  const listed =
    (prs.length > 1 || prs.some((pr) => pr.closed === true)) &&
    prs.reduce((sum, pr) => sum + pr.url.length, 0) <= TASK_PRS_MAX_LENGTH;
  return { ...(prUrl === undefined ? {} : { prUrl }), prs: listed ? prs : undefined };
}

/**
 * The fields a reported PR URL writes: none when the task already holds it — a daemon keeps
 * reporting its newest after the task fell back to an older one (`prChange`), and that must not
 * move it back — else appended to its PRs, which makes it the primary.
 */
export function reportedPr(task: Task, url: string | undefined): TaskFields {
  if (url === undefined) return {};
  const prs = taskPrs(task);
  if (prs.some((pr) => pr.url === url)) return {};
  return prFields(capped([...prs, { url }]));
}

/** Whether `entry` moves the task onto a branch other than the one recorded. */
function switched(task: Task, entry: Progress): boolean {
  return entry.branch !== undefined && task.branch !== undefined && entry.branch !== task.branch;
}

/**
 * `task` with `entry` applied: a new PR URL (`reportedPr`) or branch, and `pushed` once true.
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
    ...reportedPr(base, entry.prUrl),
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
 * (0, or none known) → `done` by `session`, unless its window was closed from
 * outside (`vanished`, no exit known) → `failed` (`session_closed`), which fails its
 * dependents too. The exit counts only there: what
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
  // A pass whose close landed (`Task.successor`): whatever else the end would have made of the task, its
  // work lives on in the successor, which holds the PR. A merge and the session's own report won above.
  if (open.successor !== undefined) return advance(open, "superseded");
  if (open.prUrl !== undefined) return advance(open, "awaiting-merge");
  const exit = seen?.exit;
  if (exit !== undefined && exit !== 0) {
    const missing = settlesOnReport(known) ? "did not report done" : "reported no pull request";
    const message = `its session exited with status ${exit} and ${missing}`;
    // `exit` too, so readers word it without parsing the message (an older one keeps only the message).
    const oom = exit === SIGKILL_STATUS && seen?.oomKill !== undefined ? { oomKill: seen.oomKill } : {};
    return advance(open, "failed", { failure: { code: "session_failed", message, exit, ...oom } });
  }
  if (exit === undefined && seen?.vanished === true) {
    const missing = settlesOnReport(known) ? "did not report done" : "reported no pull request";
    return advance(open, "failed", {
      failure: { code: "session_closed", message: `its window was closed before its session ended and it ${missing}` },
    });
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
 * The leader's forge reading of one of the task's PRs (`taskPrs`; `daemon/src/pr-status.ts`).
 * Each reading sets that PR's `closed` flag (closed iff read `closed`, so a reopen clears it),
 * and the primary (`prUrl`, `primaryPr`) follows: a moved primary is written alone — `prBound`
 * drops the old one's reading, and the poller reads the new one, newest first, in the same poll.
 * A reading for any other PR writes only when its flag changed.
 *
 * The primary's own reading is applied to `task`: recorded as `Task.pr`, and a merge into the default branch settling it
 * `done` by `merged` — a session still running included, so a placed task is
 * marked `leftRunning` as `markDone` marks a `lost` one. A `stacked` merge (into
 * another PR's branch) is recorded and settles nothing: the work is not on the
 * default branch, and a dependent would be released on nothing. Under `until: "reported"` a merge is only recorded
 * (`Task.merged`), as `progressed` does. `closed` is recorded and moves
 * nothing but the primary. Null when it changes nothing: the task finished with a merged
 * reading, waiting or reserved (no session to have opened a PR yet), the URL read not one of its
 * PRs, or an unchanged reading still inside `PR_STATUS_REFRESH_MS`.
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
  if (!wantsPrReading(task)) return null;
  const prs = taskPrs(task);
  const at = prs.findIndex((p) => p.url === prUrl);
  if (at === -1) return null;
  const closed = status.state === "closed";
  const flipped = (prs[at]?.closed === true) !== closed;
  const listed = flipped ? prs.with(at, closed ? { url: prUrl, closed } : { url: prUrl }) : prs;
  const relisted = flipped ? prFields(listed) : {};
  if (primaryPr(listed) !== task.prUrl) {
    const moved = { ...task, ...prFields(listed) };
    // The PR read is the new primary: its reading is the primary's, applied to the moved task.
    return primaryPr(listed) === prUrl ? prChange(prBound(task, moved), prUrl, status) : moved;
  }
  if (prUrl !== task.prUrl) return flipped ? { ...task, ...relisted } : null;
  // The whole reading: the alert and the chip read its head, required checks and merge state.
  const pr: PrStatus = status;
  // A finished task's one reading is for its chip alone: nothing is left for a merge to settle. A waiting
  // successor is the exception: its PR is the one it will continue, and a merge makes it `done` unplaced.
  if (!isPrReadable(task.state) && !readsPrWhileWaiting(task)) {
    return { ...task, ...relisted, pr: prChipFields(pr) };
  }
  const landed = status.state === "merged" && status.stacked !== true;
  const settles = landed && !settlesOnReport(task);
  const marks = landed && settlesOnReport(task) && task.merged !== true;
  // Every field, not three: a new head with the same state must be written, or the alert's dedupe stalls.
  const same = samePrReading(task.pr, status);
  const fresh = task.pr !== undefined && status.at >= task.pr.at && status.at - task.pr.at < PR_STATUS_REFRESH_MS;
  // A merged chip never greys (`PR_STATUS_STALE_MS`), so an unchanged one needs no refresh write.
  const relists = Object.keys(relisted).length > 0;
  if (same && (fresh || status.state === "merged") && !settles && !marks && !relists) return null;
  const recorded: Task = { ...task, ...relisted, pr };
  if (!landed) return recorded;
  if (settlesOnReport(task)) return mergedOpen(recorded);
  // The session is left alive, as for a `branch-state` settle; a placed task says so, as a lost one does.
  const placed = PLACED.includes(task.state);
  // Its own reading is the fresh one `advance` would drop: kept.
  return { ...advance(recorded, "done", { doneBy: "merged", ...(placed ? { leftRunning: true } : {}) }), pr };
}

/**
 * `after` without `pr` when it moved `prUrl` off `before`'s and carried `before`'s reading: a reading speaks
 * only for the URL it was taken for, and `prUrl` changes in several paths
 * (`absorb`, a resumed `progress` entry), so this holds at the write boundary.
 */
export function prBound(before: Task, after: Task): Task {
  // A `pr` the write itself set is for the `prUrl` it moved to (`prChange`): only a carried one is stale.
  if (after.prUrl === before.prUrl || after.pr === undefined || after.pr !== before.pr) return after;
  const { pr: _pr, ...rest } = after;
  return rest;
}
