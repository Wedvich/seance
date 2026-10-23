import { describe, expect, test } from "bun:test";
import {
  CAPABILITIES,
  PR_STATUS_REFRESH_MS,
  type BranchState,
  type DespawnRequest,
  type DespawnResponse,
  type PrStatus,
  type TaskProgress,
  wantsPrReading,
} from "@seance/shared";
import { DEFAULT_CONFIG, MemoryQueueStore, Scheduler, type Task } from "../src/index.ts";
import { branchChange, ended, prBound, progressed } from "../src/done.ts";
import { enqueue, FakeFleet, machine, NOW, readerChecked, spec } from "./fixtures.ts";

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
  const scheduler = new Scheduler({
    store: readerChecked(store, () => clock.now),
    fleet,
    config,
    now: () => clock.now,
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
    const { fleet, clock, scheduler, store } = setup(new FakeFleet([machine("a")]), {
      ...DEFAULT_CONFIG,
      globalMax: 1,
    });
    const first = await enqueue(store, scheduler, spec());
    const second = await enqueue(store, scheduler, spec());
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
    const { scheduler, store } = setup();
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    await scheduler.onSession(task.id, "ended", FROM_A);
    expect(scheduler.task(task.id)).toMatchObject({ state: "done", doneBy: "session" });
  });

  test("a PR reported while it runs is recorded, and the end reads it", async () => {
    const { store, scheduler } = setup();
    const task = await enqueue(store, scheduler, spec());
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

describe("a session's exit status", () => {
  const reporting = (): FakeFleet =>
    new FakeFleet([
      machine("a", { capabilities: [CAPABILITIES.metrics, CAPABILITIES.taskId, CAPABILITIES.exitStatus] }),
    ]);

  const dying = { id: "%1", window: "w", repo: "app", path: "/wt/t", taskId: "t" } as const;

  test("from a machine that reports it, a PR-less end waits for the answer: nonzero fails the task and its dependents", async () => {
    const { fleet, scheduler, put } = setup(reporting());
    await put("t", { assignment: ON_A });
    await put("dep", { state: "queued", spec: spec({ deps: [{ task: "t", after: "merged" }] }) });
    await scheduler.load();
    // Asked at once; claude is still shutting down, so its session is still listed.
    fleet.sessionsReply = () => ({ ok: true, sessions: [dying] });
    await scheduler.onSession("t", "ended", FROM_A);
    await scheduler.drain();
    expect(fleet.sessionCalls).toEqual(["a"]);
    expect(scheduler.task("t")?.state).toBe("running");

    // Asked again on the next pass, sweep or not.
    fleet.sessionsReply = () => ({ ok: true, sessions: [], ended: ["t"], progress: [progress("t", { exit: 1 })] });
    await pass(scheduler);
    expect(fleet.sessionCalls).toEqual(["a", "a"]);
    expect(scheduler.task("t")).toMatchObject({ state: "failed", failure: { code: "session_failed" } });
    expect(scheduler.task("dep")).toMatchObject({ state: "failed", failure: { code: "dependency_failed" } });
  });

  test("exit 0 is done, and a settled task is no longer asked for between sweeps", async () => {
    const { fleet, scheduler, put } = setup(reporting());
    await put("t", { assignment: ON_A });
    await scheduler.load();
    fleet.sessionsReply = () => ({ ok: true, sessions: [], ended: ["t"], progress: [progress("t", { exit: 0 })] });
    await scheduler.onSession("t", "ended", FROM_A);
    await scheduler.drain();
    expect(scheduler.task("t")).toMatchObject({ state: "done", doneBy: "session" });
    await pass(scheduler);
    expect(fleet.sessionCalls).toEqual(["a"]);
  });

  test("no status in the answer (a signal, an old tmux) is done, as before", async () => {
    const { fleet, scheduler, put } = setup(reporting());
    await put("t", { assignment: ON_A });
    await scheduler.load();
    fleet.sessionsReply = () => ({ ok: true, sessions: [], ended: ["t"] });
    await scheduler.onSession("t", "ended", FROM_A);
    await scheduler.drain();
    expect(scheduler.task("t")).toMatchObject({ state: "done", doneBy: "session" });
  });

  test("a PR or a believed merge outranks a nonzero exit", async () => {
    const { fleet, scheduler, put } = setup(reporting());
    await put("pr", { assignment: ON_A });
    await put("merged", { assignment: { ...ON_A, pane: "%2" } });
    fleet.sessionsReply = () => ({
      ok: true,
      sessions: [],
      ended: ["pr", "merged"],
      progress: [
        progress("pr", { prUrl: PR, exit: 2 }),
        progress("merged", { branch: "m", pushed: true, merged: true, exit: 137 }),
      ],
    });
    await scheduler.takeover();
    expect(scheduler.task("pr")?.state).toBe("awaiting-merge");
    expect(scheduler.task("merged")).toMatchObject({ state: "done", doneBy: "merged" });
  });

  test("an end with a PR settles on the event, whatever the machine reports", async () => {
    const { scheduler, put } = setup(reporting());
    await put("t", { assignment: ON_A });
    await scheduler.load();
    await scheduler.onSession("t", "ended", FROM_A, PR);
    expect(scheduler.task("t")?.state).toBe("awaiting-merge");
  });

  test("a claude that stays listed past the deadline settles as the event would have, and is asked no more", async () => {
    const { fleet, clock, scheduler, put } = setup(reporting());
    await put("t", { assignment: ON_A });
    await scheduler.load();
    fleet.sessionsReply = () => ({ ok: true, sessions: [dying] });
    await scheduler.onSession("t", "ended", FROM_A);
    await scheduler.drain();
    clock.now += DEFAULT_CONFIG.endingTimeoutMs - 1;
    await pass(scheduler);
    expect(scheduler.task("t")?.state).toBe("running");
    expect(fleet.sessionCalls).toEqual(["a", "a"]);

    // Past the deadline it waits for one read begun after it that still lists the session.
    clock.now += 1;
    await pass(scheduler);
    expect(scheduler.task("t")?.state).toBe("running");
    expect(fleet.sessionCalls).toEqual(["a", "a", "a"]);
    await pass(scheduler);
    expect(scheduler.task("t")).toMatchObject({ state: "done", doneBy: "session" });
    await pass(scheduler);
    expect(fleet.sessionCalls).toEqual(["a", "a", "a"]);
  });

  test("a check still out at the deadline is waited for: its late exit fails the task and its dependents", async () => {
    class GatedFleet extends FakeFleet {
      gate: Promise<void> | null = null;
      override async sessions(deviceId: string): ReturnType<FakeFleet["sessions"]> {
        const waiting = this.gate;
        const reply = await super.sessions(deviceId);
        await waiting;
        return reply;
      }
    }
    const fleet = new GatedFleet([
      machine("a", { capabilities: [CAPABILITIES.metrics, CAPABILITIES.taskId, CAPABILITIES.exitStatus] }),
    ]);
    const { clock, scheduler, put } = setup(fleet);
    await put("t", { assignment: ON_A });
    await put("dep", { state: "queued", spec: spec({ deps: [{ task: "t", after: "merged" }] }) });
    await scheduler.load();
    fleet.sessionsReply = () => ({ ok: true, sessions: [dying] });
    await scheduler.onSession("t", "ended", FROM_A);
    await scheduler.drain();

    // The next read is begun before the deadline and answers after it, with the exit.
    let release = (): void => {};
    fleet.gate = new Promise<void>((resolve) => (release = resolve));
    fleet.sessionsReply = () => ({ ok: true, sessions: [], ended: ["t"], progress: [progress("t", { exit: 3 })] });
    clock.now += DEFAULT_CONFIG.endingTimeoutMs - 1;
    await scheduler.tick();
    clock.now += 1;
    await scheduler.tick();
    expect(scheduler.task("t")?.state).toBe("running");

    release();
    await scheduler.drain();
    expect(scheduler.task("t")).toMatchObject({ state: "failed", failure: { code: "session_failed" } });
    expect(scheduler.task("dep")).toMatchObject({ state: "failed", failure: { code: "dependency_failed" } });
  });

  test("a disconnected machine's task settles on the deadline alone", async () => {
    const { fleet, clock, scheduler, put } = setup(reporting());
    await put("t", { assignment: ON_A });
    await scheduler.load();
    fleet.sessionsReply = () => ({ ok: true, sessions: [dying] });
    await scheduler.onSession("t", "ended", FROM_A);
    await scheduler.drain();
    fleet.fleet = [{ ...fleet.fleet[0]!, connected: false }];
    clock.now += DEFAULT_CONFIG.endingTimeoutMs;
    await pass(scheduler);
    expect(scheduler.task("t")).toMatchObject({ state: "done", doneBy: "session" });
  });

  test("a leader that took over with nothing deferred settles a task failed from the ledger's exit", async () => {
    const { fleet, scheduler, put } = setup(reporting());
    await put("t", { assignment: ON_A });
    fleet.sessionsReply = () => ({ ok: true, sessions: [], ended: ["t"], progress: [progress("t", { exit: 1 })] });
    await scheduler.takeover();
    expect(scheduler.task("t")).toMatchObject({ state: "failed", failure: { code: "session_failed" } });
  });

  test("a sweep settles a task failed the same way, with no event ever seen", async () => {
    const { fleet, clock, scheduler, put } = setup(reporting());
    await put("t", { assignment: ON_A });
    await scheduler.load();
    fleet.sessionsReply = () => ({ ok: true, sessions: [], ended: ["t"], progress: [progress("t", { exit: 1 })] });
    clock.now += DEFAULT_CONFIG.sweepIntervalMs;
    await pass(scheduler);
    expect(scheduler.task("t")).toMatchObject({ state: "failed", failure: { code: "session_failed" } });
  });

  test("a deferred end is dropped when the task is cancelled meanwhile: the deadline settles nothing", async () => {
    const { fleet, clock, scheduler, put } = setup(reporting());
    await put("t", { assignment: ON_A });
    await scheduler.load();
    fleet.sessionsReply = () => ({ ok: true, sessions: [dying] });
    await scheduler.onSession("t", "ended", FROM_A);
    await scheduler.drain();
    expect(await scheduler.cancel("t")).toMatchObject({ ok: true, task: { state: "cancelled" } });
    fleet.sessionCalls.length = 0;
    clock.now += DEFAULT_CONFIG.endingTimeoutMs;
    await pass(scheduler);
    expect(scheduler.task("t")?.state).toBe("cancelled");
    expect(fleet.sessionCalls).toEqual([]);
  });

  test("a machine that disconnects while its task awaits its exit settles it, never `lost`", async () => {
    const config = { ...DEFAULT_CONFIG, lostAfterMs: 1_000 };
    const { fleet, clock, scheduler, put } = setup(reporting(), config);
    await put("t", { assignment: ON_A });
    await scheduler.load();
    fleet.sessionsReply = () => ({ ok: true, sessions: [dying] });
    await scheduler.onSession("t", "ended", FROM_A);
    await scheduler.drain();
    fleet.fleet = [{ ...fleet.fleet[0]!, connected: false }];
    await pass(scheduler);
    clock.now += config.lostAfterMs;
    await pass(scheduler);
    expect(clock.now - NOW).toBeLessThan(config.endingTimeoutMs);
    expect(scheduler.task("t")).toMatchObject({ state: "done", doneBy: "session" });
  });

  test("an end from a machine the task is not on defers nothing: it is not asked about, nor settled", async () => {
    const fleet = new FakeFleet([
      machine("a", { capabilities: [CAPABILITIES.metrics, CAPABILITIES.taskId, CAPABILITIES.exitStatus] }),
      machine("b", { capabilities: [CAPABILITIES.metrics, CAPABILITIES.taskId, CAPABILITIES.exitStatus] }),
    ]);
    // The first pass sweeps whatever the interval; what is checked is the asking after it.
    const { clock, scheduler, put } = setup(fleet, { ...DEFAULT_CONFIG, sweepIntervalMs: 24 * 60 * 60_000 });
    await put("t", { assignment: ON_A });
    await scheduler.load();
    await scheduler.onSession("t", "ended", { deviceId: "b", pane: "%9" });
    await scheduler.drain();
    fleet.sessionCalls.length = 0;
    clock.now += DEFAULT_CONFIG.endingTimeoutMs;
    await scheduler.tick();
    await scheduler.drain();
    expect(scheduler.task("t")?.state).toBe("running");
    expect(fleet.sessionCalls).toEqual([]);
  });

  test("an end that resolves a reservation places it on the reporting pane, and the answer settles it", async () => {
    const { fleet, scheduler, put } = setup(reporting());
    await put("t", {
      state: "reserved",
      reservation: { deviceId: "a", exclave: "main", clone: "app", expiresAt: NOW + 60_000 },
      reservedAt: NOW,
    });
    await scheduler.load();
    fleet.sessionsReply = () => ({ ok: true, sessions: [dying] });
    await scheduler.onSession("t", "ended", FROM_A);
    await scheduler.drain();
    expect(scheduler.task("t")).toMatchObject({ state: "running", assignment: { deviceId: "a", pane: "%1" } });
    fleet.sessionsReply = () => ({ ok: true, sessions: [], ended: ["t"], progress: [progress("t", { exit: 1 })] });
    await pass(scheduler);
    expect(scheduler.task("t")?.state).toBe("failed");
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

describe("the merge clock from a reservation", () => {
  test("an ended event with a PR open on a reserved task starts it", async () => {
    const { clock, scheduler, put } = setup();
    await put("r", {
      state: "reserved",
      reservation: { deviceId: "a", exclave: "main", clone: "app", expiresAt: NOW + 120_000 },
      reservedAt: NOW,
    });
    await scheduler.load();
    clock.now += 3000;
    await scheduler.onSession("r", "ended", FROM_A, PR);
    expect(scheduler.task("r")).toMatchObject({ state: "awaiting-merge", prUrl: PR, endedAt: NOW + 3000 });
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

describe("markDone", () => {
  test("settles every unfinished, unreserved state as done by hand, ending the session of a running, needs-input or reachable lost one", async () => {
    const { fleet, scheduler, put } = setup();
    const states = ["queued", "blocked", "ready", "running", "needs-input", "lost", "awaiting-merge"] as const;
    for (const state of states) {
      // oxlint-disable-next-line no-await-in-loop -- one record per state
      await put(state, { state, ...(["queued", "blocked", "ready"].includes(state) ? {} : { assignment: ON_A }) });
    }
    await scheduler.load();
    for (const state of states) {
      // oxlint-disable-next-line no-await-in-loop -- each settles in turn
      const result = await scheduler.markDone(state);
      expect(result).toMatchObject({ ok: true, task: { id: state, state: "done", doneBy: "manual" } });
    }
    // A done task holds no slot, so its session must not keep running past the caps.
    expect(fleet.despawns).toEqual([
      { deviceId: "a", id: "%1" },
      { deviceId: "a", id: "%1" },
      { deviceId: "a", id: "%1" },
    ]);
  });

  test("a lost task whose machine is away is done with nothing despawned, and marked leftRunning as a cancel marks it", async () => {
    const { fleet, scheduler, put } = setup(new FakeFleet([machine("a", { connected: false })]));
    await put("away", { state: "lost", assignment: ON_A, absentSince: NOW });
    await put("ran", { state: "running", assignment: ON_A });
    await scheduler.load();
    expect(await scheduler.markDone("away")).toMatchObject({
      ok: true,
      task: { state: "done", doneBy: "manual", leftRunning: true },
    });
    expect(fleet.despawns).toEqual([]);
    // Only a lost task: one settled with its session ended is not left running.
    fleet.fleet = [machine("a")];
    const ran = await scheduler.markDone("ran");
    expect(ran.ok ? ran.task.leftRunning : "refused").toBeUndefined();
  });

  test("a session whose ended event lands during the despawn is answered as it finished, or settled by hand when it went to awaiting-merge", async () => {
    let scheduler: Scheduler | undefined;
    let pr: string | undefined;
    class EndsOnExit extends FakeFleet {
      override async despawn(deviceId: string, request: DespawnRequest): Promise<DespawnResponse> {
        const reply = await super.despawn(deviceId, request);
        await scheduler?.onSession("t", "ended", FROM_A, pr);
        return reply;
      }
    }
    const first = setup(new EndsOnExit([machine("a")]));
    scheduler = first.scheduler;
    await first.put("t", { state: "running", assignment: ON_A });
    await scheduler.load();
    expect(await scheduler.markDone("t")).toMatchObject({ ok: true, task: { state: "done" } });

    pr = PR;
    const second = setup(new EndsOnExit([machine("a")]));
    scheduler = second.scheduler;
    await second.put("t", { state: "running", assignment: ON_A });
    await scheduler.load();
    expect(await scheduler.markDone("t")).toMatchObject({ ok: true, task: { state: "done", doneBy: "manual" } });
  });

  test("a running task whose machine refuses the despawn stays running: refused, never marked done over a live session", async () => {
    class Refusing extends FakeFleet {
      override async despawn(): Promise<DespawnResponse> {
        return { ok: false, code: "internal_error", message: "refused" };
      }
    }
    const { scheduler, put } = setup(new Refusing([machine("a")]));
    await put("t", { state: "running", assignment: ON_A });
    await scheduler.load();
    expect(await scheduler.markDone("t")).toEqual({ ok: false, code: "despawn_failed" });
    expect(scheduler.task("t")?.state).toBe("running");
  });

  test("refuses a reserved task as dispatching, a finished one as finished, an unknown id as not_found", async () => {
    const { scheduler, put } = setup();
    await put("res", {
      state: "reserved",
      reservation: { deviceId: "a", exclave: "main", clone: "app", expiresAt: NOW + 60_000 },
      reservedAt: NOW,
    });
    for (const state of ["done", "failed", "cancelled"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one record per state
      await put(state, { state });
    }
    await scheduler.load();
    expect(await scheduler.markDone("res")).toEqual({ ok: false, code: "dispatching" });
    for (const state of ["done", "failed", "cancelled"]) {
      // oxlint-disable-next-line no-await-in-loop -- one answer per state
      expect(await scheduler.markDone(state)).toEqual({ ok: false, code: "finished" });
    }
    expect(await scheduler.markDone("nope")).toEqual({ ok: false, code: "not_found" });
  });

  test("conflicts that outlast the write attempts are conflict, and the task is unchanged", async () => {
    const { store, scheduler, put } = setup();
    await put("t", { state: "running", assignment: ON_A });
    await scheduler.load();
    for (let i = 0; i < 3; i += 1) store.failNext({ code: "version_conflict" });
    expect(await scheduler.markDone("t")).toEqual({ ok: false, code: "conflict" });
    expect(scheduler.task("t")?.state).toBe("running");
  });

  test("releases an after: merged dependent on the next pass, and a later ended event leaves the task done", async () => {
    const { scheduler, put } = setup();
    await put("pred", { state: "awaiting-merge", assignment: ON_A, prUrl: PR });
    await put("next", { state: "queued", spec: spec({ deps: [{ task: "pred", after: "merged" }] }) });
    await scheduler.load();
    await pass(scheduler);
    expect(scheduler.task("next")?.state).toBe("blocked");

    expect(await scheduler.markDone("pred")).toMatchObject({ ok: true });
    await pass(scheduler);
    expect(scheduler.task("next")?.state).toBe("running");

    await scheduler.onSession("pred", "ended", FROM_A);
    expect(scheduler.task("pred")).toMatchObject({ state: "done", doneBy: "manual" });
  });
});

/** `until: "reported"` (#21), on the pure functions: a merge is recorded and settles nothing; the report, or a clean PR-less exit, does. */
describe("until: reported", () => {
  const running = (until: "merged" | "reported", fields: Partial<Task> = {}): Task => ({
    id: "t",
    spec: spec({ until }),
    state: "running",
    createdAt: NOW,
    assignment: ON_A,
    ...fields,
  });
  const merged = { branch: "b", pushed: true, merged: true } as const;

  test("progressed: a believed merge is recorded, not settled; under merged it still settles", () => {
    expect(progressed(running("reported"), merged)).toMatchObject({ state: "running", merged: true });
    expect(progressed(running("merged"), merged)).toMatchObject({ state: "done", doneBy: "merged" });
    const open = running("reported", { merged: true, branch: "b", pushed: true });
    expect(progressed(open, merged)).toBe(open);
  });

  test("progressed: a merge that is not believed (never pushed) is not recorded", () => {
    const next = progressed(running("reported"), { branch: "b", merged: true });
    expect(next.state).toBe("running");
    expect(next.merged).toBeUndefined();
  });

  test("progressed: the report settles it done by reported; under merged it is ignored (a switch is deliberate)", () => {
    expect(progressed(running("reported"), { reported: true })).toMatchObject({ state: "done", doneBy: "reported" });
    const awaiting = running("reported", { state: "awaiting-merge", prUrl: PR });
    expect(progressed(awaiting, { reported: true })).toMatchObject({ state: "done", doneBy: "reported" });
    const ignored = running("merged");
    expect(progressed(ignored, { reported: true })).toBe(ignored);
  });

  test("ended: a merge with a PR is awaiting-merge with merged recorded; under merged it is done", () => {
    expect(ended(running("reported", { prUrl: PR }), merged)).toMatchObject({ state: "awaiting-merge", merged: true });
    expect(ended(running("merged", { prUrl: PR }), merged)).toMatchObject({ state: "done", doneBy: "merged" });
  });

  test("ended: the report wins, a PR-less clean exit still settles by session, a failed one still fails", () => {
    expect(ended(running("reported", { prUrl: PR }), { reported: true })).toMatchObject({
      state: "done",
      doneBy: "reported",
    });
    expect(ended(running("reported"), undefined)).toMatchObject({ state: "done", doneBy: "session" });
    expect(ended(running("reported"), { exit: 0 })).toMatchObject({ state: "done", doneBy: "session" });
    expect(ended(running("reported"), { exit: 1 })).toMatchObject({
      state: "failed",
      failure: { code: "session_failed" },
    });
    expect(ended(running("merged"), { reported: true })).toMatchObject({ state: "done", doneBy: "session" });
  });

  test("branchChange: a live merge is recorded on a reported task", () => {
    const state: BranchState = { taskId: "t", repo: "r", branch: "b", pushed: true, merged: true, at: NOW };
    expect(branchChange(running("reported"), state, "a")).toMatchObject({ state: "running", merged: true });
    expect(branchChange(running("merged"), state, "a")).toMatchObject({ state: "done", doneBy: "merged" });
  });
});

describe("PR status", () => {
  const READ = NOW + 1_000;
  const reading = (state: PrStatus["state"], at = READ, checks?: PrStatus["checks"]): PrStatus => ({
    state,
    ...(checks === undefined ? {} : { checks }),
    at,
  });
  const version = async (store: MemoryQueueStore, id: string): Promise<number | undefined> =>
    (await store.get(id))?.version;

  test("(1) an open reading is recorded; the same one a minute later writes nothing", async () => {
    const { scheduler, put, store } = setup();
    await put("t", { assignment: ON_A, prUrl: PR });
    await scheduler.load();
    await scheduler.onPrStatus("t", PR, reading("open", READ, "pending"));
    expect(scheduler.task("t")).toMatchObject({ state: "running", pr: { state: "open", checks: "pending", at: READ } });
    const written = await version(store, "t");
    await scheduler.onPrStatus("t", PR, reading("open", READ + 60_000, "pending"));
    expect(await version(store, "t")).toBe(written);
    expect(scheduler.task("t")?.pr?.at).toBe(READ);
  });

  test("(2) the same reading PR_STATUS_REFRESH_MS later refreshes `at`", async () => {
    const { scheduler, put, store } = setup();
    await put("t", { assignment: ON_A, prUrl: PR });
    await scheduler.load();
    await scheduler.onPrStatus("t", PR, reading("open"));
    const written = await version(store, "t");
    await scheduler.onPrStatus("t", PR, reading("open", READ + PR_STATUS_REFRESH_MS));
    expect(await version(store, "t")).toBe((written ?? 0) + 1);
    expect(scheduler.task("t")?.pr?.at).toBe(READ + PR_STATUS_REFRESH_MS);
  });

  test("(3) changed checks write, and a lost `checks` is dropped, not kept", async () => {
    const { scheduler, put } = setup();
    await put("t", { assignment: ON_A, prUrl: PR });
    await scheduler.load();
    await scheduler.onPrStatus("t", PR, reading("open", READ, "pending"));
    await scheduler.onPrStatus("t", PR, reading("open", READ + 1, "failing"));
    expect(scheduler.task("t")?.pr).toEqual({ state: "open", checks: "failing", at: READ + 1 });
    await scheduler.onPrStatus("t", PR, reading("open", READ + 2));
    expect(scheduler.task("t")?.pr).toEqual({ state: "open", at: READ + 2 });
  });

  test("(4) a reading for another URL than the task's writes nothing, even a merge", async () => {
    const { scheduler, put, store } = setup();
    await put("t", { assignment: ON_A, prUrl: PR });
    await put("bare", { assignment: { ...ON_A, pane: "%2" } });
    await scheduler.load();
    const written = await version(store, "t");
    await scheduler.onPrStatus("t", "https://github.com/acme/app/pull/8", reading("merged"));
    await scheduler.onPrStatus("bare", PR, reading("merged"));
    expect(await version(store, "t")).toBe(written);
    expect(scheduler.task("t")?.state).toBe("running");
    expect(scheduler.task("bare")).toMatchObject({ state: "running" });
    expect(scheduler.task("bare")?.pr).toBeUndefined();
  });

  test("(5) a merge settles a running, a needs-input, an awaiting-merge and a `here` task with no push; a live session is marked leftRunning", async () => {
    const { scheduler, put } = setup();
    await put("run", { assignment: ON_A, prUrl: PR });
    await put("input", { state: "needs-input", assignment: { ...ON_A, pane: "%2" }, prUrl: PR });
    await put("wait", { state: "awaiting-merge", assignment: { ...ON_A, pane: "%3" }, prUrl: PR });
    await put("here", { assignment: { ...ON_A, pane: "%4" }, prUrl: PR, spec: spec({ mode: "here" }) });
    await scheduler.load();
    for (const id of ["run", "input", "wait", "here"]) {
      await scheduler.onPrStatus(id, PR, reading("merged", READ, "passing"));
      expect(scheduler.task(id)).toMatchObject({ state: "done", doneBy: "merged", pr: { state: "merged" } });
      expect(scheduler.task(id)?.pushed).toBeUndefined();
      expect(scheduler.task(id)?.leftRunning).toBe(id === "wait" ? undefined : true);
    }
  });

  test("(6) a merge on a lost task settles it, marked leftRunning", async () => {
    const { scheduler, put } = setup();
    await put("t", { state: "lost", assignment: ON_A, prUrl: PR, absentSince: NOW });
    await scheduler.load();
    await scheduler.onPrStatus("t", PR, reading("merged"));
    expect(scheduler.task("t")).toMatchObject({ state: "done", doneBy: "merged", leftRunning: true });
  });

  test("(6b) a settle by branch state or by hand drops an open reading, read once more; a merge settle keeps its own", async () => {
    const { scheduler, put } = setup();
    await put("t", { assignment: ON_A, prUrl: PR });
    await put("m", { assignment: { ...ON_A, pane: "%2" }, prUrl: PR });
    await scheduler.load();
    for (const id of ["t", "m"]) {
      await scheduler.onPrStatus(id, PR, reading("open", READ, "pending"));
    }
    await scheduler.onBranchState(
      { taskId: "t", repo: "app", branch: "fix", pushed: true, merged: false, at: NOW },
      "a",
    );
    await scheduler.onBranchState(
      { taskId: "t", repo: "app", branch: "fix", pushed: true, merged: true, at: NOW },
      "a",
    );
    await scheduler.markDone("m");
    for (const id of ["t", "m"]) {
      const task = scheduler.task(id);
      expect(task?.state).toBe("done");
      expect(task?.pr).toBeUndefined();
      expect(task === undefined ? false : wantsPrReading(task)).toBe(true);
      await scheduler.onPrStatus(id, PR, reading("merged", READ + 1, "passing"));
      const read = scheduler.task(id);
      expect(read).toMatchObject({ state: "done", pr: { state: "merged", checks: "passing", at: READ + 1 } });
      expect(read === undefined ? true : wantsPrReading(read)).toBe(false);
    }
    expect(scheduler.task("t")?.doneBy).toBe("merged");
    expect(scheduler.task("m")?.doneBy).toBe("manual");
  });

  test("(7) under until: reported a merge is recorded, settles nothing, and releases an after-merged dependent", async () => {
    const { fleet, scheduler, put } = setup();
    await put("t", { assignment: ON_A, prUrl: PR, spec: spec({ until: "reported" }) });
    await put("dep", { state: "queued", spec: spec({ deps: [{ task: "t", after: "merged" }] }) });
    await scheduler.load();
    await pass(scheduler);
    expect(fleet.spawns).toEqual([]);
    await scheduler.onPrStatus("t", PR, reading("merged"));
    expect(scheduler.task("t")).toMatchObject({ state: "running", merged: true, pr: { state: "merged" } });
    expect(scheduler.task("t")?.doneBy).toBeUndefined();
    await pass(scheduler);
    expect(fleet.spawns.map((s) => s.request.taskId)).toEqual(["dep"]);
  });

  test("(7b) a second identical merged reading a minute later on that task writes nothing", async () => {
    const { scheduler, put, store } = setup();
    await put("t", { assignment: ON_A, prUrl: PR, spec: spec({ until: "reported" }) });
    await scheduler.load();
    await scheduler.onPrStatus("t", PR, reading("merged"));
    const written = await version(store, "t");
    await scheduler.onPrStatus("t", PR, reading("merged", READ + 60_000));
    expect(await version(store, "t")).toBe(written);
  });

  test("(7c) nor does one past the refresh window: a merged chip never greys, so it needs no refresh", async () => {
    const { scheduler, put, store } = setup();
    await put("t", { assignment: ON_A, prUrl: PR, spec: spec({ until: "reported" }) });
    await scheduler.load();
    await scheduler.onPrStatus("t", PR, reading("merged"));
    const written = await version(store, "t");
    await scheduler.onPrStatus("t", PR, reading("merged", READ + 6 * 60_000));
    expect(await version(store, "t")).toBe(written);
    expect(scheduler.task("t")?.pr?.at).toBe(READ);
  });

  test("(7d) a merge into a non-default branch is recorded, settles nothing and releases no dependent", async () => {
    const { fleet, scheduler, put } = setup();
    await put("t", { assignment: ON_A, prUrl: PR });
    await put("wait", { state: "awaiting-merge", assignment: { ...ON_A, pane: "%2" }, prUrl: PR });
    await put("rep", { assignment: { ...ON_A, pane: "%3" }, prUrl: PR, spec: spec({ until: "reported" }) });
    await put("dep", { state: "queued", spec: spec({ deps: [{ task: "wait", after: "merged" }] }) });
    await scheduler.load();
    const stacked: PrStatus = { state: "merged", stacked: true, at: READ };
    for (const id of ["t", "wait", "rep"]) await scheduler.onPrStatus(id, PR, stacked);
    expect(scheduler.task("t")).toMatchObject({ state: "running", pr: stacked });
    expect(scheduler.task("wait")).toMatchObject({ state: "awaiting-merge", pr: stacked });
    expect(scheduler.task("rep")).toMatchObject({ state: "running", pr: stacked });
    expect(scheduler.task("rep")?.merged).toBeUndefined();
    await pass(scheduler);
    expect(fleet.spawns).toEqual([]);
    // The same PR read again at the default branch (retargeted, or its parent landed) settles as any merge does.
    await scheduler.onPrStatus("t", PR, reading("merged", READ + 1_000));
    expect(scheduler.task("t")).toMatchObject({ state: "done", doneBy: "merged" });
    expect(scheduler.task("t")?.pr).toEqual({ state: "merged", at: READ + 1_000 });
  });

  test("(8) closed is recorded and moves nothing", async () => {
    const { scheduler, put } = setup();
    await put("t", { assignment: ON_A, prUrl: PR });
    await scheduler.load();
    await scheduler.onPrStatus("t", PR, reading("closed"));
    expect(scheduler.task("t")).toMatchObject({ state: "running", pr: { state: "closed" } });
  });

  test("(9) a finished task already read, a waiting and a reserved task are left alone", async () => {
    const { scheduler, put, store } = setup();
    await put("done", { state: "done", doneBy: "manual", prUrl: PR, pr: reading("open", NOW) });
    await put("queued", { state: "queued", prUrl: PR });
    await put("reserved", { state: "reserved", prUrl: PR });
    await scheduler.load();
    const ids = ["done", "queued", "reserved"];
    const before = await Promise.all(ids.map((id) => version(store, id)));
    for (const id of ids) await scheduler.onPrStatus(id, PR, reading("merged"));
    expect(await Promise.all(ids.map((id) => version(store, id)))).toEqual(before);
    expect(scheduler.task("done")?.pr).toEqual(reading("open", NOW));
  });

  test("(9b) a finished task with no reading takes one, once, and nothing else moves", async () => {
    const { fleet, scheduler, put, store } = setup();
    await put("done", { state: "done", doneBy: "manual", prUrl: PR });
    await put("failed", { state: "failed", prUrl: PR, spec: spec({ until: "reported" }) });
    await put("dep", { state: "queued", spec: spec({ deps: [{ task: "failed", after: "merged" }] }) });
    await scheduler.load();
    await scheduler.onPrStatus("done", PR, reading("merged"));
    await scheduler.onPrStatus("failed", PR, reading("merged"));
    expect(scheduler.task("done")).toMatchObject({ state: "done", doneBy: "manual", pr: { state: "merged" } });
    expect(scheduler.task("failed")).toMatchObject({ state: "failed", pr: { state: "merged" } });
    expect(scheduler.task("failed")?.merged).toBeUndefined();
    const written = await version(store, "done");
    await scheduler.onPrStatus("done", PR, reading("closed", READ + PR_STATUS_REFRESH_MS));
    expect(await version(store, "done")).toBe(written);
    await pass(scheduler);
    expect(fleet.spawns).toEqual([]);
  });

  test("(10) a reading whose clock is behind the stored one still settles a merge and refreshes an unchanged one", async () => {
    const { scheduler, put } = setup();
    await put("t", { assignment: ON_A, prUrl: PR });
    await put("u", { assignment: { ...ON_A, pane: "%2" }, prUrl: PR });
    await scheduler.load();
    await scheduler.onPrStatus("t", PR, reading("open", READ + 600_000));
    await scheduler.onPrStatus("t", PR, reading("open", READ));
    expect(scheduler.task("t")?.pr?.at).toBe(READ);
    await scheduler.onPrStatus("u", PR, reading("open", READ + 600_000));
    await scheduler.onPrStatus("u", PR, reading("merged", READ));
    expect(scheduler.task("u")).toMatchObject({ state: "done", doneBy: "merged" });
  });

  test("(11) a session event that moves prUrl drops the reading", async () => {
    const { scheduler, put } = setup();
    const next = "https://github.com/acme/app/pull/9";
    await put("t", { assignment: ON_A, prUrl: PR, pr: reading("open") });
    await scheduler.load();
    await scheduler.onSession("t", "busy", FROM_A, next);
    expect(scheduler.task("t")).toMatchObject({ state: "running", prUrl: next });
    expect(scheduler.task("t")?.pr).toBeUndefined();
  });

  test("prBound keeps a reading while prUrl stays, drops it when prUrl moves", () => {
    const before: Task = { id: "t", spec: spec(), state: "running", createdAt: NOW, prUrl: PR, pr: reading("open") };
    expect(prBound(before, { ...before, branch: "b" })).toEqual({ ...before, branch: "b" });
    const moved = prBound(before, { ...before, prUrl: "https://github.com/acme/app/pull/9" });
    expect(moved.pr).toBeUndefined();
    expect(moved.prUrl).toBe("https://github.com/acme/app/pull/9");
  });
});
