import { render } from "preact";
import "./base.css";
import { App } from "./app.tsx";
import { Setup } from "./components/setup.tsx";
import { dropLegacyHidden, dropLegacyPending, readForm, readFormFiles, writeForm, writeFormFiles } from "./persist.ts";
import { deriveAccountKey, FLEET_QUOTA_INTERVAL_MS, RelayClient } from "@seance/shared";
import { loadPsk, loadPskBase, readBearer, readRelayUrl } from "./relay/keys.ts";
import "./screen.css";
import type { PersistedForm } from "./state.ts";
import { receiveOnBoot, reloadCostText, shareMarker } from "./share-inbox.ts";
import { Store } from "./store.ts";
import { registerServiceWorker } from "./sw.ts";
import { watchSystemTheme } from "./theme.ts";

const PERSIST_DEBOUNCE_MS = 300;

watchSystemTheme();
registerServiceWorker();

// Prompts are the one thing here the user authored, so make eviction unlikely.
void navigator.storage?.persist?.();

// A share lands here by the worker's 303 (share-handler.ts). Cleaned at once, so a reload
// is no share; the history state is passed through, since the store's layers live in it.
const marker = shareMarker(location.search);
if (marker !== null) history.replaceState(history.state, "", "/");

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

  // Read before the first write below: it is the replaced document's, and only a share boot reports it.
  const before = marker === null ? null : readFormFiles();
  let formFiles = { files: 0, submitting: false };
  writeFormFiles(formFiles);
  store.subscribe(() => {
    const { attachments, spawning } = store.getState();
    if (attachments.length === formFiles.files && spawning === formFiles.submitting) return;
    formFiles = { files: attachments.length, submitting: spawning };
    writeFormFiles(formFiles);
  });

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

  // After the form's writer, so appended share text is saved; before the first render, so
  // the form opens with the files on it. Setup drains nothing: its save reloads into this.
  const share = await receiveOnBoot("caches" in globalThis ? caches : undefined, marker);
  if (share !== null) store.receiveShare({ ...share, problems: [...share.problems, ...reloadCostText(before)] });

  client.start();
  render(<App store={store} />, container);
}
