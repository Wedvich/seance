import { afterEach, describe, expect, test } from "bun:test";
import { toBase64Url, type PushAlert, type SettingsRecord, type WebPushSubscription } from "@seance/shared";
import { createPushSender, type PushSender } from "../src/push-sender.ts";
import { createTermSettings, type TermSettings } from "../src/settings.ts";
import type { SettingsRead, SettingsStore, SettingsWrite } from "../src/settings-store.ts";
import { generateVapidKeys } from "../src/web-push.ts";
import { pollUntil } from "./fixtures.ts";
import { startPushEndpoint, type PushEndpoint } from "./push-endpoint.ts";

const alert: PushAlert = { v: 1, kind: "needs-input", at: 5, taskId: "task-1", since: 3, escalated: true };

/** A subscription whose keys are a real P-256 point, so the sender can encrypt to it. */
async function subscription(id: string, host = "fcm.googleapis.com"): Promise<WebPushSubscription> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const point = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    endpoint: `https://${host}/fcm/send/${id}`,
    keys: { p256dh: toBase64Url(point), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) },
  };
}

/** A settings store held in memory with the relay's version rule, so a prune is a real write. */
function memoryStore(initial: SettingsRecord): SettingsStore & { record: () => SettingsRecord } {
  let held = initial;
  return {
    record: () => held,
    get: async (): Promise<SettingsRead> => ({ version: held.version, record: held }),
    put: async (at, record): Promise<SettingsWrite> => {
      if (held.version !== at) return { ok: false, code: "version_conflict" };
      held = { ...record, version: at + 1 };
      return { ok: true, version: held.version };
    },
  };
}

const stubs: PushEndpoint[] = [];
afterEach(async () => {
  await Promise.all(stubs.splice(0).map((made) => made.stop()));
});

function stub(): PushEndpoint {
  const made = startPushEndpoint();
  stubs.push(made);
  return made;
}

interface Rig {
  readonly sender: PushSender;
  readonly settings: TermSettings;
  readonly store: ReturnType<typeof memoryStore>;
  readonly vapid: Awaited<ReturnType<typeof generateVapidKeys>>;
  readonly lines: string[];
  readonly errors: unknown[];
  /** What the sender passed `httpFetch`, in call order. */
  readonly inits: (RequestInit | undefined)[];
}

/**
 * The sender over the real term holder and a stub push service. The stored endpoints are
 * allowlisted https URLs, as the parser requires; `httpFetch` rewrites them onto the stub, so
 * the allowlist check is still on the stored URL.
 */
