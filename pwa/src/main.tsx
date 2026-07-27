import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./base.css";
import { App } from "./app.tsx";
import { RelayClient } from "./relay/client.ts";
import { loadPsk, readBearer, readRelayUrl } from "./relay/keys.ts";
import { Store } from "./store.ts";
import { watchSystemTheme } from "./theme.ts";

watchSystemTheme();

// Prompts are the one thing here the user authored, so make eviction unlikely.
void navigator.storage?.persist?.();

const container = document.querySelector("#root");
if (container === null) throw new Error("#root is missing from index.html");
const root = createRoot(container);

const key = await loadPsk();
const token = readBearer();
if (key === null || token === null) {
  // Replaced by the setup screen in the next commit.
  root.render(<p>No credentials stored.</p>);
} else {
  const client = new RelayClient({ url: readRelayUrl(), token, key });
  const store = new Store(client);
  client.start();
  root.render(
    <StrictMode>
      <App store={store} />
    </StrictMode>,
  );
}
