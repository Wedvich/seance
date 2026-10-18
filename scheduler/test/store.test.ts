import { describe, expect, test } from "bun:test";
import { DECISION_MAX_CANDIDATES, TASK_FAILURE_LIMITS, TASK_REQUEST_LIMITS } from "@seance/shared";
import { MemoryQueueStore, Scheduler, StoreRevoked, type Task } from "../src/index.ts";
import { clone, exclave, FakeFleet, machine, NOW, readerChecked, spec } from "./fixtures.ts";

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
  const scheduler = new Scheduler({
    store: readerChecked(store, () => clock.now),
    fleet,
    now: () => clock.now,
    onError: (err) => errors.push(err),
  });
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

  test("discard deletes a record held unreadable at the version asked, and nothing else", async () => {
    const { store, scheduler } = setup(new FakeFleet([]));
    await store.put("good", 0, queued("good"));
    store.plant("junk", "unopenable");
    store.plant("stale", "unopenable");
    await scheduler.load();

    expect(await scheduler.discard("good", 1)).toEqual({ ok: false, code: "not_found" });
    expect(await scheduler.discard("nope", 1)).toEqual({ ok: false, code: "not_found" });
    expect(await scheduler.discard("junk", 2)).toEqual({ ok: false, code: "conflict" });
    expect(await scheduler.discard("junk", 1)).toEqual({ ok: true });
    expect(scheduler.unreadable().map((u) => u.id)).toEqual(["stale"]);
    expect((await store.list()).map((e) => e.id).toSorted()).toEqual(["good", "stale"]);
    // A tombstone stands behind it, so the same blob cannot simply be put back.
    expect(await scheduler.discard("junk", 1)).toEqual({ ok: false, code: "not_found" });

    // A lost reply that committed is gone; one that met a newer record holds that record instead.
    store.failNext({ code: "indeterminate", commit: true });
    expect(await scheduler.discard("stale", 1)).toEqual({ ok: true });
    expect(scheduler.unreadable()).toEqual([]);
    expect((await store.list()).map((e) => e.id)).toEqual(["good"]);
  });

  test("discard of a record rewritten since it was read is a conflict, and the record is held as it now reads", async () => {
    const { store, scheduler } = setup(new FakeFleet([]));
    store.plant("junk", "unopenable");
    await scheduler.load();
    store.plant("junk", "unopenable", 2);
    expect(await scheduler.discard("junk", 1)).toEqual({ ok: false, code: "conflict" });
    expect(scheduler.unreadable()).toEqual([{ id: "junk", version: 2, reason: "unopenable" }]);
    expect(await scheduler.discard("junk", 2)).toEqual({ ok: true });
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
    await store.put("t", 0, queued("t", { spec: spec({ title: "w".repeat(TASK_REQUEST_LIMITS.title) }) }));
    await scheduler.load();
    await pass(scheduler);
    const body = (await store.get("t"))?.body;
    expect(body?.failure?.message).toHaveLength(TASK_FAILURE_LIMITS.message);
    // The reservation wrote the capped decision (`readerChecked` held it to the bound); failed, it keeps the winner.
    expect(body?.decision?.candidates).toHaveLength(1);
    expect(body?.decision?.trimmed).toBe(DECISION_MAX_CANDIDATES + 4);
    expect(scheduler.preview(spec()).candidates).toHaveLength(DECISION_MAX_CANDIDATES);
  });
});

/** What a store holds for `id`: its version and body, which must be there. */
async function read(store: MemoryQueueStore, id: string): Promise<{ version: number; body: Task }> {
  const entry = await store.get(id);
  if (entry === null || entry.body === undefined) throw new Error(`${id} is not readable`);
  return { version: entry.version, body: entry.body };
}

/** A record at `version`, as an earlier leader left it: the same body written `version` times. */
async function seed(store: MemoryQueueStore, task: Task, version = 1): Promise<void> {
  for (let at = 0; at < version; at += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each put follows the version before it
    const write = await store.put(task.id, at, task);
    if (!write.ok) throw new Error(`seed ${task.id}: ${write.code}`);
  }
}

