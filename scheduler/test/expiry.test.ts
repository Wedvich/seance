import { describe, expect, test } from "bun:test";
import type { TaskDep } from "@seance/shared";
import { DEFAULT_CONFIG, MemoryQueueStore, Scheduler, type Task } from "../src/index.ts";
import type { DespawnRequest, DespawnResponse, Machine } from "@seance/shared";
import { prunable } from "../src/prune.ts";
import { FakeFleet, machine, NOW, readerChecked, spec, unreachable } from "./fixtures.ts";

/**
 * Expiry (M3 item 3 follow-up): a `lost` or `awaiting-merge` task past its
 * bound fails, in the pass, after the `sessions` checks and before admission.
 */

const PR = "https://github.com/acme/app/pull/7";
const ON_A = { deviceId: "a", exclave: "main", clone: "app", pane: "%1" } as const;
const LOST_MS = DEFAULT_CONFIG.lostExpiryMs;
const MERGE_MS = DEFAULT_CONFIG.mergeExpiryMs;

function setup(fleet = new FakeFleet([machine("a", { connected: false })])) {
  const clock = { now: NOW };
  const store = new MemoryQueueStore({ now: () => clock.now });
  const scheduler = new Scheduler({ store: readerChecked(store, () => clock.now), fleet, now: () => clock.now });
  async function put(id: string, fields: Partial<Task> = {}): Promise<void> {
    const write = await store.put(id, 0, { id, spec: spec(), state: "queued", createdAt: clock.now, ...fields });
    if (!write.ok) throw new Error(`put ${id}: ${write.code}`);
  }
  return { store, fleet, clock, scheduler, put };
}

async function pass(scheduler: Scheduler): Promise<void> {
  await scheduler.tick();
  await scheduler.drain();
}

function after(task: string, edge: TaskDep["after"]): Pick<Task, "spec"> {
  return { spec: spec({ deps: [{ task, after: edge }] }) };
}

const lost = (absentSince: number): Partial<Task> => ({ state: "lost", assignment: ON_A, absentSince });
const waiting = (fields: Partial<Task> = {}): Partial<Task> => ({
  state: "awaiting-merge",
  assignment: ON_A,
  prUrl: PR,
  ...fields,
});

