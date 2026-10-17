import { describe, expect, test } from "bun:test";
import type { BatchStrategy } from "@seance/shared";
import { MemoryQueueStore, Scheduler, type Task, type TaskSpec } from "../src/index.ts";
import { FakeFleet, machine, NOW, spec } from "./fixtures.ts";

/** Batches (M3 item 4a): a strategy's bound as `cap_reached` scope `batch`, and members routed in index order. */

const FLEET = ["a", "b", "c", "d"].map((id) => machine(id));

function setup() {
  const clock = { now: NOW };
  const fleet = new FakeFleet(FLEET);
  const store = new MemoryQueueStore({ now: () => clock.now });
  const scheduler = new Scheduler({ store, fleet, now: () => clock.now });
  async function member(
    id: string,
    index: number,
    strategy: BatchStrategy,
    fields: Partial<Task> = {},
    specFields: Partial<TaskSpec> = {},
  ): Promise<void> {
    clock.now += 1;
    const body: Task = {
      id,
      spec: spec({ batch: { id: "b1", index, strategy }, ...specFields }),
      state: "ready",
      createdAt: clock.now,
      ...fields,
    };
    const write = await store.put(id, 0, body);
    if (!write.ok) throw new Error(`put ${id}: ${write.code}`);
  }
  return { fleet, scheduler, member };
}

async function pass(scheduler: Scheduler): Promise<void> {
  await scheduler.tick();
  await scheduler.drain();
}

function dispatched(fleet: FakeFleet): (string | undefined)[] {
  return fleet.spawns.map((s) => s.request.taskId);
}

