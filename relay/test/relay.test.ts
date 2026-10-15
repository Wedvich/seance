import {
  APP_ID,
  MACHINES_ID,
  CLOSE_BAD_REQUEST,
  CLOSE_UNAUTHORIZED,
  STATUS_MAX_CT_LENGTH,
  type RegistryView,
  type RelayToAppFrame,
  type RelayToDaemonFrame,
} from "@seance/shared";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  connectApp,
  connectDaemon,
  envelope,
  identityOf,
  newDeviceId,
  register,
  startRelay,
  type Client,
  type TestRelay,
} from "./harness.ts";

const TOKEN = "test-bearer-token";

type RegistryFrame = Extract<RelayToAppFrame, { t: "registry" }>;
type MsgFrame = Extract<RelayToAppFrame, { t: "msg" }>;
type UndeliverableFrame = Extract<RelayToAppFrame, { t: "undeliverable" }>;
type ForgetRefusedFrame = Extract<RelayToAppFrame, { t: "forget-refused" }>;
type StatusFrame = Extract<RelayToAppFrame, { t: "status" }>;

let relay: TestRelay;

// One workerd instance for the file: the registry is permanent by design, so
// every test uses its own deviceId and asserts on its own entry.
beforeAll(async () => {
  relay = await startRelay(TOKEN);
});

afterAll(async () => {
  await relay.dispose();
});

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
  daemon.send(await register(deviceId));
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

