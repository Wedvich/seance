import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSIONS_MAX_PROGRESS,
  SUCCESSOR_RECORD_MAX,
  type PushBranchResponse,
  type SessionEvent,
  type SessionPass,
} from "@seance/shared";
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
    { id: "%1", pid: 10, dead: false, taskId: null, ours: true, path: "/home/u/work/repo" },
    { id: "%2", pid: 20, dead: false, taskId: "t1", ours: true, path: "/home/u/repo" },
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

describe("per-pane retention (custodian C15)", () => {
  const panes: readonly BoundPane[] = [
    { id: "%1", pid: 10, dead: false, taskId: null, ours: true, path: "/home" },
    { id: "%2", pid: 20, dead: false, taskId: "t1", ours: true, path: "/home" },
  ];

  function setup() {
    const retained: [string, string, boolean][] = [];
    const states: [string, string, boolean][] = [];
    const forwarded: SessionEvent[] = [];
    const events = createSessionEvents({
      panes: () => Promise.resolve(panes),
      exclaves: () => [],
      forward: (event) => void forwarded.push(event),
      ended: new EndedTasks(),
      coalesceMs: 0,
      hostNamesPeers: () => false,
      retain: (pane, state, turnEnded) => void retained.push([pane.id, state, turnEnded]),
      onState: (pane, _taskId, state, turnEnded) => void states.push([pane, state, turnEnded]),
      handOff: () => Promise.resolve(),
    });
    const send = (pane: string, fields: object): Promise<unknown> => events.handle(frame({ pane, ...fields }), null);
    return { retained, states, forwarded, events, send };
  }

  test("an untasked pane's states are retained while its replies, forwards and onState stay as they were", async () => {
    const { retained, states, forwarded, events, send } = setup();
    try {
      expect(await send("%1", { state: "busy" })).toEqual({ ok: true });
      expect(await send("%1", { state: "idle", turnEnded: true })).toEqual({ ok: true });
      expect(await send("%1", { state: "done" })).toEqual({ ok: false, code: "untasked" });
      expect(await send("%1", { handoff: true })).toEqual({ ok: false, code: "untasked" });
      expect(retained).toEqual([
        ["%1", "busy", false],
        ["%1", "idle", true],
      ]);
      expect(forwarded).toEqual([]);
      expect(states).toEqual([]);
    } finally {
      events.stop();
    }
  });

  test("a tasked pane's state is retained beside its forward and onState; a bare activity frame and done are not", async () => {
    const { retained, states, forwarded, events, send } = setup();
    try {
      expect(await send("%2", { state: "needs-input", reason: "question" })).toEqual({ ok: true });
      expect(await send("%2", { rateLimits: [] })).toEqual({ ok: true });
      expect(await send("%2", { state: "done" })).toEqual({ ok: false, code: "unrecorded" });
      expect(retained).toEqual([["%2", "needs-input", false]]);
      expect(states).toEqual([["%2", "needs-input", false]]);
      expect(forwarded.map((e) => e.state)).toEqual(["needs-input"]);
    } finally {
      events.stop();
    }
  });

  test("a stopped ingest retains nothing", async () => {
    const { retained, events, send } = setup();
    events.stop();
    expect(await send("%1", { state: "busy" })).toEqual({ ok: true });
    expect(retained).toEqual([]);
  });
});

