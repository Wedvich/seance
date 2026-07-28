import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Setup } from "./components/setup.tsx";
import { SpawnScreen } from "./components/spawn-screen.tsx";
import { VerdictView } from "./components/verdict.tsx";
import { readRelayUrl } from "./relay/keys.ts";
import "./screen.css";
import type { Store } from "./store.ts";
import { deriveView, type AppState } from "./view.ts";

type SetupAnim = "push" | "pop";

export function App(props: { store: Store }): JSX.Element {
  const { store } = props;
  const state = useStoreState(store);
  const [anim, clearAnim] = useSetupTransition(state.setup);

  useEffect(() => store.attach(), [store]);

  useEffect(() => {
    // Back closes a sheet, leaves setup, or leaves the verdict; without this it
    // exits the app, which on Android is the primary dismissal gesture.
    const onPopState = (): void => store.onPopState();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [store]);

  const now = Date.now();
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
      {(anim !== null || !state.setup) && (
        <main key="form" className={panelClass(anim, "push-out", "pop-in")}>
          {state.verdict !== null ? (
            <VerdictView
              verdict={state.verdict}
              machineName={view.machine?.name ?? "that machine"}
              onRetry={() => store.retrySpawn()}
              onAnother={() => store.startAnother()}
              onBack={() => store.dismissLayer()}
            />
          ) : (
            <SpawnScreen store={store} view={view} now={now} />
          )}
        </main>
      )}
      {(anim !== null || state.setup) && (
        <main key="setup" className={panelClass(anim, "push-in", "pop-out")}>
          {/* Both secrets are known to exist: main.tsx only mounts App once they load.
              New credentials mean a new socket and a new key, so the cheapest correct
              move is to boot from scratch. The form is persisted, so nothing is lost. */}
          <Setup
            relayUrl={readRelayUrl()}
            hasBearer
            hasPsk
            onSaved={() => location.reload()}
            onCancel={() => store.dismissLayer()}
          />
        </main>
      )}
    </div>
  );
}

function panelClass(anim: SetupAnim | null, pushing: string, popping: string): string {
  if (anim === null) return "screen stage-panel";
  return `screen stage-panel panel-${anim === "push" ? pushing : popping}`;
}

/**
 * Direction to animate when the setup layer opens ("push") or closes ("pop"),
 * null once the transition has played. useLayoutEffect so the animation
 * classes land before the swapped screen paints — an effect after paint would
 * flash the final state for a frame. The timeout backstops a lost
 * animationend, which would otherwise wedge the stage under
 * pointer-events: none.
 */
function useSetupTransition(setup: boolean): [SetupAnim | null, () => void] {
  const [anim, setAnim] = useState<SetupAnim | null>(null);
  const previous = useRef(setup);

  useLayoutEffect(() => {
    if (setup === previous.current) return;
    previous.current = setup;
    setAnim(setup ? "push" : "pop");
  }, [setup]);

  useEffect(() => {
    if (anim === null) return;
    const timer = setTimeout(() => setAnim(null), 600);
    return () => clearTimeout(timer);
  }, [anim]);

  return [anim, () => setAnim(null)];
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
