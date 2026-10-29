import { render } from "preact";
import "./base.css";
import { App } from "./app.tsx";
import { Booting } from "./components/booting.tsx";
import { Setup } from "./components/setup.tsx";
import { markKeys, markScript, recordLaunch } from "./launch.ts";
import { dropLegacyHidden, dropLegacyPending, readForm, readHeld, writeForm, writeHeld } from "./persist.ts";
import { deriveAccountKey, FLEET_QUOTA_INTERVAL_MS, RelayClient } from "@seance/shared";
import { loadPsk, loadPskBase, readBearer, readRelayUrl } from "./relay/keys.ts";
import "./screen.css";
import type { PersistedForm } from "./state.ts";
import { Store } from "./store.ts";
import { registerServiceWorker } from "./sw.ts";
import { watchSystemTheme } from "./theme.ts";

const PERSIST_DEBOUNCE_MS = 300;

markScript();
watchSystemTheme();
registerServiceWorker();

// Prompts are the one thing here the user authored, so make eviction unlikely.
void navigator.storage?.persist?.();

const container = document.querySelector("#root");
if (container === null) throw new Error("#root is missing from index.html");

// Before the key store is read: on a cold start that read can take seconds, and it used to be a blank screen.
render(<Booting />, container);

markKeys("from");
const [key, base] = await Promise.all([loadPsk(), loadPskBase()]);
markKeys("to");
const token = readBearer();

if (key === null || token === null) {
  render(
    <main className="screen">
      <Setup
        relayUrl={readRelayUrl()}
        hasBearer={token !== null}
        hasPsk={key !== null}
        onSaved={() => location.reload()}
      />
    </main>,
    container,
  );
} else {
  dropLegacyHidden();
  dropLegacyPending();
  // No base on an install saved before account records: it works, without aliases, until the PSK is re-entered.
  // A derivation that throws degrades the same way: naming is an extra, and must not take the app down.
  const accountKey = base === null ? null : await deriveAccountKey(base).catch(() => null);
  // Only the Machines screen folds the fleet quota record; it is polled because the relay nudges apps for no `quota:` write.
  const client = new RelayClient({
    url: readRelayUrl(),
    token,
    key,
    fleetQuotaRefreshMs: FLEET_QUOTA_INTERVAL_MS,
    ...(accountKey === null ? {} : { accountKey }),
  });
  const store = new Store(client, readForm(), readHeld());

  // Debounced because the store notifies on every keystroke in the prompt. Only a new
  // form is written: most notifies (relay status beats) leave it the same object. The
  // first is written whatever it is, so a legacy saved shape `readForm` dropped fields
  // from is rewritten once per load, as before. Held tasks are not debounced: one lost
  // to a kill inside the debounce would never run, and they change once per queue.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let written: PersistedForm | null = null;
  let held = store.getState().held;
  store.subscribe(() => {
    const state = store.getState();
    if (state.held !== held) {
      held = state.held;
      writeHeld(held);
    }
    if (state.form === written) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      written = store.getState().form;
      writeForm(written);
    }, PERSIST_DEBOUNCE_MS);
  });

  client.start();
  render(<App store={store} />, container);
}
recordLaunch();
