import type { JSX } from "preact";
import type { Verdict } from "../state.ts";
import { failureBody } from "../view.ts";

interface Content {
  readonly glyph: string;
  readonly glyphClass: string;
  readonly headline: string;
  readonly body: string;
  readonly detail: string | null;
  readonly primary: { readonly label: string; readonly onClick: "retry" | "another" | "back" };
  readonly showBack: boolean;
}

function describe(verdict: Verdict, machineName: string): Content {
  if (verdict.kind === "ok") {
    return {
      glyph: "✓",
      glyphClass: "verdict-glyph",
      headline: `It's running on ${machineName}.`,
      body: "Open Claude on your phone and continue the session from there.",
      // The note is the daemon telling you the worktree isn't based on what you
      // think; silence would be the wrong default.
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
    body: `Séance lost the reply while summoning. ${running}`,
    detail: null,
    primary: { label: "Start another", onClick: "another" },
    showBack: true,
  };
}

export function VerdictView(props: {
  verdict: Verdict;
  machineName: string;
  /** True while the exit animation plays; unmount follows via onExited. */
  closing?: boolean;
  onExited?: () => void;
  onRetry: () => void;
  onAnother: () => void;
  onReuse: () => void;
  onBack: () => void;
}): JSX.Element {
  const { verdict, machineName, closing = false, onExited, onRetry, onAnother, onReuse, onBack } = props;
  const content = describe(verdict, machineName);
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
      <div className="verdict-actions">
        <button type="button" className="primary" onClick={onPrimary}>
          {content.primary.label}
        </button>
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
