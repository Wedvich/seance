import { describe, expect, test } from "bun:test";
import type { BranchState, TaskProgress } from "@seance/shared";
import { DEFAULT_CONFIG, MemoryQueueStore, Scheduler, type Task } from "../src/index.ts";
import { FakeFleet, machine, NOW, readerChecked, spec } from "./fixtures.ts";

/**
 * Done detection (M3 item 4a): a session's end read against its PR, a branch's
 * merge, and what a leader reads back from `progress` after a gap.
 */

const PR = "https://github.com/acme/app/pull/7";
const FROM_A = { deviceId: "a", pane: "%1" } as const;
const ON_A = { deviceId: "a", exclave: "main", clone: "app", pane: "%1" } as const;

function setup(fleet = new FakeFleet([machine("a")]), config = DEFAULT_CONFIG) {
  const clock = { now: NOW };
  const store = new MemoryQueueStore({ now: () => clock.now });
  let n = 0;
  const scheduler = new Scheduler({
    store: readerChecked(store, () => clock.now),
    fleet,
    config,
    now: () => clock.now,
    newId: () => `t${++n}`,
  });
  async function put(id: string, fields: Partial<Task> = {}): Promise<void> {
    const write = await store.put(id, 0, { id, spec: spec(), state: "running", createdAt: clock.now, ...fields });
    if (!write.ok) throw new Error(`put ${id}: ${write.code}`);
  }
  return { store, fleet, clock, scheduler, put };
}

async function pass(scheduler: Scheduler): Promise<void> {
  await scheduler.tick();
  await scheduler.drain();
}

function progress(taskId: string, fields: Partial<TaskProgress> = {}): TaskProgress {
  return { taskId, at: NOW, ...fields };
}

describe("a session that ends", () => {
  test("with a PR open is awaiting-merge, and frees its slot for the next task", async () => {
    const { fleet, clock, scheduler } = setup(new FakeFleet([machine("a")]), { ...DEFAULT_CONFIG, globalMax: 1 });
    const first = await scheduler.submit(spec());
    const second = await scheduler.submit(spec());
    await pass(scheduler);
    expect(scheduler.lastDecision(second.id)?.candidates[0]?.rejected).toContainEqual({
      code: "cap_reached",
      inFlight: 1,
      max: 1,
    });

    await scheduler.onSession(first.id, "ended", FROM_A, PR);
    expect(scheduler.task(first.id)).toMatchObject({ state: "awaiting-merge", prUrl: PR, endedAt: clock.now });
    await pass(scheduler);
    expect(fleet.spawns.map((s) => s.request.taskId)).toEqual([first.id, second.id]);
  });

  test("with no PR is done by its session", async () => {
    const { scheduler } = setup();
    const task = await scheduler.submit(spec());
    await pass(scheduler);
    await scheduler.onSession(task.id, "ended", FROM_A);
    expect(scheduler.task(task.id)).toMatchObject({ state: "done", doneBy: "session" });
  });

  test("a PR reported while it runs is recorded, and the end reads it", async () => {
    const { store, scheduler } = setup();
    const task = await scheduler.submit(spec());
    await pass(scheduler);
    const before = (await store.get(task.id))?.version ?? 0;
    await scheduler.onSession(task.id, "busy", FROM_A, PR);
    await scheduler.onSession(task.id, "busy", FROM_A, PR);
    expect(scheduler.task(task.id)).toMatchObject({ state: "running", prUrl: PR });
    expect((await store.get(task.id))?.version).toBe(before + 1);
    await scheduler.onSession(task.id, "ended", FROM_A);
    expect(scheduler.task(task.id)?.state).toBe("awaiting-merge");
  });
});

