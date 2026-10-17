import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  APP_ID,
  AT_REST_OPS,
  generateIdentitySeed,
  identityFromSeed,
  importPsk,
  MAX_PAUSE_HOLDS,
  openAtRest,
  REPLAY_WINDOW_MS,
  RequestFailure,
  sealAtRest,
  sealTaskRecord,
  SCHEDULER_ID,
  seal,
  STORE_MAX_CT_LENGTH,
  toBase64,
  type AtRestOp,
  type Envelope,
  type PauseHold,
  type StoreRequestFrame,
  type TaskRecord,
} from "@seance/shared";
import { StoreRevoked, type QueueStore, type Task } from "../src/leader.ts";
import { createQueueStore } from "../src/queue-store.ts";
import { log } from "../src/log.ts";
import { RelayClient } from "../src/relay-client.ts";
import { pollUntil } from "./fixtures.ts";
import { startTestRelay, type TestRelay } from "./harness.ts";

const PSK = toBase64(new Uint8Array(32).fill(5));
const TOKEN = "queue-store-test";
let key: CryptoKey;

beforeAll(async () => {
  key = await importPsk(PSK);
});

function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    spec: { repo: "github.com/acme/app", mode: "worktree", prompt: "do it" },
    state: "queued",
    createdAt: Date.now(),
    ...fields,
  };
}

interface Rig {
  readonly relay: TestRelay;
  readonly client: RelayClient;
  readonly store: QueueStore;
  readonly deviceId: string;
}

interface RigOpts {
  /** The term the adapter writes under; the relay's is 2. */
  readonly term?: number;
  readonly storeTimeoutMs?: number;
  /** Defaults to `storeTimeoutMs`: production's longer list deadline would make a held list wait it out. */
  readonly storeListTimeoutMs?: number;
  readonly onStoreChanged?: (key: string, version: number) => void;
}

/** A real daemon `RelayClient` leading under term 2 on the test relay, and an adapter over it. */
async function withRig(body: (rig: Rig) => Promise<void>, opts: RigOpts = {}): Promise<void> {
  const relay = startTestRelay(TOKEN);
  const identity = await identityFromSeed(generateIdentitySeed());
  const client = new RelayClient({
    url: relay.url,
    bearerToken: TOKEN,
    identity,
    key,
    buildInfo: () =>
      seal(
        key,
        { to: APP_ID, from: identity.deviceId },
        { id: crypto.randomUUID(), ts: Date.now(), op: "machine-info", payload: {} },
      ),
    handle: () => Promise.resolve(null),
    storeTimeoutMs: opts.storeTimeoutMs ?? 300,
    storeListTimeoutMs: opts.storeListTimeoutMs ?? opts.storeTimeoutMs ?? 300,
    ...(opts.onStoreChanged === undefined ? {} : { onStoreChanged: opts.onStoreChanged }),
  });
  client.start();
  try {
    await relay.registers.next();
    relay.lead(identity.deviceId, 2);
    const store = createQueueStore({ leg: client, key, term: opts.term ?? 2, now: Date.now });
    await body({ relay, client, store, deviceId: identity.deviceId });
  } finally {
    client.stop();
    relay.stop();
  }
}

async function drain(relay: TestRelay): Promise<StoreRequestFrame[]> {
  const frames: StoreRequestFrame[] = [];
  while (relay.storeFrames.size > 0) frames.push(await relay.storeFrames.next());
  return frames;
}

const taskEnv = (record: TaskRecord, from = SCHEDULER_ID, k = key): Promise<Envelope> =>
  sealTaskRecord(k, from, record);

