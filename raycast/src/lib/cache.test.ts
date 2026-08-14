import { beforeEach, describe, expect, test } from "bun:test";
import {
  LAST_USED_KEY,
  readLastUsed,
  readRegistry,
  REGISTRY_KEY,
  writeLastUsed,
  writeRegistry,
  type Store,
} from "./cache.ts";
import type { LastUsed, PickerMachine } from "./form.ts";

/** Raycast's LocalStorage is an external boundary; a Map stands in for it. */
function fakeStore(): Store & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => Promise.resolve(items.get(key)),
    setItem: (key, value) => {
      items.set(key, value);
      return Promise.resolve();
    },
  };
}

let store: ReturnType<typeof fakeStore>;

beforeEach(() => {
  store = fakeStore();
});

const machine: PickerMachine = {
  deviceId: "device-1",
  name: "laptop",
  connected: true,
  lastSeen: 1_700,
  scannedAt: 1_600,
  repos: [{ name: "seance", path: "/repos/seance", defaultBranch: "main" }],
};

const lastUsed: LastUsed = {
  machineId: "device-1",
  repos: { "device-1": "seance" },
  model: "sonnet",
  effort: "high",
  worktree: false,
};

describe("registry cache", () => {
  test("round-trips a projection", async () => {
    await writeRegistry(store, [machine], 42);
    expect(await readRegistry(store)).toEqual({ machines: [machine], at: 42 });
  });

  test("drops fields the picker never renders, so the stored shape stays pinned", async () => {
    // `Machine` from the relay client carries `platform`; the projection must not.
    const wider: PickerMachine & { readonly platform: string } = { ...machine, platform: "darwin" };
    await writeRegistry(store, [wider], 1);
    const stored: unknown = JSON.parse(store.items.get(REGISTRY_KEY) ?? "");
    expect(JSON.stringify(stored)).not.toContain("platform");
  });

  test("answers null when nothing has been cached yet", async () => {
    expect(await readRegistry(store)).toBeNull();
  });

  test("answers null on a half-written blob rather than throwing", async () => {
    await store.setItem(REGISTRY_KEY, '{"machines":[');
    expect(await readRegistry(store)).toBeNull();
  });

  test("answers null when the blob is the wrong shape entirely", async () => {
    await store.setItem(REGISTRY_KEY, '"a string"');
    expect(await readRegistry(store)).toBeNull();
  });

  test("answers null when a machine is missing a field an older build did not write", async () => {
    await store.setItem(REGISTRY_KEY, JSON.stringify({ at: 1, machines: [{ deviceId: "d", name: "n" }] }));
    expect(await readRegistry(store)).toBeNull();
  });

  test("answers null when `at` is not a number", async () => {
    await store.setItem(REGISTRY_KEY, JSON.stringify({ at: "recently", machines: [] }));
    expect(await readRegistry(store)).toBeNull();
  });

  test("one unreadable repo invalidates the whole cache, not just that repo", async () => {
    const corrupt = { ...machine, repos: [{ name: "seance" }] };
    await store.setItem(REGISTRY_KEY, JSON.stringify({ at: 1, machines: [corrupt] }));
    expect(await readRegistry(store)).toBeNull();
  });

  test("keeps a null defaultBranch, which is a legitimate value", async () => {
    const unset: PickerMachine = { ...machine, repos: [{ name: "x", path: "/x", defaultBranch: null }] };
    await writeRegistry(store, [unset], 1);
    expect((await readRegistry(store))?.machines[0]?.repos[0]?.defaultBranch).toBeNull();
  });

  test("an empty registry caches as an empty list, not as absence", async () => {
    await writeRegistry(store, [], 7);
    expect(await readRegistry(store)).toEqual({ machines: [], at: 7 });
  });
});

describe("last-used cache", () => {
  test("round-trips", async () => {
    await writeLastUsed(store, lastUsed);
    expect(await readLastUsed(store)).toEqual(lastUsed);
  });

  test("answers null on first run", async () => {
    expect(await readLastUsed(store)).toBeNull();
  });

  test("keeps a null machineId, which means nothing has been spawned yet", async () => {
    await writeLastUsed(store, { ...lastUsed, machineId: null });
    expect((await readLastUsed(store))?.machineId).toBeNull();
  });

  test("answers null for a model this build no longer offers, so the preferences reseed", async () => {
    await store.setItem(LAST_USED_KEY, JSON.stringify({ ...lastUsed, model: "retired" }));
    expect(await readLastUsed(store)).toBeNull();
  });

  test("answers null for an effort this build no longer offers", async () => {
    await store.setItem(LAST_USED_KEY, JSON.stringify({ ...lastUsed, effort: "ludicrous" }));
    expect(await readLastUsed(store)).toBeNull();
  });

  test("answers null when the repo map holds a non-string", async () => {
    await store.setItem(LAST_USED_KEY, JSON.stringify({ ...lastUsed, repos: { "device-1": 3 } }));
    expect(await readLastUsed(store)).toBeNull();
  });

  test("answers null when worktree is missing", async () => {
    await store.setItem(LAST_USED_KEY, JSON.stringify({ ...lastUsed, worktree: undefined }));
    expect(await readLastUsed(store)).toBeNull();
  });

  test("answers null on unparseable JSON", async () => {
    await store.setItem(LAST_USED_KEY, "not json");
    expect(await readLastUsed(store)).toBeNull();
  });
});
