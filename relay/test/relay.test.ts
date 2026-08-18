import {
  APP_ID,
  MACHINES_ID,
  CLOSE_BAD_REQUEST,
  CLOSE_UNAUTHORIZED,
  type RegistryView,
  type RelayToAppFrame,
  type RelayToDaemonFrame,
} from "@seance/shared";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Straight from the module the worker forwards through: it takes a Request and
// returns one, so the DO-facing URL is assertable without a workerd boot.
import { hubRequest } from "../src/subrequest.ts";
import { connectApp, connectDaemon, envelope, startRelay, type Client, type TestRelay } from "./harness.ts";

const TOKEN = "test-bearer-token";

type RegistryFrame = Extract<RelayToAppFrame, { t: "registry" }>;
type MsgFrame = Extract<RelayToAppFrame, { t: "msg" }>;
type UndeliverableFrame = Extract<RelayToAppFrame, { t: "undeliverable" }>;

let relay: TestRelay;

// One workerd instance for the file: the registry is permanent by design, so
// every test uses its own deviceId and asserts on its own entry.
beforeAll(async () => {
  relay = await startRelay(TOKEN);
});

afterAll(async () => {
  await relay.dispose();
});

let deviceCounter = 0;

function nextDeviceId(): string {
  deviceCounter += 1;
  return `device-${deviceCounter}`;
}

/**
 * Waits for a registry push where this machine's entry matches. Pushes from an
 * earlier test's socket teardown can still be in flight, so matching on the
 * entry rather than the first frame keeps the assertion honest.
 */
async function waitForEntry(
  app: Client,
  deviceId: string,
  matches: (entry: RegistryView) => boolean,
): Promise<RegistryView> {
  for (;;) {
    const frame = await app.waitFor<RegistryFrame>("registry");
    const entry = frame.entries.find((candidate) => candidate.deviceId === deviceId);
    if (entry !== undefined && matches(entry)) return entry;
  }
}

async function registeredDaemon(app: Client, deviceId: string): Promise<Client> {
  const daemon = await connectDaemon(relay);
  daemon.send({ t: "register", deviceId, info: envelope(APP_ID, deviceId) });
  await waitForEntry(app, deviceId, (entry) => entry.connected);
  return daemon;
}

