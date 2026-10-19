import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Machine } from "@seance/shared";
import type { Verdict } from "../state.ts";
import { describeVerdict, VERDICT_STAGES, type VerdictStage } from "../verdict-view.ts";

/**
 * Three beads for a queued task's way to a session. Beads behind the reached
 * one are filled, the reached one pulses while it is a wait, and the last is
 * a plain fill: running is an arrival, not a wait. The connector before a
 * bead fills as it is reached, so each step is a motion, not a repaint.
 */
function StageTrack(props: { stage: VerdictStage }): JSX.Element {
  const { reached } = props.stage;
  const label =
    reached === 2 ? "Running" : `${VERDICT_STAGES[reached]}, step ${reached + 1} of ${VERDICT_STAGES.length}`;
  // The bead that just stopped waiting keeps its ring until the ring's current
  // cycle ends: cut mid-swell it would vanish at full size. The next bead's
  // ring starts at once; only the old one is let finish. Decided in render,
  // not an effect, so the ring is the same element across the step and its
  // animation runs on rather than restarting.
  const previous = useRef(reached);
  const finishing = useRef<number | null>(null);
  const [, rerender] = useState(0);
  if (previous.current !== reached) {
    finishing.current = previous.current < 2 ? previous.current : null;
    previous.current = reached;
  }
  const finished = (): void => {
    finishing.current = null;
    rerender((n) => n + 1);
  };
  useEffect(() => {
    if (finishing.current === null) return;
    // Backstop for a lost animationiteration: one full cycle.
    const timer = setTimeout(finished, 1600);
    return () => clearTimeout(timer);
  }, [reached]);
  return (
    <ol className="stage-track" aria-label={label}>
      {VERDICT_STAGES.map((name, i) => {
        const state = i < reached ? "done" : i === reached ? (i === 2 ? "done" : "now") : "next";
        const ringing = state === "now" || finishing.current === i;
        return (
          <li key={name} className={`stage-bead stage-bead-${state}`} aria-current={i === reached ? "step" : undefined}>
            {i > 0 && <span className="stage-link" aria-hidden="true" />}
            <span className="stage-dot" aria-hidden="true">
              {ringing && (
                <span
                  className="stage-sonar"
                  onAnimationIteration={() => {
                    if (finishing.current === i) finished();
                  }}
                />
              )}
              {/* Keyed on the mark so a change replays its entrance; the tick's is a pop, the ellipsis's a fade. */}
              {state === "done" && (
                <span key="done" className="stage-mark stage-mark-done">
                  ✓
                </span>
              )}
              {state === "now" && (
                <span key="now" className="stage-mark stage-mark-wait">
                  ⋯
                </span>
              )}
            </span>
            <span className="stage-name">{name}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Text that slides when it changes: the outgoing line stays stacked under the
 * new one until its exit animation ends, so a state change reads as one line
 * giving way to the next rather than text swapping in place. The first text
 * lands with the verdict's own entrance; only a change slides.
 */
function SwapText(props: { as: "h2" | "p"; className: string; text: string }): JSX.Element {
  const { as: Tag, className, text } = props;
  // Decided in render, as StageTrack does: an effect would paint the new stage
  // under the old line for a frame. `swapped` stays true: dropping the slide-in
  // class afterwards would replay the entrance animation.
  const previous = useRef(text);
  const leaving = useRef<string | null>(null);
  const swapped = useRef(false);
  const [, rerender] = useState(0);
  if (previous.current !== text) {
    leaving.current = previous.current;
    previous.current = text;
    swapped.current = true;
  }
  const onLeft = (): void => {
    if (leaving.current === null) return;
    leaving.current = null;
    rerender((n) => n + 1);
  };
  useEffect(() => {
    if (leaving.current === null) return;
    // Backstop for a lost animationend, as the sheets do.
    const timer = setTimeout(onLeft, 400);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <div className="swap-stack">
      {leaving.current !== null && (
        <Tag
          key={`out:${leaving.current}`}
          className={`${className} swap-out`}
          aria-hidden="true"
          onAnimationEnd={onLeft}
        >
          {leaving.current}
        </Tag>
      )}
      <Tag key={`in:${text}`} className={swapped.current ? `${className} swap-in` : className}>
        {text}
      </Tag>
    </div>
  );
}

export function VerdictView(props: {
  verdict: Verdict;
  machineName: string;
  machines: readonly Machine[];
  now: number;
  /** The queued verdict's way to the Queue screen. */
  onQueue: () => void;
  /** `deriveAutoAvailability`'s note: set while no verified scheduler would read a queued task. */
  waitingNote?: string | null;
  onRetry: () => void;
  onAnother: () => void;
  onReuse: () => void;
  onBack: () => void;
}): JSX.Element {
  const { verdict, machineName, machines, now, onRetry, onAnother, onReuse, onBack } = props;
  const content = describeVerdict(verdict, machineName, machines, now, props.waitingNote ?? null);
  const onPrimary =
    content.primary.onClick === "retry" ? onRetry : content.primary.onClick === "back" ? onBack : onAnother;

  return (
    <div className="verdict" role="status" aria-live="polite">
      {content.stage === null ? (
        <div key="glyph" className={content.glyphClass} aria-hidden="true">
          {content.glyph}
        </div>
      ) : (
        <StageTrack key="track" stage={content.stage} />
      )}
      <SwapText as="h2" className="verdict-headline" text={content.headline} />
      <SwapText as="p" className="verdict-body" text={content.body} />
      {content.detail !== null && <pre className="verdict-detail card">{content.detail}</pre>}
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
