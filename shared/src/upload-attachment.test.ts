// `RelayClient.uploadAttachment`'s XMLHttpRequest path, which only a browser reaches:
// Bun has no XHR, so the real-relay tests (pwa/test/client.test.ts) cover the fetch path
// (its deadline is below, on a held socket),
// and this one installs a stand-in. No relay: the stand-in answers as the route does.
import { afterEach, describe, expect, jest, test } from "bun:test";
import { RelayClient } from "./app-client.ts";
import { attachmentHash, importPsk, openAttachment, toBase64 } from "./crypto.ts";

class FakeXhr extends EventTarget {
  static sent: FakeXhr[] = [];
  /** How the "relay" answers each send; the default never answers. */
  static respond: (xhr: FakeXhr) => void = () => {};

  method = "";
  url = "";
  readonly headers: Record<string, string> = {};
  body: Uint8Array | null = null;
  status = 0;
  responseText = "";
  aborted = false;
  readonly upload = new EventTarget();

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: Uint8Array): void {
    this.body = body;
    FakeXhr.sent.push(this);
    queueMicrotask(() => FakeXhr.respond(this));
  }

  abort(): void {
    this.aborted = true;
    this.fire("abort");
  }

  fire(type: "load" | "error" | "abort"): void {
    this.dispatchEvent(new Event(type));
  }

  progress(loaded: number, total: number): void {
    this.upload.dispatchEvent(Object.assign(new Event("progress"), { loaded, total, lengthComputable: true }));
  }

  answer(status: number, body: unknown): void {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.fire("load");
  }
}

const TOKEN = "t".repeat(32);

async function client(): Promise<{ client: RelayClient; key: CryptoKey }> {
  const key = await importPsk(toBase64(new Uint8Array(32).fill(5)));
  // Never started: an upload needs no socket.
  return { client: new RelayClient({ url: "wss://relay.test/app", token: TOKEN, key }), key };
}

function installXhr(): void {
  FakeXhr.sent = [];
  FakeXhr.respond = () => {};
  Reflect.set(globalThis, "XMLHttpRequest", FakeXhr);
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "XMLHttpRequest");
});

/**
 * Fake timers must be on before the upload arms its timer. Sealing and the connect need no timer, so
 * the poll yields with `setImmediate`, which the fake clock leaves alone, and real time bounds it.
 */
async function underFakeTimersUntil(done: () => boolean): Promise<void> {
  const until = performance.now() + 4_000;
  while (!done() && performance.now() < until) {
    // oxlint-disable-next-line no-await-in-loop -- a poll: sealing and the connect land off the microtask queue
    await loopTurn();
  }
  if (!done()) throw new Error("condition never held");
}

