import {
  APP_ID,
  MAX_STORE_CREATES_PER_WINDOW,
  MAX_TASKS,
  SCHEDULER_ID,
  STORE_CREATE_MAX_CT_LENGTH,
  STORE_MAX_CT_LENGTH,
  STORE_PREFIXES,
  parseStoreChanged,
  parseStoreReply,
  type Envelope,
  type RelayToAppFrame,
  type RelayToDaemonFrame,
  type StoreRecord,
  type StoreReplyFrame,
} from "@seance/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  connectApp,
  connectDaemon,
  connectZombieDaemon,
  envelope,
  newDeviceId,
  register,
  startRelay,
  type Client,
  type TestRelay,
} from "./harness.ts";
import { LIST_BURST, MAX_LISTS_PER_WINDOW } from "../src/store.ts";

const TOKEN = "test-bearer-token";
const SCHEDULER = ["scheduler"];

type RegistryFrame = Extract<RelayToAppFrame, { t: "registry" }>;
type LeadFrame = Extract<RelayToDaemonFrame, { t: "lead" }>;

/**
 * Sleeping around every boot: bun runs every relay test file in one process, and
 * booting workerd within ~100 ms of a dispose breaks its stdio (CLAUDE.md,
 * Testing). Both sides, so either file order is covered.
 */
const SETTLE_MS = 500;

/** Daemons here never heartbeat, so the sweep is pushed out of reach rather than fed. */
const NO_SWEEP = { sweepIntervalMs: 60_000, sweepSilenceLimitMs: 3_600_000 };

/** The sentinel every ciphertext here is built from: the last test finds it in no log line. */
const MARKER = "U0VOVElORUw";

function ctOf(length: number): string {
  return MARKER.repeat(Math.ceil(length / MARKER.length)).slice(0, length);
}

function sealed(ctLength = 64): Envelope {
  return { ...envelope(SCHEDULER_ID, APP_ID), ct: ctOf(ctLength) };
}

let requests = 0;
let tasks = 0;

function taskKey(tag = "t"): string {
  tasks += 1;
  return `task:${tag}-${tasks}`;
}

let accounts = 0;

function accountKey(): string {
  accounts += 1;
  return `account:a-${accounts}`;
}

/** Fixed keys for the caps suite, which fills a fresh relay each test. */
const capKey = (i: number): string => `task:c-${String(i).padStart(3, "0")}`;
const accountCapKey = (i: number): string => `account:c-${String(i).padStart(3, "0")}`;

/**
 * One store request and its reply, parsed by the shared client parser: a reply
 * the item 2/3 clients would reject fails here, not in their suites.
 */
async function ask(
  client: Client,
  frame: Record<string, unknown>,
  timeoutMs = 5_000,
  forbid?: string,
): Promise<StoreReplyFrame> {
  requests += 1;
  const id = `q-${requests}`;
  client.send({ ...frame, id });
  const raw = await client.waitForRe<{ re: string }>(id, timeoutMs, forbid);
  const reply = parseStoreReply(raw);
  if (reply === null) throw new Error(`a client would reject this reply: ${JSON.stringify(raw)}`);
  return reply;
}

const put = (
  client: Client,
  key: string,
  expectVersion: number,
  env: Envelope,
  term?: number,
): Promise<StoreReplyFrame> =>
  ask(client, { t: "store-put", key, expect: expectVersion, env, ...(term === undefined ? {} : { term }) });

const del = (client: Client, key: string, expectVersion: number, term?: number): Promise<StoreReplyFrame> =>
  ask(client, { t: "store-delete", key, expect: expectVersion, ...(term === undefined ? {} : { term }) });

async function get(client: Client, key: string): Promise<StoreRecord | null> {
  const reply = await ask(client, { t: "store-get", key });
  if (reply.t !== "store-record") throw new Error(`expected store-record, got ${JSON.stringify(reply)}`);
  return reply.record;
}

async function list(client: Client, prefix: string, timeoutMs?: number): Promise<readonly StoreRecord[]> {
  const reply = await ask(client, { t: "store-list", prefix }, timeoutMs);
  if (reply.t !== "store-listed") throw new Error(`expected store-listed, got ${JSON.stringify(reply)}`);
  return reply.records;
}

const written = (version: number): Record<string, unknown> => ({ t: "store-written", version });
const refused = (code: string): Record<string, unknown> => ({ t: "store-refused", code });

async function until(
  ready: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
  everyMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    // oxlint-disable-next-line no-await-in-loop -- a poll between attempts is the point
    await Bun.sleep(everyMs);
  }
}

async function registryWhere(observer: Client, matches: (frame: RegistryFrame) => boolean): Promise<void> {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- registry pushes arrive in order; each is checked in turn
    if (matches(await observer.waitFor<RegistryFrame>("registry", 5_000))) return;
  }
}

const connectedIs =
  (deviceId: string, want: boolean) =>
  (frame: RegistryFrame): boolean =>
    frame.entries.some((entry) => entry.deviceId === deviceId && entry.connected === want);

function expectNoCiphertext(lines: readonly string[]): void {
  expect(lines.filter((line) => line.includes(MARKER))).toEqual([]);
}

