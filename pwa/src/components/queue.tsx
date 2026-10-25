import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { QueueRow, QueueScreenView } from "../queue-view.ts";
import type { ConnectionState } from "../view.ts";
import { RelaySettings } from "./relay-dot.tsx";

/** A first tap on a cancel that ends a session arms it this long; no confirm dialog for a thing this quick to take back. */
const ARM_MS = 4_000;

/** How long a notification's row stays marked. */
const MARK_MS = 3_000;

/** A task id is a routing id: letters, digits and `._-`, so it is a valid element id as it stands. */
const taskDomId = (taskId: string): string => `task-${taskId}`;

/**
 * Reached from the spawn form's header: what the scheduler holds, by what each
 * task needs from the person, with a way to cancel, mark done, or hold the
 * whole queue. Everything it shows is `deriveQueue`'s; this lays it out.
 */
export function QueueScreen(props: {
  view: QueueScreenView;
  relayState: ConnectionState;
  /** The last action's refusal or failure, as a sentence. */
  notice: string | null;
  pausing: boolean;
  discarding: boolean;
  /** A notification's task: scrolled to and marked once its row is listed. */
  focusedTask: string | null;
  /** The focus was acted on, or the screen closed: the store forgets it. */
  onFocused: () => void;
  /** Absent in the desktop layout, where the screen is a column rather than a layer. */
  onDismiss?: () => void;
  onRefresh: () => void;
  onCancel: (taskId: string) => void;
  onMarkDone: (taskId: string) => void;
  /** Starts a new task that waits on this one: the form opens on `auto` with it in After. */
  onFollowUp: (taskId: string) => void;
  onPause: () => void;
  onResume: (account?: string) => void;
  onDiscard: () => void;
  /** Desktop layout only: the queue is the rightmost column, so the settings pill moves to its header. */
  onOpenSettings?: () => void;
}): JSX.Element {
  const { view, relayState, notice, pausing, onDismiss, onRefresh, onCancel, onMarkDone } = props;
  const [armed, setArmed] = useState<string | null>(null);
  // The row a notification named, marked while it fades; one view, never again on a re-render.
  const [marked, setMarked] = useState<string | null>(null);
  const { focusedTask, onFocused } = props;
  const listed = focusedTask !== null && view.sections.some((s) => s.rows.some((r) => r.id === focusedTask));

  useEffect(() => {
    if (focusedTask === null || !listed) return;
    document.querySelector(`[id="${taskDomId(focusedTask)}"]`)?.scrollIntoView({ block: "center" });
    setMarked(focusedTask);
    onFocused();
  }, [focusedTask, listed, onFocused]);

  useEffect(() => {
    if (marked === null) return;
    const timer = setTimeout(() => setMarked(null), MARK_MS);
    return () => clearTimeout(timer);
  }, [marked]);

  // Leaving with the task never listed (pruned since) must not scroll some later visit.
  useEffect(() => onFocused, [onFocused]);

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

  // Deleting records can't be taken back: the button asks twice, as an act that ends a session does.
  const clear = (): void => {
    if (armed !== "discard") {
      setArmed("discard");
      return;
    }
    setArmed(null);
    props.onDiscard();
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
            {view.summary !== null && <p className="header-meta">{view.summary}</p>}
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
        {view.unreadable !== null && (
          <div className="banner card">
            <span className="banner-rule" />
            <span className="banner-text">
              <span className="banner-body">{view.unreadable}</span>
            </span>
            <button
              type="button"
              className="queue-resume"
              disabled={!view.available || props.discarding}
              onClick={clear}
            >
              {armed === "discard" ? "Tap again to delete" : "Clear"}
            </button>
          </div>
        )}
        {view.empty !== null && <p className="fleet-empty">{view.empty}</p>}
        {view.sections.map((section) => (
          <section key={section.title} className="queue-section">
            <h2 className="label fleet-heading">{section.title.toUpperCase()}</h2>
            {section.rows.map((row) => (
              <section
                key={row.id}
                id={taskDomId(row.id)}
                className={marked === row.id ? "fleet-card card fleet-card-marked" : "fleet-card card"}
              >
                <div className="fleet-card-head">
                  {row.dot !== null && <span className={`dot dot-${row.dot}`} aria-hidden="true" />}
                  <div className="fleet-card-title">
                    <h3 className="fleet-name">
                      {row.session === null ? (
                        row.title
                      ) : (
                        <a
                          className="queue-session"
                          href={row.session}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open the session on claude.ai"
                        >
                          {row.title}
                        </a>
                      )}
                    </h3>
                    <p className="fleet-meta">
                      {row.headline} · {row.age}
                    </p>
                  </div>
                </div>
                {row.deps !== null && <p className="fleet-card-body">{row.deps}</p>}
                {row.batch !== null && <p className="fleet-card-body">{row.batch}</p>}
                {row.body !== null && <p className="fleet-card-body">{row.body}</p>}
                {(row.pr !== null || row.canMarkDone || row.canCancel || row.canFollowUp) && (
                  <div className="queue-actions">
                    {row.pr !== null && (
                      <a
                        className={`fleet-badge queue-pr${row.pr.state === null ? "" : ` queue-pr-${row.pr.state}`}${row.pr.stale ? " queue-pr-stale" : ""}`}
                        href={row.pr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={row.pr.description}
                        aria-label={row.pr.accessibleName}
                      >
                        <PrStateIcon state={row.pr.state} />
                        {row.pr.label}
                        {row.pr.checks !== null && <PrChecksIcon checks={row.pr.checks} />}
                      </a>
                    )}
                    {row.canFollowUp && (
                      <button type="button" className="quiet" onClick={() => props.onFollowUp(row.id)}>
                        Follow up
                      </button>
                    )}
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

/** Same stroke vocabulary as the header's icons; colour comes from the chip's `currentColor`. */
function PrIcon(props: { size: number; className: string; children: ComponentChildren }): JSX.Element {
  return (
    <svg
      className={props.className}
      viewBox="0 0 24 24"
      width={props.size}
      height={props.size}
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

/**
 * GitHub's vocabulary: a pull request, dotted when a draft, merged, or crossed out when closed. No
 * reading is a question mark, not a pull request: a grey one reads as a draft.
 */
function PrStateIcon(props: { state: NonNullable<QueueRow["pr"]>["state"] }): JSX.Element {
  const { state } = props;
  if (state === null) {
    return (
      <PrIcon size={16} className="queue-pr-icon">
        <circle cx="12" cy="12" r="9.5" />
        <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" />
        <circle cx="12" cy="17" r="0.4" fill="currentColor" />
      </PrIcon>
    );
  }
  return (
    <PrIcon size={16} className="queue-pr-icon">
      <circle cx="6" cy="5.5" r="2.5" />
      <circle cx="6" cy="18.5" r="2.5" />
      <path d="M6 8v8" />
      <circle cx="18" cy={state === "merged" ? 13 : 18.5} r="2.5" />
      {state === "merged" && <path d="M6 8v1a4 4 0 0 0 4 4h5.5" />}
      {state === "open" && <path d="M18 16V10a4 4 0 0 0-4-4h-2M14.5 3.5 12 6l2.5 2.5" />}
      {state === "draft" && <path d="M18 15.5V6" stroke-dasharray="0.1 3.4" />}
      {state === "closed" && <path d="M18 16v-3.5M15.5 4.5l5 5M20.5 4.5l-5 5" />}
    </PrIcon>
  );
}

function PrChecksIcon(props: { checks: NonNullable<NonNullable<QueueRow["pr"]>["checks"]> }): JSX.Element {
  const { checks } = props;
  return (
    <PrIcon size={13} className={`queue-pr-ci queue-pr-ci-${checks}`}>
      {checks === "pending" ? (
        <circle cx="12" cy="12" r="4.5" fill="currentColor" />
      ) : (
        <circle cx="12" cy="12" r="9.5" />
      )}
      {checks === "passing" && <path d="M8 12.5l2.8 2.8L16 9.5" />}
      {checks === "failing" && <path d="M9 9l6 6M15 9l-6 6" />}
    </PrIcon>
  );
}
