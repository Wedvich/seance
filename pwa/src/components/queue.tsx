import { displayLine, FLEET_LIMIT_MAX, TAG_VALUE_MAX, TASK_REQUEST_LIMITS } from "@seance/shared";
import type { ComponentChildren, JSX } from "preact";
import { useCallback, useEffect, useId, useRef, useState } from "preact/hooks";
import type { SessionRow, SessionTagGroup } from "../machines-view.ts";
import {
  ASLEEP_SECTION,
  armKey,
  armTap,
  disarmRow,
  parseLimitDraft,
  type ArmOp,
  type CloseTarget,
  type LimitView,
  type LineageLine,
  type QueueRow,
  type QueueScreenView,
  type SessionQueueRow,
} from "../queue-view.ts";
import { OLDER_TITLE, type OlderSheetView, type OlderView } from "../older-view.ts";
import { centeredScrollTop } from "../scroll.ts";
import type { LabellingState, OlderPick, OlderSheet } from "../state.ts";
import { StrokeIcon } from "./icons.tsx";
import { Menu, MenuDivider, MenuItem, MoreTrigger, useMenu, type MenuHandle } from "./menu.tsx";
import { Sheet, SheetItem, TileButton, useSheetExit } from "./sheet.tsx";
import { Toast } from "./toast.tsx";
import { Time, TimedText } from "./timed.tsx";

/** The Older section's acts, all the store's (`OlderStore`). */
export interface OlderActions {
  readonly toggle: () => void;
  readonly search: (title: string) => void;
  readonly openSheet: (sheet: OlderSheet) => void;
  readonly closeSheet: () => void;
  readonly pick: (pick: OlderPick) => void;
  readonly clear: () => void;
  readonly loadMore: () => void;
}

/** A first tap on a cancel that ends a session arms it this long; no confirm dialog for a thing this quick to take back. */
const ARM_MS = 4_000;

/** How long a notification's row stays marked. */
const MARK_MS = 3_000;

/** The Queue's title block; the app puts it in a header (the phone's fixed one, or the desk column's). */
export function QueueHeading(props: {
  summary: string | null;
  /** Opens the Limits sheet; null while there is no limit to change, and the line is then plain text. */
  onLimits: (() => void) | null;
}): JSX.Element {
  const { summary, onLimits } = props;
  return (
    <div>
      <h1 className="header-title">Queue</h1>
      {summary !== null &&
        (onLimits === null ? (
          <p className="header-meta">{summary}</p>
        ) : (
          <button type="button" className="header-meta header-meta-button" aria-haspopup="dialog" onClick={onLimits}>
            <span className="sr-only">Session limit: </span>
            {summary}
            <StrokeIcon size={12}>
              <path d="M6 9l6 6 6-6" />
            </StrokeIcon>
          </button>
        ))}
    </div>
  );
}

/**
 * The fleet limit: how many sessions the queue runs at once, across every machine and account.
 * An empty field is no limit, the default. A form, so Enter saves.
 */
