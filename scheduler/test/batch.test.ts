import { describe, expect, test } from "bun:test";
import { parseTask } from "@seance/shared";
import { MemoryQueueStore, Scheduler, type Task, type TaskSpec } from "../src/index.ts";
import { FakeFleet, machine, NOW, readerChecked, spec } from "./fixtures.ts";

/**
 * Batches are a group (2026-10-26): no bound, no order of their own. Order is
 * `after`, concurrency the caps; a pass only keeps members adjacent in index order.
 */

const FLEET = ["a", "b", "c", "d"].map((id) => machine(id));

function setup() {
  const clock = { now: NOW };
  const fleet = new FakeFleet(FLEET);
  const store = new MemoryQueueStore({ now: () => clock.now });
  const scheduler = new Scheduler({ store: readerChecked(store, () => clock.now), fleet, now: () => clock.now });
  /**
   * A member as a record holds it, read through the parser every reader uses —
   * `strategy` is raw, so a record an older writer sealed reads as it would.
   */
  async function member(
    id: string,
    index: number,
    options: { strategy?: unknown; fields?: Partial<Task>; specFields?: Partial<TaskSpec> } = {},
  ): Promise<void> {
    clock.now += 1;
    const strategy = "strategy" in options ? options.strategy : { mode: "auto" };
    const raw = {
      id,
      spec: { ...spec(options.specFields), batch: { id: "b1", index, strategy } },
      state: "ready",
      createdAt: clock.now,
      ...options.fields,
    };
    const body = parseTask(raw);
    if (body === null) throw new Error(`${id} does not parse`);
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
  test("a batch holds no bound: its members route in one pass, in index order whatever order they were created in", async () => {
    const { fleet, scheduler, member } = setup();
    await member("third", 2);
    await member("first", 0);
    await member("second", 1);
    await scheduler.load();
    await pass(scheduler);
    expect(dispatched(fleet)).toEqual(["first", "second", "third"]);
  });

  test("order between members is their after edges: the later one waits for the earlier to finish", async () => {
    const { fleet, scheduler, member } = setup();
    await member("first", 1, { fields: { state: "queued" } });
    await member("second", 2, {
      fields: { state: "queued" },
      specFields: { deps: [{ task: "first", after: "opened" }] },
    });
    await scheduler.load();
    await pass(scheduler);
    expect(dispatched(fleet)).toEqual(["first"]);
    expect(scheduler.task("second")?.state).toBe("blocked");

    await scheduler.onSession("first", "ended", { deviceId: fleet.spawns[0]?.deviceId ?? "", pane: "%1" });
    await pass(scheduler);
    await pass(scheduler);
    expect(dispatched(fleet)).toEqual(["first", "second"]);
  });

  test("a record an older writer stored as sequential or parallel schedules as a plain group", async () => {
    for (const strategy of [{ mode: "sequential" }, { mode: "parallel", max: 1 }, undefined]) {
      const { fleet, scheduler, member } = setup();
      // oxlint-disable-next-line no-await-in-loop -- created in order
      for (const [i, id] of ["m0", "m1", "m2"].entries()) await member(id, i, { strategy });
      // oxlint-disable-next-line no-await-in-loop -- one scheduler per strategy
      await scheduler.load();
      // oxlint-disable-next-line no-await-in-loop -- one scheduler per strategy
      await pass(scheduler);
      expect(dispatched(fleet)).toEqual(["m0", "m1", "m2"]);
      expect(scheduler.task("m0")?.spec.batch?.strategy).toEqual({ mode: "auto" });
    }
  });

  test("an unroutable lower index holds nothing: there is no batch order hold", async () => {
    const { fleet, scheduler, member } = setup();
    await member("first", 0, { strategy: { mode: "sequential" }, specFields: { repo: "github.com/acme/elsewhere" } });
    await member("second", 1, { strategy: { mode: "sequential" } });
    await scheduler.load();
    await pass(scheduler);
    expect(dispatched(fleet)).toEqual(["second"]);
  });

  test("a lost member holds nothing: a batch counts toward no bound", async () => {
    const { fleet, scheduler, member } = setup();
    const lost: Partial<Task> = {
      state: "lost",
      assignment: { deviceId: "z", exclave: "main", clone: "app", pane: "%1" },
    };
    await member("l0", 0, { strategy: { mode: "parallel", max: 1 }, fields: lost });
    await member("l1", 1, { strategy: { mode: "parallel", max: 1 } });
    await scheduler.load();
    await pass(scheduler);
    expect(dispatched(fleet)).toEqual(["l1"]);
  });

  test("a lower index that depends on a higher one is no loop: it waits for it", async () => {
    const { fleet, scheduler, member } = setup();
    await member("low", 0, {
      strategy: { mode: "sequential" },
      fields: { state: "queued" },
      specFields: { deps: [{ task: "high", after: "opened" }] },
    });
    await member("high", 1, { strategy: { mode: "sequential" }, fields: { state: "queued" } });
    await scheduler.load();
    await pass(scheduler);
    expect(dispatched(fleet)).toEqual(["high"]);
    expect(scheduler.task("low")?.state).toBe("blocked");
  });
});
