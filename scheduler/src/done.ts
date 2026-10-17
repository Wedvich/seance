import type { BranchState, TaskProgress } from "@seance/shared";
import { advance, PLACED, type Task, type TaskFields } from "./task.ts";

/**
 * Done detection (docs/scheduler.md, "Done detection"): a task's PR and branch
 * as its machine reports them — live (`session-event`, `branch-state`) or read
 * back after a gap (`SessionsResponse.progress`) — and what they make of it.
 * Pure: the scheduler writes what these return.
 */

type Progress = Pick<TaskProgress, "prUrl" | "branch" | "pushed" | "merged">;

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
 * Whether a `merged` verdict may be believed. Reap's `Merged` reads a branch
 * with no commits past the default branch as merged (an ancestor), which is
 * every task branch before its first commit; one pushed has work on it, so its
 * merge is one. A PR URL is not tied to a branch, so after a branch switch only
 * a PR this entry brought counts, never the old branch's.
 */
function hasWork(before: Task, after: Task, entry: Progress): boolean {
  if (after.pushed === true) return true;
  if (!switched(before, entry)) return after.prUrl !== undefined;
  return entry.prUrl !== undefined && entry.prUrl !== before.prUrl;
}

/**
 * A placed or `awaiting-merge` task with `entry` applied: its fields recorded,
 * and a believed merge making it `done` (`doneBy: "merged"`) — a session still
 * running included, since what it was for has landed. Unchanged (the same
 * object) when `entry` says nothing new.
 */
export function progressed(task: Task, entry: Progress | undefined): Task {
  if (entry === undefined) return task;
  const seen = trusted(task, entry);
  const next = absorb(task, seen);
  if (seen.merged === true && hasWork(task, next, seen)) return advance(next, "done", { doneBy: "merged" });
  return next;
}

/**
 * A task whose session ended, with `fields` (the event's or the answer's) and
 * the machine's `progress` entry, if any: merged → `done` by `merged`; a PR
 * open → `awaiting-merge`, which frees its slot and keeps `after: "merged"`
 * dependents waiting; neither → `done` by `session`.
 */
export function ended(task: Task, entry: Progress | undefined, fields: TaskFields = {}): Task {
  const view: Task = { ...task, ...fields };
  const seen = entry === undefined ? undefined : trusted(view, entry);
  const known = seen === undefined ? view : absorb(view, seen);
  if (seen?.merged === true && hasWork(view, known, seen)) return advance(known, "done", { doneBy: "merged" });
  if (known.prUrl !== undefined) return advance(known, "awaiting-merge");
  return advance(known, "done", { doneBy: "session" });
}

/**
 * A live `branch-state`, from the machine that sealed it (`from`). Only the
 * machine the task was placed on may move it, as for a session event; a
 * reservation is left to its verdict.
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
