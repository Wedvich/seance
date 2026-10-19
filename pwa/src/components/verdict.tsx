import type { JSX } from "preact";
import type { Machine } from "@seance/shared";
import { describeDecision, isPlaced } from "../decision-view.ts";
import type { Verdict } from "../state.ts";
import { describeVerdict } from "../verdict-view.ts";
import { DecisionCard } from "./decision.tsx";

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
  const content = describeVerdict(verdict, machineName, machines, now, props.waitingNote ?? null);
  const decision = verdict.kind === "queued" ? verdict.task.decision : undefined;
  const placed = verdict.kind === "queued" && isPlaced(verdict.task);
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
