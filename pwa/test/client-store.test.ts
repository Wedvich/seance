// Guards the app leg of the store in shared/src/app-client.ts. Lives under pwa/
// with the rest of the client's suites; a double stands in for the relay
// because the real one answers no store frame until scheduler M3 item 1.
import {
  accountStoreKey,
  APP_ID,
  AT_REST_OPS,
  importAccountKey,
  importPsk,
  isRecord,
  openAtRest,
  openTaskRecord,
  parseEnvelope,
  QUOTA_KEY,
  RelayClient,
  failureReasonText,
  RequestFailure,
  sealAccountRecord,
  sealFleetQuotaRecord,
  sealAtRest,
  SCHEDULER_ID,
  sealTaskRecord,
  SETTINGS_KEY,
  taskKey,
  TASK_REQUEST_LIMITS,
  TASK_SPEC_LIMITS,
  toBase64,
  type FleetQuotaEntry,
  type AtRestOp,
  type StoreRecord,
  type Task,
  type UnreadableRecord,
} from "@seance/shared";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { pollUntil } from "./poll.ts";

const TOKEN = "test-bearer-token";
let key: CryptoKey;
let otherKey: CryptoKey;
let accountKey: CryptoKey;

beforeAll(async () => {
  accountKey = await importAccountKey(toBase64(new Uint8Array(32).fill(7)));
  key = await importPsk(toBase64(new Uint8Array(32).fill(7)));
  otherKey = await importPsk(toBase64(new Uint8Array(32).fill(9)));
});

type Frame = Record<string, unknown>;

/**
 * A relay double for the store frames only: a map of records with the app
 * leg's create rule (`expect: 0` or `version_conflict`). `answer` overrides it
 * per test — a reply to send, or `"silent"` / `"close"`. Not a reference for
 * relay behaviour; DESIGN.md's wire protocol is.
 */
interface StoreDouble {
  readonly url: string;
  readonly records: Map<string, StoreRecord>;
  readonly received: Frame[];
  readonly sockets: Set<ServerWebSocket<unknown>>;
  answer: ((frame: Frame) => unknown) | null;
  readonly stop: () => Promise<void>;
}

const doubles: StoreDouble[] = [];
const clients: RelayClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  await Promise.all(doubles.splice(0).map((double) => double.stop()));
});

function memoryAnswer(records: Map<string, StoreRecord>, frame: Frame): unknown {
  const re = frame["id"];
  const at = typeof frame["key"] === "string" ? records.get(frame["key"]) : undefined;
  switch (frame["t"]) {
    case "store-list":
      return { t: "store-listed", re, records: [...records.values()].toSorted((a, b) => a.key.localeCompare(b.key)) };
    case "store-get":
      return { t: "store-record", re, record: at ?? null };
    case "store-put": {
      const env = parseEnvelope(frame["env"]);
      if (typeof frame["key"] !== "string" || env === null) return { t: "store-refused", re, code: "invalid_request" };
      if ((at?.version ?? 0) !== frame["expect"]) return { t: "store-refused", re, code: "version_conflict" };
      const version = (at?.version ?? 0) + 1;
      records.set(frame["key"], { key: frame["key"], version, env });
      return { t: "store-written", re, version };
    }
    default:
      return { t: "store-refused", re, code: "invalid_request" };
  }
}

function startDouble(): StoreDouble {
  const records = new Map<string, StoreRecord>();
  const received: Frame[] = [];
  const sockets = new Set<ServerWebSocket<unknown>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      return srv.upgrade(request) ? undefined : new Response("expected a websocket", { status: 400 });
    },
    websocket: {
      perMessageDeflate: false,
      open: (ws) => void sockets.add(ws),
      close: (ws) => void sockets.delete(ws),
      message(ws: ServerWebSocket<unknown>, message) {
        if (message === "ping") {
          ws.send("pong");
          return;
        }
        const frame: unknown = JSON.parse(String(message));
        if (!isRecord(frame)) return;
        received.push(frame);
        const reply = double.answer === null ? memoryAnswer(records, frame) : double.answer(frame);
        if (reply === "silent") return;
        if (reply === "close") {
          ws.close();
          return;
        }
        ws.send(JSON.stringify(reply));
      },
    },
  });
  // Read by the handler above only once a frame arrives, by which time it is set.
  const double: StoreDouble = {
    url: `ws://127.0.0.1:${server.port}/app`,
    records,
    received,
    sockets,
    answer: null,
    stop: () => server.stop(true),
  };
  doubles.push(double);
  return double;
}

