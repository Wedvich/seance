import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTaskProgressList } from "@seance/shared";
import { LaunchLedger, LEDGER_MAX, LEDGER_MAX_AGE_MS, type TaskNote } from "./launch-ledger.ts";

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
    // Both handled before any await: `second` can reject before `first`'s await
    // returns, and an unhandled rejection fails the test whatever it asserts.
    const firstRejects = expect(first).rejects.toThrow();
    const secondRejects = expect(second).rejects.toThrow();
    await firstRejects;
    expect(ledger.ids()).toContain("dup");
    await secondRejects;
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

describe("LaunchLedger progress notes", () => {
  const TIP = "a".repeat(40);

  test("a literal v1 file opens with the same since and ids and no notes", async () => {
    await writeFile(path, '{"v":1,"since":1234,"tasks":[["t1",2000],["t2",3000]]}\n');
    const ledger = await LaunchLedger.open(path, () => 5_000);
    expect(ledger.since()).toBe(1234);
    expect(ledger.ids()).toEqual(["t1", "t2"]);
    expect(ledger.notes()).toEqual([]);
    expect(ledger.progress()).toEqual([]);
  });

  test("an untouched ledger writes plain v1; a note adds only a top-level progress array", async () => {
    const ledger = await LaunchLedger.open(path, () => 100);
    await ledger.record("t1");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ v: 1, since: 100, tasks: [["t1", 100]] });
    await ledger.note("t1", { repo: "/r", path: "/r/.claude/worktrees/x", branch: "worktree-x" });
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(raw).toMatchObject({ v: 1, since: 100, tasks: [["t1", 100]] });
    expect(raw).toHaveProperty("progress");
  });

  test("a note survives a reopen, and the file keeps the pairs an older daemon reads", async () => {
    const clock = { now: 100 };
    const ledger = await LaunchLedger.open(path, () => clock.now);
    await ledger.record("t1");
    clock.now = 200;
    await ledger.note("t1", { repo: "/r", path: "/w", branch: "worktree-x", tip: TIP, ahead: true, pushed: true });
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(raw).toMatchObject({ v: 1, tasks: [["t1", 100]] });

    const reopened = await LaunchLedger.open(path, () => 300);
    expect(reopened.notes()).toEqual([
      {
        taskId: "t1",
        at: 200,
        siteAt: 200,
        repo: "/r",
        path: "/w",
        branch: "worktree-x",
        tip: TIP,
        ahead: true,
        pushed: true,
      },
    ]);
  });

  test("siteAt is read leniently: a note without one, or with a bad one, is the oldest, never dropped", async () => {
    const file = {
      v: 1,
      since: 1,
      tasks: [
        ["a", 10],
        ["b", 20],
        ["c", 30],
      ],
      progress: [
        { taskId: "a", at: 5, path: "/w" },
        { taskId: "b", at: 6, path: "/w", siteAt: "later" },
        { taskId: "c", at: 7, path: "/w", siteAt: 9 },
      ],
    };
    await writeFile(path, JSON.stringify(file));
    const notes = (await LaunchLedger.open(path, () => 100)).notes();
    expect(notes.map((n) => [n.taskId, n.siteAt])).toEqual([
      ["a", undefined],
      ["b", undefined],
      ["c", 9],
    ]);
  });

  test("malformed progress entries are skipped, never the ledger", async () => {
    const good = { taskId: "t1", at: 5, branch: "worktree-x", pushed: true };
    const file = {
      v: 1,
      since: 77,
      tasks: [
        ["t1", 10],
        ["t2", 20],
      ],
      progress: [
        good,
        { taskId: "t2", at: 6, branch: "" },
        { taskId: "ghost", at: 7, branch: "b" },
        { taskId: "t2", at: 8, prUrl: "http://example.com/pr/1" },
        { taskId: "t2", at: 9, pushed: false, merged: "yes", tip: "nothex" },
        "junk",
        { taskId: "t1", at: Number.NaN },
      ],
    };
    await writeFile(path, JSON.stringify(file));
    const ledger = await LaunchLedger.open(path, () => 100);
    expect(ledger.since()).toBe(77);
    expect(ledger.ids()).toEqual(["t1", "t2"]);
    // A bad field drops, so a t2 entry survives as a bare note; none carries a bad value.
    const notes = ledger.notes();
    expect(notes.find((n) => n.taskId === "t1")).toMatchObject(good);
    expect(notes.some((n) => n.taskId === "ghost")).toBe(false);
    for (const note of notes) {
      expect(note.branch).not.toBe("");
      expect(note.prUrl).toBeUndefined();
      expect(note.tip).toBeUndefined();
      expect(note.merged).toBeUndefined();
    }
    expect(ledger.progress().every((entry) => entry.taskId === "t1")).toBe(true);

    await writeFile(path, JSON.stringify({ ...file, progress: "not an array" }));
    const ignored = await LaunchLedger.open(path, () => 100);
    expect(ignored.since()).toBe(77);
    expect(ignored.notes()).toEqual([]);
  });

  test("note on an unknown id writes nothing", async () => {
    const ledger = await LaunchLedger.open(path, () => 1);
    await ledger.note("ghost", { branch: "b" });
    expect(ledger.notes()).toEqual([]);
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  test("eviction and retract remove the note", async () => {
    const clock = { now: 0 };
    const ledger = await LaunchLedger.open(path, () => clock.now);
    clock.now = 10;
    await ledger.record("old");
    await ledger.note("old", { branch: "a" });
    clock.now = 20;
    await ledger.record("gone");
    await ledger.note("gone", { branch: "b" });
    await ledger.retract("gone");
    expect(ledger.notes().map((n) => n.taskId)).toEqual(["old"]);
    expect(JSON.stringify(JSON.parse(await readFile(path, "utf8")))).not.toContain('"gone"');
    clock.now = 10 + LEDGER_MAX_AGE_MS + 1;
    expect(ledger.notes()).toEqual([]);
  });

  test("a new path replaces the note; pushed, merged and ahead never clear; an unchanged note keeps its at", async () => {
    const clock = { now: 1 };
    const ledger = await LaunchLedger.open(path, () => clock.now);
    await ledger.record("t1");
    await ledger.note("t1", {
      repo: "/r",
      path: "/w1",
      branch: "a",
      pushed: true,
      ahead: true,
      prUrl: "https://x.test/1",
    });
    clock.now = 2;
    await ledger.note("t1", { branch: "b", tip: TIP });
    expect(ledger.notes()[0]).toMatchObject({
      branch: "b",
      pushed: true,
      ahead: true,
      prUrl: "https://x.test/1",
      at: 2,
    });
    clock.now = 3;
    await ledger.note("t1", { branch: "b", tip: TIP });
    expect(ledger.notes()[0]?.at).toBe(2);

    clock.now = 4;
    await ledger.note("t1", { repo: "/r", path: "/w2" });
    expect(ledger.notes()[0]).toEqual({ taskId: "t1", at: 4, siteAt: 4, repo: "/r", path: "/w2" });
    // The site's age survives later changes: ownership of a path goes by it.
    clock.now = 6;
    await ledger.note("t1", { branch: "c" });
    expect(ledger.notes()[0]).toMatchObject({ at: 6, siteAt: 4 });
  });

  test("a landed relaunch starts the note afresh, to the same path or none, and only for a launched id", async () => {
    const ledger = await LaunchLedger.open(path, () => 5);
    await ledger.record("t1");
    const worked: TaskNote = {
      repo: "/r",
      path: "/w",
      branch: "b",
      tip: TIP,
      ahead: true,
      pushed: true,
      prUrl: "https://x.test/1",
    };
    await ledger.note("t1", worked);
    await ledger.startNote("t1", { repo: "/r", path: "/w" });
    expect(ledger.notes()).toEqual([{ taskId: "t1", at: 5, siteAt: 5, repo: "/r", path: "/w" }]);

    await ledger.note("t1", worked);
    await ledger.startNote("t1");
    expect(ledger.notes()).toEqual([]);
    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("progress");

    // A PR URL its session reported while the spawn ran is the new launch's, whatever the old note said.
    await ledger.note("t1", worked);
    await ledger.startNote("t1", { repo: "/r", path: "/w" }, "https://x.test/2");
    expect(ledger.notes()).toEqual([
      { taskId: "t1", at: 5, siteAt: 5, repo: "/r", path: "/w", prUrl: "https://x.test/2" },
    ]);
    await ledger.startNote("t1", undefined, "https://x.test/3");
    expect(ledger.notes()).toEqual([{ taskId: "t1", at: 5, prUrl: "https://x.test/3" }]);
    await ledger.startNote("t1");
    expect(ledger.notes()).toEqual([]);

    await ledger.startNote("ghost", { repo: "/r", path: "/w" });
    expect(ledger.notes()).toEqual([]);
  });

  test("a patch pinned to a launch is refused once a relaunch moved siteAt", async () => {
    let clock = 5;
    const ledger = await LaunchLedger.open(path, () => clock);
    await ledger.record("t1");
    await ledger.startNote("t1", { repo: "/r", path: "/w" });
    clock = 9;
    await ledger.startNote("t1", { repo: "/r", path: "/w" });
    expect(await ledger.note("t1", { branch: "old", pushed: true }, { siteAt: 5 })).toBe(false);
    expect(ledger.notes()).toEqual([{ taskId: "t1", at: 9, siteAt: 9, repo: "/r", path: "/w" }]);
    expect(await ledger.note("t1", { branch: "new" }, { siteAt: 9 })).toBe(true);
    expect(ledger.notes()[0]?.branch).toBe("new");
    expect(await ledger.note("ghost", { branch: "x" })).toBe(false);
  });

  test("a failed write resolves, and the note stays in memory", async () => {
    const ledger = await LaunchLedger.open(path, () => 1);
    await ledger.record("t1");
    await rm(path);
    // A directory where the file should be: the rename fails.
    await mkdir(join(path, "x"), { recursive: true });
    await ledger.note("t1", { branch: "kept" });
    expect(ledger.notes()[0]?.branch).toBe("kept");
    expect(ledger.ids()).toEqual(["t1"]);
  });

  test("progress strips repo and path, omits empty notes and passes the leader's parser", async () => {
    const ledger = await LaunchLedger.open(path, () => 9);
    for (const id of ["a", "b", "c"]) await ledger.record(id);
    await ledger.note("a", { repo: "/r", path: "/w", tip: TIP, ahead: true });
    await ledger.note("b", { repo: "/r", path: "/w2", branch: "worktree-b", pushed: true, merged: true, tip: TIP });
    await ledger.note("c", { prUrl: "https://example.com/pr/3" });
    const progress = ledger.progress();
    expect(progress).toEqual([
      { taskId: "b", at: 9, branch: "worktree-b", pushed: true, merged: true },
      { taskId: "c", at: 9, prUrl: "https://example.com/pr/3" },
    ]);
    expect(parseTaskProgressList(progress)).not.toBeNull();
  });
});