/** A turn of the event loop that the fake clock does not hold back, as it does `Bun.sleep`. */
async function loopTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("uploadAttachment over XMLHttpRequest", () => {
  test("PUTs the sealed object with the token in the header, reports progress over its bytes, and reads the 201", async () => {
    installXhr();
    FakeXhr.respond = (xhr) => {
      const total = xhr.body?.length ?? 0;
      xhr.progress(Math.floor(total / 2), total);
      xhr.progress(total, total);
      xhr.answer(201, { code: "stored" });
    };
    const { client: relay, key } = await client();
    const bytes = new Uint8Array(new TextEncoder().encode("a screenshot, honestly"));
    const progress: [number, number][] = [];
    const reply = await relay.uploadAttachment(bytes, { onProgress: (sent, total) => progress.push([sent, total]) });
    if (!reply.ok) throw new Error(`not stored: ${reply.code}`);

    const [xhr] = FakeXhr.sent;
    if (xhr === undefined || xhr.body === null) throw new Error("nothing sent");
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe(`https://relay.test/attachments/${reply.id}`);
    expect(xhr.headers).toEqual({ authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" });
    const object = new Uint8Array(xhr.body);
    expect(await attachmentHash(object)).toBe(reply.hash);
    expect(await openAttachment(key, reply.id, object)).toEqual(bytes);
    expect(progress).toEqual([
      [Math.floor(object.length / 2), object.length],
      [object.length, object.length],
    ]);
  });

  test("maps the relay's refusals as the fetch path does", async () => {
    installXhr();
    const { client: relay } = await client();
    const bytes = new Uint8Array(4);
    FakeXhr.respond = (xhr) => xhr.answer(429, { code: "allowance_exhausted", window: "month", retryAfter: 60 });
    expect(await relay.uploadAttachment(bytes)).toEqual({
      ok: false,
      code: "allowance_exhausted",
      window: "month",
      retryAfter: 60,
    });
    FakeXhr.respond = (xhr) => xhr.answer(401, { code: "unauthorized" });
    expect(await relay.uploadAttachment(bytes)).toEqual({ ok: false, code: "unauthorized" });
    FakeXhr.respond = (xhr) => {
      xhr.status = 502;
      xhr.responseText = "<html>bad gateway</html>";
      xhr.fire("load");
    };
    expect(await relay.uploadAttachment(bytes)).toEqual({ ok: false, code: "unreadable" });
    FakeXhr.respond = (xhr) => xhr.fire("error");
    expect(await relay.uploadAttachment(bytes)).toEqual({ ok: false, code: "unreachable" });
  });

  test("an abort mid-send cuts the request off and answers aborted; one before it sends nothing", async () => {
    installXhr();
    const { client: relay } = await client();
    const controller = new AbortController();
    const pending = relay.uploadAttachment(new Uint8Array(4), { signal: controller.signal });
    for (let turn = 0; turn < 200 && FakeXhr.sent.length === 0; turn += 1) {
      // oxlint-disable-next-line no-await-in-loop -- a poll: sealing resolves off the microtask queue
      await Bun.sleep(1);
    }
    controller.abort();
    expect(await pending).toEqual({ ok: false, code: "aborted" });
    expect(FakeXhr.sent[0]?.aborted).toBe(true);

    expect(await relay.uploadAttachment(new Uint8Array(4), { signal: controller.signal })).toEqual({
      ok: false,
      code: "aborted",
    });
    expect(FakeXhr.sent).toHaveLength(1);
  });

  async function sentUnderFakeTimers(): Promise<FakeXhr> {
    await underFakeTimersUntil(() => FakeXhr.sent.length > 0);
    const xhr = FakeXhr.sent[0];
    if (xhr === undefined) throw new Error("nothing sent");
    return xhr;
  }

  test("an upload with no progress for a minute is cut off and answers unreachable; progress holds it off", async () => {
    installXhr();
    const { client: relay } = await client();
    jest.useFakeTimers();
    try {
      const pending = relay.uploadAttachment(new Uint8Array(4));
      const xhr = await sentUnderFakeTimers();
      jest.advanceTimersByTime(50_000);
      xhr.progress(1, 4);
      jest.advanceTimersByTime(50_000);
      expect(xhr.aborted).toBe(false);
      jest.advanceTimersByTime(11_000);
      expect(xhr.aborted).toBe(true);
      expect(await pending).toEqual({ ok: false, code: "unreachable" });
    } finally {
      jest.useRealTimers();
    }
  });

  test("an answer clears the stall timer: a minute later nothing is cut off", async () => {
    installXhr();
    const { client: relay } = await client();
    jest.useFakeTimers();
    try {
      const pending = relay.uploadAttachment(new Uint8Array(4));
      const xhr = await sentUnderFakeTimers();
      xhr.answer(201, { code: "stored" });
      const reply = await pending;
      jest.advanceTimersByTime(61_000);
      expect(xhr.aborted).toBe(false);
      expect(reply.ok).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a send that throws answers unreachable and leaves no timer to abort anything later", async () => {
    installXhr();
    const { client: relay } = await client();
    jest.useFakeTimers();
    const send = FakeXhr.prototype.send;
    FakeXhr.prototype.send = () => {
      throw new Error("InvalidStateError");
    };
    try {
      const pending = relay.uploadAttachment(new Uint8Array(4));
      for (let turn = 0; turn < 200 && jest.getTimerCount() === 0; turn += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a poll
        await new Promise<void>((resolve) => {
          jest.useRealTimers();
          setTimeout(resolve, 1);
        });
        jest.useFakeTimers();
      }
      expect(await pending).toEqual({ ok: false, code: "unreachable" });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      FakeXhr.prototype.send = send;
      jest.useRealTimers();
    }
  });
});

// The fetch path (Bun, Raycast) against a relay that takes the connection and never answers: what a
// blackholed connect looks like from here, without depending on how the OS treats a closed port
// (WSL's mirrored networking holds a connect to one rather than refusing it).
describe("uploadAttachment over fetch", () => {
  async function heldRelay(): Promise<{ client: RelayClient; connected: () => boolean; stop: () => void }> {
    let opened = 0;
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: () => {
          opened += 1;
        },
        data: () => {},
      },
    });
    const key = await importPsk(toBase64(new Uint8Array(32).fill(5)));
    return {
      client: new RelayClient({ url: `ws://127.0.0.1:${listener.port}/app`, token: TOKEN, key }),
      connected: () => opened > 0,
      stop: () => listener.stop(true),
    };
  }

  test("a relay that never answers is cut off at the deadline and answers unreachable", async () => {
    const relay = await heldRelay();
    jest.useFakeTimers();
    try {
      let settled = false;
      const pending = relay.client.uploadAttachment(new Uint8Array(4)).finally(() => {
        settled = true;
      });
      await underFakeTimersUntil(relay.connected);
      jest.advanceTimersByTime(59_000);
      await loopTurn();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(2_000);
      expect(await pending).toEqual({ ok: false, code: "unreachable" });
    } finally {
      jest.useRealTimers();
      relay.stop();
    }
  });

  test("a larger object gets time for its bytes past the minute", async () => {
    const relay = await heldRelay();
    jest.useFakeTimers();
    try {
      let settled = false;
      // 6 MiB at the floor of 64 bytes a millisecond: ~98 s on top of the minute.
      const pending = relay.client.uploadAttachment(new Uint8Array(6 * 1024 * 1024)).finally(() => {
        settled = true;
      });
      await underFakeTimersUntil(relay.connected);
      jest.advanceTimersByTime(150_000);
      await loopTurn();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(10_000);
      expect(await pending).toEqual({ ok: false, code: "unreachable" });
    } finally {
      jest.useRealTimers();
      relay.stop();
    }
  });

  test("the caller's own abort answers aborted, and leaves no deadline behind", async () => {
    const relay = await heldRelay();
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = relay.client.uploadAttachment(new Uint8Array(4), { signal: controller.signal });
      await underFakeTimersUntil(relay.connected);
      controller.abort();
      expect(await pending).toEqual({ ok: false, code: "aborted" });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
      relay.stop();
    }
  });
});
