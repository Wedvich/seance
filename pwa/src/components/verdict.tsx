import type { JSX } from "preact";
import type { Verdict } from "../state.ts";
import { failureBody } from "../view.ts";

interface Content {
  readonly glyph: string;
  readonly glyphClass: string;
  readonly headline: string;
  readonly body: string;
  readonly detail: string | null;
  readonly primary: { readonly label: string; readonly onClick: "retry" | "another" };
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
  onRetry: () => void;
  onAnother: () => void;
  onBack: () => void;
}): JSX.Element {
  const { verdict, machineName, onRetry, onAnother, onBack } = props;
  const content = describe(verdict, machineName);

  return (
    <div className="verdict" role="status" aria-live="polite">
      <div className={content.glyphClass} aria-hidden="true">
        {content.glyph}
      </div>
      <h2 className="verdict-headline">{content.headline}</h2>
      <p className="verdict-body">{content.body}</p>
      {content.detail !== null && <pre className="verdict-detail card">{content.detail}</pre>}
      <div className="verdict-actions">
        <button type="button" className="primary" onClick={content.primary.onClick === "retry" ? onRetry : onAnother}>
          {content.primary.label}
        </button>
        {verdict.kind === "ok" && (
          <a className="quiet" href="claude://code">
            Open in Claude
          </a>
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