describe("round trip", () => {
  test("a create carries the term and a sealed task; get, list, overwrite and delete follow the versions", async () => {
    await withRig(async ({ relay, store }) => {
      const body = task("a");
      expect(await store.put("a", 0, body)).toEqual({ ok: true, version: 1 });
      expect(await store.get("a")).toEqual({ id: "a", version: 1, body });
      expect(await store.list()).toEqual([{ id: "a", version: 1, body }]);
      expect(await store.put("a", 1, { ...body, state: "ready" })).toEqual({ ok: true, version: 2 });
      expect(await store.delete("a", 2)).toEqual({ ok: true, version: 2 });
      expect(await store.get("a")).toBeNull();
      // The tombstone: the key cannot be created again.
      expect(await store.put("a", 0, body)).toEqual({ ok: false, code: "version_conflict" });

      const frames = await drain(relay);
      const first = frames.find((f) => f.t === "store-put");
      expect(first).toMatchObject({ t: "store-put", key: "task:a", expect: 0, term: 2 });
      for (const frame of frames) {
        if (frame.t === "store-get" || frame.t === "store-list") expect("term" in frame).toBe(false);
        else expect(frame.term).toBe(2);
      }
      if (first?.t !== "store-put") throw new Error("no create sent");
      const opened = await openAtRest(key, first.env, AT_REST_OPS.task);
      expect(opened.op).toBe("task");
      expect(first.env.to).toBe(SCHEDULER_ID);
      expect(first.env.from).toBe(SCHEDULER_ID);
      expect(opened.payload).toEqual({ version: 1, task: body });
    });
  });
});

describe("reader rules", () => {
  test("every record a reader would refuse comes back with its reason, and list still resolves", async () => {
    await withRig(async ({ relay, store }) => {
      const good = task("good");
      expect(await store.put("good", 0, good)).toMatchObject({ ok: true });
      const other = await importPsk(toBase64(new Uint8Array(32).fill(9)));
      const queued = (id: string): TaskRecord => ({ version: 1, task: task(id) });

      relay.plantRecord("task:other-psk", 1, await taskEnv(queued("other-psk"), SCHEDULER_ID, other));
      relay.plantRecord(
        "task:wrong-op",
        1,
        await sealAtRest(key, { to: SCHEDULER_ID, from: SCHEDULER_ID }, AT_REST_OPS.status, queued("wrong-op")),
      );
      relay.plantRecord(
        "task:to-app",
        1,
        await sealAtRest(key, { to: APP_ID, from: SCHEDULER_ID }, AT_REST_OPS.task, queued("to-app")),
      );
      relay.plantRecord(
        "task:malformed",
        1,
        await sealAtRest(key, { to: SCHEDULER_ID, from: SCHEDULER_ID }, AT_REST_OPS.task, { nonsense: true }),
      );
      relay.plantRecord("task:replayed", 2, await taskEnv(queued("replayed")));
      relay.plantRecord("task:wrong-key", 1, await taskEnv(queued("someone-else")));
      relay.plantRecord("task:unqueued", 1, await taskEnv({ version: 1, task: task("unqueued", { state: "ready" }) }));
      relay.plantRecord(
        "task:ahead",
        1,
        await taskEnv({ version: 1, task: task("ahead", { createdAt: Date.now() + 2 * REPLAY_WINDOW_MS }) }),
      );

      const listed = await store.list();
      const reasons = Object.fromEntries(listed.map((e) => [e.id, e.reason ?? "readable"]));
      expect(reasons).toEqual({
        good: "readable",
        "other-psk": "unopenable",
        "wrong-op": "unopenable",
        "to-app": "unopenable",
        malformed: "malformed",
        replayed: "version_mismatch",
        "wrong-key": "key_mismatch",
        unqueued: "created_unqueued",
        ahead: "created_ahead",
      });
      expect(listed.find((e) => e.id === "replayed")).toMatchObject({ version: 2 });
      // `get` reads the same rules.
      expect(await store.get("replayed")).toEqual({ id: "replayed", version: 2, reason: "version_mismatch" });
    });
  });

  test("a listing with a key twice, or a key outside task:, reports each as key_mismatch", async () => {
    await withRig(async ({ relay, store }) => {
      const env = await taskEnv({ version: 1, task: task("dup") });
      relay.replyNextStore((frame) => ({
        t: "store-listed",
        re: frame.id,
        records: [
          { key: "task:dup", version: 1, env },
          { key: "task:dup", version: 1, env },
          { key: "queue:x", version: 1, env },
        ],
      }));
      const listed = await store.list();
      expect(listed.map((e) => [e.id, e.reason])).toEqual([
        ["dup", "key_mismatch"],
        ["dup", "key_mismatch"],
        ["queue:x", "key_mismatch"],
      ]);
    });
  });
});

