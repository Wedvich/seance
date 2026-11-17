import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, MemoryQueueStore, Scheduler, StoreRevoked } from "../src/index.ts";
import { enqueue, FakeFleet, machine, NOW, readerChecked, spec } from "./fixtures.ts";

function setup(fleet = new FakeFleet([machine("a")]), store = new MemoryQueueStore()) {
  const errors: unknown[] = [];
  const make = (): Scheduler =>
    new Scheduler({
      store: readerChecked(store, () => NOW),
      fleet,
      config: DEFAULT_CONFIG,
      now: () => NOW,
      onError: (err) => errors.push(err),
    });
  return { store, fleet, errors, make, scheduler: make() };
}

async function pass(scheduler: Scheduler): Promise<void> {
  await scheduler.tick();
  await scheduler.drain();
}

describe("the fleet limit", () => {
  test("no record is no limit: the queue runs free, and nothing is written to say so", async () => {
    const { fleet, scheduler, store } = setup();
    await scheduler.takeover();
    expect(scheduler.limits()).toEqual({ limits: {}, unreadable: false });
    for (let i = 0; i < 10; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each enqueue follows the last
      await enqueue(store, scheduler, spec());
    }
    await pass(scheduler);
    expect(fleet.spawns).toHaveLength(10);
    // Lifting a limit that was never set writes no record.
    expect(await scheduler.setLimits({ fleet: null })).toEqual({ ok: true, limits: {} });
    expect(await store.getLimits()).toBeNull();
  });

  test("a limit holds the tasks past it; lifting it lets them go", async () => {
    const { fleet, scheduler, store } = setup();
    expect(await scheduler.setLimits({ fleet: 2 })).toEqual({ ok: true, limits: { fleet: 2 } });
    const tasks = [];
    for (let i = 0; i < 3; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each enqueue follows the last
      tasks.push(await enqueue(store, scheduler, spec()));
    }
    await pass(scheduler);
    expect(fleet.spawns).toHaveLength(2);
    const waiting = tasks.find((t) => scheduler.task(t.id)?.state === "ready");
    expect(scheduler.lastDecision(waiting?.id ?? "")?.candidates[0]?.rejected).toEqual([
      { code: "cap_reached", inFlight: 2, max: 2 },
    ]);
    // The same limit again changes nothing, so writes nothing.
    await scheduler.setLimits({ fleet: 2 });
    expect((await store.getLimits())?.version).toBe(1);

    expect(await scheduler.setLimits({ fleet: null })).toEqual({ ok: true, limits: {} });
    expect(await store.getLimits()).toEqual({ version: 2, limits: {} });
    await pass(scheduler);
    expect(fleet.spawns).toHaveLength(3);
  });

  test("a new leader enforces the limit the last one stored", async () => {
    const { fleet, make, scheduler, store } = setup();
    await scheduler.setLimits({ fleet: 1 });
    const next = make();
    await next.takeover();
    expect(next.limits()).toEqual({ limits: { fleet: 1 }, unreadable: false });
    await enqueue(store, next, spec());
    await enqueue(store, next, spec());
    await pass(next);
    expect(fleet.spawns).toHaveLength(1);
  });

  test("an unreadable record places nothing, is reported, and a set-limits overwrites it at its version", async () => {
    const store = new MemoryQueueStore();
    store.plantLimits("unopenable", 3);
    const { errors, fleet, scheduler } = setup(new FakeFleet([machine("a")]), store);
    await scheduler.takeover();
    expect(errors).toHaveLength(1);
    expect(scheduler.limits()).toEqual({ limits: {}, unreadable: true });
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    expect(fleet.spawns).toEqual([]);
    expect(scheduler.lastDecision(task.id)?.candidates[0]?.rejected).toEqual([
      { code: "cap_reached", inFlight: 0, max: 0 },
    ]);

    // "No limit" is a real answer here, so it writes, unlike over a readable record holding none.
    expect(await scheduler.setLimits({ fleet: null })).toEqual({ ok: true, limits: {} });
    expect(await store.getLimits()).toEqual({ version: 4, limits: {} });
    expect(scheduler.limits()).toEqual({ limits: {}, unreadable: false });
    await pass(scheduler);
    expect(fleet.spawns).toHaveLength(1);
  });

  test("a lost race is applied again to what the store holds; one that keeps losing is conflict", async () => {
    const { scheduler, store } = setup();
    store.failNext({ code: "version_conflict" });
    expect(await scheduler.setLimits({ fleet: 4 })).toEqual({ ok: true, limits: { fleet: 4 } });
    expect((await store.getLimits())?.version).toBe(1);

    for (let i = 0; i < 3; i += 1) store.failNext({ code: "version_conflict" });
    expect(await scheduler.setLimits({ fleet: 5 })).toEqual({ ok: false, code: "conflict" });
    expect(scheduler.limits().limits).toEqual({ fleet: 4 });

    // A reply lost after the write committed: the one version past ours is ours.
    store.failNext({ code: "indeterminate", commit: true });
    expect(await scheduler.setLimits({ fleet: 5 })).toEqual({ ok: true, limits: { fleet: 5 } });
    expect(await store.getLimits()).toEqual({ version: 2, limits: { fleet: 5 } });
  });

  test("a revoked term unwinds the write; a reply lost before it committed retries at the same version", async () => {
    const { scheduler, store } = setup();
    store.failNext({ code: "revoked" });
    await expect(scheduler.setLimits({ fleet: 3 })).rejects.toBeInstanceOf(StoreRevoked);
    expect(await store.getLimits()).toBeNull();

    store.failNext({ code: "indeterminate" });
    expect(await scheduler.setLimits({ fleet: 3 })).toEqual({ ok: true, limits: { fleet: 3 } });
    expect(await store.getLimits()).toEqual({ version: 1, limits: { fleet: 3 } });
  });
});