describe("a lost task", () => {
  test("stays lost at the bound and fails lost_expired a millisecond past it, spawning and despawning nothing", async () => {
    const { fleet, clock, scheduler, put } = setup();
    await put("t", lost(NOW - LOST_MS));
    await scheduler.load();
    await pass(scheduler);
    expect(scheduler.task("t")?.state).toBe("lost");

    clock.now += 1;
    await pass(scheduler);
    const task = scheduler.task("t");
    expect(task).toMatchObject({ state: "failed", failure: { code: "lost_expired" }, assignment: ON_A });
    expect(task?.absentSince).toBeUndefined();
    expect(task?.failure?.message).toContain(new Date(NOW - LOST_MS).toISOString());
    expect(fleet.spawns).toEqual([]);
    expect(fleet.despawns).toEqual([]);
  });

  test("ages from createdAt when its record has no absentSince", async () => {
    const { scheduler, put } = setup();
    await put("t", { state: "lost", assignment: ON_A, createdAt: NOW - LOST_MS - 1 });
    await scheduler.load();
    await pass(scheduler);
    const message = scheduler.task("t")?.failure?.message ?? "";
    // `createdAt` says when the task was made, so the message must not claim the machine went away then.
    expect(message).toContain(`has not answered since before ${new Date(NOW - LOST_MS - 1).toISOString()}`);
    expect(message).not.toContain("went away");
  });

  test("a machine that is back and settles it first: the check precedes expiry", async () => {
    const fleet = new FakeFleet([machine("a")]);
    const { scheduler, put } = setup(fleet);
    await put("t", lost(NOW - LOST_MS - 1));
    await scheduler.load();
    fleet.running.set("a", [{ id: "%1", window: "w1", repo: "app", path: "/wt/t", taskId: "t" }]);
    await pass(scheduler);
    expect(scheduler.task("t")).toMatchObject({ state: "running" });
    expect(scheduler.task("t")?.failure).toBeUndefined();
  });

  test("whose machine is connected is left to its own check, even when that check got no answer", async () => {
    const fleet = new FakeFleet([machine("a")]);
    const { scheduler, put } = setup(fleet);
    await put("t", lost(NOW - LOST_MS - 1));
    await scheduler.load();
    fleet.sessionsReply = () => unreachable;
    await pass(scheduler);
    expect(scheduler.task("t")?.state).toBe("lost");

    fleet.fleet = [machine("a", { connected: false })];
    await pass(scheduler);
    expect(scheduler.task("t")?.failure?.code).toBe("lost_expired");
  });

  test("whose machine reconnects between the filter and the write is left to its own check", async () => {
    // A pass reads `machines()` for absence, for what is due, then in `#expire`'s filter: that third
    // read says "gone", and the machine is back before the write's change runs.
    class ReconnectingFleet extends FakeFleet {
      reads = 0;
      override machines(): readonly Machine[] {
        this.reads += 1;
        const gone = super.machines();
        if (this.reads === 3) {
          queueMicrotask(() => {
            this.fleet = [machine("a")];
          });
        }
        return gone;
      }
    }
    const fleet = new ReconnectingFleet([machine("a", { connected: false })]);
    const { scheduler, put } = setup(fleet);
    await put("t", lost(NOW - LOST_MS - 1));
    await scheduler.load();
    await pass(scheduler);
    expect(fleet.fleet[0]?.connected).toBe(true);
    expect(scheduler.task("t")?.state).toBe("lost");
  });

  test("is prunable once expired, and its blocked dependent fails with it", async () => {
    const { scheduler, put } = setup();
    await put("t", lost(NOW - LOST_MS - 1));
    await put("d", { state: "blocked", ...after("t", "merged") });
    await scheduler.load();
    await pass(scheduler);
    expect(scheduler.task("d")).toMatchObject({ state: "failed", failure: { code: "dependency_failed" } });
    expect(
      prunable(scheduler.tasks(), 0)
        .map((t) => t.id)
        .toSorted(),
    ).toEqual(["d", "t"]);
  });
});

describe("an awaiting-merge task", () => {
  test("stays put at the bound, and fails merge_expired a millisecond past it", async () => {
    const { scheduler, put } = setup();
    await put("edge", waiting({ endedAt: NOW - MERGE_MS }));
    await put("over", waiting({ endedAt: NOW - MERGE_MS - 1 }));
    await scheduler.load();
    await pass(scheduler);
    expect(scheduler.task("edge")?.state).toBe("awaiting-merge");
    expect(scheduler.task("over")).toMatchObject({ state: "failed", failure: { code: "merge_expired" } });
    expect(scheduler.task("over")?.endedAt).toBe(NOW - MERGE_MS - 1);
    expect(scheduler.task("over")?.failure?.message).toBe(
      "its session ended over 7 days ago and no merge of its pull request was seen",
    );
  });

  test("still expires when its machine is connected: only a lost task's machine spares it", async () => {
    const { scheduler, put } = setup(new FakeFleet([machine("a")]));
    await put("t", waiting({ endedAt: NOW - MERGE_MS - 1 }));
    await scheduler.load();
    await pass(scheduler);
    expect(scheduler.task("t")).toMatchObject({ state: "failed", failure: { code: "merge_expired" } });
  });

  test("a legacy record with no endedAt ages from createdAt", async () => {
    const { scheduler, put } = setup();
    await put("legacy", waiting({ createdAt: NOW - MERGE_MS - 1 }));
    await put("young", waiting({ createdAt: NOW - MERGE_MS }));
    await scheduler.load();
    await pass(scheduler);
    expect(scheduler.task("legacy")?.failure?.code).toBe("merge_expired");
    // No `endedAt`: when the session ended is unknown, so the message ages the task, not the session.
    expect(scheduler.task("legacy")?.failure?.message).toBe(
      "it was created over 7 days ago and no merge of its pull request was seen",
    );
    expect(scheduler.task("young")?.state).toBe("awaiting-merge");
  });

  test("fails its after-merged and after-opened dependents in the same pass, and leaves a released one alone", async () => {
    const { fleet, scheduler, put } = setup();
    await put("p", waiting({ endedAt: NOW - MERGE_MS - 1 }));
    await put("merged", { state: "blocked", ...after("p", "merged") });
    await put("opened", { state: "blocked", ...after("p", "opened") });
    await put("released", { state: "running", assignment: { ...ON_A, pane: "%9" }, ...after("p", "merged") });
    await scheduler.load();
    await pass(scheduler);
    expect(scheduler.task("p")?.failure?.code).toBe("merge_expired");
    for (const id of ["merged", "opened"]) {
      expect(scheduler.task(id)).toMatchObject({ state: "failed", failure: { code: "dependency_failed" } });
    }
    expect(scheduler.task("released")?.state).toBe("running");
    expect(fleet.spawns).toEqual([]);
  });
});