describe("branch-state", () => {
  test("only the task's own machine moves it, and a merge is believed only of a branch with work on it", async () => {
    const { scheduler, put } = setup();
    await put("t", { assignment: ON_A });
    await scheduler.load();
    const state = { taskId: "t", repo: "app", branch: "fix", pushed: false, merged: true, at: NOW };

    await scheduler.onBranchState(state, "b");
    expect(scheduler.task("t")?.branch).toBeUndefined();
    // A fresh branch with no commits is an ancestor of the default branch: `merged`, and no work.
    await scheduler.onBranchState(state, "a");
    expect(scheduler.task("t")).toMatchObject({ state: "running", branch: "fix" });

    await scheduler.onBranchState({ ...state, pushed: true, merged: false }, "a");
    expect(scheduler.task("t")).toMatchObject({ state: "running", pushed: true });
    // `pushed` never goes back: the first pushed report released `after: "opened"` for good.
    await scheduler.onBranchState({ ...state, merged: false }, "a");
    expect(scheduler.task("t")?.pushed).toBe(true);

    await scheduler.onBranchState(state, "a");
    expect(scheduler.task("t")).toMatchObject({ state: "done", doneBy: "merged" });
  });
});

describe("progress, read back", () => {
  test("a leader that takes over after a gap settles an ended session with an open PR as awaiting-merge, and a merged one as done", async () => {
    const { fleet, scheduler, put } = setup();
    await put("open", { assignment: ON_A });
    await put("merged", { assignment: { ...ON_A, pane: "%2" } });
    await put("waiting", { state: "awaiting-merge", assignment: { ...ON_A, pane: "%3" }, prUrl: PR });
    await put("live", { assignment: { ...ON_A, pane: "%4" } });
    fleet.sessionsReply = () => ({
      ok: true,
      sessions: [{ id: "%4", window: "w4", repo: "app", path: "/wt/live", taskId: "live" }],
      ended: ["open", "merged", "waiting"],
      progress: [
        progress("open", { prUrl: PR, branch: "open", pushed: true }),
        progress("merged", { prUrl: PR, branch: "merged", pushed: true, merged: true }),
        progress("waiting", { pushed: true, merged: true }),
        progress("live", { prUrl: PR, pushed: true }),
      ],
    });
    await scheduler.takeover();
    expect(scheduler.task("open")).toMatchObject({ state: "awaiting-merge", prUrl: PR, branch: "open", pushed: true });
    expect(scheduler.task("merged")).toMatchObject({ state: "done", doneBy: "merged" });
    expect(scheduler.task("waiting")).toMatchObject({ state: "done", doneBy: "merged" });
    // Still running, but what it reported while no leader listened is on the record.
    expect(scheduler.task("live")).toMatchObject({ state: "running", prUrl: PR, pushed: true });
  });

  test("in a trimmed reply a session-less task with no entry is unknown, and waits", async () => {
    const { fleet, scheduler, put } = setup();
    await put("t", { assignment: ON_A });
    fleet.sessionsReply = () => ({ ok: true, sessions: [], progress: [], progressTrimmed: 3 });
    await scheduler.takeover();
    expect(scheduler.task("t")?.state).toBe("running");
  });

  test("in a trimmed reply a session-less task whose record holds a PR settles by it, freeing its slot", async () => {
    const { fleet, scheduler, put } = setup();
    await put("t", { assignment: ON_A, prUrl: PR });
    fleet.sessionsReply = () => ({ ok: true, sessions: [], progress: [], progressTrimmed: 3 });
    await scheduler.takeover();
    expect(scheduler.task("t")).toMatchObject({ state: "awaiting-merge", prUrl: PR });

    // A later untrimmed read still settles the merge the trimmed one could not show.
    fleet.sessionsReply = () => ({
      ok: true,
      sessions: [],
      progress: [progress("t", { prUrl: PR, branch: "t", pushed: true, merged: true })],
    });
    await scheduler.takeover();
    expect(scheduler.task("t")).toMatchObject({ state: "done", doneBy: "merged" });
  });

  test("a daemon that sends no progress settles a session-less task by the PR its record holds", async () => {
    const { fleet, scheduler, put } = setup();
    await put("withPr", { assignment: ON_A, prUrl: PR });
    await put("without", { assignment: { ...ON_A, pane: "%2" } });
    fleet.sessionsReply = () => ({ ok: true, sessions: [] });
    await scheduler.takeover();
    expect(scheduler.task("withPr")?.state).toBe("awaiting-merge");
    expect(scheduler.task("without")).toMatchObject({ state: "done", doneBy: "session" });
  });

  test("a machine back from an absence has its awaiting-merge tasks read back; a connected one is not asked each pass", async () => {
    const { fleet, scheduler, put } = setup();
    await put("t", { state: "awaiting-merge", assignment: ON_A, prUrl: PR });
    await scheduler.load();
    await pass(scheduler);
    expect(fleet.sessionCalls).toEqual([]);

    fleet.fleet = [machine("a", { connected: false })];
    await pass(scheduler);
    fleet.fleet = [machine("a")];
    fleet.sessionsReply = () => ({
      ok: true,
      sessions: [],
      progress: [progress("t", { prUrl: PR, pushed: true, merged: true })],
    });
    await pass(scheduler);
    expect(fleet.sessionCalls).toEqual(["a"]);
    expect(scheduler.task("t")).toMatchObject({ state: "done", doneBy: "merged" });
  });
});

