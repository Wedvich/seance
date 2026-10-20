import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@seance/shared";
import { pollUntil } from "../test/fixtures.ts";
import { LaunchLedger } from "./launch-ledger.ts";
import { parseProcStatPpid, parsePsParents } from "./peer.ts";
import {
  createSessionEvents,
  ENDED_MAX,
  ENDED_TTL_MS,
  EndedTasks,
  parsePanePids,
  peerBindingProblem,
  parseSessionEventFrame,
  type BoundPane,
} from "./session-events.ts";

const frame = (fields: object): object => ({ v: 1, kind: "session-event", ...fields });

describe("parseSessionEventFrame", () => {
  test("keeps the fields it knows, drops the rest, and refuses a frame with nothing to report", () => {
    expect(parseSessionEventFrame(frame({ state: "busy", taskId: "x", session: "%9", pane: "%1" }))).toEqual({
      v: 1,
      kind: "session-event",
      state: "busy",
      pane: "%1",
    });
    expect(parseSessionEventFrame(frame({}))).toBeNull();
    expect(parseSessionEventFrame(frame({ state: "asleep" }))).toBeNull();
    // In the schema ahead of its act (#21): ingest refuses it as it did any unknown state.
    expect(parseSessionEventFrame(frame({ state: "done", pane: "%1" }))).toBeNull();
    expect(parseSessionEventFrame({ v: 2, kind: "session-event", state: "busy" })).toBeNull();
  });

  test("an older mod's rate-limit report is read as bare activity, its numbers never kept", () => {
    const legacy = frame({ rateLimits: [{ kind: "five_hour", percentUsed: 50 }], pane: "%1" });
    expect(parseSessionEventFrame(legacy)).toEqual({ v: 1, kind: "session-event", pane: "%1" });
    expect(parseSessionEventFrame(frame({ state: "idle", rateLimits: "junk" }))).toEqual({
      v: 1,
      kind: "session-event",
      state: "idle",
    });
  });
});

describe("activity", () => {
  const panes: readonly BoundPane[] = [
    { id: "%1", pid: 10, dead: false, taskId: null, path: "/home/u/work/repo" },
    { id: "%2", pid: 20, dead: false, taskId: "t1", path: "/home/u/repo" },
  ];
  const exclaves = [
    { id: "default", root: "/home/u", configDir: "/home/u/.claude", configFile: "/home/u/.claude.json" },
    { id: "work", root: "/home/u/work", configDir: "/home/u/.claude-work", configFile: "/x" },
  ];

  test("every bound event pokes its pane's exclave, task or not; an unbound one pokes nothing", async () => {
    const poked: string[] = [];
    const forwarded: SessionEvent[] = [];
    const events = createSessionEvents({
      panes: () => Promise.resolve(panes),
      exclaves: () => exclaves,
      forward: (event) => void forwarded.push(event),
      onActivity: (exclave) => void poked.push(exclave),
      ended: new EndedTasks(),
      coalesceMs: 0,
      hostNamesPeers: () => false,
    });
    try {
      expect(await events.handle(frame({ pane: "%1", rateLimits: [] }), null)).toEqual({ ok: true });
      expect(await events.handle(frame({ pane: "%2", state: "busy" }), null)).toEqual({ ok: true });
      expect(await events.handle(frame({ pane: "%9", state: "busy" }), null)).toEqual({ ok: false, code: "unbound" });
      expect(poked).toEqual(["work", "default"]);
      // The rate-limit report had no task and no state: nothing goes to the scheduler for it.
      expect(forwarded.map((e) => e.taskId)).toEqual(["t1"]);
    } finally {
      events.stop();
    }
  });
});

test("parsePanePids dedupes grouped panes, validates the task, and keeps a separator in the path", () => {
  const raw = ["%1|100|0|task-1|/a|b", "%1|100|0|task-1|/a|b", "%2|200|1||/c", "%3|300|0|bad task|/d", "junk"].join(
    "\n",
  );
  expect(parsePanePids(raw)).toEqual([
    { id: "%1", pid: 100, dead: false, taskId: "task-1", path: "/a|b" },
    { id: "%2", pid: 200, dead: true, taskId: null, path: "/c" },
    { id: "%3", pid: 300, dead: false, taskId: null, path: "/d" },
  ]);
});

test("parent parsing survives a comm with spaces and parens", () => {
  expect(parseProcStatPpid("123 (my (odd) proc) S 45 123 123 0")).toBe(45);
  expect(parsePsParents("  10     1\n 11 10\n")).toEqual(
    new Map([
      [10, 1],
      [11, 10],
    ]),
  );
});

