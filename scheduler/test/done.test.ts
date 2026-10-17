import { describe, expect, test } from "bun:test";
import type { TaskProgress } from "@seance/shared";
import { DEFAULT_CONFIG, MemoryQueueStore, Scheduler, type Task } from "../src/index.ts";
import { FakeFleet, machine, NOW, spec } from "./fixtures.ts";

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
  const scheduler = new Scheduler({ store, fleet, config, now: () => clock.now, newId: () => `t${++n}` });
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
    const { fleet, scheduler } = setup(new FakeFleet([machine("a")]), { ...DEFAULT_CONFIG, globalMax: 1 });
    const first = await scheduler.submit(spec());
    const second = await scheduler.submit(spec());
    await pass(scheduler);
    expect(scheduler.lastDecision(second.id)?.candidates[0]?.rejected).toContainEqual({
      code: "cap_reached",
      inFlight: 1,
      max: 1,
    });

    await scheduler.onSession(first.id, "ended", FROM_A, PR);
    expect(scheduler.task(first.id)).toMatchObject({ state: "awaiting-merge", prUrl: PR });
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
        progress("waiting", { merged: true }),
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
    fleet.sessionsReply = () => ({ ok: true, sessions: [], progress: [progress("t", { prUrl: PR, merged: true })] });
    await pass(scheduler);
    expect(fleet.sessionCalls).toEqual(["a"]);
    expect(scheduler.task("t")).toMatchObject({ state: "done", doneBy: "merged" });
  });
});