describe("batches", () => {
  test("sequential runs one member at a time, in index order, whatever order they were created in", async () => {
    const { fleet, scheduler, member } = setup();
    const sequential = { mode: "sequential" } as const;
    await member("third", 2, sequential);
    await member("first", 0, sequential);
    await member("second", 1, sequential);
    await scheduler.load();
    await pass(scheduler);
    expect(dispatched(fleet)).toEqual(["first"]);
    expect(scheduler.lastDecision("second")?.candidates[0]?.rejected).toContainEqual({
      code: "cap_reached",
      inFlight: 1,
      max: 1,
      scope: "batch",
    });

    await scheduler.onSession("first", "ended", { deviceId: fleet.spawns[0]?.deviceId ?? "", pane: "%1" });
    await pass(scheduler);
    expect(dispatched(fleet)).toEqual(["first", "second"]);
  });

  test("parallel holds the batch to its max", async () => {
    const { fleet, scheduler, member } = setup();
    for (const [i, id] of ["p0", "p1", "p2"].entries()) {
      // oxlint-disable-next-line no-await-in-loop -- created in order
      await member(id, i, { mode: "parallel", max: 2 });
    }
    await scheduler.load();
    await pass(scheduler);
    expect(dispatched(fleet)).toEqual(["p0", "p1"]);
    expect(scheduler.task("p2")?.state).toBe("ready");
    expect(scheduler.lastDecision("p2")?.candidates[0]?.rejected).toContainEqual({
      code: "cap_reached",
      inFlight: 2,
      max: 2,
      scope: "batch",
    });
  });

  test("a lost member counts toward the bound: its session may still run on a machine that only sleeps", async () => {
    const lost: Partial<Task> = {
      state: "lost",
      assignment: { deviceId: "z", exclave: "main", clone: "app", pane: "%1" },
    };
    const parallel = setup();
    await parallel.member("l0", 0, { mode: "parallel", max: 1 }, lost);
    await parallel.member("l1", 1, { mode: "parallel", max: 1 });
    await parallel.scheduler.load();
    await pass(parallel.scheduler);
    expect(dispatched(parallel.fleet)).toEqual([]);

    const sequential = setup();
    // The lost member has the higher index, so only the bound's count, not index order, can hold s1.
    await sequential.member("s1", 1, { mode: "sequential" });
    await sequential.member("s5", 5, { mode: "sequential" }, lost);
    await sequential.scheduler.load();
    await pass(sequential.scheduler);
    expect(dispatched(sequential.fleet)).toEqual([]);
  });

  describe("sequential enforces index order, not whichever member routes first", () => {
    const sequential = { mode: "sequential" } as const;

    test("an unroutable index 0 holds index 1", async () => {
      const { fleet, scheduler, member } = setup();
      await member("first", 0, sequential, {}, { repo: "github.com/acme/elsewhere" });
      await member("second", 1, sequential);
      await scheduler.load();
      await pass(scheduler);
      expect(dispatched(fleet)).toEqual([]);
      expect(scheduler.lastDecision("second")?.candidates[0]?.rejected).toContainEqual(
        expect.objectContaining({ code: "cap_reached", scope: "batch" }),
      );
    });

    test("a lower index not in the store holds nothing: gaps, 1-based numbering and pruned members never wedge a batch", async () => {
      const { fleet, scheduler, member } = setup();
      await member("third", 3, sequential);
      await member("second", 2, sequential);
      await scheduler.load();
      await pass(scheduler);
      expect(dispatched(fleet)).toEqual(["second"]);
    });

    test("the next member starts when the previous one is awaiting-merge", async () => {
      const { fleet, scheduler, member } = setup();
      await member("first", 0, sequential, { state: "awaiting-merge", prUrl: "https://github.com/acme/app/pull/1" });
      await member("second", 1, sequential);
      await scheduler.load();
      await pass(scheduler);
      expect(dispatched(fleet)).toEqual(["second"]);
    });

    test("a huge index routes promptly: the hold costs the members, not the index", async () => {
      const { fleet, scheduler, member } = setup();
      await member("first", 0, sequential);
      await member("last", Number.MAX_SAFE_INTEGER, sequential);
      await scheduler.load();
      await pass(scheduler);
      expect(dispatched(fleet)).toEqual(["first"]);
      expect(scheduler.lastDecision("last")?.candidates[0]?.rejected).toContainEqual({
        code: "cap_reached",
        inFlight: 1,
        max: 1,
        scope: "batch",
      });
    });

    test("a lower index that depends on a higher one of its sequential batch is a loop: both fail at admission", async () => {
      const { scheduler, member } = setup();
      await member("low", 0, sequential, { state: "queued" }, { deps: [{ task: "high", after: "opened" }] });
      await member("high", 1, sequential, { state: "queued" });
      await scheduler.load();
      await pass(scheduler);
      for (const id of ["low", "high"]) {
        expect(scheduler.task(id)).toMatchObject({ state: "failed", failure: { code: "dependency_cycle" } });
      }
    });

    test("an index 0 still blocked on a dependency holds index 1", async () => {
      const { fleet, scheduler, member } = setup();
      const lost: Partial<Task> = {
        state: "lost",
        assignment: { deviceId: "z", exclave: "main", clone: "app", pane: "%1" },
      };
      await member("gate", 9, { mode: "auto" }, lost, { batch: undefined });
      await member("first", 0, sequential, { state: "blocked" }, { deps: [{ task: "gate", after: "merged" }] });
      await member("second", 1, sequential);
      await scheduler.load();
      await pass(scheduler);
      expect(dispatched(fleet)).toEqual([]);
      expect(scheduler.task("first")?.state).toBe("blocked");
    });

    test("a lower index finished in any state releases the next", async () => {
      const { fleet, scheduler, member } = setup();
      await member("first", 0, sequential, { state: "failed", failure: { code: "repo_not_found", message: "gone" } });
      await member("second", 1, sequential);
      await scheduler.load();
      await pass(scheduler);
      expect(dispatched(fleet)).toEqual(["second"]);
    });
  });

  test("auto has no batch bound; where members disagree, the earliest-created member's strategy wins", async () => {
    const auto = setup();
    for (const [i, id] of ["x0", "x1", "x2"].entries()) {
      // oxlint-disable-next-line no-await-in-loop -- created in order
      await auto.member(id, i, { mode: "auto" });
    }
    await auto.scheduler.load();
    await pass(auto.scheduler);
    expect(dispatched(auto.fleet)).toEqual(["x0", "x1", "x2"]);

    const mixed = setup();
    await mixed.member("m0", 0, { mode: "sequential" });
    await mixed.member("m1", 1, { mode: "auto" });
    await mixed.scheduler.load();
    await pass(mixed.scheduler);
    expect(dispatched(mixed.fleet)).toEqual(["m0"]);
  });
});