function branchState(branch: string, fields: { pushed?: boolean; merged?: boolean } = {}): BranchState {
  return { taskId: "t", repo: "app", branch, pushed: fields.pushed ?? false, merged: fields.merged ?? false, at: NOW };
}

describe("branch-state", () => {
  test("a branch switch starts unpushed: the new branch's ancestor-merge is not the old one's PR landing", async () => {
    const { scheduler, put } = setup();
    await put("t", { assignment: ON_A, prUrl: PR, branch: "feat", pushed: true });
    await scheduler.load();
    await scheduler.onBranchState(branchState("scratch", { merged: true }), "a");
    const task = scheduler.task("t");
    expect(task).toMatchObject({ state: "running", branch: "scratch", prUrl: PR });
    expect(task?.pushed).toBeUndefined();

    // Merged work on the branch it switched to, once pushed there, is believed.
    await scheduler.onBranchState(branchState("scratch", { pushed: true, merged: true }), "a");
    expect(scheduler.task("t")).toMatchObject({ state: "done", doneBy: "merged" });
  });

  test("after a branch switch a second report on the new branch still does not settle it on the old branch's PR", async () => {
    const { scheduler, put } = setup();
    await put("t", { assignment: ON_A, prUrl: PR, branch: "feat", pushed: true });
    await scheduler.load();
    await scheduler.onBranchState(branchState("scratch", { merged: true }), "a");
    await scheduler.onBranchState(branchState("scratch", { merged: true }), "a");
    expect(scheduler.task("t")).toMatchObject({ state: "running", branch: "scratch", prUrl: PR });
  });

  test("a first-ever report naming a branch counts as its current one: merged without a push does not settle, after a push it does", async () => {
    const { scheduler, put } = setup();
    await put("t", { assignment: ON_A, prUrl: PR });
    await put("u", { assignment: { ...ON_A, pane: "%2" }, prUrl: PR });
    await scheduler.load();
    await scheduler.onBranchState({ ...branchState("x", { merged: true }), taskId: "t" }, "a");
    expect(scheduler.task("t")).toMatchObject({ state: "running", branch: "x" });

    await scheduler.onBranchState({ ...branchState("x", { pushed: true }), taskId: "u" }, "a");
    await scheduler.onBranchState({ ...branchState("x", { merged: true }), taskId: "u" }, "a");
    expect(scheduler.task("u")).toMatchObject({ state: "done", doneBy: "merged" });
  });

  test("pushed never reverts within one branch", async () => {
    const { scheduler, put } = setup();
    await put("t", { assignment: ON_A, branch: "feat" });
    await scheduler.load();
    await scheduler.onBranchState(branchState("feat", { pushed: true }), "a");
    await scheduler.onBranchState(branchState("feat"), "a");
    expect(scheduler.task("t")?.pushed).toBe(true);
  });

  test("a `here` task's branch is the checkout's: pushed and merged are ignored", async () => {
    const { scheduler, put } = setup();
    await put("t", { assignment: ON_A, prUrl: PR, spec: spec({ mode: "here" }) });
    await scheduler.load();
    await scheduler.onBranchState(branchState("main", { pushed: true, merged: true }), "a");
    const task = scheduler.task("t");
    expect(task).toMatchObject({ state: "running", branch: "main" });
    expect(task?.pushed).toBeUndefined();
  });
});