async function connect(double: StoreDouble, storeTimeoutMs = 5_000, withAccountKey = false): Promise<RelayClient> {
  const client = new RelayClient({
    url: double.url,
    token: TOKEN,
    key,
    ...(withAccountKey ? { accountKey } : {}),
    storeTimeoutMs,
    createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
    log: () => {},
  });
  clients.push(client);
  client.start();
  await pollUntil(() => client.getState().status === "open", "the socket to open");
  return client;
}

function batchSpec(index: number): Task["spec"] {
  return {
    repo: "git@github.com:m/seance.git",
    mode: "worktree",
    batch: { id: crypto.randomUUID(), index, strategy: { mode: "sequential" } },
  };
}

function queued(overrides: Partial<Task> = {}): Task {
  return {
    id: crypto.randomUUID(),
    state: "queued",
    createdAt: Date.now(),
    spec: { repo: "git@github.com:m/seance.git", mode: "worktree", prompt: "fix the flake" },
    ...overrides,
  };
}

async function stored(task: Task, version: number, sealWith = key, at = taskKey(task.id)): Promise<StoreRecord> {
  return { key: at, version, env: await sealTaskRecord(sealWith, APP_ID, { version: 1, task }) };
}

describe("createTask", () => {
  test("puts a version-1 record at expect 0 that every reader opens, and a retry reads as queued", async () => {
    const double = startDouble();
    const client = await connect(double);
    const task = queued();

    expect(await client.createTask(task)).toEqual({ ok: true, landedEarlier: false });
    const [put] = double.received;
    expect(put).toMatchObject({ t: "store-put", key: taskKey(task.id), expect: 0 });
    expect(put).not.toHaveProperty("term");
    const record = double.records.get(taskKey(task.id));
    if (record === undefined) throw new Error("the put never landed");
    expect(await openTaskRecord(key, record, Date.now())).toEqual({ version: 1, task });

    // The reply was lost, say, so the same submission goes again: the relay answers version_conflict.
    expect(await client.createTask(task)).toEqual({ ok: true, landedEarlier: true });
    expect(await client.listTasks()).toEqual({ ok: true, tasks: [{ version: 1, task }], unreadable: [] });
  });

  test("refuses locally, sending nothing, a create past the cap or one no reader would keep", async () => {
    const double = startDouble();
    const client = await connect(double);
    // Within the prompt's character bound, but three UTF-8 bytes a character seals past 28 KiB.
    const wide = queued({
      spec: { repo: "git@github.com:m/seance.git", mode: "worktree", prompt: "語".repeat(TASK_REQUEST_LIMITS.prompt) },
    });
    expect(await client.createTask(wide)).toEqual({ ok: false, code: "too_large" });
    expect(await client.createTask(queued({ state: "ready" }))).toEqual({ ok: false, code: "invalid_request" });
    expect(await client.createTask(queued({ id: "has:colon" }))).toEqual({ ok: false, code: "invalid_request" });
    expect(double.received).toEqual([]);
  });

  test("refuses a batch index past the limit before any frame, and accepts one equal to it", async () => {
    const double = startDouble();
    const client = await connect(double);
    expect(await client.createTask(queued({ spec: batchSpec(TASK_SPEC_LIMITS.batchIndex + 1) }))).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(double.received).toEqual([]);
    expect(await client.createTask(queued({ spec: batchSpec(TASK_SPEC_LIMITS.batchIndex) }))).toEqual({
      ok: true,
      landedEarlier: false,
    });
  });

  test("seals the checked copy: a property the task type does not carry never reaches the record", async () => {
    const double = startDouble();
    const client = await connect(double);
    const task = queued();
    const withExtra = { ...task, smuggled: "x" };
    expect(await client.createTask(withExtra)).toEqual({ ok: true, landedEarlier: false });
    const env = parseEnvelope(double.received[0]?.["env"]);
    if (env === null) throw new Error("the put carried no envelope");
    // Opened raw: `openTaskRecord` would parse the extra property away and hide it.
    expect((await openAtRest(key, env, AT_REST_OPS.task)).payload).toEqual({ version: 1, task });
  });

  test("hands back any other refusal raw, a code this build has never seen included", async () => {
    const double = startDouble();
    const client = await connect(double);
    double.answer = (frame) => ({ t: "store-refused", re: frame["id"], code: "store_full" });
    expect(await client.createTask(queued())).toEqual({ ok: false, code: "store_full" });
    double.answer = (frame) => ({ t: "store-refused", re: frame["id"], code: "minted_later" });
    expect(await client.createTask(queued())).toEqual({ ok: false, code: "minted_later" });
  });
});

