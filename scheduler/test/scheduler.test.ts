import { describe, expect, test } from "bun:test";
import { MemoryQueueStore, Scheduler, SCHEDULER_CLIENT, type Task } from "../src/index.ts";
import { FakeFleet, machine, NOW, spec, unreachable } from "./fixtures.ts";

function setup(fleet = new FakeFleet([machine("a")])) {
  const store = new MemoryQueueStore();
  const clock = { now: NOW };
  let n = 0;
  const scheduler = new Scheduler({ store, fleet, now: () => clock.now, newId: () => `t${++n}` });
  return { store, fleet, clock, scheduler };
}

async function stored(store: MemoryQueueStore, id: string): Promise<{ version: number; body: Task } | undefined> {
  return (await store.list()).find((s) => s.id === id);
}

describe("dispatch", () => {
  test("a ready task is reserved, spawned with its taskId as the scheduler, and running on the chosen pane", async () => {
    const { store, fleet, scheduler } = setup();
    const task = await scheduler.submit(spec({ title: "fix it", plan: true }));
    await scheduler.tick();

    expect(fleet.spawns).toEqual([
      {
        deviceId: "a",
        request: {
          repo: "app",
          mode: "worktree",
          prompt: "do it",
          title: "fix it",
          plan: true,
          client: SCHEDULER_CLIENT,
          taskId: task.id,
        },
      },
    ]);
    const after = await stored(store, task.id);
    expect(after?.body.state).toBe("running");
    expect(after?.body.assignment).toEqual({ deviceId: "a", exclave: "main", clone: "app", window: "w1", pane: "%1" });
    expect(after?.body.reservation).toBeUndefined();
    // Create, reserve, run: one write per transition.
    expect(after?.version).toBe(3);
    expect(after?.body.decision?.chosen).toEqual({ deviceId: "a", exclave: "main", clone: "app" });
  });

  test("reservations land one at a time, so the second task sees the first and spreads", async () => {
    const { fleet, scheduler } = setup(new FakeFleet([machine("a"), machine("b")]));
    await scheduler.submit(spec());
    await scheduler.submit(spec());
    await scheduler.tick();
    expect(fleet.spawns.map((s) => s.deviceId).toSorted()).toEqual(["a", "b"]);
  });

  test("an unplaceable task is written nowhere per tick; its decision is kept in memory", async () => {
    const { store, scheduler } = setup(new FakeFleet([machine("a", { connected: false })]));
    const task = await scheduler.submit(spec());
    await scheduler.tick();
    await scheduler.tick();
    expect((await stored(store, task.id))?.version).toBe(1);
    expect(scheduler.lastDecision(task.id)?.candidates[0]?.rejected).toEqual([{ code: "offline" }]);
  });

  test("a daemon refusal fails the task without a second spawn", async () => {
    const { fleet, scheduler } = setup();
    fleet.scripts.set("a", () => ({ ok: false, code: "repo_not_found", message: "gone" }));
    const task = await scheduler.submit(spec());
    await scheduler.tick();
    await scheduler.tick();
    expect(fleet.spawns).toHaveLength(1);
    expect(scheduler.task(task.id)).toMatchObject({ state: "failed", failure: { code: "repo_not_found" } });
  });

  test("task_running from a stale read resolves to running on the existing pane, without a second spawn", async () => {
    const { fleet, scheduler } = setup();
    fleet.scripts.set("a", () => ({ ok: false, code: "task_running", message: "already", id: "%7" }));
    const task = await scheduler.submit(spec());
    await scheduler.tick();
    await scheduler.tick();
    expect(fleet.spawns).toHaveLength(1);
    expect(scheduler.task(task.id)).toMatchObject({ state: "running", assignment: { deviceId: "a", pane: "%7" } });
  });
  test("the pane is the session at the reply's path and window: a `here` clone's sessions all share the path", async () => {
    const { fleet, scheduler } = setup();
    fleet.scripts.set("a", () => ({
      ok: true,
      window: "new",
      path: "/home/u/main/app",
      sessions: [
        { id: "%3", window: "old", repo: "app", path: "/home/u/main/app" },
        { id: "%4", window: "new", repo: "app", path: "/home/u/main/app" },
      ],
    }));
    const task = await scheduler.submit(spec({ mode: "here" }));
    await scheduler.tick();
    expect(scheduler.task(task.id)?.assignment?.pane).toBe("%4");
  });
});

