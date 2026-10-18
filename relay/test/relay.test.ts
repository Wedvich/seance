import {
  APP_ID,
  MACHINES_ID,
  CLOSE_BAD_REQUEST,
  CLOSE_UNAUTHORIZED,
  SCHEDULER_ID,
  STATUS_MAX_CT_LENGTH,
  type RegistryView,
  type RelayToAppFrame,
  type RelayToDaemonFrame,
} from "@seance/shared";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  connectApp,
  connectDaemon,
  connectZombieDaemon,
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
type DaemonMsg = Extract<RelayToDaemonFrame, { t: "msg" }>;

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

/** Polls a positive assertion's subject rather than sleeping: a relay suite has no business importing the daemon's fixtures. */
async function pollUntil(ready: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    // oxlint-disable-next-line no-await-in-loop -- polling is sequential by nature
    await Bun.sleep(20);
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

    expect(await daemon.waitFor<DaemonMsg>("msg")).toEqual({ t: "msg", env });
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

    expect((await redialed.waitFor<DaemonMsg>("msg")).env).toEqual(env);
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

    expect((await receiver.waitFor<DaemonMsg>("msg")).env).toEqual(env);
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

    expect((await daemon.waitFor<DaemonMsg>("msg")).env).toEqual(env);
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
    expect((await incumbent.waitFor<DaemonMsg>("msg")).env).toEqual(env);

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
    expect((await incumbent.waitFor<DaemonMsg>("msg")).env).toEqual(env);
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
    expect((await redialed.waitFor<DaemonMsg>("msg")).env).toEqual(env);
    const observer = await connectApp(relay);
    const entries = (await observer.waitFor<RegistryFrame>("registry")).entries;
    expect(entries.find((entry) => entry.deviceId === deviceId)?.connected).toBe(true);

    observer.close();
    redialed.close();
    app.close();
  });
});

