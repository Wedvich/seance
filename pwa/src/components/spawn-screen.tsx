import type { JSX, TargetedKeyboardEvent } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { TASK_SPEC_LIMITS, type DepAfter, type Machine, type TaskUntil } from "@seance/shared";
import { describeDecision, startNowItem } from "../decision-view.ts";
import type { AfterSheetView } from "../queue-view.ts";
import {
  EFFORTS,
  EFFORT_LABELS,
  MODELS,
  MODEL_LABELS,
  type Effort,
  type Model,
  type PersistedForm,
  type PreviewState,
  type SheetKind,
} from "../state.ts";
import { completeSkill, matchSkills, promptSegments, skillIndex, skillToken } from "../skills.ts";
import { formatSeen, type AttachmentsView, type Tile, type ViewModel } from "../view.ts";
import { DecisionCard } from "./decision.tsx";
import { HeaderMenu } from "./header-menu.tsx";
import { Menu, MenuItem, useMenu } from "./menu.tsx";
import { Seg } from "./seg.tsx";
import { dotClass, Sheet, SheetItem } from "./sheet.tsx";
import { SkillPicker, skillOptionId } from "./skill-picker.tsx";

const SKILL_LIST_ID = "skill-list";

const SHEET_TITLES: Record<SheetKind, string> = {
  machine: "Where should it run?",
  account: "Which account?",
  repo: "Which repo?",
  model: "Which model?",
  effort: "How much effort?",
  after: "Wait for which tasks?",
  batch: "Batch these tasks",
};

const WHEN_LABELS: Record<DepAfter, string> = { opened: "Opened", merged: "Merged", done: "Done" };

/**
 * What this screen can ask the app to do. A callback set rather than the store
 * itself: the sheets pick, the store decides what picking means — and in
 * particular it, not a component, owns the history push each layer needs to
 * keep Android back symmetrical.
 */
export interface SpawnActions {
  readonly setPrompt: (prompt: string) => void;
  readonly clearPrompt: () => void;
  readonly undoClear: () => void;
  readonly openSettings: () => void;
  readonly openQueue: () => void;
  readonly openMachines: () => void;
  readonly openSheet: (sheet: SheetKind) => void;
  readonly toggleWorktree: () => void;
  readonly spawn: () => void;
  /** Queues as `spawn` does, then asks the leader to skip the queue for it. */
  readonly startNow: () => void;
  readonly dismissLayer: () => void;
  readonly pickMachine: (deviceId: string | null) => void;
  readonly pickAccount: (accountId: string | null) => void;
  readonly refreshPreview: () => void;
  readonly removeMachine: (deviceId: string) => void;
  readonly selectRepo: (repo: string) => void;
  readonly rescan: (deviceId: string) => void;
  readonly setModel: (model: Model) => void;
  readonly setEffort: (effort: Effort) => void;
  readonly addAfter: (taskId: string, after: DepAfter) => void;
  readonly removeAfter: (taskId: string) => void;
  readonly setUntil: (until: TaskUntil) => void;
  readonly startBatch: () => void;
  readonly endBatch: () => void;
  /** Picked, pasted or dropped files; the store applies the limits. */
  readonly addFiles: (files: readonly File[]) => void;
  readonly removeFile: (key: string) => void;
}

/** Only drags that carry files light the card up: a dragged text selection is the textarea's. */
function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") === true;
}

/**
 * The prompt card's files: chips with remove, and ATTACH, which opens the picker.
 * Rendered only while attaching is offered, or while files picked earlier are
 * still listed (the leader changed under them), so they can still be removed.
 */