describe("the merge clock on the way in", () => {
  test("a lost task whose machine returns with its session ended and a PR open starts the clock at that write", async () => {
    const fleet = new FakeFleet([machine("a")]);
    const { clock, scheduler, put } = setup(fleet);
    await put("t", lost(NOW - 1000));
    await scheduler.load();
    fleet.sessionsReply = () => ({
      ok: true,
      sessions: [],
      ended: ["t"],
      progress: [{ taskId: "t", at: NOW, prUrl: PR, branch: "t", pushed: true }],
    });
    clock.now += 5000;
    await pass(scheduler);
    expect(scheduler.task("t")).toMatchObject({ state: "awaiting-merge", prUrl: PR, endedAt: NOW + 5000 });
  });
});

describe("a cancel racing expiry", () => {
  test("answers the task as it now stands, failed, and despawns nothing further", async () => {
    let scheduler: Scheduler | null = null;
    class ExpiringFleet extends FakeFleet {
      override async despawn(deviceId: string, request: DespawnRequest): Promise<DespawnResponse> {
        // The machine drops out while the despawn is in flight, and a pass expires the task before the cancel writes.
        this.fleet = [machine("a", { connected: false })];
        if (scheduler !== null) await pass(scheduler);
        return super.despawn(deviceId, request);
      }
    }
    const env = setup(new ExpiringFleet([machine("a")]));
    scheduler = env.scheduler;
    await env.put("t", lost(NOW - LOST_MS - 1));
    await env.scheduler.load();
    env.fleet.sessionsReply = () => unreachable;
    expect(await env.scheduler.cancel("t")).toMatchObject({
      ok: true,
      task: { id: "t", state: "failed", failure: { code: "lost_expired" } },
    });
    expect(env.scheduler.task("t")?.state).toBe("failed");
  });
});

describe("a machine that returns after expiry", () => {
  test("changes nothing: its session, a branch-state and a pass all decline for the failed task", async () => {
    const fleet = new FakeFleet([machine("a", { connected: false })]);
    const { store, scheduler, put } = setup(fleet);
    await put("t", lost(NOW - LOST_MS - 1));
    await scheduler.load();
    await pass(scheduler);
    expect(scheduler.task("t")?.state).toBe("failed");
    const version = (await store.get("t"))?.version;

    fleet.fleet = [machine("a")];
    fleet.running.set("a", [{ id: "%1", window: "w1", repo: "app", path: "/wt/t", taskId: "t" }]);
    await scheduler.onSession("t", "busy", { deviceId: "a", pane: "%1" });
    await scheduler.onSession("t", "ended", { deviceId: "a", pane: "%1" }, PR);
    await scheduler.onBranchState({ taskId: "t", repo: "app", branch: "x", pushed: true, merged: true, at: NOW }, "a");
    await pass(scheduler);
    expect(scheduler.task("t")?.state).toBe("failed");
    expect((await store.get("t"))?.version).toBe(version);
    expect(fleet.spawns).toEqual([]);
    expect(fleet.despawns).toEqual([]);
  });

  test("a cancel after expiry answers finished", async () => {
    const { scheduler, put } = setup();
    await put("t", lost(NOW - LOST_MS - 1));
    await scheduler.load();
    await pass(scheduler);
    expect(await scheduler.cancel("t")).toEqual({ ok: false, code: "finished" });
  });
});
