import type { ComponentChildren, JSX } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { MachinesScreen } from "./components/machines.tsx";
import { QueueScreen } from "./components/queue.tsx";
import { Settings } from "./components/settings.tsx";
import { SpawnScreen, type SpawnActions } from "./components/spawn-screen.tsx";
import { VerdictView } from "./components/verdict.tsx";
import { readRelayUrl } from "./relay/keys.ts";
import { deriveMachines } from "./machines-view.ts";
import { deriveAfterSheet, deriveQueue } from "./queue-view.ts";
import "./screen.css";
import type { Store } from "./store.ts";
import { screenKey, TransitionRunner } from "./transition.ts";
import { deriveView, type AppState } from "./view.ts";

export function App(props: { store: Store }): JSX.Element {
  const { store } = props;
  const state = useStoreState(store);
  const { layer } = screenKey(state);
  const actions = useSpawnActions(store);
  const wide = useWide(store);

  useEffect(() => store.attach(), [store]);

  useEffect(() => {
    // Back closes a sheet, leaves settings, or leaves the verdict; without this
    // it exits the app, which on Android is the primary dismissal gesture.
    const onPopState = (): void => store.onPopState();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [store]);

  const now = Date.now();
  // A local const: the verdict callbacks close over it, so a button acts on the verdict it was rendered with.
  const verdict = state.verdict;
  const view = deriveView(state, now);

  const formOrVerdict =
    verdict !== null ? (
      <VerdictView
        // A followed task is keyed on its id, so refreshes update the mounted
        // verdict (its stages animate) instead of remounting it. Every other
        // verdict stays keyed on the object, so a new one mounts fresh with its
        // entrance. transition.ts's screenKey mirrors this key.
        key={verdict.kind === "queued" ? `queued:${verdict.task.id}` : verdict}
        verdict={verdict}
        machines={state.relay.machines}
        aliases={state.accounts.aliases}
        now={now}
        onQueue={wide ? undefined : actions.openQueue}
        waitingNote={view.autoAvailability.note}
        onRetry={() => store.retrySpawn(verdict)}
        onAnother={() => store.startAnother()}
        onBack={() => store.dismissLayer()}
      />
    ) : (
      <SpawnScreen
        actions={actions}
        view={view}
        form={state.form}
        promptUndo={state.promptUndo}
        sheet={state.sheet}
        machines={state.relay.machines}
        now={now}
        rescan={state.rescan}
        preview={state.preview}
        afterSheet={state.sheet === "after" ? deriveAfterSheet(state, now) : null}
        columns={wide}
      />
    );
  const queue = (onDismiss?: () => void, onOpenSettings?: () => void): JSX.Element => (
    <QueueScreen
      view={deriveQueue(state, now)}
      relayState={view.relayState}
      notice={state.queueNotice}
      pausing={state.pausing}
      discarding={state.discarding}
      onDismiss={onDismiss}
      onRefresh={() => void store.refreshQueue()}
      onCancel={(id) => void store.cancelTask(id)}
      onMarkDone={(id) => void store.markDone(id)}
      onFollowUp={(id) => store.followUp(id)}
      onPause={() => void store.pauseQueue()}
      onResume={(account) => void store.resumeQueue(account)}
      onDiscard={() => void store.discardUnreadable()}
      onOpenSettings={onOpenSettings}
    />
  );
  // A modal dialog rather than a screen: full-screen on a phone, centred over
  // the columns on a desk.
  const settings = layer === "settings" && (
    <SettingsDialog key="settings" wide={wide} onDismiss={actions.dismissLayer}>
      <main className={wide ? "screen stage-panel" : "screen stage-panel screen-layer-host"}>
        <Settings
          relayUrl={readRelayUrl()}
          relayLine={view.relayLine}
          relayState={view.relayState}
          connected={state.relay.status === "open"}
          closeStyle={wide ? "close" : "back"}
          onDismiss={actions.dismissLayer}
          onReconnect={() => store.reconnect()}
        />
      </main>
    </SettingsDialog>
  );
  const machines = (onDismiss?: () => void): JSX.Element => (
    <MachinesScreen
      view={deriveMachines(
        state.relay.machines,
        now,
        state.relay.scheduler,
        state.accounts.aliases,
        state.relay.fleetQuota,
      )}
      relayLine={view.relayLine}
      relayState={view.relayState}
      settled={state.relay.registrySettled}
      history={state.history}
      accounts={state.accounts}
      onDismiss={onDismiss}
      onShowHistory={(target, range) => void store.showHistory(target, range)}
      onHideHistory={() => store.hideHistory()}
      onRename={(accountId, text) => store.renameAccount(accountId, text)}
      onDismissAccountNotice={() => store.dismissAccountNotice()}
    />
  );

  // Settings stays a layer, a dialog over the columns; queue and machines no
  // longer need to be one.
  if (wide) {
    return (
      <div className="desk">
        <main key="form" className="screen desk-col screen-base-host">
          {formOrVerdict}
        </main>
        <main key="machines" className="screen desk-col">
          {machines()}
        </main>
        <main key="queue" className="screen desk-col">
          {queue(undefined, actions.openSettings)}
        </main>
        {settings}
      </div>
    );
  }

  // Only the current depth renders: a view transition's old screen is a
  // snapshot, so the one leaving never has to stay mounted.
  return (
    <div className="stage">
      {layer === null && (
        <main key="form" className="screen stage-panel screen-base-host">
          {formOrVerdict}
        </main>
      )}
      {layer === "queue" && (
        <main key="queue" className="screen stage-panel screen-layer-host">
          {queue(actions.dismissLayer)}
        </main>
      )}
      {layer === "machines" && (
        <main key="machines" className="screen stage-panel screen-layer-host">
          {machines(actions.dismissLayer)}
        </main>
      )}
      {settings}
    </div>
  );
}

/** Room for three phone-width columns side by side. */
const WIDE_QUERY = "(min-width: 1200px)";

/** Tracks the desktop breakpoint and tells the store, which then reads the queue for a column nobody opened. */
function useWide(store: Store): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  useLayoutEffect(() => {
    const media = window.matchMedia(WIDE_QUERY);
    const sync = (): void => setWide(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => store.setWide(wide), [store, wide]);
  return wide;
}

/**
 * Settings' layer in a native modal dialog: the top layer makes the page behind
 * it inert and turns Escape — and Android's back, which Chrome routes to an open
 * modal before history — into `cancel`. That is cancelled and sent through the
 * store as a history pop, so every way out takes the same path.
 */
function SettingsDialog(props: { wide: boolean; onDismiss: () => void; children: ComponentChildren }): JSX.Element {
  const { wide, onDismiss, children } = props;
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const node = dialog.current;
    if (node === null) return;
    node.showModal();
    // Before removal, so focus goes back to the button that opened it.
    return () => node.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      // On a desk the dialog itself is the transition's layer, so its border and shadow move with the panel.
      className={wide ? "layer-dialog layer-modal screen-layer-host" : "layer-dialog layer-full"}
      aria-label="Settings"
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
      onClick={(event) => {
        // The panel fills the dialog, so only a backdrop click lands on it.
        if (wide && event.target === event.currentTarget) onDismiss();
      }}
    >
      {children}
    </dialog>
  );
}

/**
 * The store's own methods are unbound prototype members, so each one is wrapped
 * here rather than handed over directly. Memoized on the store so the spawn
 * screen's props stay referentially stable across the renders every keystroke
 * causes.
 */
function useSpawnActions(store: Store): SpawnActions {
  return useMemo(
    () => ({
      setPrompt: (prompt) => store.setPrompt(prompt),
      clearPrompt: () => store.clearPrompt(),
      undoClear: () => store.undoClear(),
      openSettings: () => store.openSettings(),
      openQueue: () => store.openQueue(),
      openMachines: () => store.openMachines(),
      openSheet: (sheet) => store.openSheet(sheet),
      toggleWorktree: () => store.toggleWorktree(),
      spawn: () => void store.spawn(),
      dismissLayer: () => store.dismissLayer(),
      pickMachine: (deviceId) => store.pickMachine(deviceId),
      pickAccount: (accountId) => store.pickAccount(accountId),
      refreshPreview: () => void store.refreshPreview(),
      removeMachine: (deviceId) => store.removeMachine(deviceId),
      selectRepo: (repo) => store.selectRepo(repo),
      rescan: (deviceId) => void store.rescan(deviceId),
      setModel: (model) => store.setModel(model),
      setEffort: (effort) => store.setEffort(effort),
      addAfter: (taskId, after) => store.addAfter(taskId, after),
      removeAfter: (taskId) => store.removeAfter(taskId),
      setUntil: (until) => store.setUntil(until),
      setLinearIssue: (issue) => store.setLinearIssue(issue),
      startBatch: (strategy) => store.startBatch(strategy),
      endBatch: () => store.endBatch(),
    }),
    [store],
  );
}

/**
 * Stands in for React's useSyncExternalStore, which preact/hooks has no
 * equivalent of. Preact defers a setState render to a microtask but never
 * renders concurrently, so there is still no torn read to guard; the only gap
 * is a notification landing between render and effect attach, which the offer
 * inside the effect closes.
 *
 * Every store change goes through the transition runner, which is why screen
 * motion starts here rather than in click handlers: closes arrive by popstate
 * and verdicts by the network. `apply` resolves once Preact has committed the
 * DOM (children's layout effects, the dialog's showModal among them, run
 * before this one's), which is the promise a view transition's update
 * callback returns.
 */
function useStoreState(store: Store): AppState {
  const [snap, setSnap] = useState(() => ({ state: store.getState(), seq: 0 }));
  // A list, not one slot: an instant apply landing in the same render must not
  // leave a transition's commit to its backstop.
  const committed = useRef<(() => void)[]>([]);

  useLayoutEffect(() => {
    const waiting = committed.current;
    committed.current = [];
    for (const resolve of waiting) resolve();
  }, [snap.seq]);

  useEffect(() => {
    const apply = (state: AppState): Promise<void> =>
      new Promise<void>((resolve) => {
        committed.current.push(resolve);
        // seq forces a render even for an identical state, so the promise always settles.
        setSnap((current) => ({ state, seq: current.seq + 1 }));
        // Backstop for a render that throws or is dropped: the browser would
        // otherwise hold the screen frozen until its own update timeout.
        setTimeout(resolve, 100);
      });
    const runner = new TransitionRunner<AppState>(screenKey(store.getState()), {
      start: typedViewTransitions()
        ? (options) => document.startViewTransition({ update: options.update, types: options.types })
        : undefined,
      reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      hidden: () => document.visibilityState === "hidden",
      apply,
    });
    const offer = (): void => {
      const state = store.getState();
      runner.offer(state, screenKey(state));
    };
    offer();
    return store.subscribe(offer);
  }, [store]);

  return snap.state;
}

/**
 * One test for both things screen.css relies on: the object form of
 * startViewTransition and the type selectors ship together. A browser with
 * only the Level 1 callback form gets an instant swap rather than the
 * browser's unstyled default crossfades.
 */
function typedViewTransitions(): boolean {
  return typeof CSS !== "undefined" && CSS.supports("selector(:active-view-transition-type(x))");
}