function AttachmentList(props: {
  view: AttachmentsView;
  onAdd: (files: readonly File[]) => void;
  onRemove: (key: string) => void;
}): JSX.Element | null {
  const { view, onAdd, onRemove } = props;
  const picker = useRef<HTMLInputElement>(null);
  if (!view.offered && view.files.length === 0) return null;
  return (
    <div className="attach">
      {view.files.length > 0 && (
        <ul className="attach-list" aria-label={view.summary ?? undefined}>
          {view.files.map((file) => (
            <li key={file.key} className="attach-chip">
              <span className="attach-name">{file.name}</span>
              <span className="attach-size">{file.size}</span>
              <button
                type="button"
                className="attach-remove"
                aria-label={`Remove ${file.name}`}
                disabled={view.locked}
                onClick={() => onRemove(file.key)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="attach-foot">
        <span className="attach-summary">{view.summary ?? ""}</span>
        {view.offered && (
          <button
            type="button"
            className="prompt-action"
            disabled={view.locked}
            onClick={() => picker.current?.click()}
          >
            ATTACH
          </button>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const input = event.currentTarget;
            onAdd([...(input.files ?? [])]);
            // Cleared so picking the same file again still fires a change.
            input.value = "";
          }}
        />
      </div>
      {view.notice !== null && <p className="attach-notice">{view.notice}</p>}
    </div>
  );
}

/**
 * CLEAR and UNDO share one slot in the prompt header, and it stays empty rather
 * than showing a greyed CLEAR: an action you cannot take is noise, and clearing
 * nothing is not an action.
 */
function PromptAction(props: {
  onClear: () => void;
  onUndo: () => void;
  prompt: string;
  undo: string | null;
}): JSX.Element | null {
  const { onClear, onUndo, prompt, undo } = props;
  if (undo !== null) {
    return (
      <button type="button" className="prompt-action prompt-action-undo" onClick={onUndo}>
        UNDO
      </button>
    );
  }
  if (prompt === "") return null;
  return (
    <button type="button" className="prompt-action" onClick={onClear}>
      CLEAR
    </button>
  );
}

function TileButton(props: { tile: Tile; offline?: boolean; onClick: () => void }): JSX.Element {
  const { tile, offline = false, onClick } = props;
  const valueClass = tile.mono ? "tile-value tile-value-mono" : "tile-value";
  return (
    <button
      type="button"
      className={offline ? "tile card tile-offline" : "tile card"}
      onClick={onClick}
      aria-label={`${tile.label}: ${tile.value}`}
    >
      <span className="label">{tile.label}</span>
      <span className={valueClass}>
        {tile.dot !== null && <span className={dotClass(tile.dot)} />}
        <span>{tile.value}</span>
      </span>
    </button>
  );
}

function ActiveSheet(props: {
  actions: SpawnActions;
  view: ViewModel;
  kind: SheetKind;
  model: Model;
  effort: Effort;
  batch: PersistedForm["batch"];
  /** Derived while the After sheet is open, so the list is not rebuilt on every keystroke. */
  afterSheet: AfterSheetView | null;
  /** True while the exit animation plays; the sheet is already popped from state. */
  closing: boolean;
  onExited: () => void;
}): JSX.Element {
  const {
    actions,
    view,
    kind,
    model: selectedModel,
    effort: selectedEffort,
    batch,
    afterSheet,
    closing,
    onExited,
  } = props;
  const close = actions.dismissLayer;

  if (kind === "after" && afterSheet !== null) {
    return <AfterSheet actions={actions} sheet={afterSheet} closing={closing} onExited={onExited} />;
  }

  if (kind === "batch") {
    return <BatchSheet actions={actions} batch={batch} closing={closing} onExited={onExited} />;
  }

  if (kind === "machine") {
    const auto = view.autoAvailability;
    return (
      <Sheet title={SHEET_TITLES.machine} closing={closing} onExited={onExited} onClose={close}>
        <SheetItem
          label="Auto"
          sub={auto.reason ?? auto.note ?? "the scheduler picks the machine"}
          dot={auto.available ? "auto" : "off"}
          selected={view.machine === null}
          disabled={!auto.available}
          onClick={() => actions.pickMachine(null)}
        />
        {view.machineChoices.map(({ machine, sub, disabled, selected, canRescan, rescanDisabled }) => (
          <SheetItem
            key={machine.deviceId}
            label={machine.name}
            sub={sub}
            dot={machine.connected ? "ok" : "off"}
            selected={selected}
            disabled={disabled}
            // Only offered while offline: the relay refuses to forget a machine
            // it holds a socket for, so on a connected row it would do nothing.
            onRemove={machine.connected ? null : () => actions.removeMachine(machine.deviceId)}
            removeLabel={`Forget ${machine.name}`}
            onAction={canRescan ? () => actions.rescan(machine.deviceId) : null}
            actionLabel={`Rescan ${machine.name}`}
            actionDisabled={rescanDisabled}
            onClick={() => actions.pickMachine(machine.deviceId)}
          />
        ))}
      </Sheet>
    );
  }

  if (kind === "account") {
    return (
      <Sheet title={SHEET_TITLES.account} closing={closing} onExited={onExited} onClose={close}>
        <SheetItem
          label="Auto"
          sub="the scheduler picks the account"
          dot={view.autoAvailability.available ? "auto" : "off"}
          selected={view.account === null}
          disabled={!view.autoAvailability.available}
          onClick={() => actions.pickAccount(null)}
        />
        {view.accountChoices.map((choice) => (
          <SheetItem
            key={choice.accountId}
            label={choice.label}
            sub={choice.sub}
            dot={choice.dot}
            selected={choice.selected}
            disabled={choice.disabled}
            onClick={() => actions.pickAccount(choice.accountId)}
          />
        ))}
        {view.accountChoices.length === 0 && <p className="sheet-note">No machine reports a signed-in account.</p>}
      </Sheet>
    );
  }

  if (kind === "repo") {
    return (
      <Sheet title={SHEET_TITLES.repo} closing={closing} onExited={onExited} onClose={close}>
        {view.repos.map((repo) => (
          <SheetItem
            key={repo.origin}
            label={repo.label}
            mono
            sub={repo.origin === repo.label ? null : repo.origin}
            selected={repo.origin === view.repo?.origin}
            onClick={() => actions.selectRepo(repo.origin)}
          />
        ))}
        {view.repos.length === 0 && (
          <p className="sheet-note">No clone with an origin is in scope of the pinned machine and account.</p>
        )}
      </Sheet>
    );
  }

  if (kind === "model") {
    return (
      <Sheet title={SHEET_TITLES.model} closing={closing} onExited={onExited} onClose={close}>
        {MODELS.map((model) => (
          <SheetItem
            key={model}
            label={MODEL_LABELS[model]}
            selected={model === selectedModel}
            onClick={() => actions.setModel(model)}
          />
        ))}
      </Sheet>
    );
  }

  if (kind === "after") {
    return (
      <Sheet title={SHEET_TITLES.after} closing={closing} onExited={onExited} onClose={close}>
        {null}
      </Sheet>
    );
  }

  return (
    <Sheet title={SHEET_TITLES.effort} closing={closing} onExited={onExited} onClose={close}>
      {EFFORTS.map((effort) => (
        <SheetItem
          key={effort}
          label={EFFORT_LABELS[effort]}
          selected={effort === selectedEffort}
          onClick={() => actions.setEffort(effort)}
        />
      ))}
    </Sheet>
  );
}

/**
 * Each unfinished task as a row to tick; a ticked one shows when its edge
 * releases. `Done` is offered only to a leader that takes it, but a held one
 * stays selectable so it can be changed back.
 */
function AfterSheet(props: {
  actions: SpawnActions;
  sheet: AfterSheetView;
  closing: boolean;
  onExited: () => void;
}): JSX.Element {
  const { actions, sheet, closing, onExited } = props;
  return (
    <Sheet title={SHEET_TITLES.after} closing={closing} onExited={onExited} onClose={actions.dismissLayer}>
      {sheet.options.map((option) => {
        const { when } = option;
        const whens: readonly DepAfter[] =
          sheet.doneAvailable || when === "done" ? ["opened", "merged", "done"] : ["opened", "merged"];
        return (
          <div key={option.id}>
            <SheetItem
              label={option.title}
              sub={option.headline}
              selected={when !== null}
              disabled={when === null && sheet.full}
              onClick={() => (when === null ? actions.addAfter(option.id, "opened") : actions.removeAfter(option.id))}
            />
            {when !== null && (
              <div className="after-when">
                <Seg
                  label={`When ${option.title} releases it`}
                  options={whens}
                  value={when}
                  render={(choice) => WHEN_LABELS[choice]}
                  onChange={(choice) => actions.addAfter(option.id, choice)}
                />
              </div>
            )}
          </div>
        );
      })}
      {sheet.note !== null && <p className="sheet-note">{sheet.note}</p>}
      {sheet.full && <p className="sheet-note">A task waits on at most {TASK_SPEC_LIMITS.deps} others.</p>}
      <p className="sheet-note">
        Opened: it has a PR. Merged: its branch merged. Done: it is finished
        {sheet.doneAvailable ? "" : " (the scheduler's leader doesn't take this yet)"}.
      </p>
    </Sheet>
  );
}

function BatchSheet(props: {
  actions: SpawnActions;
  batch: PersistedForm["batch"];
  closing: boolean;
  onExited: () => void;
}): JSX.Element {
  const { actions, batch, closing, onExited } = props;
  return (
    <Sheet title={SHEET_TITLES.batch} closing={closing} onExited={onExited} onClose={actions.dismissLayer}>
      <SheetItem
        label={batch === null ? "Off" : "End batch"}
        sub={batch === null ? "each task is queued on its own" : `the next task starts a fresh numbering`}
        selected={batch === null}
        onClick={actions.endBatch}
      />
      <SheetItem
        label={batch === null ? "Start batch" : "Batch open"}
        sub="the next tasks are grouped and numbered together"
        selected={batch !== null}
        onClick={actions.startBatch}
      />
      {batch !== null && <p className="sheet-note">Open, next is #{batch.next}.</p>}
      <p className="sheet-note">A batch sets no order or limit: to run tasks in turn, give each its After.</p>
    </Sheet>
  );
}

/**
 * What `auto` would do with the form as it stands, before anything is queued
 * (DESIGN.md, PWA). Shown only while the form is on `auto`.
 */
function PreviewCard(props: {
  preview: PreviewState | null;
  machines: readonly Machine[];
  now: number;
  onRefresh: () => void;
}): JSX.Element | null {
  const { preview, machines, now, onRefresh } = props;
  if (preview === null) return null;
  const pending = preview.kind === "loading";
  const refresh = (
    <button type="button" className="preview-refresh" onClick={onRefresh} disabled={pending} aria-label="Preview again">
      ↻
    </button>
  );
  const decision = preview.kind === "ok" ? preview.decision : pending ? preview.previous : undefined;
  if (decision !== undefined) {
    // Same tree for a re-ask as for its answer, so the card neither collapses nor closes its candidates.
    return (
      <div className={pending ? "preview preview-pending" : "preview"} aria-busy={pending}>
        <DecisionCard
          summary={describeDecision(decision, machines, now, "would")}
          title="PLACEMENT PREVIEW"
          quota={false}
          age={formatSeen(decision.at, now)}
        />
        {refresh}
      </div>
    );
  }
  return (
    <div className="preview">
      <section className="decision card" aria-label="PLACEMENT PREVIEW">
        <span className="label">PLACEMENT PREVIEW</span>
        <p className={preview.kind === "failed" ? "decision-headline decision-failed" : "decision-headline"}>
          {preview.kind === "failed" ? preview.message : "Asking the scheduler…"}
        </p>
      </section>
      {refresh}
    </div>
  );
}

/**
 * The footer's Queue, split when the leader answers `run-now`: two sibling
 * buttons in one pill, never nested, so Tab reaches both and a press on one
 * never fires the other. Without `run-now` it is the one button, unchanged.
 */
function QueueButton(props: {
  view: ViewModel;
  preview: PreviewState | null;
  onQueue: () => void;
  onStartNow: () => void;
}): JSX.Element {
  const { button, startNow } = props.view;
  const face = (
    <button
      type="button"
      className={button.busy ? "primary primary-busy" : "primary"}
      disabled={!button.enabled}
      onClick={props.onQueue}
    >
      {button.label}
    </button>
  );
  if (!startNow) return face;
  return (
    <SplitQueueButton
      face={face}
      enabled={button.enabled}
      busy={button.busy}
      preview={props.preview}
      onStartNow={props.onStartNow}
    />
  );
}

/** Its own component so the menu's open state mounts and unmounts with the split: a popover removed while open fires no toggle. */
function SplitQueueButton(props: {
  face: JSX.Element;
  enabled: boolean;
  busy: boolean;
  preview: PreviewState | null;
  onStartNow: () => void;
}): JSX.Element {
  const { face, enabled, busy } = props;
  const menu = useMenu<HTMLDivElement>();
  const item = startNowItem(props.preview);
  return (
    <>
      <div ref={menu.anchor} className={busy ? "split split-busy" : "split"}>
        {face}
        <span className="split-divider" aria-hidden="true" />
        <button
          type="button"
          className="split-more"
          disabled={!enabled}
          popovertarget={menu.id}
          aria-label="More ways to start"
          aria-haspopup="menu"
          aria-expanded={menu.open}
        >
          <svg
            className="split-chevron"
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M6 15l6-6 6 6" />
          </svg>
        </button>
      </div>
      <Menu menu={menu} label="More ways to start" direction="up">
        <MenuItem
          label="Start now"
          icon={<StartNowIcon />}
          sub={item.sub}
          disabled={!item.enabled}
          onClick={props.onStartNow}
        />
      </Menu>
    </>
  );
}

function StartNowIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6l8 6-8 6z" />
      <path d="M12 6l8 6-8 6z" />
    </svg>
  );
}

export function SpawnScreen(props: {
  actions: SpawnActions;
  view: ViewModel;
  form: PersistedForm;
  /** Text a CLEAR stashed; non-null for as long as UNDO is on offer. */
  promptUndo: string | null;
  sheet: SheetKind | null;
  machines: readonly Machine[];
  now: number;
  preview: PreviewState | null;
  /** The After sheet's list; non-null only while that sheet is open. */
  afterSheet: AfterSheetView | null;
  /** Desktop layout: the queue is a column of its own and the settings pill sits in its header. */
  columns: boolean;
}): JSX.Element {
  const { actions, view, form, promptUndo, sheet, machines, now, preview, afterSheet, columns } = props;
  const [dropping, setDropping] = useState(false);
  const attachOffered = view.attachments.offered;
  const offline = view.machine !== null && !view.machine.connected;
  const [renderedSheet, sheetClosing, unmountSheet] = useSheetExit(sheet);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  // The list is derived only while its sheet is open; the exit animation still needs it.
  const lastAfterSheet = useRef(afterSheet);
  if (afterSheet !== null) lastAfterSheet.current = afterSheet;

  // Open from the prompt text and caret, never focus: a tap on a row blurs the
  // textarea before its click lands on some browsers, and a focus-driven picker
  // would be gone by then. Escape hides it until the prompt next changes.
  const skills = useMemo(() => skillIndex(machines), [machines]);
  // Read against the prompt it was taken from: text written from elsewhere
  // (UNDO, "Reuse this prompt", a reload) leaves the browser's caret at the end.
  const [caret, setCaret] = useState<{ prompt: string; at: number | null }>(() => ({
    prompt: form.prompt,
    at: form.prompt.length,
  }));
  const caretAt = caret.prompt === form.prompt ? caret.at : form.prompt.length;
  const token = skillToken(form.prompt, caretAt);
  const query = token?.query ?? null;
  const readCaret = (): void => {
    const field = promptInput.current;
    if (field === null) return;
    const prompt = field.value;
    const at = field.selectionStart === field.selectionEnd ? field.selectionStart : null;
    setCaret((prev) => (prev.prompt === prompt && prev.at === at ? prev : { prompt, at }));
  };
  // Arrow keys, taps and IME moves all end here; the element-level events below
  // cover browsers that fire selectionchange on the document only for some of them.
  useEffect(() => {
    const onSelection = (): void => {
      if (document.activeElement === promptInput.current) readCaret();
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);
  const [dismissed, setDismissed] = useState<{ prompt: string; start: number } | null>(null);
  // Escape hides only until the next edit or another token: once either
  // differs, forget it, or coming back to the same text would stay hidden.
  // The caret stepping off the token (null) keeps it, so stepping back stays hidden.
  if (dismissed !== null && (dismissed.prompt !== form.prompt || (token !== null && dismissed.start !== token.start))) {
    setDismissed(null);
  }
  const pickerOpen = token !== null && skills.length > 0 && dismissed === null;
  const matches = useMemo(
    () => (pickerOpen && query !== null ? matchSkills(skills, query) : []),
    [pickerOpen, query, skills],
  );
  // Reset to the top on every query change (render-time, no effect), so editing
  // away and back never restores an old highlight; clamped if the list shrinks.
  const [cursor, setCursor] = useState<{ query: string | null; index: number }>({ query, index: 0 });
  if (cursor.query !== query) setCursor({ query, index: 0 });
  const active = cursor.query === query && cursor.index < matches.length ? cursor.index : 0;
  // A textarea can't style a run of its own text, so the highlight is painted
  // by a mirror behind it (same box and metrics, text drawn there instead) that
  // follows its scroll. The scroll event covers user scrolling; the layout
  // effect covers an edit that moves the caret without one.
  const segments = promptSegments(form.prompt, skills, pickerOpen && token !== null ? token : null);
  const promptBackdrop = useRef<HTMLDivElement>(null);
  const tokenAnchor = useRef<HTMLElement>(null);
  const syncBackdrop = (): void => {
    if (promptBackdrop.current === null || promptInput.current === null) return;
    promptBackdrop.current.scrollTop = promptInput.current.scrollTop;
  };
  // A pick rewrites the value, which puts the browser's caret at the end;
  // it belongs after the inserted space, set once the new value is in the DOM.
  const pendingCaret = useRef<{ prompt: string; caret: number } | null>(null);
  useLayoutEffect(() => {
    const field = promptInput.current;
    const pending = pendingCaret.current;
    if (field !== null && pending !== null && field.value === pending.prompt) {
      pendingCaret.current = null;
      field.setSelectionRange(pending.caret, pending.caret);
    }
    // Collapsing to one row keeps the scroll offset clamped to the last line,
    // not the caret's, so a token edited mid-prompt would be off view: scroll
    // to where the mirror draws it.
    const anchor = tokenAnchor.current;
    if (pickerOpen && field !== null && anchor !== null) {
      const top = anchor.offsetTop;
      const bottom = top + anchor.offsetHeight;
      if (top < field.scrollTop) field.scrollTop = top;
      else if (bottom > field.scrollTop + field.clientHeight) field.scrollTop = bottom - field.clientHeight;
    }
    syncBackdrop();
  }, [form.prompt, pickerOpen, token?.start]);
  const pickSkill = (name: string): void => {
    if (token === null) return;
    const next = completeSkill(form.prompt, token, name);
    pendingCaret.current = next;
    setCaret({ prompt: next.prompt, at: next.caret });
    actions.setPrompt(next.prompt);
    promptInput.current?.focus();
  };
  const pickerKey = (event: TargetedKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!pickerOpen || event.isComposing) return false;
    if (event.key === "Escape") {
      if (token !== null) setDismissed({ prompt: form.prompt, start: token.start });
      return true;
    }
    // With nothing to pick the prompt goes as typed: Enter is a newline and
    // Cmd/Ctrl+Enter still spawns.
    if (matches.length === 0 || query === null) return false;
    const plain = !(event.metaKey || event.ctrlKey || event.altKey || event.shiftKey);
    if (plain && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      const step = event.key === "ArrowDown" ? 1 : -1;
      setCursor({ query, index: (active + step + matches.length) % matches.length });
      return true;
    }
    // Cmd/Ctrl+Enter falls through to spawn, Shift+Enter to a newline.
    const pick =
      (event.key === "Enter" && !(event.metaKey || event.ctrlKey || event.shiftKey)) ||
      (event.key === "Tab" && !event.shiftKey);
    if (pick) {
      const name = matches[active];
      if (name !== undefined) pickSkill(name);
      return true;
    }
    return false;
  };

  // CLEAR leaves nothing to type into, so it drops focus (and the keyboard with
  // it); UNDO hands the field straight back. Focusing before the restore lands
  // leaves the caret at the end of the text, ready to keep writing.
  const clearPrompt = (): void => {
    actions.clearPrompt();
    promptInput.current?.blur();
  };
  const undoClear = (): void => {
    promptInput.current?.focus();
    // Same text as before the CLEAR, so the stale caret would still match it.
    if (promptUndo !== null) setCaret({ prompt: promptUndo, at: promptUndo.length });
    actions.undoClear();
  };

  return (
    <>
      <header className="header">
        <div>
          <h1 className="header-title">Séance</h1>
          <p className="header-meta">{view.meta}</p>
        </div>
        {!columns && (
          <HeaderMenu
            state={view.relayState}
            queueAttention={view.queueAttention}
            onQueue={actions.openQueue}
            onMachines={actions.openMachines}
            onSettings={actions.openSettings}
          />
        )}
      </header>

      <div className="column">
        <div
          className={dropping ? "prompt-card card prompt-card-drop" : "prompt-card card"}
          onDragOver={(event) => {
            if (!attachOffered || !carriesFiles(event)) return;
            event.preventDefault();
            setDropping(true);
          }}
          onDragLeave={(event) => {
            // Leaving for a child is still inside the card.
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
            setDropping(false);
          }}
          onDrop={(event) => {
            setDropping(false);
            if (!attachOffered || !carriesFiles(event)) return;
            event.preventDefault();
            actions.addFiles([...(event.dataTransfer?.files ?? [])]);
          }}
        >
          <div className="prompt-head">
            <span className="label" id="prompt-label">
              PROMPT
            </span>
            <PromptAction onClear={clearPrompt} onUndo={undoClear} prompt={form.prompt} undo={promptUndo} />
          </div>
          <div className={pickerOpen ? "prompt-field prompt-field-compact" : "prompt-field"}>
            <div ref={promptBackdrop} className="prompt-input prompt-backdrop" aria-hidden="true">
              {segments.map((segment) => {
                const ref = segment.anchor ? tokenAnchor : undefined;
                if (segment.skill) {
                  return (
                    <mark key={segment.start} ref={ref} className="prompt-skill">
                      {segment.text}
                    </mark>
                  );
                }
                return segment.anchor ? (
                  <span key={segment.start} ref={ref}>
                    {segment.text}
                  </span>
                ) : (
                  segment.text
                );
              })}
              {/* A trailing newline adds no line box in a div; the textarea gives it one. */}
              {form.prompt.endsWith("\n") && " "}
            </div>
            <textarea
              ref={promptInput}
              className="prompt-input prompt-text"
              onScroll={syncBackdrop}
              rows={pickerOpen ? 1 : undefined}
              aria-labelledby="prompt-label"
              aria-autocomplete="list"
              aria-controls={pickerOpen && matches.length > 0 ? SKILL_LIST_ID : undefined}
              aria-activedescendant={
                pickerOpen && matches.length > 0 ? skillOptionId(SKILL_LIST_ID, active) : undefined
              }
              placeholder="Describe the work — or leave it blank and start empty."
              value={form.prompt}
              onInput={(event) => {
                actions.setPrompt(event.currentTarget.value);
                readCaret();
              }}
              onPaste={(event) => {
                // A screenshot pastes as a file with no text; text keeps its normal paste.
                const files = [...(event.clipboardData?.files ?? [])];
                if (!attachOffered || files.length === 0) return;
                if (event.clipboardData?.getData("text/plain") === "") event.preventDefault();
                actions.addFiles(files);
              }}
              onKeyUp={readCaret}
              onClick={readCaret}
              onPointerUp={readCaret}
              onSelect={readCaret}
              onKeyDown={(event) => {
                if (pickerKey(event)) {
                  event.preventDefault();
                  return;
                }
                if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
                if (!view.button.enabled) return;
                event.preventDefault();
                actions.spawn();
              }}
            />
          </div>
          {pickerOpen && query !== null && (
            <SkillPicker id={SKILL_LIST_ID} query={query} items={matches} active={active} onPick={pickSkill} />
          )}
          <AttachmentList view={view.attachments} onAdd={actions.addFiles} onRemove={actions.removeFile} />
        </div>

        {view.banner !== null &&
          (view.banner.opensSettings ? (
            <button
              type="button"
              className={view.banner.tone === "err" ? "banner card banner-err" : "banner card"}
              onClick={actions.openSettings}
            >
              <span className="banner-rule" />
              <span className="banner-text">
                <span className="banner-title">{view.banner.title}</span>
                <span className="banner-body">{view.banner.body}</span>
              </span>
              <span className="banner-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          ) : (
            <div className={view.banner.tone === "err" ? "banner card banner-err" : "banner card"}>
              <span className="banner-rule" />
              <span className="banner-text">
                <span className="banner-title">{view.banner.title}</span>
                <span className="banner-body">{view.banner.body}</span>
              </span>
            </div>
          ))}

        <div className="grid">
          <TileButton tile={view.machineTile} offline={offline} onClick={() => actions.openSheet("machine")} />
          <TileButton tile={view.accountTile} onClick={() => actions.openSheet("account")} />
          <TileButton tile={view.repoTile} onClick={() => actions.openSheet("repo")} />
          <TileButton tile={view.modelTile} onClick={() => actions.openSheet("model")} />
          <TileButton tile={view.effortTile} onClick={() => actions.openSheet("effort")} />
          <TileButton tile={view.afterTile} onClick={() => actions.openSheet("after")} />
          <TileButton tile={view.batchTile} onClick={() => actions.openSheet("batch")} />
        </div>

        {view.ignoredNote !== null && <p className="ignored-note">{view.ignoredNote}</p>}

        {view.previewShown && (
          <PreviewCard preview={preview} machines={machines} now={now} onRefresh={actions.refreshPreview} />
        )}

        <button
          type="button"
          className="worktree card"
          onClick={actions.toggleWorktree}
          role="switch"
          aria-checked={form.worktree}
        >
          <span className="worktree-text">
            <span className="worktree-title">Fresh worktree</span>
            <span className="worktree-hint">{view.worktreeHint}</span>
          </span>
          <span className={form.worktree ? "toggle toggle-on" : "toggle"} aria-hidden="true">
            <span className="toggle-knob" />
          </span>
        </button>

        <button
          type="button"
          className="worktree card"
          onClick={() => actions.setUntil(form.until === "reported" ? "merged" : "reported")}
          role="switch"
          aria-checked={form.until === "reported"}
          disabled={!view.reportedAvailable && form.until !== "reported"}
        >
          <span className="worktree-text">
            <span className="worktree-title">Settle on its done report</span>
            <span className="worktree-hint">
              {view.reportedAvailable || form.until === "reported"
                ? form.until === "reported"
                  ? "A merge alone won't settle it. The session is told to report when it is finished; it needs the seance MCP server"
                  : "Settles when its PR merges or its session ends"
                : "The scheduler's leader doesn't take this yet — update seanced on its machine"}
            </span>
          </span>
          <span className={form.until === "reported" ? "toggle toggle-on" : "toggle"} aria-hidden="true">
            <span className="toggle-knob" />
          </span>
        </button>
      </div>

      <footer className="footer">
        {view.footerStatus !== null && <p className="footer-status">{view.footerStatus}</p>}
        <QueueButton
          view={view}
          preview={view.previewShown ? preview : null}
          onQueue={actions.spawn}
          onStartNow={actions.startNow}
        />
      </footer>

      {renderedSheet !== null && (
        <ActiveSheet
          actions={actions}
          view={view}
          kind={renderedSheet}
          model={form.model}
          effort={form.effort}
          batch={form.batch}
          afterSheet={lastAfterSheet.current}
          closing={sheetClosing}
          onExited={unmountSheet}
        />
      )}
    </>
  );
}

/**
 * Keeps the sheet mounted while its exit animation plays; state has already
 * dropped it. The timeout backstops a lost animationend, which would otherwise
 * strand an invisible scrim over the screen.
 */
function useSheetExit(sheet: SheetKind | null): [SheetKind | null, boolean, () => void] {
  const [rendered, setRendered] = useState(sheet);

  useLayoutEffect(() => {
    if (sheet !== null) setRendered(sheet);
  }, [sheet]);

  const closing = sheet === null && rendered !== null;

  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => setRendered(null), 400);
    return () => clearTimeout(timer);
  }, [closing]);

  return [rendered, closing, () => setRendered(null)];
}
