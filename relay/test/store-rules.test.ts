import { describe, expect, test } from "bun:test";
import {
  MAX_RECORDS,
  MAX_STORE_CREATES_PER_WINDOW,
  MAX_TASKS,
  STORE_CREATE_WINDOW_MS,
  STORE_KEY_PATTERN,
  STORE_PREFIXES,
} from "@seance/shared";
import type { Envelope } from "@seance/shared";
import { LEADER_KEY } from "../src/leadership.ts";
import {
  COUNTS_KEY,
  PURGE_BATCH,
  RECORD_NS,
  TOMBSTONE_AGE_NS,
  TOMBSTONE_NS,
  LIST_BURST,
  LIST_REFILL_MS,
  LIST_WINDOW_MS,
  MAX_LISTS_PER_WINDOW,
  actOf,
  admitCreate,
  admitList,
  authorize,
  floorsCreate,
  ruleFor,
  takeList,
  tombstoneAgeKey,
  RelayStore,
  type ListBucket,
  type RateWindow,
  type StoreAct,
  type StoreStorage,
} from "../src/store.ts";

const ACTS: readonly StoreAct[] = ["create", "overwrite", "delete"];

function rule(key: string): NonNullable<ReturnType<typeof ruleFor>> {
  const found = ruleFor(key);
  if (found === null) throw new Error(`no rule for ${key}`);
  return found;
}

describe("authorize", () => {
  test("task: an app creates; every overwrite and delete is the leader's", () => {
    const task = rule("task:t-1");
    expect(authorize(task, "create", "app", false)).toBeNull();
    expect(authorize(task, "overwrite", "app", false)).toBe("forbidden");
    expect(authorize(task, "delete", "app", false)).toBe("forbidden");
  });

  test("task: on the daemon leg only the term holder writes, and it never creates", () => {
    const task = rule("task:t-1");
    for (const act of ACTS) expect(authorize(task, act, "daemon", false)).toBe("not_leader");
    expect(authorize(task, "overwrite", "daemon", true)).toBeNull();
    expect(authorize(task, "delete", "daemon", true)).toBeNull();
    expect(authorize(task, "create", "daemon", true)).toBe("forbidden");
  });

  test("queue: no app writes at all", () => {
    const pause = rule("queue:pause");
    for (const act of ACTS) expect(authorize(pause, act, "app", false)).toBe("forbidden");
  });

  test("queue: the term holder creates and overwrites; anyone else is not_leader", () => {
    const pause = rule("queue:pause");
    for (const act of ["create", "overwrite"] as const) {
      expect(authorize(pause, act, "daemon", true)).toBeNull();
      expect(authorize(pause, act, "daemon", false)).toBe("not_leader");
    }
  });

  // Resume overwrites the pause and no tombstone guards `queue:`, so a delete is only ever a term holder erasing it.
  test("queue: nobody deletes, the leader included", () => {
    const pause = rule("queue:pause");
    expect(authorize(pause, "delete", "daemon", true)).toBe("forbidden");
    expect(authorize(pause, "delete", "daemon", false)).toBe("forbidden");
    expect(authorize(pause, "delete", "app", false)).toBe("forbidden");
    expect(authorize(pause, "delete", "app", true)).toBe("forbidden");
  });

  test("settings: the leader's alone, as queue: is, and never deleted", () => {
    const settings = rule("settings:vapid");
    for (const act of ACTS) expect(authorize(settings, act, "app", false)).toBe("forbidden");
    for (const act of ["create", "overwrite"] as const) {
      expect(authorize(settings, act, "daemon", true)).toBeNull();
      expect(authorize(settings, act, "daemon", false)).toBe("not_leader");
    }
    expect(authorize(settings, "delete", "daemon", true)).toBe("forbidden");
  });

  // Owner decision #14: the daemon leg needs a signed register on top of the token, so it gets an app's rights here.
  test("account: apps and any registered daemon create and overwrite; nobody deletes", () => {
    const account = rule("account:abc");
    for (const leg of ["app", "daemon"] as const) {
      for (const leader of [false, true]) {
        expect(authorize(account, "create", leg, leader)).toBeNull();
        expect(authorize(account, "overwrite", leg, leader)).toBeNull();
        expect(authorize(account, "delete", leg, leader)).toBe("forbidden");
      }
    }
  });

  test("quota: any registered daemon creates and overwrites, no app writes, nobody deletes", () => {
    const quota = rule("quota:fleet");
    for (const leader of [false, true]) {
      expect(authorize(quota, "create", "daemon", leader)).toBeNull();
      expect(authorize(quota, "overwrite", "daemon", leader)).toBeNull();
      expect(authorize(quota, "delete", "daemon", leader)).toBe("forbidden");
    }
    for (const act of ACTS) expect(authorize(quota, act, "app", false)).toBe("forbidden");
  });
});

