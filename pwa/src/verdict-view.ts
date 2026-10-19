import { isSettled, TASK_PHASES, type Machine, type Task } from "@seance/shared";
import { queuedBody, taskHeadline } from "./decision-view.ts";
import type { FollowEnd, Verdict } from "./state.ts";
import { failureBody } from "./view.ts";

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

export function describeVerdict(
  verdict: Verdict,
  machineName: string,
  machines: readonly Machine[],
  now: number,
  waitingNote: string | null,
): VerdictContent {
  if (verdict.kind === "queued") {
    const { task } = verdict;
    const settled = isSettled(task.state);
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
      // No leader to read it yet: the store holds it, and the note says so instead of promising a pickup.
      body: `${queuedBody(task)}${task.state === "queued" && waitingNote !== null ? ` ${waitingNote}.` : ""}${followText(verdict.follow)}`,
      detail: task.failure === undefined ? null : `${task.failure.code}\n${task.failure.message}`,
      primary: { label: "Start another", onClick: "another" },
      showBack: true,
    };
  }

  if (verdict.kind === "unqueued") {
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

  if (verdict.kind === "ok" && verdict.pending === true) {
    // The process is up, so this is not a failure — but "It's running" would be
    // a lie about the only thing you came here to learn, and the detail below
    // (the session's screen) is the whole point of the verdict.
    return {
      glyph: "…",
      glyphClass: "verdict-glyph verdict-glyph-muted",
      headline: `It started, but it's stuck on ${machineName}.`,
      body: "Claude hasn't finished starting up — it's most likely waiting on a prompt that only someone at that machine can answer.",
      detail: verdict.note === undefined ? verdict.window : `${verdict.window}\n${verdict.note}`,
      stage: null,
      // No "Start another": a retry meets the same prompt and leaves two stuck windows.
      primary: { label: "Back to the form", onClick: "back" },
      showBack: false,
    };
  }

  if (verdict.kind === "ok") {
    return {
      glyph: "✓",
      glyphClass: "verdict-glyph",
      headline: `It's running on ${machineName}.`,
      body: "Open Claude on your phone and continue the session from there.",
      // A note is non-fatal detail about a spawn that worked — in the shipped
      // daemon, a session that started but never registered, with the screen it
      // is stuck on. Silence would be the wrong default for something a daemon
      // went out of its way to say.
      detail: verdict.note === undefined ? verdict.window : `${verdict.window}\n${verdict.note}`,
      stage: null,
      primary: { label: "Start another", onClick: "another" },
      showBack: false,
    };
  }

  if (verdict.kind === "failed") {
    if (verdict.code === "repo_not_found" && verdict.rescan === "missing") {
      return {
        glyph: "!",
        glyphClass: "verdict-glyph verdict-glyph-err",
        headline: "It didn't take.",
        body: `${verdict.repo} isn't on ${machineName} — a fresh scan doesn't find it either. Pick another repo and try again.`,
        // Not the daemon's message: it ends in "try a rescan", the one thing this
        // verdict has just ruled out. The code alone still carries the record.
        detail: verdict.code,
        stage: null,
        primary: { label: "Back to the form", onClick: "back" },
        showBack: false,
      };
    }
    if (verdict.code === "repo_not_found" && verdict.rescan === "unreachable") {
      return {
        glyph: "!",
        glyphClass: "verdict-glyph verdict-glyph-err",
        headline: "The rescan didn't get through.",
        body: `Couldn't reach ${machineName} to rescan its repos, so ${verdict.repo} wasn't tried again.`,
        detail: `${verdict.code}\n${verdict.message}`,
        stage: null,
        primary: { label: "Rescan and try again", onClick: "retry" },
        showBack: true,
      };
    }
    return {
      glyph: "!",
      glyphClass: "verdict-glyph verdict-glyph-err",
      headline: "It didn't take.",
      body: failureBody(verdict.code, verdict.repo, machineName),
      detail: `${verdict.code}\n${verdict.message}`,
      stage: null,
      primary: {
        label: verdict.code === "repo_not_found" ? "Rescan and try again" : "Try again",
        onClick: "retry",
      },
      showBack: true,
    };
  }

  if (verdict.reason === "undelivered") {
    return {
      glyph: "!",
      glyphClass: "verdict-glyph verdict-glyph-err",
      headline: `It never reached ${verdict.machine}.`,
      body: "The relay had nowhere to deliver it, so nothing was started.",
      detail: null,
      stage: null,
      primary: { label: "Try again", onClick: "retry" },
      showBack: true,
    };
  }

  // Neither success nor failure: the reply was lost, so a session may well be
  // running. Saying "it didn't take" here would be a lie.
  const running =
    verdict.sessionCount === null
      ? `Open Claude to check whether the session on ${verdict.machine} started.`
      : `${verdict.sessionCount} claude ${verdict.sessionCount === 1 ? "session is" : "sessions are"} running on ${verdict.machine} now. Open Claude to see whether yours is one of them.`;
  return {
    glyph: "?",
    glyphClass: "verdict-glyph verdict-glyph-muted",
    headline: "The connection dropped.",
    body: `Séance lost the reply while spawning. ${running}`,
    detail: null,
    stage: null,
    primary: { label: "Start another", onClick: "another" },
    showBack: true,
  };
}