describe("status", () => {
  test("the latest rides the socket: forwarded to open apps, carried in the push a late app gets", async () => {
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
    app.close();
    late.close();
  });

  // The M2 exit: an asleep machine's accounts keep their quota, so the status
  // outlives the socket — and the register that replaces the blob it indexes
  // takes it away again, until the daemon's next beat.
  test("kept in the entry when the socket closes, pushed for the offline machine, cleared by the next register", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(relay);
    const daemon = await registeredDaemon(app, deviceId);
    const last = envelope(APP_ID, deviceId);
    daemon.send({ t: "status", env: last });
    await app.waitFor<StatusFrame>("status");

    daemon.close();
    const asleep = await waitForEntry(app, deviceId, (candidate) => !candidate.connected);
    expect(asleep.status).toEqual(last);
    // From storage, not a socket: an app that opens after the close gets it too.
    const late = await connectApp(relay);
    expect((await waitForEntry(late, deviceId, (candidate) => !candidate.connected)).status).toEqual(last);

    const back = await connectDaemon(relay);
    back.send(await register(deviceId));
    const registered = await waitForEntry(app, deviceId, (candidate) => candidate.connected);
    expect(registered.status).toBeUndefined();
    // Gone from storage as well as the view: a close before the next beat keeps nothing.
    back.close();
    const again = await waitForEntry(app, deviceId, (candidate) => !candidate.connected);
    expect(again.status).toBeUndefined();
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
// The file's shared relay boots with SCHEDULER_LEADERS unset, as a deploy that
// never set the secret does: nobody leads, however capable.
describe("scheduler leadership, allowlist unset", () => {
  test("a daemon with signed roles is never nominated: the push names no leader and the scheduler address is offline", async () => {
    const app = await connectApp(relay);
    const deviceId = await newDeviceId();
    const daemon = await connectDaemon(relay);
    daemon.send(await register(deviceId, { roles: ["scheduler"] }));
    let pushed: RegistryFrame;
    do pushed = await app.waitFor<RegistryFrame>("registry");
    while (!pushed.entries.some((entry) => entry.deviceId === deviceId && entry.connected));
    expect(pushed.scheduler).toBeNull();
    await daemon.expectNo("lead");

    const env = envelope(SCHEDULER_ID, APP_ID);
    app.send({ t: "msg", env });
    expect(await app.waitFor<UndeliverableFrame>("undeliverable")).toEqual({
      t: "undeliverable",
      to: SCHEDULER_ID,
      iv: env.iv,
      code: "offline",
    });
    await daemon.expectNo("msg");

    // Forgotten after: this registry is shared with every suite above and capped.
    daemon.close();
    await waitForEntry(app, deviceId, (entry) => !entry.connected);
    app.send({ t: "forget", deviceId });
    for (;;) {
      const frame = await app.waitFor<RegistryFrame>("registry");
      if (!frame.entries.some((entry) => entry.deviceId === deviceId)) break;
    }
    app.close();
  });
});

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
      sweep: { sweepIntervalMs: SWEEP_INTERVAL_MS, sweepSilenceLimitMs: SILENCE_LIMIT_MS },
      captureLogs: true,
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
    const last = envelope(APP_ID, deviceId);
    daemon.send({ t: "status", env: last });
    await app.waitFor<StatusFrame>("status");

    // The point of the sweep: a slept machine sends no close frame, so the
    // relay must close the socket and push the offline registry on its own.
    expect(await daemon.waitClosed(10_000)).toBe(1000);
    const entry = await waitForEntry(app, deviceId, (candidate) => !candidate.connected);
    // Swept like a close: the snapshot is kept for the machine's accounts.
    expect(entry.status).toEqual(last);

    // lastSeen is the last proof of life (accept time — it never pinged), not
    // the moment the sweep happened to run. Bounded by registration rather
    // than the silence limit so a loaded CI machine cannot flake it.
    expect(entry.lastSeen).toBeGreaterThanOrEqual(before);
    expect(entry.lastSeen).toBeLessThanOrEqual(registeredAt);
    app.close();
  });

  // A zombie (a slept machine) never completes the close a supersede sends, so
  // its close handler — here, the sweep — can run after its successor has come
  // and gone. Writing its own older snapshot back then would replace the one
  // the successor kept, and its listing would read the machine as connected.
  test("a superseded zombie swept after its successor closed keeps nothing, and the successor's status stays", async () => {
    const deviceId = await newDeviceId();
    const app = await connectApp(sweeping);
    const zombie = await connectZombieDaemon(sweeping);
    try {
      zombie.send(await register(deviceId));
      await waitForEntry(app, deviceId, (entry) => entry.connected);
      const old = envelope(APP_ID, deviceId);
      zombie.send({ t: "status", env: old });
      expect((await app.waitFor<StatusFrame>("status")).env).toEqual(old);

      const successor = await connectDaemon(sweeping);
      successor.send(await register(deviceId));
      await waitForEntry(app, deviceId, (entry) => entry.connected && entry.status === undefined);
      const latest = envelope(APP_ID, deviceId);
      successor.send({ t: "status", env: latest });
      expect((await app.waitFor<StatusFrame>("status")).env).toEqual(latest);
      // A superseded socket's beat is not the machine's.
      zombie.send({ t: "status", env: envelope(APP_ID, deviceId) });
      await app.expectNo("status");

      successor.close();
      const gone = await waitForEntry(app, deviceId, (entry) => !entry.connected);
      expect(gone.status).toEqual(latest);
      // Past the silence limit the zombie is swept; the entry is unchanged by it.
      await pollUntil(() => sweeping.logs().some((line) => line.startsWith(`swept ${deviceId}`)), "the sweep", 10_000);
      const late = await connectApp(sweeping);
      const after = await waitForEntry(late, deviceId, () => true);
      expect(after.status).toEqual(latest);
      expect(after.connected).toBe(false);
      late.close();
    } finally {
      zombie.destroy();
      app.close();
    }
  }, 20_000);

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

type LeadFrame = Extract<RelayToDaemonFrame, { t: "lead" }>;

// Own instance, last in the file: nomination is hub-wide, so every daemon the
// shared relay's suites leave connected would be a candidate here, and its
// registry is already near MAX_DEVICES. Sweep timings are compressed for the
// re-nomination test, so every daemon below heartbeats unless told not to.
describe("scheduler leadership", () => {
  const SILENCE_LIMIT_MS = 2_000;
  /** Short enough to watch lapse, long enough that a prompt reply never does. */
  const REPLY_WINDOW_MS = 3_000;
  const SCHEDULER = ["scheduler"];
  /** Minted before boot and listed in SCHEDULER_LEADERS, as an operator lists real machines; one per use. */
  const listed: string[] = [];
  /** Listed with the padding a hand-typed secret picks up, beside junk the relay must ignore. */
  let padded: string;
  let hub: TestRelay;
  const beats = new Map<Client, ReturnType<typeof setInterval>>();

  beforeAll(async () => {
    // Same settle as the sweep suite: the previous suite's dispose() just ran.
    await Bun.sleep(500);
    listed.push(...(await Promise.all(Array.from({ length: 22 }, () => newDeviceId()))));
    padded = await newDeviceId();
    const junk = ["", "  ", "not an id!", "x".repeat(65), SCHEDULER_ID, APP_ID];
    hub = await startRelay(TOKEN, {
      sweep: { sweepIntervalMs: 250, sweepSilenceLimitMs: SILENCE_LIMIT_MS },
      leaders: [...junk, ` ${padded}\t`, ...listed],
      captureLogs: true,
      schedulerReplyWindowMs: REPLY_WINDOW_MS,
    });
  });

  function listedId(): string {
    const id = listed.shift();
    if (id === undefined) throw new Error("out of listed ids — mint more in beforeAll");
    return id;
  }

  afterAll(async () => {
    for (const beat of beats.values()) clearInterval(beat);
    await hub.dispose();
  });

  async function nextRegistry(app: Client, matches: (frame: RegistryFrame) => boolean): Promise<RegistryFrame> {
    for (;;) {
      const frame = await app.waitFor<RegistryFrame>("registry");
      if (matches(frame)) return frame;
    }
  }

  const connected =
    (deviceId: string, want: boolean) =>
    (frame: RegistryFrame): boolean =>
      frame.entries.some((entry) => entry.deviceId === deviceId && entry.connected === want);

  function heartbeat(daemon: Client): void {
    beats.set(
      daemon,
      setInterval(() => daemon.sendRaw("ping"), 300),
    );
  }

  /** A registered daemon and the push that showed it, which also says who leads once it joined. */
  async function join(
    app: Client,
    deviceId: string,
    opts: { readonly roles?: readonly string[]; readonly heartbeat?: boolean } = {},
  ): Promise<{ readonly daemon: Client; readonly registry: RegistryFrame }> {
    const daemon = await connectDaemon(hub);
    if (opts.heartbeat !== false) heartbeat(daemon);
    daemon.send(await register(deviceId, opts.roles === undefined ? {} : { roles: opts.roles }));
    return { daemon, registry: await nextRegistry(app, connected(deviceId, true)) };
  }

  function quiet(daemon: Client): void {
    clearInterval(beats.get(daemon));
    beats.delete(daemon);
  }

  async function leave(app: Client, daemon: Client, deviceId: string): Promise<RegistryFrame> {
    quiet(daemon);
    daemon.close();
    return nextRegistry(app, connected(deviceId, false));
  }

  test("the earliest-connected daemon with signed roles leads, a roleless one never does, and a close re-nominates", async () => {
    const app = await connectApp(hub);
    expect((await app.waitFor<RegistryFrame>("registry")).scheduler).toBeNull();
    const oldId = listedId();
    const firstId = listedId();
    const secondId = listedId();

    // Listed and connected longest, but a v1 register carries no roles.
    const old = await join(app, oldId);
    expect(old.registry.scheduler).toBeNull();

    const first = await join(app, firstId, { roles: SCHEDULER });
    const { term } = await first.daemon.waitFor<LeadFrame>("lead");
    expect(first.registry.scheduler).toEqual({ deviceId: firstId, term });

    const second = await join(app, secondId, { roles: SCHEDULER });
    expect(second.registry.scheduler).toEqual({ deviceId: firstId, term });
    await second.daemon.expectNo("lead");

    const handedOver = await leave(app, first.daemon, firstId);
    expect(handedOver.scheduler).toEqual({ deviceId: secondId, term: term + 1 });
    expect(await second.daemon.waitFor<LeadFrame>("lead")).toEqual({ t: "lead", term: term + 1 });

    expect((await leave(app, second.daemon, secondId)).scheduler).toBeNull();
    await old.daemon.expectNo("lead");
    await leave(app, old.daemon, oldId);
    app.close();
  });

  // A token holder relaying a captured v1 register cannot add roles to it, and
  // the relay does not quietly demote the frame to a roleless one either.
  test("a register whose roles the signature does not cover is refused and never leads", async () => {
    const deviceId = listedId();
    const daemon = await connectDaemon(hub);
    daemon.send({ ...(await register(deviceId)), roles: SCHEDULER });
    expect(await daemon.waitClosed()).toBe(1000);
    await daemon.expectNo("lead");
    const observer = await connectApp(hub);
    expect((await observer.waitFor<RegistryFrame>("registry")).scheduler).toBeNull();
    observer.close();
  });

  test("envelopes to the scheduler reach the leader; with none, an app hears offline", async () => {
    const app = await connectApp(hub);
    const lone = envelope(SCHEDULER_ID, APP_ID);
    app.send({ t: "msg", env: lone });
    expect(await app.waitFor<UndeliverableFrame>("undeliverable")).toEqual({
      t: "undeliverable",
      to: SCHEDULER_ID,
      iv: lone.iv,
      code: "offline",
    });

    const otherId = await newDeviceId();
    const leaderId = listedId();
    const other = await join(app, otherId);
    // Daemon-origin with no leader: dropped, and nobody is told.
    const beforeLeader = envelope(SCHEDULER_ID, otherId);
    other.daemon.send({ t: "msg", env: beforeLeader });
    const leader = await join(app, leaderId, { roles: SCHEDULER });
    await leader.daemon.waitFor<LeadFrame>("lead");
    await leader.daemon.expectNo("msg");

    const fromApp = envelope(SCHEDULER_ID, APP_ID);
    app.send({ t: "msg", env: fromApp });
    expect((await leader.daemon.waitFor<DaemonMsg>("msg")).env).toEqual(fromApp);
    const fromDaemon = envelope(SCHEDULER_ID, otherId);
    other.daemon.send({ t: "msg", env: fromDaemon });
    expect((await leader.daemon.waitFor<DaemonMsg>("msg")).env).toEqual(fromDaemon);
    await app.expectNo("undeliverable");

    // Busy/idle events and queue fetches: a line each would be a timeline of
    // when machines worked and the queue moved. A non-leader's unprompted reply
    // still logs — and, sent last, its line says the others' would be written by now.
    const marker = envelope(APP_ID, otherId);
    other.daemon.send({ t: "msg", env: marker });
    expect((await app.waitFor<MsgFrame>("msg")).env).toEqual(marker);
    const linesFor = (iv: string): readonly string[] => hub.logs().filter((line) => line.includes(`iv="${iv}"`));
    await pollUntil(() => linesFor(marker.iv).length > 0, "the marker's fanout line");
    expect(linesFor(fromApp.iv)).toEqual([]);
    expect(linesFor(lone.iv)).toEqual([expect.stringContaining("wire undeliverable")]);
    expect(linesFor(fromDaemon.iv)).toEqual([]);
    expect(linesFor(beforeLeader.iv)).toEqual([]);

    await leave(app, leader.daemon, leaderId);
    await leave(app, other.daemon, otherId);
    app.close();
  });

  test("a leader leg's nudge and the leader's answer to a delivered request log no fanout line; any other reply still logs one", async () => {
    const app = await connectApp(hub);
    const leaderId = listedId();
    const otherId = await newDeviceId();
    const leader = await join(app, leaderId, { roles: SCHEDULER });
    const { term } = await leader.daemon.waitFor<LeadFrame>("lead");
    const other = await join(app, otherId);

    const nudge = envelope(APP_ID, SCHEDULER_ID);
    app.send({ t: "msg", env: nudge, term });
    expect((await app.waitFor<MsgFrame>("msg")).env).toEqual(nudge);

    const request = envelope(SCHEDULER_ID, APP_ID);
    app.send({ t: "msg", env: request });
    await leader.daemon.waitFor<DaemonMsg>("msg");
    // The credit is the leader socket's, not every daemon's.
    const otherReply = envelope(APP_ID, otherId);
    other.daemon.send({ t: "msg", env: otherReply });
    expect((await app.waitFor<MsgFrame>("msg")).env).toEqual(otherReply);
    const answer = envelope(APP_ID, leaderId);
    leader.daemon.send({ t: "msg", env: answer });
    expect((await app.waitFor<MsgFrame>("msg")).env).toEqual(answer);

    // One request buys one quiet reply. Sent last: its line proves the others' would be written by now.
    const unprompted = envelope(APP_ID, leaderId);
    leader.daemon.send({ t: "msg", env: unprompted });
    expect((await app.waitFor<MsgFrame>("msg")).env).toEqual(unprompted);
    const linesFor = (iv: string): readonly string[] => hub.logs().filter((line) => line.includes(`iv="${iv}"`));
    await pollUntil(() => linesFor(unprompted.iv).length > 0, "the unprompted reply's fanout line");
    expect(linesFor(unprompted.iv)).toEqual([expect.stringContaining("wire fanout")]);
    expect(linesFor(otherReply.iv)).toEqual([expect.stringContaining("wire fanout")]);
    expect(linesFor(answer.iv)).toEqual([]);
    expect(linesFor(request.iv)).toEqual([]);
    expect(linesFor(nudge.iv)).toEqual([]);

    await leave(app, other.daemon, otherId);
    await leave(app, leader.daemon, leaderId);
    app.close();
  });

  test("a leader's answer past the reply window logs a fanout line", async () => {
    const app = await connectApp(hub);
    const leaderId = listedId();
    const leader = await join(app, leaderId, { roles: SCHEDULER });
    await leader.daemon.waitFor<LeadFrame>("lead");

    app.send({ t: "msg", env: envelope(SCHEDULER_ID, APP_ID) });
    await leader.daemon.waitFor<DaemonMsg>("msg");
    // Not a wait for an event: the credit has to lapse.
    await Bun.sleep(REPLY_WINDOW_MS + 500);
    const late = envelope(APP_ID, leaderId);
    leader.daemon.send({ t: "msg", env: late });
    expect((await app.waitFor<MsgFrame>("msg")).env).toEqual(late);
    const linesFor = (iv: string): readonly string[] => hub.logs().filter((line) => line.includes(`iv="${iv}"`));
    await pollUntil(() => linesFor(late.iv).length > 0, "the late answer's fanout line");
    expect(linesFor(late.iv)).toEqual([expect.stringContaining("wire fanout")]);

    await leave(app, leader.daemon, leaderId);
    app.close();
  }, 15_000);

  test("a later request does not extend an earlier one's credit: past the first's window the answer logs", async () => {
    const app = await connectApp(hub);
    const leaderId = listedId();
    const leader = await join(app, leaderId, { roles: SCHEDULER });
    await leader.daemon.waitFor<LeadFrame>("lead");

    app.send({ t: "msg", env: envelope(SCHEDULER_ID, APP_ID) });
    await leader.daemon.waitFor<DaemonMsg>("msg");
    // Not a wait for an event: the bank's window runs from its first credit.
    await Bun.sleep(REPLY_WINDOW_MS - 1_000);
    app.send({ t: "msg", env: envelope(SCHEDULER_ID, APP_ID) });
    await leader.daemon.waitFor<DaemonMsg>("msg");
    await Bun.sleep(1_500);
    const late = envelope(APP_ID, leaderId);
    leader.daemon.send({ t: "msg", env: late });
    expect((await app.waitFor<MsgFrame>("msg")).env).toEqual(late);
    const linesFor = (iv: string): readonly string[] => hub.logs().filter((line) => line.includes(`iv="${iv}"`));
    await pollUntil(() => linesFor(late.iv).length > 0, "the late answer's fanout line");
    expect(linesFor(late.iv)).toEqual([expect.stringContaining("wire fanout")]);

    await leave(app, leader.daemon, leaderId);
    app.close();
  }, 15_000);

  test("a credited answer that reaches no app still logs, with apps=0", async () => {
    const watcher = await connectApp(hub);
    const asker = await connectApp(hub);
    const leaderId = listedId();
    const leader = await join(watcher, leaderId, { roles: SCHEDULER });
    await leader.daemon.waitFor<LeadFrame>("lead");

    asker.send({ t: "msg", env: envelope(SCHEDULER_ID, APP_ID) });
    await leader.daemon.waitFor<DaemonMsg>("msg");
    // No app is left to hear it. A socket the relay still lists fails its send,
    // which also logs `apps=0`, so the close race does not matter.
    asker.close();
    watcher.close();
    const answer = envelope(APP_ID, leaderId);
    const lines = (): readonly string[] => hub.logs().filter((line) => line.includes(`iv="${answer.iv}"`));
    leader.daemon.send({ t: "msg", env: answer });
    await pollUntil(() => lines().length > 0, "the lost answer's fanout line");
    expect(lines()).toEqual([expect.stringContaining("apps=0")]);

    quiet(leader.daemon);
    leader.daemon.close();
  });

  test("past the credit cap the surplus answers log: 17 requests, 17 answers, one line — the last", async () => {
    // Mirrors OWED_MAX in relay/src/hub.ts (the module needs the workers runtime, so a test can't import it).
    const OWED_MAX = 16;
    const app = await connectApp(hub);
    const leaderId = listedId();
    const leader = await join(app, leaderId, { roles: SCHEDULER });
    await leader.daemon.waitFor<LeadFrame>("lead");

    for (let i = 0; i < OWED_MAX + 1; i += 1) {
      app.send({ t: "msg", env: envelope(SCHEDULER_ID, APP_ID) });
      // oxlint-disable-next-line no-await-in-loop -- each request is delivered before the next is sent
      await leader.daemon.waitFor<DaemonMsg>("msg");
    }
    const answers = Array.from({ length: OWED_MAX + 1 }, () => envelope(APP_ID, leaderId));
    for (const answer of answers) {
      leader.daemon.send({ t: "msg", env: answer });
      // oxlint-disable-next-line no-await-in-loop -- in order, so the credit is spent in order
      expect((await app.waitFor<MsgFrame>("msg")).env).toEqual(answer);
    }
    const linesFor = (iv: string): readonly string[] => hub.logs().filter((line) => line.includes(`iv="${iv}"`));
    const last = answers[OWED_MAX];
    if (last === undefined) throw new Error("no last answer");
    await pollUntil(() => linesFor(last.iv).length > 0, "the over-cap answer's fanout line");
    expect(linesFor(last.iv)).toEqual([expect.stringContaining("wire fanout")]);
    for (const answer of answers.slice(0, OWED_MAX)) expect(linesFor(answer.iv)).toEqual([]);

    await leave(app, leader.daemon, leaderId);
    app.close();
  });

  test("the leader leg's dispatch to another machine is delivered with no deliver line", async () => {
    const app = await connectApp(hub);
    const leaderId = listedId();
    const otherId = await newDeviceId();
    const leader = await join(app, leaderId, { roles: SCHEDULER });
    const { term } = await leader.daemon.waitFor<LeadFrame>("lead");
    const other = await join(app, otherId);

    const dispatched = envelope(otherId, SCHEDULER_ID);
    app.send({ t: "msg", env: dispatched, term });
    expect((await other.daemon.waitFor<DaemonMsg>("msg")).env).toEqual(dispatched);
    // Sent last: an app's request to a machine still logs, so its line proves the dispatch's would be written by now.
    const marker = envelope(otherId, APP_ID);
    app.send({ t: "msg", env: marker });
    await other.daemon.waitFor<DaemonMsg>("msg");
    const linesFor = (iv: string): readonly string[] => hub.logs().filter((line) => line.includes(`iv="${iv}"`));
    await pollUntil(() => linesFor(marker.iv).length > 0, "the marker's deliver line");
    expect(linesFor(dispatched.iv)).toEqual([]);

    await leave(app, other.daemon, otherId);
    await leave(app, leader.daemon, leaderId);
    app.close();
  });

  test("a demoted leader hears follow, and anything sent under its term is refused not_leader", async () => {
    const app = await connectApp(hub);
    const aId = listedId();
    const bId = listedId();
    const a = await join(app, aId, { roles: SCHEDULER });
    const b = await join(app, bId, { roles: SCHEDULER });
    const { term } = await a.daemon.waitFor<LeadFrame>("lead");

    // The leader's app-role leg dispatching under its term.
    const dispatched = envelope(bId, SCHEDULER_ID);
    app.send({ t: "msg", env: dispatched, term });
    expect((await b.daemon.waitFor<DaemonMsg>("msg")).env).toEqual(dispatched);

    // `a` gives up the role with a fresh v2 register over no roles.
    a.daemon.send(await register(aId, { roles: [] }));
    expect(await a.daemon.waitFor("follow")).toEqual({ t: "follow" });
    expect(await b.daemon.waitFor<LeadFrame>("lead")).toEqual({ t: "lead", term: term + 1 });

    for (const claimed of [term, undefined]) {
      const stale = envelope(bId, SCHEDULER_ID);
      app.send({ t: "msg", env: stale, ...(claimed === undefined ? {} : { term: claimed }) });
      // oxlint-disable-next-line no-await-in-loop -- each refusal is matched to its own send
      expect(await app.waitFor<UndeliverableFrame>("undeliverable")).toEqual({
        t: "undeliverable",
        to: bId,
        iv: stale.iv,
        code: "not_leader",
      });
    }
    await b.daemon.expectNo("msg");

    const current = envelope(aId, SCHEDULER_ID);
    app.send({ t: "msg", env: current, term: term + 1 });
    expect((await a.daemon.waitFor<DaemonMsg>("msg")).env).toEqual(current);

    await leave(app, b.daemon, bId);
    await leave(app, a.daemon, aId);
    app.close();
  });

  // The daemon hands the role back with a roleless register (Gap A). What makes
  // that safe is that only the leader's key can sign one for its id: a token
  // holder's attempt is refused like any unverified register, and moves nothing.
  test("a roleless register for the leader's id that its key did not sign is refused, and the leader keeps its term", async () => {
    const app = await connectApp(hub);
    const leaderId = listedId();
    const otherId = listedId();
    const leader = await join(app, leaderId, { roles: SCHEDULER });
    const { term } = await leader.daemon.waitFor<LeadFrame>("lead");
    const other = await join(app, otherId, { roles: SCHEDULER });

    const ts = Date.now();
    const forged = {
      ...(await register(leaderId, { roles: [], ts })),
      sig: (await register(otherId, { roles: [], ts })).sig,
    };
    const squatter = await connectDaemon(hub);
    squatter.send(forged);
    expect(await squatter.waitClosed()).toBe(1000);
    await leader.daemon.expectNo("follow");
    await other.daemon.expectNo("lead");
    const observer = await connectApp(hub);
    expect((await observer.waitFor<RegistryFrame>("registry")).scheduler).toEqual({ deviceId: leaderId, term });
    observer.close();

    // The leader's own roleless register, on its own socket, hands the role on at once.
    leader.daemon.send(await register(leaderId, { roles: [] }));
    expect(await leader.daemon.waitFor("follow")).toEqual({ t: "follow" });
    expect(await other.daemon.waitFor<LeadFrame>("lead")).toEqual({ t: "lead", term: term + 1 });

    await leave(app, other.daemon, otherId);
    await leave(app, leader.daemon, leaderId);
    app.close();
  });

  test("a leader keeps the role across its own reconnect, under a new term on the new socket", async () => {
    const app = await connectApp(hub);
    const leaderId = listedId();
    const otherId = listedId();
    const first = await join(app, leaderId, { roles: SCHEDULER });
    const { term } = await first.daemon.waitFor<LeadFrame>("lead");
    const other = await join(app, otherId, { roles: SCHEDULER });

    const redialed = await connectDaemon(hub);
    heartbeat(redialed);
    quiet(first.daemon);
    redialed.send(await register(leaderId, { roles: SCHEDULER }));
    expect(await redialed.waitFor<LeadFrame>("lead")).toEqual({ t: "lead", term: term + 1 });
    expect(await first.daemon.waitClosed()).toBe(1000);
    await nextRegistry(app, (frame) => frame.scheduler?.deviceId === leaderId && frame.scheduler.term === term + 1);
    await other.daemon.expectNo("lead");

    await leave(app, redialed, leaderId);
    await leave(app, other.daemon, otherId);
    app.close();
  });

  // The relay cannot read a proof, so it keeps one only where a real leader's
  // would come from: that leader's own socket, under the current term, first
  // one wins. Whether it opens, and names that term, is the app's check.
  test("a lead proof rides the push only from the leader's socket under its term, once; a new term starts without one", async () => {
    const app = await connectApp(hub);
    const leaderId = listedId();
    const otherId = listedId();
    const first = await join(app, leaderId, { roles: SCHEDULER });
    const { term } = await first.daemon.waitFor<LeadFrame>("lead");
    const other = await join(app, otherId, { roles: SCHEDULER });
    expect(other.registry.scheduler).toEqual({ deviceId: leaderId, term });

    const proof = envelope(APP_ID, leaderId);
    // Another machine's, another term's, or sealed somewhere but the app: none is kept.
    other.daemon.send({ t: "lead-proof", term, env: envelope(APP_ID, otherId) });
    first.daemon.send({ t: "lead-proof", term: term + 1, env: envelope(APP_ID, leaderId) });
    first.daemon.send({ t: "lead-proof", term, env: envelope(otherId, leaderId) });
    first.daemon.send({ t: "lead-proof", term, env: proof });
    const proven = await nextRegistry(app, (frame) => frame.scheduler?.proof !== undefined);
    expect(proven.scheduler).toEqual({ deviceId: leaderId, term, proof });

    // A second one is not kept either: the next push still carries the first.
    first.daemon.send({ t: "lead-proof", term, env: envelope(APP_ID, leaderId) });
    const late = await connectApp(hub);
    expect((await late.waitFor<RegistryFrame>("registry")).scheduler).toEqual({ deviceId: leaderId, term, proof });
    late.close();

    const redialed = await connectDaemon(hub);
    heartbeat(redialed);
    quiet(first.daemon);
    redialed.send(await register(leaderId, { roles: SCHEDULER }));
    expect(await redialed.waitFor<LeadFrame>("lead")).toEqual({ t: "lead", term: term + 1 });
    const next = await nextRegistry(app, (frame) => frame.scheduler?.term === term + 1);
    expect(next.scheduler).toEqual({ deviceId: leaderId, term: term + 1 });

    await leave(app, redialed, leaderId);
    await leave(app, other.daemon, otherId);
    app.close();
  });

  // The M3 gate's exit (docs/scheduler.md): a bearer-token holder mints an id,
  // signs roles and holds the oldest socket, the one a real leader's sleeps and
  // network changes keep resetting. Not on the list, it never leads.
  test("a self-minted daemon with signed roles is never nominated, however long it holds its socket; a listed one is", async () => {
    const app = await connectApp(hub);
    const squatterId = await newDeviceId();
    const leaderId = listedId();
    const squatter = await join(app, squatterId, { roles: SCHEDULER });
    expect(squatter.registry.scheduler).toBeNull();
    await squatter.daemon.expectNo("lead");
    const lone = envelope(SCHEDULER_ID, APP_ID);
    app.send({ t: "msg", env: lone });
    expect((await app.waitFor<UndeliverableFrame>("undeliverable")).code).toBe("offline");
    await squatter.daemon.expectNo("msg");

    const leader = await join(app, leaderId, { roles: SCHEDULER });
    const { term } = await leader.daemon.waitFor<LeadFrame>("lead");
    expect(leader.registry.scheduler).toEqual({ deviceId: leaderId, term });
    const routed = envelope(SCHEDULER_ID, APP_ID);
    app.send({ t: "msg", env: routed });
    expect((await leader.daemon.waitFor<DaemonMsg>("msg")).env).toEqual(routed);

    // The listed leader goes; the squatter, connected longest, is still no candidate.
    expect((await leave(app, leader.daemon, leaderId)).scheduler).toBeNull();
    await squatter.daemon.expectNo("lead");
    await squatter.daemon.expectNo("msg");
    await leave(app, squatter.daemon, squatterId);
    app.close();
  });

  test("junk in SCHEDULER_LEADERS is ignored, and an entry padded with whitespace still leads", async () => {
    const app = await connectApp(hub);
    const joined = await join(app, padded, { roles: SCHEDULER });
    const { term } = await joined.daemon.waitFor<LeadFrame>("lead");
    expect(joined.registry.scheduler).toEqual({ deviceId: padded, term });
    await leave(app, joined.daemon, padded);
    app.close();
  });

  test("a leader that stops heartbeating is replaced within one sweep", async () => {
    const app = await connectApp(hub);
    const silentId = listedId();
    const liveId = listedId();
    const silent = await join(app, silentId, { roles: SCHEDULER, heartbeat: false });
    const { term } = await silent.daemon.waitFor<LeadFrame>("lead");
    const live = await join(app, liveId, { roles: SCHEDULER });

    expect(await silent.daemon.waitClosed(10_000)).toBe(1000);
    expect(await live.daemon.waitFor<LeadFrame>("lead", 5_000)).toEqual({ t: "lead", term: term + 1 });
    await nextRegistry(app, (frame) => frame.scheduler?.deviceId === liveId);

    await leave(app, live.daemon, liveId);
    app.close();
  }, 15_000);
});
