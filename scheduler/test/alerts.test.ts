import { describe, expect, test } from "bun:test";
import type { PrStatus } from "@seance/shared";
import {
  DEFAULT_CONFIG,
  MemoryQueueStore,
  Scheduler,
  type SchedulerAlert,
  type SchedulerConfig,
  type StoredTask,
  type Task,
} from "../src/index.ts";
import { escalation, inputAlert, inputClock, prBlockedAlert } from "../src/alerts.ts";
import { advance } from "../src/task.ts";
import {
  accountMax,
  enqueue,
  exclave,
  FakeFleet,
  machine,
  NOW,
  NOW_S,
  obs,
  readerChecked,
  spec,
  status,
} from "./fixtures.ts";

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

  test("inputClock: the stay's reason and tool go with the clock, but ride a lost task", () => {
    const running: Task = { id: "x", spec: spec(), state: "running", createdAt: NOW };
    const waiting = inputClock(
      { ...advance(running, "needs-input"), inputReason: "permission", inputTool: "Bash" },
      NOW,
    );
    const lost = inputClock(advance(waiting, "lost", { absentSince: NOW }), NOW + MINUTE);
    expect(lost).toMatchObject({ inputReason: "permission", inputTool: "Bash" });
    const left = inputClock(advance(waiting, "running"), NOW + MINUTE);
    expect(left).not.toHaveProperty("inputReason");
    expect(left).not.toHaveProperty("inputTool");
  });

  test("inputAlert: due once per stay after the debounce, never for an escalated or unstamped one", () => {
    const running: Task = { id: "x", spec: spec(), state: "running", createdAt: NOW };
    const waiting = inputClock(advance(running, "needs-input"), NOW);
    const alertDue = (task: Task, at: number): Task | null => inputAlert(task, at, 2 * MINUTE, 30 * MINUTE);
    expect(alertDue(waiting, NOW + 2 * MINUTE - 1)).toBeNull();
    const due = alertDue(waiting, NOW + 2 * MINUTE);
    expect(due).toMatchObject({ inputAlerted: true, needsInputSince: NOW });
    if (due === null) throw new Error("not due");
    expect(alertDue(due, NOW + 10 * MINUTE)).toBeNull();
    expect(alertDue({ ...waiting, escalated: true }, NOW + 10 * MINUTE)).toBeNull();
    // Past the escalation too: that alert is the one.
    expect(alertDue(waiting, NOW + 30 * MINUTE)).toBeNull();
    const { needsInputSince: _since, ...unstamped } = waiting;
    expect(alertDue(unstamped, NOW + 10 * MINUTE)).toBeNull();
    expect(alertDue(running, NOW + 10 * MINUTE)).toBeNull();
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

  test("a stay already past both thresholds when a leader takes it over is one alert, the escalation's", async () => {
    const store = new MemoryQueueStore();
    const at = { deviceId: "a", exclave: "main", clone: "app", pane: "%1" };
    const body: Task = {
      id: "old",
      spec: spec(),
      state: "needs-input",
      createdAt: NOW - 7200_000,
      needsInputSince: NOW - 3600_000,
      assignment: at,
    };
    await store.put("old", 0, body);
    const { alerts, clock, fleet, scheduler } = setup(new FakeFleet([machine("a")]), store);
    fleet.running.set("a", [{ id: "%1", window: "w", repo: "app", path: "/wt/old", taskId: "old" }]);
    await scheduler.takeover();
    await pass(scheduler, fleet, clock.now);
    expect(alerts.map((a) => (a.kind === "needs-input" ? a.escalated : null))).toEqual([true]);
    expect((await stored(store, "old")).body).not.toHaveProperty("inputAlerted");
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

describe("needs-input question alert", () => {
  async function running(): Promise<
    ReturnType<typeof setup> & { id: string; from: { deviceId: string; pane: string } }
  > {
    const env = setup();
    const task = await enqueue(env.store, env.scheduler, spec());
    await pass(env.scheduler, env.fleet, env.clock.now);
    const from = { deviceId: "a", pane: env.scheduler.task(task.id)?.assignment?.pane ?? "" };
    return { ...env, id: task.id, from };
  }

  test("alerted at once, in the write that enters the stay; no 2-minute alert after it, and the escalation still comes", async () => {
    const { alerts, clock, fleet, from, id, make, scheduler, store } = await running();
    const before = (await stored(store, id)).version;
    await scheduler.onSession(id, "needs-input", { ...from, reason: "question" });
    expect(alerts).toEqual([
      {
        kind: "needs-input",
        taskId: id,
        since: NOW,
        escalated: false,
        question: true,
        message: `needs input: task="${id}" asking a question`,
      },
    ]);
    expect((await stored(store, id)).body).toMatchObject({
      state: "needs-input",
      inputAlerted: true,
      needsInputSince: NOW,
    });
    expect((await stored(store, id)).version).toBe(before + 1);

    // The same question again, the pass past the debounce, and a new leader: nothing more.
    await scheduler.onSession(id, "needs-input", { ...from, reason: "question" });
    clock.now = NOW + 3 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    const next = make();
    await next.takeover();
    clock.now = NOW + 4 * MINUTE;
    await pass(next, fleet, clock.now);
    expect(alerts).toHaveLength(1);

    clock.now = NOW + 30 * MINUTE;
    await pass(next, fleet, clock.now);
    expect(alerts.map((a) => (a.kind === "needs-input" ? [a.escalated, a.question] : null))).toEqual([
      [false, true],
      [true, undefined],
    ]);
  });

  test("a question opening in a stay already waiting is alerted then, once; a stay already alerted is not again", async () => {
    const { alerts, clock, fleet, from, id, scheduler } = await running();
    await scheduler.onSession(id, "needs-input", from);
    clock.now = NOW + MINUTE;
    await scheduler.onSession(id, "needs-input", { ...from, reason: "question" });
    expect(alerts).toMatchObject([{ kind: "needs-input", since: NOW, question: true }]);

    // Leaving re-arms it; a plain stay alerted at 2 minutes takes no question alert after.
    await scheduler.onSession(id, "busy", from);
    clock.now = NOW + 10 * MINUTE;
    await scheduler.onSession(id, "needs-input", from);
    clock.now = NOW + 12 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    await scheduler.onSession(id, "needs-input", { ...from, reason: "question" });
    expect(alerts.map((a) => (a.kind === "needs-input" ? a.question : null))).toEqual([true, undefined]);
  });

  test("another machine's question alerts nothing and writes nothing", async () => {
    const { alerts, from, id, scheduler, store } = await running();
    await scheduler.onSession(id, "needs-input", from);
    const before = (await stored(store, id)).version;
    await scheduler.onSession(id, "needs-input", { deviceId: "b", pane: from.pane, reason: "question" });
    expect(alerts).toEqual([]);
    expect((await stored(store, id)).version).toBe(before);
    expect((await stored(store, id)).body).not.toHaveProperty("inputAlerted");
  });

  test("a permission reason never raises the at-once alert", async () => {
    const { alerts, from, id, scheduler } = await running();
    await scheduler.onSession(id, "needs-input", { ...from, reason: "permission", tool: "Bash" });
    expect(alerts).toEqual([]);
  });

  test("a question reason beside any other state alerts nothing", async () => {
    const { alerts, from, id, scheduler } = await running();
    await scheduler.onSession(id, "busy", { ...from, reason: "question" });
    await scheduler.onSession(id, "idle", { ...from, reason: "question" });
    expect(alerts).toEqual([]);
  });

  test("a question in a stay already past the escalation mark alerts nothing; the escalation is the one push", async () => {
    const { alerts, clock, fleet, from, id, scheduler } = await running();
    await scheduler.onSession(id, "needs-input", from);
    clock.now = NOW + 31 * MINUTE;
    await scheduler.onSession(id, "needs-input", { ...from, reason: "question" });
    expect(alerts).toEqual([]);
    await pass(scheduler, fleet, clock.now);
    expect(alerts).toMatchObject([{ kind: "needs-input", escalated: true }]);
    expect(alerts[0]).not.toHaveProperty("question");
  });

  test("a version conflict applies the question again to what the store holds: a stay another write alerted alerts nothing", async () => {
    const { alerts, from, id, scheduler, store } = await running();
    await scheduler.onSession(id, "needs-input", from);
    const entry = await stored(store, id);
    // Out of band, so the leader's held version is stale and its first write conflicts.
    await store.put(id, entry.version, { ...entry.body, inputAlerted: true });
    // A PR URL beside it, so the retry still writes: what is left to keep the alert back is the retry's own verdict.
    const prUrl = "https://github.com/o/r/pull/1";
    await scheduler.onSession(id, "needs-input", { ...from, reason: "question" }, prUrl);
    expect((await stored(store, id)).body).toMatchObject({ prUrl, inputAlerted: true });
    expect(alerts).toEqual([]);
  });

  test("a question as the first event on a reserved task resolves the reservation and alerts once", async () => {
    const { alerts, from, id, scheduler, store } = await running();
    // Put the running task back to its reservation: the spawn landed, the reply was lost.
    const entry = await stored(store, id);
    const { assignment, ...rest } = entry.body;
    await store.put(id, entry.version, {
      ...rest,
      state: "reserved",
      reservation: { deviceId: "a", exclave: assignment?.exclave ?? "main", clone: "app", expiresAt: NOW + 120_000 },
      reservedAt: NOW,
    });
    await scheduler.load();
    await scheduler.onSession(id, "needs-input", { ...from, reason: "question" });
    expect(alerts).toMatchObject([{ kind: "needs-input", taskId: id, question: true }]);
    expect((await stored(store, id)).body).toMatchObject({ state: "needs-input", inputAlerted: true });
  });

  test("a question write that fails alerts nothing; the 2-minute pass is still there for the stay", async () => {
    const { alerts, clock, fleet, from, id, scheduler, store } = await running();
    await scheduler.onSession(id, "needs-input", from);
    store.failNext({ code: "refused" });
    await scheduler.onSession(id, "needs-input", { ...from, reason: "question" });
    expect(alerts).toEqual([]);
    clock.now = NOW + 2 * MINUTE;
    await pass(scheduler, fleet, clock.now);
    expect(alerts).toMatchObject([{ kind: "needs-input", escalated: false }]);
    expect(alerts[0]).not.toHaveProperty("question");
  });
});

/** Machine `a` whose account reads `h`% in its 5h window — over the line by default — resetting at `hr`, with extra usage on. */
function spilling(hr: number, h = 95): ReturnType<typeof machine> {
  return machine("a", {
    exclaves: [exclave("main", "org:a", { extraUsageEnabled: true })],
    status: status({ quota: [obs(0, { h, hr })] }),
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

  const WIDE: SchedulerConfig = { ...DEFAULT_CONFIG, ...accountMax(20), globalMax: 20 };
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

  test("a window warned of alerts once more when it fills, and a new leader holds both alerts", async () => {
    const { alerts, clock, fleet, make, scheduler, store } = setup(
      new FakeFleet([spilling(NOW_S + 3600)]),
      undefined,
      WIDE,
    );
    const forecast = await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    expect(alerts).toEqual([expect.objectContaining({ kind: "spill", taskId: forecast.id, window: "5h" })]);
    expect(alerts[0]).not.toHaveProperty("spending");
    expect(alerts[0]?.message).toStartWith("may spill into credits:");

    // The same window, now full: credits are billing, which the forecast did not say.
    fleet.fleet = [spilling(NOW_S + 3600, 100)];
    const spending = await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    expect(alerts.map((a) => a.taskId)).toEqual([forecast.id, spending.id]);
    expect(alerts[1]).toMatchObject({ kind: "spill", window: "5h", spending: true });
    expect(alerts[1]?.message).toStartWith("spending credits:");
    expect((await stored(store, spending.id)).body.spillAlert).toEqual({
      accountId: "org:a",
      window: "5h",
      reset: (NOW_S + 3600) * 1000,
      at: NOW,
      spending: true,
    });

    const next = make();
    await next.takeover();
    await enqueue(store, next, spec());
    await pass(next, fleet, clock.now);
    fleet.fleet = [spilling(NOW_S + 3600)];
    await enqueue(store, next, spec());
    await pass(next, fleet, clock.now);
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
      { accountId: "org:a", window: "5h", reset: (NOW_S + 3600) * 1000, at: NOW },
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
      at: NOW,
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

  describe("a stamp a later term reads", () => {
    const HOUR = 60 * MINUTE;
    /** `spilling`, its quota reading `at` seconds, so an advanced clock does not age it past use. */
    const fresh = (hr: number | undefined, clock: { now: number }): ReturnType<typeof machine> =>
      machine("a", {
        exclaves: [exclave("main", "org:a", { extraUsageEnabled: true })],
        status: status({ quota: [obs(0, { h: 95, ...(hr === undefined ? {} : { hr }), at: clock.now / 1000 - 60 })] }),
      });

    /** A first term alerts a spill whose reading carries `hr`, then `later` ms pass and a second term reads the record. */
    async function laterTerm(hr: number | undefined, later: number, then: number | undefined) {
      const env = setup(new FakeFleet([fresh(hr, { now: NOW })]), undefined, WIDE);
      await enqueue(env.store, env.scheduler, spec());
      await pass(env.scheduler, env.fleet, env.clock.now);
      expect(env.alerts).toHaveLength(1);
      env.clock.now = NOW + later;
      env.fleet.fleet = [fresh(then, env.clock)];
      const next = env.make();
      await next.takeover();
      await enqueue(env.store, next, spec());
      await pass(next, env.fleet, env.clock.now);
      return env.alerts;
    }

    test("one with no reset, within its window's length, still holds the window: no repeat", async () => {
      expect(await laterTerm(undefined, HOUR, undefined)).toHaveLength(1);
      expect(await laterTerm(undefined, 4 * HOUR, NOW_S + 9 * 3600)).toHaveLength(1);
    });

    test("one with no reset, older than its window is long, is dropped: the window running now alerts", async () => {
      expect(await laterTerm(undefined, 6 * HOUR, undefined)).toHaveLength(2);
      // The same reading, with the reset it has since learned: still a window nobody was told of.
      expect(await laterTerm(undefined, 6 * HOUR, (NOW + 6 * HOUR) / 1000 + 3600)).toHaveLength(2);
    });

    test("one whose reset passed beyond the grace is dropped; one still within it holds", async () => {
      const reset = NOW_S + 3600;
      expect(await laterTerm(reset, 2 * HOUR, undefined)).toHaveLength(2);
      expect(await laterTerm(reset, HOUR + 5 * MINUTE, undefined)).toHaveLength(1);
    });
  });

  test("a stamp the reader would refuse is not written: the record stays readable, and the alert still fires", async () => {
    const long = machine("a", {
      exclaves: [exclave("main", "x".repeat(200), { extraUsageEnabled: true })],
      status: status({ quota: [obs(0, { h: 95, hr: NOW_S + 3600 })] }),
    });
    const { alerts, clock, errors, fleet, scheduler, store } = setup(new FakeFleet([long]), undefined, WIDE);
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    expect(errors).toEqual([]);
    expect(alerts).toHaveLength(1);
    expect(scheduler.task(task.id)?.state).toBe("running");
    expect((await stored(store, task.id)).body.spillAlert).toBeUndefined();
  });

  test("a dispatch under the line alerts nothing", async () => {
    const { alerts, clock, fleet, scheduler, store } = setup();
    await enqueue(store, scheduler, spec());
    await pass(scheduler, fleet, clock.now);
    expect(fleet.spawns).toHaveLength(1);
    expect(alerts).toEqual([]);
  });
});

describe("pr-blocked", () => {
  const PR = "https://github.com/acme/app/pull/7";
  const H1 = "1".repeat(40);
  const H2 = "2".repeat(40);
  const conflict = (head = H1, at = NOW + 1_000): PrStatus => ({ state: "open", merge: "dirty", head, at });
  const awaiting = (fields: Partial<Task> = {}): Task => ({
    id: "t",
    spec: spec(),
    state: "awaiting-merge",
    createdAt: NOW,
    prUrl: PR,
    endedAt: NOW,
    pr: conflict(),
    ...fields,
  });

  describe("prBlockedAlert", () => {
    test("stamps an awaiting-merge task whose reading names a reason, with that reason and head", () => {
      expect(prBlockedAlert(awaiting(), false, NOW)?.prAlert).toEqual({ reason: "conflict", head: H1, at: NOW });
    });

    test("is due only for awaiting-merge, never under until: reported, never while continuing, never without a head", () => {
      expect(prBlockedAlert(awaiting({ state: "running" }), false, NOW)).toBeNull();
      expect(prBlockedAlert(awaiting({ spec: spec({ until: "reported" }) }), false, NOW)).toBeNull();
      expect(prBlockedAlert(awaiting(), true, NOW)).toBeNull();
      expect(prBlockedAlert(awaiting({ pr: { state: "open", merge: "dirty", at: NOW } }), false, NOW)).toBeNull();
      expect(
        prBlockedAlert(awaiting({ pr: { state: "open", merge: "clean", head: H1, at: NOW } }), false, NOW),
      ).toBeNull();
    });

    test("is not due for the same reason and head, and is again for a new head or a new reason at the same head", () => {
      const stamped = awaiting({ prAlert: { reason: "conflict", head: H1, at: NOW } });
      expect(prBlockedAlert(stamped, false, NOW + 1)).toBeNull();
      expect(prBlockedAlert({ ...stamped, pr: conflict(H2) }, false, NOW + 1)?.prAlert).toEqual({
        reason: "conflict",
        head: H2,
        at: NOW + 1,
      });
      const failing: PrStatus = { state: "open", required: "failing", failing: ["x"], head: H1, at: NOW };
      expect(prBlockedAlert({ ...stamped, pr: failing }, false, NOW + 1)?.prAlert?.reason).toBe("checks");
    });
  });

  describe("through onPrStatus", () => {
    const ON_A = { deviceId: "a", exclave: "main", clone: "app", pane: "%1" } as const;
    const seed = async (store: MemoryQueueStore, fields: Partial<Task> = {}): Promise<void> => {
      const { pr: _pr, ...bare } = awaiting();
      const write = await store.put("t", 0, { ...bare, assignment: ON_A, ...fields });
      if (!write.ok) throw new Error(`seed: ${write.code}`);
    };

    test("(a) alerts once, and the stamp is on the stored record", async () => {
      const { alerts, scheduler, store } = setup();
      await seed(store);
      await scheduler.load();
      await scheduler.onPrStatus("t", PR, conflict());
      expect(alerts).toEqual([
        {
          kind: "pr-blocked",
          taskId: "t",
          reason: "conflict",
          head: H1,
          message: 'pr blocked: task="t" reason=conflict',
        },
      ]);
      expect((await stored(store, "t")).body.prAlert).toEqual({ reason: "conflict", head: H1, at: NOW });
    });

    test("(b) an identical reading again alerts nothing, a new head does, and a task under until: reported never does", async () => {
      const { alerts, scheduler, store } = setup();
      await seed(store);
      await scheduler.load();
      await scheduler.onPrStatus("t", PR, conflict());
      await scheduler.onPrStatus("t", PR, conflict(H1, NOW + 2_000));
      expect(alerts).toHaveLength(1);
      await scheduler.onPrStatus("t", PR, conflict(H2, NOW + 3_000));
      expect(alerts).toHaveLength(2);
      expect(alerts[1]).toMatchObject({ kind: "pr-blocked", head: H2 });

      const reported = setup();
      await seed(reported.store, { spec: spec({ until: "reported" }) });
      await reported.scheduler.load();
      await reported.scheduler.onPrStatus("t", PR, conflict());
      expect(reported.alerts).toEqual([]);
      expect((await stored(reported.store, "t")).body).not.toHaveProperty("prAlert");
    });

    test("(c) a continuation still in the queue holds the alert, and the next reading alerts once it has ended", async () => {
      const { alerts, scheduler, store } = setup();
      await seed(store);
      const continuation: Task = {
        id: "c",
        state: "queued",
        createdAt: NOW,
        spec: spec({
          mode: "continue",
          continues: { task: "t", at: { deviceId: "a", exclave: "main", clone: "app" } },
        }),
      };
      expect((await store.put("c", 0, continuation)).ok).toBe(true);
      await scheduler.load();
      await scheduler.onPrStatus("t", PR, conflict());
      expect(alerts).toEqual([]);
      expect((await stored(store, "t")).body).not.toHaveProperty("prAlert");

      expect((await store.put("c", 1, { ...continuation, state: "done", doneBy: "session" })).ok).toBe(true);
      await scheduler.refresh("c");
      await scheduler.onPrStatus("t", PR, conflict(H1, NOW + 2_000));
      expect(alerts).toHaveLength(1);
    });

    test("(d) a new leader reading the stamped record does not alert again", async () => {
      const { alerts, make, scheduler, store } = setup();
      await seed(store);
      await scheduler.load();
      await scheduler.onPrStatus("t", PR, conflict());
      expect(alerts).toHaveLength(1);
      const next = make();
      await next.takeover();
      await next.onPrStatus("t", PR, conflict(H1, NOW + 2_000));
      await next.onPrStatus("t", PR, conflict(H1, NOW + 3_000));
      expect(alerts).toHaveLength(1);
    });

    test("(f) a landed continuation clears the stamp and holds the alert while it runs; it ends with no new head and the next reading alerts once", async () => {
      const { alerts, clock, fleet, scheduler, store } = setup();
      await seed(store, { prAlert: { reason: "conflict", head: H1, at: NOW } });
      const continuation: Task = {
        id: "c",
        state: "running",
        createdAt: NOW + 1,
        assignment: ON_A,
        spec: spec({
          mode: "continue",
          continues: { task: "t", at: { deviceId: "a", exclave: "main", clone: "app" } },
        }),
      };
      expect((await store.put("c", 0, continuation)).ok).toBe(true);
      await scheduler.load();
      await pass(scheduler, fleet, clock.now);
      const marked = (await stored(store, "t")).body;
      expect(marked.continuedBy).toEqual({ task: "c", createdAt: NOW + 1, live: true });
      expect(marked).not.toHaveProperty("prAlert");

      await scheduler.onPrStatus("t", PR, conflict());
      expect(alerts).toEqual([]);

      const running = await stored(store, "c");
      expect((await store.put("c", running.version, { ...continuation, state: "done", doneBy: "session" })).ok).toBe(
        true,
      );
      await scheduler.refresh("c");
      await pass(scheduler, fleet, clock.now);
      expect((await stored(store, "t")).body.continuedBy).toEqual({ task: "c", createdAt: NOW + 1 });

      await scheduler.onPrStatus("t", PR, conflict(H1, NOW + 2_000));
      await scheduler.onPrStatus("t", PR, conflict(H1, NOW + 3_000));
      expect(alerts).toHaveLength(1);
    });

    test("(g) a pass with no change to the chain writes nothing to the task", async () => {
      const { clock, fleet, scheduler, store } = setup();
      await seed(store, { prAlert: { reason: "conflict", head: H1, at: NOW } });
      await scheduler.load();
      const before = (await stored(store, "t")).version;
      await pass(scheduler, fleet, clock.now);
      await pass(scheduler, fleet, clock.now);
      expect(await stored(store, "t")).toMatchObject({ version: before, body: { prAlert: { head: H1 } } });
    });

    test("(e) a write that conflicts and retries still alerts exactly once", async () => {
      const { alerts, scheduler, store } = setup();
      await seed(store);
      await scheduler.load();
      // Another writer moves the record on: the leader's held version is stale, so its first put conflicts.
      const entry = await stored(store, "t");
      expect((await store.put("t", entry.version, entry.body)).ok).toBe(true);
      await scheduler.onPrStatus("t", PR, conflict());
      expect(alerts).toHaveLength(1);
      expect((await stored(store, "t")).body.prAlert).toEqual({ reason: "conflict", head: H1, at: NOW });
    });
  });
});
