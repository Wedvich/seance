import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSIONS_MAX_PROGRESS, type SessionEvent } from "@seance/shared";
import { pollUntil } from "../test/fixtures.ts";
import { LaunchLedger, LEDGER_MAX } from "./launch-ledger.ts";
import { parseProcStatPpid, parsePsParents } from "./peer.ts";
import {
  createSessionEvents,
  ENDED_MAX,
  ENDED_TTL_MS,
  EndedTasks,
  LaunchesClosed,
  parsePanePids,
  peerBindingProblem,
  parseSessionEventFrame,
  type BoundPane,
} from "./session-events.ts";

const frame = (fields: object): object => ({ v: 1, kind: "session-event", ...fields });
const SESSION = "0b6e1c52-3f0d-4a8e-9c7b-2d5f4e6a1b90";

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
    expect(parseSessionEventFrame(frame({ state: "done", pane: "%1" }))).toEqual({
      v: 1,
      kind: "session-event",
      state: "done",
      pane: "%1",
    });
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

  test("continuation says where a launch ran, or why it cannot be continued", async () => {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    expect(ended.continuation("unknown")).toEqual({ refused: expect.stringContaining("holds no launch") });
    // Launched, not yet settled: its site is not known and a second spawn must not race it.
    const settle = await ended.launch("flying");
    expect(ended.continuation("flying")).toEqual({ refused: expect.stringContaining("still in flight") });
    await settle(true);
    expect(ended.continuation("flying")).toEqual({ refused: expect.stringContaining("no worktree of it was noted") });
    await ledger.record("landed");
    await ledger.note("landed", { repo: "/r", path: "/r/.claude/worktrees/x", session: SESSION });
    expect(ended.continuation("landed")).toEqual({ repo: "/r", path: "/r/.claude/worktrees/x", session: SESSION });
  });

  test("the newest note on a path owns it: an older task is refused, naming the newer", async () => {
    const clock = { now: 1000 };
    const ledger = LaunchLedger.memory(() => clock.now);
    const ended = new EndedTasks(ledger);
    const path = "/r/.claude/worktrees/x";
    await ledger.record("old");
    await ledger.note("old", { repo: "/r", path, session: SESSION, exit: 137 });
    clock.now += 10;
    await ledger.record("new");
    await ledger.note("new", { repo: "/r", path, session: SESSION });
    const refused = ended.continuation("old");
    expect(refused).toEqual({ refused: expect.stringContaining("new") });
    expect(refused).toEqual({ refused: expect.stringContaining(path) });
    expect(ended.continuation("new")).toEqual({ repo: "/r", path, session: SESSION });
  });

  test("an equal site time goes to the later launch", async () => {
    const ledger = LaunchLedger.memory(() => 1000);
    const ended = new EndedTasks(ledger);
    const path = "/r/.claude/worktrees/x";
    for (const id of ["first", "second"]) {
      // oxlint-disable-next-line no-await-in-loop -- ledger order is the point
      await ledger.record(id);
      // oxlint-disable-next-line no-await-in-loop
      await ledger.note(id, { repo: "/r", path, session: SESSION });
    }
    expect(ended.continuation("first")).toEqual({ refused: expect.stringContaining("second") });
    expect(ended.continuation("second")).toEqual({ repo: "/r", path, session: SESSION });
  });

  test("a landed launch's session id is noted, and a continuation of it notes the same id", async () => {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    const worktree = "/r/.claude/worktrees/x";
    await (
      await ended.launch("first")
    )(true, { site: { repo: "/r", worktree, session: SESSION } });
    const site = ended.continuation("first");
    expect(site).toEqual({ repo: "/r", path: worktree, session: SESSION });
    if ("refused" in site) throw new Error("unreachable");
    // What the handler settles a continuation with: the session it resumed, not a new one.
    await (
      await ended.launch("second")
    )(true, { site: { repo: "/r", worktree, session: site.session } });
    expect(ended.continuation("second")).toEqual({ repo: "/r", path: worktree, session: SESSION });
    expect(ended.continuation("first")).toEqual({ refused: expect.stringContaining("second") });
  });

  test("a worktree noted without a session id (an older daemon's) is refused, never resumed by --continue", async () => {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    await ledger.record("old");
    await ledger.note("old", { repo: "/r", path: "/r/.claude/worktrees/x", exit: 137 });
    expect(ended.continuation("old")).toEqual({
      refused: expect.stringContaining("before this daemon noted session ids"),
    });
  });

  test("the old note's exit is carried, for wording only", async () => {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    await ledger.record("dead");
    await ledger.note("dead", { repo: "/r", path: "/r/.claude/worktrees/x", session: SESSION, exit: 137 });
    expect(ended.continuation("dead")).toEqual({
      repo: "/r",
      path: "/r/.claude/worktrees/x",
      session: SESSION,
      exit: 137,
    });
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

describe("EndedTasks interrupted launches and the drain", () => {
  async function inTmp(run: (path: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "seance-interrupted-"));
    try {
      await run(join(dir, "launched.json"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const fileOf = async (path: string): Promise<{ pending?: string[]; interrupted?: string[] }> =>
    JSON.parse(await readFile(path, "utf8"));

  /** Neither mark on disk: the file a restart reads back as no interrupted launch. */
  const markless = async (path: string): Promise<boolean> => {
    const file = await fileOf(path);
    return file.pending === undefined && file.interrupted === undefined;
  };

  /** A process that began a launch and died before it settled, then a new one on the same file. */
  async function afterCrash(path: string, id: string): Promise<EndedTasks> {
    await new EndedTasks(await LaunchLedger.open(path)).launch(id);
    return new EndedTasks(await LaunchLedger.open(path));
  }

  const paneEvents = (ended: EndedTasks, pane: BoundPane): ReturnType<typeof createSessionEvents> =>
    createSessionEvents({
      panes: () => Promise.resolve([pane]),
      exclaves: () => [],
      forward: () => {},
      ended,
      coalesceMs: 0,
      hostNamesPeers: () => false,
    });

  test("a launch with no settle reports interrupted, beside ended, after a restart", async () => {
    await inTmp(async (path) => {
      const restarted = await afterCrash(path, "t1");
      expect(restarted.report(new Set())).toMatchObject({ ended: ["t1"], interrupted: ["t1"] });
    });
  });

  test("a session carrying it omits it and clears the mark on disk", async () => {
    await inTmp(async (path) => {
      const restarted = await afterCrash(path, "t1");
      expect(restarted.report(new Set(["t1"]))).not.toHaveProperty("interrupted");
      await pollUntil(() => markless(path), "the mark cleared on disk");
      expect((await LaunchLedger.open(path)).interrupted()).toEqual([]);
    });
  });

  test("the gate's state is visible and each change heard once; a final drain is never heard reopening", async () => {
    const ended = new EndedTasks();
    const heard: boolean[] = [];
    const unsubscribe = ended.onGate((closed) => heard.push(closed));
    expect(ended.draining).toBe(false);
    ended.reopen();
    expect(await ended.drain(1_000)).toBe(true);
    expect(await ended.drain(1_000)).toBe(true);
    expect(ended.draining).toBe(true);
    ended.reopen();
    expect(ended.draining).toBe(false);
    expect(heard).toEqual([true, false]);

    await ended.drain(1_000, { final: true });
    ended.reopen();
    expect(ended.draining).toBe(true);
    expect(heard).toEqual([true, false, true]);

    unsubscribe();
    const fresh = new EndedTasks();
    const off = fresh.onGate((closed) => heard.push(closed));
    off();
    await fresh.drain(1_000);
    expect(heard).toEqual([true, false, true]);
  });

  test("a throwing gate listener neither stops the drain nor the listeners after it", async () => {
    const ended = new EndedTasks();
    const heard: boolean[] = [];
    ended.onGate(() => {
      throw new Error("listener broke");
    });
    ended.onGate((closed) => heard.push(closed));
    expect(await ended.drain(1_000)).toBe(true);
    expect(heard).toEqual([true]);
    await expect(ended.launch("t1")).rejects.toBeInstanceOf(LaunchesClosed);
  });

  test("drain resolves true only once the launch in flight settled, its pending clear on disk by then", async () => {
    await inTmp(async (path) => {
      const ended = new EndedTasks(await LaunchLedger.open(path));
      const settle = await ended.launch("t1");
      expect((await fileOf(path)).pending).toEqual(["t1"]);
      let drained: boolean | null = null;
      const draining = ended.drain(10_000).then((ok) => (drained = ok));
      await Bun.sleep(20); // a non-event can't be polled
      expect(drained).toBeNull();
      await settle(true, {});
      expect(await draining).toBe(true);
      expect(await fileOf(path)).not.toHaveProperty("pending");
    });
  });

  test("a launch after drain is refused unrecorded, and settled does not wait for it", async () => {
    await inTmp(async (path) => {
      const ended = new EndedTasks(await LaunchLedger.open(path));
      expect(await ended.drain(1_000)).toBe(true);
      await expect(ended.launch("late")).rejects.toBeInstanceOf(LaunchesClosed);
      await ended.settled();
      expect(ended.launched("late")).toBe(false);
      await expect(readFile(path, "utf8")).rejects.toThrow();
    });
  });

  test("a launch begun before drain still records, runs and is waited for", async () => {
    const ended = new EndedTasks();
    const settle = await ended.launch("t1");
    const draining = ended.drain(10_000);
    await settle(true, {});
    expect(await draining).toBe(true);
    expect(ended.launched("t1")).toBe(true);
  });

  test("reopen takes launches again", async () => {
    const ended = new EndedTasks();
    await ended.drain(1_000);
    ended.reopen();
    await (
      await ended.launch("t1")
    )(true, {});
    expect(ended.launched("t1")).toBe(true);
  });

  test("drain returns false at its timeout, with the launch still in flight", async () => {
    const ended = new EndedTasks();
    const settle = await ended.launch("t1");
    expect(await ended.drain(20)).toBe(false);
    await settle(true, {});
    await ended.settled();
  });

  test("drain waits for a held reply after the launch settled, but settled() does not", async () => {
    const ended = new EndedTasks();
    const settle = await ended.launch("t1");
    const release = ended.hold();
    await settle(true, {});
    await ended.settled(); // what the handler's own `sessionsAfter` waits on: must not wait for the reply
    let drained: boolean | null = null;
    const draining = ended.drain(10_000).then((ok) => (drained = ok));
    await Bun.sleep(20); // a non-event can't be polled
    expect(drained).toBeNull();
    release();
    release(); // idempotent
    expect(await draining).toBe(true);
  });

  test("drain times out on a reply never handed over", async () => {
    const ended = new EndedTasks();
    ended.hold();
    expect(await ended.drain(20)).toBe(false);
  });

  test("a final drain cannot be reopened; a plain one can", async () => {
    const ended = new EndedTasks();
    await ended.drain(1_000, { final: true });
    ended.reopen();
    await expect(ended.launch("late")).rejects.toBeInstanceOf(LaunchesClosed);

    const plain = new EndedTasks();
    await plain.drain(1_000);
    await expect(plain.launch("held")).rejects.toBeInstanceOf(LaunchesClosed);
    plain.reopen();
    await (
      await plain.launch("later")
    )(true, {});
    expect(plain.report(new Set())).toMatchObject({ ended: ["later"] });
  });

  test("a crash with no verdict marks the launch interrupted on disk; a refusal and a landed launch do not", async () => {
    await inTmp(async (path) => {
      const ended = new EndedTasks(await LaunchLedger.open(path));
      await (
        await ended.launch("crashed")
      )(true, undefined, { unknown: true });
      expect(await fileOf(path)).toMatchObject({ interrupted: ["crashed"] });
      expect(await fileOf(path)).not.toHaveProperty("pending");
      expect(ended.report(new Set())).toMatchObject({ ended: ["crashed"], interrupted: ["crashed"] });
      await (
        await ended.launch("running")
      )(true); // task_running: an earlier launch's session stands
      await (
        await ended.launch("landed")
      )(true, {});
      expect((await fileOf(path)).interrupted).toEqual(["crashed"]);
      // A fresh id whose launch never ran is still retracted, not marked.
      await (
        await ended.launch("refused")
      )(false);
      expect(ended.launched("refused")).toBe(false);
      expect((await fileOf(path)).interrupted).toEqual(["crashed"]);
      // A restart reads the mark back as interrupted, and a later landed launch of the id clears it.
      const restarted = new EndedTasks(await LaunchLedger.open(path));
      expect(restarted.report(new Set())).toMatchObject({ interrupted: ["crashed"] });
      await (
        await restarted.launch("crashed")
      )(true, {});
      expect(restarted.report(new Set())).not.toHaveProperty("interrupted");
    });
  });

  test("the ledger never holds more ids than a sessions reply may name as interrupted", () => {
    // `report` slices to the cap as well, but `parseInterrupted` drops the whole list past it, so a raise of
    // LEDGER_MAX alone would silently turn every interrupted launch back into `done`.
    expect(LEDGER_MAX).toBeLessThanOrEqual(SESSIONS_MAX_PROGRESS);
  });

  test("a bound ended event from the pane of an interrupted task clears its mark", async () => {
    await inTmp(async (path) => {
      const restarted = await afterCrash(path, "t1");
      const events = paneEvents(restarted, { id: "%1", pid: 10, dead: false, taskId: "t1", path: "/home" });
      try {
        await events.handle(frame({ pane: "%1", state: "ended" }), null);
        await pollUntil(() => restarted.ledger.interrupted().length === 0, "the mark cleared");
        await pollUntil(() => markless(path), "the clear on disk");
      } finally {
        events.stop();
      }
    });
  });

  test("a bound busy or stateless event leaves the mark: a live session is cleared by the listing", async () => {
    await inTmp(async (path) => {
      const restarted = await afterCrash(path, "t1");
      const events = paneEvents(restarted, { id: "%1", pid: 10, dead: false, taskId: "t1", path: "/home" });
      try {
        await events.handle(frame({ pane: "%1", state: "busy" }), null);
        await events.handle(frame({ pane: "%1" }), null);
        await Bun.sleep(30); // a non-event can't be polled
        expect(restarted.ledger.interrupted()).toEqual(["t1"]);
      } finally {
        events.stop();
      }
    });
  });

  test("an ended event after the ingest stopped leaves the mark", async () => {
    await inTmp(async (path) => {
      const restarted = await afterCrash(path, "t1");
      const events = paneEvents(restarted, { id: "%1", pid: 10, dead: false, taskId: "t1", path: "/home" });
      events.stop();
      await events.handle(frame({ pane: "%1", state: "ended" }), null);
      await Bun.sleep(30); // a non-event can't be polled
      expect(restarted.ledger.interrupted()).toEqual(["t1"]);
    });
  });

  test("an unbound event, and one from another task's pane, clear nothing", async () => {
    await inTmp(async (path) => {
      const restarted = await afterCrash(path, "t1");
      const events = paneEvents(restarted, { id: "%2", pid: 20, dead: false, taskId: "other", path: "/home" });
      try {
        await events.handle(frame({ pane: "%9", state: "ended" }), null);
        await events.handle(frame({ pane: "%2", state: "ended" }), null);
        await Bun.sleep(30); // a non-event can't be polled
        expect(restarted.ledger.interrupted()).toEqual(["t1"]);
      } finally {
        events.stop();
      }
    });
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

describe("a session's done report (#21)", () => {
  const tasked: BoundPane = { id: "%1", pid: 10, dead: false, taskId: "t1", path: "/home" };
  const bare: BoundPane = { id: "%2", pid: 20, dead: false, taskId: null, path: "/home" };

  function setup(coalesceMs = 0, ledger = LaunchLedger.memory()) {
    const ended = new EndedTasks(ledger);
    const forwarded: SessionEvent[] = [];
    const events = createSessionEvents({
      panes: () => Promise.resolve([tasked, bare]),
      exclaves: () => [],
      forward: (event) => void forwarded.push(event),
      ended,
      coalesceMs,
      hostNamesPeers: () => false,
    });
    const send = (pane: string, fields: object): Promise<unknown> => events.handle(frame({ pane, ...fields }), null);
    return { ledger, ended, forwarded, events, send };
  }

  test("a tasked pane's report is on disk before the reply, and forwarded", async () => {
    const { ledger, ended, forwarded, events, send } = setup();
    try {
      await ledger.record("t1");
      expect(await send("%1", { state: "done" })).toEqual({ ok: true });
      expect(ended.progress()).toEqual([{ taskId: "t1", at: expect.any(Number), reported: true }]);
      expect(forwarded.map((e) => [e.taskId, e.state])).toEqual([["t1", "done"]]);
    } finally {
      events.stop();
    }
  });

  test("a task-less pane is told untasked, and nothing is forwarded", async () => {
    const { forwarded, events, send } = setup();
    try {
      expect(await send("%2", { state: "done" })).toEqual({ ok: false, code: "untasked" });
      expect(await send("%9", { state: "done" })).toEqual({ ok: false, code: "unbound" });
      expect(forwarded).toEqual([]);
    } finally {
      events.stop();
    }
  });

  test("a task's report is forwarded once: a repeat is told ok and sends nothing", async () => {
    const { ledger, forwarded, events, send } = setup();
    try {
      await ledger.record("t1");
      expect(await send("%1", { state: "done" })).toEqual({ ok: true });
      expect(await send("%1", { state: "done" })).toEqual({ ok: true });
      expect(forwarded.map((e) => e.state)).toEqual(["done"]);
    } finally {
      events.stop();
    }
  });

  test("a report for a task the ledger holds no launch of is refused unrecorded and sent nowhere", async () => {
    const { ended, forwarded, events, send } = setup();
    try {
      expect(await send("%1", { state: "done" })).toEqual({ ok: false, code: "unrecorded" });
      expect(forwarded).toEqual([]);
      expect(ended.progress()).toEqual([]);
    } finally {
      events.stop();
    }
  });

  test("a report whose ledger write failed is forwarded but answered unwritten, not ok", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seance-report-ledger-"));
    const path = join(dir, "launched.json");
    const ledger = await LaunchLedger.open(path);
    const { forwarded, events, send } = setup(0, ledger);
    try {
      await ledger.record("t1");
      // A directory where the file goes: the next write fails.
      await rm(path, { force: true });
      await mkdir(path);
      expect(await send("%1", { state: "done" })).toEqual({ ok: false, code: "unwritten" });
      expect(forwarded.map((e) => e.state)).toEqual(["done"]);
    } finally {
      events.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a stopped ingest answers a report stopping, and the other states ok", async () => {
    const { ledger, forwarded, events, send } = setup();
    await ledger.record("t1");
    events.stop();
    expect(await send("%1", { state: "done" })).toEqual({ ok: false, code: "stopping" });
    expect(await send("%1", { state: "busy" })).toEqual({ ok: true });
    expect(forwarded).toEqual([]);
  });

  test("it goes at once inside a window holding a pending state, and the PR URL it carries is noted too", async () => {
    const { ledger, ended, forwarded, events, send } = setup(10_000);
    try {
      await ledger.record("t1");
      await send("%1", { state: "busy" });
      await send("%1", { state: "idle" });
      expect(forwarded.map((e) => e.state)).toEqual(["busy"]);
      await send("%1", { state: "done", prUrl: "https://github.com/a/b/pull/1" });
      expect(forwarded.map((e) => [e.state, e.prUrl])).toEqual([
        ["busy", undefined],
        ["done", "https://github.com/a/b/pull/1"],
      ]);
      await pollUntil(() => ended.progress()[0]?.prUrl !== undefined, "the PR URL in progress");
      expect(ended.progress()[0]).toMatchObject({ reported: true, prUrl: "https://github.com/a/b/pull/1" });
    } finally {
      events.stop();
    }
  });
});