describe("reading tasks", () => {
  test("skips and reports, never fatally, every record that fails to open or bind", async () => {
    const double = startDouble();
    const client = await connect(double);
    const good = queued();
    const foreign = queued();
    const rolledBack = queued();
    const refiled = queued();
    const refiledAt = taskKey(crypto.randomUUID());
    for (const record of [
      await stored(good, 1),
      await stored(foreign, 1, otherKey),
      // Its authentic version-1 blob, put back after the leader had moved it to version 3.
      await stored(rolledBack, 3),
      // Its blob created again under a fresh key.
      await stored(refiled, 1, key, refiledAt),
    ]) {
      double.records.set(record.key, record);
    }

    const listing = await client.listTasks();
    if (listing === null || !listing.ok) throw new Error(`no listing: ${JSON.stringify(listing)}`);
    expect(listing.tasks).toEqual([{ version: 1, task: good }]);
    const expected: UnreadableRecord[] = [
      { key: taskKey(foreign.id), version: 1, reason: "unopenable" },
      { key: taskKey(rolledBack.id), version: 3, reason: "version_mismatch" },
      { key: refiledAt, version: 1, reason: "key_mismatch" },
    ];
    // The relay lists ascending by key, and the report keeps that order.
    expect(listing.unreadable).toEqual(expected.toSorted((a, b) => a.key.localeCompare(b.key)));
    // Reported, never cleared: the client asked for nothing but the list.
    expect(double.received.map((frame) => frame["t"])).toEqual(["store-list"]);
    expect(double.records.size).toBe(4);
  });

  test("gets one task, an unreadable one with its reason, or null for none", async () => {
    const double = startDouble();
    const client = await connect(double);
    const task = queued();
    const rolledBack = queued();
    for (const record of [await stored(task, 1), await stored(rolledBack, 2)]) double.records.set(record.key, record);

    expect(await client.getTask(task.id)).toEqual({ ok: true, task: { version: 1, task } });
    expect(await client.getTask(rolledBack.id)).toEqual({
      ok: true,
      task: { key: taskKey(rolledBack.id), version: 2, reason: "version_mismatch" },
    });
    expect(await client.getTask(crypto.randomUUID())).toEqual({ ok: true, task: null });
  });

  test("a listing with a key outside task: or one listed twice reports them, the rest still read", async () => {
    const double = startDouble();
    const client = await connect(double);
    const good = queued();
    const twice = queued();
    const outside = queued();
    const copy = await stored(twice, 1);
    const outsideAt = `settings:${outside.id}`;
    const records = [await stored(good, 1), copy, copy, await stored(outside, 1, key, outsideAt)];
    double.answer = (frame) => ({ t: "store-listed", re: frame["id"], records });

    const listing = await client.listTasks();
    if (listing === null || !listing.ok) throw new Error(`no listing: ${JSON.stringify(listing)}`);
    expect(listing.tasks).toEqual([{ version: 1, task: good }]);
    expect(listing.unreadable).toEqual([
      { key: taskKey(twice.id), version: 1, reason: "key_mismatch" },
      { key: taskKey(twice.id), version: 1, reason: "key_mismatch" },
      { key: outsideAt, version: 1, reason: "key_mismatch" },
    ]);
  });

  test("a refused list or get comes back as the refusal", async () => {
    const double = startDouble();
    const client = await connect(double);
    double.answer = (frame) => ({ t: "store-refused", re: frame["id"], code: "rate_limited" });
    expect(await client.listTasks()).toEqual({ ok: false, code: "rate_limited" });
    expect(await client.getTask(crypto.randomUUID())).toEqual({ ok: false, code: "rate_limited" });
  });

  test("a get answered with another key's record is no answer, however well it binds", async () => {
    const double = startDouble();
    const client = await connect(double);
    const other = await stored(queued(), 1);
    double.answer = (frame) => ({ t: "store-record", re: frame["id"], record: other });
    expect(await client.getTask(crypto.randomUUID())).toBeNull();
  });
});

