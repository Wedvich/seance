import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTaskProgressList } from "@seance/shared";
import {
  LaunchLedger,
  LEDGER_MAX,
  pathOwners,
  type NotedTask,
  LEDGER_MAX_AGE_MS,
  type TaskNote,
} from "./launch-ledger.ts";
import { OOM_REFRESH_MS } from "./oom-kill.ts";

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
    // Handlers go on in the same tick the writes start: `expect(p).rejects` may attach its own
    // only after an await, and a rejection nothing handles by then fails the whole file.
    const first = ledger.record("dup").then(
      () => null,
      (err: unknown) => ({ err }),
    );
    const second = ledger.record("dup").then(
      () => null,
      (err: unknown) => ({ err }),
    );
    const firstOutcome = await first;
    expect(firstOutcome).not.toBeNull();
    expect(ledger.ids()).toContain("dup");
    expect(await second).not.toBeNull();
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

  test("an exit status survives a reopen, reaches progress alone, and a relaunch starts without it", async () => {
    const ledger = await LaunchLedger.open(path, () => 9);
    await ledger.record("t1");
    await ledger.note("t1", { exit: 3 });
    expect(ledger.progress()).toEqual([{ taskId: "t1", at: 9, exit: 3 }]);

    const reopened = await LaunchLedger.open(path, () => 10);
    expect(reopened.progress()).toEqual([{ taskId: "t1", at: 9, exit: 3 }]);
    // A later note keeps it; a value no process exits with is not read back.
    await reopened.note("t1", { branch: "b" });
    expect(reopened.notes()[0]?.exit).toBe(3);
    const file = JSON.parse(await readFile(path, "utf8"));
    file.progress[0].exit = 256;
    await writeFile(path, JSON.stringify(file));
    expect((await LaunchLedger.open(path, () => 11)).notes()[0]).not.toHaveProperty("exit");

    await reopened.startNote("t1");
    expect(reopened.progress()).toEqual([]);
  });
});

describe("LaunchLedger OOM samples", () => {
  const unit = { cgroup: "/system.slice/seanced.service", kills: 42, at: 5, paneId: "%1", windowId: "@1" };

  test("a sample survives a reopen but stays out of progress, and changing it alone keeps at", async () => {
    let now = 5;
    const ledger = await LaunchLedger.open(path, () => now);
    await ledger.record("t1");
    await ledger.note("t1", { branch: "b" });
    now = 6;
    expect(await ledger.apply("t1", { oom: unit })).toBe("written");
    // Quiet pass: same reading a little later, no write.
    expect(await ledger.apply("t1", { oom: { ...unit, at: 6 } })).toBe("same");
    expect(await ledger.apply("t1", { oom: { ...unit, kills: 43, at: 6 } })).toBe("written");
    expect(ledger.progress()).toEqual([{ taskId: "t1", at: 5, branch: "b" }]);
    const reopened = await LaunchLedger.open(path, () => 7);
    expect(reopened.notes()[0]?.oom).toEqual({ ...unit, kills: 43, at: 6 });
    expect(reopened.notes()[0]?.at).toBe(5);
  });

  test("an unchanged sample is rewritten once stale, so its time stays inside the verdict's window", async () => {
    const ledger = await LaunchLedger.open(path, () => 5);
    await ledger.record("t1");
    await ledger.note("t1", { oom: unit });
    expect(await ledger.apply("t1", { oom: { ...unit, at: unit.at + OOM_REFRESH_MS } })).toBe("written");
    expect(ledger.notes()[0]?.oom?.at).toBe(unit.at + OOM_REFRESH_MS);
  });

  test("another pane's sample replaces it: a relaunch is not judged on the old pane's count", async () => {
    const ledger = await LaunchLedger.open(path, () => 5);
    await ledger.record("t1");
    await ledger.note("t1", { oom: unit });
    expect(await ledger.apply("t1", { oom: { ...unit, paneId: "%2", windowId: "@2" } })).toBe("written");
    expect(ledger.notes()[0]?.oom?.paneId).toBe("%2");
  });

  test("a batch persists once for every task's change, and not at all when nothing changed", async () => {
    const ledger = await LaunchLedger.open(path, () => 5);
    for (const id of ["t1", "t2", "t3"]) await ledger.record(id);
    const entries = ["t1", "t2", "t3"].map((taskId) => ({ taskId, patch: { oom: unit } }));
    await ledger.noteBatch([...entries, { taskId: "unknown", patch: { oom: unit } }]);
    const written = await readFile(path, "utf8");
    expect(JSON.parse(written).progress).toHaveLength(3);
    // Same content again: untouched on disk.
    await writeFile(path, "sentinel");
    await ledger.noteBatch(entries);
    expect(await readFile(path, "utf8")).toBe("sentinel");
  });

  test("the verdict reaches progress beside a SIGKILL only, and a bad sample or verdict is dropped, never the note", async () => {
    const ledger = await LaunchLedger.open(path, () => 9);
    await ledger.record("t1");
    await ledger.record("t2");
    await ledger.note("t1", { oom: unit });
    await ledger.note("t1", { exit: 137, oomKill: true });
    await ledger.note("t2", { exit: 1, oomKill: false });
    expect(ledger.progress()).toEqual([
      { taskId: "t1", at: 9, exit: 137, oomKill: true },
      { taskId: "t2", at: 9, exit: 1 },
    ]);
    expect(parseTaskProgressList(ledger.progress())).toEqual(ledger.progress());

    const file = JSON.parse(await readFile(path, "utf8"));
    // The list shape an earlier draft wrote reads as no sample.
    file.progress[0].oom = [unit];
    file.progress[0].oomKill = "yes";
    await writeFile(path, JSON.stringify(file));
    const [note] = (await LaunchLedger.open(path, () => 10)).notes();
    expect(note).toMatchObject({ taskId: "t1", exit: 137 });
    expect(note).not.toHaveProperty("oom");
    expect(note).not.toHaveProperty("oomKill");
  });

  test("a verdict stays for the same exit and goes with a different one", async () => {
    const ledger = await LaunchLedger.open(path, () => 9);
    await ledger.record("t1");
    await ledger.note("t1", { exit: 137, oomKill: true });
    // Another sample or progress note leaves it.
    await ledger.note("t1", { branch: "b" });
    expect(ledger.progress()[0]?.oomKill).toBe(true);
    // The same exit noted again without one (a racing pass whose judge read failed) keeps it.
    await ledger.note("t1", { exit: 137 });
    expect(ledger.progress()).toEqual([{ taskId: "t1", at: 9, branch: "b", exit: 137, oomKill: true }]);
    // Another exit clears it.
    await ledger.note("t1", { exit: 1 });
    expect(ledger.progress()).toEqual([{ taskId: "t1", at: 9, branch: "b", exit: 1 }]);
  });
});