describe("reservation TTL", () => {
  test("no answer keeps the reservation; past the TTL a session carrying the taskId makes it running", async () => {
    const { fleet, clock, scheduler } = setup();
    // The spawn lands but its reply is lost.
    fleet.scripts.set("a", (request) => {
      fleet.start("a", request);
      return unreachable;
    });
    const task = await scheduler.submit(spec());
    await scheduler.tick();
    expect(scheduler.task(task.id)?.state).toBe("reserved");

    clock.now += 119_000;
    await scheduler.tick();
    expect(fleet.sessionCalls).toEqual([]);
    expect(scheduler.task(task.id)?.state).toBe("reserved");

    clock.now += 1_000;
    await scheduler.tick();
    expect(fleet.sessionCalls).toEqual(["a"]);
    expect(scheduler.task(task.id)).toMatchObject({ state: "running", assignment: { pane: "%1", window: "w1" } });
    expect(fleet.spawns).toHaveLength(1);
  });

  test("past the TTL with no such session, the task is released and routed again", async () => {
    const { fleet, clock, scheduler } = setup();
    fleet.scripts.set("a", () => unreachable);
    const task = await scheduler.submit(spec());
    await scheduler.tick();
    fleet.scripts.delete("a");
    clock.now += 120_000;
    fleet.beat(clock.now);
    await scheduler.tick();
    expect(fleet.spawns).toHaveLength(2);
    expect(scheduler.task(task.id)?.state).toBe("running");
  });

  test("an unanswered sessions check waits while the machine is connected, and releases once it is not", async () => {
    const fleet = new FakeFleet([machine("a"), machine("b", { connected: false })]);
    const { clock, scheduler } = setup(fleet);
    fleet.scripts.set("a", () => unreachable);
    fleet.sessionsReply = () => unreachable;
    const task = await scheduler.submit(spec());
    await scheduler.tick();
    clock.now += 120_000;
    await scheduler.tick();
    expect(scheduler.task(task.id)?.state).toBe("reserved");

    fleet.fleet = [machine("a", { connected: false }), machine("b")];
    fleet.beat(clock.now);
    await scheduler.tick();
    expect(scheduler.task(task.id)).toMatchObject({ state: "running", assignment: { deviceId: "b" } });
  });
});

describe("session state", () => {
  test("needs-input and back, then ended is done; events for unknown or unstarted tasks are ignored", async () => {
    const { scheduler } = setup();
    const task = await scheduler.submit(spec());
    await scheduler.onSession(task.id, "needs-input");
    expect(scheduler.task(task.id)?.state).toBe("ready");
    await scheduler.onSession("nope", "ended");

    await scheduler.tick();
    await scheduler.onSession(task.id, "needs-input");
    expect(scheduler.task(task.id)?.state).toBe("needs-input");
    await scheduler.onSession(task.id, "busy");
    expect(scheduler.task(task.id)?.state).toBe("running");
    await scheduler.onSession(task.id, "ended");
    expect(scheduler.task(task.id)?.state).toBe("done");
    await scheduler.onSession(task.id, "busy");
    expect(scheduler.task(task.id)?.state).toBe("done");
  });
});

