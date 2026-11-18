import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONVERSATION_IDLE_MS,
  CONVERSATIONS_KEPT_MAX,
  LAST_LIVE_WRITE_MS,
  loadConversationStore,
} from "./conversation-store.ts";
import { pollUntil } from "../test/fixtures.ts";

const id = (n: number): string => `${String(n).padStart(8, "0")}-1c2d-4e5f-8a9b-0c1d2e3f4a5b`;

const base = await mkdtemp(join(tmpdir(), "seance-conv-store-"));
let dir: string;
let path: string;
let seq = 0;

beforeEach(async () => {
  dir = join(base, String(seq++));
  await mkdir(dir, { recursive: true });
  path = join(dir, "conversations.json");
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function onDisk(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("the conversations file", () => {
  test("a label lands 0600, whole, with no temp file left, and a restart reads it back", async () => {
    let now = 1_000_000;
    const store = loadConversationStore(path, () => now);
    await store.setLabel(id(1), "release notes");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["conversations.json"]);
    expect(await onDisk()).toEqual({
      [id(1)]: { ownerLabel: { value: "release notes", at: 1_000_000 }, subscriptions: [], lastLive: 1_000_000 },
    });
    now += 5;
    const restarted = loadConversationStore(path, () => now);
    expect(restarted.label(id(1))).toEqual({ value: "release notes", at: 1_000_000 });
  });

  test("clearing the label drops an entry that holds nothing else", async () => {
    const store = loadConversationStore(path);
    await store.setLabel(id(2), "x");
    await store.setLabel(id(2), "");
    expect(store.label(id(2))).toBeUndefined();
    expect(await onDisk()).toEqual({});
  });

  test("a missing, unreadable or malformed file loads empty", async () => {
    expect(loadConversationStore(path).label(id(3))).toBeUndefined();
    await writeFile(path, "{not json");
    expect(loadConversationStore(path).label(id(3))).toBeUndefined();
    await writeFile(path, JSON.stringify([1, 2]));
    expect(loadConversationStore(path).label(id(3))).toBeUndefined();
    await writeFile(path, JSON.stringify({ [id(3)]: { ownerLabel: { value: "ok", at: 5 }, lastLive: 5 } }));
    await chmod(path, 0o000);
    // Root reads through a 000 mode; the point is only that a read that fails loads empty.
    if (process.getuid?.() !== 0) expect(loadConversationStore(path, () => 10).label(id(3))).toBeUndefined();
    await chmod(path, 0o600);
  });

  test("entries are parsed strictly: a bad id, label or time is dropped, never the file", async () => {
    const now = 10_000;
    await writeFile(
      path,
      JSON.stringify({
        [id(4)]: { ownerLabel: { value: "kept", at: 5 }, subscriptions: [], lastLive: 9_000 },
        "not-an-id": { ownerLabel: { value: "gone", at: 5 }, lastLive: 9_000 },
        [id(5)]: { ownerLabel: { value: "x".repeat(500), at: 5 }, lastLive: 9_000 },
        [id(6)]: { ownerLabel: { value: "no time" }, lastLive: 9_000 },
        [id(7)]: { ownerLabel: { value: "no live", at: 5 } },
        [id(8)]: {
          subscriptions: [
            { adapter: "tracker", since: 7 },
            { adapter: "Bad Name", since: 7 },
          ],
          lastLive: 9_000,
        },
      }),
    );
    const store = loadConversationStore(path, () => now);
    expect(store.label(id(4))?.value).toBe("kept");
    for (const n of [5, 6, 7]) expect(store.label(id(n))).toBeUndefined();
    // A subscription a later build wrote is written back, not erased, by this build's next label write.
    await store.setLabel(id(9), "new");
    const disk = await onDisk();
    expect(Object.keys(disk).toSorted()).toEqual([id(4), id(8), id(9)].toSorted());
    expect(disk[id(8)]).toEqual({ subscriptions: [{ adapter: "tracker", since: 7 }], lastLive: 9_000 });
  });

  test("a conversation idle past 30 days is dropped at load", async () => {
    const now = CONVERSATION_IDLE_MS * 2;
    await writeFile(
      path,
      JSON.stringify({
        [id(10)]: {
          ownerLabel: { value: "stale", at: 1 },
          subscriptions: [],
          lastLive: now - CONVERSATION_IDLE_MS - 1,
        },
        [id(11)]: {
          ownerLabel: { value: "fresh", at: 1 },
          subscriptions: [],
          lastLive: now - CONVERSATION_IDLE_MS + 1,
        },
      }),
    );
    const store = loadConversationStore(path, () => now);
    expect(store.label(id(10))).toBeUndefined();
    expect(store.label(id(11))?.value).toBe("fresh");
  });

  test("past the cap the least recently live goes first, at load and on a write", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: CONVERSATIONS_KEPT_MAX + 1 }, (_, n) => [
        id(100 + n),
        { ownerLabel: { value: `l${n}`, at: 1 }, subscriptions: [], lastLive: 1_000 + n },
      ]),
    );
    await writeFile(path, JSON.stringify(entries));
    let now = 2_000;
    const store = loadConversationStore(path, () => now);
    // The oldest of 257 was dropped at load.
    expect(store.label(id(100))).toBeUndefined();
    expect(store.label(id(101))?.value).toBe("l1");
    // A touch makes 101 recent, so a new label evicts 102, the least recently live now.
    store.live(id(101));
    now += 1;
    await store.setLabel(id(999), "new");
    expect(store.label(id(101))?.value).toBe("l1");
    expect(store.label(id(102))).toBeUndefined();
    expect(Object.keys(await onDisk())).toHaveLength(CONVERSATIONS_KEPT_MAX);
  });

  test("lastLive reaches the disk at most hourly", async () => {
    let now = 1_000;
    const store = loadConversationStore(path, () => now);
    await store.setLabel(id(20), "x");
    now += 60_000;
    store.live(id(20));
    // A non-event: nothing to poll for, so a short wait before reading the disk unchanged.
    await Bun.sleep(50);
    expect((await onDisk())[id(20)]).toMatchObject({ lastLive: 1_000 });
    now += LAST_LIVE_WRITE_MS;
    store.live(id(20));
    const due = 61_000 + LAST_LIVE_WRITE_MS;
    await pollUntil(
      async () => ((await onDisk())[id(20)] as { lastLive?: number } | undefined)?.lastLive === due,
      "lastLive written past the spacing",
    );
  });

  test("clearing a label that is not there writes nothing, not even the file", async () => {
    const store = loadConversationStore(path);
    await store.setLabel(id(40), "");
    expect(await readdir(dir)).toEqual([]);
    await store.setLabel(id(41), "x");
    const before = await readFile(path, "utf8");
    await store.setLabel(id(40), "");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("a write that fails leaves the label as it was", async () => {
    const store = loadConversationStore(path);
    await store.setLabel(id(30), "before");
    // A directory where the temp file would go makes the write fail.
    await rm(dir, { recursive: true });
    await writeFile(dir, "");
    await expect(store.setLabel(id(30), "after")).rejects.toThrow();
    await rm(dir);
    await mkdir(dir);
    expect(store.label(id(30))?.value).toBe("before");
  });
});
