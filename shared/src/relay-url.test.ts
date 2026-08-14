import { describe, expect, test } from "bun:test";
import { appRelayUrl } from "./relay-url.ts";

describe("appRelayUrl", () => {
  test("swaps the daemon path for the app path, keeping the rest of the URL", () => {
    expect(appRelayUrl("wss://relay.example.workers.dev/daemon")).toBe("wss://relay.example.workers.dev/app");
  });

  test("leaves a URL without the daemon suffix alone rather than guessing", () => {
    expect(appRelayUrl("wss://relay.example.dev/other")).toBe("wss://relay.example.dev/other");
  });
});
