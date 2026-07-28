import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Setup } from "./components/setup.tsx";
import { SpawnScreen } from "./components/spawn-screen.tsx";
import { VerdictView } from "./components/verdict.tsx";
import { readRelayUrl } from "./relay/keys.ts";
import "./screen.css";
import type { Store } from "./store.ts";
import { deriveView, type AppState } from "./view.ts";

export function App(props: { store: Store }): JSX.Element {
  const { store } = props;
  const state = useStoreState(store);

  useEffect(() => store.attach(), [store]);

  useEffect(() => {
    // Back closes a sheet, leaves setup, or leaves the verdict; without this it
    // exits the app, which on Android is the primary dismissal gesture.
    const onPopState = (): void => store.onPopState();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [store]);

  if (state.setup) {
    return (
      <main className="screen">
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
    );
  }

  const now = Date.now();
  const view = deriveView(state, now);

  if (state.verdict !== null) {
    return (
      <main className="screen">
        <VerdictView
          verdict={state.verdict}
          machineName={view.machine?.name ?? "that machine"}
          onRetry={() => store.retrySpawn()}
          onAnother={() => store.startAnother()}
          onBack={() => store.dismissLayer()}
        />
      </main>
    );
  }

  return (
    <main className="screen">
      <SpawnScreen store={store} view={view} now={now} />
    </main>
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
