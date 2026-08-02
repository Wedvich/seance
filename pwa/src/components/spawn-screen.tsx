import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Machine } from "../relay/client.ts";
import {
  EFFORTS,
  EFFORT_LABELS,
  MODELS,
  MODEL_LABELS,
  type Effort,
  type Model,
  type PersistedForm,
  type RescanState,
  type SheetKind,
} from "../state.ts";
import { abbreviatePaths, formatSeen, type ConnectionState, type Tile, type ViewModel } from "../view.ts";
import { RelayDot } from "./relay-dot.tsx";
import { Sheet, SheetItem } from "./sheet.tsx";

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
  readonly openSheet: (sheet: SheetKind) => void;
  readonly toggleWorktree: () => void;
  readonly spawn: () => void;
  readonly dismissLayer: () => void;
  readonly selectMachine: (deviceId: string) => void;
  readonly removeMachine: (deviceId: string) => void;
  readonly selectRepo: (repo: string) => void;
  readonly rescan: () => void;
  readonly setModel: (model: Model) => void;
  readonly setEffort: (effort: Effort) => void;
}

/**
 * Segmented pill: the flat track carries passive relay status, the raised face
 * is the settings action. One button, so the whole pill is the hit target —
 * 4px of padding around a 36px face clears 44px without a hit-area hack.
 */
function RelaySettings(props: { state: ConnectionState; onClick: () => void }): JSX.Element {
  const { state, onClick } = props;
  return (
    <button
      type="button"
      className="relay-group"
      onClick={onClick}
      aria-label="Relay settings"
      title={`Relay: ${state}`}
    >
      <span className="relay-status">
        <RelayDot state={state} />
      </span>
      <span className="relay-cog" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          width="17"
          height="17"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="3.2" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </span>
    </button>
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
        {tile.dot !== null && <span className={tile.dot === "ok" ? "dot dot-ok" : "dot"} />}
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
    return (
      <Sheet title={SHEET_TITLES.machine} closing={closing} onExited={onExited} onClose={close}>
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
              selected={machine.deviceId === view.machine?.deviceId}
              disabled={!machine.connected}
              // Only offered while offline: a connected machine would reappear at once.
              onRemove={machine.connected ? null : () => actions.removeMachine(machine.deviceId)}
              removeLabel={`Hide ${machine.name} until it connects`}
              onClick={() => actions.selectMachine(machine.deviceId)}
            />
          ))}
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
}): JSX.Element {
  const { actions, view, form, promptUndo, sheet, machines, now, rescan } = props;
  const offline = view.machine !== null && !view.machine.connected;
  const [renderedSheet, sheetClosing, unmountSheet] = useSheetExit(sheet);
  const promptInput = useRef<HTMLTextAreaElement>(null);

  // CLEAR leaves nothing to type into, so it drops focus (and the keyboard with
  // it); UNDO hands the field straight back. Focusing before the restore lands
  // leaves the caret at the end of the text, ready to keep writing.
  const clearPrompt = (): void => {
    actions.clearPrompt();
    promptInput.current?.blur();
  };
  const undoClear = (): void => {
    promptInput.current?.focus();
    actions.undoClear();
  };

  return (
    <>
      <header className="header">
        <div>
          <h1 className="header-title">Séance</h1>
          <p className="header-meta">{view.meta}</p>
        </div>
        <RelaySettings state={view.relayState} onClick={actions.openSettings} />
      </header>

      <div className="column">
        <div className="prompt-card card">
          <div className="prompt-head">
            <span className="label" id="prompt-label">
              PROMPT
            </span>
            <PromptAction onClear={clearPrompt} onUndo={undoClear} prompt={form.prompt} undo={promptUndo} />
          </div>
          <textarea
            ref={promptInput}
            className="prompt-input"
            aria-labelledby="prompt-label"
            placeholder="Describe the work — or leave it blank and start empty."
            value={form.prompt}
            onInput={(event) => actions.setPrompt(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
              if (!view.button.enabled) return;
              event.preventDefault();
              actions.spawn();
            }}
          />
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
