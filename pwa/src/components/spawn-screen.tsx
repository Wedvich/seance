import type { JSX } from "preact";
import { EFFORTS, EFFORT_LABELS, MODELS, MODEL_LABELS, type SheetKind } from "../state.ts";
import type { Store } from "../store.ts";
import { abbreviatePath, formatSeen, type Tile, type ViewModel } from "../view.ts";
import { readRelayUrl } from "../relay/keys.ts";
import { SettingsSheet } from "./settings.tsx";
import { Sheet, SheetItem } from "./sheet.tsx";

const SHEET_TITLES: Record<SheetKind, string> = {
  machine: "Where should it run?",
  repo: "Which repo?",
  model: "Model",
  effort: "Thinking effort",
  settings: "Settings",
};

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

function ActiveSheet(props: { store: Store; view: ViewModel; kind: SheetKind; now: number }): JSX.Element {
  const { store, view, kind, now } = props;
  const close = (): void => store.dismissLayer();
  const state = store.getState();

  if (kind === "machine") {
    return (
      <Sheet title={SHEET_TITLES.machine} onClose={close}>
        {state.relay.machines.map((machine) => (
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
            onClick={() => store.selectMachine(machine.deviceId)}
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
            onClick={() => store.selectRepo(repo.name)}
          />
        ))}
        <SheetItem
          label="↻ Rescan repos"
          action
          sub={view.machine === null ? null : `last scanned ${formatSeen(view.machine.scannedAt, now)}`}
          onClick={() => {
            store.dismissLayer();
            void store.rescan();
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
            selected={model === state.form.model}
            onClick={() => store.setModel(model)}
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
          selected={effort === state.form.effort}
          onClick={() => store.setEffort(effort)}
        />
      ))}
    </Sheet>
  );
}

export function SpawnScreen(props: { store: Store; view: ViewModel; now: number }): JSX.Element {
  const { store, view, now } = props;
  const state = store.getState();
  const offline = view.machine !== null && !view.machine.connected;

  return (
    <>
      <header className="header">
        <div>
          <h1 className="header-title">Séance</h1>
          <p className="header-meta">{view.meta}</p>
        </div>
        <button
          type="button"
          className="relay-chip"
          onClick={() => store.openSheet("settings")}
          aria-label="Relay and settings"
        >
          <span className={view.relayOk ? "dot dot-ok" : "dot dot-err"} />
          relay
        </button>
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
            value={state.form.prompt}
            onInput={(event) => store.setPrompt(event.currentTarget.value)}
          />
        </div>

        {view.banner !== null &&
          (view.banner.opensSetup ? (
            <button
              type="button"
              className={view.banner.tone === "err" ? "banner card banner-err" : "banner card"}
              onClick={() => store.openSetup()}
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
          <TileButton tile={view.machineTile} offline={offline} onClick={() => store.openSheet("machine")} />
          <TileButton tile={view.repoTile} onClick={() => store.openSheet("repo")} />
          <TileButton tile={view.modelTile} onClick={() => store.openSheet("model")} />
          <TileButton tile={view.effortTile} onClick={() => store.openSheet("effort")} />
        </div>

        {view.ignoredNote !== null && <p className="ignored-note">{view.ignoredNote}</p>}

        <button
          type="button"
          className="worktree card"
          onClick={() => store.toggleWorktree()}
          role="switch"
          aria-checked={state.form.worktree}
        >
          <span className="worktree-text">
            <span className="worktree-title">Fresh worktree</span>
            <span className="worktree-hint">{view.worktreeHint}</span>
          </span>
          <span className={state.form.worktree ? "toggle toggle-on" : "toggle"} aria-hidden="true">
            <span className="toggle-knob" />
          </span>
        </button>
      </div>

      <footer className="footer">
        <p className="footer-status">{view.footerStatus}</p>
        <button type="button" className="primary" disabled={!view.button.enabled} onClick={() => void store.spawn()}>
          {view.button.label}
        </button>
      </footer>

      {state.sheet === "settings" ? (
        <SettingsSheet
          relayUrl={readRelayUrl()}
          relayStatus={state.relay.status}
          onClose={() => store.dismissLayer()}
          onOpenSetup={() => store.openSetup()}
          onReconnect={() => {
            store.dismissLayer();
            store.reconnect();
          }}
        />
      ) : (
        state.sheet !== null && <ActiveSheet store={store} view={view} kind={state.sheet} now={now} />
      )}
    </>
  );
}
