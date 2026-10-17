import { describe, expect, test } from "bun:test";
import type { BatchStrategy } from "@seance/shared";
import { MemoryQueueStore, Scheduler, type Task } from "../src/index.ts";
import { FakeFleet, machine, NOW, spec } from "./fixtures.ts";

/** Batches (M3 item 4a): a strategy's bound as `cap_reached` scope `batch`, and members routed in index order. */

const FLEET = ["a", "b", "c", "d"].map((id) => machine(id));

function setup() {
  const clock = { now: NOW };
  const fleet = new FakeFleet(FLEET);
  const store = new MemoryQueueStore({ now: () => clock.now });
  const scheduler = new Scheduler({ store, fleet, now: () => clock.now });
  async function member(id: string, index: number, strategy: BatchStrategy): Promise<void> {
    clock.now += 1;
    const body: Task = {
      id,
      spec: spec({ batch: { id: "b1", index, strategy } }),
      state: "ready",
      createdAt: clock.now,
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