describe("prefix rules", () => {
  const rules = Object.values(STORE_PREFIXES);

  test("the caps sum to at most MAX_RECORDS, so no prefix's fill can starve another's", () => {
    expect(rules.reduce((sum, { cap }) => sum + cap, 0)).toBeLessThanOrEqual(MAX_RECORDS);
    expect(STORE_PREFIXES.task.cap).toBe(MAX_TASKS);
  });

  // A tombstone is what stops an app re-creating a deleted record from its own old blob; a never-deleted
  // prefix needs none, and on a deterministic key one would block the only key that names the thing.
  test("a tombstone wherever a delete can be undone by a create, and nowhere else", () => {
    for (const { prefix, appCreate, deletes, tombstone } of rules) {
      expect({ prefix, tombstone }).toEqual({ prefix, tombstone: deletes !== "never" && appCreate });
    }
  });

  test("no prefix is another's prefix, so a key has one rule", () => {
    for (const a of rules) for (const b of rules) if (a !== b) expect(a.prefix.startsWith(b.prefix)).toBe(false);
  });

  test("the create floor binds every app create and daemon creates where writes are not term-fenced", () => {
    for (const r of rules) {
      expect(floorsCreate(r, "app")).toBe(true);
      expect(floorsCreate(r, "daemon")).toBe(!r.termFenced);
    }
  });
});

describe("actOf", () => {
  test("a put at expect 0 creates, any other put overwrites, a delete deletes", () => {
    expect(actOf({ t: "store-put", expect: 0 })).toBe("create");
    expect(actOf({ t: "store-put", expect: 3 })).toBe("overwrite");
    expect(actOf({ t: "store-delete", expect: 0 })).toBe("delete");
    expect(actOf({ t: "store-delete", expect: 3 })).toBe("delete");
  });
});

describe("ruleFor", () => {
  test("a key maps to its prefix's rule; an unknown prefix to none", () => {
    expect(ruleFor("task:x")).toBe(STORE_PREFIXES.task);
    expect(ruleFor("queue:pause")).toBe(STORE_PREFIXES.queue);
    expect(ruleFor("account:x")).toBe(STORE_PREFIXES.account);
    expect(ruleFor("quota:fleet")).toBe(STORE_PREFIXES.quota);
    expect(ruleFor("settings:vapid")).toBe(STORE_PREFIXES.settings);
    expect(ruleFor("push:x")).toBeNull();
    expect(ruleFor("device:x")).toBeNull();
  });
});

describe.each([
  { name: "admitCreate", admit: admitCreate, windowMs: STORE_CREATE_WINDOW_MS, max: MAX_STORE_CREATES_PER_WINDOW },
  { name: "admitList", admit: admitList, windowMs: LIST_WINDOW_MS, max: MAX_LISTS_PER_WINDOW },
])("$name", ({ admit, windowMs, max }) => {
  test("the first use opens a window", () => {
    expect(admit(undefined, 1_000)).toEqual({ windowStart: 1_000, count: 1 });
  });

  test("the floor's last use is admitted and the next is not", () => {
    let window: RateWindow | undefined;
    for (let i = 1; i <= max; i += 1) {
      const next = admit(window, 1_000 + i);
      expect(next).not.toBeNull();
      window = next ?? undefined;
    }
    expect(window).toEqual({ windowStart: 1_001, count: max });
    expect(admit(window, 2_000)).toBeNull();
  });

  test("an expired window starts again at one", () => {
    const full: RateWindow = { windowStart: 1_000, count: max };
    expect(admit(full, 1_000 + windowMs - 1)).toBeNull();
    expect(admit(full, 1_000 + windowMs)).toEqual({ windowStart: 1_000 + windowMs, count: 1 });
  });
});

