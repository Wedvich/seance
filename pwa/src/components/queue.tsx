import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Machine } from "@seance/shared";
import { describeDecision } from "../decision-view.ts";
import type { QueueRow, QueueScreenView } from "../queue-view.ts";
import type { ConnectionState } from "../view.ts";
import { DecisionCard } from "./decision.tsx";
import { RelayDot, RelaySettings } from "./relay-dot.tsx";

/** A first tap on a cancel that ends a session arms it this long; no confirm dialog for a thing this quick to take back. */
const ARM_MS = 4_000;

/**
 * Reached from the spawn form's header: what the scheduler holds, by what each
 * task needs from the person, with a way to cancel, mark done, or hold the
 * whole queue. Everything it shows is `deriveQueue`'s; this lays it out.
 */
export function QueueScreen(props: {
  view: QueueScreenView;
  relayState: ConnectionState;
  machines: readonly Machine[];
  now: number;
  /** The last action's refusal or failure, as a sentence. */
  notice: string | null;
  pausing: boolean;
  /** Absent in the desktop layout, where the screen is a column rather than a layer. */
  onDismiss?: () => void;
  onRefresh: () => void;
  onCancel: (taskId: string) => void;
  onMarkDone: (taskId: string) => void;
  onPause: () => void;
  onResume: (account?: string) => void;
  /** Desktop layout only: the queue is the rightmost column, so the settings pill moves to its header. */
  onOpenSettings?: () => void;
}): JSX.Element {
  const { view, relayState, machines, now, notice, pausing, onDismiss, onRefresh, onCancel, onMarkDone } = props;
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  // An act that ends a session asks twice; the key names the act so one button's tap can't arm the other.
  const act = (row: QueueRow, op: "cancel" | "mark-done"): void => {
    const key = `${op}:${row.id}`;
    const endsSession = op === "cancel" ? row.cancelEndsSession : row.markDoneEndsSession;
    if (endsSession && armed !== key) {
      setArmed(key);
      return;
    }
    setArmed(null);
    if (op === "cancel") onCancel(row.id);
    else onMarkDone(row.id);
  };

  return (
    <>
      <header className="header">
        <div className="header-lead">
          {onDismiss !== undefined && (
            <button type="button" className="header-back" onClick={onDismiss} aria-label="Back">
              ‹
            </button>
          )}
          <div>
            <h1 className="header-title">Queue</h1>
            <p className="header-meta header-status">
              <RelayDot state={relayState} />
              {view.status}
            </p>
          </div>
        </div>
        <div className="header-actions">
          <button type="button" className="queue-refresh" onClick={onRefresh} aria-label="Refresh the queue">
            ↻
          </button>
          {props.onOpenSettings !== undefined && <RelaySettings state={relayState} onClick={props.onOpenSettings} />}
        </div>
      </header>

      <div className="fleet">
        {notice !== null && (
          <div className="banner card banner-err" role="alert">
            <span className="banner-rule" />
            <span className="banner-text">
              <span className="banner-body">{notice}</span>
            </span>
          </div>
        )}
        {view.holds.map((hold) => (
          <div key={hold.key} className="banner card">
            <span className="banner-rule" />
            <span className="banner-text">
              <span className="banner-body">{hold.text}</span>
            </span>
            <button
              type="button"
              className="queue-resume"
              disabled={!view.available || pausing}
              onClick={() => props.onResume(hold.account)}
            >
              Resume
            </button>
          </div>
        ))}
        {view.empty !== null && <p className="fleet-empty">{view.empty}</p>}
        {view.sections.map((section) => (
          <section key={section.title} className="queue-section">
            <h2 className="label fleet-heading">{section.title.toUpperCase()}</h2>
            {section.rows.map((row) => (
              <section key={row.id} className="fleet-card card">
                <div className="fleet-card-head">
                  {row.dot !== null && <span className={`dot dot-${row.dot}`} aria-hidden="true" />}
                  <div className="fleet-card-title">
                    <h3 className="fleet-name">{row.title}</h3>
                    <p className="fleet-meta">
                      {row.headline} · {row.age}
                    </p>
                  </div>
                </div>
                {row.body !== null && <p className="fleet-card-body">{row.body}</p>}
                {row.decision !== null && (
                  <details className="queue-why">
                    <summary>{row.decision.tense === "did" ? "Why there" : "Where it would go"}</summary>
                    <DecisionCard
                      summary={describeDecision(row.decision.record, machines, now, row.decision.tense)}
                      title={row.decision.tense === "did" ? "WHY THERE" : "WHERE IT WOULD GO"}
                      quota
                    />
                  </details>
                )}
                {(row.canMarkDone || row.canCancel) && (
                  <div className="queue-actions">
                    {row.canMarkDone && (
                      <button
                        type="button"
                        className="quiet"
                        disabled={!view.available || row.busy}
                        onClick={() => act(row, "mark-done")}
                      >
                        {armed === `mark-done:${row.id}` ? "Tap again to mark done" : "Mark done"}
                      </button>
                    )}
                    {row.canCancel && (
                      <button
                        type="button"
                        className="quiet"
                        disabled={!view.available || row.busy}
                        onClick={() => act(row, "cancel")}
                      >
                        {armed === `cancel:${row.id}` ? "Tap again to cancel" : "Cancel"}
                      </button>
                    )}
                  </div>
                )}
              </section>
            ))}
          </section>
        ))}
        {view.partial !== null && <p className="fleet-note">{view.partial}</p>}
      </div>

      <footer className="footer">
        <button
          type="button"
          className="primary queue-pause"
          disabled={!view.available || pausing}
          onClick={view.paused ? () => props.onResume() : props.onPause}
        >
          {view.paused ? "Resume queue" : "Pause queue"}
        </button>
      </footer>
    </>
  );
}