describe("the sweep", () => {
  test("applies progress to a live task and reads an awaiting-merge one, so a lost merge is picked up", async () => {
    const { fleet, clock, scheduler, put } = setup();
    await put("live", { assignment: ON_A });
    await put("waiting", { state: "awaiting-merge", assignment: { ...ON_A, pane: "%2" }, prUrl: PR });
    await scheduler.load();
    fleet.sessionsReply = () => ({
      ok: true,
      sessions: [{ id: "%1", window: "w1", repo: "app", path: "/wt/live", taskId: "live" }],
      progress: [
        progress("live", { prUrl: PR, branch: "live", pushed: true }),
        progress("waiting", { pushed: true, merged: true }),
      ],
    });
    await pass(scheduler);
    expect(fleet.sessionCalls).toEqual([]);

    clock.now += DEFAULT_CONFIG.sweepIntervalMs;
    await pass(scheduler);
    expect(fleet.sessionCalls).toEqual(["a"]);
    expect(scheduler.task("live")).toMatchObject({ state: "running", prUrl: PR, branch: "live", pushed: true });
    expect(scheduler.task("waiting")).toMatchObject({ state: "done", doneBy: "merged" });
  });
});

describe("the merge clock", () => {
  test("is stamped on entering awaiting-merge only: a record an older leader left there is never given one by a later write", async () => {
    const { fleet, clock, scheduler, put } = setup();
    await put("legacy", { state: "awaiting-merge", assignment: ON_A, prUrl: PR });
    await scheduler.load();
    fleet.sessionsReply = () => ({
      ok: true,
      sessions: [],
      progress: [progress("legacy", { prUrl: PR, branch: "fresh" })],
    });
    clock.now += DEFAULT_CONFIG.sweepIntervalMs;
    await pass(scheduler);
    const task = scheduler.task("legacy");
    expect(task).toMatchObject({ state: "awaiting-merge", branch: "fresh" });
    expect(task?.endedAt).toBeUndefined();
  });
});

describe("a `here` task awaiting merge", () => {
  test("is left out of the sweep: no reply can change it", async () => {
    const { fleet, clock, scheduler, put } = setup();
    await put("t", { state: "awaiting-merge", assignment: ON_A, prUrl: PR, spec: spec({ mode: "here" }) });
    await scheduler.load();
    clock.now += DEFAULT_CONFIG.sweepIntervalMs;
    await pass(scheduler);
    expect(fleet.sessionCalls).toEqual([]);
  });
});

describe("a trimmed reply", () => {
  test("leaves a reservation whose id is in `ended` unsettled, as it does a placed task", async () => {
    const { fleet, scheduler, put } = setup();
    const reservation = { deviceId: "a", exclave: "main", clone: "app", expiresAt: NOW - 1 };
    await put("t", { state: "reserved", reservation, reservedAt: NOW - 1000 });
    await scheduler.load();
    fleet.sessionsReply = () => ({ ok: true, sessions: [], ended: ["t"], progress: [], progressTrimmed: 2 });
    await pass(scheduler);
    expect(scheduler.task("t")?.state).toBe("reserved");

    fleet.sessionsReply = () => ({
      ok: true,
      sessions: [],
      ended: ["t"],
      progress: [progress("t", { prUrl: PR })],
      progressTrimmed: 1,
    });
    await pass(scheduler);
    expect(scheduler.task("t")).toMatchObject({ state: "awaiting-merge", prUrl: PR });
  });
});
