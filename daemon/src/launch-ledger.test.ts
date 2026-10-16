import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaunchLedger, LEDGER_MAX, LEDGER_MAX_AGE_MS } from "./launch-ledger.ts";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "seance-ledger-"));
  path = join(dir, "launched.json");
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

  test("concurrent records all land: writes are serialized, each the whole ledger", async () => {
    const ledger = await LaunchLedger.open(path, () => 1);
    await Promise.all(Array.from({ length: 20 }, (_, i) => ledger.record(`t${i}`)));
    expect((await LaunchLedger.open(path, () => 1)).ids().toSorted()).toEqual(
      Array.from({ length: 20 }, (_, i) => `t${i}`).toSorted(),
    );
  });
});
