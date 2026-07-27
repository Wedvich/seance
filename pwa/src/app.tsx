import { useEffect, useState, useSyncExternalStore } from "react";
import { Setup } from "./components/setup.tsx";
import { SpawnScreen } from "./components/spawn-screen.tsx";
import { VerdictView } from "./components/verdict.tsx";
import { readRelayUrl } from "./relay/keys.ts";
import "./screen.css";
import type { Store } from "./store.ts";
import { deriveView } from "./view.ts";

export function App(props: { store: Store }): React.JSX.Element {
  const { store } = props;
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [setupOpen, setSetupOpen] = useState(false);

  useEffect(() => store.attach(), [store]);

  useEffect(() => {
    // Back closes a sheet or leaves the verdict; without this it exits the app,
    // which on Android is the primary dismissal gesture.
    const onPopState = (): void => store.onPopState();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [store]);

  if (setupOpen) {
    return (
      <div className="screen">
        {/* New credentials mean a new socket and a new key, so the cheapest correct
            move is to boot from scratch. The form is persisted, so nothing is lost. */}
        <Setup relayUrl={readRelayUrl()} onSaved={() => location.reload()} />
      </div>
    );
  }

  const now = Date.now();
  const view = deriveView(state, now);

  if (state.verdict !== null) {
    return (
      <div className="screen">
        <VerdictView
          verdict={state.verdict}
          machineName={view.machine?.name ?? "that machine"}
          onRetry={() => store.retrySpawn()}
          onAnother={() => store.startAnother()}
          onBack={() => store.dismissLayer()}
        />
      </div>
    );
  }

  return (
    <div className="screen">
      <SpawnScreen
        store={store}
        view={view}
        now={now}
        onOpenSetup={() => {
          store.dismissLayer();
          setSetupOpen(true);
        }}
      />
    </div>
  );
}
