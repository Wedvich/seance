import { isSettled, TASK_PHASES, type Machine, type Task } from "@seance/shared";
import { pinLine, queuedBody, taskHeadline, waitingText } from "./decision-view.ts";
import type { FollowEnd, Verdict } from "./state.ts";

/**
 * The verdict screen as data, derived in one pure pass like `deriveView`, so
 * what each outcome says is testable without a DOM; the component only lays
 * it out.
 */

export interface VerdictContent {
  readonly glyph: string;
  readonly glyphClass: string;
  /**
   * A queued task's way to a session as beads, in place of the glyph: how far
   * it has come. Null once it has settled — an outcome is a glyph, not a stage.
   */
  readonly stage: VerdictStage | null;
  readonly headline: string;
  readonly body: string;
  readonly detail: string | null;
  readonly primary: { readonly label: string; readonly onClick: "retry" | "another" | "back" };
  readonly showBack: boolean;
}

/** The three beads, in order; `reached` indexes the one the task stands on. */
export const VERDICT_STAGES = ["Queued", "Placed", "Running"] as const;

export interface VerdictStage {
  readonly reached: 0 | 1 | 2;
}

function stageOf(task: Task): VerdictStage | null {
  const phase = TASK_PHASES[task.state];
  // `lost` is placed by phase but unknown in fact: a question mark, not a third bead.
  if (task.state === "lost" || phase === "ended" || phase === "finished") return null;
  return { reached: phase === "waiting" ? 0 : phase === "dispatching" ? 1 : 2 };
}

/** What a follow that ended before the task settled adds to the body, as a sentence after it. */
function followText(follow: FollowEnd | undefined): string {
  if (follow === undefined) return "";
  switch (follow.kind) {
    case "refused":
      return ` Stopped following it: ${follow.message}`;
    case "gone":
      return " Stopped following it: it is no longer in the queue.";
    case "unlisted":
      return " It is still in the queue, but the scheduler's answers leave it out, so this may be out of date.";
    case "unanswered":
      return " The scheduler stopped answering, so this may be out of date.";
    case "stopped":
      return " This screen has stopped checking, so it may have moved on since.";
  }
}

/** A pinned machine that is offline: nothing is wrong, the task waits for it (as `resolvePlacement` notes). */
function offlinePinNote(task: Task, machines: readonly Machine[]): string | null {
  if (TASK_PHASES[task.state] !== "waiting") return null;
  const machine = machines.find((m) => m.deviceId === task.spec.pin?.deviceId);
  return machine === undefined || machine.connected ? null : `${machine.name} is offline — the task waits for it.`;
}

export function describeVerdict(
  verdict: Verdict,
  machines: readonly Machine[],
  aliases: Readonly<Record<string, string>>,
  now: number,
  waitingNote: string | null,
): VerdictContent {
  if (verdict.kind === "queued") {
    const { task } = verdict;
    const settled = isSettled(task.state);
    const pin = pinLine(task, machines, aliases);
    const waiting = waitingText(task);
    const parts = [
      queuedBody(task),
      pin === null ? null : `${pin}.`,
      waiting === null ? null : `Waiting: ${waiting}.`,
      offlinePinNote(task, machines),
      // No leader to read it yet: the store holds it, and the note says so instead of promising a pickup.
      task.state === "queued" && waitingNote !== null ? `${waitingNote}.` : null,
    ].filter((part) => part !== null);
    return {
      // `lost` is unknown, not failed — the session may still be alive — so it reads like a dropped reply.
      glyph: task.state === "failed" ? "!" : task.state === "lost" ? "?" : settled ? "✓" : "…",
      glyphClass:
        task.state === "failed"
          ? "verdict-glyph verdict-glyph-err"
          : settled && task.state !== "lost"
            ? "verdict-glyph"
            : "verdict-glyph verdict-glyph-muted",
      stage: stageOf(task),
      headline: taskHeadline(task, machines, now),
      body: `${parts.join(" ")}${followText(verdict.follow)}`,
      detail: task.failure === undefined ? null : `${task.failure.code}\n${task.failure.message}`,
      primary: { label: "Start another", onClick: "another" },
      showBack: true,
    };
  }

  return {
    glyph: verdict.mayHaveLanded ? "?" : "!",
    glyphClass: verdict.mayHaveLanded ? "verdict-glyph verdict-glyph-muted" : "verdict-glyph verdict-glyph-err",
    headline: verdict.mayHaveLanded ? "The relay's answer was lost." : "It wasn't queued.",
    // `message` says why the answer was lost, never that it may have queued: this is the one place that does.
    body: verdict.mayHaveLanded
      ? `${verdict.message} It may have queued anyway — trying again is safe: it re-sends the same task, which can't queue twice.`
      : verdict.message,
    detail: null,
    stage: null,
    primary:
      verdict.retry === undefined
        ? { label: "Back to the form", onClick: "back" }
        : { label: "Try again", onClick: "retry" },
    showBack: verdict.retry !== undefined,
  };
}