describe("takeList", () => {
  test("a fresh bucket holds LIST_BURST lists, then refills one per LIST_REFILL_MS up to the burst", () => {
    let bucket: ListBucket | undefined;
    for (let i = 0; i < LIST_BURST; i += 1) {
      const next = takeList(bucket, 1_000);
      expect(next).not.toBeNull();
      bucket = next ?? undefined;
    }
    expect(takeList(bucket, 1_000)).toBeNull();
    expect(takeList(bucket, 1_000 + LIST_REFILL_MS - 1)).toBeNull();
    const refilled = takeList(bucket, 1_000 + LIST_REFILL_MS);
    expect(refilled).not.toBeNull();
    expect(takeList(refilled ?? undefined, 1_000 + LIST_REFILL_MS)).toBeNull();
    // A long idle spell refills to the burst, never past it.
    expect(takeList(bucket, 1_000 + 1_000 * LIST_REFILL_MS)).toEqual({
      tokens: LIST_BURST - 1,
      at: 1_000 + 1_000 * LIST_REFILL_MS,
    });
  });

  // The free plan reads 5M rows a day; past that every storage op fails until midnight UTC. Each prefix has
  // its own bucket, so the bound is every prefix listed full at the steady rate: the caps, at most MAX_RECORDS.
  test("a day of every prefix listed full at the steady rate leaves the rest of the free daily reads", () => {
    const caps = Object.values(STORE_PREFIXES).reduce((sum, { cap }) => sum + cap, 0);
    expect((86_400_000 / LIST_REFILL_MS) * caps).toBeLessThan(0.6 * 5_000_000);
    expect((86_400_000 / LIST_REFILL_MS) * MAX_RECORDS).toBeLessThan(0.6 * 5_000_000);
  });
});

describe("tombstoneAgeKey", () => {
  test("lexical order is numeric order", () => {
    expect(tombstoneAgeKey(999, "task:a") < tombstoneAgeKey(1_000, "task:a")).toBe(true);
    expect(tombstoneAgeKey(1_700_000_000_000, "task:a") < tombstoneAgeKey(1_700_000_000_001, "task:a")).toBe(true);
  });

  test("it ends with the store key and sits in its own namespace", () => {
    const key = tombstoneAgeKey(5, "task:t-1");
    expect(key.startsWith(TOMBSTONE_AGE_NS)).toBe(true);
    expect(key.endsWith(":task:t-1")).toBe(true);
    expect(key.slice(TOMBSTONE_AGE_NS.length, TOMBSTONE_AGE_NS.length + 16)).toBe("0000000000000005");
  });
});

describe("storage namespaces", () => {
  const SAMPLE_KEYS = [
    "task:t-1",
    "task:a.b_c-D",
    `task:${"z".repeat(64)}`,
    "queue:pause",
    "queue:q-000",
    `account:${"f".repeat(64)}`,
    "quota:fleet",
    "settings:vapid",
  ];

  test("a record's storage key never aliases the registry or the leader record", () => {
    for (const key of SAMPLE_KEYS) {
      expect(STORE_KEY_PATTERN.test(key)).toBe(true);
      expect((RECORD_NS + key).startsWith("device:")).toBe(false);
      expect(RECORD_NS + key).not.toBe(LEADER_KEY);
      expect((TOMBSTONE_NS + key).startsWith("device:")).toBe(false);
    }
    for (const namespace of [RECORD_NS, TOMBSTONE_NS, TOMBSTONE_AGE_NS, COUNTS_KEY]) {
      expect(namespace.startsWith("device:")).toBe(false);
      expect(namespace).not.toBe(LEADER_KEY);
    }
  });

  test("the four namespaces are pairwise prefix-disjoint, so one list never sweeps another's keys", () => {
    const all = [RECORD_NS, TOMBSTONE_NS, TOMBSTONE_AGE_NS, COUNTS_KEY];
    for (const a of all) {
      for (const b of all) {
        if (a !== b) expect(a.startsWith(b)).toBe(false);
      }
    }
  });
});

describe("purge batch", () => {
  // Cloudflare caps a storage delete at 128 keys per call: the record plus a tombstone and its age entry per purge.
  test("a delete's key list stays under the 128-key storage limit", () => {
    expect(1 + 2 * PURGE_BATCH).toBeLessThanOrEqual(128);
  });
});

