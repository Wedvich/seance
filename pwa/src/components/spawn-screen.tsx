import type { JSX, TargetedKeyboardEvent } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Machine } from "@seance/shared";
import { describeDecision } from "../decision-view.ts";
import {
  EFFORTS,
  EFFORT_LABELS,
  MODELS,
  MODEL_LABELS,
  type Effort,
  type Model,
  type PersistedForm,
  type PreviewState,
  type RescanState,
  type SheetKind,
} from "../state.ts";
import { completeSkill, matchSkills, promptSegments, skillIndex, skillToken } from "../skills.ts";
import { abbreviatePaths, formatSeen, type Tile, type ViewModel } from "../view.ts";
import { DecisionCard } from "./decision.tsx";
import { HeaderMenu } from "./header-menu.tsx";
import { dotClass, Sheet, SheetItem } from "./sheet.tsx";
import { SkillPicker, skillOptionId } from "./skill-picker.tsx";

const SKILL_LIST_ID = "skill-list";

/** One collator for every sheet sort; constructing one per comparison is not free. */
const collator = new Intl.Collator();

const SHEET_TITLES: Record<SheetKind, string> = {
  machine: "Where should it run?",
  repo: "Which repo?",
  model: "Which model?",
  effort: "How much effort?",
};

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
  readonly dismissLayer: () => void;
  readonly selectMachine: (deviceId: string) => void;
  readonly selectAuto: () => void;
  readonly refreshPreview: () => void;
  readonly removeMachine: (deviceId: string) => void;
  readonly selectRepo: (repo: string) => void;
  readonly rescan: () => void;
  readonly setModel: (model: Model) => void;
  readonly setEffort: (effort: Effort) => void;
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

/**
 * Its own component so the labelling can sit behind a hook: the sheet re-renders
 * on every store patch, but the labels only move when the machine does.
 */
