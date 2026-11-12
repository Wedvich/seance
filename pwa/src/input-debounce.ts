import type { Task } from "@seance/shared";

/**
 * How long a needs-input stay must stand before the screen puts the task under Needs you. Auto
 * mode's classifier asks settle in seconds and most approved calls run under half a minute, so
 * they never show; Claude Code auto-denies an unanswered prompt after 120 s, so a 2-minute
 * debounce (the push's `needsInputAlertMs`) would hide exactly the waits that matter, and 30 s
 * leaves ~90 s to answer. A long approved call still reaches Needs you, worded "may be waiting".
 * DESIGN.md, "The Queue screen".
 */
export const NEEDS_INPUT_SCREEN_MS = 30_000;

/**
 * How far ahead of the leader's clock a stamp may sit and still be a fresh stay: the skew estimate
 * runs short by the reply's latency. Further ahead is another leader's clock (a handover keeps the
 * record), and waiting out that gap would hide a prompt Claude Code auto-denies in 120 s: show it.
 */
const CLOCK_TOLERANCE_MS = 5_000;

/**
 * A needs-input stay too young to call: not a question (cannot flicker), not already pushed
 * (`inputAlerted`, `escalated`), and with a clock to measure on (an older leader's record has none).
 */
export function settlingInput(task: Task, leaderNow: number): boolean {
  const age = leaderNow - (task.needsInputSince ?? leaderNow);
  return (
    task.state === "needs-input" &&
    task.needsInputSince !== undefined &&
    task.inputReason !== "question" &&
    task.inputAlerted !== true &&
    task.escalated !== true &&
    age < NEEDS_INPUT_SCREEN_MS &&
    age > -CLOCK_TOLERANCE_MS
  );
}

/**
 * The device-clock time the first settling task crosses the threshold, or null when none does:
 * the store re-renders then, since nothing else would.
 */
export function nextReveal(tasks: readonly Task[], now: number, skew: number): number | null {
  const at = tasks
    .filter((t) => settlingInput(t, now + skew))
    .map((t) => (t.needsInputSince ?? 0) + NEEDS_INPUT_SCREEN_MS - skew);
  return at.length === 0 ? null : Math.min(...at);
}
