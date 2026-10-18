import type { JSX } from "preact";
import { isRouted, isSettled, type Machine, type Task } from "@seance/shared";
import { describeDecision, taskHeadline } from "../decision-view.ts";
import type { Verdict } from "../state.ts";
import { failedBody, failureBody } from "../view.ts";
import { DecisionCard } from "./decision.tsx";

interface Content {
  readonly glyph: string;
  readonly glyphClass: string;
  readonly headline: string;
  readonly body: string;
  readonly detail: string | null;
  readonly primary: { readonly label: string; readonly onClick: "retry" | "another" | "back" };
  readonly showBack: boolean;
}

/** What the person can do next about a task the scheduler holds, by its state. */
function queuedBody(task: Task): string {
  switch (task.state) {
    case "queued":
      return "It is in the queue. The scheduler picks it up as soon as one is running. Nothing is running yet.";
    case "blocked":
      return "It waits for the tasks it depends on. Nothing is running yet.";
    case "ready":
      return "The scheduler holds it and places it as soon as a machine can take it. Nothing is running yet.";
    case "reserved":
      return "The scheduler picked a machine and is starting the session there.";
    case "running":
    case "needs-input":
      return "Open Claude on your phone and continue the session from there.";
    case "lost":
      return "Its machine stopped answering and the session may still be alive there, so the scheduler starts it nowhere else unless that machine proves it never began. It settles once that machine is back, or is given up on after a week.";
    case "awaiting-merge":
      return "The session ended with a pull request open. Tasks that wait for it to merge stay blocked until it does; the scheduler gives up after a week, and they fail.";
    case "done":
      return "The session ended.";
    case "failed":
      return failedBody(task.failure?.code);
    case "cancelled":
      return task.leftRunning === true
        ? "Its machine was away, so nothing was stopped there. End the session on that machine if it is still running."
        : "Nothing is running.";
  }
}

function describe(
  verdict: Verdict,
  machineName: string,
  machines: readonly Machine[],
  now: number,
  waitingNote: string | null,
): Content {
  if (verdict.kind === "queued") {
    const { task, follow } = verdict;
    const settled = isSettled(task.state);
    const stale =
      follow === undefined
        ? ""
        : follow.kind === "refused"
          ? ` Stopped following it: ${follow.message}`
          : follow.kind === "unanswered"
            ? " The scheduler stopped answering, so this may be out of date."
            : " This screen has stopped checking, so it may have moved on since.";
    return {
      // `lost` is unknown, not failed — the session may still be alive — so it reads like a dropped reply.
      glyph: task.state === "failed" ? "!" : task.state === "lost" ? "?" : settled ? "✓" : "…",
      glyphClass:
        task.state === "failed"
          ? "verdict-glyph verdict-glyph-err"
          : settled && task.state !== "lost"
            ? "verdict-glyph"
            : "verdict-glyph verdict-glyph-muted",
      headline: taskHeadline(task, machines, now),
      // No leader to read it yet: the store holds it, and the note says so instead of promising a pickup.
      body: `${queuedBody(task)}${task.state === "queued" && waitingNote !== null ? ` ${waitingNote}.` : ""}${stale}`,
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
      body: verdict.mayHaveLanded
        ? `${verdict.message} It may have queued anyway — trying again is safe: it re-sends the same task, which can't queue twice.`
        : verdict.message,
      detail: null,
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
    primary: { label: "Start another", onClick: "another" },
    showBack: true,
  };
}

export function VerdictView(props: {
  verdict: Verdict;
  machineName: string;
  machines: readonly Machine[];
  now: number;
  /** True while the exit animation plays; unmount follows via onExited. */
  closing?: boolean;
  onExited?: () => void;
  /** The queued verdict's way to the Queue screen. */
  onQueue: () => void;
  /** `deriveAutoAvailability`'s note: set while no verified scheduler would read a queued task. */
  waitingNote?: string | null;
  onRetry: () => void;
  onAnother: () => void;
  onReuse: () => void;
  onBack: () => void;
}): JSX.Element {
  const { verdict, machineName, machines, now, closing = false, onExited, onRetry, onAnother, onReuse, onBack } = props;
  const content = describe(verdict, machineName, machines, now, props.waitingNote ?? null);
  const decision = verdict.kind === "queued" ? verdict.task.decision : undefined;
  const placed = verdict.kind === "queued" && isRouted(verdict.task.state);
  const onPrimary =
    content.primary.onClick === "retry" ? onRetry : content.primary.onClick === "back" ? onBack : onAnother;

  return (
    <div
      className={closing ? "verdict verdict-closing" : "verdict"}
      role="status"
      aria-live="polite"
      onAnimationEnd={(event) => {
        if (event.animationName === "verdict-out") onExited?.();
      }}
    >
      <div className={content.glyphClass} aria-hidden="true">
        {content.glyph}
      </div>
      <h2 className="verdict-headline">{content.headline}</h2>
      <p className="verdict-body">{content.body}</p>
      {content.detail !== null && <pre className="verdict-detail card">{content.detail}</pre>}
      {decision !== undefined && (
        <DecisionCard
          summary={describeDecision(decision, machines, now, placed ? "did" : "would")}
          title={placed ? "WHY THERE" : "WHERE IT WOULD GO"}
          quota
        />
      )}
      <div className="verdict-actions">
        <button type="button" className="primary" onClick={onPrimary}>
          {content.primary.label}
        </button>
        {verdict.kind === "queued" && (
          <button type="button" className="quiet" onClick={props.onQueue}>
            See the queue
          </button>
        )}
        {verdict.kind === "ok" && verdict.prompt !== undefined && (
          <button type="button" className="quiet" onClick={onReuse}>
            Reuse this prompt
          </button>
        )}
        {content.showBack && (
          <button type="button" className="quiet" onClick={onBack}>
            Back to the form
          </button>
        )}
      </div>
    </div>
  );
}
