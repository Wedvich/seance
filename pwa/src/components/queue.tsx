import type { ComponentChildren, JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import {
  ASLEEP_SECTION,
  armKey,
  armTap,
  disarmRow,
  type ArmOp,
  type QueueRow,
  type QueueScreenView,
} from "../queue-view.ts";
import type { ConnectionState } from "../view.ts";
import { Menu, MenuDivider, MenuItem, useMenu, type MenuHandle } from "./menu.tsx";
import { RelaySettings } from "./relay-dot.tsx";

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
  /** The last action's refusal or failure, as a sentence. */
  notice: string | null;
  pausing: boolean;
  discarding: boolean;
  /** Absent in the desktop layout, where the screen is a column rather than a layer. */
  onDismiss?: () => void;
  onRefresh: () => void;
  onCancel: (taskId: string) => void;
  onMarkDone: (taskId: string) => void;
  /** Places a task the concurrency caps alone hold, past them. */
  onRunNow: (taskId: string) => void;
  /** Queues a task that resumes this failed or cancelled one's session in its worktree, on its machine. */
  onContinue: (taskId: string) => void;
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
  // Memory only: persist.ts keeps the spawn form's record, no place for a view's open/closed.
  const [asleepOpen, setAsleepOpen] = useState(false);

  useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const act = (row: QueueRow, op: ArmOp): void => {
    const tap = armTap(row, op, armed);
    setArmed(tap.armed);
    if (!tap.fire) return;
    if (op === "cancel") onCancel(row.id);
    else onMarkDone(row.id);
  };

  // Functional: the popover's toggle lands after a second tap's own update.
  // Stable: QueueCard's unmount cleanup depends on it, and a changing one would disarm every render.
  const onMenuClosed = useCallback((rowId: string): void => setArmed((current) => disarmRow(rowId, current)), []);

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
        {view.sections.map((section) => {
          const collapsible = section.title === ASLEEP_SECTION;
          const shown = !collapsible || asleepOpen;
          return (
            <section key={section.title} className="queue-section">
              {collapsible ? (
                <h2 className="label fleet-heading">
                  <button
                    type="button"
                    className="queue-section-toggle"
                    aria-expanded={asleepOpen}
                    aria-label={`${section.title}, ${section.rows.length} ${section.rows.length === 1 ? "task" : "tasks"}`}
                    onClick={() => setAsleepOpen((open) => !open)}
                  >
                    <span className="disclosure-chevron" aria-hidden="true">
                      ▶
                    </span>
                    {section.title} · {section.rows.length}
                  </button>
                </h2>
              ) : (
                <h2 className="label fleet-heading">{section.title.toUpperCase()}</h2>
              )}
              {shown &&
                section.rows.map((row) => (
                  <QueueCard
                    key={row.id}
                    row={row}
                    available={view.available}
                    armed={armed}
                    onAct={act}
                    onMenuClosed={onMenuClosed}
                    onRunNow={props.onRunNow}
                    onContinue={props.onContinue}
                    onFollowUp={props.onFollowUp}
                  />
                ))}
            </section>
          );
        })}
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

const INLINE_LABEL: Record<NonNullable<QueueRow["inline"]>, string> = {
  continue: "Continue",
  "run-now": "Start now",
};

/**
 * One task: the chip and the likeliest next step (`row.inline`) on the card, every action it
 * allows behind ⋯ — the inline one too, so the menu alone is complete. Its own component because
 * `useMenu` is one per menu.
 */
function QueueCard(props: {
  row: QueueRow;
  available: boolean;
  armed: string | null;
  onAct: (row: QueueRow, op: ArmOp) => void;
  onMenuClosed: (rowId: string) => void;
  onRunNow: (taskId: string) => void;
  onContinue: (taskId: string) => void;
  onFollowUp: (taskId: string) => void;
}): JSX.Element {
  const { row, armed, onAct } = props;
  const { inline } = row;
  const menu = useMenu();
  // Closing by any means — a pick, an outside tap, Escape, back, a scroll — disarms this row.
  const handle: MenuHandle<HTMLButtonElement> = {
    ...menu,
    onToggle: (newState) => {
      menu.onToggle(newState);
      if (newState !== "open") props.onMenuClosed(row.id);
    },
  };
  const disabled = !props.available || row.busy;
  const opens = row.canFollowUp || row.startNow !== null || row.canContinue || row.session !== null;
  const ends = row.canMarkDone || row.canCancel;
  const hasMenu = opens || ends;
  // Removing an open popover fires no `toggle`, so a card that unmounts (a poll moving its task
  // to another section) or drops its menu would leave the row armed for the next open.
  const { onMenuClosed } = props;
  useEffect(() => {
    if (!hasMenu) return;
    return () => onMenuClosed(row.id);
  }, [hasMenu, row.id, onMenuClosed]);
  const run: Record<NonNullable<QueueRow["inline"]>, (taskId: string) => void> = {
    continue: props.onContinue,
    "run-now": props.onRunNow,
  };
  const armItem = (op: ArmOp, label: string, armedLabel: string, icon: JSX.Element, destructive: boolean) => (
    <MenuItem
      label={armed === armKey(op, row.id) ? armedLabel : label}
      icon={icon}
      disabled={disabled}
      destructive={destructive}
      keepOpen={!armTap(row, op, armed).fire}
      onClick={() => onAct(row, op)}
    />
  );

  return (
    <section className="fleet-card card">
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
        {hasMenu && (
          <>
            <button
              ref={menu.anchor}
              type="button"
              className="queue-more"
              popovertarget={menu.id}
              aria-haspopup="menu"
              aria-expanded={menu.open}
              aria-label={`More actions for ${row.title}`}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="19" cy="12" r="1.8" />
              </svg>
            </button>
            <Menu menu={handle} label={`Actions for ${row.title}`}>
              {row.canFollowUp && (
                <MenuItem label="Follow up" icon={<FollowUpIcon />} onClick={() => props.onFollowUp(row.id)} />
              )}
              {row.startNow !== null && (
                <MenuItem
                  label="Start now"
                  icon={<StartNowIcon />}
                  sub={row.startNow.sub}
                  disabled={disabled || !row.startNow.enabled}
                  onClick={() => props.onRunNow(row.id)}
                />
              )}
              {row.canContinue && (
                <MenuItem
                  label="Continue"
                  icon={<ContinueIcon />}
                  disabled={disabled}
                  onClick={() => props.onContinue(row.id)}
                />
              )}
              {row.session !== null && (
                <MenuItem label="Open on claude.ai" icon={<ExternalIcon />} href={row.session} external />
              )}
              {opens && ends && <MenuDivider />}
              {row.canMarkDone && armItem("mark-done", "Mark done", "Tap again to mark done", <CheckIcon />, false)}
              {row.canCancel && armItem("cancel", "Cancel", "Tap again to cancel", <CrossIcon />, true)}
            </Menu>
          </>
        )}
      </div>
      {row.deps !== null && <p className="fleet-card-body">{row.deps}</p>}
      {row.continues !== null && <p className="fleet-card-body">{row.continues}</p>}
      {row.placement !== null && <p className="fleet-card-body">{row.placement}</p>}
      {row.batch !== null && <p className="fleet-card-body">{row.batch}</p>}
      {row.body !== null && <p className="fleet-card-body">{row.body}</p>}
      {(row.pr !== null || inline !== null) && (
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
          {inline !== null && (
            <button type="button" className="quiet" disabled={disabled} onClick={() => run[inline](row.id)}>
              {INLINE_LABEL[inline]}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function MenuGlyph(props: { children: ComponentChildren }): JSX.Element {
  return <StrokeIcon size={18}>{props.children}</StrokeIcon>;
}

function FollowUpIcon(): JSX.Element {
  return (
    <MenuGlyph>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </MenuGlyph>
  );
}

function StartNowIcon(): JSX.Element {
  return (
    <MenuGlyph>
      <path d="M3 6l8 6-8 6z" />
      <path d="M12 6l8 6-8 6z" />
    </MenuGlyph>
  );
}

function ContinueIcon(): JSX.Element {
  return (
    <MenuGlyph>
      <path d="M7 5l12 7-12 7z" />
    </MenuGlyph>
  );
}

function ExternalIcon(): JSX.Element {
  return (
    <MenuGlyph>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </MenuGlyph>
  );
}

function CheckIcon(): JSX.Element {
  return (
    <MenuGlyph>
      <path d="M20 6 9 17l-5-5" />
    </MenuGlyph>
  );
}

function CrossIcon(): JSX.Element {
  return (
    <MenuGlyph>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </MenuGlyph>
  );
}

/** Same stroke vocabulary as the header's icons; colour comes from the parent's `currentColor`. */
function StrokeIcon(props: { size: number; className?: string; children: ComponentChildren }): JSX.Element {
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
      <StrokeIcon size={16} className="queue-pr-icon">
        <circle cx="12" cy="12" r="9.5" />
        <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" />
        <circle cx="12" cy="17" r="0.4" fill="currentColor" />
      </StrokeIcon>
    );
  }
  return (
    <StrokeIcon size={16} className="queue-pr-icon">
      <circle cx="6" cy="5.5" r="2.5" />
      <circle cx="6" cy="18.5" r="2.5" />
      <path d="M6 8v8" />
      <circle cx="18" cy={state === "merged" ? 13 : 18.5} r="2.5" />
      {state === "merged" && <path d="M6 8v1a4 4 0 0 0 4 4h5.5" />}
      {state === "open" && <path d="M18 16V10a4 4 0 0 0-4-4h-2M14.5 3.5 12 6l2.5 2.5" />}
      {state === "draft" && <path d="M18 15.5V6" stroke-dasharray="0.1 3.4" />}
      {state === "closed" && <path d="M18 16v-3.5M15.5 4.5l5 5M20.5 4.5l-5 5" />}
    </StrokeIcon>
  );
}

function PrChecksIcon(props: { checks: NonNullable<NonNullable<QueueRow["pr"]>["checks"]> }): JSX.Element {
  const { checks } = props;
  return (
    <StrokeIcon size={13} className={`queue-pr-ci queue-pr-ci-${checks}`}>
      {checks === "pending" ? (
        <circle cx="12" cy="12" r="4.5" fill="currentColor" />
      ) : (
        <circle cx="12" cy="12" r="9.5" />
      )}
      {checks === "passing" && <path d="M8 12.5l2.8 2.8L16 9.5" />}
      {checks === "failing" && <path d="M9 9l6 6M15 9l-6 6" />}
    </StrokeIcon>
  );
}