function RepoSheet(props: {
  actions: SpawnActions;
  machine: Machine | null;
  selected: string | null;
  rescan: RescanState;
  closing: boolean;
  onExited: () => void;
  now: number;
}): JSX.Element {
  const { actions, machine, selected, rescan, closing, onExited, now } = props;
  // Keyed on the machine, which every finished rescan replaces (changed or
  // not) — so rescans relabel, and unrelated store patches do not.
  const items = useMemo(() => {
    const repos = machine?.repos ?? [];
    const labels = abbreviatePaths(repos.map((repo) => repo.path));
    return repos
      .map((repo) => ({ repo, label: labels.get(repo.path) ?? repo.path }))
      .toSorted((a, b) => collator.compare(a.label, b.label));
  }, [machine]);

  return (
    <Sheet title={SHEET_TITLES.repo} closing={closing} onExited={onExited} onClose={actions.dismissLayer}>
      {items.map(({ repo, label }) => (
        <SheetItem
          key={repo.name}
          label={label}
          mono
          selected={repo.name === selected}
          onClick={() => actions.selectRepo(repo.name)}
        />
      ))}
      <SheetItem
        label="↻ Rescan repos"
        action
        disabled={rescan === "scanning"}
        sub={
          rescan === "scanning"
            ? "scanning…"
            : machine === null
              ? null
              : `last scanned ${formatSeen(machine.scannedAt, now)}`
        }
        onClick={actions.rescan}
      />
      {rescan === "failed" && <p className="sheet-note">Couldn't rescan — this is the last known list.</p>}
    </Sheet>
  );
}

function ActiveSheet(props: {
  actions: SpawnActions;
  view: ViewModel;
  kind: SheetKind;
  machines: readonly Machine[];
  model: Model;
  effort: Effort;
  rescan: RescanState;
  /** True while the exit animation plays; the sheet is already popped from state. */
  closing: boolean;
  onExited: () => void;
  now: number;
}): JSX.Element {
  const {
    actions,
    view,
    kind,
    machines,
    model: selectedModel,
    effort: selectedEffort,
    now,
    rescan,
    closing,
    onExited,
  } = props;
  const close = actions.dismissLayer;

  if (kind === "machine") {
    const auto = view.autoAvailability;
    return (
      <Sheet title={SHEET_TITLES.machine} closing={closing} onExited={onExited} onClose={close}>
        <SheetItem
          label="Auto"
          sub={auto.reason ?? auto.note ?? "the scheduler picks the machine"}
          dot={auto.available ? "auto" : "off"}
          selected={view.auto !== null}
          disabled={!auto.available}
          onClick={actions.selectAuto}
        />
        {machines
          .toSorted((a, b) => collator.compare(a.name, b.name))
          .map((machine) => (
            <SheetItem
              key={machine.deviceId}
              label={machine.name}
              sub={
                machine.connected
                  ? `online · ${machine.repos.length} ${machine.repos.length === 1 ? "repo" : "repos"}`
                  : `offline · last seen ${formatSeen(machine.lastSeen, now)}`
              }
              dot={machine.connected ? "ok" : "off"}
              selected={view.auto === null && machine.deviceId === view.machine?.deviceId}
              disabled={!machine.connected}
              // Only offered while offline: the relay refuses to forget a machine
              // it holds a socket for, so on a connected row it would do nothing.
              onRemove={machine.connected ? null : () => actions.removeMachine(machine.deviceId)}
              removeLabel={`Forget ${machine.name}`}
              onClick={() => actions.selectMachine(machine.deviceId)}
            />
          ))}
      </Sheet>
    );
  }

  if (kind === "repo" && view.auto !== null) {
    const selected = view.auto.repo?.origin ?? null;
    return (
      <Sheet title={SHEET_TITLES.repo} closing={closing} onExited={onExited} onClose={close}>
        {view.auto.repos.map((repo) => (
          <SheetItem
            key={repo.origin}
            label={repo.label}
            mono
            sub={repo.origin === repo.label ? null : repo.origin}
            selected={repo.origin === selected}
            onClick={() => actions.selectRepo(repo.origin)}
          />
        ))}
        {view.auto.repos.length === 0 && <p className="sheet-note">No machine reports a clone with an origin.</p>}
      </Sheet>
    );
  }

  if (kind === "repo") {
    return (
      <RepoSheet
        actions={actions}
        machine={view.machine}
        selected={view.repo?.name ?? null}
        rescan={rescan}
        closing={closing}
        onExited={onExited}
        now={now}
      />
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

export function SpawnScreen(props: {
  actions: SpawnActions;
  view: ViewModel;
  form: PersistedForm;
  /** Text a CLEAR stashed; non-null for as long as UNDO is on offer. */
  promptUndo: string | null;
  sheet: SheetKind | null;
  machines: readonly Machine[];
  now: number;
  rescan: RescanState;
  preview: PreviewState | null;
  /** Desktop layout: the queue is a column of its own and the settings pill sits in its header. */
  columns: boolean;
}): JSX.Element {
  const { actions, view, form, promptUndo, sheet, machines, now, rescan, preview, columns } = props;
  const offline = view.auto === null && view.machine !== null && !view.machine.connected;
  const [renderedSheet, sheetClosing, unmountSheet] = useSheetExit(sheet);
  const promptInput = useRef<HTMLTextAreaElement>(null);

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
        <div className="prompt-card card">
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
          <TileButton tile={view.repoTile} onClick={() => actions.openSheet("repo")} />
          <TileButton tile={view.modelTile} onClick={() => actions.openSheet("model")} />
          <TileButton tile={view.effortTile} onClick={() => actions.openSheet("effort")} />
        </div>

        {view.ignoredNote !== null && <p className="ignored-note">{view.ignoredNote}</p>}

        {view.auto !== null && (
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
      </div>

      <footer className="footer">
        <p className="footer-status">{view.footerStatus}</p>
        <button
          type="button"
          className={view.button.busy ? "primary primary-busy" : "primary"}
          disabled={!view.button.enabled}
          onClick={actions.spawn}
        >
          {view.button.label}
        </button>
      </footer>

      {renderedSheet !== null && (
        <ActiveSheet
          actions={actions}
          view={view}
          kind={renderedSheet}
          machines={machines}
          model={form.model}
          effort={form.effort}
          now={now}
          rescan={rescan}
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
