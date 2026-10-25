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
import { escalation, inputAlert, inputClock } from "../src/alerts.ts";
import { advance } from "../src/task.ts";
import { enqueue, exclave, FakeFleet, machine, NOW, NOW_S, obs, readerChecked, spec, status } from "./fixtures.ts";

const MINUTE = 60_000;

/** The escalation alone: the first alert is debounced past it, so a stay escalates before it would fire. */
const ESCALATION_ONLY: SchedulerConfig = { ...DEFAULT_CONFIG, needsInputAlertMs: 60 * MINUTE };

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
    const { alerts, clock, fleet, make, scheduler, store } = setup(undefined, undefined, ESCALATION_ONLY);
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
    expect(alerts[0]).toMatchObject({ kind: "needs-input", taskId: task.id, since: NOW, escalated: true });

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
    expect(left.body).not.toHaveProperty("inputAlerted");
  });

  test("lost keeps the clock: the stay resumes where it was, and never alerts twice", async () => {
    const { alerts, clock, fleet, scheduler, store } = setup(undefined, undefined, ESCALATION_ONLY);
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

  test("lost and back through its machine's sessions alone: waiting again on the original clock, escalated once", async () => {
    const { alerts, clock, fleet, scheduler, store } = setup(undefined, undefined, ESCALATION_ONLY);
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    const from = { deviceId: "a", pane: scheduler.task(task.id)?.assignment?.pane ?? "" };
    await scheduler.onSession(task.id, "needs-input", from);

    clock.now = NOW + MINUTE;
    fleet.fleet = fleet.fleet.map((m) => ({ ...m, connected: false }));
    await scheduler.tick();
    clock.now = NOW + MINUTE + DEFAULT_CONFIG.lostAfterMs;
    await scheduler.tick();
    expect(scheduler.task(task.id)).toMatchObject({ state: "lost", needsInputSince: NOW });

    // Back, its session still waiting: no event re-sends the wait, so only `sessions` speaks.
    fleet.fleet = fleet.fleet.map((m) => ({ ...m, connected: true }));
    await pass(scheduler, fleet, clock.now);
    expect(scheduler.task(task.id)).toMatchObject({ state: "needs-input", needsInputSince: NOW });
    expect(alerts).toHaveLength(0);

    clock.now = NOW + 30 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    clock.now = NOW + 60 * MINUTE;
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

  test("inputAlert: due once per stay after the debounce, never for an escalated or unstamped one", () => {
    const running: Task = { id: "x", spec: spec(), state: "running", createdAt: NOW };
    const waiting = inputClock(advance(running, "needs-input"), NOW);
    expect(inputAlert(waiting, NOW + 2 * MINUTE - 1, 2 * MINUTE)).toBeNull();
    const due = inputAlert(waiting, NOW + 2 * MINUTE, 2 * MINUTE);
    expect(due).toMatchObject({ inputAlerted: true, needsInputSince: NOW });
    if (due === null) throw new Error("not due");
    expect(inputAlert(due, NOW + 60 * MINUTE, 2 * MINUTE)).toBeNull();
    expect(inputAlert({ ...waiting, escalated: true }, NOW + 60 * MINUTE, 2 * MINUTE)).toBeNull();
    const { needsInputSince: _since, ...unstamped } = waiting;
    expect(inputAlert(unstamped, NOW + 60 * MINUTE, 2 * MINUTE)).toBeNull();
    expect(inputAlert(running, NOW + 60 * MINUTE, 2 * MINUTE)).toBeNull();
    const left = inputClock(advance(due, "running"), NOW + 3 * MINUTE);
    expect(left).not.toHaveProperty("inputAlerted");
    const lost = inputClock(advance(due, "lost", { absentSince: NOW }), NOW + 3 * MINUTE);
    expect(lost).toMatchObject({ inputAlerted: true });
  });

  test("an escalation write that fails alerts nothing; the next pass retries it", async () => {
    // No sweep: its check's own tick would retry the write before the assertion.
    const config = { ...ESCALATION_ONLY, sweepIntervalMs: 24 * 60 * MINUTE };
    const { alerts, clock, errors, fleet, scheduler, store } = setup(undefined, undefined, config);
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

describe("needs-input first alert", () => {
  async function waiting(): Promise<
    ReturnType<typeof setup> & { id: string; from: { deviceId: string; pane: string } }
  > {
    const env = setup();
    const task = await enqueue(env.store, env.scheduler, spec());
    await pass(env.scheduler, env.fleet, env.clock.now);
    const from = { deviceId: "a", pane: env.scheduler.task(task.id)?.assignment?.pane ?? "" };
    await env.scheduler.onSession(task.id, "needs-input", from);
    return { ...env, id: task.id, from };
  }

  test("a flicker shorter than the debounce alerts nothing and writes nothing", async () => {
    const { alerts, clock, fleet, from, id, scheduler, store } = await waiting();
    const before = (await stored(store, id)).version;
    clock.now = NOW + MINUTE;
    await pass(scheduler, fleet, clock.now);
    await scheduler.onSession(id, "busy", from);
    // The stay is over: the next one starts its own clock.
    clock.now = NOW + 10 * MINUTE;
    await scheduler.onSession(id, "needs-input", from);
    clock.now = NOW + 11 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    expect(alerts).toEqual([]);
    const body = (await stored(store, id)).body;
    expect(body).toMatchObject({ state: "needs-input", needsInputSince: NOW + 10 * MINUTE });
    expect(body).not.toHaveProperty("inputAlerted");
    // busy, needs-input: two state writes; the passes between wrote nothing else.
    expect((await stored(store, id)).version).toBe(before + 2);
  });

  test("past the debounce: one alert, `inputAlerted` on the record, and no repeat from the next pass or leader", async () => {
    const { alerts, clock, fleet, id, make, scheduler, store } = await waiting();
    clock.now = NOW + 2 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "needs-input", taskId: id, since: NOW, escalated: false });
    expect((await stored(store, id)).body).toMatchObject({ inputAlerted: true });
    expect((await stored(store, id)).body).not.toHaveProperty("escalated");

    clock.now += MINUTE;
    await pass(scheduler, fleet, clock.now);
    const next = make();
    await next.takeover();
    clock.now += MINUTE;
    await pass(next, fleet, clock.now);
    expect(alerts).toHaveLength(1);
  });

  test("then the escalation at 30 min is the second and last, and leaving and re-entering re-arms both", async () => {
    const { alerts, clock, fleet, from, id, scheduler, store } = await waiting();
    clock.now = NOW + 2 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    clock.now = NOW + 30 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    clock.now = NOW + 45 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    expect(alerts.map((a) => (a.kind === "needs-input" ? a.escalated : null))).toEqual([false, true]);
    expect((await stored(store, id)).body).toMatchObject({ inputAlerted: true, escalated: true });

    await scheduler.onSession(id, "busy", from);
    expect((await stored(store, id)).body).not.toHaveProperty("inputAlerted");
    clock.now = NOW + 50 * MINUTE;
    await scheduler.onSession(id, "needs-input", from);
    clock.now = NOW + 52 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    expect(alerts).toHaveLength(3);
    expect(alerts[2]).toMatchObject({ escalated: false, since: NOW + 50 * MINUTE });
  });

  test("a stay that escalates before the debounce alerts once, as the escalation", async () => {
    const { alerts, clock, fleet, scheduler, store } = setup(undefined, undefined, {
      ...DEFAULT_CONFIG,
      needsInputAlertMs: 40 * MINUTE,
    });
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    await scheduler.onSession(task.id, "needs-input", {
      deviceId: "a",
      pane: scheduler.task(task.id)?.assignment?.pane ?? "",
    });
    clock.now = NOW + 30 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    clock.now = NOW + 41 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ escalated: true });
  });

  test("lost keeps the flags: the stay that was alerted is not alerted again on return", async () => {
    const { alerts, clock, fleet, from, id, scheduler, store } = await waiting();
    clock.now = NOW + 2 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    expect(alerts).toHaveLength(1);

    fleet.fleet = fleet.fleet.map((m) => ({ ...m, connected: false }));
    clock.now = NOW + 3 * MINUTE;
    await scheduler.tick();
    clock.now = NOW + 3 * MINUTE + DEFAULT_CONFIG.lostAfterMs;
    await scheduler.tick();
    await scheduler.drain();
    expect((await stored(store, id)).body).toMatchObject({ state: "lost", inputAlerted: true, needsInputSince: NOW });

    fleet.fleet = fleet.fleet.map((m) => ({ ...m, connected: true }));
    await scheduler.onSession(id, "needs-input", from);
    clock.now += MINUTE;
    await pass(scheduler, fleet, clock.now);
    expect(alerts).toHaveLength(1);
  });

  test("an alert write that fails alerts nothing; the next pass retries it", async () => {
    const config = { ...DEFAULT_CONFIG, sweepIntervalMs: 24 * 60 * MINUTE };
    const { alerts, clock, errors, fleet, scheduler, store } = setup(undefined, undefined, config);
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    await scheduler.onSession(task.id, "needs-input", {
      deviceId: "a",
      pane: scheduler.task(task.id)?.assignment?.pane ?? "",
    });
    clock.now = NOW + 2 * MINUTE;
    store.failNext({ code: "refused" });
    fleet.beat(clock.now);
    await scheduler.tick().catch((err: unknown) => errors.push(err));
    await scheduler.drain();
    expect(alerts).toEqual([]);
    expect((await stored(store, task.id)).body.inputAlerted).toBeUndefined();

    clock.now += MINUTE;
    await pass(scheduler, fleet, clock.now);
    expect(alerts).toHaveLength(1);
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
    const { clock, errors, fleet, scheduler, store } = setup(
      new FakeFleet([spilling(NOW_S + 3600)]),
      undefined,
      WIDE,
      () => {
        throw new Error("sink down");
      },
    );
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    expect(scheduler.task(task.id)?.state).toBe("running");
    expect(errors).toHaveLength(1);
  });

  test("the window is stamped on each dispatched record; a new leader alerts no spill for it, and one for a later window", async () => {
    const { alerts, clock, fleet, make, scheduler, store } = setup(
      new FakeFleet([spilling(NOW_S + 3600)]),
      undefined,
      WIDE,
    );
    const first = await enqueue(store, scheduler, spec());
    const second = await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    expect(alerts).toHaveLength(1);
    // Only the dispatch that alerted carries the stamp; the window is what the next leader needs.
    const stamps = [first, second].map(async (t) => (await stored(store, t.id)).body.spillAlert);
    expect((await Promise.all(stamps)).filter((s) => s !== undefined)).toEqual([
      { accountId: "org:a", window: "5h", reset: (NOW_S + 3600) * 1000 },
    ]);

    const next = make();
    await next.takeover();
    await enqueue(store, next, spec());
    await pass(next, fleet, clock.now);
    expect(alerts).toHaveLength(1);

    // Resets later by more than the grace: the next window, alerted again.
    fleet.fleet = [spilling(NOW_S + 5 * 3600)];
    const later = await enqueue(store, next, spec());
    await pass(next, fleet, clock.now);
    expect(alerts.map((a) => a.taskId)).toEqual([first.id, later.id]);
  });

  test("a session event landing before the spawn reply still leaves the stamp, and a reloaded leader stays quiet", async () => {
    const { alerts, clock, fleet, make, scheduler, store } = setup(new FakeFleet([spilling(NOW_S + 3600)]));
    // The reply waits for the pane's title; a hook's `busy` need not.
    fleet.scripts.set("a", async (request) => {
      const reply = fleet.start("a", request);
      const pane = reply.ok ? (reply.sessions[0]?.id ?? "") : "";
      await scheduler.onSession(request.taskId ?? "", "busy", { deviceId: "a", pane });
      return reply;
    });
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    expect(scheduler.task(task.id)?.state).toBe("running");
    expect(alerts).toHaveLength(1);
    expect((await stored(store, task.id)).body.spillAlert).toEqual({
      accountId: "org:a",
      window: "5h",
      reset: (NOW_S + 3600) * 1000,
    });

    fleet.scripts.delete("a");
    const next = make();
    await next.takeover();
    await enqueue(store, next, spec());
    await pass(next, fleet, clock.now);
    expect(alerts).toHaveLength(1);
  });

  test("a stamp that cannot be written costs only a repeat under the next leader; this term still alerts once", async () => {
    const { alerts, clock, errors, fleet, make, scheduler, store } = setup(new FakeFleet([spilling(NOW_S + 3600)]));
    fleet.scripts.set("a", async (request) => {
      const reply = fleet.start("a", request);
      const pane = reply.ok ? (reply.sessions[0]?.id ?? "") : "";
      await scheduler.onSession(request.taskId ?? "", "busy", { deviceId: "a", pane });
      // The event's write has landed and the verdict will decline: the next write is the stamp's.
      store.failNext({ code: "refused" });
      return reply;
    });
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    expect(alerts).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((await stored(store, task.id)).body.spillAlert).toBeUndefined();

    fleet.scripts.delete("a");
    const next = make();
    await next.takeover();
    await enqueue(store, next, spec());
    await pass(next, fleet, clock.now);
    expect(alerts).toHaveLength(2);
  });

  test("a dispatch under the line alerts nothing", async () => {
    const { alerts, clock, fleet, scheduler, store } = setup();
    await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    expect(fleet.spawns).toHaveLength(1);
    expect(alerts).toEqual([]);
  });
});
