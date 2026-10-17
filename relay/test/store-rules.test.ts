import { describe, expect, test } from "bun:test";
import {
  MAX_STORE_CREATES_PER_WINDOW,
  STORE_CREATE_WINDOW_MS,
  STORE_KEY_PATTERN,
  STORE_PREFIXES,
} from "@seance/shared";
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
  type CreateWindow,
  type StoreAct,
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