describe("EndedTasks", () => {
  test("ended and launched-but-not-carried tasks report; one a session carries never does", async () => {
    const ended = new EndedTasks(
      LaunchLedger.memory(() => 5),
      () => 0,
    );
    ended.ended("a");
    for (const id of ["b", "c"]) await (await ended.launch(id))(true);
    expect(ended.report(new Set(["c"]))).toEqual({ ended: ["a", "b"], ledgerSince: 5 });
  });

  test("every landed launch starts the task's note afresh: a site notes it, `here` clears it", async () => {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    const site = { repo: "/r", worktree: "/r/.claude/worktrees/x" };
    await (
      await ended.launch("t1")
    )(true, { site });
    await ledger.note("t1", { branch: "worktree-x", ahead: true, pushed: true, prUrl: "https://x.test/1" });
    // The same id relaunched to the same path: nothing of the first attempt carries over.
    await (
      await ended.launch("t1")
    )(true, { site });
    expect(ledger.notes()).toEqual([expect.objectContaining({ taskId: "t1", repo: "/r", path: site.worktree })]);
    expect(ledger.notes()[0]).not.toHaveProperty("ahead");
    expect(ledger.notes()[0]).not.toHaveProperty("prUrl");
    await (
      await ended.launch("t1")
    )(true, {});
    expect(ledger.notes()).toEqual([]);
  });

  test("a launch that did not land keeps the earlier launch's note: not launched, a refusal that ran, or a crash", async () => {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    const site = { repo: "/r", worktree: "/r/.claude/worktrees/x" };
    await (
      await ended.launch("t1")
    )(true, { site });
    await ledger.note("t1", { branch: "worktree-x", ahead: true, pushed: true, prUrl: "https://x.test/1" });
    const before = ledger.notes();
    await (
      await ended.launch("t1")
    )(false);
    // `launched` without `landed`: task_running, or a crash.
    await (
      await ended.launch("t1")
    )(true);
    expect(ledger.notes()).toEqual(before);
  });

  test("a PR URL a session reports while its launch is in flight survives the fresh note", async () => {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    const site = { repo: "/r", worktree: "/r/.claude/worktrees/x" };
    await (
      await ended.launch("t1")
    )(true, { site });
    await ledger.note("t1", { prUrl: "https://x.test/old" });
    const settle = await ended.launch("t1");
    await ended.notePr("t1", "https://x.test/new");
    await settle(true, { site });
    expect(ledger.notes()).toEqual([
      expect.objectContaining({ taskId: "t1", path: site.worktree, prUrl: "https://x.test/new" }),
    ]);
    // Not carried to the next launch, which starts with none.
    await (
      await ended.launch("t1")
    )(true, { site });
    expect(ledger.notes()[0]).not.toHaveProperty("prUrl");
  });

  test("ended events are bounded by age and by count", () => {
    const clock = { now: 0 };
    const ended = new EndedTasks(LaunchLedger.memory(), () => clock.now);
    ended.ended("old");
    clock.now = ENDED_TTL_MS + 1;
    for (let i = 0; i <= ENDED_MAX; i++) ended.ended(`t${i}`);
    const report = ended.report(new Set()).ended;
    expect(report).toHaveLength(ENDED_MAX);
    expect(report).not.toContain("old");
    expect(report).not.toContain("t0");
  });

  test("a launch that never ran leaves the ledger; task_running's earlier launch stays", async () => {
    const ended = new EndedTasks(LaunchLedger.memory());
    await (
      await ended.launch("refused")
    )(false);
    await (
      await ended.launch("dup")
    )(true);
    await (
      await ended.launch("dup")
    )(false);
    expect(ended.report(new Set()).ended).toEqual(["dup"]);
  });

  // A duplicate dispatch: two spawns of one task id at once. Only the first
  // finds the id unrecorded; whichever fails, the one that ran stays.
  test("two launches of one id in flight: one that failed never retracts one that ran, in either order", async () => {
    for (const failedFirst of [true, false]) {
      const ended = new EndedTasks(LaunchLedger.memory());
      const [a, b] = await Promise.all([ended.launch("dup"), ended.launch("dup")]);
      if (failedFirst) {
        await a(false);
        await b(true);
      } else {
        await b(true);
        await a(false);
      }
      expect(ended.report(new Set()).ended).toEqual(["dup"]);
    }
    const ended = new EndedTasks(LaunchLedger.memory());
    const [a, b] = await Promise.all([ended.launch("none"), ended.launch("none")]);
    await a(false);
    await b(false);
    expect(ended.report(new Set()).ended).toEqual([]);
  });

  test("settled waits for every launch in flight, one begun while waiting included", async () => {
    const ended = new EndedTasks(LaunchLedger.memory());
    const first = await ended.launch("a");
    let done = false;
    const waiting = (async () => {
      await ended.settled();
      done = true;
    })();
    const second = ended.launch("b");
    await first(true);
    await Bun.sleep(0);
    expect(done).toBe(false);
    await (
      await second
    )(true);
    await waiting;
    expect(done).toBe(true);
  });

  test("a ledger that cannot record refuses the launch and holds nothing back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seance-ledger-"));
    try {
      // A directory where the file should be: every write fails.
      const path = join(dir, "launched.json");
      await mkdir(join(path, "x"), { recursive: true });
      const ended = new EndedTasks(await LaunchLedger.open(path));
      await expect(ended.launch("t1")).rejects.toThrow();
      await ended.settled();
      expect(ended.report(new Set()).ended).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("peer binding probe", () => {
  // The fd is a field Bun leaves undocumented; this is the check an upgrade that drops it fails.
  test("on this runtime a self-connect yields an fd and the kernel names this process", async () => {
    expect(await peerBindingProblem()).toBeNull();
  });
});

describe("coalescing", () => {
  const pane: BoundPane = { id: "%1", pid: 10, dead: false, taskId: "t1", path: "/home" };

  function setup(coalesceMs: number) {
    const forwarded: SessionEvent[] = [];
    const events = createSessionEvents({
      panes: () => Promise.resolve([pane]),
      exclaves: () => [],
      forward: (event) => void forwarded.push(event),
      ended: new EndedTasks(),
      coalesceMs,
      // A host that names no peer: the fallback binding, by the frame's own pane.
      hostNamesPeers: () => false,
    });
    const send = (fields: object): Promise<unknown> => events.handle(frame({ pane: "%1", ...fields }), null);
    return { forwarded, events, send };
  }

  test("one event goes at once; a burst after it folds into one, newest state, earlier PR URL kept", async () => {
    const { forwarded, events, send } = setup(150);
    try {
      await send({ state: "busy" });
      expect(forwarded.map((e) => e.state)).toEqual(["busy"]);
      await send({ state: "idle", prUrl: "https://github.com/a/b/pull/1" });
      await send({ state: "busy" });
      await send({ state: "needs-input" });
      expect(forwarded).toHaveLength(1);
      await pollUntil(() => forwarded.length === 2, "the folded event");
      expect(forwarded.map((e) => [e.state, e.prUrl])).toEqual([
        ["busy", undefined],
        ["needs-input", "https://github.com/a/b/pull/1"],
      ]);
    } finally {
      events.stop();
    }
  });

  test("stop cancels a pending send", async () => {
    const { forwarded, events, send } = setup(100);
    await send({ state: "busy" });
    await send({ state: "idle" });
    events.stop();
    await Bun.sleep(200); // past the window: a non-event can't be polled
    expect(forwarded).toHaveLength(1);
  });
});

describe("the PR URL is kept for the scheduler's progress", () => {
  function setup(taskId: string) {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    const pane: BoundPane = { id: "%1", pid: 10, dead: false, taskId, path: "/home" };
    const events = createSessionEvents({
      panes: () => Promise.resolve([pane]),
      exclaves: () => [],
      forward: () => {},
      ended,
      coalesceMs: 0,
      hostNamesPeers: () => false,
    });
    const send = (fields: object): Promise<unknown> => events.handle(frame({ pane: "%1", ...fields }), null);
    return { ledger, ended, events, send };
  }

  test("an https URL for a launched task is recorded", async () => {
    const { ledger, ended, events, send } = setup("t1");
    try {
      await ledger.record("t1");
      await send({ state: "idle", prUrl: "https://github.com/a/b/pull/1" });
      await pollUntil(() => ended.progress().length === 1, "the PR URL in progress");
      expect(ended.progress()).toEqual([
        { taskId: "t1", at: expect.any(Number), prUrl: "https://github.com/a/b/pull/1" },
      ]);
    } finally {
      events.stop();
    }
  });

  test("an http URL, a malformed one, and one for a task never launched here are not", async () => {
    const { ledger, ended, events, send } = setup("t1");
    const stranger = setup("ghost");
    try {
      await ledger.record("t1");
      await send({ state: "idle", prUrl: "http://github.com/a/b/pull/1" });
      await send({ state: "idle", prUrl: "not a url" });
      await stranger.send({ state: "idle", prUrl: "https://github.com/a/b/pull/2" });
      await Bun.sleep(30); // a non-event can't be polled
      expect(ended.progress()).toEqual([]);
      expect(stranger.ended.progress()).toEqual([]);
    } finally {
      events.stop();
      stranger.events.stop();
    }
  });
});