/** The owner's label for one task: a form like the account rename, staying open on a refusal with the reason. */
function LabelDialog(props: {
  title: string;
  initial: string;
  saving: boolean;
  notice: string | null;
  onSave: (text: string) => void;
  onClose: () => void;
}): JSX.Element {
  const { title, initial, saving, notice, onSave, onClose } = props;
  const [draft, setDraft] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const noticeId = useId();
  // An effect, not a layout effect: `Sheet` focuses its panel in one, after its children's.
  useEffect(() => {
    if (!saving) input.current?.focus();
  }, [saving]);
  const max = TASK_REQUEST_LIMITS.title;
  return (
    <Sheet title="Label task" variant="dialog" onClose={onClose}>
      <form
        className="rename"
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving) onSave(draft);
        }}
      >
        <p className="rename-account">{title}</p>
        <label className="rename-label" htmlFor={inputId}>
          Label
        </label>
        <input
          ref={input}
          id={inputId}
          type="text"
          className="rename-input"
          placeholder="Name this task"
          maxLength={max}
          value={draft}
          disabled={saving}
          aria-invalid={notice !== null}
          aria-describedby={notice === null ? undefined : noticeId}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        {notice === null ? (
          <p className="rename-hint">
            <span>Shown in place of the title, and by get_queue to sessions. Leave it empty to remove it.</span>
            <span className="rename-count">
              {Array.from(draft).length}/{max}
            </span>
          </p>
        ) : (
          <p id={noticeId} className="rename-error" role="alert">
            {notice}
          </p>
        )}
        <div className="rename-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function LimitsSheet(props: {
  limit: LimitView;
  saving: boolean;
  onSave: (fleet: number | null) => void;
  onClose: () => void;
}): JSX.Element {
  const { limit, saving, onSave, onClose } = props;
  const [draft, setDraft] = useState(limit.fleet === null ? "" : String(limit.fleet));
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  // An effect, not a layout effect: `Sheet` focuses its panel in one, after its children's.
  useEffect(() => {
    input.current?.focus();
  }, []);

  const parsed = parseLimitDraft(draft);
  return (
    <Sheet title="Session limit" variant="dialog" onClose={onClose}>
      <form
        className="rename"
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving && parsed !== undefined) onSave(parsed);
        }}
      >
        <label className="rename-label" htmlFor={inputId}>
          Sessions at once, across all machines
        </label>
        <input
          ref={input}
          id={inputId}
          type="text"
          inputMode="numeric"
          className="rename-input"
          placeholder="No limit"
          maxLength={String(FLEET_LIMIT_MAX).length}
          value={draft}
          disabled={saving}
          aria-invalid={parsed === undefined}
          aria-describedby={hintId}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        {parsed === undefined ? (
          <p id={hintId} className="rename-error" role="alert">
            A whole number from 1 to {FLEET_LIMIT_MAX}, or empty for no limit. To stop the queue, pause it.
          </p>
        ) : (
          <p id={hintId} className="rename-hint">
            <span>
              Empty lets the queue run free: each account is then bound only by its quota. Sessions already running keep
              running, and Start now still goes past the limit.
            </span>
          </p>
        )}
        <div className="rename-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving || parsed === undefined}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/**
 * Reached from the phone's header menu, or a desk column: what the scheduler holds, by what each
 * task needs from the person, with a way to cancel, mark done, or hold the
 * whole queue. Everything it shows is `deriveQueue`'s; this lays it out.
 */