test("parsePanePids dedupes grouped panes, validates the task, reads ours, and keeps a separator in the path", () => {
  const raw = [
    "%1|100|0|task-1|1|/a|b",
    "%1|100|0|task-1|1|/a|b",
    "%2|200|1||0|/c",
    "%3|300|0|bad task|1|/d",
    "junk",
  ].join("\n");
  expect(parsePanePids(raw)).toEqual([
    { id: "%1", pid: 100, dead: false, taskId: "task-1", ours: true, path: "/a|b" },
    { id: "%2", pid: 200, dead: true, taskId: null, ours: false, path: "/c" },
    { id: "%3", pid: 300, dead: false, taskId: null, ours: true, path: "/d" },
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

  test("the continued note's PR is carried for the continuation to inherit: its own report, else what it inherited", async () => {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    const site = { repo: "/r", path: "/r/.claude/worktrees/x", session: SESSION };
    await ledger.record("opened");
    await ledger.note("opened", { ...site, prUrl: "https://github.com/a/b/pull/1", exit: 0 });
    expect(ended.continuation("opened")).toMatchObject({ continuedPr: "https://github.com/a/b/pull/1" });
    await ledger.record("inherited");
    await ledger.note("inherited", {
      ...site,
      path: "/r/.claude/worktrees/y",
      continuedPr: "https://github.com/a/b/pull/2",
      exit: 0,
    });
    expect(ended.continuation("inherited")).toMatchObject({ continuedPr: "https://github.com/a/b/pull/2" });
    await ledger.record("both");
    await ledger.note("both", {
      ...site,
      path: "/r/.claude/worktrees/z",
      prUrl: "https://github.com/a/b/pull/3",
      continuedPr: "https://github.com/a/b/pull/2",
      exit: 0,
    });
    expect(ended.continuation("both")).toMatchObject({ continuedPr: "https://github.com/a/b/pull/3" });
    await ledger.record("bare");
    await ledger.note("bare", { ...site, path: "/r/.claude/worktrees/w", exit: 0 });
    expect(ended.continuation("bare")).not.toHaveProperty("continuedPr");
  });

  test("a PR is inherited from a launch however it ended, but not from one the scheduler cancelled", async () => {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    const pr = "https://github.com/a/b/pull/1";
    const noted = async (id: string, note: object): Promise<void> => {
      await ledger.record(id);
      await ledger.note(id, {
        repo: "/r",
        path: `/r/.claude/worktrees/${id}`,
        session: SESSION,
        prUrl: pr,
        ...note,
      });
    };
    // Each of these leaves a task with a PR awaiting-merge (`ended()` in scheduler/src/done.ts).
    await noted("handed", {});
    await ended.handingOff("handed");
    await noted("exited", { exit: 0 });
    await noted("failed", { exit: 1 });
    await noted("vanished", { vanished: true });
    // A despawn or reap, and a harvest of a pane that kept no status: closed here, nothing cancelled.
    await noted("despawned", { exit: 0 });
    await ended.closing("despawned");
    await noted("closed-bare", {});
    await ended.closing("closed-bare");
    await noted("handed-killed", {});
    await ended.handingOff("handed-killed");
    await ledger.note("handed-killed", { exit: 137 });
    await noted("running", {});
    for (const id of [
      "handed",
      "exited",
      "failed",
      "vanished",
      "despawned",
      "closed-bare",
      "handed-killed",
      "running",
    ]) {
      expect(ended.continuation(id), id).toMatchObject({ continuedPr: pr });
    }
    // The scheduler's cancel or mark-done: the task is no awaiting-merge one, and nothing watches its PR.
    await noted("cancelled", {});
    await ended.closing("cancelled", true);
    await noted("cancelled-zero", { exit: 0 });
    await ended.closing("cancelled-zero", true);
    expect(ended.continuation("cancelled")).not.toHaveProperty("continuedPr");
    expect(ended.continuation("cancelled-zero")).not.toHaveProperty("continuedPr");
    // Inherited through a chain: a cancelled link drops it for the links after.
    await noted("link", { prUrl: undefined, continuedPr: pr });
    await ended.closing("link", true);
    expect(ended.continuation("link")).not.toHaveProperty("continuedPr");
  });

  test("handingOff notes the hand-off and the close, and the continuation reports handedOff only for a clean end", async () => {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    const site = { repo: "/r", path: "/r/.claude/worktrees/x", session: SESSION };
    await ledger.record("h");
    await ledger.note("h", site);
    await ended.handingOff("h");
    expect(ledger.notes().find((n) => n.taskId === "h")).toMatchObject({ closedHere: true, handedOff: true });
    expect(ended.continuation("h")).toMatchObject({ handedOff: true });
    await ledger.note("h", { exit: 0 });
    expect(ended.continuation("h")).toMatchObject({ handedOff: true });
    await ledger.note("h", { exit: 137 });
    expect(ended.continuation("h")).not.toHaveProperty("handedOff");
    // Reap and despawn keep `closing`: a close nobody handed off.
    await ledger.record("r");
    await ledger.note("r", { ...site, path: "/r/.claude/worktrees/y" });
    await ended.closing("r");
    expect(ended.continuation("r")).not.toHaveProperty("handedOff");
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
      const events = paneEvents(restarted, { id: "%1", pid: 10, dead: false, taskId: "t1", ours: true, path: "/home" });
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
      const events = paneEvents(restarted, { id: "%1", pid: 10, dead: false, taskId: "t1", ours: true, path: "/home" });
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
      const events = paneEvents(restarted, { id: "%1", pid: 10, dead: false, taskId: "t1", ours: true, path: "/home" });
      events.stop();
      await events.handle(frame({ pane: "%1", state: "ended" }), null);
      await Bun.sleep(30); // a non-event can't be polled
      expect(restarted.ledger.interrupted()).toEqual(["t1"]);
    });
  });

  test("an unbound event, and one from another task's pane, clear nothing", async () => {
    await inTmp(async (path) => {
      const restarted = await afterCrash(path, "t1");
      const events = paneEvents(restarted, {
        id: "%2",
        pid: 20,
        dead: false,
        taskId: "other",
        ours: true,
        path: "/home",
      });
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

  // A fresh process, since the probe's success is kept for the process's life and the suite's other files share one.
  test("a failed probe resolves to a problem instead of rejecting, is not kept, and the next reader probes again", async () => {
    const script = `
      const { peerBindingProblem } = await import(process.env.PROBE_MODULE);
      const real = process.env.TMPDIR;
      process.env.TMPDIR = "/nonexistent/seanced-probe";
      const failed = await peerBindingProblem();
      if (real === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = real;
      console.log(JSON.stringify([failed, await peerBindingProblem()]));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, PROBE_MODULE: join(import.meta.dir, "session-events.ts") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(out)).toEqual([expect.stringContaining("the probe socket failed"), null]);
  });
});

describe("coalescing", () => {
  // The window is the subject: on a real clock a loaded runner's gap between two sends outlasted it.
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const pane: BoundPane = { id: "%1", pid: 10, dead: false, taskId: "t1", ours: true, path: "/home" };

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
      jest.advanceTimersByTime(149);
      expect(forwarded).toHaveLength(1);
      jest.advanceTimersByTime(1);
      expect(forwarded.map((e) => [e.state, e.prUrl])).toEqual([
        ["busy", undefined],
        ["needs-input", "https://github.com/a/b/pull/1"],
      ]);
    } finally {
      events.stop();
    }
  });

  test("a question reason is forwarded with its needs-input, and belongs to it: a later state in the window drops it", async () => {
    const { forwarded, events, send } = setup(150);
    try {
      await send({ state: "needs-input", reason: "question" });
      expect(forwarded.map((e) => [e.state, e.reason])).toEqual([["needs-input", "question"]]);
      await send({ state: "needs-input", reason: "question" });
      await send({ state: "needs-input" });
      jest.advanceTimersByTime(150);
      expect(forwarded.map((e) => [e.state, e.reason])).toEqual([
        ["needs-input", "question"],
        ["needs-input", undefined],
      ]);
    } finally {
      events.stop();
    }
  });

  test("a permission reason and its tool are forwarded with their needs-input, and a later state drops both", async () => {
    const { forwarded, events, send } = setup(150);
    try {
      await send({ state: "needs-input", reason: "permission", tool: "Bash" });
      expect(forwarded.map((e) => [e.state, e.reason, e.tool])).toEqual([["needs-input", "permission", "Bash"]]);
      await send({ state: "needs-input", reason: "permission", tool: "Bash" });
      await send({ state: "busy" });
      jest.advanceTimersByTime(150);
      expect(forwarded.map((e) => [e.state, e.reason, e.tool])).toEqual([
        ["needs-input", "permission", "Bash"],
        ["busy", undefined, undefined],
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
    jest.advanceTimersByTime(200);
    expect(forwarded).toHaveLength(1);
  });
});

describe("the PR URL is kept for the scheduler's progress", () => {
  function setup(taskId: string) {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    const pane: BoundPane = { id: "%1", pid: 10, dead: false, taskId, ours: true, path: "/home" };
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

describe("an ended event carries the PR its own launch noted", () => {
  const OLD = "https://github.com/a/b/pull/1";
  const NEW = "https://github.com/a/b/pull/2";

  function setup() {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    const pane: BoundPane = { id: "%1", pid: 10, dead: false, taskId: "t1", ours: true, path: "/home" };
    const forwarded: SessionEvent[] = [];
    const events = createSessionEvents({
      panes: () => Promise.resolve([pane]),
      exclaves: () => [],
      forward: (event) => void forwarded.push(event),
      ended,
      coalesceMs: 0,
      hostNamesPeers: () => false,
    });
    const send = (fields: object): Promise<unknown> => events.handle(frame({ pane: "%1", ...fields }), null);
    return { ledger, forwarded, events, send };
  }

  // The event that carried the PR may be lost on its way to the leader (a relay hiccup, a failover) and the
  // mod's `ended` carry none (a respawned hooks worker has no `lastPrUrl`); the leader would then defer the
  // PR-less `ended` for the exit and, with the machine gone, settle it `done`.
  test("a PR whose own event was lost rides the PR-less ended that follows", async () => {
    const { ledger, forwarded, events, send } = setup();
    try {
      await ledger.record("t1");
      await send({ state: "busy", prUrl: OLD });
      forwarded.length = 0; // lost on the way
      await send({ state: "ended" });
      expect(forwarded).toEqual([expect.objectContaining({ taskId: "t1", state: "ended", prUrl: OLD })]);
    } finally {
      events.stop();
    }
  });

  test("the frame's own PR wins, and a live state carries only its own", async () => {
    const { ledger, forwarded, events, send } = setup();
    try {
      await ledger.record("t1");
      await send({ state: "busy", prUrl: OLD });
      await send({ state: "idle" });
      expect(forwarded.at(-1)?.prUrl).toBeUndefined();
      await send({ state: "ended", prUrl: NEW });
      expect(forwarded.at(-1)).toMatchObject({ state: "ended", prUrl: NEW });
    } finally {
      events.stop();
    }
  });

  test("a PR a continuation only inherited is not its own: its ended carries none", async () => {
    const { ledger, forwarded, events, send } = setup();
    try {
      await ledger.record("t1");
      await ledger.note("t1", { repo: "/r", path: "/r/.claude/worktrees/x", session: SESSION, continuedPr: OLD });
      await send({ state: "ended" });
      expect(forwarded).toEqual([expect.objectContaining({ state: "ended" })]);
      expect(forwarded[0]?.prUrl).toBeUndefined();
    } finally {
      events.stop();
    }
  });
});

describe("a session's done report (#21)", () => {
  const tasked: BoundPane = { id: "%1", pid: 10, dead: false, taskId: "t1", ours: true, path: "/home" };
  const bare: BoundPane = { id: "%2", pid: 20, dead: false, taskId: null, ours: true, path: "/home" };

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

describe("a session's hand-off", () => {
  const PR = "https://github.com/a/b/pull/1";

  test("parses alone: a hand-off carries no state, and only `true` is one", () => {
    expect(parseSessionEventFrame(frame({ handoff: true, pane: "%1", prUrl: PR }))).toEqual({
      v: 1,
      kind: "session-event",
      handoff: true,
      pane: "%1",
    });
    expect(parseSessionEventFrame(frame({ handoff: true, state: "idle" }))).toBeNull();
    expect(parseSessionEventFrame(frame({ handoff: false }))).toBeNull();
    expect(parseSessionEventFrame(frame({ handoff: true, pane: 7 }))).toBeNull();
  });

  test("a question reason rides only on needs-input; elsewhere, or unknown, it is dropped and the frame kept", () => {
    const base = { v: 1, kind: "session-event" } as const;
    expect(parseSessionEventFrame(frame({ state: "needs-input", reason: "question" }))).toEqual({
      ...base,
      state: "needs-input",
      reason: "question",
    });
    expect(parseSessionEventFrame(frame({ state: "busy", reason: "question" }))).toEqual({ ...base, state: "busy" });
    expect(parseSessionEventFrame(frame({ state: "needs-input", reason: "elicitation" }))).toEqual({
      ...base,
      state: "needs-input",
    });
    expect(parseSessionEventFrame(frame({ state: "needs-input", reason: 1 }))).toEqual({
      ...base,
      state: "needs-input",
    });
  });

  test("a permission reason keeps a tool name beside it; a bad or misplaced tool is dropped, the frame kept", () => {
    const base = { v: 1, kind: "session-event", state: "needs-input" } as const;
    const permission = { ...base, reason: "permission" } as const;
    expect(parseSessionEventFrame(frame({ ...permission, tool: "Bash" }))).toEqual({ ...permission, tool: "Bash" });
    expect(parseSessionEventFrame(frame(permission))).toEqual(permission);
    for (const tool of ["rm -rf /", "a/b", "", "t".repeat(65), 4]) {
      expect(parseSessionEventFrame(frame({ ...permission, tool }))).toEqual(permission);
    }
    expect(parseSessionEventFrame(frame({ ...base, reason: "question", tool: "Bash" }))).toEqual({
      ...base,
      reason: "question",
    });
    expect(parseSessionEventFrame(frame({ state: "busy", reason: "permission", tool: "Bash" }))).toEqual({
      v: 1,
      kind: "session-event",
      state: "busy",
    });
  });

  test("a turn's end rides only on idle, and only as `true`", () => {
    expect(parseSessionEventFrame(frame({ state: "idle", turnEnded: true }))).toEqual({
      v: 1,
      kind: "session-event",
      state: "idle",
      turnEnded: true,
    });
    expect(parseSessionEventFrame(frame({ state: "busy", turnEnded: true }))).toBeNull();
    expect(parseSessionEventFrame(frame({ state: "idle", turnEnded: false }))).toBeNull();
    expect(parseSessionEventFrame(frame({ handoff: true, turnEnded: true }))).toEqual({
      v: 1,
      kind: "session-event",
      handoff: true,
    });
  });

  function setup(opts: { readonly handOff?: boolean; readonly prWaitMs?: number } = {}) {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    const panes: BoundPane[] = [
      { id: "%1", pid: 10, dead: false, taskId: "t1", ours: true, path: "/home" },
      { id: "%2", pid: 20, dead: false, taskId: null, ours: true, path: "/home" },
    ];
    const forwarded: SessionEvent[] = [];
    const closed: [string, string][] = [];
    const events = createSessionEvents({
      panes: () => Promise.resolve(panes),
      exclaves: () => [],
      forward: (event) => void forwarded.push(event),
      ended,
      coalesceMs: 0,
      hostNamesPeers: () => false,
      handoffPrWaitMs: opts.prWaitMs ?? 0,
      ...(opts.handOff === false
        ? {}
        : {
            handOff: (pane: string, taskId: string): Promise<void> => {
              closed.push([pane, taskId]);
              return Promise.resolve();
            },
          }),
    });
    const send = (pane: string, fields: object): Promise<unknown> => events.handle(frame({ pane, ...fields }), null);
    return { ledger, ended, panes, forwarded, closed, events, send };
  }

  test("is refused, with nothing sent, from a task-less pane, an unrecorded task, or one with no PR noted", async () => {
    const { ledger, ended, forwarded, events, send } = setup();
    try {
      expect(await send("%2", { handoff: true })).toEqual({ ok: false, code: "untasked" });
      expect(await send("%1", { handoff: true })).toEqual({ ok: false, code: "unrecorded" });
      await ledger.record("t1");
      expect(await send("%1", { handoff: true })).toEqual({ ok: false, code: "prless" });
      await ended.notePr("t1", PR);
      expect(await send("%1", { handoff: true })).toEqual({ ok: true });
      expect(forwarded).toEqual([]);
    } finally {
      events.stop();
    }
  });

  test("a continuation hands off the PR its own note inherited, with nothing of the continued launch in the ledger", async () => {
    const { ledger, events, closed, send } = setup();
    try {
      await ledger.record("t1");
      await ledger.note("t1", {
        repo: "/r",
        path: "/r/.claude/worktrees/x",
        session: SESSION,
        continuedPr: PR,
      });
      expect(await send("%1", { handoff: true })).toEqual({ ok: true });
      await send("%1", { state: "idle", turnEnded: true });
      expect(closed).toEqual([["%1", "t1"]]);
    } finally {
      events.stop();
    }
  });

  test("a continuation of an awaiting-merge task hands off whatever ended the launch, and is prless after a cancel", async () => {
    const site = { repo: "/r", path: "/r/.claude/worktrees/x", session: SESSION };
    // What the daemon does for the continuation: note the PR the continued launch's note hands it, then take the hand-off.
    const handoffAfter = async (
      end: (ended: EndedTasks, ledger: LaunchLedger) => Promise<unknown>,
    ): Promise<unknown> => {
      const { ledger, ended, events, send } = setup();
      try {
        await ledger.record("t0");
        await ledger.note("t0", { ...site, prUrl: PR });
        await end(ended, ledger);
        const continued = ended.continuation("t0");
        await ledger.record("t1");
        await ledger.note("t1", {
          ...site,
          ...("continuedPr" in continued ? { continuedPr: continued.continuedPr } : {}),
        });
        return await send("%1", { handoff: true });
      } finally {
        events.stop();
      }
    };
    const accepted = { ok: true };
    expect(await handoffAfter((_, ledger) => ledger.note("t0", { exit: 1 }))).toEqual(accepted);
    expect(await handoffAfter((_, ledger) => ledger.note("t0", { vanished: true }))).toEqual(accepted);
    expect(await handoffAfter((ended) => ended.closing("t0"))).toEqual(accepted);
    expect(await handoffAfter((ended) => ended.closing("t0", true))).toEqual({ ok: false, code: "prless" });
  });

  test("a continuation with no PR of its own or inherited is prless, though another launch noted the same path and session", async () => {
    const { ledger, events, send } = setup();
    try {
      const site = { repo: "/r", path: "/r/.claude/worktrees/x", session: SESSION };
      await ledger.record("t0");
      await ledger.note("t0", { ...site, prUrl: PR });
      await ledger.record("t1");
      await ledger.note("t1", site);
      expect(await send("%1", { handoff: true })).toEqual({ ok: false, code: "prless" });
    } finally {
      events.stop();
    }
  });

  test("waits for a PR URL still on its way from the mod, and no longer than its limit", async () => {
    const { ledger, ended, events, send } = setup({ prWaitMs: 2_000 });
    try {
      await ledger.record("t1");
      const answer = send("%1", { handoff: true });
      setTimeout(() => void ended.notePr("t1", PR), 150);
      expect(await answer).toEqual({ ok: true });
    } finally {
      events.stop();
    }
    const late = setup({ prWaitMs: 200 });
    try {
      await late.ledger.record("t1");
      const started = Date.now();
      expect(await late.send("%1", { handoff: true })).toEqual({ ok: false, code: "prless" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    } finally {
      late.events.stop();
    }
  });

  test("closes the pane at its turn's end, once, after that idle is forwarded", async () => {
    const { ledger, ended, forwarded, closed, events, send } = setup();
    try {
      await ledger.record("t1");
      await ended.notePr("t1", PR);
      await send("%1", { handoff: true });
      await send("%1", { state: "busy" });
      await send("%1", { state: "needs-input" });
      // A hooks-worker respawn mid-turn reads idle too: the final message is not written yet.
      await send("%1", { state: "idle" });
      expect(closed).toEqual([]);
      await send("%1", { state: "idle", turnEnded: true });
      expect(closed).toEqual([["%1", "t1"]]);
      expect(forwarded.map((e) => e.state)).toEqual(["busy", "needs-input", "idle", "idle"]);
      await send("%1", { state: "busy" });
      await send("%1", { state: "idle", turnEnded: true });
      expect(closed).toEqual([["%1", "t1"]]);
    } finally {
      events.stop();
    }
  });

  test("an end before the turn's, or the pane reused by another task, drops it", async () => {
    const { ledger, ended, panes, closed, events, send } = setup();
    try {
      await ledger.record("t1");
      await ended.notePr("t1", PR);
      await send("%1", { handoff: true });
      await send("%1", { state: "ended" });
      await send("%1", { state: "idle", turnEnded: true });
      expect(closed).toEqual([]);

      await send("%1", { handoff: true });
      panes[0] = { id: "%1", pid: 11, dead: false, taskId: "t2", ours: true, path: "/home" };
      await ledger.record("t2");
      await send("%1", { state: "idle", turnEnded: true });
      panes[0] = { id: "%1", pid: 10, dead: false, taskId: "t1", ours: true, path: "/home" };
      await send("%1", { state: "idle", turnEnded: true });
      expect(closed).toEqual([]);
    } finally {
      events.stop();
    }
  });

  test("a daemon with no hand-off act answers unsupported; a stopped ingest answers stopping", async () => {
    const bare = setup({ handOff: false });
    try {
      await bare.ledger.record("t1");
      await bare.ended.notePr("t1", PR);
      expect(await bare.send("%1", { handoff: true })).toEqual({ ok: false, code: "unsupported" });
    } finally {
      bare.events.stop();
    }
    const { ledger, ended, events, send } = setup();
    await ledger.record("t1");
    await ended.notePr("t1", PR);
    events.stop();
    expect(await send("%1", { handoff: true })).toEqual({ ok: false, code: "stopping" });
  });
});

describe("a session's own pass", () => {
  const PR = "https://github.com/a/b/pull/1";
  const TIP = "a".repeat(40);
  const RECORD = "done: a; left: b";
  const SITE = { repo: "/r", path: "/r/.claude/worktrees/x", session: SESSION };
  const PUSHED: PushBranchResponse = { ok: true, remoteBranch: "feature/x", tip: TIP, pushed: true };

  function setup(
    opts: {
      readonly pass?: boolean;
      readonly push?: PushBranchResponse;
      readonly sent?: boolean;
      /** Runs inside the push, as a caller giving up or a throw would. */
      readonly during?: () => void;
    } = {},
  ) {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    const panes: BoundPane[] = [
      { id: "%1", pid: 10, dead: false, taskId: "t1", ours: true, path: "/home" },
      { id: "%2", pid: 20, dead: false, taskId: null, ours: true, path: "/home" },
    ];
    const pushes: { taskId: string; hasPr: boolean }[] = [];
    const passes: SessionPass[] = [];
    const closed: [string, string][] = [];
    const handedOff: [string, string][] = [];
    const events = createSessionEvents({
      panes: () => Promise.resolve(panes),
      exclaves: () => [],
      forward: () => {},
      ended,
      coalesceMs: 0,
      hostNamesPeers: () => false,
      handOff: (pane: string, taskId: string): Promise<void> => {
        handedOff.push([pane, taskId]);
        return Promise.resolve();
      },
      ...(opts.pass === false
        ? {}
        : {
            pass: {
              push: (taskId: string, options: { readonly hasPr: boolean }): Promise<PushBranchResponse> => {
                pushes.push({ taskId, hasPr: options.hasPr });
                opts.during?.();
                return Promise.resolve(opts.push ?? PUSHED);
              },
              send: (pass: SessionPass): Promise<boolean> => {
                passes.push(pass);
                return Promise.resolve(opts.sent ?? true);
              },
              close: (pane: string, taskId: string): Promise<void> => {
                closed.push([pane, taskId]);
                return Promise.resolve();
              },
            },
          }),
    });
    const send = (pane: string, fields: object, caller?: AbortSignal): Promise<unknown> =>
      events.handle(frame({ pane, ...fields }), null, caller);
    const launch = async (): Promise<void> => {
      await ledger.record("t1");
      await ledger.note("t1", SITE);
    };
    return { ledger, ended, panes, pushes, passes, closed, handedOff, events, send, launch };
  }

  test("parses alone, with a bounded record: a pass rides no state and never beside a hand-off", () => {
    expect(parseSessionEventFrame(frame({ pass: true, record: RECORD, pane: "%1", prUrl: PR }))).toEqual({
      v: 1,
      kind: "session-event",
      pass: true,
      record: RECORD,
      pane: "%1",
    });
    expect(parseSessionEventFrame(frame({ pass: true, record: "x".repeat(SUCCESSOR_RECORD_MAX) }))).not.toBeNull();
    for (const bad of [
      { pass: true },
      { pass: true, record: "" },
      { pass: true, record: 7 },
      { pass: true, record: "x".repeat(SUCCESSOR_RECORD_MAX + 1) },
      { pass: false, record: RECORD },
      { pass: true, record: RECORD, state: "idle" },
      { pass: true, record: RECORD, handoff: true },
      { pass: true, record: RECORD, pane: 7 },
    ]) {
      expect(parseSessionEventFrame(frame(bad))).toBeNull();
    }
    // A record with no pass is no pass: ignored, the frame read as any other.
    expect(parseSessionEventFrame(frame({ state: "busy", record: RECORD }))).toEqual({
      v: 1,
      kind: "session-event",
      state: "busy",
    });
  });

  test("pushes the task's branch, hands the pass to the scheduler once, and answers what was pushed", async () => {
    const { launch, pushes, passes, send, events } = setup();
    try {
      await launch();
      expect(await send("%1", { pass: true, record: RECORD })).toEqual({
        ok: true,
        pass: { taskId: "t1", remoteBranch: "feature/x", tip: TIP, pushed: true },
      });
      expect(pushes).toEqual([{ taskId: "t1", hasPr: false }]);
      // Every field but the record is the daemon's own: the task comes from the bound pane, never the frame.
      expect(passes).toEqual([
        {
          session: "%1",
          taskId: "t1",
          exclave: expect.any(String),
          remoteBranch: "feature/x",
          tip: TIP,
          record: RECORD,
          at: expect.any(Number),
        },
      ]);
    } finally {
      events.stop();
    }
  });

  test("tells the push whether the launch noted a PR, so a branch with no upstream is the session's to fix", async () => {
    const { launch, ended, pushes, send, events } = setup({
      push: { ok: false, code: "no_upstream", message: "m" },
    });
    try {
      await launch();
      await ended.notePr("t1", PR);
      expect(await send("%1", { pass: true, record: RECORD })).toEqual({ ok: false, code: "no_upstream" });
      expect(pushes).toEqual([{ taskId: "t1", hasPr: true }]);
    } finally {
      events.stop();
    }
  });

  test("a continuation's inherited PR counts as one for the push too", async () => {
    const { launch, ledger, pushes, send, events } = setup({
      push: { ok: false, code: "no_upstream", message: "m" },
    });
    try {
      await launch();
      await ledger.note("t1", { continuedPr: PR });
      expect(await send("%1", { pass: true, record: RECORD })).toEqual({ ok: false, code: "no_upstream" });
      expect(pushes).toEqual([{ taskId: "t1", hasPr: true }]);
    } finally {
      events.stop();
    }
  });

  test("is refused, with nothing pushed or sent, from a task-less pane, an unrecorded or in-place task", async () => {
    const { ledger, passes, pushes, send, events } = setup();
    try {
      expect(await send("%2", { pass: true, record: RECORD })).toEqual({ ok: false, code: "untasked" });
      expect(await send("%1", { pass: true, record: RECORD })).toEqual({ ok: false, code: "unrecorded" });
      // Launched in place: a launch with no worktree noted.
      await ledger.record("t1");
      expect(await send("%1", { pass: true, record: RECORD })).toEqual({ ok: false, code: "here" });
      expect(pushes).toEqual([]);
      expect(passes).toEqual([]);
    } finally {
      events.stop();
    }
  });

  test("a daemon without the act answers unsupported, before anything is pushed", async () => {
    const bare = setup({ pass: false });
    try {
      await bare.launch();
      expect(await bare.send("%1", { pass: true, record: RECORD })).toEqual({ ok: false, code: "unsupported" });
    } finally {
      bare.events.stop();
    }
  });

  test("answers a push refusal as the code the session can act on, and nothing is sent", async () => {
    const cases: [PushBranchResponse, string][] = [
      [{ ok: false, code: "dirty_worktree", message: "m" }, "dirty_worktree"],
      [{ ok: false, code: "detached_head", message: "m" }, "detached_head"],
      [{ ok: false, code: "default_branch", message: "m" }, "default_branch"],
      [{ ok: false, code: "push_rejected", message: "m" }, "push_rejected"],
      [{ ok: false, code: "not_launched", message: "m" }, "unrecorded"],
      [{ ok: false, code: "internal_error", message: "m" }, "push_failed"],
    ];
    for (const [push, code] of cases) {
      const { launch, passes, send, events } = setup({ push });
      try {
        // oxlint-disable-next-line no-await-in-loop -- one double per case
        await launch();
        // oxlint-disable-next-line no-await-in-loop -- one double per case
        expect(await send("%1", { pass: true, record: RECORD })).toEqual({ ok: false, code });
        expect(passes).toEqual([]);
      } finally {
        events.stop();
      }
    }
  });

  test("a pass the daemon could not hand on is told so, and leaves no mark: only a later pass-close makes one", async () => {
    const { launch, closed, send, events } = setup({ sent: false });
    try {
      await launch();
      expect(await send("%1", { pass: true, record: RECORD })).toEqual({ ok: false, code: "unsent" });
      await send("%1", { state: "idle", turnEnded: true });
      expect(closed).toEqual([]);
    } finally {
      events.stop();
    }
  });

  test("a stopped ingest answers stopping before the push, and says the branch is pushed after it", async () => {
    const stopped = setup();
    await stopped.launch();
    stopped.events.stop();
    expect(await stopped.send("%1", { pass: true, record: RECORD })).toEqual({ ok: false, code: "stopping" });
    expect(stopped.pushes).toEqual([]);

    const during = setup();
    await during.launch();
    const slow = createSessionEvents({
      panes: () => Promise.resolve(during.panes),
      exclaves: () => [],
      forward: () => {},
      ended: during.ended,
      hostNamesPeers: () => false,
      pass: {
        push: (): Promise<PushBranchResponse> => {
          slow.stop();
          return Promise.resolve(PUSHED);
        },
        send: (): Promise<boolean> => Promise.reject(new Error("must not send")),
        close: (): Promise<void> => Promise.resolve(),
      },
    });
    expect(await slow.handle(frame({ pane: "%1", pass: true, record: RECORD }), null)).toEqual({
      ok: false,
      code: "stopping_pushed",
    });
    during.events.stop();
  });

  test("a push that throws is push_failed, never `invalid`, and sends and marks nothing", async () => {
    const { launch, ledger, passes, closed, send, events } = setup();
    try {
      await launch();
      const throwing = createSessionEvents({
        panes: () => Promise.resolve([{ id: "%1", pid: 10, dead: false, taskId: "t1", ours: true, path: "/home" }]),
        exclaves: () => [],
        forward: () => {},
        ended: new EndedTasks(ledger),
        hostNamesPeers: () => false,
        pass: {
          push: (): Promise<PushBranchResponse> => Promise.reject(new Error("audit log: EACCES")),
          send: (pass: SessionPass): Promise<boolean> => {
            passes.push(pass);
            return Promise.resolve(true);
          },
          close: (): Promise<void> => Promise.resolve(),
        },
      });
      expect(await throwing.handle(frame({ pane: "%1", pass: true, record: RECORD }), null)).toEqual({
        ok: false,
        code: "push_failed",
      });
      expect(passes).toEqual([]);
      await send("%1", { state: "idle", turnEnded: true });
      expect(closed).toEqual([]);
      throwing.stop();
    } finally {
      events.stop();
    }
  });

  test("a caller that has gone is told nothing is sent, and no pass, mark or close follows (an interrupted call)", async () => {
    const before = new AbortController();
    before.abort();
    const early = setup();
    try {
      await early.launch();
      expect(await early.send("%1", { pass: true, record: RECORD }, before.signal)).toEqual({
        ok: false,
        code: "cancelled",
      });
      expect(early.pushes).toEqual([]);
    } finally {
      early.events.stop();
    }

    // Gone while the push ran: the branch is pushed (clean, never forced), but it is never passed.
    const mid = new AbortController();
    const late = setup({ during: () => mid.abort() });
    try {
      await late.launch();
      expect(await late.send("%1", { pass: true, record: RECORD }, mid.signal)).toEqual({
        ok: false,
        code: "cancelled",
      });
      expect(late.pushes).toHaveLength(1);
      expect(late.passes).toEqual([]);
      // No mark: a later pass-close (which only a sent pass could provoke) finds none, and a turn end closes nothing.
      await late.send("%1", { state: "idle", turnEnded: true });
      await late.events.armPassClose("t1");
      expect(late.closed).toEqual([]);
    } finally {
      late.events.stop();
    }
  });

  test("one close per pane: a pass replaces a hand-off's mark, and a hand-off after a pass is refused", async () => {
    const { launch, ended, closed, handedOff, send, events } = setup();
    try {
      await launch();
      await ended.notePr("t1", PR);
      await send("%1", { handoff: true });
      await send("%1", { pass: true, record: RECORD });
      await events.armPassClose("t1");
      await send("%1", { state: "idle", turnEnded: true });
      expect(closed).toEqual([["%1", "t1"]]);
      expect(handedOff).toEqual([]);

      await send("%1", { pass: true, record: RECORD });
      expect(await send("%1", { handoff: true })).toEqual({ ok: false, code: "passed" });
      await events.armPassClose("t1");
      await send("%1", { state: "idle", turnEnded: true });
      expect(closed).toHaveLength(2);
      expect(handedOff).toEqual([]);
    } finally {
      events.stop();
    }
  });

  describe("the close at a turn's end", () => {
    test("needs both the leader's pass-close and the turn's end, whichever lands second", async () => {
      const { launch, closed, send, events } = setup();
      try {
        await launch();
        await send("%1", { pass: true, record: RECORD });
        // Turn ends first: nothing closes until the leader has written its commit point.
        await send("%1", { state: "idle", turnEnded: true });
        expect(closed).toEqual([]);
        expect(await events.armPassClose("t1")).toEqual({ ok: true });
        expect(closed).toEqual([["%1", "t1"]]);

        // Confirmed first, then the turn ends.
        await send("%1", { pass: true, record: RECORD });
        expect(await events.armPassClose("t1")).toEqual({ ok: true });
        expect(closed).toHaveLength(1);
        await send("%1", { state: "idle", turnEnded: true });
        expect(closed).toHaveLength(2);
        // Once: a later turn end finds no entry.
        await send("%1", { state: "idle", turnEnded: true });
        expect(closed).toHaveLength(2);
      } finally {
        events.stop();
      }
    });

    test("a plain idle, a hooks-worker respawn's, never closes a confirmed pass", async () => {
      const { launch, closed, send, events } = setup();
      try {
        await launch();
        await send("%1", { pass: true, record: RECORD });
        await events.armPassClose("t1");
        await send("%1", { state: "idle" });
        await send("%1", { state: "idle" });
        expect(closed).toEqual([]);
      } finally {
        events.stop();
      }
    });

    test("a turn begun after an unconfirmed pass is never cut by a late pass-close", async () => {
      const { launch, closed, send, events } = setup();
      try {
        await launch();
        await send("%1", { pass: true, record: RECORD });
        await send("%1", { state: "idle", turnEnded: true });
        // A person prompts the session again before the leader's answer lands.
        await send("%1", { state: "busy" });
        await events.armPassClose("t1");
        expect(closed).toEqual([]);
        await send("%1", { state: "idle", turnEnded: true });
        expect(closed).toEqual([["%1", "t1"]]);
        // A question mid-turn clears it too.
        await send("%1", { pass: true, record: RECORD });
        await send("%1", { state: "idle", turnEnded: true });
        await send("%1", { state: "needs-input" });
        await events.armPassClose("t1");
        expect(closed).toHaveLength(1);
      } finally {
        events.stop();
      }
    });

    test("the pane reused by another task drops the entry", async () => {
      const { launch, ledger, panes, closed, send, events } = setup();
      try {
        await launch();
        await ledger.record("t2");
        await send("%1", { pass: true, record: RECORD });
        panes[0] = { id: "%1", pid: 10, dead: false, taskId: "t2", ours: true, path: "/home" };
        await send("%1", { state: "idle", turnEnded: true });
        panes[0] = { id: "%1", pid: 10, dead: false, taskId: "t1", ours: true, path: "/home" };
        // A pass-close for t1 now finds no entry of the pane's: it is made anew, and needs a later turn end.
        await events.armPassClose("t1");
        expect(closed).toEqual([]);
      } finally {
        events.stop();
      }
    });

    test("a pass-close for a task no live pane carries is no_pane, and a stopped ingest arms nothing", async () => {
      const { panes, events } = setup();
      expect(await events.armPassClose("nobody")).toMatchObject({ ok: false, code: "no_pane" });
      panes[0] = { id: "%1", pid: 10, dead: true, taskId: "t1", ours: true, path: "/home" };
      expect(await events.armPassClose("t1")).toMatchObject({ ok: false, code: "no_pane" });
      panes[0] = { id: "%1", pid: 10, dead: false, taskId: "t1", ours: true, path: "/home" };
      events.stop();
      // Not no_pane: that tells the leader the session is gone, which a stopping daemon cannot say.
      expect(await events.armPassClose("t1")).toMatchObject({ ok: false, code: "unsupported" });
    });

    test("after a daemon restart a pass-close makes the entry itself, and only a later turn end closes", async () => {
      const { closed, send, events } = setup();
      try {
        expect(await events.armPassClose("t1")).toEqual({ ok: true });
        expect(closed).toEqual([]);
        await send("%1", { state: "busy" });
        await send("%1", { state: "idle", turnEnded: true });
        expect(closed).toEqual([["%1", "t1"]]);
      } finally {
        events.stop();
      }
    });

    test("leaves the hand-off alone: its own mark, closed through its own seam", async () => {
      const { launch, ended, closed, handedOff, send, events } = setup();
      try {
        await launch();
        await ended.notePr("t1", PR);
        await send("%1", { handoff: true });
        await send("%1", { state: "idle", turnEnded: true });
        expect(handedOff).toEqual([["%1", "t1"]]);
        expect(closed).toEqual([]);
      } finally {
        events.stop();
      }
    });

    test("stop clears the entries", async () => {
      const { launch, closed, send, events } = setup();
      await launch();
      await send("%1", { pass: true, record: RECORD });
      await events.armPassClose("t1");
      events.stop();
      await send("%1", { state: "idle", turnEnded: true });
      expect(closed).toEqual([]);
    });
  });
});

describe("the drain ask's hooks", () => {
  const PR = "https://github.com/a/b/pull/1";
  const TIP = "b".repeat(40);
  const SITE = { repo: "/r", path: "/r/.claude/worktrees/x", session: SESSION };
  const PUSHED: PushBranchResponse = { ok: true, remoteBranch: "feature/x", tip: TIP, pushed: true };
  type State = [string, string, string, boolean, string | undefined, boolean];

  function setup(opts: { readonly drain?: boolean; readonly closeSettles?: Promise<void> } = {}) {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    const panes: BoundPane[] = [
      { id: "%1", pid: 10, dead: false, taskId: "t1", ours: true, path: "/home" },
      { id: "%2", pid: 20, dead: false, taskId: null, ours: true, path: "/home" },
    ];
    const states: State[] = [];
    const passes: SessionPass[] = [];
    const forwarded: SessionEvent[] = [];
    const events = createSessionEvents({
      panes: () => Promise.resolve(panes),
      exclaves: () => [],
      forward: (event) => forwarded.push(event),
      ended,
      coalesceMs: 60_000,
      hostNamesPeers: () => false,
      handOff: () => opts.closeSettles ?? Promise.resolve(),
      pass: {
        push: () => Promise.resolve(PUSHED),
        send: (pass) => {
          passes.push(pass);
          return Promise.resolve(true);
        },
        close: () => opts.closeSettles ?? Promise.resolve(),
      },
      onState: (pane, taskId, state, turnEnded, reason, closing) => {
        states.push([pane, taskId, state, turnEnded, reason, closing]);
      },
      ...(opts.drain === undefined ? {} : { drainMark: () => opts.drain === true }),
    });
    const send = (pane: string, fields: object): Promise<unknown> => events.handle(frame({ pane, ...fields }), null);
    const launch = async (): Promise<void> => {
      await ledger.record("t1");
      await ledger.note("t1", { ...SITE, prUrl: PR });
    };
    return { ledger, ended, panes, states, passes, forwarded, events, send, launch };
  }

  test("a session pass carries drain only while the machine is closed", async () => {
    for (const drain of [true, false, undefined]) {
      const { launch, passes, send, events } = setup(drain === undefined ? {} : { drain });
      try {
        await launch();
        await send("%1", { pass: true, record: "r" });
        expect(passes).toHaveLength(1);
        expect("drain" in (passes[0] ?? {})).toBe(drain === true);
        if (drain === true) expect(passes[0]).toMatchObject({ drain: true });
      } finally {
        events.stop();
      }
    }
  });

  test("onState sees every bound, tasked frame, including ones the outbox coalesces, and nothing else", async () => {
    const { launch, states, forwarded, send, events } = setup();
    try {
      await launch();
      await send("%1", { state: "busy" });
      await send("%1", { state: "needs-input", reason: "question" });
      await send("%1", { state: "idle", turnEnded: true });
      await send("%1", { state: "idle" });
      // Untasked pane, an unbound pane, a frame with no state: nothing.
      await send("%2", { state: "busy" });
      await send("%9", { state: "busy" });
      await send("%1", {});
      expect(states).toEqual([
        ["%1", "t1", "busy", false, undefined, false],
        ["%1", "t1", "needs-input", false, "question", false],
        ["%1", "t1", "idle", true, undefined, false],
        ["%1", "t1", "idle", false, undefined, false],
      ]);
      // The 60 s window coalesced the outbox: fewer events went on than frames were seen.
      expect(forwarded.length).toBeLessThan(4);
    } finally {
      events.stop();
    }
  });

  test("a hand-off mark fires on the turn-ended idle: onState says closing, and marked holds until the close settles", async () => {
    const settles = Promise.withResolvers<void>();
    const { launch, states, send, events } = setup({ closeSettles: settles.promise });
    try {
      await launch();
      expect(events.marked("%1")).toBe(false);
      await send("%1", { handoff: true });
      expect(events.marked("%1")).toBe(true);
      await send("%1", { state: "idle", turnEnded: true });
      expect(states.at(-1)).toEqual(["%1", "t1", "idle", true, undefined, true]);
      // The mark was consumed, but the despawn has not written its own: still marked.
      expect(events.marked("%1")).toBe(true);
      settles.resolve();
      await pollUntil(() => !events.marked("%1"), "the close settled and the pane unmarked");
    } finally {
      events.stop();
    }
  });

  test("a confirmed pass close likewise: closing on the turn's end, marked until it settles", async () => {
    const settles = Promise.withResolvers<void>();
    const { launch, states, send, events } = setup({ closeSettles: settles.promise });
    try {
      await launch();
      await send("%1", { pass: true, record: "r" });
      expect(events.marked("%1")).toBe(true);
      await events.armPassClose("t1");
      await send("%1", { state: "idle", turnEnded: true });
      expect(states.at(-1)).toEqual(["%1", "t1", "idle", true, undefined, true]);
      expect(events.marked("%1")).toBe(true);
      settles.resolve();
      await pollUntil(() => !events.marked("%1"), "the close settled and the pane unmarked");
    } finally {
      events.stop();
    }
  });

  test("the leader's pass-close landing after the turn ended closes at once, and is marked as well", async () => {
    const settles = Promise.withResolvers<void>();
    const { launch, send, events } = setup({ closeSettles: settles.promise });
    try {
      await launch();
      await send("%1", { pass: true, record: "r" });
      await send("%1", { state: "idle", turnEnded: true });
      await events.armPassClose("t1");
      expect(events.marked("%1")).toBe(true);
      settles.resolve();
      await pollUntil(() => !events.marked("%1"), "the close settled and the pane unmarked");
    } finally {
      events.stop();
    }
  });

  test("an ended frame clears a hand-off mark; marked is then false", async () => {
    const { launch, send, events } = setup();
    try {
      await launch();
      await send("%1", { handoff: true });
      expect(events.marked("%1")).toBe(true);
      await send("%1", { state: "ended" });
      expect(events.marked("%1")).toBe(false);
    } finally {
      events.stop();
    }
  });

  test("askable: a worktree launch only, not reported done, not closed here, and one the ledger holds", async () => {
    const ledger = LaunchLedger.memory();
    const ended = new EndedTasks(ledger);
    expect(ended.askable("none")).toBe(false);

    await ledger.record("here");
    expect(ended.askable("here")).toBe(false);

    await ledger.record("wt");
    await ledger.note("wt", SITE);
    expect(ended.askable("wt")).toBe(true);

    await ledger.record("done");
    await ledger.note("done", SITE);
    await ended.noteReported("done");
    expect(ended.askable("done")).toBe(false);

    await ledger.record("closing");
    await ledger.note("closing", SITE);
    await ended.closing("closing");
    expect(ended.askable("closing")).toBe(false);

    await ledger.record("handed");
    await ledger.note("handed", SITE);
    await ended.handingOff("handed");
    expect(ended.askable("handed")).toBe(false);
  });
});