describe("upgrade", () => {
  test("404s a path that is neither /daemon nor /app", async () => {
    expect((await relay.probe("/")).status).toBe(404);
    expect((await relay.probe("/registry")).status).toBe(404);
  });

  test("401s a daemon without a valid bearer header", async () => {
    expect((await relay.probe("/daemon")).status).toBe(401);
    expect((await relay.probe("/daemon", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await relay.probe("/daemon", { headers: { authorization: TOKEN } })).status).toBe(401);
  });

  test("401s a non-upgrade app request without a valid ?t= token", async () => {
    expect((await relay.probe("/app")).status).toBe(401);
    expect((await relay.probe(`/app?t=${TOKEN}x`)).status).toBe(401);
  });

  // A browser cannot read the status of a rejected handshake, so the reason has
  // to arrive as a close code the app can act on instead of retrying forever.
  test("closes an app handshake with a wrong token as 4401", async () => {
    const app = await connectApp(relay, `${TOKEN}x`);
    expect(await app.waitClosed()).toBe(CLOSE_UNAUTHORIZED);
  });

  test("closes an app handshake with no token at all as 4400", async () => {
    const app = await connectApp(relay, null);
    expect(await app.waitClosed()).toBe(CLOSE_BAD_REQUEST);
  });

  test("never pushes the registry to a rejected app handshake", async () => {
    const app = await connectApp(relay, `${TOKEN}x`);
    await app.expectNo("registry");
  });

  test("426s an authenticated request that is not a websocket upgrade", async () => {
    expect((await relay.probe("/daemon", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(426);
    expect((await relay.probe(`/app?t=${TOKEN}`)).status).toBe(426);
  });
});

describe("hub subrequest", () => {
  test("the app's ?t= token never reaches the Durable Object", () => {
    const forwarded = hubRequest(
      new Request(`https://relay.test/app?t=${TOKEN}&x=1`, { headers: { upgrade: "websocket" } }),
    );

    // The hub re-derives the role from the path, so carrying the bearer further
    // only writes it into a second trace span.
    expect(forwarded.url).not.toContain(TOKEN);
    const url = new URL(forwarded.url);
    expect(url.pathname).toBe("/app");
    expect(url.searchParams.has("t")).toBe(false);
    expect(url.searchParams.get("x")).toBe("1");
    // Rebuilt, but still the upgrade the hub answers 101 to.
    expect(forwarded.headers.get("upgrade")).toBe("websocket");
  });

  test("a request with nothing to strip is forwarded as it arrived", () => {
    const req = new Request("https://relay.test/daemon", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(hubRequest(req)).toBe(req);
  });
});

describe("presence", () => {
  test("pushes the registry to an app the moment it connects", async () => {
    const app = await connectApp(relay);
    const frame = await app.waitFor<RegistryFrame>("registry");
    expect(Array.isArray(frame.entries)).toBe(true);
    app.close();
  });

  test("a register stores the encrypted info verbatim and shows the machine online", async () => {
    const deviceId = nextDeviceId();
    const app = await connectApp(relay);
    const info = envelope(APP_ID, deviceId);
    const daemon = await connectDaemon(relay);

    daemon.send({ t: "register", deviceId, info });
    const entry = await waitForEntry(app, deviceId, (candidate) => candidate.connected);

    expect(entry.info).toEqual(info);
    expect(entry.lastSeen).toBeGreaterThan(Date.now() - 10_000);
    daemon.close();
    app.close();
  });

  test("an offline machine stays listed with a fresh last-seen", async () => {
    const deviceId = nextDeviceId();
    const app = await connectApp(relay);
    const daemon = await registeredDaemon(app, deviceId);

    daemon.close();
    const entry = await waitForEntry(app, deviceId, (candidate) => !candidate.connected);

    expect(entry.deviceId).toBe(deviceId);
    expect(entry.lastSeen).toBeGreaterThan(Date.now() - 10_000);
    app.close();
  });
});

describe("heartbeat", () => {
  test("answers a bare ping with a bare pong", async () => {
    const daemon = await connectDaemon(relay);
    daemon.sendRaw("ping");
    expect(await daemon.nextRaw()).toBe("pong");
    daemon.close();
  });
});

describe("routing", () => {
  test("hands an app envelope to the addressed daemon untouched", async () => {
    const deviceId = nextDeviceId();
    const app = await connectApp(relay);
    const daemon = await registeredDaemon(app, deviceId);

    const env = envelope(deviceId, APP_ID);
    app.send({ t: "msg", env });

    expect(await daemon.waitFor<RelayToDaemonFrame>("msg")).toEqual({ t: "msg", env });
    daemon.close();
    app.close();
  });

  test("broadcasts a daemon reply to every open app socket", async () => {
    const deviceId = nextDeviceId();
    const phone = await connectApp(relay);
    const laptop = await connectApp(relay);
    const daemon = await registeredDaemon(phone, deviceId);

    const env = envelope(APP_ID, deviceId);
    daemon.send({ t: "msg", env });

    expect((await phone.waitFor<MsgFrame>("msg")).env).toEqual(env);
    expect((await laptop.waitFor<MsgFrame>("msg")).env).toEqual(env);
    daemon.close();
    phone.close();
    laptop.close();
  });

  test("reports a deviceId it has never seen as undeliverable/unknown", async () => {
    const app = await connectApp(relay);
    const env = envelope("never-registered", APP_ID);

    app.send({ t: "msg", env });

    const notice = await app.waitFor<UndeliverableFrame>("undeliverable");
    expect(notice).toEqual({ t: "undeliverable", to: "never-registered", iv: env.iv, code: "unknown" });
    app.close();
  });

  test("reports a registered but disconnected machine as undeliverable/offline", async () => {
    const deviceId = nextDeviceId();
    const app = await connectApp(relay);
    const daemon = await registeredDaemon(app, deviceId);
    daemon.close();
    await waitForEntry(app, deviceId, (entry) => !entry.connected);

    const env = envelope(deviceId, APP_ID);
    app.send({ t: "msg", env });

    const notice = await app.waitFor<UndeliverableFrame>("undeliverable");
    expect(notice).toEqual({ t: "undeliverable", to: deviceId, iv: env.iv, code: "offline" });
    app.close();
  });

  test("fans a machines broadcast to every other registered daemon, never the sender", async () => {
    const senderId = nextDeviceId();
    const receiverId = nextDeviceId();
    const app = await connectApp(relay);
    const sender = await registeredDaemon(app, senderId);
    const receiver = await registeredDaemon(app, receiverId);
    const unregistered = await connectDaemon(relay);

    const env = envelope(MACHINES_ID, senderId);
    sender.send({ t: "msg", env });

    expect((await receiver.waitFor<RelayToDaemonFrame>("msg")).env).toEqual(env);
    // The sender must not be self-nudged, sockets that never registered are
    // not machines, and a broadcast is daemon-bound — apps never see it.
    await sender.expectNo("msg");
    await unregistered.expectNo("msg");
    await app.expectNo("msg");
    sender.close();
    receiver.close();
    unregistered.close();
    app.close();
  });

  test("an app-sent broadcast reaches daemons, with no undeliverable either way", async () => {
    const deviceId = nextDeviceId();
    const app = await connectApp(relay);
    const daemon = await registeredDaemon(app, deviceId);

    const env = envelope(MACHINES_ID, APP_ID);
    app.send({ t: "msg", env });

    expect((await daemon.waitFor<RelayToDaemonFrame>("msg")).env).toEqual(env);
    // Fire-and-forget: nothing correlates a broadcast, so no notice even for
    // an app sender the relay could answer.
    await app.expectNo("undeliverable");
    daemon.close();
    app.close();
  });

  test("a broadcast is never answered undeliverable, even with nothing to deliver to", async () => {
    const app = await connectApp(relay);

    // The unicast fallback would answer `unknown` for an address it cannot
    // route; a broadcast must not, whether or not anyone is listening.
    app.send({ t: "msg", env: envelope(MACHINES_ID, APP_ID) });

    await app.expectNo("undeliverable");
    // The socket still serves, so the frame was handled rather than fatal.
    const env = envelope("never-registered", APP_ID);
    app.send({ t: "msg", env });
    expect((await app.waitFor<UndeliverableFrame>("undeliverable")).iv).toBe(env.iv);
    app.close();
  });
});

describe("identity", () => {
  test("drops a daemon msg whose from is not its own deviceId", async () => {
    const deviceId = nextDeviceId();
    const app = await connectApp(relay);
    const daemon = await registeredDaemon(app, deviceId);

    daemon.send({ t: "msg", env: envelope(APP_ID, "some-other-machine") });

    await app.expectNo("msg");
    daemon.close();
    app.close();
  });

  test("drops an app msg that does not claim the app address", async () => {
    const deviceId = nextDeviceId();
    const app = await connectApp(relay);
    const daemon = await registeredDaemon(app, deviceId);

    app.send({ t: "msg", env: envelope(deviceId, "pretending-to-be-a-daemon") });

    await daemon.expectNo("msg");
    daemon.close();
    app.close();
  });

  test("drops a msg from a daemon socket that has not registered", async () => {
    const app = await connectApp(relay);
    const daemon = await connectDaemon(relay);

    daemon.send({ t: "msg", env: envelope(APP_ID, "unregistered") });

    await app.expectNo("msg");
    daemon.close();
    app.close();
  });

  test("supersedes an older socket claiming the same deviceId", async () => {
    const deviceId = nextDeviceId();
    const app = await connectApp(relay);
    const stale = await registeredDaemon(app, deviceId);
    const fresh = await registeredDaemon(app, deviceId);

    expect(await stale.waitClosed()).toBe(1000);

    const env = envelope(deviceId, APP_ID);
    app.send({ t: "msg", env });
    expect((await fresh.waitFor<RelayToDaemonFrame>("msg")).env).toEqual(env);

    // The machine is still online: the survivor carries the identity.
    await waitForEntry(app, deviceId, (entry) => entry.connected);
    fresh.close();
    app.close();
  });
});

describe("robustness", () => {
  test("ignores malformed frames without dropping the socket", async () => {
    const deviceId = nextDeviceId();
    const app = await connectApp(relay);
    const daemon = await connectDaemon(relay);

    daemon.sendRaw("not json at all");
    daemon.sendRaw("[]");
    daemon.send({ t: "register" });
    daemon.send({ t: "register", deviceId, info: { v: 1, to: APP_ID } });
    daemon.send({ t: "msg", env: { v: 1, to: APP_ID, from: deviceId, iv: "", ct: "x" } });
    daemon.send({ t: "unknown-verb" });

    // The socket is still usable, and none of the above registered anything.
    daemon.send({ t: "register", deviceId, info: envelope(APP_ID, deviceId) });
    await waitForEntry(app, deviceId, (entry) => entry.connected);
    daemon.close();
    app.close();
  });

  test("never lets an app socket register a machine", async () => {
    const app = await connectApp(relay);
    app.send({ t: "register", deviceId: "apps-cannot-register", info: envelope(APP_ID, "x") });

    // Round-trip on the same socket to prove the bogus frame was handled first.
    const env = envelope("still-never-registered", APP_ID);
    app.send({ t: "msg", env });
    await app.waitFor<UndeliverableFrame>("undeliverable");

    const observer = await connectApp(relay);
    const frame = await observer.waitFor<RegistryFrame>("registry");
    expect(frame.entries.map((entry) => entry.deviceId)).not.toContain("apps-cannot-register");
    observer.close();
    app.close();
  });
});

/** Current registry as the DO reports it: a fresh app socket is pushed it on connect. */
async function registryEntries(target: TestRelay): Promise<readonly RegistryView[]> {
  const observer = await connectApp(target);
  const frame = await observer.waitFor<RegistryFrame>("registry");
  observer.close();
  return frame.entries;
}

async function registryIds(target: TestRelay): Promise<string[]> {
  return (await registryEntries(target)).map((entry) => entry.deviceId);
}

/** `connected` is derived from live sockets, so it is what proves a register landed. */
async function isConnected(target: TestRelay, deviceId: string): Promise<boolean> {
  const entries = await registryEntries(target);
  return entries.find((entry) => entry.deviceId === deviceId)?.connected ?? false;
}

/**
 * Round-trips a frame the DO must answer, so a preceding refusal is known to
 * have been processed and dropped rather than merely still in flight.
 */
async function drain(app: Client): Promise<void> {
  app.send({ t: "msg", env: envelope("no-such-device", APP_ID) });
  await app.waitFor<UndeliverableFrame>("undeliverable");
}

// Own instance: the registry is permanent, so a test that deliberately fills it
// would starve every later test sharing the object.
describe("registry entry cap", () => {
  const MAX_DEVICES = 32;
  let bounded: TestRelay;

  beforeAll(async () => {
    bounded = await startRelay(TOKEN);
  });

  afterAll(async () => {
    await bounded.dispose();
  });

  test("a full registry turns away unknown machines and keeps serving known ones", async () => {
    const app = await connectApp(bounded);
    const daemons: Client[] = [];
    for (let i = 0; i < MAX_DEVICES; i += 1) {
      const deviceId = `full-${i}`;
      // oxlint-disable-next-line no-await-in-loop -- the assertion is about the boundary, so fill in a known order
      const daemon = await connectDaemon(bounded);
      daemon.send({ t: "register", deviceId, info: envelope(APP_ID, deviceId) });
      // oxlint-disable-next-line no-await-in-loop -- each entry must land before the next is counted
      await waitForEntry(app, deviceId, (entry) => entry.connected);
      daemons.push(daemon);
    }

    const overflow = await connectDaemon(bounded);
    overflow.send({ t: "register", deviceId: "overflow", info: envelope(APP_ID, "overflow") });
    await drain(app);

    const ids = await registryIds(bounded);
    expect(ids).toHaveLength(MAX_DEVICES);
    expect(ids).not.toContain("overflow");

    // The cap must not cost you a machine you already had: reconnecting one of
    // the filled entries still registers, because its id is already known.
    daemons[0]?.close();
    await waitForEntry(app, "full-0", (entry) => !entry.connected);
    const rejoined = await connectDaemon(bounded);
    rejoined.send({ t: "register", deviceId: "full-0", info: envelope(APP_ID, "full-0") });
    await waitForEntry(app, "full-0", (entry) => entry.connected);

    rejoined.close();
    overflow.close();
    for (const daemon of daemons.slice(1)) daemon.close();
    app.close();
  }, 30_000);

  // Runs on the registry the test above filled.
  test("a register the full registry turns away still spends the window", async () => {
    const MAX_REGISTERS_PER_WINDOW = 10;
    const app = await connectApp(bounded);
    const daemon = await connectDaemon(bounded);

    // Every one of these is refused by the entry cap, and every one costs a
    // storage read plus a list over the prefix. If the refusal were free the
    // window would never advance and unknown ids would be unlimited per socket.
    for (let i = 0; i < MAX_REGISTERS_PER_WINDOW; i += 1) {
      daemon.send({ t: "register", deviceId: `spent-${i}`, info: envelope(APP_ID, `spent-${i}`) });
    }
    await drain(app);

    // A known id the cap would wave through: the only thing left to refuse it
    // is the rate limit the refusals above must have spent.
    daemon.send({ t: "register", deviceId: "full-1", info: envelope(APP_ID, "full-1") });
    await drain(app);

    expect(await isConnected(bounded, "full-1")).toBe(false);
    expect(await registryIds(bounded)).toHaveLength(MAX_DEVICES);

    daemon.close();
    app.close();
  }, 30_000);
});

describe("register rate limit", () => {
  const MAX_REGISTERS_PER_WINDOW = 10;
  let limited: TestRelay;

  beforeAll(async () => {
    limited = await startRelay(TOKEN);
  });

  afterAll(async () => {
    await limited.dispose();
  });

  test("a socket registering faster than any daemon would is cut off", async () => {
    const app = await connectApp(limited);
    const daemon = await connectDaemon(limited);
    for (let i = 0; i < MAX_REGISTERS_PER_WINDOW; i += 1) {
      const deviceId = `rate-${i}`;
      daemon.send({ t: "register", deviceId, info: envelope(APP_ID, deviceId) });
      // oxlint-disable-next-line no-await-in-loop -- spending the window one register at a time is the point
      await waitForEntry(app, deviceId, () => true);
    }

    daemon.send({ t: "register", deviceId: "rate-over", info: envelope(APP_ID, "rate-over") });
    await drain(app);

    const ids = await registryIds(limited);
    expect(ids).toHaveLength(MAX_REGISTERS_PER_WINDOW);
    expect(ids).not.toContain("rate-over");

    // A refusal must not hand the caller a fresh window: an id already in the
    // registry — nothing else would turn it away — is refused just the same.
    daemon.send({ t: "register", deviceId: "rate-0", info: envelope(APP_ID, "rate-0") });
    await drain(app);
    expect(await isConnected(limited, "rate-0")).toBe(false);

    // Honest about the shape of the guarantee: the budget is per socket, so a
    // new connection starts a new window. This bounds one socket's write rate,
    // not an attacker's total — MAX_DEVICES is what bounds the damage.
    const second = await connectDaemon(limited);
    second.send({ t: "register", deviceId: "rate-fresh", info: envelope(APP_ID, "rate-fresh") });
    await waitForEntry(app, "rate-fresh", (entry) => entry.connected);

    second.close();
    daemon.close();
    app.close();
  }, 30_000);
});

// Own instance: compressed sweep timings would race the suites above.
describe("silent-socket sweep", () => {
  // Generous gaps so CI jitter cannot blur a live daemon into a swept one:
  // heartbeats every 300ms against a 2s silence limit and 250ms sweeps.
  const SWEEP_INTERVAL_MS = 250;
  const SILENCE_LIMIT_MS = 2_000;
  const HEARTBEAT_MS = 300;
  let sweeping: TestRelay;

  beforeAll(async () => {
    // The rate-limit suite's dispose() just ran, and booting workerd too soon
    // after a dispose in the same process breaks its stdio wiring (CLAUDE.md's
    // scar; "Broken pipe" from server.c++). Let it settle first.
    await Bun.sleep(500);
    sweeping = await startRelay(TOKEN, {
      sweepIntervalMs: SWEEP_INTERVAL_MS,
      sweepSilenceLimitMs: SILENCE_LIMIT_MS,
    });
  });

  afterAll(async () => {
    await sweeping.dispose();
  });

  test("closes a daemon that never heartbeats and reports it offline with an honest lastSeen", async () => {
    const deviceId = nextDeviceId();
    const app = await connectApp(sweeping);
    const before = Date.now();
    const daemon = await connectDaemon(sweeping);
    daemon.send({ t: "register", deviceId, info: envelope(APP_ID, deviceId) });
    await waitForEntry(app, deviceId, (entry) => entry.connected);
    const registeredAt = Date.now();

    // The point of the sweep: a slept machine sends no close frame, so the
    // relay must close the socket and push the offline registry on its own.
    expect(await daemon.waitClosed(10_000)).toBe(1000);
    const entry = await waitForEntry(app, deviceId, (candidate) => !candidate.connected);

    // lastSeen is the last proof of life (accept time — it never pinged), not
    // the moment the sweep happened to run. Bounded by registration rather
    // than the silence limit so a loaded CI machine cannot flake it.
    expect(entry.lastSeen).toBeGreaterThanOrEqual(before);
    expect(entry.lastSeen).toBeLessThanOrEqual(registeredAt);
    app.close();
  });

  test("a heartbeating daemon is never swept, then is once it falls silent", async () => {
    const deviceId = nextDeviceId();
    const app = await connectApp(sweeping);
    const daemon = await connectDaemon(sweeping);
    daemon.send({ t: "register", deviceId, info: envelope(APP_ID, deviceId) });
    await waitForEntry(app, deviceId, (entry) => entry.connected);

    const heartbeat = setInterval(() => daemon.sendRaw("ping"), HEARTBEAT_MS);
    // Outlives the silence limit twice over while pinging — waitClosed
    // rejecting is the socket staying open.
    await expect(daemon.waitClosed(SILENCE_LIMIT_MS * 2.5)).rejects.toThrow();
    clearInterval(heartbeat);

    expect(await daemon.waitClosed(10_000)).toBe(1000);
    await waitForEntry(app, deviceId, (entry) => !entry.connected);
    app.close();
  }, 20_000);
});
