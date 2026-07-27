import { APP_ID, type RegistryView, type RelayToAppFrame, type RelayToDaemonFrame } from "@seance/shared";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

  test("401s an app without a valid ?t= token", async () => {
    expect((await relay.probe("/app")).status).toBe(401);
    expect((await relay.probe(`/app?t=${TOKEN}x`)).status).toBe(401);
  });

  test("426s an authenticated request that is not a websocket upgrade", async () => {
    expect((await relay.probe("/daemon", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(426);
    expect((await relay.probe(`/app?t=${TOKEN}`)).status).toBe(426);
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
