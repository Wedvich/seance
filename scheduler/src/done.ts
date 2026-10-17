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
 * What `entry` adds to the task: a newer PR URL or branch, and `pushed` once
 * true — none of them goes back, so the first report of a pushed branch with a
 * PR releases `after: "opened"` for good.
 */
function news(task: Task, entry: Progress): TaskFields {
  return {
    ...(entry.prUrl === undefined || entry.prUrl === task.prUrl ? {} : { prUrl: entry.prUrl }),
    ...(entry.branch === undefined || entry.branch === task.branch ? {} : { branch: entry.branch }),
    ...(entry.pushed === true && task.pushed !== true ? { pushed: true } : {}),
  };
}

/**
 * Whether a `merged` verdict may be believed. Reap's `Merged` reads a branch
 * with no commits past the default branch as merged (an ancestor), which is
 * every task branch before its first commit; a branch that was pushed or has
 * a PR has work on it, so its merge is one.
 */
function hasWork(task: Task): boolean {
  return task.prUrl !== undefined || task.pushed === true;
}

/**
 * A placed or `awaiting-merge` task with `entry` applied: its fields recorded,
 * and a believed merge making it `done` (`doneBy: "merged"`) — a session still
 * running included, since what it was for has landed. Unchanged (the same
 * object) when `entry` says nothing new.
 */
export function progressed(task: Task, entry: Progress | undefined): Task {
  if (entry === undefined) return task;
  const fields = news(task, entry);
  const next = Object.keys(fields).length === 0 ? task : { ...task, ...fields };
  if (entry.merged === true && hasWork(next)) return advance(next, "done", { doneBy: "merged" });
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
  const added = entry === undefined ? {} : news(view, entry);
  const known: Task = { ...view, ...added };
  const all = { ...fields, ...added };
  if (entry?.merged === true && hasWork(known)) return advance(task, "done", { ...all, doneBy: "merged" });
  if (known.prUrl !== undefined) return advance(task, "awaiting-merge", all);
  return advance(task, "done", { ...all, doneBy: "session" });
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
