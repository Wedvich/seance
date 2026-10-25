import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORE_TOMBSTONE_MS } from "@seance/shared";
import { FLOOR_MAX, VersionFloor } from "./version-floor.ts";

let dir: string;
let n = 0;
const fresh = (): string => join(dir, `floor-${n++}.json`);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "seance-floor-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("version floor", () => {
  test("only rises from reads, survives a restart, and is 0600 on disk", async () => {
    const path = fresh();
    const floor = await VersionFloor.open(path);
    expect(floor.task("t-1")).toBe(0);
    expect(floor.sawTask("t-1", 5)).toBe(true);
    expect(floor.sawTask("t-1", 3)).toBe(false);
    expect(floor.sawPause(4)).toBe(true);
    expect(floor.sawPause(2)).toBe(false);
    await floor.save();
    const reopened = await VersionFloor.open(path);
    expect(reopened.task("t-1")).toBe(5);
    expect(reopened.pause()).toBe(4);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a record that vanished is the leader's own delete only when it sent one", () => {
    const floor = VersionFloor.memory();
    expect(floor.vanished("never-seen")).toBe(true);
    floor.sawTask("kept", 2);
    expect(floor.vanished("kept")).toBe(false);
    floor.deletedTask("pruned", 3, true);
    expect(floor.vanished("pruned")).toBe(true);
    // Past the tombstone, the deleted version is below the floor.
    expect(floor.task("pruned")).toBe(4);
    // A lost answer: a null read is the delete having landed…
    floor.deletedTask("lost", 6, false);
    expect(floor.task("lost")).toBe(6);
    expect(floor.vanished("lost")).toBe(true);
    expect(floor.task("lost")).toBe(7);
    // …and a record still there at that version is the delete not having landed.
    floor.deletedTask("missed", 2, false);
    floor.sawTask("missed", 2);
    expect(floor.vanished("missed")).toBe(false);
  });

  test("the leader's own pause write sets the floor, even lower: a person's resume lets a held queue go", () => {
    const floor = VersionFloor.memory();
    floor.sawPause(9);
    floor.wrotePause(1);
    expect(floor.pause()).toBe(1);
  });

  test("the settings slot only rises, from reads and from the leader's own writes", () => {
    const floor = VersionFloor.memory();
    expect(floor.settings()).toBe(0);
    expect(floor.sawSettings(2)).toBe(true);
    expect(floor.sawSettings(2)).toBe(false);
    expect(floor.sawSettings(1)).toBe(false);
    expect(floor.wroteSettings(1)).toBe(false);
    expect(floor.settings()).toBe(2);
    expect(floor.wroteSettings(3)).toBe(true);
    expect(floor.settings()).toBe(3);
  });

  test("the settings slot survives a restart and leaves v and the task floors as an older daemon reads them", async () => {
    const path = fresh();
    const floor = await VersionFloor.open(path);
    floor.sawTask("t-1", 5);
    await floor.save();
    // Never led: no settings key at all, so the file is the one an older build wrote.
    const before = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(before).toSorted()).toEqual(["pause", "tasks", "v"]);

    floor.wroteSettings(4);
    await floor.save();
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after).toMatchObject({ v: 1, pause: 0, tasks: before.tasks, settings: 4 });
    expect((await VersionFloor.open(path)).settings()).toBe(4);

    // A file written before the slot existed reads as 0.
    const old = fresh();
    await writeFile(old, '{"v":1,"pause":2,"tasks":[]}\n');
    const reopened = await VersionFloor.open(old);
    expect(reopened.pause()).toBe(2);
    expect(reopened.settings()).toBe(0);
  });

  test("forgets a key unseen past the tombstone window, and the least recently seen past FLOOR_MAX", () => {
    const clock = { now: 1_000 };
    const floor = VersionFloor.memory(() => clock.now);
    floor.sawTask("old", 3);
    clock.now += STORE_TOMBSTONE_MS / 2;
    floor.sawTask("seen-again", 3);
    floor.sawTask("old", 3);
    floor.sawTask("stale", 2);
    clock.now += STORE_TOMBSTONE_MS / 2 + 1;
    floor.sawTask("old", 3);
    expect(floor.task("old")).toBe(3);
    expect(floor.task("stale")).toBe(2);
    clock.now += STORE_TOMBSTONE_MS;
    expect(floor.task("stale")).toBe(0);

    const full = VersionFloor.memory();
    for (let i = 0; i <= FLOOR_MAX; i += 1) full.sawTask(`t-${i}`, 1);
    expect(full.task("t-0")).toBe(0);
    expect(full.task(`t-${FLOOR_MAX}`)).toBe(1);
  });

  test("an unchanged sighting writes nothing until a day has passed, so a takeover's listing is not a write per key", () => {
    const clock = { now: 1_000 };
    const floor = VersionFloor.memory(() => clock.now);
    expect(floor.sawTask("t-1", 2)).toBe(true);
    clock.now += 60_000;
    expect(floor.sawTask("t-1", 2)).toBe(false);
    clock.now += 24 * 3_600_000;
    expect(floor.sawTask("t-1", 2)).toBe(true);
  });

  test("a corrupt file starts empty and is replaced by the next save", async () => {
    const path = fresh();
    await writeFile(path, '{"v":1,"pause":2,"tasks":[["t 1",3,1]]}\n');
    const floor = await VersionFloor.open(path);
    expect(floor.pause()).toBe(0);
    floor.sawTask("t-1", 1);
    await floor.save();
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ v: 1, tasks: [["t-1", 1, expect.any(Number)]] });
  });
});