describe("presence", () => {
  test("pushes the registry to an app the moment it connects", async () => {
    const app = await connectApp(relay);
    const frame = await app.waitFor<RegistryFrame>("registry");
    expect(Array.isArray(frame.entries)).toBe(true);
    app.close();
  });

  test("a register stores the encrypted info verbatim and shows the machine online", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const info = envelope(APP_ID, deviceId);
    const daemon = await connectDaemon(relay);

    daemon.send(await register(deviceId, { info }));
    const entry = await waitForEntry(app, deviceId, (candidate) => candidate.connected);

    expect(entry.info).toEqual(info);
    expect(entry.lastSeen).toBeGreaterThan(Date.now() - 10_000);
    daemon.close();
    app.close();
  });

  test("an offline machine stays listed with a fresh last-seen", async () => {
    const deviceId = await newDeviceId();
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
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const daemon = await registeredDaemon(app, deviceId);

    const env = envelope(deviceId, APP_ID);
    app.send({ t: "msg", env });

    expect(await daemon.waitFor<RelayToDaemonFrame>("msg")).toEqual({ t: "msg", env });
    daemon.close();
    app.close();
  });

  test("broadcasts a daemon reply to every open app socket", async () => {
    const deviceId = await newDeviceId();
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
    const deviceId = await newDeviceId();
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

  // The common case: a dropped socket is gone from the object before its daemon
  // redials, so the redial registers with nothing to supersede and owns the
  // route. The identity suite covers the redial that races its own zombie.
  test("delivers to the redialed socket when a machine has just reconnected", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const dropped = await registeredDaemon(app, deviceId);
    dropped.close();
    await waitForEntry(app, deviceId, (entry) => !entry.connected);
    const redialed = await registeredDaemon(app, deviceId);

    const env = envelope(deviceId, APP_ID);
    app.send({ t: "msg", env });

    expect((await redialed.waitFor<RelayToDaemonFrame>("msg")).env).toEqual(env);
    await app.expectNo("undeliverable");
    redialed.close();
    app.close();
  });

  test("fans a machines broadcast to every other registered daemon, never the sender", async () => {
    const senderId = await newDeviceId();
    const receiverId = await newDeviceId();
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
    const deviceId = await newDeviceId();
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
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const daemon = await registeredDaemon(app, deviceId);

    daemon.send({ t: "msg", env: envelope(APP_ID, "some-other-machine") });

    await app.expectNo("msg");
    daemon.close();
    app.close();
  });

  test("drops an app msg that does not claim the app address", async () => {
    const deviceId = await newDeviceId();
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

  // The id is the hash of a key and the register is signed with it, so a token
  // holder cannot move a machine's route by naming its id: the forgery is
  // closed, and the machine keeps delivering.
  test("refuses a register whose key does not hash to the deviceId it names", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const incumbent = await registeredDaemon(app, deviceId);

    // A stranger with a perfectly good key of their own, signing for an id that
    // is not that key's hash.
    const stranger = identityOf(await newDeviceId());
    const claimant = await connectDaemon(relay);
    claimant.send(await register(deviceId, { key: stranger.publicKey, sig: (await register(stranger.deviceId)).sig }));
    expect(await claimant.waitClosed()).toBe(1000);

    // Delivery is the proof: the incumbent still owns the route, and the entry
    // never stopped reporting the machine online.
    const env = envelope(deviceId, APP_ID);
    app.send({ t: "msg", env });
    expect((await incumbent.waitFor<RelayToDaemonFrame>("msg")).env).toEqual(env);

    // Read off a fresh socket's first push: the refusal changes nothing, so it
    // pushes no registry of its own to wait for.
    const observer = await connectApp(relay);
    const entries = (await observer.waitFor<RegistryFrame>("registry")).entries;
    expect(entries.find((entry) => entry.deviceId === deviceId)?.connected).toBe(true);

    observer.close();
    incumbent.close();
    app.close();
  });

  test("refuses a register that presents the right key but cannot sign for it", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const incumbent = await registeredDaemon(app, deviceId);

    // The public key is public — a registry entry carries no key, but the id
    // of one does, by construction, so assume the attacker has it. What they
    // do not have is the seed, so a signature from anyone else's key is a
    // signature over the right message by the wrong signer.
    const other = await newDeviceId();
    const forged = await register(other, { deviceId, key: identityOf(deviceId).publicKey });
    const claimant = await connectDaemon(relay);
    claimant.send(forged);
    expect(await claimant.waitClosed()).toBe(1000);

    const env = envelope(deviceId, APP_ID);
    app.send({ t: "msg", env });
    expect((await incumbent.waitFor<RelayToDaemonFrame>("msg")).env).toEqual(env);
    incumbent.close();
    app.close();
  });

  test("refuses a register signed too long ago to be this connection's", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const daemon = await connectDaemon(relay);
    // A captured register replayed later: the signature is genuine, the
    // timestamp is not within the window the relay will accept.
    daemon.send(await register(deviceId, { ts: Date.now() - 5 * 60_000 }));
    expect(await daemon.waitClosed()).toBe(1000);
    expect(await registryIds(relay)).not.toContain(deviceId);
    app.close();
  });

  // The flip side: a verified register *is* the machine, so it never waits
  // behind a socket the same machine left open — a laptop that changed
  // networks redials before the relay has noticed the old socket is dead.
  test("a machine re-registering supersedes its own live socket at once", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const zombie = await registeredDaemon(app, deviceId);

    const redialed = await connectDaemon(relay);
    redialed.send(await register(deviceId));
    expect(await zombie.waitClosed()).toBe(1000);

    // Delivery proves the route moved with it, and the entry stayed online
    // throughout — the zombie's close must not have flipped it.
    const env = envelope(deviceId, APP_ID);
    app.send({ t: "msg", env });
    expect((await redialed.waitFor<RelayToDaemonFrame>("msg")).env).toEqual(env);
    const observer = await connectApp(relay);
    const entries = (await observer.waitFor<RegistryFrame>("registry")).entries;
    expect(entries.find((entry) => entry.deviceId === deviceId)?.connected).toBe(true);

    observer.close();
    redialed.close();
    app.close();
  });
});

