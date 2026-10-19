import type { ComponentChildren, JSX } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { MachinesScreen } from "./components/machines.tsx";
import { QueueScreen } from "./components/queue.tsx";
import { Settings } from "./components/settings.tsx";
import { SpawnScreen, type SpawnActions } from "./components/spawn-screen.tsx";
import { VerdictView } from "./components/verdict.tsx";
import { readRelayUrl } from "./relay/keys.ts";
import { deriveMachines } from "./machines-view.ts";
import { deriveQueue } from "./queue-view.ts";
import "./screen.css";
import type { Verdict } from "./state.ts";
import type { Store } from "./store.ts";
import { deriveView, type AppState } from "./view.ts";

/** Pushed screens in stack order; the spawn form is depth 0. */
type Depth = 0 | 1;

/** The layers the phone's header menu opens, each straight over the form. */
type DepthOne = "settings" | "queue" | "machines";

interface ScreenAnim {
  readonly from: Depth;
  readonly to: Depth;
}

export function App(props: { store: Store }): JSX.Element {
  const { store } = props;
  const state = useStoreState(store);
  const depth: Depth = state.settings || state.queue || state.machines ? 1 : 0;
  const depthOne = useDepthOne(state);
  const [anim, clearAnim] = useScreenTransition(depth);
  const shown = (screen: Depth): boolean => screen === depth || screen === anim?.from;
  const exit = useVerdictExit(state.verdict);
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
  // A local const, not `exit.rendered` inline: the verdict callbacks close over
  // it, and it is the copy the buttons belong to.
  const rendered = exit.rendered;
  const view = deriveView(state, now);

  const formOrVerdict =
    rendered !== null ? (
      <VerdictView
        // A followed task is keyed on its id, so refreshes update the mounted
        // verdict (its stages animate) instead of remounting it. Every other
        // verdict stays keyed on the object: a retry whose failure lands inside
        // the exit animation is a new verdict and must mount fresh, not snap the
        // half-dismissed one back.
        key={rendered.kind === "queued" ? `queued:${rendered.task.id}` : rendered}
        verdict={rendered}
        machineName={view.machine?.name ?? "that machine"}
        machines={state.relay.machines}
        now={now}
        closing={exit.closing}
        onExited={exit.onExited}
        onQueue={actions.openQueue}
        waitingNote={view.autoAvailability.note}
        onRetry={() => store.retrySpawn(rendered)}
        onAnother={() => store.startAnother()}
        onReuse={() => store.reusePrompt(rendered)}
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
        columns={wide}
      />
    );
  const queue = (onDismiss?: () => void, onOpenSettings?: () => void): JSX.Element => (
    <QueueScreen
      view={deriveQueue(state, now)}
      relayState={view.relayState}
      machines={state.relay.machines}
      now={now}
      notice={state.queueNotice}
      pausing={state.pausing}
      discarding={state.discarding}
      onDismiss={onDismiss}
      onRefresh={() => void store.refreshQueue()}
      onCancel={(id) => void store.cancelTask(id)}
      onMarkDone={(id) => void store.markDone(id)}
      onPause={() => void store.pauseQueue()}
      onResume={(account) => void store.resumeQueue(account)}
      onDiscard={() => void store.discardUnreadable()}
      onOpenSettings={onOpenSettings}
    />
  );
  // A modal dialog rather than a screen: full-screen on a phone, centred over
  // the columns on a desk.
  const settings = shown(1) && depthOne === "settings" && (
    <SettingsDialog key="settings" wide={wide} anim={anim} onDismiss={actions.dismissLayer}>
      <main className={wide ? "screen stage-panel" : panelClass(anim, 1)}>
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
      view={deriveMachines(state.relay.machines, now, state.relay.scheduler)}
      relayLine={view.relayLine}
      relayState={view.relayState}
      settled={state.relay.registrySettled}
      history={state.history}
      onDismiss={onDismiss}
      onShowHistory={(target, range) => void store.showHistory(target, range)}
      onHideHistory={() => store.hideHistory()}
    />
  );

  // Settings stays a layer, a dialog over the columns; queue and machines no
  // longer need to be one.
  if (wide) {
    return (
      <div
        className="desk"
        onAnimationEnd={(event) => {
          if (event.animationName.startsWith("screen-")) clearAnim();
        }}
      >
        <main key="form" className={`screen desk-col${exit.entering ? " form-enter" : ""}`}>
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

  // Both ends of a transition stay mounted while it plays; push and pop are
  // mirrored full-width slides.
  return (
    <div
      className={anim === null ? "stage" : "stage stage-animating"}
      onAnimationEnd={(event) => {
        if (event.animationName.startsWith("screen-")) clearAnim();
      }}
    >
      {shown(0) && (
        <main key="form" className={`${panelClass(anim, 0)}${exit.entering ? " form-enter" : ""}`}>
          {formOrVerdict}
        </main>
      )}
      {shown(1) && depthOne === "queue" && (
        <main key="queue" className={panelClass(anim, 1)}>
          {queue(actions.dismissLayer)}
        </main>
      )}
      {shown(1) && depthOne === "machines" && (
        <main key="machines" className={panelClass(anim, 1)}>
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
 * store as a history pop, so every way out takes the same path. Stays open while
 * its panel is still on stage, so the close animation plays in it.
 */
function SettingsDialog(props: {
  wide: boolean;
  anim: ScreenAnim | null;
  onDismiss: () => void;
  children: ComponentChildren;
}): JSX.Element {
  const { wide, anim, onDismiss, children } = props;
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const node = dialog.current;
    if (node === null) return;
    node.showModal();
    // Before removal, so focus goes back to the button that opened it.
    return () => node.close();
  }, []);

  const motion = wide && anim !== null ? (anim.to === 0 ? " layer-modal-out" : " layer-modal-in") : "";
  return (
    <dialog
      ref={dialog}
      className={`layer-dialog ${wide ? "layer-modal" : "layer-full"}${motion}`}
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
 * Which depth-1 screen showed last, so a pop animation keeps rendering the one
 * that is leaving after its flag has already cleared.
 */
function useDepthOne(state: AppState): DepthOne {
  const [which, setWhich] = useState<DepthOne>("settings");
  const next = state.queue ? "queue" : state.machines ? "machines" : state.settings ? "settings" : null;
  useLayoutEffect(() => {
    if (next !== null && next !== which) setWhich(next);
  }, [next, which]);
  return next ?? which;
}

/** The deeper of the two screens is the one sliding; the shallower gives way under it. */
function panelClass(anim: ScreenAnim | null, screen: Depth): string {
  if (anim === null) return "screen stage-panel";
  const pushing = anim.to > anim.from;
  const role = screen === anim.to ? (pushing ? "push-in" : "pop-in") : pushing ? "push-out" : "pop-out";
  return `screen stage-panel panel-${role}`;
}

/**
 * The screens to animate between when the stack moves, null once the
 * transition has played. useLayoutEffect so the animation classes land before
 * the swapped screen paints — an effect after paint would flash the final state
 * for a frame. The timeout backstops a lost animationend, which would otherwise
 * wedge the stage under pointer-events: none.
 */
function useScreenTransition(depth: Depth): [ScreenAnim | null, () => void] {
  const [anim, setAnim] = useState<ScreenAnim | null>(null);
  const previous = useRef(depth);

  useLayoutEffect(() => {
    if (depth === previous.current) return;
    setAnim({ from: previous.current, to: depth });
    previous.current = depth;
  }, [depth]);

  useEffect(() => {
    if (anim === null) return;
    const timer = setTimeout(() => setAnim(null), 600);
    return () => clearTimeout(timer);
  }, [anim]);

  return [anim, () => setAnim(null)];
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
      selectMachine: (deviceId) => store.selectMachine(deviceId),
      selectAuto: () => store.selectAuto(),
      refreshPreview: () => void store.refreshPreview(),
      removeMachine: (deviceId) => store.removeMachine(deviceId),
      selectRepo: (repo) => store.selectRepo(repo),
      rescan: () => void store.rescan(),
      setModel: (model) => store.setModel(model),
      setEffort: (effort) => store.setEffort(effort),
    }),
    [store],
  );
}

/**
 * Stands in for React's useSyncExternalStore, which preact/hooks has no
 * equivalent of. Preact renders synchronously, so there is no torn-read window
 * to guard against; the only gap is a notification landing between render and
 * effect attach, which the resync inside the effect closes.
 */
function useStoreState(store: Store): AppState {
  const [state, setState] = useState(store.getState);
  useEffect(() => {
    setState(store.getState());
    return store.subscribe(() => setState(store.getState()));
  }, [store]);
  return state;
}

interface VerdictExit {
  readonly rendered: Verdict | null;
  readonly closing: boolean;
  readonly entering: boolean;
  readonly onExited: () => void;
}

/**
 * Fade-through for verdict dismissal: the verdict stays mounted while its exit
 * animation plays, then the form fades in — instead of a single-frame swap.
 * The timeout backstops a lost animationend, as with the sheets.
 */
function useVerdictExit(verdict: Verdict | null): VerdictExit {
  const [rendered, setRendered] = useState(verdict);
  const [entering, setEntering] = useState(false);

  useLayoutEffect(() => {
    if (verdict !== null) setRendered(verdict);
  }, [verdict]);

  const closing = verdict === null && rendered !== null;
  const exited = (): void => {
    setRendered(null);
    setEntering(true);
  };

  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(exited, 300);
    return () => clearTimeout(timer);
  }, [closing]);

  useEffect(() => {
    if (!entering) return;
    const timer = setTimeout(() => setEntering(false), 300);
    return () => clearTimeout(timer);
  }, [entering]);

  return { rendered, closing, entering, onExited: exited };
}
