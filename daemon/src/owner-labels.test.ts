// The owner's label at rest: kept by the one owner of `conversations.json` beside the adapter subscriptions
// (`adapter-subscriptions.ts`, docs/tags.md §3.2).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVERSATION_IDLE_MS, CONVERSATIONS_KEPT_MAX, openSubscriptions } from "./adapter-subscriptions.ts";
import { pollUntil } from "../test/fixtures.ts";

const id = (n: number): string => `${String(n).padStart(8, "0")}-1c2d-4e5f-8a9b-0c1d2e3f4a5b`;
const HOUR_MS = 60 * 60_000;

const base = await mkdtemp(join(tmpdir(), "seance-owner-labels-"));
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

async function conversationsOnDisk(): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await readFile(path, "utf8")) as { conversations: Record<string, unknown> };
  return raw.conversations;
}

const file = (conversations: Record<string, unknown>): string => JSON.stringify({ v: 1, adapters: {}, conversations });

describe("the owner's label in the conversations file", () => {
  test("a label lands 0600, whole, with no temp file left, and a restart reads it back", async () => {
    let now = 1_000_000;
    const store = openSubscriptions(path, { now: () => now });
    await store.setLabel(id(1), "release notes");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["conversations.json"]);
    expect(await conversationsOnDisk()).toEqual({
      [id(1)]: { ownerLabel: { value: "release notes", at: 1_000_000 }, subscriptions: [], lastLive: 1_000_000 },
    });
    now += 5;
    const restarted = openSubscriptions(path, { now: () => now });
    expect(restarted.label(id(1))).toEqual({ value: "release notes", at: 1_000_000 });
  });

  test("clearing the label drops an entry that holds nothing else", async () => {
    const store = openSubscriptions(path);
    await store.setLabel(id(2), "x");
    await store.setLabel(id(2), "");
    expect(store.label(id(2))).toBeUndefined();
    expect(await conversationsOnDisk()).toEqual({});
  });

  test("a label and a subscription share one entry: neither's write or end erases the other", async () => {
    let now = 5_000;
    const store = openSubscriptions(path, { now: () => now });
    store.add("tracker", id(3));
    await store.setLabel(id(3), "named");
    store.leave("tracker", id(3));
    await store.flushed();
    expect(await conversationsOnDisk()).toEqual({
      [id(3)]: { ownerLabel: { value: "named", at: 5_000 }, subscriptions: [], lastLive: 5_000 },
    });
    now += 1;
    store.add("tracker", id(3));
    await store.setLabel(id(3), "");
    await store.flushed();
    expect(await conversationsOnDisk()).toEqual({
      [id(3)]: { subscriptions: [{ adapter: "tracker", since: 5_001 }], lastLive: 5_001 },
    });
    // The CLI's own open of the file (`seance adapter remove`) keeps a label it does not touch.
    await store.setLabel(id(3), "again");
    const cli = openSubscriptions(path, { now: () => now });
    cli.drop("tracker");
    await cli.flushed();
    expect(openSubscriptions(path, { now: () => now }).label(id(3))?.value).toBe("again");
  });

  test("a missing, unreadable or malformed file loads empty", async () => {
    expect(openSubscriptions(path).label(id(4))).toBeUndefined();
    await writeFile(path, "{not json");
    expect(openSubscriptions(path).label(id(4))).toBeUndefined();
    await writeFile(path, JSON.stringify([1, 2]));
    expect(openSubscriptions(path).label(id(4))).toBeUndefined();
    await writeFile(path, file({ [id(4)]: { ownerLabel: { value: "ok", at: 5 }, subscriptions: [], lastLive: 5 } }));
    await chmod(path, 0o000);
    // Root reads through a 000 mode; the point is only that a read that fails loads empty.
    if (process.getuid?.() !== 0) expect(openSubscriptions(path, { now: () => 10 }).label(id(4))).toBeUndefined();
    await chmod(path, 0o600);
  });

  test("a bad label is dropped, never the entry's subscriptions", async () => {
    const now = 10_000;
    await writeFile(
      path,
      file({
        [id(5)]: { ownerLabel: { value: "kept", at: 5 }, subscriptions: [], lastLive: 9_000 },
        [id(6)]: { ownerLabel: { value: "x".repeat(500), at: 5 }, subscriptions: [], lastLive: 9_000 },
        [id(7)]: { ownerLabel: { value: "no time" }, subscriptions: [], lastLive: 9_000 },
        [id(8)]: {
          ownerLabel: { value: 7, at: 5 },
          subscriptions: [{ adapter: "tracker", since: 7 }],
          lastLive: 9_000,
        },
      }),
    );
    const store = openSubscriptions(path, { now: () => now });
    expect(store.label(id(5))?.value).toBe("kept");
    for (const n of [6, 7, 8]) expect(store.label(id(n))).toBeUndefined();
    expect(store.has("tracker", id(8))).toBe(true);
  });

  test("a conversation idle past 30 days is dropped at load", async () => {
    const now = CONVERSATION_IDLE_MS * 2;
    await writeFile(
      path,
      file({
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
    const store = openSubscriptions(path, { now: () => now });
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
    await writeFile(path, file(entries));
    let now = 2_000;
    const store = openSubscriptions(path, { now: () => now });
    expect(store.label(id(100))).toBeUndefined();
    expect(store.label(id(101))?.value).toBe("l1");
    // A touch makes 101 recent, so a new label evicts 102, the least recently live now.
    store.live(id(101));
    now += 1;
    await store.setLabel(id(999), "new");
    expect(store.label(id(101))?.value).toBe("l1");
    expect(store.label(id(102))).toBeUndefined();
    expect(Object.keys(await conversationsOnDisk())).toHaveLength(CONVERSATIONS_KEPT_MAX);
  });

  test("lastLive reaches the disk at most hourly", async () => {
    let now = 1_000;
    const store = openSubscriptions(path, { now: () => now });
    await store.setLabel(id(20), "x");
    now += 60_000;
    store.live(id(20));
    // A non-event: nothing to poll for, so a short wait before reading the disk unchanged.
    await Bun.sleep(50);
    expect((await conversationsOnDisk())[id(20)]).toMatchObject({ lastLive: 1_000 });
    now += HOUR_MS;
    store.live(id(20));
    const due = 61_000 + HOUR_MS;
    await pollUntil(
      async () => ((await conversationsOnDisk())[id(20)] as { lastLive?: number } | undefined)?.lastLive === due,
      "lastLive written past the spacing",
    );
  });

  test("clearing a label that is not there writes nothing, not even the file", async () => {
    const store = openSubscriptions(path);
    await store.setLabel(id(40), "");
    expect(await readdir(dir)).toEqual([]);
    await store.setLabel(id(41), "x");
    const before = await readFile(path, "utf8");
    await store.setLabel(id(40), "");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("a write that fails leaves the label as it was", async () => {
    const store = openSubscriptions(path);
    await store.setLabel(id(30), "before");
    // A file where the directory was makes the write fail.
    await rm(dir, { recursive: true });
    await writeFile(dir, "");
    await expect(store.setLabel(id(30), "after")).rejects.toThrow();
    await rm(dir);
    await mkdir(dir);
    expect(store.label(id(30))?.value).toBe("before");
  });
});