describe("cancel", () => {
  test("a ready task is cancelled; a running one is despawned first; a finished one is refused", async () => {
    const { fleet, scheduler } = setup(new FakeFleet([machine("a", { connected: false })]));
    const waiting = await scheduler.submit(spec());
    expect(await scheduler.cancel(waiting.id)).toMatchObject({ ok: true, task: { state: "cancelled" } });
    expect(await scheduler.cancel(waiting.id)).toEqual({ ok: false, code: "finished" });

    fleet.fleet = [machine("a")];
    const live = await scheduler.submit(spec());
    await scheduler.tick();
    expect(await scheduler.cancel(live.id)).toMatchObject({ ok: true });
    expect(fleet.despawns).toEqual([{ deviceId: "a", id: "%1" }]);
  });

  test("a running task with no known pane is despawned through the session carrying its id", async () => {
    const { fleet, scheduler } = setup();
    fleet.scripts.set("a", (request) => {
      fleet.start("a", request);
      return { ok: false, code: "task_running", message: "already" };
    });
    const task = await scheduler.submit(spec());
    await scheduler.tick();
    expect(scheduler.task(task.id)?.assignment?.pane).toBeUndefined();
    expect(await scheduler.cancel(task.id)).toMatchObject({ ok: true });
    expect(fleet.despawns).toEqual([{ deviceId: "a", id: "%1" }]);
  });

  test("a cancel landing while the pass reserves an earlier task is not overwritten by the later reservation", async () => {
    const gate = Promise.withResolvers<void>();
    let held = true;
    class GatedStore extends MemoryQueueStore {
      override async put(id: string, version: number, body: Task): ReturnType<MemoryQueueStore["put"]> {
        if (held && body.state === "reserved") await gate.promise;
        return super.put(id, version, body);
      }
    }
    const fleet = new FakeFleet([machine("a")]);
    const scheduler = new Scheduler({
      store: new GatedStore(),
      fleet,
      now: () => NOW,
      newId: (() => {
        let n = 0;
        return () => `t${++n}`;
      })(),
    });
    await scheduler.submit(spec());
    const later = await scheduler.submit(spec());
    const pass = scheduler.tick();
    await Bun.sleep(0);
    expect(await scheduler.cancel(later.id)).toMatchObject({ ok: true });
    held = false;
    gate.resolve();
    await pass;
    expect(scheduler.task(later.id)?.state).toBe("cancelled");
    expect(fleet.spawns.map((s) => s.request.taskId)).toEqual(["t1"]);
  });

  test("a reserved task is mid-dispatch and refused", async () => {
    const { fleet, scheduler } = setup();
    fleet.scripts.set("a", () => unreachable);
    const task = await scheduler.submit(spec());
    await scheduler.tick();
    expect(await scheduler.cancel(task.id)).toEqual({ ok: false, code: "dispatching" });
  });
});

describe("takeover", () => {
  /** What a leader that died mid-dispatch leaves in the store: four tasks in flight across two machines. */
  async function leftBehind() {
    const fleet = new FakeFleet([machine("a"), machine("b")]);
    const { store, clock, scheduler } = setup(fleet);
    // Every spawn lands, but no verdict comes back to the leader that sent it.
    for (const id of ["a", "b"]) {
      fleet.scripts.set(id, (request) => {
        fleet.start(id, request);
        return unreachable;
      });
    }
    const tasks = await Promise.all([scheduler.submit(spec()), scheduler.submit(spec())]);
    await scheduler.tick();
    // A third task whose spawn never reached its machine, and a fourth that ran and ended.
    fleet.scripts.set("a", () => unreachable);
    fleet.scripts.set("b", () => unreachable);
    const lost = await scheduler.submit(spec({ pin: { deviceId: "a" } }));
    await scheduler.tick();
    fleet.scripts.clear();
    const ended = await scheduler.submit(spec({ pin: { deviceId: "b" } }));
    await scheduler.tick();
    fleet.running.set(
      "b",
      (fleet.running.get("b") ?? []).filter((s) => s.taskId !== ended.id),
    );
    expect(scheduler.tasks().map((t) => t.state)).toEqual(["reserved", "reserved", "reserved", "running"]);
    fleet.sessionCalls.length = 0;
    fleet.spawns.length = 0;
    return { fleet, store, clock, landed: tasks, lost, ended };
  }

  test("before any dispatch: a landed reservation runs, an unlanded one waits its TTL, an ended session is done", async () => {
    const { fleet, store, clock, landed, lost, ended } = await leftBehind();
    const successor = new Scheduler({ store, fleet, now: () => clock.now });
    await successor.takeover();

    // One sessions call per machine, and nothing spawned.
    expect(fleet.sessionCalls.toSorted()).toEqual(["a", "b"]);
    expect(fleet.spawns).toEqual([]);
    for (const task of landed) expect(successor.task(task.id)?.state).toBe("running");
    expect(successor.task(lost.id)?.state).toBe("reserved");
    expect(successor.task(ended.id)?.state).toBe("done");

    // Past the TTL with still no session, it is released and dispatched once.
    clock.now += 120_000;
    fleet.beat(clock.now);
    await successor.tick();
    expect(fleet.spawns.map((s) => s.request.taskId)).toEqual([lost.id]);
    expect(successor.task(lost.id)?.state).toBe("running");
  });

  test("an unanswered machine keeps its tasks as they were", async () => {
    const { fleet, store, clock, landed, lost, ended } = await leftBehind();
    fleet.sessionsReply = () => unreachable;
    const successor = new Scheduler({ store, fleet, now: () => clock.now });
    await successor.takeover();
    for (const task of [...landed, lost]) expect(successor.task(task.id)?.state).toBe("reserved");
    expect(successor.task(ended.id)?.state).toBe("running");
    expect(fleet.spawns).toEqual([]);
  });
});

