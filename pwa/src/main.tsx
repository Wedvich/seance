import { render } from "preact";
import "./base.css";
import { App } from "./app.tsx";
import { Setup } from "./components/setup.tsx";
import { readForm, readPending, writeForm, writePending } from "./persist.ts";
import { RelayClient } from "./relay/client.ts";
import { loadPsk, readBearer, readRelayUrl } from "./relay/keys.ts";
import "./screen.css";
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

const key = await loadPsk();
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
  const client = new RelayClient({ url: readRelayUrl(), token, key });
  const store = new Store(client, readForm(), readPending());

  // Debounced because the store notifies on every keystroke in the prompt.
  let timer: ReturnType<typeof setTimeout> | null = null;
  store.subscribe(() => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      writeForm(store.getState().form);
      writePending(store.pendingSpawn);
    }, PERSIST_DEBOUNCE_MS);
  });

  client.start();
  render(<App store={store} />, container);
}
