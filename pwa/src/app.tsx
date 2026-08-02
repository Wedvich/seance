import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { Settings } from "./components/settings.tsx";
import { SpawnScreen, type SpawnActions } from "./components/spawn-screen.tsx";
import { VerdictView } from "./components/verdict.tsx";
import { readRelayUrl } from "./relay/keys.ts";
import "./screen.css";
import type { Verdict } from "./state.ts";
import type { Store } from "./store.ts";
import { deriveView, type AppState } from "./view.ts";

type ScreenAnim = "push" | "pop";

export function App(props: { store: Store }): JSX.Element {
  const { store } = props;
  const state = useStoreState(store);
  const [anim, clearAnim] = useScreenTransition(state.settings);
  const exit = useVerdictExit(state.verdict);
  const actions = useSpawnActions(store);

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

  // Both screens stay mounted while a transition plays; push and pop are
  // mirrored full-width slides.
  return (
    <div
      className={anim === null ? "stage" : "stage stage-animating"}
      onAnimationEnd={(event) => {
        if (event.animationName.startsWith("screen-")) clearAnim();
      }}
    >
      {(anim !== null || !state.settings) && (
        <main key="form" className={`${panelClass(anim, "push-out", "pop-in")}${exit.entering ? " form-enter" : ""}`}>
          {rendered !== null ? (
            <VerdictView
              key={rendered}
              verdict={rendered}
              machineName={view.machine?.name ?? "that machine"}
              closing={exit.closing}
              onExited={exit.onExited}
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
              sheet={state.sheet}
              machines={state.relay.machines}
              hidden={state.relay.hidden}
              now={now}
              rescan={state.rescan}
            />
          )}
        </main>
      )}
      {(anim !== null || state.settings) && (
        <main key="settings" className={panelClass(anim, "push-in", "pop-out")}>
          <Settings
            relayUrl={readRelayUrl()}
            relayLine={view.relayLine}
            relayState={view.relayState}
            connected={state.relay.status === "open"}
            onDismiss={actions.dismissLayer}
            onReconnect={() => store.reconnect()}
          />
        </main>
      )}
    </div>
  );
}

function panelClass(anim: ScreenAnim | null, pushing: string, popping: string): string {
  if (anim === null) return "screen stage-panel";
  return `screen stage-panel panel-${anim === "push" ? pushing : popping}`;
}

/**
 * Direction to animate when the settings screen opens ("push") or closes
 * ("pop"), null once the transition has played. useLayoutEffect so the
 * animation classes land before the swapped screen paints — an effect after
 * paint would flash the final state for a frame. The timeout backstops a lost
 * animationend, which would otherwise wedge the stage under
 * pointer-events: none.
 */
function useScreenTransition(settings: boolean): [ScreenAnim | null, () => void] {
  const [anim, setAnim] = useState<ScreenAnim | null>(null);
  const previous = useRef(settings);

  useLayoutEffect(() => {
    if (settings === previous.current) return;
    previous.current = settings;
    setAnim(settings ? "push" : "pop");
  }, [settings]);

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
      openSettings: () => store.openSettings(),
      openSheet: (sheet) => store.openSheet(sheet),
      toggleWorktree: () => store.toggleWorktree(),
      spawn: () => void store.spawn(),
      dismissLayer: () => store.dismissLayer(),
      selectMachine: (deviceId) => store.selectMachine(deviceId),
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
