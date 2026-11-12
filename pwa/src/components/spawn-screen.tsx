import type { JSX, TargetedKeyboardEvent } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  AUTONOMY_LEVELS,
  TASK_SPEC_LIMITS,
  type AutonomyLevel,
  type DepAfter,
  type Machine,
  type TaskUntil,
} from "@seance/shared";
import { describeDecision, startNowItem } from "../decision-view.ts";
import type { AfterSheetView } from "../queue-view.ts";
import {
  AUTONOMY_HINTS,
  AUTONOMY_LABELS,
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
import { formatSeen, type AttachmentChip, type AttachmentsView, type Tile, type ViewModel } from "../view.ts";
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
  autonomy: "How much should it decide?",
  after: "Wait for which tasks?",
  requires: "Which traits must it have?",
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
  readonly setAutonomy: (autonomy: AutonomyLevel) => void;
  readonly addAfter: (taskId: string, after: DepAfter) => void;
  readonly removeAfter: (taskId: string) => void;
  readonly setUntil: (until: TaskUntil) => void;
  readonly toggleRequires: (trait: string) => void;
  /** Picked, pasted or dropped files; the store applies the limits. */
  readonly addFiles: (files: readonly File[]) => void;
  readonly removeFile: (key: string) => void;
  readonly retryHeld: (taskId: string) => void;
  readonly discardHeld: (taskId: string) => void;
  readonly dismissHeldDropped: () => void;
}

/**
 * Grows the prompt to its text, as chat composers do; CSS caps it, past which it
 * scrolls. Height is cleared first so a shortened prompt shrinks back. While the
 * skill picker is open the field is one row, so it is left unsized.
 *
 * The mirror is sized with it: its `inset: 0` follows the field's box, which a
 * stretched card makes taller than the textarea, and a taller mirror scrolls less
 * far and draws lines the textarea clips. The momentary collapse clamps both the
 * textarea's scroll and the column's, so both are put back, or an edit mid-way
 * down a long prompt jumps.
 */
function fitPrompt(field: HTMLTextAreaElement, mirror: HTMLElement | null, compact: boolean): void {
  const column = field.closest(".column");
  const fieldTop = field.scrollTop;
  const columnTop = column?.scrollTop ?? 0;
  field.style.height = "";
  if (mirror !== null) mirror.style.height = "";
  if (!compact) {
    field.style.height = `${field.scrollHeight}px`;
    if (mirror !== null) mirror.style.height = `${field.offsetHeight}px`;
  }
  field.scrollTop = fieldTop;
  if (column !== null) column.scrollTop = columnTop;
}

/** Only drags that carry files light the card up: a dragged text selection is the textarea's. */
function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") === true;
}

/**
 * A local preview of an image file, or the file glyph with its extension. An image
 * that decodes is a button: the keyboard's way into the preview, whose click the
 * chip handles as it does one anywhere else on it.
 */
function AttachmentThumb(props: {
  url: string | null;
  ext: string | null;
  name: string;
  onBroken: () => void;
}): JSX.Element {
  const { url, ext, name, onBroken } = props;
  if (url !== null) {
    return (
      <button type="button" className="attach-thumb attach-thumb-open" aria-label={`Preview ${name}`}>
        <img src={url} alt="" decoding="async" onError={onBroken} />
      </button>
    );
  }
  return (
    <span className="attach-thumb attach-thumb-file" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </svg>
      {ext !== null && <span className="attach-thumb-ext">{ext}</span>}
    </span>
  );
}

/**
 * An object URL for a picked file, living exactly as long as its user: made in an
 * effect, revoked on cleanup, so a remove, a queued task or leaving the screen frees it.
 */
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (blob === null) return;
    const made = URL.createObjectURL(blob);
    setUrl(made);
    return () => {
      URL.revokeObjectURL(made);
      setUrl(null);
    };
  }, [blob]);
  return url;
}

/**
 * One chip. An image the browser can't decode (HEIC on Chrome) falls back to the
 * glyph and opens no preview.
 */