describe("a finished task is kept lean: no prompt, and its decision cut to the winner", () => {
  const ON_A = { deviceId: "a", exclave: "main", clone: "app", pane: "%1" } as const;
  const FROM_A = { deviceId: "a", pane: "%1" } as const;

  test("the write that ends a session without a PR drops the prompt, in the one version it costs", async () => {
    const { store, scheduler } = setup();
    await store.put("t", 0, queued("t", { spec: spec({ title: "fix it" }) }));
    await scheduler.load();
    await pass(scheduler);
    const running = await read(store, "t");
    expect(running.body.state).toBe("running");
    expect(running.body.spec.prompt).toBe("do it");

    await scheduler.onSession("t", "ended", FROM_A);
    const done = await read(store, "t");
    expect(done.body.state).toBe("done");
    expect(done.version).toBe(running.version + 1);
    expect(done.body.spec).toEqual({ repo: running.body.spec.repo, mode: "worktree", title: "fix it" });
    expect(scheduler.task("t")?.spec.prompt).toBeUndefined();
  });

  test("every failing path leaves none: a refused spawn, an expired lost task, a failed dependency", async () => {
    const refused = setup();
    refused.fleet.scripts.set("a", () => ({ ok: false, code: "repo_not_found", message: "gone" }));
    await refused.store.put("t", 0, queued("t"));
    await refused.scheduler.load();
    await pass(refused.scheduler);
    const failed = await read(refused.store, "t");
    expect(failed.body).toMatchObject({ state: "failed", failure: { code: "repo_not_found" } });
    expect(failed.body.spec.prompt).toBeUndefined();

    const expired = setup(new FakeFleet([machine("a", { connected: false })]));
    await expired.store.put("l", 0, queued("l", { state: "lost", assignment: ON_A, absentSince: NOW }));
    await expired.scheduler.takeover();
    expired.clock.now += 8 * 86_400_000;
    await pass(expired.scheduler);
    const lost = await read(expired.store, "l");
    expect(lost.body).toMatchObject({ state: "failed", failure: { code: "lost_expired" } });
    expect(lost.body.spec.prompt).toBeUndefined();
    expect(lost.version).toBe(2);

    const dependent = setup();
    await dependent.store.put(
      "p",
      0,
      queued("p", { state: "failed", failure: { code: "repo_not_found", message: "x" } }),
    );
    await dependent.store.put(
      "d",
      0,
      queued("d", { state: "queued", spec: spec({ deps: [{ task: "p", after: "merged" }] }) }),
    );
    await dependent.scheduler.takeover();
    await pass(dependent.scheduler);
    const blocked = await read(dependent.store, "d");
    expect(blocked.body).toMatchObject({ state: "failed", failure: { code: "dependency_failed" } });
    expect(blocked.body.spec.prompt).toBeUndefined();
    expect(blocked.version).toBe(2);
  });

  test("cancel and mark-done leave none, and the task they return has none", async () => {
    const { store, scheduler } = setup();
    await store.put("c", 0, queued("c", { state: "queued" }));
    await store.put("m", 0, queued("m", { state: "ready" }));
    await scheduler.load();

    const cancelled = await scheduler.cancel("c");
    expect(cancelled).toMatchObject({ ok: true, task: { state: "cancelled" } });
    expect(cancelled.ok && cancelled.task.spec.prompt).toBeUndefined();
    expect((await read(store, "c")).body.spec.prompt).toBeUndefined();

    const done = await scheduler.markDone("m");
    expect(done).toMatchObject({ ok: true, task: { state: "done" } });
    expect(done.ok && done.task.spec.prompt).toBeUndefined();
    expect((await read(store, "m")).body.spec.prompt).toBeUndefined();
  });

  test("an unfinished task keeps its prompt, spawns with it, and a pass does not rewrite it", async () => {
    const fleet = new FakeFleet([machine("a")]);
    fleet.running.set("a", [{ id: "%1", window: "w", repo: "app", path: "/wt/r", taskId: "r" }]);
    const { store, scheduler } = setup(fleet);
    await store.put("r", 0, queued("r", { state: "running", assignment: ON_A }));
    await store.put("t", 0, queued("t"));
    await scheduler.takeover();
    await pass(scheduler);
    expect(fleet.spawns.map((s) => s.request.prompt)).toEqual(["do it"]);
    const running = await read(store, "r");
    expect(running.version).toBe(1);
    expect(running.body.spec.prompt).toBe("do it");
  });

  test("a finished record an earlier leader left with its prompt is rewritten once, in the first pass", async () => {
    const { store, scheduler } = setup();
    const legacy = queued("t", { state: "done", doneBy: "session" });
    await seed(store, legacy, 3);
    await scheduler.takeover();
    expect((await read(store, "t")).body.spec.prompt).toBe("do it");

    await pass(scheduler);
    const stripped = await read(store, "t");
    expect(stripped.version).toBe(4);
    const { prompt: _prompt, ...rest } = legacy.spec;
    expect(stripped.body).toEqual({ ...legacy, spec: rest });

    await pass(scheduler);
    expect((await read(store, "t")).version).toBe(4);
  });

  test("a finished record on a 10 × 5 fleet keeps only its winner, and an earlier leader's full one is cut in the first pass", async () => {
    const exclaves = ["e0", "e1", "e2", "e3", "e4"];
    const wide = (id: string) =>
      machine(id, {
        repos: exclaves.map((x) => clone("app", x)),
        exclaves: exclaves.map((x) => exclave(x, `org:${id}-${x}`)),
      });
    const fleet = new FakeFleet(Array.from({ length: 10 }, (_, i) => wide(`m${i}`)));
    const { store, scheduler } = setup(fleet);
    await store.put("t", 0, queued("t"));
    await scheduler.load();
    await pass(scheduler);
    const running = await read(store, "t");
    expect(running.body.decision?.candidates).toHaveLength(50);
    const at = running.body.assignment;
    await scheduler.onSession("t", "ended", { deviceId: at?.deviceId ?? "", pane: at?.pane ?? "" });
    const done = await read(store, "t");
    expect(done.body.decision).toMatchObject({ candidates: [{ deviceId: at?.deviceId }], trimmed: 49 });
    expect(JSON.stringify(done.body).length).toBeLessThanOrEqual(1536);

    // As an earlier leader left it: finished with the full decision, and no prompt to strip.
    const { prompt: _prompt, ...noPrompt } = running.body.spec;
    await seed(store, { ...running.body, id: "legacy", spec: noPrompt, state: "done", doneBy: "session" });
    await scheduler.takeover();
    await pass(scheduler);
    expect((await read(store, "legacy")).body.decision?.candidates).toHaveLength(1);
  });

  test("a sweep strips at most eight records a pass, the oldest by createdAt first", async () => {
    const { store, scheduler } = setup();
    // createdAt runs against both the id order and the order the records go in: d00 is the newest, d19 the oldest.
    const ids = Array.from({ length: 20 }, (_, i) => `d${String(i).padStart(2, "0")}`);
    for (const [i, id] of ids.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one record each
      await seed(store, queued(id, { state: "done", doneBy: "session", createdAt: NOW - 100_000 - i }));
    }
    await scheduler.takeover();

    async function stripped(): Promise<string[]> {
      const held = await Promise.all(ids.map(async (id) => [id, (await read(store, id)).version] as const));
      return held.filter(([, version]) => version === 2).map(([id]) => id);
    }
    await pass(scheduler);
    expect(await stripped()).toEqual(ids.slice(12));

    await pass(scheduler);
    await pass(scheduler);
    expect(await stripped()).toEqual(ids);
    for (const id of ids) expect((await read(store, id)).body.spec.prompt).toBeUndefined();
  });

  test("a sweep leaves a ready task dispatched in the same tick", async () => {
    const { store, fleet, scheduler } = setup();
    for (let i = 0; i < 20; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one record each
      await seed(store, queued(`d${i}`, { state: "done", doneBy: "session", createdAt: NOW - 100_000 + i }));
    }
    await store.put("r", 0, queued("r", { createdAt: NOW }));
    await scheduler.takeover();
    await pass(scheduler);
    expect(fleet.spawns.map((s) => s.request.taskId)).toEqual(["r"]);
  });

  test("a refused cleanup write is reported without the prompt, and not retried in the term", async () => {
    const { store, scheduler, errors } = setup();
    await seed(store, queued("bad", { state: "done", doneBy: "session", createdAt: NOW - 3 }), 3);
    for (const id of ["a", "b"]) {
      // oxlint-disable-next-line no-await-in-loop -- one record each
      await seed(store, queued(id, { state: "done", doneBy: "session", createdAt: NOW - 2 }), 3);
    }
    await scheduler.takeover();
    store.failNext({ code: "refused" });
    await pass(scheduler);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("refused");
    expect(String(errors[0])).not.toContain("do it");
    const refused = await read(store, "bad");
    expect(refused.version).toBe(3);
    expect(refused.body.spec.prompt).toBe("do it");
    // The records after it went through in the same pass.
    for (const id of ["a", "b"]) expect((await read(store, id)).body.spec.prompt).toBeUndefined();

    // A record the store keeps refusing is not selected again: no write, no second report.
    store.failNext({ code: "refused" });
    await pass(scheduler);
    expect(errors).toHaveLength(1);
    expect((await read(store, "bad")).version).toBe(3);
    await pass(scheduler);
    expect((await read(store, "bad")).version).toBe(3);
  });

  test("a refused cleanup write does not take the slots of the others, and a new term tries it again", async () => {
    const { store, scheduler, errors } = setup();
    await seed(store, queued("bad", { state: "done", doneBy: "session", createdAt: NOW - 100 }), 3);
    const ids = Array.from({ length: 9 }, (_, i) => `d${i}`);
    for (const [i, id] of ids.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one record each
      await seed(store, queued(id, { state: "done", doneBy: "session", createdAt: NOW - 50 + i }));
    }
    await scheduler.takeover();
    store.failNext({ code: "refused" });
    await pass(scheduler);
    expect(errors).toHaveLength(1);
    // "bad" was first and took a slot; the next pass skips it, so all of the remaining records go in two.
    await pass(scheduler);
    for (const id of ids) expect((await read(store, id)).body.spec.prompt).toBeUndefined();
    expect((await read(store, "bad")).body.spec.prompt).toBe("do it");

    await scheduler.takeover();
    await pass(scheduler);
    const retried = await read(store, "bad");
    expect(retried.version).toBe(4);
    expect(retried.body.spec.prompt).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  test("a revoked term ends the sweep and leaves the record as it was", async () => {
    const { store, scheduler } = setup();
    await seed(store, queued("t", { state: "done", doneBy: "session" }), 3);
    await scheduler.takeover();
    store.failNext({ code: "revoked" });
    await expect(scheduler.tick()).rejects.toBeInstanceOf(StoreRevoked);
    await scheduler.drain().catch(() => undefined);
    const record = await read(store, "t");
    expect(record.version).toBe(3);
    expect(record.body.spec.prompt).toBe("do it");
  });
});