export function QueueScreen(props: {
  view: QueueScreenView;
  /** The last action's refusal or failure, as a sentence. */
  notice: string | null;
  onDismissNotice: () => void;
  pausing: boolean;
  discarding: boolean;
  /** The Limits sheet is open; the app holds it, since the header's count opens it too. */
  limitsOpen: boolean;
  limiting: boolean;
  onOpenLimits: () => void;
  onCloseLimits: () => void;
  onSetLimit: (fleet: number | null) => void;
  /** A notification's task: scrolled to and marked once its row is listed. */
  focusedTask: string | null;
  /**
   * The focus was acted on: the store forgets it. Only here, never on unmount: a callback that is a new
   * closure each render would make an unmount effect run on every re-render and drop a focus whose row
   * is not listed yet. The store drops it when the screen closes (`#closeTopLayer`, or a switch to Machines).
   */
  onFocused: () => void;
  onCancel: (taskId: string) => void;
  onMarkDone: (taskId: string) => void;
  /** Places a task the concurrency limit alone holds, past it. */
  onRunNow: (taskId: string) => void;
  /** Queues a task that resumes this failed or cancelled one's session in its worktree, on its machine. */
  onContinue: (taskId: string) => void;
  /** Passes a running task to a successor: pushes its branch, ends its session, queues the task that carries on. */
  onPass: (taskId: string) => void;
  /** Starts a new task that waits on this one: the form opens on `auto` with it in After. */
  onFollowUp: (taskId: string) => void;
  /** The label dialog's state, a layer: the task being labelled, and whether its save is in flight. */
  labelling: LabellingState | null;
  onOpenLabel: (taskId: string) => void;
  onCloseLabel: () => void;
  /** Sets the task's `owner.label` (blank clears it); true when it landed. */
  onLabel: (taskId: string, label: string) => Promise<boolean>;
  onPause: () => void;
  onResume: (account?: string) => void;
  onDiscard: () => void;
  /** The archive's tasks past Finished; null while no archivist is online, and nothing of it renders (A35). */
  older: OlderView | null;
  olderActions: OlderActions;
  /** Ends a session by its pane (the graceful despawn): a task's live one, or one running none. Settles once it is answered. */
  onCloseSession: (target: CloseTarget) => Promise<void>;
  /** Names an untasked session's conversation (blank clears); resolves null once it landed, else the refusal to show. */
  onRenameSession: (deviceId: string, pane: string, session: string, text: string) => Promise<string | null>;
}): JSX.Element {
  const { view, notice, pausing, onCancel, onMarkDone } = props;
  const [armed, setArmed] = useState<string | null>(null);
  // The row whose close is out: its Close greys until the daemon answers.
  const [closing, setClosing] = useState<string | null>(null);
  // The open session rename: a dialog local to this screen, as the Machines card's was.
  const [sessionRename, setSessionRename] = useState<{
    readonly row: SessionQueueRow;
    readonly rename: NonNullable<SessionRow["rename"]>;
  } | null>(null);
  // Memory only: persist.ts keeps the spawn form's record, no place for a view's open/closed.
  const [asleepOpen, setAsleepOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const pause = useRef<HTMLButtonElement>(null);

  // The × that held focus is gone: hand it to the footer's button rather than drop it to <body>.
  const dismissNotice = (): void => {
    props.onDismissNotice();
    pause.current?.focus();
  };

  // Not scrollIntoView: that scrolls every ancestor too, which shifts the page on a phone.
  const reveal = useCallback((taskId: string): void => {
    const el = list.current;
    if (el === null) return;
    const card = el.querySelector<HTMLElement>(`[data-task="${CSS.escape(taskId)}"]`);
    if (card === null) return;
    const box = el.getBoundingClientRect();
    const at = card.getBoundingClientRect();
    const top = centeredScrollTop(
      { top: box.top, height: box.height, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight },
      { top: at.top, height: at.height },
    );
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top, behavior: still ? "auto" : "smooth" });
    // The scroll alone leaves keyboard and screen-reader focus on the button; preventScroll keeps the smooth scroll ours.
    card.focus({ preventScroll: true });
  }, []);

  // A lineage line may name a card in the collapsed Asleep section: open it, and reveal on the next pass.
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);
  const revealOpening = useCallback(
    (taskId: string): void => {
      const asleep = view.sections.some((s) => s.title === ASLEEP_SECTION && s.rows.some((r) => r.id === taskId));
      if (!asleep || asleepOpen) {
        reveal(taskId);
        return;
      }
      setAsleepOpen(true);
      setPendingReveal(taskId);
    },
    [view.sections, asleepOpen, reveal],
  );
  useEffect(() => {
    if (pendingReveal === null || !asleepOpen) return;
    reveal(pendingReveal);
    setPendingReveal(null);
  }, [pendingReveal, asleepOpen, reveal]);

  // The row a notification named, marked while it fades; one view, never again on a re-render.
  const [marked, setMarked] = useState<string | null>(null);
  const { focusedTask, onFocused } = props;
  const focusedIn =
    focusedTask === null ? undefined : view.sections.find((s) => s.rows.some((r) => r.id === focusedTask))?.title;

  useEffect(() => {
    if (focusedTask === null || focusedIn === undefined) return;
    // A card in the collapsed Asleep section is not rendered: open it, and reveal on the next pass.
    if (focusedIn === ASLEEP_SECTION && !asleepOpen) {
      setAsleepOpen(true);
      return;
    }
    reveal(focusedTask);
    setMarked(focusedTask);
    onFocused();
  }, [focusedTask, focusedIn, asleepOpen, onFocused, reveal]);

  useEffect(() => {
    if (marked === null) return;
    const timer = setTimeout(() => setMarked(null), MARK_MS);
    return () => clearTimeout(timer);
  }, [marked]);

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
    else if (op === "pass") props.onPass(row.id);
    else if (op === "mark-done") onMarkDone(row.id);
  };

  const { onCloseSession } = props;
  const closeTap = (row: { readonly id: string; readonly close: CloseTarget | null }): void => {
    const target = row.close;
    if (target === null) return;
    const tap = armTap(row, "close", armed);
    setArmed(tap.armed);
    if (!tap.fire) return;
    setClosing(row.id);
    void onCloseSession(target).finally(() => setClosing((current) => (current === row.id ? null : current)));
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

  const labelledId = props.labelling?.taskId;
  const labelled =
    labelledId === undefined
      ? undefined
      : [...view.sections.flatMap((section) => section.rows), ...(props.older?.rows ?? [])].find(
          (row) => row.id === labelledId,
        );
  return (
    <>
      <div className="fleet" ref={list}>
        {view.holds.map((hold) => (
          <div key={hold.key} className="banner card">
            <span className="banner-rule" />
            <span className="banner-text">
              <span className="banner-body">
                <TimedText line={hold.text} />
              </span>
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
        {view.limitsUnreadable !== null && (
          <div className="banner card">
            <span className="banner-rule" />
            <span className="banner-text">
              <span className="banner-body">{view.limitsUnreadable}</span>
            </span>
            {view.limit !== null && (
              <button type="button" className="queue-resume" disabled={props.limiting} onClick={props.onOpenLimits}>
                Set limit
              </button>
            )}
          </div>
        )}
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
          const tasks = `${section.rows.length} ${section.rows.length === 1 ? "task" : "tasks"}`;
          const sessions = `${section.sessions.length} ${section.sessions.length === 1 ? "session" : "sessions"}`;
          return (
            <section key={section.title} className="queue-section">
              {collapsible ? (
                <h2 className="label fleet-heading">
                  <button
                    type="button"
                    className="queue-section-toggle"
                    aria-expanded={asleepOpen}
                    aria-label={`${section.title}, ${section.sessions.length === 0 ? tasks : `${tasks} and ${sessions}`}`}
                    onClick={() => setAsleepOpen((open) => !open)}
                  >
                    <span className="disclosure-chevron" aria-hidden="true">
                      ▶
                    </span>
                    {section.title} · {section.rows.length + section.sessions.length}
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
                    marked={marked === row.id}
                    available={view.available}
                    armed={armed}
                    onAct={act}
                    onMenuClosed={onMenuClosed}
                    onRunNow={props.onRunNow}
                    onContinue={props.onContinue}
                    onPass={props.onPass}
                    onFollowUp={props.onFollowUp}
                    onOpenLabel={props.onOpenLabel}
                    onReveal={reveal}
                    closing={closing === row.id}
                    onClose={closeTap}
                  />
                ))}
              {shown &&
                section.sessions.map((row) => (
                  <SessionCard
                    key={row.id}
                    row={row}
                    armed={armed}
                    closing={closing === row.id}
                    onClose={closeTap}
                    onRename={(rename) => setSessionRename({ row, rename })}
                    onMenuClosed={onMenuClosed}
                  />
                ))}
            </section>
          );
        })}
        {view.partial !== null && <p className="fleet-note">{view.partial}</p>}
        {props.older !== null && (
          <OlderSection
            older={props.older}
            actions={props.olderActions}
            renderCard={(row) => (
              <QueueCard
                key={row.id}
                row={row}
                marked={false}
                available={view.available}
                armed={armed}
                onAct={act}
                onMenuClosed={onMenuClosed}
                onRunNow={props.onRunNow}
                onContinue={props.onContinue}
                onPass={props.onPass}
                onFollowUp={props.onFollowUp}
                onOpenLabel={props.onOpenLabel}
                onReveal={revealOpening}
                closing={false}
                onClose={closeTap}
              />
            )}
          />
        )}
      </div>

      {/* Between list and footer, in flow: shown however the list is scrolled, and never covering its last card. */}
      {notice !== null && <Toast key={notice} text={notice} onDismiss={dismissNotice} />}
      <footer className="footer">
        <button
          ref={pause}
          type="button"
          className="primary queue-pause"
          disabled={!view.available || pausing}
          onClick={view.paused ? () => props.onResume() : props.onPause}
        >
          {view.paused ? "Resume queue" : "Pause queue"}
        </button>
      </footer>
      <OlderFilterSheet sheet={props.older?.sheet ?? null} actions={props.olderActions} />
      {labelled !== undefined && props.labelling !== null && (
        <LabelDialog
          key={labelled.id}
          title={labelled.title}
          initial={labelled.label ?? ""}
          saving={props.labelling.saving}
          notice={props.labelling.notice}
          onSave={(text) => void props.onLabel(labelled.id, text)}
          onClose={props.onCloseLabel}
        />
      )}
      {sessionRename !== null && (
        <SessionRenameDialog
          key={sessionRename.row.id}
          row={sessionRename.row}
          label={sessionRename.rename.label}
          onSave={(text) =>
            props.onRenameSession(
              sessionRename.row.deviceId,
              sessionRename.rename.pane,
              sessionRename.rename.session,
              text,
            )
          }
          onClose={() => setSessionRename(null)}
        />
      )}
      {props.limitsOpen && view.limit !== null && (
        <LimitsSheet
          limit={view.limit}
          saving={props.limiting}
          onSave={props.onSetLimit}
          onClose={props.onCloseLimits}
        />
      )}
    </>
  );
}