describe("LaunchLedger reported notes (#21)", () => {
  test("a report survives a reopen, is sticky across later notes, reaches progress, and a relaunch starts without it", async () => {
    const ledger = await LaunchLedger.open(path, () => 9);
    await ledger.record("t1");
    expect(await ledger.note("t1", { reported: true })).toBe(true);
    expect(ledger.progress()).toEqual([{ taskId: "t1", at: 9, reported: true }]);
    expect(parseTaskProgressList(ledger.progress())).not.toBeNull();

    const reopened = await LaunchLedger.open(path, () => 10);
    expect(reopened.progress()).toEqual([{ taskId: "t1", at: 9, reported: true }]);
    await reopened.note("t1", { branch: "b" });
    expect(reopened.progress()).toEqual([{ taskId: "t1", at: 10, branch: "b", reported: true }]);

    await reopened.startNote("t1");
    expect(reopened.progress()).toEqual([]);
  });

  test("a report for an id never launched here is not noted, and a non-true value is not read back", async () => {
    const ledger = await LaunchLedger.open(path, () => 9);
    expect(await ledger.note("ghost", { reported: true })).toBe(false);
    await ledger.record("t1");
    await ledger.note("t1", { reported: true });
    const file = JSON.parse(await readFile(path, "utf8"));
    file.progress[0].reported = "yes";
    await writeFile(path, JSON.stringify(file));
    expect((await LaunchLedger.open(path, () => 11)).notes()[0]).not.toHaveProperty("reported");
  });

  test("apply says refused for an unknown id, written the first time, and same once the report is held", async () => {
    const ledger = await LaunchLedger.open(path, () => 9);
    expect(await ledger.apply("ghost", { reported: true })).toBe("refused");
    await ledger.record("t1");
    expect(await ledger.apply("t1", { reported: true })).toBe("written");
    expect(await ledger.apply("t1", { reported: true })).toBe("same");
  });

  test("apply says unwritten when the file cannot be written, with the note kept in memory", async () => {
    const ledger = await LaunchLedger.open(path, () => 9);
    await ledger.record("t1");
    // A directory where the file goes: the write fails, the record in memory stands.
    await rm(path, { force: true });
    await mkdir(path);
    expect(await ledger.apply("t1", { reported: true })).toBe("unwritten");
    expect(ledger.progress()).toEqual([{ taskId: "t1", at: 9, reported: true }]);
  });

  test("an older daemon's reader skips the unknown note field: the file keeps the pairs it reads", async () => {
    const ledger = await LaunchLedger.open(path, () => 9);
    await ledger.record("t1");
    await ledger.note("t1", { reported: true });
    const file = JSON.parse(await readFile(path, "utf8"));
    expect(file.tasks).toEqual([["t1", 9]]);
    expect(file.progress[0]).toMatchObject({ taskId: "t1", reported: true });
  });
});

