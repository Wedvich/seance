import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  MemoryQueueStore,
  Scheduler,
  type SchedulerAlert,
  type StoredTask,
  type Task,
} from "../src/index.ts";
import { exclave, FakeFleet, machine, NOW, NOW_S, obs, spec, status } from "./fixtures.ts";

const MINUTE = 60_000;

function setup(fleet = new FakeFleet([machine("a")]), store = new MemoryQueueStore()) {
  const clock = { now: NOW };
  const alerts: SchedulerAlert[] = [];
  let n = 0;
  const make = (): Scheduler =>
    new Scheduler({
      store,
      fleet,
      config: DEFAULT_CONFIG,
      now: () => clock.now,
      newId: () => `t${++n}`,
      onAlert: (alert) => alerts.push(alert),
    });
  return { store, fleet, clock, alerts, make, scheduler: make() };
}

async function pass(scheduler: Scheduler, fleet: FakeFleet, now: number): Promise<void> {
  fleet.beat(now);
  await scheduler.tick();
  await scheduler.drain();
}

async function stored(store: MemoryQueueStore, id: string): Promise<StoredTask> {
  const entry = await store.get(id);
  if (entry === null || entry.body === undefined) throw new Error(`no readable ${id}`);
  return entry;
}

describe("needs-input escalation", () => {
  test("the clock rides the state's own write, escalates once after 30 min, and clears on leaving", async () => {
    const { alerts, clock, fleet, make, scheduler, store } = setup();
    const task = await scheduler.submit(spec());
    await pass(scheduler, fleet, clock.now);
    const pane = scheduler.task(task.id)?.assignment?.pane ?? "";
    const from = { deviceId: "a", pane };

    await scheduler.onSession(task.id, "needs-input", from);
    // Create, reserve, run, needs-input: the stamp costs no write of its own.
    expect(await stored(store, task.id)).toMatchObject({ version: 4, body: { needsInputSince: NOW } });

    clock.now = NOW + 29 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    expect((await stored(store, task.id)).version).toBe(4);
    expect(alerts).toEqual([]);

    clock.now = NOW + 30 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    expect(await stored(store, task.id)).toMatchObject({
      version: 5,
      body: { state: "needs-input", needsInputSince: NOW, escalated: true },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "needs-input", taskId: task.id, since: NOW });

    // Neither the next pass nor the next leader alerts it again, and the slot is still held.
    clock.now += MINUTE;
    await pass(scheduler, fleet, clock.now);
    const next = make();
    await next.takeover();
    clock.now += MINUTE;
    await pass(next, fleet, clock.now);
    expect(alerts).toHaveLength(1);
    expect(next.preview(spec()).candidates[0]?.score?.components.queuePressure).toBe(1);

    await next.onSession(task.id, "busy", from);
    const left = await stored(store, task.id);
    expect(left.body.state).toBe("running");
    expect(left.body).not.toHaveProperty("needsInputSince");
    expect(left.body).not.toHaveProperty("escalated");
  });

  test("a stay an older leader never stamped starts its clock with one write, alerting nothing", async () => {
    const store = new MemoryQueueStore();
    const at = { deviceId: "a", exclave: "main", clone: "app", pane: "%1" };
    const body: Task = { id: "old", spec: spec(), state: "needs-input", createdAt: NOW - 3600_000, assignment: at };
    await store.put("old", 0, body);
    const { alerts, clock, fleet, scheduler } = setup(new FakeFleet([machine("a")]), store);
    fleet.running.set("a", [{ id: "%1", window: "w", repo: "app", path: "/wt/old", taskId: "old" }]);
    await scheduler.takeover();
    await pass(scheduler, fleet, clock.now);
    expect(await stored(store, "old")).toMatchObject({ version: 2, body: { needsInputSince: NOW } });
    expect(alerts).toEqual([]);
  });
});

/** Machine `a` whose account is over the line in its 5h window, resetting at `hr`, with extra usage on. */
function spilling(hr: number): ReturnType<typeof machine> {
  return machine("a", {
    exclaves: [exclave("main", "org:a", { extraUsageEnabled: true })],
    status: status({ quota: [obs(0, { h: 95, hr })] }),
  });
}

describe("credits spill", () => {
  test("alerted once per account per window, not per task; again once the window has reset", async () => {
    const { alerts, clock, fleet, scheduler, store } = setup(new FakeFleet([spilling(NOW_S + 3600)]));
    const first = await scheduler.submit(spec());
    const second = await scheduler.submit(spec());
    await pass(scheduler, fleet, clock.now);
    expect(scheduler.task(first.id)?.state).toBe("running");
    expect(scheduler.task(second.id)?.state).toBe("running");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "spill", taskId: first.id, accountId: "org:a", window: "5h" });
    // Each task's record carries the spill its dispatch made.
    expect((await stored(store, second.id)).body.decision?.candidates[0]?.spill).toEqual({
      window: "5h",
      projectedPct: 105,
    });

    // The next 5h window, as full: a new spill.
    fleet.fleet = [spilling(NOW_S + 5 * 3600)];
    const third = await scheduler.submit(spec());
    await pass(scheduler, fleet, clock.now);
    expect(alerts.map((a) => a.taskId)).toEqual([first.id, third.id]);
  });

  test("a dispatch under the line alerts nothing", async () => {
    const { alerts, clock, fleet, scheduler } = setup();
    await scheduler.submit(spec());
    await pass(scheduler, fleet, clock.now);
    expect(fleet.spawns).toHaveLength(1);
    expect(alerts).toEqual([]);
  });
});
