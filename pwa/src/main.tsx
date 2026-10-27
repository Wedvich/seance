import { render } from "preact";
import "./base.css";
import { App } from "./app.tsx";
import { Setup } from "./components/setup.tsx";
import { dropLegacyHidden, dropLegacyPending, readForm, writeForm } from "./persist.ts";
import { deriveAccountKey, FLEET_QUOTA_INTERVAL_MS, RelayClient } from "@seance/shared";
import { loadPsk, loadPskBase, readBearer, readRelayUrl } from "./relay/keys.ts";
import "./screen.css";
import { watchPushResync } from "./push-browser.ts";
import { Store } from "./store.ts";
import { registerServiceWorker } from "./sw.ts";
import { watchSystemTheme } from "./theme.ts";

const PERSIST_DEBOUNCE_MS = 300;

watchSystemTheme();
registerServiceWorker();

// Prompts are the one thing here the user authored, so make eviction unlikely.
void navigator.storage?.persist?.();

const container = document.querySelector("#root");
if (container === null) throw new Error("#root is missing from index.html");

const [key, base] = await Promise.all([loadPsk(), loadPskBase()]);
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
  const store = new Store(client, readForm());

  // Debounced because the store notifies on every keystroke in the prompt.
  let timer: ReturnType<typeof setTimeout> | null = null;
  store.subscribe(() => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      writeForm(store.getState().form);
    }, PERSIST_DEBOUNCE_MS);
  });

  client.start();
  watchPushResync(client);
  render(<App store={store} push={client} />, container);
}