/** What a pass does, under its item: the push and the end of the session are the parts a person should know first. */
const PASS_CONFIRM = "Pushes its branch and ends this session; a new task picks it up.";

/**
 * Older (DESIGN.md, Archivist, A36g–A36j): the Asleep section's toggle, closed by
 * default and with no count, since the archive is paged; open, the title search
 * in the rename field's style, the spawn form's tile grid, and archived cards.
 */
function OlderSection(props: {
  older: OlderView;
  actions: OlderActions;
  renderCard: (row: OlderView["rows"][number]) => JSX.Element;
}): JSX.Element {
  const { older, actions } = props;
  return (
    <section className="queue-section">
      <h2 className="label fleet-heading">
        <button type="button" className="queue-section-toggle" aria-expanded={older.open} onClick={actions.toggle}>
          <span className="disclosure-chevron" aria-hidden="true">
            ▶
          </span>
          {OLDER_TITLE}
        </button>
      </h2>
      {older.open && (
        <>
          <input
            type="search"
            className="rename-input"
            value={older.search}
            placeholder="Search titles"
            aria-label="Search older tasks by title"
            enterKeyHint="search"
            autoComplete="off"
            onInput={(event) => actions.search(event.currentTarget.value)}
          />
          <div className="grid">
            {older.tiles.map(({ sheet, tile }) => (
              <TileButton key={sheet} tile={tile} onClick={() => actions.openSheet(sheet)} />
            ))}
          </div>
          {older.status !== null && <p className="fleet-note">{older.status}</p>}
          {older.clearable && (
            <button type="button" className="quiet" onClick={actions.clear}>
              Clear search and filters
            </button>
          )}
          {older.rows.map((row) => props.renderCard(row))}
          {older.showing !== null && <p className="fleet-note">{older.showing}</p>}
          {older.moreError !== null && <p className="fleet-note">{older.moreError}</p>}
          {older.more !== null && (
            <button type="button" className="quiet" disabled={older.more.loading} onClick={actions.loadMore}>
              {older.more.loading ? "Loading…" : "Load older"}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** One of Older's filter sheets, kept mounted through its exit like the spawn form's. */
function OlderFilterSheet(props: { sheet: OlderSheetView | null; actions: OlderActions }): JSX.Element | null {
  const { sheet, actions } = props;
  // The view drops the sheet as it closes; its last options stay on screen for the exit animation.
  const last = useRef<OlderSheetView | null>(null);
  if (sheet !== null) last.current = sheet;
  const [kind, closing, unmount] = useSheetExit(sheet?.kind ?? null);
  const shown = kind === null ? null : last.current;
  if (shown === null) return null;
  return (
    <Sheet title={shown.title} closing={closing} onExited={unmount} onClose={actions.closeSheet}>
      {shown.options.map((option) => (
        <SheetItem
          key={option.key}
          label={option.label}
          sub={option.sub}
          mono={option.mono}
          dot={option.dot}
          selected={option.selected}
          onClick={() => actions.pick(option.pick)}
        />
      ))}
    </Sheet>
  );
}

const INLINE_LABEL: Record<NonNullable<QueueRow["inline"]>, string> = {
  continue: "Continue",
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
  onPass: (taskId: string) => void;
  onFollowUp: (taskId: string) => void;
  onOpenLabel: (taskId: string) => void;
  /** Scrolls the queue to another task's card. */
  onReveal: (taskId: string) => void;
  /** The task a notification opened: the card is marked while it fades. */
  marked: boolean;
  /** Its session's close is out. */
  closing: boolean;
  /** Close session: arms, then despawns its pane. */
  onClose: (row: QueueRow) => void;
}): JSX.Element {
  const { row, armed, onAct } = props;
  const { inline, continuing } = row;
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
  const opens =
    row.canFollowUp || row.startNow !== null || row.canContinue || row.canPass || row.canLabel || row.session !== null;
  const ends = row.canMarkDone || row.canCancel || row.close !== null;
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
  };
  const armItem = (
    op: ArmOp,
    label: string,
    armedLabel: string,
    icon: JSX.Element,
    destructive: boolean,
    sub?: string,
  ) => (
    <MenuItem
      label={armed === armKey(op, row.id) ? armedLabel : label}
      icon={icon}
      {...(sub === undefined ? {} : { sub })}
      disabled={disabled}
      destructive={destructive}
      keepOpen={!armTap(row, op, armed).fire}
      onClick={() => onAct(row, op)}
    />
  );

  return (
    <section
      className={props.marked ? "fleet-card card fleet-card-marked" : "fleet-card card"}
      data-task={row.id}
      tabIndex={-1}
    >
      <div className="fleet-card-head">
        {row.dot !== null && <span className={`dot dot-${row.dot}`} aria-hidden="true" />}
        <div className="fleet-card-title">
          <h3 className="fleet-name">
            {row.session === null ? (
              row.name
            ) : (
              <a
                className="queue-session"
                href={row.session}
                target="_blank"
                rel="noopener noreferrer"
                title="Open the session on claude.ai"
              >
                {row.name}
              </a>
            )}
          </h3>
          <p className="fleet-meta">
            <TimedText line={row.headline} /> · <Time moment={row.age} />
            {row.agent !== null && (
              <span className="fleet-badge queue-agent" title={`Runs on ${row.agent}`}>
                {row.agent}
              </span>
            )}
            {row.autonomy !== null && (
              <span className="fleet-badge queue-autonomy" title={`Autonomy: ${row.autonomy}`}>
                {row.autonomy}
              </span>
            )}
          </p>
        </div>
        {hasMenu && (
          <>
            <MoreTrigger menu={handle} label={`More actions for ${row.name}`} />
            <Menu menu={handle} label={`Actions for ${row.name}`}>
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
              {row.canPass &&
                armItem("pass", "Pass to successor", "Tap again to pass it on", <PassIcon />, false, PASS_CONFIRM)}
              {row.canLabel && (
                <MenuItem label="Label…" icon={<LabelIcon />} onClick={() => props.onOpenLabel(row.id)} />
              )}
              {row.session !== null && (
                <MenuItem label="Open on claude.ai" icon={<ExternalIcon />} href={row.session} external />
              )}
              {opens && ends && <MenuDivider />}
              {row.canMarkDone && armItem("mark-done", "Mark done", "Tap again to mark done", <CheckIcon />, false)}
              {row.canCancel && armItem("cancel", "Cancel", "Tap again to cancel", <CrossIcon />, true)}
              {row.close !== null && (
                <CloseItem
                  rowId={row.id}
                  armed={armed}
                  disabled={row.busy || props.closing}
                  task
                  onClick={() => props.onClose(row)}
                />
              )}
            </Menu>
          </>
        )}
      </div>
      {row.ref !== null && (
        <p className="fleet-card-body queue-tags">
          {row.ref.url === null ? (
            <span className="fleet-badge queue-ref" title="What it is for">
              {row.ref.text}
            </span>
          ) : (
            <a
              className="fleet-badge queue-ref"
              href={row.ref.url}
              target="_blank"
              rel="noopener noreferrer"
              title="What it is for"
            >
              {row.ref.text}
            </a>
          )}
        </p>
      )}
      {row.deps !== null && <p className="fleet-card-body">{row.deps}</p>}
      {row.continues !== null && <p className="fleet-card-body">{row.continues}</p>}
      {row.stackedOn !== null && <Lineage line={row.stackedOn} onReveal={props.onReveal} />}
      {row.carriesOn !== null && <Lineage line={row.carriesOn} onReveal={props.onReveal} />}
      {row.passedTo !== null && <Lineage line={row.passedTo} onReveal={props.onReveal} />}
      {row.flag !== null && (
        <p className="fleet-card-body">
          {row.flag.label}
          {row.flag.note !== null && <>: {row.flag.note}</>}
        </p>
      )}
      {continuing !== null && <Lineage line={continuing} onReveal={props.onReveal} />}
      {row.placement !== null && <p className="fleet-card-body">{row.placement}</p>}
      {row.batch !== null && <p className="fleet-card-body">{row.batch}</p>}
      {row.body !== null && (
        <p className="fleet-card-body">
          <TimedText line={row.body} />
        </p>
      )}
      {row.sessionTags.length > 0 && <SessionTags groups={row.sessionTags} />}
      {(row.pr !== null || inline !== null || row.answer !== null) && (
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
              {row.pr.blocked !== null && <span className="queue-pr-blocked">{row.pr.blocked}</span>}
            </a>
          )}
          {inline !== null && (
            <button
              type="button"
              className={row.inlinePrimary ? "primary" : "quiet"}
              disabled={disabled}
              onClick={() => run[inline](row.id)}
            >
              {INLINE_LABEL[inline]}
            </button>
          )}
          {row.answer !== null && (
            <a className="primary" href={row.answer} target="_blank" rel="noopener noreferrer">
              Answer in Claude
            </a>
          )}
        </div>
      )}
    </section>
  );
}

/** What a close does, under its item: the despawn's own terms (`DespawnRequest`). */
const CLOSE_CONFIRM = "Asks Claude to exit and closes its window; a worktree stays.";
/** On a task's row: the despawn goes straight to its machine, so the task ends with its session, not as a cancel. */
const CLOSE_TASK_CONFIRM = "Asks Claude to exit and closes its window; the task ends with it, not as a cancel.";

/** Close session: ends a session, so it asks twice like Cancel. */
function CloseItem(props: {
  rowId: string;
  armed: string | null;
  disabled: boolean;
  task?: true;
  onClick: () => void;
}): JSX.Element {
  const armedHere = props.armed === armKey("close", props.rowId);
  return (
    <MenuItem
      label={armedHere ? "Tap again to close" : "Close session"}
      icon={<CloseSessionIcon />}
      sub={props.task === true ? CLOSE_TASK_CONFIRM : CLOSE_CONFIRM}
      disabled={props.disabled}
      destructive
      keepOpen={!armTap({ id: props.rowId }, "close", props.armed).fire}
      onClick={props.onClick}
    />
  );
}

/**
 * A session the queue's list carries no row for (docs/work.md, "Untasked row"): its name, where it runs, what it is
 * doing. It has no record, so its menu holds only acts on the session itself: never Continue, Pass, Mark done or Cancel.
 */
function SessionCard(props: {
  row: SessionQueueRow;
  armed: string | null;
  closing: boolean;
  onClose: (row: SessionQueueRow) => void;
  onRename: (rename: NonNullable<SessionRow["rename"]>) => void;
  onMenuClosed: (rowId: string) => void;
}): JSX.Element {
  const { row, armed, onMenuClosed } = props;
  const { rename } = row;
  const menu = useMenu();
  const handle: MenuHandle<HTMLButtonElement> = {
    ...menu,
    onToggle: (newState) => {
      menu.onToggle(newState);
      if (newState !== "open") onMenuClosed(row.id);
    },
  };
  const opens = rename !== null || row.session !== null;
  const hasMenu = opens || row.close !== null;
  // As QueueCard: an unmount fires no `toggle`, so the arm would outlive the card.
  useEffect(() => {
    if (!hasMenu) return;
    return () => onMenuClosed(row.id);
  }, [hasMenu, row.id, onMenuClosed]);

  return (
    <section className="fleet-card card" tabIndex={-1}>
      <div className="fleet-card-head">
        <div className="fleet-card-title">
          <h3 className="fleet-name">
            {row.session === null ? (
              row.name
            ) : (
              <a
                className="queue-session"
                href={row.session}
                target="_blank"
                rel="noopener noreferrer"
                title="Open the session on claude.ai"
              >
                {row.name}
              </a>
            )}
          </h3>
          <p className="fleet-meta">
            {row.where}
            {row.nameMark === null ? "" : ` · ${row.nameMark}`}
            <span className="fleet-badge queue-kind">{row.kind}</span>
          </p>
        </div>
        {hasMenu && (
          <>
            <MoreTrigger menu={handle} label={`More actions for ${row.name}`} />
            <Menu menu={handle} label={`Actions for ${row.name}`}>
              {rename !== null && (
                <MenuItem label="Rename…" icon={<LabelIcon />} onClick={() => props.onRename(rename)} />
              )}
              {row.session !== null && (
                <MenuItem label="Open on claude.ai" icon={<ExternalIcon />} href={row.session} external />
              )}
              {opens && row.close !== null && <MenuDivider />}
              {row.close !== null && (
                <CloseItem rowId={row.id} armed={armed} disabled={props.closing} onClick={() => props.onClose(row)} />
              )}
            </Menu>
          </>
        )}
      </div>
      <p className="fleet-card-body">
        <TimedText line={row.state} />
      </p>
      {row.tags.length > 0 && <SessionTags groups={row.tags} />}
    </section>
  );
}

/** A session's joined tags, folded: each namespace with its writer, each tag with its scope and age. */
function SessionTags(props: { groups: readonly SessionTagGroup[] }): JSX.Element {
  const { groups } = props;
  const count = groups.reduce((sum, group) => sum + group.tags.length, 0);
  return (
    <details className="session-tags">
      <summary>Tags · {count}</summary>
      {groups.map((group) => (
        <div key={group.namespace} className="session-tag-group">
          <p className="session-tag-head">
            <code>{group.namespace}.*</code> · by {group.writer}
          </p>
          <dl className="session-tag-list">
            {group.tags.map((tag) => (
              <div key={tag.suffix} className="session-tag">
                <dt>{tag.suffix}</dt>
                <dd>
                  {tag.url === null ? (
                    <span className="session-tag-value">{tag.value}</span>
                  ) : (
                    <a className="session-tag-value" href={tag.url} target="_blank" rel="noopener noreferrer">
                      {tag.value}
                    </a>
                  )}
                  {tag.verified && <span className="session-tag-verified">verified</span>}
                  <span className="session-tag-meta">
                    {tag.scope} · <TimedText line={tag.age} />
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </details>
  );
}

/**
 * The owner's name for an untasked session, kept against its conversation on that machine. Stays open on a refusal,
 * the reason where the hint was, so the draft is there to send again; closes once the name landed.
 */
function SessionRenameDialog(props: {
  row: SessionQueueRow;
  /** The owner's label now, `""` for none. */
  label: string;
  onSave: (text: string) => Promise<string | null>;
  onClose: () => void;
}): JSX.Element {
  const { row, label, onSave, onClose } = props;
  const [draft, setDraft] = useState(label);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const noticeId = useId();
  const inputId = useId();
  // The daemon refuses what its byte cap would cut (multibyte text reaches it well before the character cap).
  const tooLong = new TextEncoder().encode(displayLine(draft, Infinity)).length > TAG_VALUE_MAX;
  // An effect, not a layout effect: `Sheet` focuses its panel in one, after its children's.
  useEffect(() => {
    if (!saving) input.current?.focus();
  }, [saving]);

  return (
    <Sheet title="Rename session" variant="dialog" onClose={onClose}>
      <form
        className="rename"
        onSubmit={(event) => {
          event.preventDefault();
          if (saving) return;
          setSaving(true);
          setNotice(null);
          void onSave(draft).then((refusal) => {
            setSaving(false);
            if (refusal === null) onClose();
            else setNotice(refusal);
          });
        }}
      >
        <p className="rename-account">
          {row.name}
          {row.nameMark === null ? "" : ` ${row.nameMark}`}
        </p>
        <label className="rename-label" htmlFor={inputId}>
          Session name
        </label>
        <input
          ref={input}
          id={inputId}
          type="text"
          className="rename-input"
          placeholder="Name this session"
          maxLength={TASK_REQUEST_LIMITS.title}
          value={draft}
          disabled={saving}
          aria-invalid={notice !== null}
          aria-describedby={notice === null ? undefined : noticeId}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        {notice === null ? (
          <p className="rename-hint">
            <span>
              {tooLong
                ? `Too long: at most ${TAG_VALUE_MAX} bytes, which non-ASCII characters use up faster.`
                : "Kept for this conversation on its machine. Leave it empty to go back to the session's own name."}
            </span>
            <span className="rename-count">
              {Array.from(draft).length}/{TASK_REQUEST_LIMITS.title}
            </span>
          </p>
        ) : (
          <p id={noticeId} className="rename-error" role="alert">
            {notice}
          </p>
        )}
        <div className="rename-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving || tooLong}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function CloseSessionIcon(): JSX.Element {
  return (
    <MenuGlyph>
      <path d="M9 4H5v16h4M15 8l4 4-4 4M19 12H9" />
    </MenuGlyph>
  );
}

function Lineage(props: { line: LineageLine; onReveal: (taskId: string) => void }): JSX.Element {
  const { text, reveal } = props.line;
  if (reveal === null) return <p className="fleet-card-body">{text}</p>;
  return (
    <p className="fleet-card-body">
      <button
        type="button"
        className="queue-reveal"
        aria-label={`${text}, show in queue`}
        onClick={() => props.onReveal(reveal)}
      >
        {text}
      </button>
    </p>
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

function LabelIcon(): JSX.Element {
  return (
    <MenuGlyph>
      <path d="M3 12V4h8l9 9-8 8z" />
      <circle cx="7.5" cy="8.5" r="1" />
    </MenuGlyph>
  );
}

function PassIcon(): JSX.Element {
  return (
    <MenuGlyph>
      <path d="M4 12h12" />
      <path d="M12 6l6 6-6 6" />
      <path d="M20 5v14" />
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
      {checks === "unrun" && (
        <>
          <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" />
          <circle cx="12" cy="17" r="0.4" fill="currentColor" />
        </>
      )}
    </StrokeIcon>
  );
}
