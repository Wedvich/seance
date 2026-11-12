// `RelayClient.uploadAttachment`'s XMLHttpRequest path, which only a browser reaches:
// Bun has no XHR, so the real-relay tests (pwa/test/client.test.ts) cover the fetch path,
// and this one installs a stand-in. No relay: the stand-in answers as the route does.
import { afterEach, describe, expect, test } from "bun:test";
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
});