describe("status", () => {
  test("the latest rides the socket: forwarded to open apps, carried in the push a late app gets, gone with the socket", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const daemon = await registeredDaemon(app, deviceId);
    const status = envelope(APP_ID, deviceId);

    daemon.send({ t: "status", env: status });
    expect(await app.waitFor<StatusFrame>("status")).toEqual({ t: "status", deviceId, env: status });

    // Not a registry re-push for the app that was open; the one that connects
    // later gets it in its first push, so it renders pressure without a wait.
    const late = await connectApp(relay);
    const entry = await waitForEntry(late, deviceId, (candidate) => candidate.status !== undefined);
    expect(entry.status).toEqual(status);
    expect(entry.connected).toBe(true);

    daemon.close();
    const gone = await waitForEntry(late, deviceId, (candidate) => !candidate.connected);
    expect(gone.status).toBeUndefined();
    app.close();
    late.close();
  });

  test("a second status inside the floor is dropped, and the first stays the latest", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const daemon = await registeredDaemon(app, deviceId);
    const first = envelope(APP_ID, deviceId);
    daemon.send({ t: "status", env: first });
    await app.waitFor<StatusFrame>("status");

    daemon.send({ t: "status", env: envelope(APP_ID, deviceId) });
    await app.expectNo("status");
    const late = await connectApp(relay);
    const entry = await waitForEntry(late, deviceId, (candidate) => candidate.status !== undefined);
    expect(entry.status).toEqual(first);
    daemon.close();
    app.close();
    late.close();
  });

  test("dropped from an unregistered socket, under another machine's id, or addressed anywhere but the app", async () => {
    const deviceId = await newDeviceId();
    const other = await newDeviceId();
    const app = await connectApp(relay);
    const stranger = await connectDaemon(relay);
    stranger.send({ t: "status", env: envelope(APP_ID, deviceId) });
    await app.expectNo("status");

    const daemon = await registeredDaemon(app, deviceId);
    daemon.send({ t: "status", env: envelope(APP_ID, other) });
    daemon.send({ t: "status", env: envelope(other, deviceId) });
    await app.expectNo("status");

    const late = await connectApp(relay);
    const entry = await waitForEntry(late, deviceId, (candidate) => candidate.connected);
    expect(entry.status).toBeUndefined();
    stranger.close();
    daemon.close();
    app.close();
    late.close();
  });

  test("the largest status the bound allows fits the attachment beside the identity; a re-register clears it", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const daemon = await registeredDaemon(app, deviceId);

    // Over the bound first: refused by the parser, so it never reaches the floor.
    daemon.send({ t: "status", env: { ...envelope(APP_ID, deviceId), ct: "A".repeat(STATUS_MAX_CT_LENGTH + 1) } });
    await app.expectNo("status");

    const largest = { ...envelope(APP_ID, deviceId), ct: "A".repeat(STATUS_MAX_CT_LENGTH) };
    daemon.send({ t: "status", env: largest });
    expect((await app.waitFor<StatusFrame>("status")).env).toEqual(largest);

    // The register replaces the blob the snapshot indexes, so the snapshot
    // goes with it — and the floor with the snapshot: the status that follows
    // a register inside ten seconds is accepted, not dropped.
    daemon.send(await register(deviceId));
    await waitForEntry(app, deviceId, (candidate) => candidate.connected);
    const late = await connectApp(relay);
    const cleared = await waitForEntry(late, deviceId, (candidate) => candidate.connected);
    expect(cleared.status).toBeUndefined();
    const fresh = envelope(APP_ID, deviceId);
    daemon.send({ t: "status", env: fresh });
    expect((await late.waitFor<StatusFrame>("status")).env).toEqual(fresh);
    daemon.close();
    app.close();
    late.close();
  });
});

