import { describe, expect, test } from "bun:test";
import type { Machine } from "./app-client.ts";
import { drainStuckText, drainSummary, drainView, leaderCloseNote, leadsQueue } from "./drain.ts";
import { CAPABILITIES, type SessionEntry, type Task, type TaskSpec } from "./types.ts";

const CL = 1_800_000_000_000;
const AT = { deviceId: "a", exclave: "main", clone: "app" };

function box(cl: number | null = CL): Pick<Machine, "deviceId" | "status"> {
  return { deviceId: "a", status: { at: 1, scan: 1, cpu: 0, mem: 0, free: 1, ...(cl === null ? {} : { cl }) } };
}

function task(id: string, fields: Partial<Task> = {}, spec: Partial<TaskSpec> = {}): Task {
  return {
    id,
    spec: { repo: "github.com/acme/app", mode: "worktree", prompt: "go", ...spec },
    state: "running",
    createdAt: CL - 10_000,
    assignment: AT,
    ...fields,
  };
}

const pane = (taskId?: string): SessionEntry => ({
  window: "w",
  repo: "app",
  path: "/x",
  ...(taskId === undefined ? {} : { taskId }),
});

const successorOf = (id: string, fields: Partial<Task> = {}, createdAt = CL + 1): Task =>
  task(
    id,
    { state: "ready", createdAt, assignment: undefined, ...fields },
    { succeeds: { task: "old", account: "org:a", at: AT, trigger: "drain" } },
  );

describe("drainView", () => {
  test("a running task moves; a needs-input one moves and waits on you", () => {
    const view = drainView(box(), [task("t1"), task("t2", { state: "needs-input" })], [pane("t1"), pane("t2")]);
    expect(view.moving).toEqual([
      { taskId: "t1", waitingOnYou: false, idle: false },
      { taskId: "t2", waitingOnYou: true, idle: false },
    ]);
    expect(view.stuck).toEqual([]);
    expect(view.empty).toBe(false);
  });

  test("a task run in place is stuck here", () => {
    expect(drainView(box(), [task("t1", {}, { mode: "here" })], [pane("t1")]).stuck).toEqual([
      { taskId: "t1", reason: "here" },
    ]);
  });

  test("a refusal stamped at this close is stuck with its code, at an older close it is still moving", () => {
    const refused = { at: CL, tried: CL + 1, refused: "dirty_worktree" } as const;
    expect(drainView(box(), [task("t1", { drained: refused })], [pane("t1")]).stuck).toEqual([
      { taskId: "t1", reason: "refused", code: "dirty_worktree" },
    ]);
    const older = drainView(box(), [task("t1", { drained: { ...refused, at: CL - 1 } })], [pane("t1")]);
    expect(older.stuck).toEqual([]);
    expect(older.moving).toHaveLength(1);
  });

  test("a task already carrying its successor counts as moved", () => {
    const view = drainView(box(), [task("t1", { successor: "s1" })], [pane("t1")]);
    expect(view.moved).toEqual(["s1"]);
    expect(view.moving).toEqual([]);
  });

  test("a drain successor waiting for a machine is stuck unplaced; one running or settled is moved; an older one is ignored", () => {
    const view = drainView(
      box(),
      [
        successorOf("s1"),
        successorOf("s2", { state: "running" }),
        successorOf("s3", { state: "done" }),
        successorOf("s4", {}, CL - 1),
      ],
      [],
    );
    expect(view.stuck).toEqual([{ taskId: "s1", reason: "unplaced" }]);
    expect(view.moved).toEqual(["s2", "s3"]);
    expect(view.empty).toBe(true);
  });

  test("a successor named by a still-running predecessor and waiting for a machine is counted once, as stuck", () => {
    const view = drainView(box(), [task("old", { successor: "s1" }), successorOf("s1")], [pane("old")]);
    expect(view.stuck).toEqual([{ taskId: "s1", reason: "unplaced" }]);
    expect(view.moved).toEqual([]);
  });

  test("a pane with no task is stuck untasked; one whose task is not listed counts as moving", () => {
    const view = drainView(box(), [], [pane(), pane("unlisted")]);
    expect(view.stuck).toEqual([{ reason: "untasked" }]);
    expect(view.moving).toEqual([{ taskId: "unlisted", waitingOnYou: false, idle: false }]);
  });

  test("sessions that could not be read leave empty unknown", () => {
    expect(drainView(box(), [task("t1")], null)).toMatchObject({ empty: null, moving: [{ taskId: "t1" }] });
  });

  test("no panes is empty", () => {
    expect(drainView(box(), [], []).empty).toBe(true);
  });

  test("an open machine counts moving, here and untasked, never stamps or successors", () => {
    const view = drainView(
      box(null),
      [
        task("t1"),
        task("t2", {}, { mode: "here" }),
        task("t3", { drained: { at: CL, tried: 1, refused: "push_failed" } }),
        successorOf("s1"),
      ],
      [pane(), pane("t1"), pane("t2"), pane("t3")],
      // The confirm sheet's prospective list: what a drain would do.
      { draining: true },
    );
    expect(view.moving.map((m) => m.taskId)).toEqual(["t1", "t3"]);
    expect(view.stuck).toEqual([{ taskId: "t2", reason: "here" }, { reason: "untasked" }]);
    expect(view.moved).toEqual([]);
  });

  test("an override stands in for a status that lags the close", () => {
    const refused = { at: CL, tried: 1, refused: "push_failed" } as const;
    const view = drainView(box(null), [task("t1", { drained: refused }), successorOf("s1")], [pane("t1")], { cl: CL });
    expect(view.stuck.map((s) => s.reason)).toEqual(["refused", "unplaced"]);
  });

  test("a task on another machine is not this one's", () => {
    const elsewhere = task("t1", { assignment: { ...AT, deviceId: "b" } });
    expect(drainView(box(), [elsewhere], []).moving).toEqual([]);
  });
});