/** In-memory `StoreStorage`; `deleteSizes` is the key count of every `delete` call. */
function fakeStorage(): StoreStorage & { readonly data: Map<string, unknown>; readonly deleteSizes: number[] } {
  const data = new Map<string, unknown>();
  const deleteSizes: number[] = [];
  return {
    data,
    deleteSizes,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async <T>(entries: Record<string, T>) => {
      for (const [key, value] of Object.entries(entries)) data.set(key, value);
    },
    delete: async (keys: string[]) => {
      deleteSizes.push(keys.length);
      return keys.filter((key) => data.delete(key)).length;
    },
    list: async <T>({ prefix, limit }: { prefix: string; limit?: number }) => {
      const keys = [...data.keys()].filter((key) => key.startsWith(prefix)).toSorted();
      return new Map(keys.slice(0, limit).map((key) => [key, data.get(key) as T]));
    },
  };
}

const ENV: Envelope = { v: 1, to: "app", from: "scheduler", iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" };

function seedTombstone(storage: ReturnType<typeof fakeStorage>, key: string, at: number): void {
  storage.data.set(TOMBSTONE_NS + key, { version: 1, at });
  storage.data.set(tombstoneAgeKey(at, key), key);
}

describe("RelayStore.delete purge", () => {
  const TOMBSTONE_MS = 1_000;
  const NOW = 100_000;

  function seeded(): { storage: ReturnType<typeof fakeStorage>; store: RelayStore } {
    const storage = fakeStorage();
    return { storage, store: new RelayStore(storage, TOMBSTONE_MS) };
  }

  test("removes min(N, PURGE_BATCH) expired tombstones with their age entries, oldest first, keeps the rest", async () => {
    const { storage, store } = seeded();
    const expired = PURGE_BATCH + 10;
    // Key order is the reverse of age order, so only the age index finds the oldest.
    const oldKey = (i: number): string => `task:old-${String(expired - i).padStart(3, "0")}`;
    for (let i = 0; i < expired; i += 1) seedTombstone(storage, oldKey(i), 1 + i);
    for (let i = 0; i < 5; i += 1) seedTombstone(storage, `task:new-${i}`, NOW - 10 + i);
    expect(await store.put("task:victim", 0, ENV, NOW - 20_000, true)).toMatchObject({ ok: true, version: 1 });
    storage.deleteSizes.length = 0;

    expect(await store.delete("task:victim", 1, NOW)).toMatchObject({ ok: true, version: 1 });

    for (let i = 0; i < expired; i += 1) {
      const kept = i >= PURGE_BATCH;
      expect(storage.data.has(TOMBSTONE_NS + oldKey(i))).toBe(kept);
      expect(storage.data.has(tombstoneAgeKey(1 + i, oldKey(i)))).toBe(kept);
    }
    for (let i = 0; i < 5; i += 1) {
      expect(storage.data.has(TOMBSTONE_NS + `task:new-${i}`)).toBe(true);
      expect(storage.data.has(tombstoneAgeKey(NOW - 10 + i, `task:new-${i}`))).toBe(true);
    }
    // The delete's own tombstone stands, and the record is gone.
    expect(storage.data.has(TOMBSTONE_NS + "task:victim")).toBe(true);
    expect(storage.data.has(RECORD_NS + "task:victim")).toBe(false);
    expect(storage.deleteSizes).toEqual([1 + 2 * PURGE_BATCH]);
    expect(Math.max(...storage.deleteSizes)).toBeLessThanOrEqual(128);
  });

  test("fewer expired than the batch: all go, the walk stops at the first unexpired one", async () => {
    const { storage, store } = seeded();
    seedTombstone(storage, "task:a", 1);
    seedTombstone(storage, "task:b", 2);
    seedTombstone(storage, "task:fresh", NOW - 10);
    await store.put("task:victim", 0, ENV, NOW - 20_000, true);
    storage.deleteSizes.length = 0;

    await store.delete("task:victim", 1, NOW);

    for (const [at, key] of [
      [1, "task:a"],
      [2, "task:b"],
    ] as const) {
      expect(storage.data.has(TOMBSTONE_NS + key)).toBe(false);
      expect(storage.data.has(tombstoneAgeKey(at, key))).toBe(false);
    }
    expect(storage.data.has(TOMBSTONE_NS + "task:fresh")).toBe(true);
    expect(storage.data.has(tombstoneAgeKey(NOW - 10, "task:fresh"))).toBe(true);
    expect(storage.deleteSizes).toEqual([1 + 2 * 2]);
  });
});

const counts = (storage: ReturnType<typeof fakeStorage>): unknown => storage.data.get(COUNTS_KEY);

describe("RelayStore tombstone cap", () => {
  const TOMBSTONE_MS = 1_000;
  const NOW = 100_000;
  const CAP = 3;

  async function withTasks(...keys: string[]): Promise<{ storage: ReturnType<typeof fakeStorage>; store: RelayStore }> {
    const storage = fakeStorage();
    const store = new RelayStore(storage, TOMBSTONE_MS, CAP);
    for (const key of keys) {
      // oxlint-disable-next-line no-await-in-loop -- each create reads the counts the last one wrote
      expect(await store.put(key, 0, ENV, NOW - 10, true)).toMatchObject({ ok: true, version: 1 });
    }
    return { storage, store };
  }

  test("a delete past the cap is store_full and leaves the record; a retried delete still reads version_conflict", async () => {
    const { storage, store } = await withTasks("task:a", "task:b", "task:c", "task:d");
    for (const key of ["task:a", "task:b", "task:c"]) {
      // oxlint-disable-next-line no-await-in-loop -- in order: each delete counts the last one's tombstone
      expect(await store.delete(key, 1, NOW)).toMatchObject({ ok: true });
    }
    expect(counts(storage)).toMatchObject({ total: 1, tombstones: CAP });

    expect(await store.delete("task:d", 1, NOW)).toEqual({ ok: false, code: "store_full" });
    expect(storage.data.has(RECORD_NS + "task:d")).toBe(true);
    expect(storage.data.has(TOMBSTONE_NS + "task:d")).toBe(false);
    expect(await store.delete("task:a", 1, NOW)).toEqual({ ok: false, code: "version_conflict" });
    expect(counts(storage)).toMatchObject({ total: 1, tombstones: CAP });
  });

  test("a delete at the cap goes through once the expired tombstones it purges make room", async () => {
    const { storage, store } = await withTasks("task:d");
    for (const [i, key] of ["task:a", "task:b", "task:c"].entries()) {
      seedTombstone(storage, key, NOW - TOMBSTONE_MS - 10 + i);
    }
    // Written before the cap: no tombstone count, so the delete counts the age index.
    storage.data.set(COUNTS_KEY, { total: 1, prefixes: { "task:": 1 } });

    expect(await store.delete("task:d", 1, NOW)).toMatchObject({ ok: true });
    expect(counts(storage)).toEqual({ total: 0, prefixes: { "task:": 0 }, tombstones: 1 });
    expect(storage.data.has(TOMBSTONE_NS + "task:a")).toBe(false);
  });

  test("a row from before the cap is counted from the age index, so its tombstones are not forgotten", async () => {
    const { storage, store } = await withTasks("task:d");
    for (const key of ["task:a", "task:b", "task:c"]) seedTombstone(storage, key, NOW - 10);
    storage.data.set(COUNTS_KEY, { total: 1, prefixes: { "task:": 1 } });

    expect(await store.delete("task:d", 1, NOW)).toEqual({ ok: false, code: "store_full" });
  });

  test("a delete under a prefix with no tombstone leaves none and counts none", async () => {
    const { storage, store } = await withTasks("queue:pause");
    expect(await store.delete("queue:pause", 1, NOW)).toMatchObject({ ok: true, version: 1 });
    expect(storage.data.has(TOMBSTONE_NS + "queue:pause")).toBe(false);
    expect(counts(storage)).toMatchObject({ total: 0, tombstones: 0 });
    expect(await store.put("queue:pause", 0, ENV, NOW, true)).toMatchObject({ ok: true, version: 1 });
  });

  test("a create past its prefix's cap is store_full, and other prefixes still create", async () => {
    const { store } = await withTasks("quota:fleet");
    expect(await store.put("quota:other", 0, ENV, NOW, true)).toEqual({ ok: false, code: "store_full" });
    expect(await store.put("quota:fleet", 0, ENV, NOW, true)).toEqual({ ok: false, code: "version_conflict" });
    expect(await store.put("account:a", 0, ENV, NOW, true)).toMatchObject({ ok: true, version: 1 });
  });

  test("a create that clears an expired tombstone counts it gone", async () => {
    const { storage, store } = await withTasks("task:a");
    expect(await store.delete("task:a", 1, NOW)).toMatchObject({ ok: true });
    expect(counts(storage)).toMatchObject({ tombstones: 1 });
    expect(await store.put("task:a", 0, ENV, NOW + TOMBSTONE_MS, true)).toMatchObject({ ok: true, version: 1 });
    expect(counts(storage)).toMatchObject({ total: 1, tombstones: 0 });
  });
});
