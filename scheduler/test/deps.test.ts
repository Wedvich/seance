import { describe, expect, test } from "bun:test";
import { DEP_MISSING_GRACE_MS, STORE_TOMBSTONE_MS, type TaskDep } from "@seance/shared";
import { MemoryQueueStore, Scheduler, type Task } from "../src/index.ts";
import { prunable } from "../src/prune.ts";
import { FakeFleet, machine, NOW, readerChecked, spec } from "./fixtures.ts";

/**
 * Admission and hand-declared dependencies (M3 item 4a, PR 0b's semantics),
 * through the scheduler over `MemoryQueueStore`: tasks are put as an app (or a
 * previous leader) left them, and a pass admits them.
 */

const PR = "https://github.com/acme/app/pull/7";
const ON_A = { deviceId: "a", exclave: "main", clone: "app", pane: "%1" } as const;

function setup(fleet = new FakeFleet([machine("a")])) {
  const clock = { now: NOW };
  const store = new MemoryQueueStore({ now: () => clock.now });
  const scheduler = new Scheduler({ store: readerChecked(store, () => clock.now), fleet, now: () => clock.now });
  async function put(id: string, fields: Partial<Task> = {}): Promise<void> {
    const write = await store.put(id, 0, { id, spec: spec(), state: "queued", createdAt: clock.now, ...fields });
    if (!write.ok) throw new Error(`put ${id}: ${write.code}`);
  }
  return { store, fleet, clock, scheduler, put };
}

function after(task: string, edge: TaskDep["after"]): Pick<Task, "spec"> {
  return { spec: spec({ deps: [{ task, after: edge }] }) };
}

async function pass(scheduler: Scheduler): Promise<void> {
  await scheduler.tick();
  await scheduler.drain();
}

function states(scheduler: Scheduler, ...ids: string[]): Record<string, string | undefined> {
  return Object.fromEntries(ids.map((id) => [id, scheduler.task(id)?.state]));
}

describe("admission", () => {
  test("a queued task with nothing to wait on is admitted and dispatched in the same pass", async () => {
    const { store, fleet, scheduler, put } = setup();
    await scheduler.load();
    // An app's create, reaching a running leader through `store-changed`.
    await put("q");
    await scheduler.refresh("q");
    await pass(scheduler);
    expect(fleet.spawns.map((s) => s.request.taskId)).toEqual(["q"]);
    // Create, admit, reserve, run: one write per transition.
    expect((await store.get("q"))?.version).toBe(4);
    expect(scheduler.task("q")?.state).toBe("running");
  });

  test("a queued task older than the tombstone window fails, and its dependents with it: an authentic blob may have been put back", async () => {
    const { clock, fleet, scheduler, put } = setup();
    await put("old", { createdAt: clock.now - STORE_TOMBSTONE_MS - 1 });
    await put("edge", { createdAt: clock.now - STORE_TOMBSTONE_MS });
    await put("dependent", after("old", "merged"));
    await scheduler.load();
    await pass(scheduler);
    expect(states(scheduler, "old", "edge", "dependent")).toEqual({
      old: "failed",
      edge: "running",
      dependent: "failed",
    });
    expect(scheduler.task("old")?.failure?.code).toBe("queue_expired");
    expect(scheduler.task("dependent")?.failure?.code).toBe("dependency_failed");
    expect(fleet.spawns.map((s) => s.request.taskId)).toEqual(["edge"]);
    // Finished, so the prune path can take both.
    expect(
      prunable(scheduler.tasks(), 0)
        .map((t) => t.id)
        .toSorted(),
    ).toEqual(["dependent", "old"]);
  });

  test("an expired task on a loop gives its loop-mate dependency_failed, not dependency_cycle", async () => {
    const { clock, scheduler, put } = setup();
    await put("x", { createdAt: clock.now - STORE_TOMBSTONE_MS - 1, ...after("y", "merged") });
    await put("y", { state: "blocked", ...after("x", "merged") });
    await scheduler.load();
    await pass(scheduler);
    expect(scheduler.task("x")?.failure?.code).toBe("queue_expired");
    expect(scheduler.task("y")).toMatchObject({ state: "failed", failure: { code: "dependency_failed" } });
  });
});

