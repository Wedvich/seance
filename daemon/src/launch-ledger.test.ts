import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaunchLedger, LEDGER_MAX, LEDGER_MAX_AGE_MS } from "./launch-ledger.ts";

let dir: string;
let path: string;

/**
 * A fresh ledger dates itself no earlier than its directory's mtime, which a
 * real write moves to the real clock; the fake clocks here start near zero, so
 * the directory is put back to the epoch before each fresh open.
 */
async function rewindDir(): Promise<void> {
  await utimes(dir, 0, 0);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "seance-ledger-"));
  path = join(dir, "launched.json");
  await rewindDir();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LaunchLedger", () => {
  test("write-ahead: the id is on disk when record resolves, and a new instance reads it back", async () => {
    const clock = { now: 1_000 };
    const ledger = await LaunchLedger.open(path, () => clock.now);
    clock.now = 2_000;
    expect(await ledger.record("t1")).toBe(true);
    expect(await readFile(path, "utf8")).toContain('"t1"');

    // A restart: nothing in memory, only the file.
    const reopened = await LaunchLedger.open(path, () => 9_999);
    expect(reopened.ids()).toEqual(["t1"]);
    expect(reopened.since()).toBe(1_000);
  });

  test("a missing or corrupt file is a fresh ledger, complete from now, and is replaced on the next write", async () => {
    expect((await LaunchLedger.open(path, () => 7)).since()).toBe(7);
    for (const junk of ["{not json", '{"v":2,"since":1,"tasks":[]}', '{"v":1,"since":1,"tasks":[["bad id;", 1]]}']) {
      await writeFile(path, junk);
      await rewindDir();
      const ledger = await LaunchLedger.open(path, () => 42);
      expect(ledger.ids()).toEqual([]);
      expect(ledger.since()).toBe(42);
    }
    const ledger = await LaunchLedger.open(path, () => 42);
    await ledger.record("t1");
    expect((await LaunchLedger.open(path, () => 50)).ids()).toEqual(["t1"]);
  });

  test("bounded by count: the oldest goes, and since moves past it", async () => {
    const clock = { now: 0 };
    const ledger = await LaunchLedger.open(path, () => clock.now);
    for (let i = 0; i <= LEDGER_MAX; i++) {
      clock.now = 100 + i;
      await ledger.record(`t${i}`);
    }
    expect(ledger.ids()).toHaveLength(LEDGER_MAX);
    expect(ledger.ids()).not.toContain("t0");
    expect(ledger.since()).toBe(101);
    expect((await LaunchLedger.open(path, () => clock.now)).since()).toBe(101);
  });

  test("bounded by age: an entry past a week goes, and since moves past it; an empty ledger keeps its since", async () => {
    const clock = { now: 0 };
    const ledger = await LaunchLedger.open(path, () => clock.now);
    clock.now = 10;
    await ledger.record("old");
    clock.now = 20;
    await ledger.record("newer");
    clock.now = 10 + LEDGER_MAX_AGE_MS + 1;
    expect(ledger.ids()).toEqual(["newer"]);
    expect(ledger.since()).toBe(11);
    clock.now += LEDGER_MAX_AGE_MS;
    expect(ledger.ids()).toEqual([]);
    expect(ledger.since()).toBe(21);
  });

  test("a retracted launch leaves without moving since; re-recording an id is not fresh", async () => {
    const ledger = await LaunchLedger.open(path, () => 5);
    expect(await ledger.record("t1")).toBe(true);
    expect(await ledger.record("t1")).toBe(false);
    await ledger.record("t2");
    await ledger.retract("t2");
    expect((await LaunchLedger.open(path, () => 5)).ids()).toEqual(["t1"]);
    expect(ledger.since()).toBe(5);
  });

  test("a fresh ledger never dates itself before its directory last changed: a clock behind at boot cannot", async () => {
    await writeFile(path, "{lost");
    // The lost ledger's last write, by a clock that was right then.
    const lastWrite = 1_800_000_000;
    await utimes(dir, lastWrite, lastWrite);
    const ledger = await LaunchLedger.open(path, () => 5);
    expect(ledger.since()).toBeGreaterThan(lastWrite * 1_000);
    // Once the clock is past it, the clock decides as before.
    await rewindDir();
    expect((await LaunchLedger.open(join(dir, "missing.json"), () => 5)).since()).toBe(5);
  });

  // Writes are serialized, each the whole ledger as it stands when it starts:
  // dropping the id when the first write fails would have the second, which
  // starts right after, put the ledger on disk without it — and report success.
  test("a failed record does not drop an id a concurrent record of it is about to write", async () => {
    const ledger = await LaunchLedger.open(path, () => 1);
    // A directory where the file should be: every write fails at the rename.
    await mkdir(join(path, "x"), { recursive: true });
    const first = ledger.record("dup");
    const second = ledger.record("dup");
    await expect(first).rejects.toThrow();
    expect(ledger.ids()).toContain("dup");
    await expect(second).rejects.toThrow();
    // Both failed and nothing launched: kept, it reads as ran-and-ended, never as never-started.
    expect(ledger.ids()).toContain("dup");
  });

  test("concurrent records all land: writes are serialized, each the whole ledger", async () => {
    const ledger = await LaunchLedger.open(path, () => 1);
    await Promise.all(Array.from({ length: 20 }, (_, i) => ledger.record(`t${i}`)));
    expect((await LaunchLedger.open(path, () => 1)).ids().toSorted()).toEqual(
      Array.from({ length: 20 }, (_, i) => `t${i}`).toSorted(),
    );
  });
});
