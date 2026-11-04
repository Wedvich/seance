import { describe, expect, test } from "bun:test";
import { appRelayUrl, attachmentUrl } from "./relay-url.ts";

describe("attachmentUrl", () => {
  const id = "0b6f0c9e-1a2b-4c3d-8e9f-001122334455";

  test("the HTTP origin of either socket URL, at the attachment path", () => {
    expect(attachmentUrl("wss://relay.example.workers.dev/daemon", id)).toBe(
      `https://relay.example.workers.dev/attachments/${id}`,
    );
    expect(attachmentUrl("wss://relay.example.workers.dev/app", id)).toBe(
      `https://relay.example.workers.dev/attachments/${id}`,
    );
    expect(attachmentUrl("ws://127.0.0.1:8787/daemon", id)).toBe(`http://127.0.0.1:8787/attachments/${id}`);
  });

  test("keeps a mount prefix, and drops a query or fragment so no token rides the URL", () => {
    expect(attachmentUrl("wss://example.dev/seance/daemon?t=secret#x", id)).toBe(
      `https://example.dev/seance/attachments/${id}`,
    );
    expect(attachmentUrl("https://example.dev/", id)).toBe(`https://example.dev/attachments/${id}`);
  });
});

describe("appRelayUrl", () => {
  test("swaps the daemon path for the app path, keeping the rest of the URL", () => {
    expect(appRelayUrl("wss://relay.example.workers.dev/daemon")).toBe("wss://relay.example.workers.dev/app");
  });

  test("leaves a URL without the daemon suffix alone rather than guessing", () => {
    expect(appRelayUrl("wss://relay.example.dev/other")).toBe("wss://relay.example.dev/other");
  });
});
