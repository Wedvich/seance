import type { JSX } from "preact";
import type { Machine } from "../relay/client.ts";
import {
  EFFORTS,
  EFFORT_LABELS,
  MODELS,
  MODEL_LABELS,
  type Effort,
  type Model,
  type PersistedForm,
  type SheetKind,
} from "../state.ts";
import { abbreviatePath, formatSeen, type ConnectionState, type Tile, type ViewModel } from "../view.ts";
import { RelayDot } from "./relay-dot.tsx";
import { Sheet, SheetItem } from "./sheet.tsx";

const SHEET_TITLES: Record<SheetKind, string> = {
  machine: "Where should it run?",
  repo: "Which repo?",
  model: "Model",
  effort: "Thinking effort",
};

/**
 * What this screen can ask the app to do. A callback set rather than the store
 * itself: the sheets pick, the store decides what picking means — and in
 * particular it, not a component, owns the history push each layer needs to
 * keep Android back symmetrical.
 */
export interface SpawnActions {
  readonly setPrompt: (prompt: string) => void;
  readonly openSettings: () => void;
  readonly openSheet: (sheet: SheetKind) => void;
  readonly toggleWorktree: () => void;
  readonly spawn: () => void;
  readonly dismissLayer: () => void;
  readonly selectMachine: (deviceId: string) => void;
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

function ActiveSheet(props: {
  actions: SpawnActions;
  view: ViewModel;
  kind: SheetKind;
  machines: readonly Machine[];
  model: Model;
  effort: Effort;
  now: number;
}): JSX.Element {
  const { actions, view, kind, machines, model: selectedModel, effort: selectedEffort, now } = props;
  const close = actions.dismissLayer;

  if (kind === "machine") {
    return (
      <Sheet title={SHEET_TITLES.machine} onClose={close}>
        {machines
          .toSorted((a, b) => a.name.localeCompare(b.name))
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
              onClick={() => actions.selectMachine(machine.deviceId)}
            />
          ))}
      </Sheet>
    );
  }

  if (kind === "repo") {
    const paths = view.machine?.repos.map((repo) => repo.path) ?? [];
    const items = (view.machine?.repos ?? [])
      .map((repo) => ({ repo, label: abbreviatePath(repo.path, paths) }))
      .toSorted((a, b) => a.label.localeCompare(b.label));
    return (
      <Sheet title={SHEET_TITLES.repo} onClose={close}>
        {items.map(({ repo, label }) => (
          <SheetItem
            key={repo.name}
            label={label}
            mono
            selected={repo.name === view.repo?.name}
            onClick={() => actions.selectRepo(repo.name)}
          />
        ))}
        <SheetItem
          label="↻ Rescan repos"
          action
          sub={view.machine === null ? null : `last scanned ${formatSeen(view.machine.scannedAt, now)}`}
          onClick={() => {
            actions.dismissLayer();
            actions.rescan();
          }}
        />
      </Sheet>
    );
  }

  if (kind === "model") {
    return (
      <Sheet title={SHEET_TITLES.model} onClose={close}>
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
    <Sheet title={SHEET_TITLES.effort} onClose={close}>
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
  sheet: SheetKind | null;
  machines: readonly Machine[];
  now: number;
}): JSX.Element {
  const { actions, view, form, sheet, machines, now } = props;
  const offline = view.machine !== null && !view.machine.connected;

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
          <span className="label" id="prompt-label">
            PROMPT
          </span>
          <textarea
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
        <button type="button" className="primary" disabled={!view.button.enabled} onClick={actions.spawn}>
          {view.button.label}
        </button>
      </footer>

      {sheet !== null && (
        <ActiveSheet
          actions={actions}
          view={view}
          kind={sheet}
          machines={machines}
          model={form.model}
          effort={form.effort}
          now={now}
        />
      )}
    </>
  );
}