describe("release", () => {
  test("after: opened waits for a PR and a pushed branch; a `here` predecessor's PR alone releases it", async () => {
    const { fleet, scheduler, put } = setup();
    await put("tree", { state: "running", assignment: ON_A });
    await put("here", { state: "running", assignment: { ...ON_A, pane: "%2" }, spec: spec({ mode: "here" }) });
    await put("onTree", after("tree", "opened"));
    await put("onHere", after("here", "opened"));
    await scheduler.load();
    await pass(scheduler);
    expect(states(scheduler, "onTree", "onHere")).toEqual({ onTree: "blocked", onHere: "blocked" });

    await scheduler.onSession("tree", "busy", { deviceId: "a", pane: "%1" }, PR);
    await scheduler.onSession("here", "busy", { deviceId: "a", pane: "%2" }, PR);
    expect(scheduler.task("tree")?.prUrl).toBe(PR);
    await pass(scheduler);
    expect(states(scheduler, "onTree", "onHere")).toEqual({ onTree: "blocked", onHere: "running" });

    await scheduler.onBranchState(
      { taskId: "tree", repo: "app", branch: "fix", pushed: true, merged: false, at: NOW },
      "a",
    );
    await pass(scheduler);
    expect(scheduler.task("onTree")?.state).toBe("running");
    expect(fleet.spawns.map((s) => s.request.taskId)).toEqual(["onHere", "onTree"]);
  });

  test("after: merged waits through awaiting-merge and releases on the merge", async () => {
    const { scheduler, put } = setup();
    await put("pred", { state: "running", assignment: ON_A, prUrl: PR, pushed: true });
    await put("next", after("pred", "merged"));
    await scheduler.load();
    await scheduler.onSession("pred", "ended", { deviceId: "a", pane: "%1" });
    await pass(scheduler);
    expect(states(scheduler, "pred", "next")).toEqual({ pred: "awaiting-merge", next: "blocked" });

    await scheduler.onBranchState(
      { taskId: "pred", repo: "app", branch: "fix", pushed: true, merged: true, at: NOW },
      "a",
    );
    expect(scheduler.task("pred")).toMatchObject({ state: "done", doneBy: "merged" });
    await pass(scheduler);
    expect(scheduler.task("next")?.state).toBe("running");
  });

  test("a `here` predecessor's merge is not believed: after: merged waits for done", async () => {
    const { store, scheduler, put } = setup();
    await put("here", { state: "running", assignment: ON_A, spec: spec({ mode: "here" }), prUrl: PR });
    await put("next", after("here", "merged"));
    await scheduler.load();
    await scheduler.onBranchState(
      { taskId: "here", repo: "app", branch: "main", pushed: true, merged: true, at: NOW },
      "a",
    );
    await pass(scheduler);
    expect(states(scheduler, "here", "next")).toEqual({ here: "running", next: "blocked" });
    expect(scheduler.task("here")?.pushed).toBeUndefined();

    const held = await store.get("here");
    const finished: Task = {
      id: "here",
      spec: spec({ mode: "here" }),
      state: "done",
      createdAt: NOW,
      prUrl: PR,
      doneBy: "manual",
    };
    await store.put("here", held?.reason === undefined ? (held?.version ?? 0) : 0, finished);
    await scheduler.refresh("here");
    await pass(scheduler);
    expect(scheduler.task("next")?.state).toBe("running");
  });

  test("done releases every edge, whatever settled it", async () => {
    const { scheduler, put } = setup(new FakeFleet([]));
    await put("manual", { state: "done", doneBy: "manual" });
    await put("opened", after("manual", "opened"));
    await put("merged", after("manual", "merged"));
    await scheduler.load();
    await pass(scheduler);
    expect(states(scheduler, "opened", "merged")).toEqual({ opened: "ready", merged: "ready" });
  });

  test("a lost predecessor is waited on, never failed for", async () => {
    const { clock, scheduler, put } = setup(new FakeFleet([machine("b", { connected: false })]));
    await put("gone", { state: "lost", assignment: { ...ON_A, deviceId: "b" }, absentSince: NOW });
    await put("next", after("gone", "opened"));
    await scheduler.load();
    await pass(scheduler);
    clock.now += DEP_MISSING_GRACE_MS * 2;
    await pass(scheduler);
    expect(states(scheduler, "gone", "next")).toEqual({ gone: "lost", next: "blocked" });
  });
});