const ACCOUNT_ID = "org-uuid:account-uuid";

async function storedAccount(
  accountId: string,
  alias: string | null,
  version: number,
  at?: string,
): Promise<StoreRecord> {
  return {
    key: at ?? (await accountStoreKey(accountKey, accountId)),
    version,
    env: await sealAccountRecord(key, APP_ID, { version, accountId, alias }),
  };
}

describe("account records", () => {
  test("a rename is a compare-and-set: create at 0, overwrite at the held version, a stale expect conflicts", async () => {
    const double = startDouble();
    const client = await connect(double, 5_000, true);
    const at = await client.accountStoreKey(ACCOUNT_ID);

    const created = await client.putAccountAlias(ACCOUNT_ID, "work", 0);
    expect(created).toEqual({ ok: true, key: at, record: { version: 1, accountId: ACCOUNT_ID, alias: "work" } });
    expect(await client.getAccountRecord(at)).toEqual({
      ok: true,
      key: at,
      version: 1,
      entry: { version: 1, accountId: ACCOUNT_ID, alias: "work" },
    });

    const renamed = await client.putAccountAlias(ACCOUNT_ID, "  home ", 1);
    expect(renamed).toEqual({ ok: true, key: at, record: { version: 2, accountId: ACCOUNT_ID, alias: "home" } });
    expect(double.records.get(at)?.version).toBe(2);

    // Never mapped to success, unlike a task create: the other client's name would be lost.
    expect(await client.putAccountAlias(ACCOUNT_ID, "stale", 1)).toEqual({ ok: false, code: "version_conflict" });
    expect(await client.putAccountAlias(ACCOUNT_ID, "stale", 0)).toEqual({ ok: false, code: "version_conflict" });
    const cleared = await client.putAccountAlias(ACCOUNT_ID, "", 2);
    expect(cleared).toEqual({ ok: true, key: at, record: { version: 3, accountId: ACCOUNT_ID, alias: null } });
  });

  test("a put answered with a version other than expect + 1 is no answer", async () => {
    const double = startDouble();
    const client = await connect(double, 5_000, true);
    double.answer = (frame) => ({ t: "store-written", re: frame["id"], version: 5 });
    expect(await client.putAccountAlias(ACCOUNT_ID, "work", 0)).toBeNull();
  });

  test("refuses locally, sending nothing, an alias past the bound", async () => {
    const double = startDouble();
    const client = await connect(double, 5_000, true);
    expect(await client.putAccountAlias(ACCOUNT_ID, "x".repeat(65), 0)).toEqual({ ok: false, code: "invalid_request" });
    expect(double.received).toEqual([]);
  });

  test("a get for a key outside account: sends nothing; an absent key reads as version 0", async () => {
    const double = startDouble();
    const client = await connect(double, 5_000, true);
    expect(await client.getAccountRecord(taskKey(crypto.randomUUID()))).toBeNull();
    expect(await client.getAccountRecord("account:not a key")).toBeNull();
    expect(double.received).toEqual([]);
    const absent = await client.accountStoreKey(ACCOUNT_ID);
    expect(await client.getAccountRecord(absent)).toEqual({ ok: true, key: absent, version: 0, entry: null });
  });

  test("a get answered with another key's record is no answer", async () => {
    const double = startDouble();
    const client = await connect(double, 5_000, true);
    const other = await storedAccount("org-uuid:other", "home", 1);
    double.answer = (frame) => ({ t: "store-record", re: frame["id"], record: other });
    expect(await client.getAccountRecord(await client.accountStoreKey(ACCOUNT_ID))).toBeNull();
  });

  test("an unreadable record comes back with its reason and the relay's version, for a rename to overwrite", async () => {
    const double = startDouble();
    const client = await connect(double, 5_000, true);
    const at = await client.accountStoreKey(ACCOUNT_ID);
    // An authentic version-1 blob put back by overwrite: the relay now holds it at 2.
    double.records.set(at, { ...(await storedAccount(ACCOUNT_ID, "old", 1)), version: 2 });
    expect(await client.getAccountRecord(at)).toEqual({
      ok: true,
      key: at,
      version: 2,
      entry: { key: at, version: 2, reason: "version_mismatch" },
    });
    expect(await client.putAccountAlias(ACCOUNT_ID, "new", 2)).toEqual({
      ok: true,
      key: at,
      record: { version: 3, accountId: ACCOUNT_ID, alias: "new" },
    });
  });

  test("a listing reports a record under the wrong key as unreadable, the rest still read", async () => {
    const double = startDouble();
    const client = await connect(double, 5_000, true);
    const good = await storedAccount(ACCOUNT_ID, "work", 1);
    const planted = await storedAccount(ACCOUNT_ID, "forged", 1, `account:${"0".repeat(64)}`);
    for (const record of [good, planted]) double.records.set(record.key, record);
    const listing = await client.listAccounts();
    expect(listing).toEqual({
      ok: true,
      accounts: [{ key: good.key, record: { version: 1, accountId: ACCOUNT_ID, alias: "work" } }],
      unreadable: [{ key: planted.key, version: 1, reason: "key_mismatch" }],
    });
  });

  test("hands back a refusal raw, and a client without an account key is unsupported before anything is sent", async () => {
    const double = startDouble();
    const bare = await connect(double);
    expect(bare.accountsNamed).toBe(false);
    expect(await failure(bare.listAccounts())).toBe("unsupported");
    expect(await failure(bare.getAccountRecord("account:" + "a".repeat(64)))).toBe("unsupported");
    expect(await failure(bare.putAccountAlias(ACCOUNT_ID, "work", 0))).toBe("unsupported");
    expect(await failure(bare.accountStoreKey(ACCOUNT_ID))).toBe("unsupported");
    expect(double.received).toEqual([]);

    const client = await connect(double, 5_000, true);
    expect(client.accountsNamed).toBe(true);
    double.answer = (frame) => ({ t: "store-refused", re: frame["id"], code: "store_full" });
    expect(await client.putAccountAlias(ACCOUNT_ID, "work", 0)).toEqual({ ok: false, code: "store_full" });
    expect(await client.listAccounts()).toEqual({ ok: false, code: "store_full" });
  });
});

