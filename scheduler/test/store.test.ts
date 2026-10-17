import { describe, expect, test } from "bun:test";
import { DECISION_MAX_CANDIDATES, TASK_FAILURE_LIMITS, TARGET_LIMITS } from "@seance/shared";
import { MemoryQueueStore, Scheduler, StoreRevoked, type Task } from "../src/index.ts";
import { FakeFleet, machine, NOW, spec } from "./fixtures.ts";

/**
 * The store port (`QueueStore`): what a store can answer besides a clean write,
 * and what the library does with each — over `MemoryQueueStore`, whose fault
 * hooks stand in for the relay and for an attacker.
 */

function queued(id: string, fields: Partial<Task> = {}): Task {
  return { id, spec: spec(), state: "ready", createdAt: NOW, ...fields };
}

function setup(fleet = new FakeFleet([machine("a")])) {
  const clock = { now: NOW };
  const store = new MemoryQueueStore({ now: () => clock.now, tombstoneMs: 1_000 });
  const errors: unknown[] = [];
  const scheduler = new Scheduler({ store, fleet, now: () => clock.now, onError: (err) => errors.push(err) });
  return { store, fleet, clock, scheduler, errors };
}

async function pass(scheduler: Scheduler): Promise<void> {
  await scheduler.tick();
  await scheduler.drain();
}

describe("MemoryQueueStore", () => {
  test("a delete leaves a tombstone that refuses any put until it expires", async () => {
    const { store, clock } = setup();
    expect(await store.put("t", 0, queued("t"))).toEqual({ ok: true, version: 1 });
    expect(await store.delete("t", 1)).toEqual({ ok: true, version: 1 });
    expect(await store.get("t")).toBeNull();
    expect(await store.list()).toEqual([]);
    // The authentic version-1 blob, re-created: what tombstones exist to refuse.
    expect(await store.put("t", 0, queued("t"))).toEqual({ ok: false, code: "version_conflict" });
    clock.now += 1_000;
    expect(await store.put("t", 0, queued("t"))).toEqual({ ok: true, version: 1 });
  });

  test("a create past the cap is store_full; an overwrite is not, and a tombstone counts toward nothing", async () => {
    const store = new MemoryQueueStore({ maxTasks: 1 });
    expect(await store.put("t", 0, queued("t"))).toEqual({ ok: true, version: 1 });
    expect(await store.put("u", 0, queued("u"))).toEqual({ ok: false, code: "store_full" });
    expect(await store.put("t", 1, queued("t"))).toEqual({ ok: true, version: 2 });
    await store.delete("t", 2);
    expect(await store.put("u", 0, queued("u"))).toEqual({ ok: true, version: 1 });
  });

  test("an old body put back at a newer version reads as a version mismatch, never as the task", async () => {
    const { store } = setup();
    await store.put("t", 0, queued("t"));
    await store.put("t", 1, queued("t", { state: "cancelled" }));
    store.replay("t", 1);
    expect(await store.get("t")).toEqual({ id: "t", version: 3, reason: "version_mismatch" });
  });

  test("the pause is one record with its own version", async () => {
    const { store } = setup();
    expect(await store.getPause()).toBeNull();
    const holds = [{ until: "resume", at: NOW }] as const;
    expect(await store.putPause(0, holds)).toEqual({ ok: true, version: 1 });
    expect(await store.putPause(0, [])).toEqual({ ok: false, code: "version_conflict" });
    expect(await store.getPause()).toEqual({ version: 1, holds });
  });

  test("faults: a refusal is a value, a lost reply may have committed, a revoked term throws", async () => {
    const { store } = setup();
    store.failNext({ code: "store_full" });
    expect(await store.put("t", 0, queued("t"))).toEqual({ ok: false, code: "store_full" });
    expect(await store.get("t")).toBeNull();
    store.failNext({ code: "indeterminate", commit: true });
    expect(await store.put("t", 0, queued("t"))).toEqual({ ok: false, code: "indeterminate" });
    expect((await store.get("t"))?.version).toBe(1);
    store.failNext({ code: "revoked" });
    await expect(store.delete("t", 1)).rejects.toBeInstanceOf(StoreRevoked);
  });
});