async function rig(
  subs: readonly WebPushSubscription[],
  route: (id: string) => PushEndpoint,
  tuning: { maxInFlight?: number; maxQueued?: number; timeoutMs?: number } = {},
): Promise<Rig> {
  const vapid = await generateVapidKeys();
  const store = memoryStore({ version: 1, vapid, subscriptions: subs });
  const lines: string[] = [];
  const settings = createTermSettings({ store, term: 1, log: { warn: (line) => lines.push(line) } });
  expect(await settings.load()).toBe("ready");
  const errors: unknown[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const sender = createPushSender({
    settings,
    httpFetch: (input, init) => {
      inits.push(init);
      const id = new URL(String(input)).pathname.split("/").at(-1) ?? "";
      return fetch(route(id).endpoint(id), init);
    },
    sub: "https://relay.example",
    now: Date.now,
    log: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    onError: (err) => errors.push(err),
    ...tuning,
  });
  return { sender, settings, store, vapid, lines, errors, inits };
}

describe("a send", () => {
  test("returns before any request leaves, then posts an encrypted, VAPID-signed push and logs nothing", async () => {
    const push = stub();
    const sub = await subscription("a");
    const { sender, vapid, lines, inits } = await rig([sub], () => push);
    sender.send(alert);
    expect(push.requests()).toEqual([]);
    const [request] = await push.waitForRequests(1);
    expect(request?.method).toBe("POST");
    expect(request?.headers).toMatchObject({
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "3600",
      urgency: "high",
    });
    expect(request?.headers["authorization"]).toStartWith("vapid t=");
    expect(request?.headers["authorization"]).toEndWith(`, k=${vapid.publicKey}`);
    // salt 16 + record size 4 + keyid length 1 + point 65, then the sealed alert and its tag.
    expect(request?.body.length).toBeGreaterThan(86 + 16);
    // A redirect is never followed (a push service answers a live subscription directly), and the send is bounded.
    expect(inits[0]?.redirect).toBe("manual");
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
    await Bun.sleep(50);
    expect(lines).toEqual([]);
  });

  test("a 404 or a 410 prunes exactly that subscription, and logs the host and status only", async () => {
    for (const status of [404, 410]) {
      const gone = stub();
      const live = stub();
      gone.respondWith(status);
      const [a, b] = [await subscription("gone"), await subscription("live")];
      const { sender, store, lines } = await rig([a, b], (id) => (id === "gone" ? gone : live));
      sender.send(alert);
      await pollUntil(() => store.record().version === 2, `the prune after a ${status}`);
      expect(store.record().subscriptions).toEqual([b]);
      expect(lines).toEqual([`push: pruned a subscription host=fcm.googleapis.com status=${status}`]);
      expect(live.requests()).toHaveLength(1);
    }
  });

  test("pruning the last subscription leaves a record without a list, VAPID key kept", async () => {
    const gone = stub();
    gone.respondWith(410);
    const { sender, store, vapid } = await rig([await subscription("gone")], () => gone);
    sender.send(alert);
    await pollUntil(() => store.record().version === 2, "the prune");
    expect(store.record()).toEqual({ version: 2, vapid });
  });

  test("a 500 neither prunes nor retries, and logs the host and status", async () => {
    const push = stub();
    push.respondWith(500);
    const sub = await subscription("x");
    const { sender, store, lines } = await rig([sub], () => push);
    sender.send(alert);
    await pollUntil(() => lines.length > 0, "the log line for 500");
    expect(lines).toEqual(["push: send failed host=fcm.googleapis.com status=500"]);
    expect(store.record().version).toBe(1);
    expect(push.requests()).toHaveLength(1);
  });

  test("a redirect is a failed send: its Location is never fetched, and nothing is pruned", async () => {
    const first = stub();
    const second = stub();
    first.redirectTo(second.endpoint("elsewhere"));
    const { sender, store, lines } = await rig([await subscription("x")], () => first);
    sender.send(alert);
    await pollUntil(() => lines.length > 0, "the log line for the redirect");
    expect(lines).toEqual(["push: send failed host=fcm.googleapis.com status=302"]);
    expect(first.requests()).toHaveLength(1);
    // A non-event cannot be polled: a followed redirect would have landed by now.
    await Bun.sleep(100);
    expect(second.requests()).toEqual([]);
    expect(store.record().version).toBe(1);
  });

  test("two sends that both meet a 410 log one prune: the second finds the endpoint already gone", async () => {
    const gone = stub();
    gone.respondWith(410);
    const release = gone.hold();
    const { sender, store, lines } = await rig([await subscription("gone")], () => gone);
    sender.send(alert);
    sender.send({ ...alert, taskId: "task-2" });
    await gone.waitForRequests(2);
    release();
    await pollUntil(() => store.record().version === 2, "the prune");
    // The second prune is a no-op write-wise: wait out its turn on the writer before reading the log.
    await Bun.sleep(100);
    expect(lines).toEqual(["push: pruned a subscription host=fcm.googleapis.com status=410"]);
  });

  test("a push service that never answers times out, while send had already returned", async () => {
    const push = stub();
    const release = push.hold();
    const { sender, store, lines } = await rig([await subscription("slow")], () => push, { timeoutMs: 100 });
    sender.send(alert);
    await push.waitForRequests(1);
    await pollUntil(() => lines.length > 0, "the timeout line");
    expect(lines).toEqual(["push: send failed host=fcm.googleapis.com status=timeout"]);
    expect(store.record().version).toBe(1);
    release();
  });

  test("a stored endpoint the allowlist no longer accepts is never fetched", async () => {
    const push = stub();
    const [bad, good] = [await subscription("bad", "example.com"), await subscription("good")];
    const { sender } = await rig([bad, good], () => push);
    sender.send(alert);
    await push.waitForRequests(1);
    // A non-event cannot be polled.
    await Bun.sleep(50);
    expect(push.requests().map((request) => request.path)).toEqual(["/push/good"]);
  });

  test("no log line carries an endpoint path, a key, a JWT or the payload", async () => {
    const push = stub();
    push.respondWith(500);
    const sub = await subscription("secret-path");
    const { sender, vapid, lines } = await rig([sub], () => push);
    sender.send(alert);
    await pollUntil(() => lines.length > 0, "the failure line");
    const logged = lines.join("\n");
    for (const secret of [
      "secret-path",
      "/fcm/send",
      sub.keys.p256dh,
      sub.keys.auth,
      vapid.publicKey,
      vapid.privateKey,
      "vapid t=",
      "task-1",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  test("with no loaded settings it sends nothing and does not throw", async () => {
    const store = memoryStore({
      version: 1,
      vapid: await generateVapidKeys(),
      subscriptions: [await subscription("a")],
    });
    const unloaded = createTermSettings({ store, term: 1, log: { warn: () => undefined } });
    const idle = createPushSender({
      settings: unloaded,
      httpFetch: () => Promise.reject(new Error("must not be called")),
      sub: "https://relay.example",
      now: Date.now,
      log: { info: () => undefined, warn: () => undefined },
      onError: () => undefined,
    });
    expect(() => idle.send(alert)).not.toThrow();
  });
});

describe("a stopped sender", () => {
  test("drops what is queued, sends nothing afterwards, and does not prune on an answer that lands late", async () => {
    const gone = stub();
    gone.respondWith(410);
    const release = gone.hold();
    const subs = await Promise.all(["a", "b", "c"].map((id) => subscription(id)));
    const { sender, store, lines } = await rig(subs, () => gone, { maxInFlight: 1 });
    sender.send(alert);
    await gone.waitForRequests(1);
    sender.stop();
    sender.send({ ...alert, taskId: "task-2" });
    release();
    // Non-events cannot be polled: the two queued sends, the later alert and the prune would all have landed by now.
    await Bun.sleep(150);
    expect(gone.requests()).toHaveLength(1);
    expect(store.record().version).toBe(1);
    expect(lines).toEqual([]);
  });
});

describe("a queued send", () => {
  test("is skipped when its subscription has left the record by its turn", async () => {
    const gone = stub();
    const live = stub();
    gone.respondWith(410);
    const release = gone.hold();
    const [a, b, c] = [await subscription("a"), await subscription("b"), await subscription("c")];
    const { sender, settings, store } = await rig([a, b, c], (id) => (id === "a" ? gone : live), { maxInFlight: 1 });
    sender.send(alert);
    await gone.waitForRequests(1);
    // b leaves the record while it waits behind a.
    await settings.update(({ version: _version, ...rest }) => ({ ...rest, subscriptions: [a, c] }));
    release();
    await live.waitForRequests(1);
    await pollUntil(() => store.record().subscriptions?.length === 1, "a pruned after its 410");
    // A non-event cannot be polled: b's send would have started right behind c's.
    await Bun.sleep(100);
    expect(live.requests().map((request) => request.path)).toEqual(["/push/c"]);
    expect(store.record().subscriptions).toEqual([c]);
  });
});

describe("the in-flight cap", () => {
  test("holds sends past it in line and delivers every one once the service answers", async () => {
    const push = stub();
    const release = push.hold();
    const subs = await Promise.all(["a", "b", "c", "d", "e"].map((id) => subscription(id)));
    const { sender, lines } = await rig(subs, () => push, { maxInFlight: 2 });
    sender.send(alert);
    await push.waitForRequests(2);
    // The third would have started by now had the cap let it; a non-event cannot be polled.
    await Bun.sleep(100);
    expect(push.requests()).toHaveLength(2);
    release();
    await push.waitForRequests(5);
    expect(new Set(push.requests().map((request) => request.path)).size).toBe(5);
    expect(lines).toEqual([]);
  });

  test("an alert raised while others wait goes behind them, and every alert reaches every subscription", async () => {
    const push = stub();
    const release = push.hold();
    const subs = await Promise.all(["a", "b", "c"].map((id) => subscription(id)));
    const { sender } = await rig(subs, () => push, { maxInFlight: 1 });
    sender.send(alert);
    sender.send({ ...alert, taskId: "task-2" });
    await push.waitForRequests(1);
    release();
    await push.waitForRequests(6);
    expect(push.requests()).toHaveLength(6);
  });

  test("past the line's bound a send is dropped, with one warning per alert and none per endpoint", async () => {
    const push = stub();
    const release = push.hold();
    const subs = await Promise.all(["a", "b", "c", "d", "e"].map((id) => subscription(id)));
    const { sender, lines } = await rig(subs, () => push, { maxInFlight: 1, maxQueued: 2 });
    sender.send(alert);
    expect(lines).toEqual(["push: queue full, dropped 2 send(s)"]);
    await push.waitForRequests(1);
    release();
    await push.waitForRequests(3);
    await Bun.sleep(50);
    expect(push.requests()).toHaveLength(3);
  });
});