/** The `RequestFailure` reason a store call rejected with; null if it resolved. */
function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => (err instanceof RequestFailure ? err.reason : err),
  );
}

describe("store transport", () => {
  test("a reply this build cannot read settles at once instead of riding the timeout", async () => {
    const double = startDouble();
    // A timeout this long outlives the test's own, so only a fast settle passes.
    const client = await connect(double, 60_000);
    // A page: `next` means more follows, which this build cannot continue.
    double.answer = (frame) => ({ t: "store-listed", re: frame["id"], records: [], next: "task:z" });
    expect(await client.listTasks()).toBeNull();
    double.answer = (frame) => ({ t: "store-written", re: frame["id"], version: 1 });
    expect(await client.listTasks()).toBeNull();
  });

  test("fails as disconnected with no socket, dropped when it closes, and timeout on silence", async () => {
    const double = startDouble();
    const idle = new RelayClient({ url: double.url, token: TOKEN, key });
    expect(await failure(idle.listTasks())).toBe("disconnected");

    const client = await connect(double, 50);
    double.answer = () => "silent";
    expect(await failure(client.getTask(crypto.randomUUID()))).toBe("timeout");
    const timedOut = await client.getTask(crypto.randomUUID()).catch((err: unknown) => err);
    if (!(timedOut instanceof RequestFailure)) throw new Error("expected a RequestFailure");
    expect(failureReasonText(timedOut)).toContain("the relay did not answer");
    double.answer = () => "close";
    expect(await failure(client.createTask(queued()))).toBe("dropped");
  });

  test("a reconnect fails the store request sent on the replaced socket at once", async () => {
    const double = startDouble();
    const client = await connect(double, 60_000);
    double.answer = () => "silent";
    const outcome = failure(client.getTask(crypto.randomUUID()));
    await pollUntil(() => double.received.length === 1, "the request to arrive");
    const started = Date.now();
    client.reconnect();
    expect(await outcome).toBe("dropped");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a reply after the timeout settles nothing and throws nothing", async () => {
    const double = startDouble();
    const client = await connect(double, 50);
    double.answer = () => "silent";
    expect(await failure(client.getTask(crypto.randomUUID()))).toBe("timeout");
    const [late] = double.received;
    for (const ws of double.sockets) ws.send(JSON.stringify({ t: "store-record", re: late?.["id"], record: null }));
    // The socket orders frames, so once this answers, the late reply has been handled.
    double.answer = null;
    expect(await client.getTask(crypto.randomUUID())).toEqual({ ok: true, task: null });
  });
});