describe("write mapping", () => {
  test("a term the relay does not hold revokes the store", async () => {
    await withRig(
      async ({ store }) => {
        await expect(store.put("a", 0, task("a"))).rejects.toBeInstanceOf(StoreRevoked);
        await expect(store.delete("a", 1)).rejects.toBeInstanceOf(StoreRevoked);
        await expect(store.putPause(0, [])).rejects.toBeInstanceOf(StoreRevoked);
      },
      { term: 1 },
    );
  });

  test("a stale expect is version_conflict", async () => {
    await withRig(async ({ store }) => {
      expect(await store.put("a", 5, task("a"))).toEqual({ ok: false, code: "version_conflict" });
      expect(await store.delete("missing", 1)).toEqual({ ok: false, code: "version_conflict" });
    });
  });

  test.each([
    ["forbidden", "refused"],
    ["invalid_request", "refused"],
    ["brand_new_code", "refused"],
    ["too_large", "too_large"],
    ["rate_limited", "rate_limited"],
    ["store_full", "store_full"],
    ["version_conflict", "version_conflict"],
  ])("the relay's %s is the port's %s", async (code, expected) => {
    await withRig(async ({ relay, store }) => {
      relay.replyNextStore((frame) => ({ t: "store-refused", re: frame.id, code }));
      const write = await store.put("a", 0, task("a"));
      expect(write.ok ? "ok" : write.code).toBe(expected);
    });
  });

  test("not_leader from the relay throws, whatever the key", async () => {
    await withRig(async ({ relay, store }) => {
      relay.replyNextStore((frame) => ({ t: "store-refused", re: frame.id, code: "not_leader" }));
      await expect(store.put("a", 0, task("a"))).rejects.toThrow("store-put as not_leader");
    });
  });

  test("no answer in time, a wrong version, an unreadable reply and a reply of the wrong kind are all indeterminate", async () => {
    await withRig(async ({ relay, store }) => {
      relay.holdStoreReplies = true;
      expect(await store.put("a", 0, task("a"))).toEqual({ ok: false, code: "indeterminate" });
      relay.holdStoreReplies = false;

      relay.replyNextStore((frame) => ({ t: "store-written", re: frame.id, version: 99 }));
      expect(await store.put("b", 0, task("b"))).toEqual({ ok: false, code: "indeterminate" });
      relay.replyNextStore((frame) => ({ t: "store-written", re: frame.id, version: "one" }));
      expect(await store.put("c", 0, task("c"))).toEqual({ ok: false, code: "indeterminate" });
      relay.replyNextStore((frame) => ({ t: "store-record", re: frame.id, record: null }));
      expect(await store.put("d", 0, task("d"))).toEqual({ ok: false, code: "indeterminate" });
      // A delete is written at the version it removed, not one past it.
      relay.replyNextStore((frame) => ({ t: "store-written", re: frame.id, version: 4 }));
      expect(await store.delete("e", 3)).toEqual({ ok: false, code: "indeterminate" });
    });
  });

  test("a socket that closes after the send is indeterminate, not a timeout", async () => {
    await withRig(
      async ({ relay, store, deviceId }) => {
        relay.holdStoreReplies = true;
        const pending = store.put("a", 0, task("a"));
        await pollUntil(() => relay.storeFrames.size === 1, "the put to reach the relay");
        const started = Date.now();
        relay.dropDaemon(deviceId);
        expect(await pending).toEqual({ ok: false, code: "indeterminate" });
        expect(Date.now() - started).toBeLessThan(5_000);
      },
      { storeTimeoutMs: 30_000 },
    );
  });

  test("a send that throws leaves nothing pending, reads as no socket and redials so the relay hears the daemon again", async () => {
    await withRig(async ({ relay, client, store }) => {
      const real = WebSocket.prototype.send;
      const refuse = spyOn(WebSocket.prototype, "send").mockImplementation(function (
        this: WebSocket,
        data: Parameters<typeof real>[0],
      ) {
        if (typeof data === "string" && data.includes('"t":"store-')) throw new Error("socket is closing");
        return real.call(this, data);
      });
      const warn = spyOn(log, "warn");
      try {
        const frame = { t: "store-get", id: crypto.randomUUID(), key: "task:a" } as const;
        const failure = await client.store(frame).catch((err: unknown) => err);
        expect(failure).toBeInstanceOf(RequestFailure);
        expect(failure).toMatchObject({ reason: "disconnected" });
        await expect(store.put("a", 0, task("a"))).rejects.toBeInstanceOf(StoreRevoked);
        // The socket was left open by the failed send; without a close nothing would register again.
        await relay.registers.next();
        // A non-event cannot be polled for: wait past the 300ms deadline a leaked timer would fire at.
        await Bun.sleep(400);
        expect(warn.mock.calls.filter(([line]) => String(line).includes("store timeout"))).toEqual([]);
      } finally {
        refuse.mockRestore();
        warn.mockRestore();
      }
    });
  });

  test("a list waits out its own, longer deadline while a single read gives up at the short one", async () => {
    await withRig(
      async ({ relay, store }) => {
        relay.holdStoreReplies = true;
        await expect(store.get("a")).rejects.toThrow("timed out after 200ms");
        const list = Date.now();
        await expect(store.list()).rejects.toThrow("timed out after 1000ms");
        // A timer cannot fire early, so a lower bound is not a race.
        expect(Date.now() - list).toBeGreaterThanOrEqual(950);
      },
      { storeTimeoutMs: 200, storeListTimeoutMs: 1_000 },
    );
  });

  test("with no socket to send on, the term is over", async () => {
    await withRig(async ({ relay, client, store }) => {
      client.stop();
      await expect(store.put("a", 0, task("a"))).rejects.toBeInstanceOf(StoreRevoked);
      await expect(store.delete("a", 1)).rejects.toBeInstanceOf(StoreRevoked);
      expect(relay.storeFrames.size).toBe(0);
    });
  });

  test("a body no reader would keep is refused without a frame", async () => {
    await withRig(async ({ relay, store }) => {
      expect(await store.put("a", 0, task("a", { state: "ready" }))).toEqual({ ok: false, code: "refused" });
      expect(relay.storeFrames.size).toBe(0);
    });
  });

  test("a create past the create cap is too_large without a frame; an overwrite has the larger cap", async () => {
    await withRig(async ({ relay, store }) => {
      // Three-byte text: the longest prompt a task may hold seals past 28 KiB.
      const heavy = task("a", { spec: { repo: "github.com/acme/app", mode: "worktree", prompt: "漢".repeat(8_192) } });
      expect(await store.put("a", 0, heavy)).toEqual({ ok: false, code: "too_large" });
      expect(relay.storeFrames.size).toBe(0);
      expect(await store.put("a", 1, heavy)).toEqual({ ok: false, code: "version_conflict" });
      expect(relay.storeFrames.size).toBe(1);
    });
  });
});

