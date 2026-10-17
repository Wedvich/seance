import {
  APP_ID,
  MAX_RECORDS,
  MAX_STORE_CREATES_PER_WINDOW,
  MAX_TASKS,
  SCHEDULER_ID,
  STORE_CREATE_MAX_CT_LENGTH,
  STORE_MAX_CT_LENGTH,
  parseStoreChanged,
  parseStoreReply,
  type Envelope,
  type RelayToAppFrame,
  type RelayToDaemonFrame,
  type StoreRecord,
  type StoreReplyFrame,
} from "@seance/shared";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  connectApp,
  connectDaemon,
  envelope,
  newDeviceId,
  register,
  startRelay,
  type Client,
  type TestRelay,
} from "./harness.ts";

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

/**
 * One store request and its reply, parsed by the shared client parser: a reply
 * the item 2/3 clients would reject fails here, not in their suites.
 */
async function ask(client: Client, frame: Record<string, unknown>, timeoutMs = 5_000): Promise<StoreReplyFrame> {
  requests += 1;
  const id = `q-${requests}`;
  client.send({ ...frame, id });
  const raw = await client.waitForRe<{ re: string }>(id, timeoutMs);
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
      listed.push(...(await Promise.all(Array.from({ length: opts.leaders ?? 16 }, () => newDeviceId()))));
      hub = await startRelay(TOKEN, {
        leaders: listed,
        captureLogs: true,
        sweep: NO_SWEEP,
        ...(opts.tombstoneMs === undefined ? {} : { tombstoneMs: opts.tombstoneMs }),
      });
    },
    stop: async () => {
      await hub?.dispose();
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
    expect(await put(leader.daemon, key, 0, first, leader.term)).toMatchObject(refused("version_conflict"));
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
    const key = taskKey();

    expect(await put(one, key, 0, sealed())).toMatchObject(refused("not_leader"));
    // Listed, registered and capable, but not the socket the term was issued to.
    expect(await put(two, key, 0, sealed(), term)).toMatchObject(refused("not_leader"));
    expect(await put(one, key, 0, sealed(), term - 1)).toMatchObject(refused("not_leader"));
    expect(await put(one, key, 0, sealed(), term)).toMatchObject(written(1));

    // One resigns with a roleless register; two takes the term.
    one.send(await register(oneId, { roles: [] }));
    await one.waitFor("follow", 5_000);
    const next = await two.waitFor<LeadFrame>("lead", 5_000);
    expect(next.term).toBe(term + 1);
    expect(await put(one, key, 1, sealed(), term)).toMatchObject(refused("not_leader"));
    expect(await put(one, key, 1, sealed(), next.term)).toMatchObject(refused("not_leader"));
    expect(await put(two, key, 1, sealed(), next.term)).toMatchObject(written(2));

    await rigA.leave(observer, one, oneId);
    await rigA.leave(observer, two, twoId);
    observer.close();
  });

  test("a leader that redials gets a new term, and the old term from the new socket is not_leader", async () => {
    const observer = await connectApp(rigA.relay());
    const leader = await rigA.lead(observer);
    const key = taskKey();
    expect(await put(leader.daemon, key, 0, sealed(), leader.term)).toMatchObject(written(1));

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

    expect(await put(leader.daemon, key, 1, sealed(), leader.term)).toMatchObject(written(2));
    await leader.daemon.expectNo("store-changed");
    await follower.expectNo("store-changed");

    app.close();
    follower.close();
    await rigA.dismiss(observer, leader);
    observer.close();
  });

  test("an unregistered daemon socket reads, and its write is not_leader rather than dropped", async () => {
    const stranger = await connectDaemon(rigA.relay());
    const key = taskKey();
    expect(await list(stranger, "task:")).toBeInstanceOf(Array);
    expect(await get(stranger, key)).toBeNull();
    expect(await put(stranger, key, 0, sealed(), 1)).toMatchObject(refused("not_leader"));
    expect(await put(stranger, key, 0, sealed())).toMatchObject(refused("not_leader"));
    expect(await del(stranger, key, 1, 1)).toMatchObject(refused("not_leader"));
    stranger.close();
  });

  test("a frame with no usable id is dropped and the socket stays usable; one with an id and a bad field is refused", async () => {
    const daemon = await connectDaemon(rigA.relay());
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
        { t: "store-put", key: "account:x", expect: 0, env: sealed() },
        { t: "store-list", prefix: "account:" },
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
    daemon.close();
    app.close();
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

  test("the create floor: sixty creates per socket per window, a fresh socket starts over, the leader has none", async () => {
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
    const own = taskKey("f");
    created.push(own);
    expect(await put(leader.daemon, own, 0, sealed(), leader.term)).toMatchObject(written(1));

    // Room for the next test: deletes leave tombstones, which count toward no cap.
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

  test("no relay log line holds a record's ciphertext", () => {
    const lines = rigA.relay().logs();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => line.includes(MARKER))).toEqual([]);
    // Refusals are logged (with no ciphertext); the marker never appears.
    expect(lines.some((line) => line.startsWith("store refused"))).toBe(true);
  });
});