describe("fleet quota record", () => {
  const ENTRY: FleetQuotaEntry = {
    accountId: "acct-1",
    observer: "dev-a",
    reading: { h: 40, s: "cache", at: 1_800_000_000 },
  };

  async function quotaRecord(version: number, sealWith = key): Promise<StoreRecord> {
    return {
      key: QUOTA_KEY,
      version,
      env: await sealFleetQuotaRecord(sealWith, "dev-a", { version, accounts: [ENTRY] }),
    };
  }

  function polling(double: StoreDouble, storeTimeoutMs = 5_000): RelayClient {
    const client = new RelayClient({
      url: double.url,
      token: TOKEN,
      key,
      storeTimeoutMs,
      fleetQuotaRefreshMs: 60_000,
      createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
      log: () => {},
    });
    clients.push(client);
    client.start();
    return client;
  }

  test("a client built without a refresh never reads it", async () => {
    const double = startDouble();
    const client = await connect(double);
    expect(await client.getTask(crypto.randomUUID())).toEqual({ ok: true, task: null });
    expect(double.received.some((frame) => frame["key"] === QUOTA_KEY)).toBe(false);
    expect(client.getState().fleetQuota).toEqual([]);
  });

  test("reads on open; a refusal keeps the last copy, an unreadable record empties it", async () => {
    const double = startDouble();
    double.records.set(QUOTA_KEY, await quotaRecord(3));
    const client = polling(double);
    await pollUntil(() => client.getState().fleetQuota.length === 1, "the read on open");
    expect(client.getState().fleetQuota).toEqual([ENTRY]);

    const held = client.getState().fleetQuota;
    await client.refreshFleetQuota();
    expect(client.getState().fleetQuota).toBe(held);

    double.answer = (frame) => ({ t: "store-refused", re: frame["id"], code: "rate_limited" });
    await client.refreshFleetQuota();
    expect(client.getState().fleetQuota).toEqual([ENTRY]);

    double.answer = null;
    double.records.set(QUOTA_KEY, await quotaRecord(4, otherKey));
    await client.refreshFleetQuota();
    expect(client.getState().fleetQuota).toEqual([]);
  });

  test("an older answer finishing after a newer one never replaces it", async () => {
    const double = startDouble();
    double.records.set(QUOTA_KEY, await quotaRecord(5));
    const client = polling(double);
    await pollUntil(() => client.getState().fleetQuota.length === 1, "the read on open");
    const stale = await quotaRecord(3);
    const older = {
      ...stale,
      env: await sealFleetQuotaRecord(key, "dev-b", {
        version: 3,
        accounts: [{ ...ENTRY, accountId: "acct-old" }],
      }),
    };
    double.answer = (frame) => ({ t: "store-record", re: frame["id"], record: older });
    await client.refreshFleetQuota();
    expect(client.getState().fleetQuota).toEqual([ENTRY]);
  });

  test("a relay store reset lowers the version floor, so the next socket's answers are read", async () => {
    const double = startDouble();
    double.records.set(QUOTA_KEY, await quotaRecord(5));
    const client = polling(double);
    await pollUntil(() => client.getState().fleetQuota.length === 1, "the read on open");
    const fresh = await quotaRecord(1);
    double.records.set(QUOTA_KEY, {
      ...fresh,
      env: await sealFleetQuotaRecord(key, "dev-b", {
        version: 1,
        accounts: [{ ...ENTRY, accountId: "acct-new" }],
      }),
    });
    client.reconnect();
    await pollUntil(() => client.getState().fleetQuota[0]?.accountId === "acct-new", "the read after the reset");
  });

  test("a quota read leaves no wire line, a failing one does", async () => {
    const double = startDouble();
    double.records.set(QUOTA_KEY, await quotaRecord(3));
    const lines: string[] = [];
    const client = new RelayClient({
      url: double.url,
      token: TOKEN,
      key,
      storeTimeoutMs: 50,
      fleetQuotaRefreshMs: 60_000,
      createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
      log: (line) => void lines.push(line),
    });
    clients.push(client);
    client.start();
    await pollUntil(() => client.getState().fleetQuota.length === 1, "the read on open");
    expect(lines).toEqual([]);
    double.answer = () => "silent";
    await client.refreshFleetQuota();
    expect(lines.filter((line) => line.includes("timeout"))).toHaveLength(1);
  });

  test("a read with no answer resolves at the store timeout and keeps the last copy", async () => {
    const double = startDouble();
    double.records.set(QUOTA_KEY, await quotaRecord(3));
    const client = polling(double, 50);
    await pollUntil(() => client.getState().fleetQuota.length === 1, "the read on open");
    double.answer = () => "silent";
    await client.refreshFleetQuota();
    expect(client.getState().fleetQuota).toEqual([ENTRY]);
  });
});