describe("the scheduler over a store", () => {
  test("a record it cannot read is skipped and reported — never dispatched, never deleted", async () => {
    const { store, fleet, scheduler } = setup();
    await store.put("good", 0, queued("good"));
    await store.put("rolled", 0, queued("rolled"));
    await store.put("rolled", 1, queued("rolled", { state: "cancelled" }));
    store.replay("rolled", 1);
    store.plant("junk", "unopenable");
    await scheduler.takeover();
    await pass(scheduler);
    expect(fleet.spawns.map((s) => s.request.taskId)).toEqual(["good"]);
    expect(scheduler.task("rolled")).toBeUndefined();
    expect(scheduler.unreadable()).toEqual([
      { id: "rolled", version: 3, reason: "version_mismatch" },
      { id: "junk", version: 1, reason: "unopenable" },
    ]);
    await scheduler.prune(0);
    expect((await store.list()).map((entry) => entry.id).toSorted()).toEqual(["good", "junk", "rolled"]);
  });

  test("a lost reply after its write committed is read back as written, and the spawn still goes", async () => {
    const { store, fleet, scheduler } = setup();
    await store.put("t", 0, queued("t"));
    await scheduler.load();
    store.failNext({ code: "indeterminate", commit: true });
    await pass(scheduler);
    expect(fleet.spawns).toHaveLength(1);
    expect(scheduler.task("t")?.state).toBe("running");
  });

  test("a lost reply that never committed is applied again", async () => {
    const { store, fleet, scheduler } = setup();
    await store.put("t", 0, queued("t"));
    await scheduler.load();
    store.failNext({ code: "indeterminate" });
    await pass(scheduler);
    expect(fleet.spawns).toHaveLength(1);
    expect((await store.get("t"))?.body?.state).toBe("running");
  });

  test("a record past the store's bound is written again with its decision cut to the winner", async () => {
    const { store, scheduler } = setup(new FakeFleet([machine("a"), machine("b"), machine("c")]));
    await store.put("t", 0, queued("t"));
    await scheduler.load();
    store.failNext({ code: "too_large" });
    await pass(scheduler);
    const decision = (await store.get("t"))?.body?.decision;
    const chosen = decision?.chosen?.deviceId;
    expect(chosen).toBeDefined();
    expect(decision?.candidates.map((c) => c.deviceId)).toEqual([chosen ?? ""]);
    expect(decision?.trimmed).toBe(2);
  });

  test("a refusal that is no race is reported, and the task stays as it was", async () => {
    const { store, fleet, scheduler, errors } = setup();
    await store.put("t", 0, queued("t"));
    await scheduler.load();
    store.failNext({ code: "refused" });
    await pass(scheduler);
    expect(fleet.spawns).toEqual([]);
    expect(scheduler.task("t")?.state).toBe("ready");
    expect(String(errors[0])).toContain("refused");
  });

  test("a revoked term unwinds the pass rather than writing on", async () => {
    const { store, fleet, scheduler } = setup();
    await store.put("t", 0, queued("t"));
    await scheduler.load();
    store.failNext({ code: "revoked" });
    await expect(scheduler.tick()).rejects.toBeInstanceOf(StoreRevoked);
    await scheduler.drain().catch(() => undefined);
    expect(fleet.spawns).toEqual([]);
  });

  test("refresh re-reads one record: a write from elsewhere, a delete, or one that no longer reads", async () => {
    const { store, scheduler } = setup(new FakeFleet([]));
    await store.put("a", 0, queued("a"));
    await store.put("b", 0, queued("b"));
    await store.put("c", 0, queued("c"));
    await scheduler.load();
    await store.put("a", 1, queued("a", { state: "cancelled" }));
    await store.delete("b", 1);
    store.plant("c", "key_mismatch", 2);
    for (const id of ["a", "b", "c"]) await scheduler.refresh(id);
    expect(scheduler.task("a")?.state).toBe("cancelled");
    expect(scheduler.task("b")).toBeUndefined();
    expect(scheduler.task("c")).toBeUndefined();
    expect(scheduler.unreadable()).toEqual([{ id: "c", version: 2, reason: "key_mismatch" }]);
  });

  test("what the leader writes stays inside what a reader accepts", async () => {
    const fleet = new FakeFleet(Array.from({ length: DECISION_MAX_CANDIDATES + 5 }, (_, i) => machine(`m${i}`)));
    const { store, scheduler } = setup(fleet);
    for (const m of fleet.fleet) {
      fleet.scripts.set(m.deviceId, () => ({ ok: false, code: "launch_error", message: "x".repeat(10_000) }));
    }
    await store.put("t", 0, queued("t", { spec: spec({ title: "w".repeat(TARGET_LIMITS.window * 2) }) }));
    await scheduler.load();
    await pass(scheduler);
    const body = (await store.get("t"))?.body;
    expect(body?.failure?.message).toHaveLength(TASK_FAILURE_LIMITS.message);
    expect(body?.decision?.candidates).toHaveLength(DECISION_MAX_CANDIDATES);
    expect(body?.decision?.trimmed).toBe(5);
    expect(scheduler.preview(spec()).candidates).toHaveLength(DECISION_MAX_CANDIDATES);
  });
});
