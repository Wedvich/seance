import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  MemoryQueueStore,
  Scheduler,
  type SchedulerAlert,
  type SchedulerConfig,
  type StoredTask,
  type Task,
} from "../src/index.ts";
import { escalation, inputClock } from "../src/alerts.ts";
import { advance } from "../src/task.ts";
import { enqueue, exclave, FakeFleet, machine, NOW, NOW_S, obs, readerChecked, spec, status } from "./fixtures.ts";

const MINUTE = 60_000;

function setup(
  fleet = new FakeFleet([machine("a")]),
  store = new MemoryQueueStore(),
  config: SchedulerConfig = DEFAULT_CONFIG,
  sink?: (alert: SchedulerAlert) => void,
) {
  const clock = { now: NOW };
  const alerts: SchedulerAlert[] = [];
  const errors: unknown[] = [];
  const make = (): Scheduler =>
    new Scheduler({
      store: readerChecked(store, () => clock.now),
      fleet,
      config,
      now: () => clock.now,
      onAlert: sink ?? ((alert) => void alerts.push(alert)),
      onError: (err) => errors.push(err),
    });
  return { store, fleet, clock, alerts, errors, make, scheduler: make() };
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
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    const pane = scheduler.task(task.id)?.assignment?.pane ?? "";
    const from = { deviceId: "a", pane };

    await scheduler.onSession(task.id, "needs-input", from);
    // Create, admit, reserve, run, needs-input: the stamp costs no write of its own.
    expect(await stored(store, task.id)).toMatchObject({ version: 5, body: { needsInputSince: NOW } });

    clock.now = NOW + 29 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    expect((await stored(store, task.id)).version).toBe(5);
    expect(alerts).toEqual([]);

    clock.now = NOW + 30 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    expect(await stored(store, task.id)).toMatchObject({
      version: 6,
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

  test("lost keeps the clock: the stay resumes where it was, and never alerts twice", async () => {
    const { alerts, clock, fleet, scheduler, store } = setup();
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    const from = { deviceId: "a", pane: scheduler.task(task.id)?.assignment?.pane ?? "" };
    await scheduler.onSession(task.id, "needs-input", from);

    // The machine goes quiet past lostAfterMs; the stay is still the one stamped at NOW.
    clock.now = NOW + 5 * MINUTE;
    fleet.fleet = fleet.fleet.map((m) => ({ ...m, connected: false }));
    await scheduler.tick();
    clock.now = NOW + 21 * MINUTE;
    await scheduler.tick();
    await scheduler.drain();
    expect(await stored(store, task.id)).toMatchObject({ body: { state: "lost", needsInputSince: NOW } });

    clock.now = NOW + 22 * MINUTE;
    fleet.fleet = fleet.fleet.map((m) => ({ ...m, connected: true }));
    await scheduler.onSession(task.id, "needs-input", from);
    expect((await stored(store, task.id)).body).toMatchObject({ state: "needs-input", needsInputSince: NOW });

    clock.now = NOW + 30 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "needs-input", since: NOW });
  });

  test("inputClock: lost keeps both fields, any other leaving clears them, an escalated stay is not due again", () => {
    const running: Task = { id: "x", spec: spec(), state: "running", createdAt: NOW };
    const waiting = inputClock(advance(running, "needs-input"), NOW);
    const escalated: Task = { ...waiting, escalated: true };
    const lost = inputClock(advance(escalated, "lost", { absentSince: NOW }), NOW + MINUTE);
    expect(lost).toMatchObject({ needsInputSince: NOW, escalated: true });
    const back = inputClock(advance(lost, "needs-input"), NOW + 2 * MINUTE);
    expect(back).toMatchObject({ needsInputSince: NOW, escalated: true });
    expect(escalation(back, NOW + 60 * MINUTE, 30 * MINUTE)).toBeNull();
    const left = inputClock(advance(lost, "running"), NOW + 2 * MINUTE);
    expect(left).not.toHaveProperty("needsInputSince");
    expect(left).not.toHaveProperty("escalated");
  });

  test("an escalation write that fails alerts nothing; the next pass retries it", async () => {
    const { alerts, clock, errors, fleet, scheduler, store } = setup();
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    const pane = scheduler.task(task.id)?.assignment?.pane ?? "";
    await scheduler.onSession(task.id, "needs-input", { deviceId: "a", pane });
    clock.now = NOW + 30 * MINUTE;
    store.failNext({ code: "refused" });
    fleet.beat(clock.now);
    await scheduler.tick().catch((err: unknown) => errors.push(err));
    await scheduler.drain();
    expect(alerts).toEqual([]);
    expect((await stored(store, task.id)).body.escalated).toBeUndefined();

    clock.now += MINUTE;
    await pass(scheduler, fleet, clock.now);
    expect(alerts).toHaveLength(1);
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
    const first = await enqueue(store, scheduler, spec());
    const second = await enqueue(store, scheduler, spec());
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
    const third = await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    expect(alerts.map((a) => a.taskId)).toEqual([first.id, third.id]);
  });

  const WIDE: SchedulerConfig = { ...DEFAULT_CONFIG, accountMax: 20, globalMax: 20 };
  const noReset = machine("a", {
    exclaves: [exclave("main", "org:a", { extraUsageEnabled: true })],
    status: status({ quota: [obs(0, { h: 95 })] }),
  });

  test("one window is one alert across reading jitter and a reading without its reset; the next window alerts", async () => {
    const { alerts, clock, fleet, scheduler, store } = setup(new FakeFleet([spilling(NOW_S + 3600)]), undefined, WIDE);
    const spillOnce = async (): Promise<void> => {
      await enqueue(store, scheduler, spec());
      await pass(scheduler, fleet, clock.now);
    };
    await spillOnce();
    expect(alerts).toHaveLength(1);

    // Another source's reading of the same reset, a second off.
    fleet.fleet = [spilling(NOW_S + 3601)];
    await spillOnce();
    // Resets stripped, then back.
    fleet.fleet = [noReset];
    await spillOnce();
    fleet.fleet = [spilling(NOW_S + 3600)];
    await spillOnce();
    expect(alerts).toHaveLength(1);

    fleet.fleet = [spilling(NOW_S + 5 * 3600)];
    await spillOnce();
    expect(alerts).toHaveLength(2);
  });

  test("a refused spawn alerts nothing and leaves the window's alert for the next confirmed spill", async () => {
    const { alerts, clock, fleet, scheduler, store } = setup(new FakeFleet([spilling(NOW_S + 3600)]), undefined, WIDE);
    fleet.scripts.set("a", () => ({ ok: false, code: "launch_error", message: "no" }));
    await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    expect(alerts).toEqual([]);

    fleet.scripts.delete("a");
    const next = await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "spill", taskId: next.id });
  });

  test("a throwing onAlert goes to onError and the task still launches", async () => {
    const { clock, errors, fleet, scheduler, store } = setup(new FakeFleet([spilling(NOW_S + 3600)]), undefined, WIDE, () => {
      throw new Error("sink down");
    });
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    expect(scheduler.task(task.id)?.state).toBe("running");
    expect(errors).toHaveLength(1);
  });

  test("a dispatch under the line alerts nothing", async () => {
    const { alerts, clock, fleet, scheduler, store } = setup();
    await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    expect(fleet.spawns).toHaveLength(1);
    expect(alerts).toEqual([]);
  });
});