describe("pushSettings", () => {
  const publicKey = Buffer.alloc(65, 4).toString("base64url");
  const privateKey = Buffer.alloc(32, 9).toString("base64url");
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    keys: { p256dh: Buffer.alloc(65, 1).toString("base64url"), auth: Buffer.alloc(16, 2).toString("base64url") },
  };
  const body = {
    version: 3,
    vapid: { publicKey, privateKey },
    linearKey: "lin_api_secret",
    subscriptions: [subscription],
  };

  async function settingsRecord(
    overrides: { at?: string; to?: string; sealWith?: CryptoKey; op?: AtRestOp; payload?: unknown } = {},
  ): Promise<StoreRecord> {
    const env = await sealAtRest(
      overrides.sealWith ?? key,
      { to: overrides.to ?? SCHEDULER_ID, from: SCHEDULER_ID },
      overrides.op ?? AT_REST_OPS.settings,
      overrides.payload ?? body,
    );
    return { key: overrides.at ?? SETTINGS_KEY, version: 3, env };
  }

  async function ask(record: StoreRecord | null, endpoint?: string): Promise<unknown> {
    const double = startDouble();
    const client = await connect(double);
    if (record !== null) double.records.set(SETTINGS_KEY, record);
    // The key it was asked under is the one it is read for: a double that answers another key's record is no answer.
    double.answer = (frame) => ({ t: "store-record", re: frame["id"], record });
    return client.pushSettings(endpoint);
  }

  test("returns the public key and whether the endpoint is held, and nothing else of the record", async () => {
    const held = await ask(await settingsRecord(), subscription.endpoint);
    expect(held).toEqual({ publicKey, subscribed: true });
    expect(await ask(await settingsRecord(), "https://fcm.googleapis.com/fcm/send/other")).toEqual({
      publicKey,
      subscribed: false,
    });
    expect(await ask(await settingsRecord())).toEqual({ publicKey, subscribed: false });
    const text = JSON.stringify(held);
    expect(text).not.toContain(privateKey);
    expect(text).not.toContain("lin_api_secret");
  });

  test("is null for no record, a record that is not the settings one, or one it cannot trust", async () => {
    const noVapid = { version: 3, subscriptions: [subscription] };
    for (const record of [
      null,
      await settingsRecord({ at: "settings:other" }),
      await settingsRecord({ to: APP_ID }),
      await settingsRecord({ sealWith: otherKey }),
      await settingsRecord({ op: AT_REST_OPS.pauseState }),
      await settingsRecord({ payload: { ...body, version: 2 } }),
      await settingsRecord({ payload: noVapid }),
      await settingsRecord({ payload: { version: 3, vapid: { publicKey: "short", privateKey } } }),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one double per case
      expect(await ask(record)).toBeNull();
    }
  });

  test("is null for a refusal, and fails as a store request does when nothing answers", async () => {
    const double = startDouble();
    const client = await connect(double, 100);
    double.answer = (frame) => ({ t: "store-refused", re: frame["id"], code: "rate_limited" });
    expect(await client.pushSettings()).toBeNull();
    double.answer = () => "silent";
    expect(await failure(client.pushSettings())).toBe("timeout");
  });
});
