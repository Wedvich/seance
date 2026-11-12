import { SPAN_MS, type Exhaustion } from "./route.ts";
import type { SchedulerConfig } from "./config.ts";
import type { Task } from "./task.ts";

/**
 * The automatic quota trigger's dedupe (docs/scheduler.md, Successor, stage 3): pure, so the leader
 * only does the I/O. A stamp on the task (`Task.quotaExhausted`) says which window of which account was
 * acted on, so one window costs one pass attempt (and one retry) or one alert, across terms.
 */
export type QuotaDue = "act" | "retry" | null;

/** Whether a stamp describes the window now exhausted, not an earlier one of the same label. */
function covers(task: Task, ex: Exhaustion, now: number, config: SchedulerConfig): boolean {
  const stamp = task.quotaExhausted;
  if (stamp === undefined || stamp.accountId !== ex.accountId || stamp.window !== ex.window) return false;
  if (ex.reset > 0) return Math.abs(stamp.reset - ex.reset) <= config.resetGraceMs;
  // No reset to key on: the stamp holds for one span of the window, as a spill alert's does.
  return now - stamp.at < (ex.window.startsWith("7d") ? SPAN_MS["7d"] : SPAN_MS["5h"]);
}

/** A task the trigger may act on at all: never a wait, never one that cannot be passed. */
function eligible(task: Task): boolean {
  return (
    task.state === "running" &&
    task.spec.mode !== "here" &&
    task.successor === undefined &&
    task.assignment !== undefined
  );
}

/**
 * What the leader owes `task` this tick: `act` once per window, `retry` once more after
 * `quotaPassRetryMs` when an automatic pass was refused for a reason that can pass. Null for a
 * forecast (no `ex`), an ineligible task, or a window already handled.
 */
export function quotaDue(task: Task, ex: Exhaustion | null, now: number, config: SchedulerConfig): QuotaDue {
  if (ex === null || !eligible(task)) return null;
  if (!covers(task, ex, now, config)) return "act";
  const stamp = task.quotaExhausted;
  return stamp?.retry === true && now - stamp.at >= config.quotaPassRetryMs ? "retry" : null;
}

/**
 * The change function for `#update`: stamps the window, with `retry` only when one more attempt is
 * owed. Null when the task is no longer one the trigger may act on, so a write that lost a race
 * to a state change never stamps (nor alerts) a task that moved.
 */
export function stampQuota(task: Task, ex: Exhaustion, now: number, retry: boolean): Task | null {
  if (!eligible(task)) return null;
  return {
    ...task,
    quotaExhausted: {
      accountId: ex.accountId,
      window: ex.window,
      reset: ex.reset,
      at: now,
      ...(retry ? { retry: true } : {}),
    },
  };
}
