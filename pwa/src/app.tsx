import { useEffect, useSyncExternalStore } from "react";
import { SpawnScreen } from "./components/spawn-screen.tsx";
import { VerdictView } from "./components/verdict.tsx";
import "./screen.css";
import type { Store } from "./store.ts";
import { deriveView } from "./view.ts";

export function App(props: { store: Store }): React.JSX.Element {
  const { store } = props;
  const state = useSyncExternalStore(store.subscribe, store.getState);

  useEffect(() => store.attach(), [store]);

  useEffect(() => {
    // Back closes a sheet or leaves the verdict; without this it exits the app,
    // which on Android is the primary dismissal gesture.
    const onPopState = (): void => store.onPopState();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [store]);

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
      <SpawnScreen store={store} view={view} now={now} />
    </div>
  );
}