describe("store", () => {
  test("load replaces the view with the store's: a new leader picks up what an old one left", async () => {
    const { store, fleet, scheduler } = setup();
    const task = await scheduler.submit(spec());
    const successor = new Scheduler({ store, fleet, now: () => NOW });
    await successor.load();
    expect(successor.tasks().map((t) => t.id)).toEqual([task.id]);
    await successor.tick();
    expect(successor.task(task.id)?.state).toBe("running");
  });

  test("a version conflict skips the write and refreshes the held copy from the store", async () => {
    const { store, fleet, scheduler } = setup();
    const task = await scheduler.submit(spec());
    // Someone else moved it first.
    const current = await stored(store, task.id);
    await store.put(task.id, current?.version ?? 0, { ...task, state: "cancelled" });
    await scheduler.tick();
    expect(fleet.spawns).toEqual([]);
    expect(scheduler.task(task.id)?.state).toBe("cancelled");
  });

  test("the memory store creates only at expect 0 and bumps per put", async () => {
    const store = new MemoryQueueStore();
    const body: Task = { id: "x", spec: spec(), state: "ready", createdAt: NOW };
    expect(await store.put("x", 1, body)).toEqual({ ok: false, code: "version_conflict" });
    expect(await store.get("x")).toBeNull();
    expect(await store.put("x", 0, body)).toEqual({ ok: true, version: 1 });
    expect(await store.get("x")).toEqual({ id: "x", version: 1, body });
    expect(await store.put("x", 0, body)).toEqual({ ok: false, code: "version_conflict" });
    expect(await store.put("x", 1, body)).toEqual({ ok: true, version: 2 });
    expect(await store.delete("x", 1)).toEqual({ ok: false, code: "version_conflict" });
    expect(await store.delete("x", 2)).toEqual({ ok: true, version: 2 });
    expect(await store.list()).toEqual([]);
  });
});

test("preview routes a spec without queuing it", () => {
  const { scheduler } = setup();
  expect(scheduler.preview(spec()).chosen?.deviceId).toBe("a");
  expect(scheduler.tasks()).toEqual([]);
});

test("ticks asked for while one runs coalesce into one more pass, never a concurrent one", async () => {
  const { fleet, scheduler } = setup();
  const gate = Promise.withResolvers<void>();
  fleet.scripts.set("a", async (request) => {
    await gate.promise;
    return fleet.start("a", request);
  });
  await scheduler.submit(spec());
  const first = scheduler.tick();
  await Bun.sleep(0);
  // A task arriving mid-pass waits for the pass rather than running beside it.
  await scheduler.submit(spec());
  const second = scheduler.tick();
  await Bun.sleep(0);
  expect(fleet.spawns).toHaveLength(1);
  gate.resolve();
  await Promise.all([first, second]);
  expect(fleet.spawns).toHaveLength(2);
  expect(scheduler.tasks().map((t) => t.state)).toEqual(["running", "running"]);
});