describe("read mapping", () => {
  test("a page, a timeout and a record of another key reject rather than read as a short queue", async () => {
    await withRig(async ({ relay, store }) => {
      relay.replyNextStore((frame) => ({ t: "store-listed", re: frame.id, records: [], next: "task:z" }));
      await expect(store.list()).rejects.toThrow();

      relay.holdStoreReplies = true;
      await expect(store.list()).rejects.toThrow("timed out");
      await expect(store.get("a")).rejects.toThrow("timed out");
      await expect(store.getPause()).rejects.toThrow("timed out");
      relay.holdStoreReplies = false;

      const env = await taskEnv({ version: 1, task: task("other") });
      relay.replyNextStore((frame) => ({
        t: "store-record",
        re: frame.id,
        record: { key: "task:other", version: 1, env },
      }));
      await expect(store.get("a")).rejects.toThrow("another key");

      relay.replyNextStore((frame) => ({ t: "store-refused", re: frame.id, code: "invalid_request" }));
      await expect(store.list()).rejects.toThrow("invalid_request");
    });
  });
});

describe("pause", () => {
  const hold: PauseHold = { until: "resume", at: 1 };
  const pauseEnv = (payload: unknown, op: AtRestOp = AT_REST_OPS.pauseState): Promise<Envelope> =>
    sealAtRest(key, { to: SCHEDULER_ID, from: SCHEDULER_ID }, op, payload);

  test("none at first; a put reads back; a second create is a conflict", async () => {
    await withRig(async ({ relay, store }) => {
      expect(await store.getPause()).toBeNull();
      expect(await store.putPause(0, [hold])).toEqual({ ok: true, version: 1 });
      expect(await store.getPause()).toEqual({ version: 1, holds: [hold] });
      expect(await store.putPause(0, [])).toEqual({ ok: false, code: "version_conflict" });
      expect(await store.putPause(1, [])).toEqual({ ok: true, version: 2 });
      expect(await store.getPause()).toEqual({ version: 2, holds: [] });
      const puts = (await drain(relay)).filter((f) => f.t === "store-put");
      expect(puts.map((f) => f.key)).toEqual(["queue:pause", "queue:pause", "queue:pause"]);
      expect(puts.every((f) => f.term === 2)).toBe(true);
    });
  });

  test("a record that is not this slot's reads with its reason", async () => {
    await withRig(async ({ relay, store }) => {
      relay.plantRecord("queue:pause", 1, await pauseEnv({ version: 1, holds: [] }, AT_REST_OPS.task));
      expect(await store.getPause()).toEqual({ version: 1, reason: "unopenable" });
      relay.plantRecord(
        "queue:pause",
        1,
        await sealAtRest(key, { to: APP_ID, from: SCHEDULER_ID }, AT_REST_OPS.pauseState, { version: 1, holds: [] }),
      );
      expect(await store.getPause()).toEqual({ version: 1, reason: "unopenable" });
      relay.plantRecord("queue:pause", 1, await pauseEnv({ nonsense: true }));
      expect(await store.getPause()).toEqual({ version: 1, reason: "malformed" });
      // An authentic old blob put back names the version it was sealed at.
      relay.plantRecord("queue:pause", 2, await pauseEnv({ version: 1, holds: [hold] }));
      expect(await store.getPause()).toEqual({ version: 2, reason: "version_mismatch" });

      const env = await pauseEnv({ version: 1, holds: [] });
      relay.replyNextStore((frame) => ({
        t: "store-record",
        re: frame.id,
        record: { key: "queue:other", version: 1, env },
      }));
      expect(await store.getPause()).toEqual({ version: 1, reason: "key_mismatch" });
    });
  });

  test("more holds than a reader accepts is refused without a frame", async () => {
    await withRig(async ({ relay, store }) => {
      const holds = Array.from({ length: MAX_PAUSE_HOLDS + 1 }, () => hold);
      expect(await store.putPause(0, holds)).toEqual({ ok: false, code: "refused" });
      expect(relay.storeFrames.size).toBe(0);
    });
  });
});