/** The suite's shared rig: ids listed in SCHEDULER_LEADERS, an observer app, and daemons that join and leave. */
function rig(): {
  readonly boot: (opts?: { tombstoneMs?: number; leaders?: number }) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly relay: () => TestRelay;
  readonly leaderId: () => string;
  readonly join: (observer: Client, id: string, roles?: readonly string[]) => Promise<Client>;
  readonly leave: (observer: Client, daemon: Client, id: string) => Promise<void>;
  readonly lead: (observer: Client) => Promise<{ daemon: Client; id: string; term: number }>;
  readonly dismiss: (observer: Client, leader: { daemon: Client; id: string }) => Promise<void>;
} {
  let hub: TestRelay | undefined;
  const listed: string[] = [];
  const current = (): TestRelay => {
    if (hub === undefined) throw new Error("relay not booted");
    return hub;
  };
  const join = async (observer: Client, id: string, roles: readonly string[] = SCHEDULER): Promise<Client> => {
    const daemon = await connectDaemon(current());
    daemon.send(await register(id, { roles }));
    await registryWhere(observer, connectedIs(id, true));
    return daemon;
  };
  const leave = async (observer: Client, daemon: Client, id: string): Promise<void> => {
    daemon.close();
    await registryWhere(observer, connectedIs(id, false));
  };
  const leaderId = (): string => {
    const id = listed.shift();
    if (id === undefined) throw new Error("out of listed ids");
    return id;
  };
  return {
    boot: async (opts = {}) => {
      await Bun.sleep(SETTLE_MS);
      // A fresh relay lists only its own ids: one left over from the last boot could never lead.
      listed.length = 0;
      listed.push(...(await Promise.all(Array.from({ length: opts.leaders ?? 16 }, () => newDeviceId()))));
      hub = await startRelay(TOKEN, {
        leaders: listed,
        captureLogs: true,
        sweep: NO_SWEEP,
        ...(opts.tombstoneMs === undefined ? {} : { tombstoneMs: opts.tombstoneMs }),
      });
    },
    stop: async () => {
      const booted = hub;
      hub = undefined;
      await booted?.dispose();
      await Bun.sleep(SETTLE_MS);
    },
    relay: current,
    leaderId,
    join,
    leave,
    lead: async (observer) => {
      const id = leaderId();
      const daemon = await join(observer, id);
      const { term } = await daemon.waitFor<LeadFrame>("lead", 5_000);
      return { daemon, id, term };
    },
    dismiss: (observer, leader) => leave(observer, leader.daemon, leader.id),
  };
}