describe("relay store: caps", () => {
  const rigB = rig();

  beforeAll(() => rigB.boot({ leaders: 3 }));
  afterAll(() => rigB.stop());

  test("a full task: prefix refuses creates on both legs, but a retried create still reads version_conflict", async () => {
    const observer = await connectApp(rigB.relay());
    const leader = await rigB.lead(observer);
    const app = await connectApp(rigB.relay());
    for (let i = 0; i < MAX_TASKS; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential fill to the cap
      const reply = await put(leader.daemon, `task:c-${String(i).padStart(3, "0")}`, 0, sealed(), leader.term);
      expect(reply).toMatchObject(written(1));
    }
    expect(await put(app, "task:x-1", 0, sealed())).toMatchObject(refused("store_full"));
    expect(await put(leader.daemon, "task:x-2", 0, sealed(), leader.term)).toMatchObject(refused("store_full"));
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
    const before = await list(leader.daemon, "task:");
    expect(before).toHaveLength(MAX_TASKS);
    for (const record of before) {
      // oxlint-disable-next-line no-await-in-loop -- sequential: 128 records at the largest size
      const reply = await put(leader.daemon, record.key, record.version, sealed(STORE_MAX_CT_LENGTH), leader.term);
      expect(reply).toMatchObject(written(record.version + 1));
    }
    const records = await list(leader.daemon, "task:", 20_000);
    expect(records).toHaveLength(MAX_TASKS);
    const keys = records.map((record) => record.key);
    expect(keys).toEqual(keys.toSorted());
    for (const record of records) expect(record.env.ct).toHaveLength(STORE_MAX_CT_LENGTH);
    await rigB.dismiss(observer, leader);
    observer.close();
  }, 90_000);

  test("MAX_RECORDS bounds the total across prefixes: queue: keys count with the tasks", async () => {
    const observer = await connectApp(rigB.relay());
    const leader = await rigB.lead(observer);
    let landed = 0;
    for (let i = 0; i < MAX_RECORDS; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential fill until the relay says full
      const reply = await put(leader.daemon, `queue:q-${String(i).padStart(3, "0")}`, 0, sealed(), leader.term);
      if (reply.t === "store-refused") {
        expect(reply.code).toBe("store_full");
        break;
      }
      landed += 1;
    }
    expect(landed).toBe(MAX_RECORDS - MAX_TASKS);
    await rigB.dismiss(observer, leader);
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
    const key = taskKey("e");
    expect(await put(leader.daemon, key, 0, sealed(), leader.term)).toMatchObject(written(1));
    expect(await del(leader.daemon, key, 1, leader.term)).toMatchObject(written(1));
    expect(await put(leader.daemon, key, 0, sealed(), leader.term)).toMatchObject(refused("version_conflict"));

    await until(
      async () => (await put(leader.daemon, key, 0, sealed(), leader.term)).t === "store-written",
      "the tombstone to expire",
    );
    expect(await get(leader.daemon, key)).toMatchObject({ key, version: 1 });
    await rigC.dismiss(observer, leader);
    observer.close();
  }, 30_000);

  test("later deletes purge expired tombstones, and the relay says how many", async () => {
    const observer = await connectApp(rigC.relay());
    const leader = await rigC.lead(observer);
    const stale = taskKey("p");
    expect(await put(leader.daemon, stale, 0, sealed(), leader.term)).toMatchObject(written(1));
    expect(await del(leader.daemon, stale, 1, leader.term)).toMatchObject(written(1));

    await until(async () => {
      // Each round's delete is what purges the ones that have aged out.
      const key = taskKey("p");
      await put(leader.daemon, key, 0, sealed(), leader.term);
      await del(leader.daemon, key, 1, leader.term);
      return rigC
        .relay()
        .logs()
        .some((line) => /store purged expired tombstones=\d+/u.test(line));
    }, "a purge line");
    // The purged key is free again.
    expect(await put(leader.daemon, stale, 0, sealed(), leader.term)).toMatchObject(written(1));
    await rigC.dismiss(observer, leader);
    observer.close();
  }, 30_000);
});
