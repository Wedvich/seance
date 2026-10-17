import { describe, expect, test } from "bun:test";
import { MAX_PAUSE_HOLDS } from "@seance/shared";
import { DEFAULT_CONFIG, MemoryQueueStore, Scheduler, StoreRevoked } from "../src/index.ts";
import { FakeFleet, machine, NOW, NOW_S, obs, readerChecked, spec, status } from "./fixtures.ts";

function setup(fleet = new FakeFleet([machine("a")]), store = new MemoryQueueStore()) {
  const clock = { now: NOW };
  const errors: unknown[] = [];
  let n = 0;
  const make = (): Scheduler =>
    new Scheduler({
      store: readerChecked(store, () => clock.now),
      fleet,
      config: DEFAULT_CONFIG,
      now: () => clock.now,
      newId: () => `t${++n}`,
      onError: (err) => errors.push(err),
    });
  return { store, fleet, clock, errors, make, scheduler: make() };
}

async function pass(scheduler: Scheduler): Promise<void> {
  await scheduler.tick();
  await scheduler.drain();
}

describe("pause and resume", () => {
  test("pause stops dispatch and keeps the running session; resume continues", async () => {
    const { fleet, scheduler, store } = setup();
    const first = await scheduler.submit(spec());
    await pass(scheduler);
    expect(scheduler.task(first.id)?.state).toBe("running");

    expect(await scheduler.pause({ until: "resume" })).toEqual({ ok: true, holds: [{ until: "resume", at: NOW }] });
    const second = await scheduler.submit(spec());
    await pass(scheduler);
    expect(fleet.spawns).toHaveLength(1);
    expect(fleet.despawns).toEqual([]);
    expect(scheduler.task(first.id)?.state).toBe("running");
    expect(scheduler.task(second.id)?.state).toBe("ready");
    expect(scheduler.lastDecision(second.id)?.candidates[0]?.rejected).toEqual([
      { code: "paused", until: "resume", scope: "queue" },
    ]);
    // Pausing again changes nothing, so writes nothing.
    await scheduler.pause({ until: "resume" });
    expect((await store.getPause())?.version).toBe(1);

    expect(await scheduler.resume({})).toEqual({ ok: true, holds: [] });
    await pass(scheduler);
    expect(scheduler.task(second.id)?.state).toBe("running");
  });

  test("an account hold sends work to another account, and a preview says why", async () => {
    const { scheduler } = setup(new FakeFleet([machine("a"), machine("b")]));
    await scheduler.pause({ until: "resume", account: "org:a" });
    expect(scheduler.preview(spec()).candidates.find((c) => c.deviceId === "a")?.rejected).toEqual([
      { code: "paused", until: "resume", scope: "account" },
    ]);
    const task = await scheduler.submit(spec());
    await pass(scheduler);
    expect(scheduler.task(task.id)?.assignment?.deviceId).toBe("b");
    // Resuming an account that holds nothing, or the queue when only an account is held, lifts nothing.
    expect(await scheduler.resume({ account: "org:b" })).toMatchObject({ holds: [{ account: "org:a" }] });
    expect(await scheduler.resume({})).toMatchObject({ holds: [{ account: "org:a" }] });
  });

  test("holds outlive the leader: the next one's takeover reads them before it dispatches", async () => {
    const { fleet, make, scheduler } = setup();
    await scheduler.pause({ until: "resume" });
    await scheduler.submit(spec());
    const next = make();
    await next.takeover();
    expect(next.holds()).toEqual([{ until: "resume", at: NOW }]);
    await pass(next);
    expect(fleet.spawns).toEqual([]);
  });

  test("until reset lifts at the account's reset with no resume and no write; reset_unknown with no reading", async () => {
    const resetAt = (NOW_S + 3600) * 1000;
    const full = machine("a", { status: status({ quota: [obs(0, { h: 95, hr: NOW_S + 3600 })] }) });
    const { clock, fleet, scheduler, store } = setup(new FakeFleet([full]));
    expect(await scheduler.pause({ until: "reset", account: "org:zz" })).toEqual({ ok: false, code: "reset_unknown" });
    expect(await scheduler.pause({ until: "reset", account: "org:a" })).toEqual({
      ok: true,
      holds: [{ account: "org:a", until: "reset", at: NOW, resumeAt: resetAt }],
    });
    const task = await scheduler.submit(spec());

    clock.now = resetAt;
    fleet.beat(clock.now);
    expect(scheduler.holds()).toEqual([]);
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("running");
    expect((await store.getPause())?.version).toBe(1);
    // The next write drops the lifted hold.
    expect(await scheduler.pause({ until: "resume" })).toEqual({ ok: true, holds: [{ until: "resume", at: resetAt }] });
    expect(await store.getPause()).toEqual({ version: 2, holds: [{ until: "resume", at: resetAt }] });
  });

  test("a lost race is applied again to what the store holds; one that keeps losing is conflict", async () => {
    const { scheduler, store } = setup();
    store.failNext({ code: "version_conflict" });
    expect(await scheduler.pause({ until: "resume" })).toMatchObject({ ok: true });
    expect((await store.getPause())?.version).toBe(1);

    for (let i = 0; i < 3; i += 1) store.failNext({ code: "version_conflict" });
    expect(await scheduler.resume({})).toEqual({ ok: false, code: "conflict" });
    expect(scheduler.holds()).toHaveLength(1);

    // A reply lost after the write committed: the one version past ours is ours.
    store.failNext({ code: "indeterminate", commit: true });
    expect(await scheduler.resume({})).toEqual({ ok: true, holds: [] });
    expect(await store.getPause()).toEqual({ version: 2, holds: [] });
  });

  test("an unreadable record holds the whole queue, is reported, and a resume overwrites it at its version", async () => {
    const store = new MemoryQueueStore();
    store.plantPause("unopenable", 3);
    const { errors, fleet, scheduler } = setup(new FakeFleet([machine("a")]), store);
    await scheduler.takeover();
    expect(errors).toHaveLength(1);
    expect(scheduler.holds()).toEqual([{ until: "resume", at: NOW }]);
    await scheduler.submit(spec());
    await pass(scheduler);
    expect(fleet.spawns).toEqual([]);

    expect(await scheduler.resume({})).toEqual({ ok: true, holds: [] });
    expect(await store.getPause()).toEqual({ version: 4, holds: [] });
    await pass(scheduler);
    expect(fleet.spawns).toHaveLength(1);
  });

  test("account holds stop one short of MAX_PAUSE_HOLDS, so a whole-queue pause always fits", async () => {
    const { scheduler } = setup();
    for (let i = 0; i < MAX_PAUSE_HOLDS - 1; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each write follows the last
      expect(await scheduler.pause({ until: "resume", account: `org:${i}` })).toMatchObject({ ok: true });
    }
    expect(await scheduler.pause({ until: "resume", account: "org:extra" })).toEqual({ ok: false, code: "full" });
    // Replacing a hold already held still fits.
    expect(await scheduler.pause({ until: "resume", account: "org:0" })).toMatchObject({ ok: true });
    expect(await scheduler.pause({ until: "resume" })).toMatchObject({ ok: true });
    expect(scheduler.holds()).toHaveLength(MAX_PAUSE_HOLDS);
  });

  test("a revoked term unwinds the pause write; a reply lost before it committed retries at the same version", async () => {
    const { scheduler, store } = setup();
    store.failNext({ code: "revoked" });
    await expect(scheduler.pause({ until: "resume" })).rejects.toBeInstanceOf(StoreRevoked);
    expect(await store.getPause()).toBeNull();

    store.failNext({ code: "indeterminate" });
    expect(await scheduler.pause({ until: "resume" })).toMatchObject({ ok: true });
    expect(await store.getPause()).toEqual({ version: 1, holds: [{ until: "resume", at: NOW }] });
  });

  test("an account pause over an unreadable record persists the synthetic queue hold until a resume", async () => {
    const store = new MemoryQueueStore();
    store.plantPause("unopenable", 3);
    const { clock, scheduler } = setup(new FakeFleet([machine("a")]), store);
    await scheduler.takeover();
    clock.now = NOW + 60_000;
    expect(await scheduler.pause({ until: "resume", account: "org:a" })).toMatchObject({ ok: true });
    // The queue hold keeps the read time as its `at` and is now a real record.
    expect(await store.getPause()).toEqual({
      version: 4,
      holds: [
        { until: "resume", at: NOW },
        { account: "org:a", until: "resume", at: NOW + 60_000 },
      ],
    });
    expect(await scheduler.resume({})).toMatchObject({ ok: true, holds: [{ account: "org:a" }] });
  });
});