describe("LaunchLedger vanished notes", () => {
  async function opened(clock: { now: number }): Promise<LaunchLedger> {
    const ledger = await LaunchLedger.open(path, () => clock.now);
    await ledger.record("t1");
    return ledger;
  }

  test("a here-mode launch with only a server still gets a note, and is unaccounted for", async () => {
    const clock = { now: 10 };
    const ledger = await opened(clock);
    expect(ledger.unaccounted()).toEqual([]);
    await ledger.startNote("t1", undefined, undefined, 4242);
    expect(ledger.unaccounted()).toEqual([{ taskId: "t1", recordedAt: 10, server: 4242 }]);
    // Neither the server nor anything else is progress.
    expect(ledger.progress()).toEqual([]);
  });

  test("vanished is noted, durable across a reopen, reaches progress, and moves at; server and closedHere never do", async () => {
    const clock = { now: 10 };
    const ledger = await opened(clock);
    await ledger.startNote("t1", undefined, undefined, 4242);
    const startedAt = ledger.notes()[0]?.at;
    clock.now = 20;
    expect(await ledger.note("t1", { closedHere: true })).toBe(true);
    expect(ledger.notes()[0]?.at).toBe(startedAt);
    expect(ledger.progress()).toEqual([]);
    // Closed here: never judged, and a second closedHere is no write.
    expect(ledger.unaccounted()).toEqual([]);
    expect(await ledger.noteVanished("t1", 10)).toBe(false);

    const second = await opened({ now: 30 });
    await second.record("t2");
    await second.startNote("t2", undefined, undefined, 4242);
    expect(await second.noteVanished("t2", 30)).toBe(true);
    expect(second.progress()).toEqual([expect.objectContaining({ taskId: "t2", vanished: true })]);
    expect(second.progress()[0]).not.toHaveProperty("server");
    expect(second.progress()[0]).not.toHaveProperty("closedHere");
    expect(await second.noteVanished("t2", 30)).toBe(false);

    const reopened = await LaunchLedger.open(path, () => 99);
    expect(reopened.progress()).toEqual([expect.objectContaining({ taskId: "t2", vanished: true })]);
    expect(reopened.unaccounted()).toEqual([]);
  });

  test("noteVanished is refused after an exit, for a relaunch, an unknown id, or a launch with no server; progress drops it once an exit is noted", async () => {
    const clock = { now: 10 };
    const ledger = await opened(clock);
    await ledger.startNote("t1", undefined, undefined, 7);
    expect(await ledger.noteVanished("t1", 999)).toBe(false);
    expect(await ledger.noteVanished("nope", 10)).toBe(false);
    // A relaunch moves the record time, so a candidate snapshotted before it is refused.
    clock.now = 50;
    await ledger.record("t1");
    expect(await ledger.noteVanished("t1", 10)).toBe(false);
    await ledger.startNote("t1", undefined, undefined, 7);
    await ledger.note("t1", { exit: 0 });
    expect(await ledger.noteVanished("t1", 50)).toBe(false);

    await ledger.record("t3");
    await ledger.startNote("t3", undefined, undefined, 7);
    expect(await ledger.noteVanished("t3", 50)).toBe(true);
    await ledger.note("t3", { exit: 2 });
    expect(ledger.progress().find((p) => p.taskId === "t3")).toEqual(expect.objectContaining({ exit: 2 }));
    expect(ledger.progress().find((p) => p.taskId === "t3")?.vanished).toBeUndefined();

    const bare = await opened({ now: 60 });
    await bare.record("t4");
    await bare.startNote("t4", { repo: "/r", path: "/r/wt" });
    expect(await bare.noteVanished("t4", 60)).toBe(false);
  });

  test("a file from before these fields parses, a malformed server or flag is dropped, and the wire parser accepts a vanished entry", async () => {
    await writeFile(
      path,
      JSON.stringify({
        v: 1,
        since: 1,
        tasks: [["t1", 5]],
        progress: [{ taskId: "t1", at: 5, branch: "b", server: -3, closedHere: "yes", vanished: 1 }],
      }),
    );
    const ledger = await LaunchLedger.open(path, () => 9);
    expect(ledger.notes()[0]).toEqual({ taskId: "t1", at: 5, branch: "b" });
    await ledger.note("t1", { vanished: true });
    expect(parseTaskProgressList(ledger.progress())).toEqual(ledger.progress());
  });
});

describe("pathOwners", () => {
  const note = (taskId: string, at: string | undefined, siteAt?: number): NotedTask => ({
    taskId,
    at: 0,
    ...(at === undefined ? {} : { path: at }),
    ...(siteAt === undefined ? {} : { siteAt }),
  });

  test("the newer site owns a path, whatever the order", () => {
    expect(pathOwners([note("a", "/p", 5), note("b", "/p", 3)]).get("/p")?.taskId).toBe("a");
    expect(pathOwners([note("b", "/p", 3), note("a", "/p", 5)]).get("/p")?.taskId).toBe("a");
  });

  test("a tie goes to the later note, and a missing siteAt counts as oldest", () => {
    expect(pathOwners([note("a", "/p", 5), note("b", "/p", 5)]).get("/p")?.taskId).toBe("b");
    expect(pathOwners([note("a", "/p", 1), note("b", "/p")]).get("/p")?.taskId).toBe("a");
  });

  test("notes without a path are skipped", () => {
    expect(pathOwners([note("a", undefined, 5)]).size).toBe(0);
  });
});