describe("robustness", () => {
  test("ignores malformed frames without dropping the socket", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const daemon = await connectDaemon(relay);

    daemon.sendRaw("not json at all");
    daemon.sendRaw("[]");
    daemon.send({ t: "register" });
    daemon.send({ t: "register", deviceId, info: { v: 1, to: APP_ID } });
    daemon.send({ t: "register", deviceId, info: envelope(APP_ID, deviceId) });
    daemon.send(await register(deviceId, { sig: "short" }));
    daemon.send({ t: "msg", env: { v: 1, to: APP_ID, from: deviceId, iv: "", ct: "x" } });
    daemon.send({ t: "unknown-verb" });

    // The socket is still usable, and none of the above registered anything —
    // an unsigned or mis-sized register is malformed, not unverified, so it is
    // dropped on the floor rather than closing the socket.
    daemon.send(await register(deviceId));
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
async function registryIds(target: TestRelay): Promise<string[]> {
  const observer = await connectApp(target);
  const frame = await observer.waitFor<RegistryFrame>("registry");
  observer.close();
  return frame.entries.map((entry) => entry.deviceId);
}

/**
 * Round-trips a frame the DO must answer, so a preceding refusal is known to
 * have been processed and dropped rather than merely still in flight.
 */
async function drain(app: Client): Promise<void> {
  app.send({ t: "msg", env: envelope("no-such-device", APP_ID) });
  await app.waitFor<UndeliverableFrame>("undeliverable");
}

describe("forget", () => {
  test("deletes an offline machine's entry and pushes the change to every app", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const observer = await connectApp(relay);
    const daemon = await registeredDaemon(app, deviceId);
    daemon.close();
    await waitForEntry(app, deviceId, (entry) => !entry.connected);

    app.send({ t: "forget", deviceId });

    // Asserted on the socket that did not ask: a deletion is registry state, so
    // every open app has to learn it, not just the one holding the button.
    for (;;) {
      const frame = await observer.waitFor<RegistryFrame>("registry");
      if (!frame.entries.some((entry) => entry.deviceId === deviceId)) break;
    }
    expect(await registryIds(relay)).not.toContain(deviceId);
    await app.expectNo("forget-refused");
    observer.close();
    app.close();
  });

  test("refuses while the machine is connected, and names which one", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const daemon = await registeredDaemon(app, deviceId);

    app.send({ t: "forget", deviceId });

    const refusal = await app.waitFor<ForgetRefusedFrame>("forget-refused");
    expect(refusal).toEqual({ t: "forget-refused", deviceId, code: "connected" });
    expect(await registryIds(relay)).toContain(deviceId);
    daemon.close();
    app.close();
  });

  test("is silent about an id the registry never held", async () => {
    const app = await connectApp(relay);

    app.send({ t: "forget", deviceId: "never-registered-anywhere" });

    // Idempotent: nothing to delete is the state asked for, so no refusal — and
    // no push either, which is what keeps a flood of them from costing fanouts.
    await app.expectNo("forget-refused");
    await app.expectNo("registry");
    await drain(app);
    app.close();
  });

  test("never lets a daemon socket forget a machine", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const daemon = await registeredDaemon(app, deviceId);
    const other = await connectDaemon(relay);

    // The frame only exists on the app leg; on this one it is malformed, and a
    // daemon that could evict its neighbours would be a hole of its own.
    other.send({ t: "forget", deviceId });
    daemon.send({ t: "forget", deviceId });
    await drain(app);

    expect(await registryIds(relay)).toContain(deviceId);
    other.close();
    daemon.close();
    app.close();
  });

  test("drops a malformed forget without dropping the socket", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const daemon = await registeredDaemon(app, deviceId);
    daemon.close();
    await waitForEntry(app, deviceId, (entry) => !entry.connected);

    app.send({ t: "forget" });
    app.send({ t: "forget", deviceId: 7 });
    app.send({ t: "forget", deviceId: "device:../escape" });
    await drain(app);
    expect(await registryIds(relay)).toContain(deviceId);

    // The socket still serves, so the frames above were handled rather than fatal.
    app.send({ t: "forget", deviceId });
    for (;;) {
      const frame = await app.waitFor<RegistryFrame>("registry");
      if (!frame.entries.some((entry) => entry.deviceId === deviceId)) break;
    }
    app.close();
  });
});
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
    const filling = await Promise.all(Array.from({ length: MAX_DEVICES }, () => newDeviceId()));
    const daemons: Client[] = [];
    for (const deviceId of filling) {
      // oxlint-disable-next-line no-await-in-loop -- the assertion is about the boundary, so fill in a known order
      const daemon = await connectDaemon(bounded);
      // oxlint-disable-next-line no-await-in-loop -- signed per id, in the same order
      daemon.send(await register(deviceId));
      // oxlint-disable-next-line no-await-in-loop -- each entry must land before the next is counted
      await waitForEntry(app, deviceId, (entry) => entry.connected);
      daemons.push(daemon);
    }

    const overflowId = await newDeviceId();
    const overflow = await connectDaemon(bounded);
    overflow.send(await register(overflowId));
    await drain(app);

    const ids = await registryIds(bounded);
    expect(ids).toHaveLength(MAX_DEVICES);
    expect(ids).not.toContain(overflowId);

    // The cap must not cost you a machine you already had: reconnecting one of
    // the filled entries still registers, because its id is already known.
    const first = filling[0] ?? "";
    daemons[0]?.close();
    await waitForEntry(app, first, (entry) => !entry.connected);
    const rejoined = await connectDaemon(bounded);
    rejoined.send(await register(first));
    await waitForEntry(app, first, (entry) => entry.connected);

    rejoined.close();
    overflow.close();
    for (const daemon of daemons.slice(1)) daemon.close();
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
    const budget = await Promise.all(Array.from({ length: MAX_REGISTERS_PER_WINDOW }, () => newDeviceId()));
    for (const deviceId of budget) {
      // oxlint-disable-next-line no-await-in-loop -- spending the window one register at a time is the point
      daemon.send(await register(deviceId));
      // oxlint-disable-next-line no-await-in-loop -- same
      await waitForEntry(app, deviceId, () => true);
    }

    // Genuine, and still refused: the window is spent before anything is
    // verified, so a holder cannot make the relay pay for a verify per frame.
    const over = await newDeviceId();
    daemon.send(await register(over));
    await drain(app);

    const ids = await registryIds(limited);
    expect(ids).toHaveLength(MAX_REGISTERS_PER_WINDOW);
    expect(ids).not.toContain(over);

    // Honest about the shape of the guarantee: the budget is per socket, so a
    // new connection starts a new window. This bounds one socket's write rate,
    // not an attacker's total — MAX_DEVICES is what bounds the damage.
    const fresh = await newDeviceId();
    const second = await connectDaemon(limited);
    second.send(await register(fresh));
    await waitForEntry(app, fresh, (entry) => entry.connected);

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
    const deviceId = await newDeviceId();
    const app = await connectApp(sweeping);
    const before = Date.now();
    const daemon = await connectDaemon(sweeping);
    daemon.send(await register(deviceId));
    await waitForEntry(app, deviceId, (entry) => entry.connected);
    const registeredAt = Date.now();
    daemon.send({ t: "status", env: envelope(APP_ID, deviceId) });
    await app.waitFor<StatusFrame>("status");

    // The point of the sweep: a slept machine sends no close frame, so the
    // relay must close the socket and push the offline registry on its own.
    expect(await daemon.waitClosed(10_000)).toBe(1000);
    const entry = await waitForEntry(app, deviceId, (candidate) => !candidate.connected);
    // A swept socket leaves no snapshot behind: it went with the socket.
    expect(entry.status).toBeUndefined();

    // lastSeen is the last proof of life (accept time — it never pinged), not
    // the moment the sweep happened to run. Bounded by registration rather
    // than the silence limit so a loaded CI machine cannot flake it.
    expect(entry.lastSeen).toBeGreaterThanOrEqual(before);
    expect(entry.lastSeen).toBeLessThanOrEqual(registeredAt);
    app.close();
  });

  test("a heartbeating daemon is never swept, then is once it falls silent", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(sweeping);
    const daemon = await connectDaemon(sweeping);
    daemon.send(await register(deviceId));
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