describe("size", () => {
  test("a full prefix of full-size records arrives whole, as one frame", async () => {
    await withRig(
      async ({ relay, store }) => {
        const env: Envelope = {
          v: 1,
          to: SCHEDULER_ID,
          from: SCHEDULER_ID,
          iv: "AAAAAAAAAAAAAAAA",
          ct: "A".repeat(STORE_MAX_CT_LENGTH),
        };
        relay.replyNextStore((frame) => ({
          t: "store-listed",
          re: frame.id,
          records: Array.from({ length: 128 }, (_, i) => ({ key: `task:size-${i}`, version: 2, env })),
        }));
        const listed = await store.list();
        expect(listed).toHaveLength(128);
        expect(listed.every((e) => e.reason === "unopenable")).toBe(true);
      },
      { storeTimeoutMs: 10_000 },
    );
  });
});

describe("store-changed", () => {
  test("a valid frame reaches the callback; a malformed one does not", async () => {
    const heard: [string, number][] = [];
    await withRig(
      async ({ relay, deviceId }) => {
        const send = (frame: unknown): void => relay.sendRawToDaemon(deviceId, JSON.stringify(frame));
        send({ t: "store-changed", key: "task:x", version: 1 });
        await pollUntil(() => heard.length === 1, "the nudge");
        send({ t: "store-changed", key: "not a key", version: 1 });
        send({ t: "store-changed", key: "task:y", version: -1 });
        send({ t: "store-changed", key: "task:z", version: 0 });
        await pollUntil(() => heard.length === 2, "the delete nudge");
        expect(heard).toEqual([
          ["task:x", 1],
          ["task:z", 0],
        ]);
      },
      { onStoreChanged: (k, v) => heard.push([k, v]) },
    );
  });
});