describe("drainView on a soft close", () => {
  const SOFT = [CAPABILITIES.softClose];
  const soft = (dr?: number): Pick<Machine, "deviceId" | "status" | "capabilities"> => ({
    deviceId: "a",
    status: { at: 1, scan: 1, cl: CL, ...(dr === undefined ? {} : { dr }) },
    capabilities: SOFT,
  });

  test("a softClose machine with no dr is not draining; with dr, or without softClose, it is", () => {
    expect(drainView(soft(), [], []).draining).toBe(false);
    expect(drainView(soft(CL + 5), [], []).draining).toBe(true);
    expect(drainView(box(), [], []).draining).toBe(true);
    // A client that just sent the drain knows it before the status says so.
    expect(drainView(soft(), [], [], { draining: true }).draining).toBe(true);
  });

  test("a task run in place is still running there, not stuck; an untasked pane is still stuck", () => {
    const view = drainView(soft(), [task("t1", {}, { mode: "here" })], [pane("t1"), pane()]);
    expect(view.moving).toEqual([{ taskId: "t1", waitingOnYou: false, idle: false }]);
    expect(view.stuck).toEqual([{ reason: "untasked" }]);
  });

  test("tells a running task from one idle at its prompt and one waiting on you, listed or only a pane", () => {
    const view = drainView(
      soft(),
      [task("busy"), task("idle"), task("asks", { state: "needs-input" })],
      [pane("busy"), pane("idle"), pane("asks"), pane("unlisted")],
      { idle: ["idle", "unlisted"] },
    );
    expect(view.moving).toEqual([
      { taskId: "busy", waitingOnYou: false, idle: false },
      { taskId: "idle", waitingOnYou: false, idle: true },
      { taskId: "asks", waitingOnYou: true, idle: false },
      { taskId: "unlisted", waitingOnYou: false, idle: true },
    ]);
    expect(drainSummary(view)).toBe("running 1 · 2 idle at their prompt · 1 waiting on you");
  });
});

describe("drainStuckText and drainSummary", () => {
  test("each reason has its fixed words; a refusal is the scheduler's sentence", () => {
    expect(drainStuckText({ reason: "here" })).toBe("Can't move: runs in the clone");
    expect(drainStuckText({ reason: "untasked" })).toBe("Not a task: close it yourself");
    expect(drainStuckText({ reason: "unplaced" })).toBe("Moved, waiting for a machine");
    expect(drainStuckText({ reason: "refused", code: "dirty_worktree" })).toMatch(/uncommitted/u);
  });

  test("the summary reads moving and stuck counts, then empty", () => {
    const base = { draining: true, moved: [], empty: false } as const;
    const stuck = [{ reason: "here" } as const];
    const one = [{ taskId: "a", waitingOnYou: false, idle: false }];
    expect(drainSummary({ ...base, moving: one, stuck: [] })).toBe("moving 1");
    expect(drainSummary({ ...base, moving: one, stuck })).toBe("moving 1 · 1 stuck");
    expect(drainSummary({ ...base, moving: [], stuck })).toBe("1 stuck");
    expect(drainSummary({ ...base, moving: [], stuck: [], empty: true })).toBe("empty");
    expect(drainSummary({ ...base, moving: [], stuck: [], empty: null })).toBe("sessions unknown");
  });

  test("a soft close reads what it waits on: running, one idle at its prompt, waiting on you; else as draining", () => {
    const base = { draining: false, moved: [], stuck: [], empty: false } as const;
    const idle = { taskId: "b", waitingOnYou: false, idle: true };
    expect(drainSummary({ ...base, moving: [{ taskId: "a", waitingOnYou: false, idle: false }] })).toBe("running 1");
    expect(drainSummary({ ...base, moving: [idle] })).toBe("1 idle at its prompt");
    // Waiting on you wins over idle: a needs-input task is never counted twice.
    expect(drainSummary({ ...base, moving: [{ ...idle, waitingOnYou: true }] })).toBe("1 waiting on you");
    expect(drainSummary({ ...base, moving: [], empty: true })).toBe("empty");
    expect(drainSummary({ ...base, moving: [], empty: null })).toBe("sessions unknown");
  });
});

describe("the close's leader note", () => {
  const target = { deviceId: "dev-1" };

  test("only the verified leader leads the queue: never an unverified nominee, no leader, or another machine", () => {
    expect(leadsQueue(target, { kind: "ready", deviceId: "dev-1", term: 2 })).toBe(true);
    expect(leadsQueue(target, { kind: "unverified", deviceId: "dev-1", term: 2 })).toBe(false);
    expect(leadsQueue(target, { kind: "none" })).toBe(false);
    expect(leadsQueue(target, { kind: "ready", deviceId: "dev-2", term: 2 })).toBe(false);
  });

  test("says the queue stops while it is down, and claims nothing about another machine", () => {
    expect(leaderCloseNote("Thad")).toBe(
      "Thad runs the queue: while it is down, the queue stops unless another machine can take over.",
    );
  });
});