describe("relay store: rules, versions and tombstones", () => {
  const rigA = rig();

  beforeAll(() => rigA.boot());
  afterAll(() => rigA.stop());

  test("an app enqueues with no daemon connected; the record lists and gets back byte-identical", async () => {
    const app = await connectApp(rigA.relay());
    const key = taskKey();
    const env = sealed(200);
    expect(await put(app, key, 0, env)).toMatchObject(written(1));
    const records = await list(app, "task:");
    expect(records.find((record) => record.key === key)).toEqual({ key, version: 1, env });
    expect(await get(app, key)).toEqual({ key, version: 1, env });
    expect(await get(app, taskKey())).toBeNull();
    app.close();
  });

  test("creating a key again is version_conflict and the first env stays: an enqueue retry is idempotent", async () => {
    const app = await connectApp(rigA.relay());
    const key = taskKey();
    const first = sealed(100);
    expect(await put(app, key, 0, first)).toMatchObject(written(1));
    expect(await put(app, key, 0, sealed(120))).toMatchObject(refused("version_conflict"));
    expect(await get(app, key)).toEqual({ key, version: 1, env: first });
    app.close();
  });

  test("a bearer-token client creates tasks and nothing else, even carrying the current term", async () => {
    const observer = await connectApp(rigA.relay());
    const leader = await rigA.lead(observer);
    const app = await connectApp(rigA.relay());
    const key = taskKey();
    expect(await put(app, key, 0, sealed())).toMatchObject(written(1));

    expect(await put(app, key, 1, sealed())).toMatchObject(refused("forbidden"));
    expect(await del(app, key, 1)).toMatchObject(refused("forbidden"));
    // The term is public on every registry push: on this leg it authorizes nothing.
    expect(await put(app, key, 1, sealed(), leader.term)).toMatchObject(refused("forbidden"));
    expect(await del(app, key, 1, leader.term)).toMatchObject(refused("forbidden"));
    expect(await put(app, "queue:pause", 0, sealed())).toMatchObject(refused("forbidden"));
    expect(await put(app, "queue:pause", 0, sealed(), leader.term)).toMatchObject(refused("forbidden"));
    expect((await get(app, key))?.version).toBe(1);

    app.close();
    await rigA.dismiss(observer, leader);
    observer.close();
  });

  test("the leader overwrites at the version it read; a replay of the first env at the next version is the reader's to reject", async () => {
    const observer = await connectApp(rigA.relay());
    const leader = await rigA.lead(observer);
    const app = await connectApp(rigA.relay());
    const key = taskKey();
    const first = sealed(100);
    const second = sealed(150);
    expect(await put(app, key, 0, first)).toMatchObject(written(1));

    expect(await put(leader.daemon, key, 1, second, leader.term)).toMatchObject(written(2));
    expect(await put(leader.daemon, key, 1, second, leader.term)).toMatchObject(refused("version_conflict"));
    // The relay is blind: version 1's bytes at version 3 are accepted, and the reader's binding refuses them.
    expect(await put(leader.daemon, key, 2, first, leader.term)).toMatchObject(written(3));
    expect(await get(app, key)).toEqual({ key, version: 3, env: first });

    // A delete answers the version it removed, and leaves a tombstone.
    expect(await del(leader.daemon, key, 3, leader.term)).toMatchObject(written(3));
    expect(await get(app, key)).toBeNull();
    expect((await list(app, "task:")).some((record) => record.key === key)).toBe(false);
    expect(await put(app, key, 0, first)).toMatchObject(refused("version_conflict"));
    expect(await put(leader.daemon, key, 3, first, leader.term)).toMatchObject(refused("version_conflict"));
    // The leader creates no task at all, so its re-create is refused before the tombstone is read.
    expect(await put(leader.daemon, key, 0, first, leader.term)).toMatchObject(refused("forbidden"));
    expect(await del(leader.daemon, key, 3, leader.term)).toMatchObject(refused("version_conflict"));
    // A key that never existed is the same answer, whatever `expect` says.
    expect(await del(leader.daemon, taskKey(), 0, leader.term)).toMatchObject(refused("version_conflict"));

    app.close();
    await rigA.dismiss(observer, leader);
    observer.close();
  });

  // No tombstone guards `queue:`, so the relay refuses every delete there: resume overwrites the pause, and a
  // delete could only be a term holder silently unpausing the queue.
  test("queue:pause is the leader's to create and overwrite, and nobody's to delete", async () => {
    const observer = await connectApp(rigA.relay());
    const leader = await rigA.lead(observer);
    const app = await connectApp(rigA.relay());
    const env = sealed();
    expect(await put(leader.daemon, "queue:pause", 0, env, leader.term)).toMatchObject(written(1));
    expect(await put(leader.daemon, "queue:pause", 1, env, leader.term)).toMatchObject(written(2));

    expect(await del(leader.daemon, "queue:pause", 2, leader.term)).toMatchObject(refused("forbidden"));
    expect(await del(app, "queue:pause", 2)).toMatchObject(refused("forbidden"));
    expect(await get(app, "queue:pause")).toEqual({ key: "queue:pause", version: 2, env });

    app.close();
    await rigA.dismiss(observer, leader);
    observer.close();
  });

  test("a daemon write is not_leader without the term, with a non-leader's copy of it, and after the term moved", async () => {
    const observer = await connectApp(rigA.relay());
    const oneId = rigA.leaderId();
    const twoId = rigA.leaderId();
    const one = await rigA.join(observer, oneId);
    const { term } = await one.waitFor<LeadFrame>("lead", 5_000);
    const two = await rigA.join(observer, twoId);
    const app = await connectApp(rigA.relay());
    const key = taskKey();
    expect(await put(app, key, 0, sealed())).toMatchObject(written(1));

    expect(await put(one, key, 1, sealed())).toMatchObject(refused("not_leader"));
    // Listed, registered and capable, but not the socket the term was issued to.
    expect(await put(two, key, 1, sealed(), term)).toMatchObject(refused("not_leader"));
    expect(await put(one, key, 1, sealed(), term - 1)).toMatchObject(refused("not_leader"));
    expect(await put(two, taskKey(), 0, sealed(), term)).toMatchObject(refused("not_leader"));
    expect(await put(one, key, 1, sealed(), term)).toMatchObject(written(2));

    // One resigns with a roleless register; two takes the term.
    one.send(await register(oneId, { roles: [] }));
    await one.waitFor("follow", 5_000);
    const next = await two.waitFor<LeadFrame>("lead", 5_000);
    expect(next.term).toBe(term + 1);
    expect(await put(one, key, 2, sealed(), term)).toMatchObject(refused("not_leader"));
    expect(await put(one, key, 2, sealed(), next.term)).toMatchObject(refused("not_leader"));
    expect(await put(two, key, 2, sealed(), next.term)).toMatchObject(written(3));

    app.close();
    await rigA.leave(observer, one, oneId);
    await rigA.leave(observer, two, twoId);
    observer.close();
  });

  test("a leader that redials gets a new term, and the old term from the new socket is not_leader", async () => {
    const observer = await connectApp(rigA.relay());
    const leader = await rigA.lead(observer);
    const app = await connectApp(rigA.relay());
    const key = taskKey();
    expect(await put(app, key, 0, sealed())).toMatchObject(written(1));
    app.close();

    const redialed = await connectDaemon(rigA.relay());
    redialed.send(await register(leader.id, { roles: SCHEDULER }));
    const next = await redialed.waitFor<LeadFrame>("lead", 5_000);
    expect(next.term).toBe(leader.term + 1);
    await leader.daemon.waitClosed(5_000);

    expect(await put(redialed, key, 1, sealed(), leader.term)).toMatchObject(refused("not_leader"));
    expect(await put(redialed, key, 1, sealed(), next.term)).toMatchObject(written(2));

    await rigA.leave(observer, redialed, leader.id);
    observer.close();
  });

  test("store-changed goes to the leader's socket for an app write, and to no follower or the leader's own write", async () => {
    const observer = await connectApp(rigA.relay());
    const leader = await rigA.lead(observer);
    const follower = await rigA.join(observer, rigA.leaderId());
    const app = await connectApp(rigA.relay());
    const key = taskKey();

    expect(await put(app, key, 0, sealed())).toMatchObject(written(1));
    const raw = await leader.daemon.waitFor<{ t: string }>("store-changed", 5_000);
    expect(parseStoreChanged(raw)).toEqual({ t: "store-changed", key, version: 1 });

    // Either order: a nudge sent before the leader's own reply fails the ask, one after it the expectNo.
    const own = { t: "store-put", key, expect: 1, env: sealed(), term: leader.term };
    expect(await ask(leader.daemon, own, 5_000, "store-changed")).toMatchObject(written(2));
    await leader.daemon.expectNo("store-changed");
    await follower.expectNo("store-changed");

    // The leader still hears the next app write, so the silence above was about its own write.
    const next = taskKey();
    expect(await put(app, next, 0, sealed())).toMatchObject(written(1));
    const after = await leader.daemon.waitFor<{ t: string }>("store-changed", 5_000);
    expect(parseStoreChanged(after)).toEqual({ t: "store-changed", key: next, version: 1 });
    await follower.expectNo("store-changed");

    app.close();
    follower.close();
    await rigA.dismiss(observer, leader);
    observer.close();
  });

  // Registration is the daemon leg's authority wherever writes are not term-fenced, so nothing on that leg
  // is answered before it — reads included. Refused rather than dropped, so the client settles.
  test("an unregistered daemon socket's store frames are forbidden, reads included, until its register lands", async () => {
    const observer = await connectApp(rigA.relay());
    const stranger = await connectDaemon(rigA.relay());
    const key = taskKey();
    expect(await ask(stranger, { t: "store-list", prefix: "task:" })).toMatchObject(refused("forbidden"));
    expect(await ask(stranger, { t: "store-get", key })).toMatchObject(refused("forbidden"));
    expect(await put(stranger, key, 0, sealed(), 1)).toMatchObject(refused("forbidden"));
    expect(await put(stranger, accountKey(), 0, sealed())).toMatchObject(refused("forbidden"));
    expect(await del(stranger, key, 1, 1)).toMatchObject(refused("forbidden"));
    // A parse refusal meets the same gate: the socket has no rights to be told about yet.
    expect(await ask(stranger, { t: "store-put", key: "device:x", expect: 0, env: sealed() })).toMatchObject(
      refused("forbidden"),
    );

    // A store frame right behind the register meets its outcome, not the socket as it was before it.
    const id = await newDeviceId();
    stranger.send(await register(id, { roles: [] }));
    expect(await get(stranger, key)).toBeNull();
    expect(await list(stranger, "task:")).toBeInstanceOf(Array);
    await rigA.leave(observer, stranger, id);
    observer.close();
  });

  test("a frame with no usable id is dropped and the socket stays usable; one with an id and a bad field is refused", async () => {
    const observer = await connectApp(rigA.relay());
    const daemonId = await newDeviceId();
    const daemon = await rigA.join(observer, daemonId, []);
    const app = await connectApp(rigA.relay());
    for (const client of [daemon, app]) {
      client.send({ t: "store-put" });
      client.send({ t: "store-get", id: "bad id!" });
      // oxlint-disable-next-line no-await-in-loop -- one socket at a time keeps each drop attributable
      await client.expectNo("store-refused");
      // oxlint-disable-next-line no-await-in-loop -- the same socket answers the next valid request
      expect(await list(client, "task:")).toBeInstanceOf(Array);

      for (const frame of [
        { t: "store-get", key: "device:x" },
        { t: "store-get", key: "scheduler:term" },
        { t: "store-put", key: "push:x", expect: 0, env: sealed() },
        { t: "store-list", prefix: "push:" },
        { t: "store-put", key: taskKey(), expect: -1, env: sealed() },
        { t: "store-delete", key: taskKey(), expect: 1.5 },
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- each refusal is matched to its own request id
        expect(await ask(client, frame)).toMatchObject(refused("invalid_request"));
      }
    }

    // `after` is a newer client's paging; this relay answers the whole prefix.
    const whole = await list(app, "task:");
    const paged = await ask(app, { t: "store-list", prefix: "task:", after: "task:z" });
    expect(paged).toEqual({ t: "store-listed", re: paged.re, records: whole });
    await rigA.leave(observer, daemon, daemonId);
    app.close();
    observer.close();
  });

  test("account: apps and registered daemons create and overwrite by expect; nobody deletes, the leader included", async () => {
    const observer = await connectApp(rigA.relay());
    const leader = await rigA.lead(observer);
    const followerId = await newDeviceId();
    const follower = await rigA.join(observer, followerId, []);
    const app = await connectApp(rigA.relay());
    const key = accountKey();
    expect(await put(app, key, 0, sealed())).toMatchObject(written(1));
    expect(await put(follower, key, 1, sealed())).toMatchObject(written(2));
    expect(await put(app, key, 1, sealed())).toMatchObject(refused("version_conflict"));
    expect(await put(app, key, 2, sealed())).toMatchObject(written(3));
    // Not term-fenced: the term changes nothing, on either leg.
    expect(await put(leader.daemon, key, 3, sealed(), leader.term)).toMatchObject(written(4));
    const daemonMade = accountKey();
    expect(await put(follower, daemonMade, 0, sealed())).toMatchObject(written(1));

    expect(await del(app, key, 4)).toMatchObject(refused("forbidden"));
    expect(await del(follower, key, 4)).toMatchObject(refused("forbidden"));
    expect(await del(leader.daemon, key, 4, leader.term)).toMatchObject(refused("forbidden"));
    expect((await get(app, key))?.version).toBe(4);
    const listed = await list(app, "account:");
    expect(listed.map((record) => record.key)).toEqual(expect.arrayContaining([key, daemonMade]));

    app.close();
    await rigA.leave(observer, follower, followerId);
    await rigA.dismiss(observer, leader);
    observer.close();
  });

  test("quota: any registered daemon writes it and no app does; settings: is the term holder's alone; neither deletes", async () => {
    const observer = await connectApp(rigA.relay());
    const leader = await rigA.lead(observer);
    const followerId = await newDeviceId();
    const follower = await rigA.join(observer, followerId, []);
    const app = await connectApp(rigA.relay());

    expect(await put(app, "quota:fleet", 0, sealed())).toMatchObject(refused("forbidden"));
    expect(await put(follower, "quota:fleet", 0, sealed())).toMatchObject(written(1));
    expect(await put(leader.daemon, "quota:fleet", 1, sealed())).toMatchObject(written(2));
    expect(await put(app, "quota:fleet", 2, sealed())).toMatchObject(refused("forbidden"));
    expect(await del(follower, "quota:fleet", 2)).toMatchObject(refused("forbidden"));
    expect(await del(leader.daemon, "quota:fleet", 2, leader.term)).toMatchObject(refused("forbidden"));

    expect(await put(app, "settings:vapid", 0, sealed())).toMatchObject(refused("forbidden"));
    expect(await put(follower, "settings:vapid", 0, sealed(), leader.term)).toMatchObject(refused("not_leader"));
    expect(await put(leader.daemon, "settings:vapid", 0, sealed(), leader.term)).toMatchObject(written(1));
    expect(await put(leader.daemon, "settings:vapid", 1, sealed(), leader.term)).toMatchObject(written(2));
    expect(await del(leader.daemon, "settings:vapid", 2, leader.term)).toMatchObject(refused("forbidden"));
    expect((await get(app, "settings:vapid"))?.version).toBe(2);

    app.close();
    await rigA.leave(observer, follower, followerId);
    await rigA.dismiss(observer, leader);
    observer.close();
  });

  test("quota: and queue: take their one key alone; quota:fleet creates", async () => {
    const observer = await connectApp(rigA.relay());
    const leader = await rigA.lead(observer);
    const app = await connectApp(rigA.relay());
    expect(await put(leader.daemon, "quota:junk", 0, sealed())).toMatchObject(refused("invalid_request"));
    expect(await put(leader.daemon, "queue:other", 0, sealed(), leader.term)).toMatchObject(refused("invalid_request"));
    expect(await put(app, "quota:junk", 0, sealed())).toMatchObject(refused("invalid_request"));
    expect(await ask(app, { t: "store-get", key: "quota:junk" })).toMatchObject(refused("invalid_request"));
    const current = (await get(app, "quota:fleet"))?.version ?? 0;
    expect(await put(leader.daemon, "quota:fleet", current, sealed())).toMatchObject(written(current + 1));

    app.close();
    await rigA.dismiss(observer, leader);
    observer.close();
  });

  test("a follower's quota:fleet write nudges the leader, and the leader's own write, with or without the term, does not", async () => {
    const observer = await connectApp(rigA.relay());
    const leader = await rigA.lead(observer);
    const followerId = await newDeviceId();
    const follower = await rigA.join(observer, followerId, []);
    const app = await connectApp(rigA.relay());
    let version = (await get(app, "quota:fleet"))?.version ?? 0;

    expect(await put(follower, "quota:fleet", version, sealed())).toMatchObject(written(version + 1));
    version += 1;
    const raw = await leader.daemon.waitFor<{ t: string }>("store-changed", 5_000);
    expect(parseStoreChanged(raw)).toEqual({ t: "store-changed", key: "quota:fleet", version });

    for (const term of [undefined, leader.term]) {
      const own = {
        t: "store-put",
        key: "quota:fleet",
        expect: version,
        env: sealed(),
        ...(term === undefined ? {} : { term }),
      };
      // oxlint-disable-next-line no-await-in-loop -- sequential: each overwrite is at the version the last made
      expect(await ask(leader.daemon, own, 5_000, "store-changed")).toMatchObject(written(version + 1));
      version += 1;
      // oxlint-disable-next-line no-await-in-loop -- a non-event per write
      await leader.daemon.expectNo("store-changed");
    }
    await follower.expectNo("store-changed");

    app.close();
    await rigA.leave(observer, follower, followerId);
    await rigA.dismiss(observer, leader);
    observer.close();
  });

  // The zombie never reads, so the effect is the evidence: what it wrote, an app reads back.
  test("store frames on a superseded daemon socket are forbidden: its write never lands", async () => {
    const observer = await connectApp(rigA.relay());
    const id = await newDeviceId();
    const zombie = await connectZombieDaemon(rigA.relay());
    try {
      zombie.send(await register(id, { roles: [] }));
      await registryWhere(observer, connectedIs(id, true));
      const successor = await connectDaemon(rigA.relay());
      successor.send(await register(id, { roles: [] }));
      await until(async () => (await put(successor, accountKey(), 0, sealed())).t === "store-written", "the successor");

      const key = accountKey();
      zombie.send({ t: "store-put", id: "z-1", key, expect: 0, env: sealed() });
      await Bun.sleep(500);
      expect(await get(observer, key)).toBeNull();
      expect(await put(successor, key, 0, sealed())).toMatchObject(written(1));
      await rigA.leave(observer, successor, id);
    } finally {
      zombie.destroy();
      observer.close();
    }
  });

  test("a store frame right behind a register that fails verify is refused, not served on the earlier identity", async () => {
    const observer = await connectApp(rigA.relay());
    const id = await newDeviceId();
    const zombie = await connectZombieDaemon(rigA.relay());
    try {
      zombie.send(await register(id, { roles: [] }));
      await registryWhere(observer, connectedIs(id, true));
      const key = accountKey();
      // A stale timestamp fails verify; the put is queued behind it on the same socket.
      zombie.send(await register(id, { roles: [], ts: 1 }));
      zombie.send({ t: "store-put", id: "z-2", key, expect: 0, env: sealed() });
      await Bun.sleep(500);
      expect(await get(observer, key)).toBeNull();
    } finally {
      zombie.destroy();
      observer.close();
    }
  });

  test("overwrites on account: spend the write floor: past it a socket's overwrite is rate_limited, and a fresh socket starts over", async () => {
    const app = await connectApp(rigA.relay());
    const key = accountKey();
    expect(await put(app, key, 0, sealed())).toMatchObject(written(1));
    for (let version = 1; version < MAX_STORE_CREATES_PER_WINDOW; version += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential: the floor counts landed writes in order
      expect(await put(app, key, version, sealed())).toMatchObject(written(version + 1));
    }
    expect(await put(app, key, MAX_STORE_CREATES_PER_WINDOW, sealed())).toMatchObject(refused("rate_limited"));
    // A refusal leaves the record as it was.
    expect((await get(app, key))?.version).toBe(MAX_STORE_CREATES_PER_WINDOW);
    const fresh = await connectApp(rigA.relay());
    expect(await put(fresh, key, MAX_STORE_CREATES_PER_WINDOW, sealed())).toMatchObject(
      written(MAX_STORE_CREATES_PER_WINDOW + 1),
    );
    app.close();
    fresh.close();
  }, 30_000);

  test("store-changed reaches every other app for an account: write, and the leader for any write its term socket did not make", async () => {
    const observer = await connectApp(rigA.relay());
    const leader = await rigA.lead(observer);
    const followerId = await newDeviceId();
    const follower = await rigA.join(observer, followerId, []);
    const writer = await connectApp(rigA.relay());
    const reader = await connectApp(rigA.relay());
    const key = accountKey();
    const changed = (client: Client): Promise<unknown> =>
      client.waitFor<{ t: string }>("store-changed", 5_000).then(parseStoreChanged);

    // The writer hears nothing about its own write, before or after its reply.
    const create = { t: "store-put", key, expect: 0, env: sealed() };
    expect(await ask(writer, create, 5_000, "store-changed")).toMatchObject(written(1));
    expect(await changed(reader)).toEqual({ t: "store-changed", key, version: 1 });
    expect(await changed(leader.daemon)).toEqual({ t: "store-changed", key, version: 1 });
    await writer.expectNo("store-changed");

    // A daemon's write reaches every app and the leader; the leader's own reaches the apps, not itself.
    expect(await put(follower, key, 1, sealed())).toMatchObject(written(2));
    expect(await changed(writer)).toMatchObject({ key, version: 2 });
    expect(await changed(reader)).toMatchObject({ key, version: 2 });
    expect(await changed(leader.daemon)).toMatchObject({ key, version: 2 });
    const own = { t: "store-put", key, expect: 2, env: sealed() };
    expect(await ask(leader.daemon, own, 5_000, "store-changed")).toMatchObject(written(3));
    expect(await changed(reader)).toMatchObject({ key, version: 3 });
    await leader.daemon.expectNo("store-changed");

    // `task:` is no app-writable prefix: the leader hears an enqueue, no app does.
    const task = taskKey();
    expect(await put(writer, task, 0, sealed())).toMatchObject(written(1));
    expect(await changed(leader.daemon)).toMatchObject({ key: task, version: 1 });
    await reader.expectNo("store-changed");
    await follower.expectNo("store-changed");

    writer.close();
    reader.close();
    await rigA.leave(observer, follower, followerId);
    await rigA.dismiss(observer, leader);
    observer.close();
  });

  test("size: a create holds less than an overwrite, on both legs, and the bounds themselves land", async () => {
    const observer = await connectApp(rigA.relay());
    const leader = await rigA.lead(observer);
    const app = await connectApp(rigA.relay());
    const key = taskKey();
    expect(await put(app, key, 0, sealed(STORE_CREATE_MAX_CT_LENGTH))).toMatchObject(written(1));
    expect(await put(app, taskKey(), 0, sealed(STORE_CREATE_MAX_CT_LENGTH + 1))).toMatchObject(refused("too_large"));
    expect(await put(leader.daemon, taskKey(), 0, sealed(STORE_CREATE_MAX_CT_LENGTH + 1), leader.term)).toMatchObject(
      refused("too_large"),
    );
    expect(await put(leader.daemon, key, 1, sealed(STORE_MAX_CT_LENGTH), leader.term)).toMatchObject(written(2));
    expect(await put(leader.daemon, key, 2, sealed(STORE_MAX_CT_LENGTH + 1), leader.term)).toMatchObject(
      refused("too_large"),
    );
    expect((await get(app, key))?.version).toBe(2);

    app.close();
    await rigA.dismiss(observer, leader);
    observer.close();
  });

  test("the create floor: sixty creates per socket per window, a fresh socket starts over, the leader creates none", async () => {
    const observer = await connectApp(rigA.relay());
    const leader = await rigA.lead(observer);
    const created: string[] = [];
    const app = await connectApp(rigA.relay());
    for (let i = 0; i < MAX_STORE_CREATES_PER_WINDOW; i += 1) {
      const key = taskKey("f");
      created.push(key);
      // oxlint-disable-next-line no-await-in-loop -- sequential: the floor counts landed creates in order
      expect(await put(app, key, 0, sealed())).toMatchObject(written(1));
    }
    expect(await put(app, taskKey("f"), 0, sealed())).toMatchObject(refused("rate_limited"));

    const fresh = await connectApp(rigA.relay());
    const other = taskKey("f");
    created.push(other);
    expect(await put(fresh, other, 0, sealed())).toMatchObject(written(1));
    // Only apps enqueue: the term holder meets no floor, so it gets no creates to churn.
    expect(await put(leader.daemon, taskKey("f"), 0, sealed(), leader.term)).toMatchObject(refused("forbidden"));

    // Room for the next test: deletes leave tombstones, which count toward no record cap.
    for (const key of created) {
      // oxlint-disable-next-line no-await-in-loop -- each delete is matched to its own reply
      expect(await del(leader.daemon, key, 1, leader.term)).toMatchObject(written(1));
    }
    app.close();
    fresh.close();
    await rigA.dismiss(observer, leader);
    observer.close();
  }, 30_000);

  // A refused or conflicting create never counted, so the retry of one that landed cannot read rate_limited.
  test("the floor counts landed creates only: retries of a landed create are version_conflict, never rate_limited", async () => {
    const observer = await connectApp(rigA.relay());
    const leader = await rigA.lead(observer);
    const created: string[] = [];
    const app = await connectApp(rigA.relay());
    const first = taskKey("g");
    created.push(first);
    const env = sealed();
    expect(await put(app, first, 0, env)).toMatchObject(written(1));
    for (let i = 0; i < MAX_STORE_CREATES_PER_WINDOW + 10; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential: any rate_limited among them is the bug
      expect(await put(app, first, 0, env)).toMatchObject(refused("version_conflict"));
    }
    for (let i = 1; i < MAX_STORE_CREATES_PER_WINDOW; i += 1) {
      const key = taskKey("g");
      created.push(key);
      // oxlint-disable-next-line no-await-in-loop -- sequential, as above
      expect(await put(app, key, 0, sealed())).toMatchObject(written(1));
    }
    expect(await put(app, taskKey("g"), 0, sealed())).toMatchObject(refused("rate_limited"));

    for (const key of created) {
      // oxlint-disable-next-line no-await-in-loop -- each delete is matched to its own reply
      expect(await del(leader.daemon, key, 1, leader.term)).toMatchObject(written(1));
    }
    app.close();
    await rigA.dismiss(observer, leader);
    observer.close();
  }, 30_000);

  // Its own write and refusal, so the check holds in any test order; run last, it covers this suite's relay.
  // The caps suite's per-test relays are checked in its `afterEach`.
  test("no relay log line holds a record's ciphertext", async () => {
    const app = await connectApp(rigA.relay());
    const key = taskKey();
    expect(await put(app, key, 0, sealed(200))).toMatchObject(written(1));
    expect(await put(app, key, 1, sealed(200))).toMatchObject(refused("forbidden"));
    app.close();

    const lines = rigA.relay().logs();
    expectNoCiphertext(lines);
    // Refusals are logged (with no ciphertext); the marker never appears.
    expect(lines.some((line) => line.startsWith("store refused"))).toBe(true);
  });
});

// A relay per test: each cap needs the store at a known fill, and `queue:` keys nobody may delete
// would leave the next test a different one.
describe("relay store: caps", () => {
  const rigB = rig();

  beforeEach(() => rigB.boot({ leaders: 1 }));
  afterEach(async () => {
    // After a failed boot `relay()` throws; `stop` still runs.
    try {
      expectNoCiphertext(rigB.relay().logs());
    } finally {
      await rigB.stop();
    }
  });

  /** `task:` filled to `MAX_TASKS` by apps, at version 1 and the default size: a socket per create window's worth. */
  async function fillTasks(): Promise<void> {
    for (let start = 0; start < MAX_TASKS; start += MAX_STORE_CREATES_PER_WINDOW) {
      // oxlint-disable-next-line no-await-in-loop -- a fresh socket once the last one's floor is spent
      const app = await connectApp(rigB.relay());
      for (let i = start; i < Math.min(MAX_TASKS, start + MAX_STORE_CREATES_PER_WINDOW); i += 1) {
        // oxlint-disable-next-line no-await-in-loop -- sequential fill to the cap
        expect(await put(app, capKey(i), 0, sealed())).toMatchObject(written(1));
      }
      app.close();
    }
  }

  test("a full task: prefix refuses creates, but a retried create still reads version_conflict", async () => {
    const observer = await connectApp(rigB.relay());
    const leader = await rigB.lead(observer);
    const app = await connectApp(rigB.relay());
    await fillTasks();
    expect(await put(app, "task:x-1", 0, sealed())).toMatchObject(refused("store_full"));
    // The version check comes before the caps: the retry of a create that landed is not a full-store answer.
    expect(await put(app, "task:c-000", 0, sealed())).toMatchObject(refused("version_conflict"));

    // A tombstone counts toward no cap, so a delete frees exactly one slot.
    expect(await del(leader.daemon, "task:c-000", 1, leader.term)).toMatchObject(written(1));
    expect(await put(app, "task:x-3", 0, sealed())).toMatchObject(written(1));
    expect(await put(app, "task:x-4", 0, sealed())).toMatchObject(refused("store_full"));
    expect(await put(app, "task:c-000", 0, sealed())).toMatchObject(refused("version_conflict"));
    app.close();
    await rigB.dismiss(observer, leader);
    observer.close();
  }, 60_000);

  test("a full prefix lists as one frame, ascending by key", async () => {
    const observer = await connectApp(rigB.relay());
    const leader = await rigB.lead(observer);
    await fillTasks();
    // Creates are capped below `STORE_MAX_CT_LENGTH`, so each record reaches it by an overwrite.
    for (let i = 0; i < MAX_TASKS; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential: 128 records at the largest size
      const reply = await put(leader.daemon, capKey(i), 1, sealed(STORE_MAX_CT_LENGTH), leader.term);
      expect(reply).toMatchObject(written(2));
    }
    const records = await list(leader.daemon, "task:", 20_000);
    expect(records).toHaveLength(MAX_TASKS);
    const keys = records.map((record) => record.key);
    expect(keys).toEqual(keys.toSorted());
    for (const record of records) expect(record.env.ct).toHaveLength(STORE_MAX_CT_LENGTH);
    await rigB.dismiss(observer, leader);
    observer.close();
  }, 90_000);

  test("a full task: leaves the other prefixes room, and the singleton prefixes take their one key alone", async () => {
    const observer = await connectApp(rigB.relay());
    const leader = await rigB.lead(observer);
    await fillTasks();
    expect(await put(leader.daemon, "queue:pause", 0, sealed(), leader.term)).toMatchObject(written(1));
    expect(await put(leader.daemon, "queue:other", 0, sealed(), leader.term)).toMatchObject(refused("invalid_request"));
    expect(await put(leader.daemon, "quota:fleet", 0, sealed())).toMatchObject(written(1));
    expect(await put(leader.daemon, "quota:other", 0, sealed())).toMatchObject(refused("invalid_request"));
    expect(await put(leader.daemon, "settings:vapid", 0, sealed(), leader.term)).toMatchObject(written(1));
    const app = await connectApp(rigB.relay());
    expect(await put(app, accountCapKey(0), 0, sealed())).toMatchObject(written(1));
    app.close();
    await rigB.dismiss(observer, leader);
    observer.close();
  }, 60_000);

  // On a prefix that is not term-fenced the daemon leg is as open as the app leg, so it meets the same floor.
  test("the write floor binds a daemon's account: creates, survives a re-register, and the cap stops the rest", async () => {
    const observer = await connectApp(rigB.relay());
    const id = await newDeviceId();
    const daemon = await rigB.join(observer, id, []);
    for (let i = 0; i < MAX_STORE_CREATES_PER_WINDOW; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential: the floor counts landed creates in order
      expect(await put(daemon, accountCapKey(i), 0, sealed())).toMatchObject(written(1));
    }
    const next = accountCapKey(MAX_STORE_CREATES_PER_WINDOW);
    expect(await put(daemon, next, 0, sealed())).toMatchObject(refused("rate_limited"));
    // Overwrites spend the same window where the term fence does not cover the prefix.
    expect(await put(daemon, accountCapKey(0), 1, sealed())).toMatchObject(refused("rate_limited"));
    daemon.send(await register(id, { roles: [] }));
    expect(await put(daemon, next, 0, sealed())).toMatchObject(refused("rate_limited"));

    // A fresh socket starts over, and the prefix's cap takes it from there.
    const cap = STORE_PREFIXES.account.cap;
    const fresh = await connectDaemon(rigB.relay());
    fresh.send(await register(id, { roles: [] }));
    await daemon.waitClosed(5_000);
    for (let i = MAX_STORE_CREATES_PER_WINDOW; i < cap; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential fill to the cap
      expect(await put(fresh, accountCapKey(i), 0, sealed())).toMatchObject(written(1));
    }
    expect(await put(fresh, accountCapKey(cap), 0, sealed())).toMatchObject(refused("store_full"));
    await rigB.leave(observer, fresh, id);
    observer.close();
  }, 60_000);
});

describe("relay store: tombstone expiry", () => {
  const rigC = rig();

  beforeAll(() => rigC.boot({ leaders: 2, tombstoneMs: 2_000 }));
  afterAll(() => rigC.stop());

  test("a deleted key refuses a put until its tombstone expires, then a create lands at version 1", async () => {
    const observer = await connectApp(rigC.relay());
    const leader = await rigC.lead(observer);
    const app = await connectApp(rigC.relay());
    const key = taskKey("e");
    expect(await put(app, key, 0, sealed())).toMatchObject(written(1));
    expect(await del(leader.daemon, key, 1, leader.term)).toMatchObject(written(1));
    expect(await put(app, key, 0, sealed())).toMatchObject(refused("version_conflict"));

    await until(async () => (await put(app, key, 0, sealed())).t === "store-written", "the tombstone to expire");
    expect(await get(app, key)).toMatchObject({ key, version: 1 });
    app.close();
    await rigC.dismiss(observer, leader);
    observer.close();
  }, 30_000);
});

// A relay per test: the DO-wide bucket is the object's, so each test starts it full.
describe("relay store: list floors", () => {
  const rigD = rig();

  beforeEach(() => rigD.boot({ leaders: 3 }));
  afterEach(() => rigD.stop());

  const listReply = (client: Client): Promise<StoreReplyFrame> => ask(client, { t: "store-list", prefix: "task:" });

  test("one socket looping lists is rate_limited past its floor, a re-register resets nothing, the term holder is never", async () => {
    const observer = await connectApp(rigD.relay());
    const leader = await rigD.lead(observer);
    const followerId = rigD.leaderId();
    const follower = await rigD.join(observer, followerId);
    const app = await connectApp(rigD.relay());

    for (const client of [app, follower]) {
      for (let i = 0; i < MAX_LISTS_PER_WINDOW; i += 1) {
        // oxlint-disable-next-line no-await-in-loop -- sequential: the floor counts lists in order
        expect((await listReply(client)).t).toBe("store-listed");
      }
      // oxlint-disable-next-line no-await-in-loop -- one socket at a time
      expect(await listReply(client)).toMatchObject(refused("rate_limited"));
    }
    follower.send(await register(followerId, { roles: SCHEDULER }));
    await registryWhere(observer, connectedIs(followerId, true));
    expect(await listReply(follower)).toMatchObject(refused("rate_limited"));

    // Past both floors, as a takeover retried in a loop would be.
    for (let i = 0; i < 2 * LIST_BURST; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential, as above
      expect((await listReply(leader.daemon)).t).toBe("store-listed");
    }
    expect(rigD.relay().logs()).toContain("store refused t=store-list leg=app code=rate_limited");

    app.close();
    await rigD.leave(observer, follower, followerId);
    await rigD.dismiss(observer, leader);
    observer.close();
  }, 30_000);

  test("both floors are per prefix: a socket past its task: lists still lists account:", async () => {
    const app = await connectApp(rigD.relay());
    for (let i = 0; i < MAX_LISTS_PER_WINDOW; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential: the floor counts lists in order
      expect((await listReply(app)).t).toBe("store-listed");
    }
    expect(await listReply(app)).toMatchObject(refused("rate_limited"));
    expect((await ask(app, { t: "store-list", prefix: "account:" })).t).toBe("store-listed");
    app.close();
  });

  test("ten sockets spend the DO-wide bucket between them, and the next term's takeover list still lands", async () => {
    const observer = await connectApp(rigD.relay());
    const apps = await Promise.all(Array.from({ length: 10 }, () => connectApp(rigD.relay())));
    const replies: StoreReplyFrame[] = [];
    for (let i = 0; i < MAX_LISTS_PER_WINDOW; i += 1) {
      for (const app of apps) {
        // oxlint-disable-next-line no-await-in-loop -- sequential, so the bucket's count is the test's
        replies.push(await listReply(app));
      }
    }
    const landed = replies.filter((reply) => reply.t === "store-listed").length;
    // Each socket stays under its own floor, so only the bucket refuses: it holds LIST_BURST, plus a refill or two.
    expect(landed).toBeGreaterThanOrEqual(LIST_BURST);
    expect(landed).toBeLessThan(LIST_BURST + 3);
    const refusals = replies.filter((reply) => reply.t === "store-refused");
    expect(refusals).toHaveLength(replies.length - landed);
    for (const refusal of refusals) expect(refusal).toMatchObject(refused("rate_limited"));

    const leader = await rigD.lead(observer);
    expect((await listReply(leader.daemon)).t).toBe("store-listed");

    for (const app of apps) app.close();
    await rigD.dismiss(observer, leader);
    observer.close();
  }, 30_000);
});
