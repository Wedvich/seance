import { describe, expect, test } from "bun:test";
import {
  MAX_STORE_CREATES_PER_WINDOW,
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
  actOf,
  admitCreate,
  authorize,
  ruleFor,
  tombstoneAgeKey,
  RelayStore,
  type CreateWindow,
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

  test("task: on the daemon leg only the term holder writes, whatever the act", () => {
    const task = rule("task:t-1");
    for (const act of ACTS) {
      expect(authorize(task, act, "daemon", true)).toBeNull();
      expect(authorize(task, act, "daemon", false)).toBe("not_leader");
    }
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
    expect(ruleFor("account:x")).toBeNull();
    expect(ruleFor("device:x")).toBeNull();
  });
});

describe("admitCreate", () => {
  test("the first create opens a window", () => {
    expect(admitCreate(undefined, 1_000)).toEqual({ windowStart: 1_000, creates: 1 });
  });

  test("the floor's last create is admitted and the next is not", () => {
    let window: CreateWindow | undefined;
    for (let i = 1; i <= MAX_STORE_CREATES_PER_WINDOW; i += 1) {
      const next = admitCreate(window, 1_000 + i);
      expect(next).not.toBeNull();
      window = next ?? undefined;
    }
    expect(window).toEqual({ windowStart: 1_001, creates: MAX_STORE_CREATES_PER_WINDOW });
    expect(admitCreate(window, 2_000)).toBeNull();
  });

  test("a window older than STORE_CREATE_WINDOW_MS starts again at one", () => {
    const full: CreateWindow = { windowStart: 1_000, creates: MAX_STORE_CREATES_PER_WINDOW };
    expect(admitCreate(full, 1_000 + STORE_CREATE_WINDOW_MS - 1)).toBeNull();
    expect(admitCreate(full, 1_000 + STORE_CREATE_WINDOW_MS)).toEqual({
      windowStart: 1_000 + STORE_CREATE_WINDOW_MS,
      creates: 1,
    });
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
  const SAMPLE_KEYS = ["task:t-1", "task:a.b_c-D", `task:${"z".repeat(64)}`, "queue:pause", "queue:q-000"];

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
