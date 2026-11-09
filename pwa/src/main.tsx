import { render } from "preact";
import "./base.css";
import { App } from "./app.tsx";
import { Setup } from "./components/setup.tsx";
import { watchDeepLinks } from "./deep-link-browser.ts";
import { dropLegacyHidden, dropLegacyPending, readForm, readFormFiles, trackFormFiles, writeForm } from "./persist.ts";
import { deriveAccountKey, FLEET_QUOTA_INTERVAL_MS, RelayClient } from "@seance/shared";
import { loadPsk, loadPskBase, readBearer, readRelayUrl } from "./relay/keys.ts";
import "./screen.css";
import { watchPushResync } from "./push-browser.ts";
import type { PersistedForm } from "./state.ts";
import { deliverShare, shareMarker } from "./share-inbox.ts";
import { Store } from "./store.ts";
import { registerServiceWorker } from "./sw.ts";
import { watchSystemTheme } from "./theme.ts";

const PERSIST_DEBOUNCE_MS = 300;

watchSystemTheme();
registerServiceWorker();

// Prompts are the one thing here the user authored, so make eviction unlikely.
void navigator.storage?.persist?.();

// A share lands here by the worker's 303 (share-handler.ts).
const marker = shareMarker(location.search);

const container = document.querySelector("#root");
if (container === null) throw new Error("#root is missing from index.html");

const [key, base] = await Promise.all([loadPsk(), loadPskBase()]);
const token = readBearer();

if (key === null || token === null) {
  // The marker stays in the URL: Setup's save reloads into the boot that reports it.
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
  // Cleaned at once, so a reload is no share; the history state is passed through, since the store's layers live in it.
  if (marker !== null) history.replaceState(history.state, "", "/");
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

  // Read before the first write below: it is the replaced document's, and only a share boot reports it.
  const before = readFormFiles();
  trackFormFiles(store, (flush) => addEventListener("pagehide", flush));

  // Debounced because the store notifies on every keystroke in the prompt. Only a new
  // form is written: most notifies (relay status beats) leave it the same object. The
  // first is written whatever it is, so a legacy saved shape `readForm` dropped fields
  // from is rewritten once per load, as before.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let written: PersistedForm | null = null;
  store.subscribe(() => {
    if (store.getState().form === written) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      written = store.getState().form;
      writeForm(written);
    }, PERSIST_DEBOUNCE_MS);
  });

  client.start();
  watchPushResync(client);
  watchDeepLinks(store);
  render(<App store={store} push={client} />, container);

  // After the form's writer, so appended share text is saved. The form is up first: Cache Storage
  // can stall, and the files stay in the inbox for a later boot, never dropped.
  void deliverShare("caches" in globalThis ? caches : undefined, marker, before, (share) => store.receiveShare(share));
}