function AttachmentChipItem(props: {
  file: AttachmentChip;
  removeLocked: boolean;
  onRemove: (key: string) => void;
  onPreview: (key: string) => void;
}): JSX.Element {
  const { file, removeLocked, onRemove, onPreview } = props;
  const made = useObjectUrl(file.image);
  const [broken, setBroken] = useState(false);
  const url = broken ? null : made;
  const classes = ["attach-chip"];
  if (file.failed) classes.push("attach-chip-failed");
  if (url !== null) classes.push("attach-chip-open");
  return (
    <li className={classes.join(" ")} onClick={url === null ? undefined : () => onPreview(file.key)}>
      <AttachmentThumb url={url} ext={file.ext} name={file.name} onBroken={() => setBroken(true)} />
      <span className="attach-text">
        <span className="attach-row">
          <span
            className="attach-name"
            // Set on the element, not as a prop: only a name the chip cuts gets a tooltip, and that is known at hover.
            onPointerEnter={(event) => {
              const node = event.currentTarget;
              node.title = node.scrollWidth > node.clientWidth ? file.name : "";
            }}
          >
            {file.name}
          </span>
          <button
            type="button"
            className="attach-remove"
            aria-label={`Remove ${file.name}`}
            disabled={removeLocked}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(file.key);
            }}
          >
            ×
          </button>
        </span>
        <span className="attach-status">{file.status}</span>
      </span>
      {file.percent !== null && (
        <span
          className="attach-progress"
          role="progressbar"
          aria-label={`Uploading ${file.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={file.percent}
        >
          <span className="attach-progress-fill" style={{ width: `${file.percent}%` }} />
        </span>
      )}
    </li>
  );
}

/**
 * A picked image at full size, from the file still held on the form: nothing is
 * fetched. A native modal dialog, as Settings is, for the inert page and for Escape
 * and Android's back arriving as `cancel`; it is no history layer, so `close` is the
 * one way out. Only ever an `<img>`: a picked SVG or HTML file opened as a document
 * would run in the app's origin.
 */
function AttachmentPreview(props: { name: string; image: Blob; onClose: () => void }): JSX.Element {
  const { name, image, onClose } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const url = useObjectUrl(image);

  useLayoutEffect(() => {
    const node = dialog.current;
    if (node === null) return;
    node.showModal();
    // Before removal, so focus goes back to where it was: the thumbnail, for a keyboard open.
    return () => node.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="attach-preview"
      aria-label={name}
      onClose={onClose}
      // The dialog sits inside the prompt card: a file dragged over the preview must not reach the card's drop.
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        // Anywhere but the picture closes: the backdrop, the margins around it, the ✕.
        if (!(event.target instanceof HTMLImageElement)) onClose();
      }}
    >
      <div className="attach-preview-head">
        <span className="attach-preview-name">{name}</span>
        <button type="button" className="sheet-close" aria-label="Close">
          ✕
        </button>
      </div>
      {/* A chip is clickable until its thumbnail's own error lands; an image that can't decode closes rather than showing broken. */}
      {url !== null && <img className="attach-preview-image" src={url} alt={name} decoding="async" onError={onClose} />}
    </dialog>
  );
}

/**
 * The prompt card's files, above the text: two-row chips with a thumbnail, the name
 * and remove on the first row, size and upload state on the second. Still listed
 * after attaching stops being offered (the leader changed under them), so they can
 * be removed. A click on an image's chip opens it at full size.
 */
function AttachmentChips(props: { view: AttachmentsView; onRemove: (key: string) => void }): JSX.Element | null {
  const { view, onRemove } = props;
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  if (view.files.length === 0 && view.notice === null) return null;
  // Looked up each render, so a file that left the form takes its preview with it.
  const previewed = view.files.find((file) => file.key === previewKey);
  return (
    <div className="attach">
      {view.files.length > 0 && (
        <ul className="attach-list" aria-label={view.summary ?? undefined}>
          {view.files.map((file) => (
            <AttachmentChipItem
              key={file.key}
              file={file}
              removeLocked={view.removeLocked}
              onRemove={onRemove}
              onPreview={setPreviewKey}
            />
          ))}
        </ul>
      )}
      {view.notice !== null && <p className="attach-notice">{view.notice}</p>}
      {previewed !== undefined && previewed.image !== null && (
        <AttachmentPreview
          key={previewed.key}
          name={previewed.name}
          image={previewed.image}
          onClose={() => setPreviewKey(null)}
        />
      )}
    </div>
  );
}

/** Tasks queued with the relay unreachable, waiting on this phone; a refused one offers a retry. */
function HeldList(props: {
  rows: ViewModel["held"];
  dropped: string | null;
  onRetry: (taskId: string) => void;
  onDiscard: (taskId: string) => void;
  onDismissDropped: () => void;
}): JSX.Element {
  return (
    <section className="held card" aria-label="Held on this phone">
      <p className="label">HELD ON THIS PHONE</p>
      {props.dropped !== null && (
        <div className="held-row" role="status">
          <span className="held-text">
            <span className="held-status held-status-err">{props.dropped}</span>
          </span>
          <span className="held-actions">
            <button type="button" className="held-action" onClick={props.onDismissDropped}>
              Dismiss
            </button>
          </span>
        </div>
      )}
      <ul className="held-list">
        {props.rows.map((row) => (
          <li key={row.taskId} className="held-row">
            <span className="held-text">
              <span className="held-title">{row.title}</span>
              <span className="held-sub mono">{row.repo}</span>
              <span className={row.failed ? "held-status held-status-err" : "held-status"}>{row.status}</span>
            </span>
            <span className="held-actions">
              {row.failed && (
                <button type="button" className="held-action" onClick={() => props.onRetry(row.taskId)}>
                  Retry
                </button>
              )}
              <button
                type="button"
                className="held-action"
                disabled={row.sending}
                onClick={() => props.onDiscard(row.taskId)}
              >
                Discard
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The composer bar's paperclip, shown only while attaching is offered. The input stays
 * mounted regardless: returning from a slow pick (Android's multi-select) re-dials the
 * relay, `offered` drops until the leader re-verifies, and an input unmounted then
 * loses the pick's `change`.
 */
function AttachButton(props: {
  offered: boolean;
  locked: boolean;
  onAdd: (files: readonly File[]) => void;
}): JSX.Element {
  const { offered, locked, onAdd } = props;
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      {offered && (
        <button
          type="button"
          className="compose-attach"
          aria-label="Attach files"
          title="Attach files"
          disabled={locked}
          onClick={() => picker.current?.click()}
        >
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l8-8" />
          </svg>
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
    </>
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
  autonomy: AutonomyLevel;
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
    autonomy: selectedAutonomy,
    afterSheet,
    closing,
    onExited,
  } = props;
  const close = actions.dismissLayer;

  if (kind === "after" && afterSheet !== null) {
    return <AfterSheet actions={actions} sheet={afterSheet} closing={closing} onExited={onExited} />;
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

  if (kind === "autonomy") {
    return (
      <Sheet title={SHEET_TITLES.autonomy} closing={closing} onExited={onExited} onClose={close}>
        {AUTONOMY_LEVELS.map((level) => (
          <SheetItem
            key={level}
            label={AUTONOMY_LABELS[level]}
            sub={AUTONOMY_HINTS[level]}
            selected={level === selectedAutonomy}
            onClick={() => actions.setAutonomy(level)}
          />
        ))}
      </Sheet>
    );
  }

  if (kind === "requires") {
    const { choices, note } = view.requires;
    return (
      <Sheet title={SHEET_TITLES.requires} closing={closing} onExited={onExited} onClose={close}>
        {choices.map((choice) => (
          <SheetItem
            key={choice.name}
            label={choice.name}
            sub={choice.holders}
            mono
            selected={choice.selected}
            disabled={choice.disabled}
            onClick={() => actions.toggleRequires(choice.name)}
          />
        ))}
        {choices.length === 0 && <p className="sheet-note">No machine declares a trait.</p>}
        {note !== null && <p className="sheet-note">{note}</p>}
        <p className="sheet-note">
          The task runs only where one exclave declares every trait ticked. A machine declares its traits in its own
          config.json.
        </p>
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
 * The composer's Queue, split when the leader answers `run-now`: two sibling
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
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
      <Menu menu={menu} label="More ways to start">
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
  autonomy: AutonomyLevel;
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
  const { actions, view, form, autonomy, promptUndo, sheet, machines, now, preview, afterSheet, columns } = props;
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
    if (field !== null) fitPrompt(field, promptBackdrop.current, pickerOpen);
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
  // A rewrap stales the fitted height: a width change (window, column layout) or
  // a web font landing after the first fit. Width only, since the fit itself
  // changes the height and would otherwise observe its own write.
  useEffect(() => {
    const field = promptInput.current;
    if (field === null) return;
    const refit = (): void => {
      fitPrompt(field, promptBackdrop.current, pickerOpen);
      syncBackdrop();
    };
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      refit();
    });
    observer.observe(field);
    document.fonts.addEventListener("loadingdone", refit);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", refit);
    };
  }, [pickerOpen]);
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

      <div className="column column-last">
        <div
          className={dropping ? "prompt-card card prompt-card-drop" : "prompt-card card"}
          onDragOver={(event) => {
            if (!carriesFiles(event)) return;
            // Cancelled even when attaching isn't offered: an uncancelled file drop navigates away from the PWA.
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
            if (!carriesFiles(event)) return;
            event.preventDefault();
            // Not gated on `offered`, which drops during a re-dial; the status line says if they can't go.
            actions.addFiles([...(event.dataTransfer?.files ?? [])]);
          }}
        >
          <div className="prompt-head">
            <span className="label" id="prompt-label">
              PROMPT
            </span>
            <PromptAction onClear={clearPrompt} onUndo={undoClear} prompt={form.prompt} undo={promptUndo} />
          </div>
          <AttachmentChips view={view.attachments} onRemove={actions.removeFile} />
          <div
            className={pickerOpen ? "prompt-field prompt-field-compact" : "prompt-field"}
            onClick={(event) => {
              // A stretched card leaves the field taller than the fitted textarea; a tap
              // on that blank stretch is still a tap on the prompt.
              const input = promptInput.current;
              if (event.target !== event.currentTarget || input === null) return;
              input.focus();
              input.setSelectionRange(input.value.length, input.value.length);
            }}
          >
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
                if (files.length === 0) return;
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
          <div className="compose-bar">
            <AttachButton offered={attachOffered} locked={view.attachments.addLocked} onAdd={actions.addFiles} />
            <QueueButton
              view={view}
              preview={view.previewShown ? preview : null}
              onQueue={actions.spawn}
              onStartNow={actions.startNow}
            />
          </div>
        </div>

        {view.formStatus !== null && <p className="compose-status">{view.formStatus}</p>}

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

        {(view.held.length > 0 || view.heldDropped !== null) && (
          <HeldList
            rows={view.held}
            dropped={view.heldDropped}
            onRetry={actions.retryHeld}
            onDiscard={actions.discardHeld}
            onDismissDropped={actions.dismissHeldDropped}
          />
        )}

        <div className="grid">
          <TileButton tile={view.machineTile} offline={offline} onClick={() => actions.openSheet("machine")} />
          <TileButton tile={view.accountTile} onClick={() => actions.openSheet("account")} />
          <TileButton tile={view.repoTile} onClick={() => actions.openSheet("repo")} />
          <TileButton tile={view.modelTile} onClick={() => actions.openSheet("model")} />
          <TileButton tile={view.effortTile} onClick={() => actions.openSheet("effort")} />
          <TileButton tile={view.autonomyTile} onClick={() => actions.openSheet("autonomy")} />
          <TileButton tile={view.afterTile} onClick={() => actions.openSheet("after")} />
          {view.requiresTile !== null && (
            <TileButton tile={view.requiresTile} onClick={() => actions.openSheet("requires")} />
          )}
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

      {renderedSheet !== null && (
        <ActiveSheet
          actions={actions}
          view={view}
          kind={renderedSheet}
          model={form.model}
          effort={form.effort}
          autonomy={autonomy}
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