describe("edges that never release", () => {
  test("a failed or cancelled predecessor fails its dependents, through every level, in one pass", async () => {
    const { scheduler, put } = setup(new FakeFleet([]));
    await put("broken", { state: "failed", failure: { code: "repo_not_found", message: "gone" } });
    await put("dropped", { state: "cancelled" });
    await put("child", after("broken", "opened"));
    await put("grandchild", after("child", "merged"));
    await put("other", after("dropped", "merged"));
    await scheduler.load();
    await pass(scheduler);
    for (const id of ["child", "grandchild", "other"]) {
      expect(scheduler.task(id)).toMatchObject({ state: "failed", failure: { code: "dependency_failed" } });
    }
    expect(scheduler.task("grandchild")?.failure?.message).toContain("child");
  });

  test("a failure cascades to a fixpoint whatever order the chain was stored in", async () => {
    const { scheduler, put } = setup(new FakeFleet([]));
    await put("grandchild", after("child", "merged"));
    await put("child", after("broken", "opened"));
    await put("broken", { state: "failed", failure: { code: "repo_not_found", message: "gone" } });
    await scheduler.load();
    await pass(scheduler);
    expect(states(scheduler, "child", "grandchild")).toEqual({ child: "failed", grandchild: "failed" });
  });

  test("a cancelled predecessor fails its dependents, whatever its PR: only one already released stays so", async () => {
    const { scheduler, put } = setup(new FakeFleet([]));
    await put("pred", { state: "cancelled", prUrl: PR, pushed: true });
    await put("stacked", after("pred", "opened"));
    await put("landing", after("pred", "merged"));
    await scheduler.load();
    await pass(scheduler);
    expect(scheduler.task("stacked")).toMatchObject({ state: "failed", failure: { code: "dependency_failed" } });
    expect(scheduler.task("landing")).toMatchObject({ state: "failed", failure: { code: "dependency_failed" } });
  });

  test("a predecessor failing later fails a blocked dependent", async () => {
    const { scheduler, put } = setup();
    await put("pred", { state: "running", assignment: ON_A });
    await put("next", after("pred", "merged"));
    await scheduler.load();
    await pass(scheduler);
    expect(scheduler.task("next")?.state).toBe("blocked");
    expect(await scheduler.cancel("pred")).toMatchObject({ ok: true });
    await pass(scheduler);
    expect(scheduler.task("next")).toMatchObject({ state: "failed", failure: { code: "dependency_failed" } });
  });

  test("a cycle fails every member at admission, a self-edge included; a task depending on one fails by cascade", async () => {
    const { scheduler, put } = setup(new FakeFleet([]));
    await put("a", after("b", "opened"));
    await put("b", after("a", "merged"));
    await put("self", after("self", "opened"));
    await put("tail", after("a", "opened"));
    await scheduler.load();
    await pass(scheduler);
    for (const id of ["a", "b", "self"]) {
      expect(scheduler.task(id)).toMatchObject({ state: "failed", failure: { code: "dependency_cycle" } });
    }
    expect(scheduler.task("tail")).toMatchObject({ state: "failed", failure: { code: "dependency_failed" } });
  });

  test("a finished task's edges are not a loop: a cancelled member's dependent fails as dependency_failed", async () => {
    const { scheduler, put } = setup(new FakeFleet([]));
    await put("dropped", { ...after("tail", "opened"), state: "cancelled" });
    await put("tail", after("dropped", "merged"));
    await put("finished", { ...after("after", "opened"), state: "done" });
    await put("after", after("finished", "merged"));
    await scheduler.load();
    await pass(scheduler);
    expect(scheduler.task("tail")).toMatchObject({ state: "failed", failure: { code: "dependency_failed" } });
    expect(scheduler.task("after")?.state).toBe("ready");
  });

  test("a cycle closed by a later create fails the member already blocked too", async () => {
    const { scheduler, put } = setup(new FakeFleet([]));
    await put("first", after("second", "opened"));
    await scheduler.load();
    await pass(scheduler);
    expect(scheduler.task("first")?.state).toBe("blocked");
    await put("second", after("first", "opened"));
    await scheduler.refresh("second");
    await pass(scheduler);
    expect(states(scheduler, "first", "second")).toEqual({ first: "failed", second: "failed" });
  });

  test("a missing predecessor waits out the grace from the dependent's own createdAt; an unreadable one is held, and waits", async () => {
    const { store, clock, scheduler, put } = setup(new FakeFleet([]));
    await put("orphan", after("ghost", "opened"));
    await put("early", after("late", "merged"));
    await put("onJunk", after("junk", "opened"));
    store.plant("junk", "unopenable");
    await scheduler.load();
    await pass(scheduler);
    expect(states(scheduler, "orphan", "early", "onJunk")).toEqual({
      orphan: "blocked",
      early: "blocked",
      onJunk: "blocked",
    });

    // A batch put one record at a time: the predecessor lands after its dependent.
    clock.now += DEP_MISSING_GRACE_MS - 1;
    await put("late", { state: "done", doneBy: "manual" });
    await scheduler.refresh("late");
    await pass(scheduler);
    expect(scheduler.task("early")?.state).toBe("ready");
    expect(scheduler.task("orphan")?.state).toBe("blocked");

    clock.now += 1;
    await pass(scheduler);
    expect(scheduler.task("orphan")).toMatchObject({ state: "failed", failure: { code: "dependency_missing" } });
    expect(scheduler.task("onJunk")?.state).toBe("blocked");
  });
});
