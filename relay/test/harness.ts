import { PROTOCOL_VERSION, type Envelope } from "@seance/shared";
import { Miniflare } from "miniflare";
import { join } from "node:path";

/**
 * Boots the real Worker + Durable Object under workerd via Miniflare, so these
 * tests exercise the shipped relay rather than a double. Bindings and
 * compatibility date are read from wrangler.jsonc — a drift there fails here.
 */
export interface TestRelay {
  readonly url: URL;
  readonly token: string;
  /** HTTP-level probe; the only way to observe upgrade rejections as status codes. */
  readonly probe: (path: string, init?: { readonly headers?: Record<string, string> }) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

interface WranglerConfig {
  readonly compatibility_date: string;
  readonly durable_objects: { readonly bindings: readonly { readonly name: string; readonly class_name: string }[] };
}

/** wrangler.jsonc is real jsonc: oxfmt keeps line comments and trailing commas, JSON.parse takes neither. */
async function readWranglerConfig(): Promise<WranglerConfig> {
  const text = await Bun.file(join(import.meta.dir, "../wrangler.jsonc")).text();
  const stripped = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")
    .replaceAll(/,(\s*[}\]])/gu, "$1");
  return JSON.parse(stripped) as WranglerConfig;
}

/**
 * Bundled once per process: a second Bun.build in the same process fails with
 * "Unexpected reading file", which is how the relay and PWA suites collide when
 * `bun test` runs both.
 */
let bundlePromise: Promise<string> | null = null;

function workerBundle(): Promise<string> {
  bundlePromise ??= (async () => {
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "../src/index.ts")], target: "browser" });
    const bundle = built.outputs[0];
    if (!built.success || bundle === undefined) {
      throw new Error(`bundling the worker failed: ${built.logs.join("\n")}`);
    }
    return bundle.text();
  })();
  return bundlePromise;
}

export interface SweepOverrides {
  readonly sweepIntervalMs: number;
  readonly sweepSilenceLimitMs: number;
}

export async function startRelay(token: string, sweep?: SweepOverrides): Promise<TestRelay> {
  const config = await readWranglerConfig();
  const binding = config.durable_objects.bindings[0];
  if (binding === undefined) throw new Error("wrangler.jsonc declares no Durable Object binding");

  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "index.mjs", contents: await workerBundle() }],
    compatibilityDate: config.compatibility_date,
    // Free-tier Durable Objects are SQLite-backed; match that here.
    durableObjects: { [binding.name]: { className: binding.class_name, useSQLite: true } },
    bindings: {
      BEARER_TOKEN: token,
      ...(sweep === undefined
        ? {}
        : {
            SWEEP_INTERVAL_MS: String(sweep.sweepIntervalMs),
            SWEEP_SILENCE_LIMIT_MS: String(sweep.sweepSilenceLimitMs),
          }),
    },
  });
  const url = await mf.ready;

  return {
    url,
    token,
    probe: (path, init) => mf.dispatchFetch(new URL(path, url).href, init) as unknown as Promise<Response>,
    // Must dispose: `bun test` fires no process exit hooks, so an undisposed
    // Miniflare leaves its workerd running past the test process itself.
    dispose: () => mf.dispose(),
  };
}

class AsyncQueue<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((value: T) => void)[] = [];

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter(item);
    else this.#items.push(item);
  }

  async next(timeoutMs: number): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return item;
    return new Promise((resolve, reject) => {
      const waiter = (value: T): void => {
        clearTimeout(timer);
        resolve(value);
      };
      // Unqueue on timeout: a waiter left behind swallows the next frame into
      // an already-rejected promise, so a later `next()` waits forever for a
      // frame that did arrive. `expectNo` times out by design, which makes
      // every drain a chance to eat the frame the next assertion wants.
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) this.#waiters.splice(index, 1);
        reject(new Error(`nothing arrived in ${timeoutMs}ms`));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }
}

export interface Client {
  send(frame: unknown): void;
  sendRaw(text: string): void;
  /** Next frame of the given `t`, discarding others (registry pushes interleave). */
  waitFor<T extends { t: string }>(t: T["t"], timeoutMs?: number): Promise<T>;
  /** Next frame verbatim — heartbeats are bare strings, not JSON. */
  nextRaw(timeoutMs?: number): Promise<string>;
  /** Asserts no frame of this type arrives — used where one must have been dropped. */
  expectNo(t: string, ms?: number): Promise<void>;
  waitClosed(timeoutMs?: number): Promise<number>;
  close(): void;
}

function wrap(ws: WebSocket): Client {
  const frames = new AsyncQueue<string>();
  let closeCode: number | null = null;
  const closeWaiters: ((code: number) => void)[] = [];

  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") frames.push(event.data);
  });
  ws.addEventListener("close", (event) => {
    closeCode = event.code;
    for (const waiter of closeWaiters) waiter(event.code);
  });

  return {
    send: (frame) => ws.send(JSON.stringify(frame)),
    sendRaw: (text) => ws.send(text),
    waitFor: async <T extends { t: string }>(t: T["t"], timeoutMs = 2_000): Promise<T> => {
      const deadline = Bun.nanoseconds() + timeoutMs * 1e6;
      for (;;) {
        const remaining = Math.ceil((deadline - Bun.nanoseconds()) / 1e6);
        if (remaining <= 0) throw new Error(`no "${t}" frame within ${timeoutMs}ms`);
        const text = await frames.next(remaining);
        const frame = JSON.parse(text) as { t: string };
        if (frame.t === t) return frame as T;
      }
    },
    nextRaw: (timeoutMs = 2_000) => frames.next(timeoutMs),
    expectNo: async (t: string, ms = 300): Promise<void> => {
      const deadline = Bun.nanoseconds() + ms * 1e6;
      for (;;) {
        const remaining = Math.ceil((deadline - Bun.nanoseconds()) / 1e6);
        if (remaining <= 0) return;
        const text = await frames.next(remaining).catch(() => null);
        if (text === null) return;
        // Registry pushes are background traffic; only the named type is a failure.
        if ((JSON.parse(text) as { t: string }).t === t) throw new Error(`expected no "${t}" frame, got ${text}`);
      }
    },
    waitClosed: async (timeoutMs = 2_000): Promise<number> => {
      if (closeCode !== null) return closeCode;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`socket stayed open for ${timeoutMs}ms`)), timeoutMs);
        closeWaiters.push((code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
    },
    close: () => ws.close(),
  };
}

async function open(ws: WebSocket): Promise<Client> {
  const client = wrap(ws);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket did not open in 5s")), 5_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("socket failed to open"));
    });
  });
  return client;
}

export async function connectDaemon(relay: TestRelay): Promise<Client> {
  const url = new URL("/daemon", relay.url);
  url.protocol = "ws:";
  return open(new WebSocket(url.href, { headers: { authorization: `Bearer ${relay.token}` } }));
}

/** `token` overrides the valid one so a rejected app handshake can be observed. */
export async function connectApp(relay: TestRelay, token: string | null = relay.token): Promise<Client> {
  const url = new URL("/app", relay.url);
  url.protocol = "ws:";
  if (token !== null) url.searchParams.set("t", token);
  return open(new WebSocket(url.href));
}

let ivCounter = 0;

/** The relay never opens an envelope, so the ciphertext here is arbitrary. */
export function envelope(to: string, from: string): Envelope {
  ivCounter += 1;
  return {
    v: PROTOCOL_VERSION,
    to,
    from,
    iv: `iv-${ivCounter}`,
    ct: "Y2lwaGVydGV4dA==",
  };
}
