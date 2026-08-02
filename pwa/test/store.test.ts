import { importPsk, toBase64 } from "@seance/shared";
import { beforeAll, describe, expect, test } from "bun:test";
import { RelayClient } from "../src/relay/client.ts";
import { Store } from "../src/store.ts";

/**
 * The two browser globals store.ts touches, stubbed rather than injected — they
 * are an external boundary Bun does not provide. Nothing here opens a layer, so
 * no-ops suffice; e2e/harness.ts installs the same pair for the same reason.
 */
declare global {
  var document: {
    visibilityState: "visible" | "hidden";
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
  };
  var history: { pushState(data: unknown, unused: string): void; back(): void };
}

Object.defineProperty(globalThis, "document", {
  value: { visibilityState: "visible", addEventListener(): void {}, removeEventListener(): void {} },
  configurable: true,
});
Object.defineProperty(globalThis, "history", {
  value: { pushState(): void {}, back(): void {} },
  configurable: true,
});

let key: CryptoKey;

beforeAll(async () => {
  key = await importPsk(toBase64(new Uint8Array(32).fill(3)));
});

/** Never started, so nothing dials: the store is the subject here, not the transport. */
function idleClient(): RelayClient {
  return new RelayClient({ url: "ws://127.0.0.1:1/app", token: "unused", key });
}

describe("store notifications", () => {
  // attach() re-reads the relay state the constructor already stored, which on
  // every mount is the identical object — one render for nothing, and one
  // needless re-arm of main.tsx's persist debounce.
  test("attaching to an unchanged client notifies nobody", () => {
    const store = new Store(idleClient());
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    const before = store.getState();
    const detach = store.attach();
    detach();

    expect(notifications).toBe(0);
    expect(store.getState()).toBe(before);
  });

  test("a patch that does change something still notifies", () => {
    const store = new Store(idleClient());
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.setPrompt("port the pane");

    expect(notifications).toBe(1);
    expect(store.getState().form.prompt).toBe("port the pane");
  });
});
