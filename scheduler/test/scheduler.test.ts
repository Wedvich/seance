import { describe, expect, test } from "bun:test";
import {
  CAPABILITIES,
  MAX_TASKS,
  REPLAY_WINDOW_MS,
  type DespawnRequest,
  type DespawnResponse,
  type SessionState,
} from "@seance/shared";
import {
  DEFAULT_CONFIG,
  MemoryQueueStore,
  Scheduler,
  SCHEDULER_CLIENT,
  StoreRevoked,
  UNDELIVERED,
  type StoredTask,
  type Task,
  type TaskSpawnReply,
} from "../src/index.ts";
import { advance } from "../src/task.ts";
import { enqueue, FakeFleet, machine, NOW, NOW_S, obs, readerChecked, spec, status, unreachable } from "./fixtures.ts";

function setup(fleet = new FakeFleet([machine("a")]), config = DEFAULT_CONFIG) {
  const store = new MemoryQueueStore();
  const clock = { now: NOW };
  const idleChanges: string[] = [];
  const scheduler = new Scheduler({
    store: readerChecked(store, () => clock.now),
    fleet,
    config,
    now: () => clock.now,
    onIdleChange: (id) => idleChanges.push(id),
  });
  return { store, fleet, clock, scheduler, idleChanges };
}

/** One pass and the spawns it sent: a pass itself never waits for a spawn's verdict. */
async function pass(scheduler: Scheduler): Promise<void> {
  await scheduler.tick();
  await scheduler.drain();
}

/** Polls until `ready` holds; each turn lets queued microtasks and timers run. */
async function until(ready: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    if (ready()) return;
    // oxlint-disable-next-line no-await-in-loop -- a poll
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function stored(store: MemoryQueueStore, id: string): Promise<StoredTask | undefined> {
  return (await store.list()).find((s): s is StoredTask => s.id === id && s.body !== undefined);
}

describe("dispatch", () => {
  test("a ready task is reserved, spawned with its taskId as the scheduler, and running on the chosen pane", async () => {
    const { store, fleet, scheduler } = setup();
    const task = await enqueue(store, scheduler, spec({ title: "fix it", plan: true }));
    await pass(scheduler);

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
    // Create, admit, reserve, run: one write per transition.
    expect(after?.version).toBe(4);
    expect(after?.body.decision?.chosen).toEqual({ deviceId: "a", exclave: "main", clone: "app" });
  });

  test("reservations land one at a time, so the second task sees the first and spreads", async () => {
    const { fleet, scheduler, store } = setup(new FakeFleet([machine("a"), machine("b")]));
    await enqueue(store, scheduler, spec());
    await enqueue(store, scheduler, spec());
    await pass(scheduler);
    expect(fleet.spawns.map((s) => s.deviceId).toSorted()).toEqual(["a", "b"]);
  });

  test("an unplaceable task is written nowhere per tick; its decision is kept in memory", async () => {
    const { store, scheduler } = setup(new FakeFleet([machine("a", { connected: false })]));
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    await pass(scheduler);
    expect((await stored(store, task.id))?.version).toBe(2);
    expect(scheduler.lastDecision(task.id)?.candidates[0]?.rejected).toEqual([{ code: "offline" }]);
  });

  test("a daemon refusal fails the task without a second spawn", async () => {
    const { fleet, scheduler, store } = setup();
    fleet.scripts.set("a", () => ({ ok: false, code: "repo_not_found", message: "gone" }));
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    await pass(scheduler);
    expect(fleet.spawns).toHaveLength(1);
    expect(scheduler.task(task.id)).toMatchObject({ state: "failed", failure: { code: "repo_not_found" } });
  });

  describe("a continue task", () => {
    const at = { deviceId: "a", exclave: "main", clone: "app" };
    const continuing = spec({ mode: "continue", continues: { task: "t-old", at } });
    const capable = (): ReturnType<typeof machine> =>
      machine("a", { capabilities: [CAPABILITIES.metrics, CAPABILITIES.taskId, CAPABILITIES.continueTask] });

    test("is spawned in continue mode on its target, carrying the id it continues", async () => {
      const { fleet, scheduler, store } = setup(new FakeFleet([capable()]));
      const task = await enqueue(store, scheduler, continuing);
      await pass(scheduler);
      expect(fleet.spawns).toEqual([
        {
          deviceId: "a",
          request: {
            repo: "app",
            mode: "continue",
            prompt: "do it",
            continues: "t-old",
            client: SCHEDULER_CLIENT,
            taskId: task.id,
          },
        },
      ]);
      expect(scheduler.task(task.id)?.state).toBe("running");
    });

    test("a not_continuable refusal fails it with the daemon's code and message, and it does not stay reserved", async () => {
      const { fleet, scheduler, store } = setup(new FakeFleet([capable()]));
      fleet.scripts.set("a", () => ({ ok: false, code: "not_continuable", message: "its worktree is gone" }));
      const task = await enqueue(store, scheduler, continuing);
      await pass(scheduler);
      await pass(scheduler);
      expect(fleet.spawns).toHaveLength(1);
      const after = scheduler.task(task.id);
      expect(after).toMatchObject({
        state: "failed",
        failure: { code: "not_continuable", message: "its worktree is gone" },
      });
      expect(after?.reservation).toBeUndefined();
    });
  });

  test("task_running from a stale read resolves to running on the existing pane, without a second spawn", async () => {
    const { fleet, scheduler, store } = setup();
    fleet.scripts.set("a", () => ({ ok: false, code: "task_running", message: "already", id: "%7" }));
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    await pass(scheduler);
    expect(fleet.spawns).toHaveLength(1);
    expect(scheduler.task(task.id)).toMatchObject({ state: "running", assignment: { deviceId: "a", pane: "%7" } });
  });
  test("the pane is the session at the reply's path and window: a `here` clone's sessions all share the path", async () => {
    const { fleet, scheduler, store } = setup();
    fleet.scripts.set("a", () => ({
      ok: true,
      window: "new",
      path: "/home/u/main/app",
      sessions: [
        { id: "%3", window: "old", repo: "app", path: "/home/u/main/app" },
        { id: "%4", window: "new", repo: "app", path: "/home/u/main/app" },
      ],
    }));
    const task = await enqueue(store, scheduler, spec({ mode: "here" }));
    await pass(scheduler);
    expect(scheduler.task(task.id)?.assignment?.pane).toBe("%4");
  });
});

describe("reservation TTL", () => {
  test("no answer keeps the reservation; past the TTL a session carrying the taskId makes it running", async () => {
    const { fleet, clock, scheduler, store } = setup();
    // The spawn lands but its reply is lost.
    fleet.scripts.set("a", (request) => {
      fleet.start("a", request);
      return unreachable;
    });
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("reserved");

    clock.now += 119_000;
    await pass(scheduler);
    expect(fleet.sessionCalls).toEqual([]);
    expect(scheduler.task(task.id)?.state).toBe("reserved");

    clock.now += 1_000;
    await pass(scheduler);
    expect(fleet.sessionCalls).toEqual(["a"]);
    expect(scheduler.task(task.id)).toMatchObject({ state: "running", assignment: { pane: "%1", window: "w1" } });
    expect(fleet.spawns).toHaveLength(1);
  });

  test("past the TTL with no such session, and the machine's ledger proving none landed, the task is routed again", async () => {
    const { fleet, clock, scheduler, store } = setup();
    fleet.scripts.set("a", () => unreachable);
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    fleet.scripts.delete("a");
    clock.now += 120_000;
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(fleet.spawns).toHaveLength(2);
    expect(scheduler.task(task.id)?.state).toBe("running");
  });

  test("without proof — an old daemon, or a ledger younger than the reservation plus skew — it fails, never twice", async () => {
    for (const since of [null, NOW, NOW - REPLAY_WINDOW_MS + 1]) {
      const { fleet, clock, scheduler, store } = setup();
      fleet.scripts.set("a", () => unreachable);
      fleet.ledgerSince.set("a", since);
      // oxlint-disable-next-line no-await-in-loop -- one scenario at a time
      const task = await enqueue(store, scheduler, spec());
      // oxlint-disable-next-line no-await-in-loop -- the clock moves between passes
      await pass(scheduler);
      clock.now += 120_000;
      fleet.beat(clock.now);
      // oxlint-disable-next-line no-await-in-loop -- the clock moves between passes
      await pass(scheduler);
      expect(scheduler.task(task.id)).toMatchObject({
        state: "failed",
        failure: { code: "dispatch_unconfirmed" },
        assignment: { deviceId: "a", clone: "app" },
      });
      // oxlint-disable-next-line no-await-in-loop -- the clock moves between passes
      await pass(scheduler);
      expect(fleet.spawns).toHaveLength(1);
    }
  });

  test("a ledger older than the reservation by the replay window's skew is proof", async () => {
    const { fleet, clock, scheduler, store } = setup();
    fleet.scripts.set("a", () => unreachable);
    fleet.ledgerSince.set("a", NOW - REPLAY_WINDOW_MS);
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    fleet.scripts.delete("a");
    clock.now += 120_000;
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("running");
    expect(fleet.spawns).toHaveLength(2);
  });

  test("an unanswered sessions check waits while the machine is connected, and is lost — not released — once it is not", async () => {
    const fleet = new FakeFleet([machine("a"), machine("b", { connected: false })]);
    const { clock, scheduler, store } = setup(fleet);
    fleet.scripts.set("a", () => unreachable);
    fleet.sessionsReply = () => unreachable;
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    clock.now += 120_000;
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("reserved");

    fleet.fleet = [machine("a", { connected: false }), machine("b")];
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(scheduler.task(task.id)).toMatchObject({
      state: "lost",
      assignment: { deviceId: "a", exclave: "main", clone: "app" },
      reservedAt: NOW,
      absentSince: clock.now,
    });
    expect(scheduler.task(task.id)?.assignment?.pane).toBeUndefined();
    expect(scheduler.task(task.id)?.reservation).toBeUndefined();
    clock.now += 3_600_000;
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("lost");
    expect(fleet.spawns).toHaveLength(1);
  });

  test("a connected machine that answers only errors: lost after lostAfterMs past the TTL, freeing its slot without a twin", async () => {
    const fleet = new FakeFleet([machine("a")]);
    const { clock, scheduler, store } = setup(fleet, { ...DEFAULT_CONFIG, globalMax: 1 });
    fleet.scripts.set("a", () => ({ ok: false, code: "internal_error", message: "crashed after launch?" }));
    fleet.sessionsReply = () => ({ ok: false, code: "internal_error", message: "tmux failing" });
    const t1 = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    const expiresAt = scheduler.task(t1.id)?.reservation?.expiresAt ?? 0;

    // The first check is at the TTL; failing ones keep it reserved until the bound.
    clock.now = expiresAt;
    await pass(scheduler);
    expect(scheduler.task(t1.id)?.state).toBe("reserved");
    clock.now = expiresAt + DEFAULT_CONFIG.lostAfterMs - 1;
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(scheduler.task(t1.id)?.state).toBe("reserved");

    clock.now = expiresAt + DEFAULT_CONFIG.lostAfterMs;
    fleet.beat(clock.now);
    const t2 = await enqueue(store, scheduler, spec());
    fleet.scripts.delete("a");
    await pass(scheduler);
    expect(scheduler.task(t1.id)).toMatchObject({ state: "lost", reservedAt: NOW, absentSince: expiresAt });
    expect(scheduler.task(t2.id)?.state).toBe("running");
    expect(fleet.spawns.map((s) => s.request.taskId)).toEqual([t1.id, t2.id]);
  });
});

/**
 * M2's gap 1: a reservation whose machine went away before answering. It is
 * `lost` on that machine, and only that machine's answer — with its ledger's
 * proof, for a re-dispatch — moves it.
 */
/** What a leader leaves for its successor: a reservation `a` never answered for, now `lost`. */
function unconfirmedOnA(id: string): Task {
  return {
    id,
    spec: spec(),
    state: "lost",
    createdAt: NOW,
    reservedAt: NOW,
    absentSince: NOW + 120_000,
    assignment: { deviceId: "a", exclave: "main", clone: "app" },
  };
}

describe("a reservation whose machine went away", () => {
  /** A spawn sent to `a` with no reply, `a` gone past the TTL, `b` there since. */
  async function reservedThenGone() {
    const fleet = new FakeFleet([machine("a"), machine("b", { connected: false })]);
    const env = setup(fleet);
    fleet.scripts.set("a", () => unreachable);
    const task = await enqueue(env.store, env.scheduler, spec());
    await pass(env.scheduler);
    fleet.scripts.delete("a");
    fleet.fleet = [machine("a", { connected: false }), machine("b")];
    env.clock.now += 120_000;
    fleet.beat(env.clock.now);
    await pass(env.scheduler);
    expect(env.scheduler.task(task.id)?.state).toBe("lost");
    /** `a` connected again, and a pass to notice. */
    const back = async (): Promise<void> => {
      fleet.fleet = [machine("a"), machine("b")];
      fleet.beat(env.clock.now);
      await pass(env.scheduler);
    };
    return { ...env, task, back };
  }

  test("back with the session: running on the pane listed now, with no twin", async () => {
    const { fleet, scheduler, task, back } = await reservedThenGone();
    fleet.running.set("a", [{ id: "%9", window: "w9", repo: "app", path: "/wt/x", taskId: task.id }]);
    await back();
    expect(scheduler.task(task.id)).toMatchObject({
      state: "running",
      assignment: { deviceId: "a", exclave: "main", clone: "app", pane: "%9", window: "w9" },
    });
    expect(scheduler.task(task.id)?.reservedAt).toBeUndefined();
    expect(fleet.spawns).toHaveLength(1);
  });

  test("back reporting it ended: done, with no twin", async () => {
    const { fleet, scheduler, task, back } = await reservedThenGone();
    fleet.ended.set("a", [task.id]);
    await back();
    expect(scheduler.task(task.id)).toMatchObject({ state: "done", assignment: { deviceId: "a" } });
    expect(fleet.spawns).toHaveLength(1);
  });

  test("back with neither and the ledger's proof: ready again, and routed afresh", async () => {
    const { fleet, scheduler, task, back } = await reservedThenGone();
    await back();
    expect(fleet.spawns).toHaveLength(2);
    expect(scheduler.task(task.id)?.state).toBe("running");
    expect(scheduler.task(task.id)?.reservedAt).toBeUndefined();
  });

  test("back with neither and no proof: failed dispatch_unconfirmed, never dispatched again", async () => {
    for (const since of [null, NOW]) {
      // oxlint-disable-next-line no-await-in-loop -- one scenario at a time
      const { fleet, scheduler, task, back, clock } = await reservedThenGone();
      fleet.ledgerSince.set("a", since);
      // oxlint-disable-next-line no-await-in-loop -- one scenario at a time
      await back();
      expect(scheduler.task(task.id)).toMatchObject({ state: "failed", failure: { code: "dispatch_unconfirmed" } });
      clock.now += 120_000;
      fleet.beat(clock.now);
      // oxlint-disable-next-line no-await-in-loop -- one scenario at a time
      await pass(scheduler);
      expect(fleet.spawns).toHaveLength(1);
    }
  });

  test("back but unanswered: still lost", async () => {
    const { fleet, scheduler, task, back } = await reservedThenGone();
    fleet.sessionsReply = () => unreachable;
    await back();
    expect(scheduler.task(task.id)?.state).toBe("lost");
    expect(fleet.spawns).toHaveLength(1);
  });

  test("an event from its own machine resolves it with the reporting pane; another's, or none, moves nothing", async () => {
    const { scheduler, task } = await reservedThenGone();
    await scheduler.onSession(task.id, "busy", { deviceId: "b", pane: "%1" });
    await scheduler.onSession(task.id, "busy");
    expect(scheduler.task(task.id)?.state).toBe("lost");
    await scheduler.onSession(task.id, "needs-input", { deviceId: "a", pane: "%4" });
    expect(scheduler.task(task.id)).toMatchObject({ state: "needs-input", assignment: { deviceId: "a", pane: "%4" } });
  });

  test("takeover settles it from its machine's sessions as its reservation would have been", async () => {
    const { store, fleet, clock } = setup(new FakeFleet([machine("a")]));
    await store.put("proved", 0, unconfirmedOnA("proved"));
    await store.put("ran", 0, unconfirmedOnA("ran"));
    fleet.ended.set("a", ["ran"]);
    const successor = new Scheduler({ store, fleet, now: () => clock.now });
    await successor.takeover();
    expect(successor.task("proved")?.state).toBe("ready");
    expect(successor.task("ran")?.state).toBe("done");
    expect(fleet.spawns).toEqual([]);
  });

  test("only a task never confirmed may leave lost for ready", () => {
    const placed: Task = {
      id: "x",
      spec: spec(),
      state: "lost",
      createdAt: NOW,
      assignment: { deviceId: "a", exclave: "main", clone: "app", pane: "%1" },
    };
    expect(() => advance(placed, "ready")).toThrow("never returns to ready");
    expect(advance({ ...placed, reservedAt: NOW }, "ready")).toMatchObject({ state: "ready" });
  });
});

describe("cancelling a lost task", () => {
  test("its machine gone: cancelled with nothing despawned, and the record says its session was left running", async () => {
    const { fleet, scheduler, clock, store } = setup(new FakeFleet([machine("a")]));
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    fleet.fleet = [machine("a", { connected: false })];
    await pass(scheduler);
    clock.now += DEFAULT_CONFIG.lostAfterMs;
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("lost");

    expect(await scheduler.cancel(task.id)).toMatchObject({
      ok: true,
      task: { state: "cancelled", leftRunning: true },
    });
    expect(fleet.despawns).toEqual([]);

    // Terminal: its machine back with the session, or an event from it, changes nothing.
    fleet.fleet = [machine("a")];
    fleet.beat(clock.now);
    await pass(scheduler);
    await scheduler.onSession(task.id, "busy", { deviceId: "a", pane: "%1" });
    expect(scheduler.task(task.id)).toMatchObject({ state: "cancelled", leftRunning: true });
    expect(await scheduler.cancel(task.id)).toEqual({ ok: false, code: "finished" });
    expect(fleet.spawns).toHaveLength(1);
  });

  test("its machine back: despawned as a running one is, through the session carrying its id when it has no pane", async () => {
    const fleet = new FakeFleet([machine("a"), machine("b", { connected: false })]);
    const { scheduler, clock, store } = setup(fleet);
    fleet.scripts.set("a", (request) => {
      fleet.start("a", request);
      return unreachable;
    });
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    fleet.fleet = [machine("a", { connected: false }), machine("b", { connected: false })];
    clock.now += 120_000;
    await pass(scheduler);
    expect(scheduler.task(task.id)).toMatchObject({ state: "lost", assignment: { deviceId: "a" } });
    expect(scheduler.task(task.id)?.assignment?.pane).toBeUndefined();

    // Back, but before a pass has settled it.
    fleet.fleet = [machine("a"), machine("b", { connected: false })];
    const result = await scheduler.cancel(task.id);
    expect(result).toMatchObject({ ok: true, task: { state: "cancelled" } });
    expect(result.ok ? result.task.leftRunning : "refused").toBeUndefined();
    expect(fleet.despawns).toEqual([{ deviceId: "a", id: "%1" }]);
  });

  test("its machine back but not answering: refused, so a cancel never claims a despawn it did not do", async () => {
    const fleet = new FakeFleet([machine("a")]);
    const { scheduler, clock, store } = setup(fleet);
    fleet.scripts.set("a", () => unreachable);
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    fleet.fleet = [machine("a", { connected: false })];
    clock.now += 120_000;
    await pass(scheduler);
    fleet.fleet = [machine("a")];
    fleet.sessionsReply = () => unreachable;
    expect(await scheduler.cancel(task.id)).toEqual({ ok: false, code: "despawn_failed" });
    expect(scheduler.task(task.id)?.state).toBe("lost");
  });
});

describe("a machine that stops answering", () => {
  const LOST_AFTER = DEFAULT_CONFIG.lostAfterMs;

  /** One task running on `a`, then `a` gone — disconnected, or forgotten from the registry. */
  async function runningThenGone(gone: "disconnected" | "forgotten", config = DEFAULT_CONFIG) {
    const env = setup(new FakeFleet([machine("a"), machine("b")]), config);
    env.fleet.scripts.set("b", () => ({ ok: false, code: "repo_not_found", message: "only a runs it" }));
    const task = await enqueue(env.store, env.scheduler, spec({ pin: { deviceId: "a" } }));
    await pass(env.scheduler);
    expect(env.scheduler.task(task.id)?.state).toBe("running");
    env.fleet.fleet = gone === "forgotten" ? [machine("b")] : [machine("a", { connected: false }), machine("b")];
    return { ...env, task };
  }

  test("past the bound a running task is lost, shown with when its machine went, and never dispatched again", async () => {
    for (const gone of ["disconnected", "forgotten"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one scenario at a time
      const { clock, fleet, scheduler, task } = await runningThenGone(gone);
      const absent = clock.now;
      await pass(scheduler);
      clock.now += LOST_AFTER - 1;
      fleet.beat(clock.now);
      // oxlint-disable-next-line no-await-in-loop -- the clock moves between passes
      await pass(scheduler);
      expect(scheduler.task(task.id)?.state).toBe("running");

      clock.now += 1;
      fleet.beat(clock.now);
      // oxlint-disable-next-line no-await-in-loop -- the clock moves between passes
      await pass(scheduler);
      expect(scheduler.task(task.id)).toMatchObject({
        state: "lost",
        absentSince: absent,
        assignment: { deviceId: "a" },
      });
      clock.now += 3_600_000;
      fleet.beat(clock.now);
      // oxlint-disable-next-line no-await-in-loop -- the clock moves between passes
      await pass(scheduler);
      expect(scheduler.task(task.id)?.state).toBe("lost");
      expect(fleet.spawns).toHaveLength(1);
    }
  });

  test("a lost task frees its slot: it does not count toward the global cap", async () => {
    const { clock, fleet, scheduler, store, task } = await runningThenGone("disconnected", {
      ...DEFAULT_CONFIG,
      globalMax: 1,
    });
    fleet.scripts.delete("b");
    expect(scheduler.preview(spec()).candidates.flatMap((c) => c.rejected)).toContainEqual(
      expect.objectContaining({ code: "cap_reached" }),
    );
    await pass(scheduler);
    clock.now += LOST_AFTER;
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("lost");
    const next = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    expect(scheduler.task(next.id)).toMatchObject({ state: "running", assignment: { deviceId: "b" } });
  });

  test("its machine back with the session alive: running again on the pane listed now, with no twin", async () => {
    const { clock, fleet, scheduler, task } = await runningThenGone("disconnected");
    await pass(scheduler);
    clock.now += LOST_AFTER;
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("lost");

    // The daemon restarted its tmux view: the same task id, on a new pane.
    fleet.running.set("a", [{ id: "%40", window: "w40", repo: "app", path: "/wt/x", taskId: task.id }]);
    fleet.fleet = [machine("a"), machine("b")];
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(scheduler.task(task.id)).toMatchObject({
      state: "running",
      assignment: { deviceId: "a", pane: "%40", window: "w40" },
    });
    expect(scheduler.task(task.id)?.absentSince).toBeUndefined();
    expect(fleet.spawns).toHaveLength(1);
  });

  test("its machine back without the session, or reporting it ended, settles it done", async () => {
    for (const ended of [false, true]) {
      // oxlint-disable-next-line no-await-in-loop -- one scenario at a time
      const { clock, fleet, scheduler, task } = await runningThenGone("disconnected");
      // oxlint-disable-next-line no-await-in-loop -- the clock moves between passes
      await pass(scheduler);
      clock.now += LOST_AFTER;
      fleet.beat(clock.now);
      // oxlint-disable-next-line no-await-in-loop -- the clock moves between passes
      await pass(scheduler);
      fleet.running.set("a", []);
      if (ended) fleet.ended.set("a", [task.id]);
      fleet.fleet = [machine("a"), machine("b")];
      fleet.beat(clock.now);
      // oxlint-disable-next-line no-await-in-loop -- the clock moves between passes
      await pass(scheduler);
      expect(scheduler.task(task.id)?.state).toBe("done");
      expect(fleet.spawns).toHaveLength(1);
    }
  });

  test("an unanswered check keeps it lost; an event from its own machine settles it, one from another does not", async () => {
    const { clock, fleet, scheduler, task } = await runningThenGone("disconnected");
    await pass(scheduler);
    clock.now += LOST_AFTER;
    fleet.beat(clock.now);
    await pass(scheduler);
    fleet.fleet = [machine("a"), machine("b")];
    fleet.beat(clock.now);
    fleet.sessionsReply = () => unreachable;
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("lost");

    await scheduler.onSession(task.id, "busy", { deviceId: "b", pane: "%1" });
    expect(scheduler.task(task.id)?.state).toBe("lost");
    await scheduler.onSession(task.id, "needs-input", { deviceId: "a", pane: "%1" });
    expect(scheduler.task(task.id)?.state).toBe("needs-input");
  });

  test("a machine back inside the bound resets the count", async () => {
    const { clock, fleet, scheduler, task } = await runningThenGone("disconnected");
    await pass(scheduler);
    clock.now += LOST_AFTER - 1;
    fleet.fleet = [machine("a"), machine("b")];
    fleet.beat(clock.now);
    await pass(scheduler);
    fleet.fleet = [machine("a", { connected: false }), machine("b")];
    await pass(scheduler);
    clock.now += LOST_AFTER - 1;
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("running");
  });

  test("takeover settles a lost task from its machine's sessions like a running one", async () => {
    const { store, fleet, scheduler } = setup();
    const lost: Task = {
      id: "l1",
      spec: spec(),
      state: "lost",
      createdAt: NOW,
      absentSince: NOW - 1,
      assignment: { deviceId: "a", exclave: "main", clone: "app", pane: "%1" },
    };
    await store.put("l1", 0, lost);
    fleet.running.set("a", [{ id: "%2", window: "w2", repo: "app", path: "/p", taskId: "l1" }]);
    await scheduler.takeover();
    expect(scheduler.task("l1")).toMatchObject({ state: "running", assignment: { pane: "%2" } });
  });
});

describe("a machine asleep past slotReleaseAfterMs", () => {
  const GRACE = DEFAULT_CONFIG.slotReleaseAfterMs;

  /** One task running on `a` under a global max of 1, then `a` asleep, seen by a pass. */
  async function asleepHoldingTheSlot() {
    const env = setup(new FakeFleet([machine("a"), machine("b")]), { ...DEFAULT_CONFIG, globalMax: 1 });
    const first = await enqueue(env.store, env.scheduler, spec({ pin: { deviceId: "a" } }));
    await pass(env.scheduler);
    expect(env.scheduler.task(first.id)).toMatchObject({ state: "running", assignment: { deviceId: "a" } });
    env.fleet.fleet = [machine("a", { connected: false }), machine("b")];
    await pass(env.scheduler);
    const second = await enqueue(env.store, env.scheduler, spec());
    return { ...env, first, second };
  }

  function reasons(scheduler: Scheduler, id: string): unknown {
    return scheduler.lastDecision(id)?.candidates.flatMap((c) => c.rejected);
  }

  async function at(env: { clock: { now: number }; fleet: FakeFleet; scheduler: Scheduler }, now: number) {
    env.clock.now = now;
    env.fleet.beat(now);
    await pass(env.scheduler);
  }

  async function end(env: { fleet: FakeFleet; scheduler: Scheduler }, id: string): Promise<void> {
    const assignment = env.scheduler.task(id)?.assignment;
    if (assignment?.pane === undefined) throw new Error(`${id} has no pane`);
    env.fleet.end(assignment.deviceId, id);
    await env.scheduler.onSession(id, "ended", { deviceId: assignment.deviceId, pane: assignment.pane });
  }

  test("short of the grace its task holds the slot; past it another machine gets the work, its task untouched", async () => {
    const env = await asleepHoldingTheSlot();
    const { scheduler, first, second } = env;
    await at(env, NOW + GRACE - 1);
    expect(scheduler.task(second.id)?.state).toBe("ready");
    expect(reasons(scheduler, second.id)).toContainEqual({ code: "cap_reached", inFlight: 1, max: 1 });

    await at(env, NOW + GRACE);
    expect(scheduler.task(second.id)).toMatchObject({ state: "running", assignment: { deviceId: "b" } });
    expect(scheduler.task(first.id)).toMatchObject({ state: "running", assignment: { deviceId: "a" } });
  });

  test("back with its task running: over the cap, nothing killed, nothing placed until the count drops under", async () => {
    const env = await asleepHoldingTheSlot();
    const { fleet, scheduler, store, first, second } = env;
    await at(env, NOW + GRACE);
    expect(scheduler.task(second.id)?.state).toBe("running");

    fleet.fleet = [machine("a"), machine("b")];
    await at(env, NOW + GRACE + 1);
    expect(scheduler.task(first.id)).toMatchObject({ state: "running", assignment: { deviceId: "a" } });
    expect(fleet.despawns).toEqual([]);
    const third = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    expect(scheduler.task(third.id)?.state).toBe("ready");
    expect(reasons(scheduler, third.id)).toContainEqual({ code: "cap_reached", inFlight: 2, max: 1 });

    await end(env, second.id);
    await pass(scheduler);
    expect(reasons(scheduler, third.id)).toContainEqual({ code: "cap_reached", inFlight: 1, max: 1 });
    await end(env, first.id);
    await pass(scheduler);
    expect(scheduler.task(third.id)?.state).toBe("running");
    expect(fleet.spawns).toHaveLength(3);
  });

  test("a flap restarts the grace: absent, back, absent again holds the slot until the new absence runs its course", async () => {
    const env = await asleepHoldingTheSlot();
    const { fleet, scheduler, second } = env;
    await at(env, NOW + GRACE - 1);
    fleet.fleet = [machine("a"), machine("b")];
    await at(env, NOW + GRACE);
    fleet.fleet = [machine("a", { connected: false }), machine("b")];
    const away = NOW + GRACE + 1;
    await at(env, away);
    await at(env, away + GRACE - 1);
    expect(scheduler.task(second.id)?.state).toBe("ready");
    expect(reasons(scheduler, second.id)).toContainEqual({ code: "cap_reached", inFlight: 1, max: 1 });

    await at(env, away + GRACE);
    expect(scheduler.task(second.id)).toMatchObject({ state: "running", assignment: { deviceId: "b" } });
  });

  test("back before any pass: preview already counts its task again, as the next pass will", async () => {
    const env = await asleepHoldingTheSlot();
    const { clock, fleet, scheduler } = env;
    clock.now = NOW + GRACE;
    fleet.beat(clock.now);
    const rejected = (): unknown => scheduler.preview(spec()).candidates.flatMap((c) => c.rejected);
    expect(rejected()).not.toContainEqual(expect.objectContaining({ code: "cap_reached" }));

    fleet.fleet = [machine("a"), machine("b")];
    expect(rejected()).toContainEqual({ code: "cap_reached", inFlight: 1, max: 1 });
  });

  test("pause until reset leaves the tasks of a machine asleep past the grace out of its projected usage", async () => {
    const reading = (h: number) =>
      machine("a", { status: status({ quota: [obs(0, { h, hr: NOW_S + 7200, d: 40, dr: NOW_S + 3600 })] }) });
    const env = setup(new FakeFleet([reading(10)]));
    const { clock, fleet, scheduler, store } = env;
    for (let i = 0; i < 3; i++) await enqueue(store, scheduler, spec());
    await pass(scheduler);
    expect(fleet.spawns).toHaveLength(3);

    // 78% plus four tasks of 5% crosses the line in 5h, so while they count the reset is its, the latest.
    fleet.fleet = [machine("a", { ...reading(78), connected: false })];
    await at(env, NOW + 1);
    clock.now = NOW + GRACE;
    expect(await scheduler.pause({ until: "reset", account: "org:a" })).toMatchObject({
      ok: true,
      holds: [{ resumeAt: (NOW_S + 7200) * 1000 }],
    });
    await scheduler.resume({ account: "org:a" });

    clock.now = NOW + 1 + GRACE;
    expect(await scheduler.pause({ until: "reset", account: "org:a" })).toMatchObject({
      ok: true,
      holds: [{ resumeAt: (NOW_S + 3600) * 1000 }],
    });
  });
});

describe("a session idle past idleReleaseAfterMs", () => {
  const GRACE = DEFAULT_CONFIG.idleReleaseAfterMs;

  /** One task running on `a` under a global max of 1, a second waiting behind it. */
  async function holdingTheSlot() {
    const env = setup(new FakeFleet([machine("a"), machine("b")]), { ...DEFAULT_CONFIG, globalMax: 1 });
    const first = await enqueue(env.store, env.scheduler, spec({ pin: { deviceId: "a" } }));
    await pass(env.scheduler);
    const pane = env.scheduler.task(first.id)?.assignment?.pane;
    if (pane === undefined) throw new Error("first has no pane");
    const second = await enqueue(env.store, env.scheduler, spec());
    const report = (state: SessionState, deviceId = "a") =>
      env.scheduler.onSession(first.id, state, { deviceId, pane });
    return { ...env, first, second, report };
  }

  async function at(env: { clock: { now: number }; fleet: FakeFleet; scheduler: Scheduler }, now: number) {
    env.clock.now = now;
    env.fleet.beat(now);
    await pass(env.scheduler);
  }

  function capped(scheduler: Scheduler, id: string, inFlight: number): void {
    expect(scheduler.task(id)?.state).toBe("ready");
    const rejected = scheduler.lastDecision(id)?.candidates.flatMap((c) => c.rejected);
    expect(rejected).toContainEqual({ code: "cap_reached", inFlight, max: 1 });
  }

  test("short of the grace it holds the slot; past it the next task runs, the idle one untouched", async () => {
    const env = await holdingTheSlot();
    const { fleet, scheduler, first, second, report } = env;
    await report("idle");
    await at(env, NOW + GRACE - 1);
    capped(scheduler, second.id, 1);

    await at(env, NOW + GRACE);
    expect(scheduler.task(second.id)).toMatchObject({ state: "running" });
    expect(scheduler.task(first.id)).toMatchObject({ state: "running", assignment: { deviceId: "a" } });
    expect(fleet.despawns).toEqual([]);
  });

  test("idle lists a release with when its stay began, and the host hears each start and end once", async () => {
    const env = await holdingTheSlot();
    const { scheduler, first, idleChanges, report } = env;
    await report("idle");
    await at(env, NOW + GRACE - 1);
    expect(scheduler.idle()).toEqual([]);
    expect(idleChanges).toEqual([]);

    await at(env, NOW + GRACE);
    expect(scheduler.idle()).toEqual([{ taskId: first.id, since: NOW }]);
    expect(idleChanges).toEqual([first.id]);
    await at(env, NOW + GRACE + 1);
    expect(idleChanges).toEqual([first.id]);

    await report("busy");
    expect(scheduler.idle()).toEqual([]);
    expect(idleChanges).toEqual([first.id, first.id]);
  });

  test("a repeated idle keeps its deadline", async () => {
    const env = await holdingTheSlot();
    const { scheduler, second, report } = env;
    await report("idle");
    env.clock.now = NOW + GRACE - 1;
    await report("idle");
    await at(env, NOW + GRACE);
    expect(scheduler.task(second.id)?.state).toBe("running");
  });

  test("busy stops the clock, and the next idle starts over", async () => {
    const env = await holdingTheSlot();
    const { scheduler, second, report } = env;
    await report("idle");
    env.clock.now = NOW + GRACE - 1;
    await report("busy");
    await at(env, NOW + GRACE);
    capped(scheduler, second.id, 1);

    const again = NOW + GRACE + 1;
    env.clock.now = again;
    await report("idle");
    await at(env, again + GRACE - 1);
    capped(scheduler, second.id, 1);
    await at(env, again + GRACE);
    expect(scheduler.task(second.id)?.state).toBe("running");
  });

  test("back from lost, an idle starts a fresh grace, not the one it left with", async () => {
    const env = await holdingTheSlot();
    const { fleet, scheduler, store, first, report } = env;
    await report("idle");
    fleet.fleet = [machine("a", { connected: false }), machine("b")];
    await at(env, NOW + 1);
    await at(env, NOW + 1 + DEFAULT_CONFIG.lostAfterMs);
    expect(scheduler.task(first.id)?.state).toBe("lost");

    fleet.fleet = [machine("a"), machine("b")];
    const back = NOW + 2 + DEFAULT_CONFIG.lostAfterMs;
    env.clock.now = back;
    await report("idle");
    expect(scheduler.task(first.id)?.state).toBe("running");
    // The second took `b` while `a` slept; the first counts again beside it until its new grace runs out.
    const third = await enqueue(store, scheduler, spec());
    await at(env, back + 1);
    capped(scheduler, third.id, 2);
    await at(env, back + GRACE);
    capped(scheduler, third.id, 1);
  });

  test("needs-input keeps its slot, however long it waits", async () => {
    const env = await holdingTheSlot();
    const { scheduler, first, second, report } = env;
    await report("idle");
    await report("needs-input");
    await at(env, NOW + GRACE * 3);
    expect(scheduler.task(first.id)?.state).toBe("needs-input");
    capped(scheduler, second.id, 1);
  });

  test("busy again after its release: over the cap, nothing killed, nothing placed until the count drops", async () => {
    const env = await holdingTheSlot();
    const { fleet, scheduler, store, second, report } = env;
    await report("idle");
    await at(env, NOW + GRACE);
    expect(scheduler.task(second.id)?.state).toBe("running");

    await report("busy");
    const third = await enqueue(store, scheduler, spec());
    await at(env, NOW + GRACE + 1);
    capped(scheduler, third.id, 2);
    expect(fleet.despawns).toEqual([]);
  });

  test("an idle from another machine, or from a sender that names none, frees nothing", async () => {
    const env = await holdingTheSlot();
    const { scheduler, first, second, report } = env;
    await report("idle", "b");
    await scheduler.onSession(first.id, "idle");
    await at(env, NOW + GRACE);
    capped(scheduler, second.id, 1);
  });

  test("another machine's busy does not stop its clock", async () => {
    const env = await holdingTheSlot();
    const { scheduler, second, report } = env;
    await report("idle");
    env.clock.now = NOW + GRACE - 1;
    await report("busy", "b");
    await at(env, NOW + GRACE);
    expect(scheduler.task(second.id)?.state).toBe("running");
  });
});

describe("prune", () => {
  test("past the keep, the oldest finished tasks are deleted; nothing unfinished ever is", async () => {
    const { clock, fleet, store, scheduler } = setup();
    fleet.scripts.set("a", () => ({ ok: false, code: "repo_not_found", message: "gone" }));
    const failed: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      clock.now += 1;
      // oxlint-disable-next-line no-await-in-loop -- created in order, so their ages differ
      failed.push((await enqueue(store, scheduler, spec())).id);
      // oxlint-disable-next-line no-await-in-loop -- each fails before the next is created
      await pass(scheduler);
    }
    fleet.scripts.delete("a");
    fleet.fleet = [machine("a", { connected: false })];
    const ready = await enqueue(store, scheduler, spec());
    await scheduler.prune(1);
    expect(scheduler.tasks().map((t) => t.id)).toEqual([...failed.slice(2), ready.id]);
    expect((await store.list()).map((s) => s.id)).toEqual([...failed.slice(2), ready.id]);
  });

  test("a finished task an unfinished one names is kept past the keep: its dependent would fail on work that was there", async () => {
    const { store, scheduler } = setup(new FakeFleet([]));
    await store.put("named", 0, { id: "named", spec: spec(), state: "done", createdAt: NOW });
    await store.put("other", 0, { id: "other", spec: spec(), state: "cancelled", createdAt: NOW + 1 });
    const deps = [{ task: "named", after: "merged" }] as const;
    await store.put("next", 0, { id: "next", spec: spec({ deps }), state: "queued", createdAt: NOW + 2 });
    await scheduler.load();
    await scheduler.prune(0);
    expect((await store.list()).map((s) => s.id)).toEqual(["named", "next"]);
  });

  test("a pass prunes only once the store holds pruneAt records, so a finished task is not gone before an app can name it", async () => {
    const config = { ...DEFAULT_CONFIG, keepFinished: 1, pruneAt: 4 };
    const { store, fleet, scheduler } = setup(new FakeFleet([machine("a")]), config);
    for (const [i, id] of ["f1", "f2", "f3"].entries()) {
      // oxlint-disable-next-line no-await-in-loop -- created in order, so their ages differ
      await store.put(id, 0, { id, spec: spec(), state: "done", createdAt: NOW - 10 + i });
    }
    await scheduler.load();
    await pass(scheduler);
    expect((await store.list()).map((s) => s.id)).toEqual(["f1", "f2", "f3"]);

    await store.put("f4", 0, { id: "f4", spec: spec(), state: "done", createdAt: NOW });
    await scheduler.refresh("f4");
    await pass(scheduler);
    expect((await store.list()).map((s) => s.id)).toEqual(["f4"]);
    expect(fleet.spawns).toEqual([]);
  });

  test("takeover below pruneAt prunes nothing: a create naming a finished task may be in flight", async () => {
    const config = { ...DEFAULT_CONFIG, keepFinished: 1, pruneAt: 4 };
    const { store, scheduler } = setup(new FakeFleet([machine("a")]), config);
    for (const [i, id] of ["f1", "f2", "f3"].entries()) {
      // oxlint-disable-next-line no-await-in-loop -- created in order, so their ages differ
      await store.put(id, 0, { id, spec: spec(), state: "done", createdAt: NOW - 10 + i });
    }
    await scheduler.takeover();
    expect((await store.list()).map((s) => s.id)).toEqual(["f1", "f2", "f3"]);
  });

  test("takeover answers without pruning; the pass after it prunes to the keep, its deletes all out at once", async () => {
    const config = { ...DEFAULT_CONFIG, keepFinished: 1, pruneAt: 2 };
    const { store, fleet, clock, scheduler } = setup(new FakeFleet([machine("a")]), config);
    for (const id of ["f1", "f2", "f3"]) {
      // oxlint-disable-next-line no-await-in-loop -- created in order, so their ages differ
      await store.put(id, 0, { id, spec: spec(), state: "done", createdAt: (clock.now += 1) });
    }
    let out = 0;
    let most = 0;
    const remove = store.delete.bind(store);
    store.delete = async (id, version) => {
      most = Math.max(most, (out += 1));
      await Bun.sleep(1);
      out -= 1;
      return remove(id, version);
    };
    await scheduler.takeover();
    expect((await store.list()).map((s) => s.id)).toEqual(["f1", "f2", "f3"]);
    await pass(scheduler);
    expect((await store.list()).map((s) => s.id)).toEqual(["f3"]);
    expect(most).toBe(2);

    const task = await enqueue(store, scheduler, spec(), undefined, clock.now);
    await pass(scheduler);
    fleet.end("a", task.id);
    await scheduler.onSession(task.id, "ended", { deviceId: "a", pane: "%1" });
    await pass(scheduler);
    expect((await store.list()).map((s) => s.id)).toEqual([task.id]);
  });

  test("equally old finished tasks go in id order, so two leaders prune the same ones", async () => {
    const { store, scheduler } = setup(new FakeFleet([]));
    for (const id of ["b", "c", "a"]) {
      // oxlint-disable-next-line no-await-in-loop -- stored in an order unrelated to the ids
      await store.put(id, 0, { id, spec: spec(), state: "done", createdAt: NOW });
    }
    await scheduler.load();
    await scheduler.prune(1);
    expect((await store.list()).map((s) => s.id)).toEqual(["c"]);
  });

  test("a delete whose reply was lost is read back: a committed one leaves no ghost, so later prunes reach the real excess", async () => {
    const errors: unknown[] = [];
    const store = new MemoryQueueStore();
    const config = { ...DEFAULT_CONFIG, keepFinished: 1, pruneAt: 2 };
    const scheduler = new Scheduler({
      store,
      fleet: new FakeFleet([]),
      config,
      now: () => NOW,
      onError: (e) => errors.push(e),
    });
    for (const [i, id] of ["old", "mid", "new"].entries()) {
      // oxlint-disable-next-line no-await-in-loop -- created in order, so their ages differ
      await store.put(id, 0, { id, spec: spec(), state: "done", createdAt: NOW - 10 + i });
    }
    await scheduler.load();
    store.failNext({ code: "indeterminate", commit: true });
    await scheduler.prune();
    expect(scheduler.task("old")).toBeUndefined();
    expect(scheduler.tasks().map((t) => t.id)).toEqual(["new"]);
    expect((await store.list()).map((e) => e.id)).toEqual(["new"]);
    await scheduler.prune();
    expect(errors).toEqual([]);
  });

  test("a delete that met another write keeps the record as the store now holds it", async () => {
    const errors: unknown[] = [];
    const store = new MemoryQueueStore();
    const scheduler = new Scheduler({
      store,
      fleet: new FakeFleet([]),
      now: () => NOW,
      onError: (e) => errors.push(e),
    });
    await store.put("old", 0, { id: "old", spec: spec(), state: "done", createdAt: NOW });
    await scheduler.load();
    await store.put("old", 1, { id: "old", spec: spec(), state: "done", createdAt: NOW, doneBy: "manual" });
    await scheduler.prune(0);
    expect(scheduler.task("old")).toMatchObject({ doneBy: "manual" });
    await scheduler.prune(0);
    expect(scheduler.task("old")).toBeUndefined();
    expect(await store.list()).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("the default pruneAt leaves room under the store's cap for apps' creates", () => {
    expect(DEFAULT_CONFIG.pruneAt).toBeLessThan(MAX_TASKS);
  });

  test("prune frees room under the store's cap: the oldest finished task goes, past keepFinished", async () => {
    const fleet = new FakeFleet([]);
    const store = new MemoryQueueStore({ maxTasks: 2 });
    const config = { ...DEFAULT_CONFIG, keepFinished: 1 };
    const scheduler = new Scheduler({ store, fleet, config, now: () => NOW });
    await store.put("old", 0, { id: "old", spec: spec(), state: "done", createdAt: NOW - 2 });
    await store.put("older", 0, { id: "older", spec: spec(), state: "failed", createdAt: NOW - 3 });
    await scheduler.load();
    await scheduler.prune();
    expect((await store.list()).map((e) => e.id)).toEqual(["old"]);
  });
});

describe("session state", () => {
  test("needs-input and back, then ended is done; events for unknown or unstarted tasks are ignored", async () => {
    const { scheduler, store } = setup();
    const task = await enqueue(store, scheduler, spec());
    await scheduler.onSession(task.id, "needs-input");
    expect(scheduler.task(task.id)?.state).toBe("queued");
    await scheduler.onSession("nope", "ended");

    await pass(scheduler);
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

describe("a session's own done report (#21)", () => {
  test("settles a reported task, and releases its after: done dependent on the next pass", async () => {
    const { scheduler, store } = setup();
    const pred = await enqueue(store, scheduler, spec({ until: "reported" }));
    const next = await enqueue(store, scheduler, spec({ deps: [{ task: pred.id, after: "done" }] }));
    await pass(scheduler);
    expect(scheduler.task(pred.id)?.state).toBe("running");
    expect(scheduler.task(next.id)?.state).toBe("blocked");

    await scheduler.onSession(pred.id, "done", { deviceId: "a", pane: "%1" });
    expect(scheduler.task(pred.id)).toMatchObject({ state: "done", doneBy: "reported" });
    await pass(scheduler);
    expect(scheduler.task(next.id)?.state).toBe("running");
  });

  test("a task that did not ask to settle on a report is left running", async () => {
    const { scheduler, store } = setup();
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    await scheduler.onSession(task.id, "done", { deviceId: "a", pane: "%1" });
    expect(scheduler.task(task.id)?.state).toBe("running");
  });
});

/**
 * The double spawn item 5 closes: a spawn lands, its reply is lost, and the
 * session ends inside the reservation TTL. Neither the session event nor the
 * `sessions` check may then read the task as never started.
 */
describe("a reply lost, then the session ends", () => {
  function lostReply() {
    const ctx = setup();
    ctx.fleet.scripts.set("a", (request) => {
      ctx.fleet.start("a", request);
      return unreachable;
    });
    return ctx;
  }

  test("the ended event resolves the reservation as done; the TTL check then spawns nothing", async () => {
    const { fleet, clock, scheduler, store } = lostReply();
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("reserved");

    fleet.end("a", task.id);
    await scheduler.onSession(task.id, "ended", { deviceId: "a", pane: "%1" });
    expect(scheduler.task(task.id)).toMatchObject({
      state: "done",
      assignment: { deviceId: "a", exclave: "main", clone: "app", pane: "%1" },
    });

    clock.now += 120_000;
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(fleet.spawns).toHaveLength(1);
    expect(scheduler.task(task.id)?.state).toBe("done");
  });

  test("the ended event lost too: past the TTL the daemon's `ended` says the task ran, and it is done", async () => {
    const { fleet, clock, scheduler, store } = lostReply();
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    fleet.end("a", task.id);

    clock.now += 120_000;
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(fleet.sessionCalls).toEqual(["a"]);
    expect(scheduler.task(task.id)).toMatchObject({ state: "done", assignment: { deviceId: "a", clone: "app" } });
    await pass(scheduler);
    expect(fleet.spawns).toHaveLength(1);
  });

  test("busy and needs-input resolve a reservation too, with the reporting pane", async () => {
    const { scheduler, store } = lostReply();
    const first = await enqueue(store, scheduler, spec());
    const second = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    await scheduler.onSession(first.id, "busy", { deviceId: "a", pane: "%1" });
    await scheduler.onSession(second.id, "needs-input", { deviceId: "a", pane: "%2" });
    expect(scheduler.task(first.id)).toMatchObject({ state: "running", assignment: { pane: "%1" } });
    expect(scheduler.task(second.id)).toMatchObject({ state: "needs-input", assignment: { pane: "%2" } });
  });

  test("an event from a machine the task was not placed on, or with no source, moves nothing", async () => {
    const { scheduler, store } = lostReply();
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    await scheduler.onSession(task.id, "ended", { deviceId: "b", pane: "%1" });
    await scheduler.onSession(task.id, "ended");
    expect(scheduler.task(task.id)?.state).toBe("reserved");

    await scheduler.onSession(task.id, "busy", { deviceId: "a", pane: "%1" });
    await scheduler.onSession(task.id, "ended", { deviceId: "b", pane: "%9" });
    expect(scheduler.task(task.id)?.state).toBe("running");
  });
});

describe("run now", () => {
  const ONE_SLOT = { ...DEFAULT_CONFIG, globalMax: 1, accountMax: 1 };

  /** One task running on `a`, a second `ready` and held by both caps. */
  async function capped() {
    const env = setup(new FakeFleet([machine("a")]), ONE_SLOT);
    const first = await enqueue(env.store, env.scheduler, spec());
    await pass(env.scheduler);
    const second = await enqueue(env.store, env.scheduler, spec());
    await pass(env.scheduler);
    expect(env.scheduler.task(second.id)?.state).toBe("ready");
    expect(env.scheduler.lastDecision(second.id)?.candidates.flatMap((c) => c.rejected)).toEqual([
      { code: "cap_reached", inFlight: 1, max: 1 },
      { code: "cap_reached", inFlight: 1, max: 1, scope: "account" },
    ]);
    return { ...env, first, second };
  }

  test("places a task past both caps; it then counts, so the next waits over the cap", async () => {
    const { fleet, scheduler, store, first, second } = await capped();
    const ran = await scheduler.runNow(second.id);
    expect(ran).toMatchObject({ ok: true, task: { state: "reserved", reservation: { deviceId: "a" } } });
    await scheduler.drain();
    expect(scheduler.task(second.id)?.state).toBe("running");
    expect(scheduler.task(first.id)?.state).toBe("running");
    expect(fleet.spawns).toHaveLength(2);
    expect((await stored(store, second.id))?.body.state).toBe("running");

    const third = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    expect(scheduler.task(third.id)?.state).toBe("ready");
    expect(scheduler.lastDecision(third.id)?.candidates.flatMap((c) => c.rejected)).toContainEqual({
      code: "cap_reached",
      inFlight: 2,
      max: 1,
    });
  });

  test("every other filter still holds: a paused queue is unplaceable and nothing is written or sent", async () => {
    const { fleet, scheduler, store, second } = await capped();
    expect(await scheduler.pause({ until: "resume" })).toMatchObject({ ok: true });
    const before = await stored(store, second.id);
    expect(await scheduler.runNow(second.id)).toEqual({ ok: false, code: "unplaceable" });
    expect(await stored(store, second.id)).toEqual(before);
    expect(fleet.spawns).toHaveLength(1);
    // The held decision is still the pass's, not the uncapped one.
    expect(scheduler.lastDecision(second.id)?.candidates.flatMap((c) => c.rejected)).toContainEqual(
      expect.objectContaining({ code: "cap_reached" }),
    );
  });

  test("refuses what is not a ready task: unknown, not admitted, placed, in flight, finished", async () => {
    const { fleet, scheduler, store, first, second } = await capped();
    expect(await scheduler.runNow("nobody")).toEqual({ ok: false, code: "not_found" });
    expect(await scheduler.runNow(first.id)).toEqual({ ok: false, code: "not_waiting" });
    const fresh = await enqueue(store, scheduler, spec());
    expect(await scheduler.runNow(fresh.id)).toEqual({ ok: false, code: "not_waiting" });

    const hung = Promise.withResolvers<TaskSpawnReply>();
    fleet.scripts.set("a", () => hung.promise);
    expect(await scheduler.runNow(second.id)).toMatchObject({ ok: true });
    expect(await scheduler.runNow(second.id)).toEqual({ ok: false, code: "dispatching" });
    const sent = fleet.spawns[1]?.request;
    if (sent === undefined) throw new Error("no spawn was sent");
    hung.resolve(fleet.start("a", sent));
    await scheduler.drain();

    expect(await scheduler.cancel(fresh.id)).toMatchObject({ ok: true });
    expect(await scheduler.runNow(fresh.id)).toEqual({ ok: false, code: "finished" });
  });

  test("a task it placed while a pass awaited an earlier reservation keeps its own decision", async () => {
    class Gated extends MemoryQueueStore {
      readonly held = Promise.withResolvers<void>();
      override async put(id: string, version: number, body: Task): ReturnType<MemoryQueueStore["put"]> {
        if (id === "x" && body.state === "reserved") await this.held.promise;
        return super.put(id, version, body);
      }
    }
    const store = new Gated();
    const fleet = new FakeFleet([machine("a"), machine("b")]);
    const scheduler = new Scheduler({ store, fleet, config: { ...DEFAULT_CONFIG, accountMax: 1 }, now: () => NOW });
    await enqueue(store, scheduler, spec({ pin: { deviceId: "a" } }), "first", NOW - 3);
    await pass(scheduler);
    await enqueue(store, scheduler, spec({ pin: { deviceId: "b" } }), "x", NOW - 2);
    await enqueue(store, scheduler, spec({ pin: { deviceId: "a" } }), "y", NOW - 1);

    // The pass routes `x` first (oldest) and waits on its write with `y` still in its snapshot.
    const ticking = scheduler.tick();
    await until(() => scheduler.task("y")?.state === "ready", "y admitted");
    expect(await scheduler.runNow("y")).toMatchObject({ ok: true, task: { state: "reserved" } });
    store.held.resolve();
    await ticking;
    await scheduler.drain();

    expect(scheduler.task("x")?.state).toBe("running");
    expect(scheduler.task("y")?.state).toBe("running");
    const decision = scheduler.lastDecision("y");
    expect(decision?.chosen?.deviceId).toBe("a");
    expect(decision?.candidates.flatMap((c) => c.rejected)).not.toContainEqual(
      expect.objectContaining({ code: "cap_reached" }),
    );
  });
});

describe("cancel", () => {
  test("a ready task is cancelled; a running one is despawned first; a finished one is refused", async () => {
    const { fleet, scheduler, store } = setup(new FakeFleet([machine("a", { connected: false })]));
    const waiting = await enqueue(store, scheduler, spec());
    expect(await scheduler.cancel(waiting.id)).toMatchObject({ ok: true, task: { state: "cancelled" } });
    expect(await scheduler.cancel(waiting.id)).toEqual({ ok: false, code: "finished" });

    fleet.fleet = [machine("a")];
    const live = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    expect(await scheduler.cancel(live.id)).toMatchObject({ ok: true });
    expect(fleet.despawns).toEqual([{ deviceId: "a", id: "%1" }]);
  });

  test("a write revoked after the despawn ran is unrecorded and ends the term through onError", async () => {
    class Revocable extends MemoryQueueStore {
      armed = false;
      override put(id: string, version: number, body: Task): ReturnType<MemoryQueueStore["put"]> {
        if (this.armed) return Promise.reject(new StoreRevoked("not_leader"));
        return super.put(id, version, body);
      }
    }
    const store = new Revocable();
    const fleet = new FakeFleet([machine("a")]);
    const errors: unknown[] = [];
    const scheduler = new Scheduler({
      store,
      fleet,
      now: () => NOW,
      onError: (err) => errors.push(err),
    });
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    store.armed = true;
    expect(await scheduler.cancel(task.id)).toEqual({ ok: false, code: "unrecorded" });
    expect(fleet.despawns).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(StoreRevoked);
  });

  test("a write revoked with nothing despawned still throws: nothing happened, so the next leader may be asked", async () => {
    class Revocable extends MemoryQueueStore {
      armed = false;
      override put(id: string, version: number, body: Task): ReturnType<MemoryQueueStore["put"]> {
        if (this.armed) return Promise.reject(new StoreRevoked("not_leader"));
        return super.put(id, version, body);
      }
    }
    const store = new Revocable();
    const fleet = new FakeFleet([machine("a", { connected: false })]);
    const scheduler = new Scheduler({ store, fleet, now: () => NOW });
    const waiting = await enqueue(store, scheduler, spec());
    store.armed = true;
    await expect(scheduler.cancel(waiting.id)).rejects.toBeInstanceOf(StoreRevoked);
    expect(fleet.despawns).toEqual([]);
  });

  test("a running task with no known pane is despawned through the session carrying its id", async () => {
    const { fleet, scheduler, store } = setup();
    fleet.scripts.set("a", (request) => {
      fleet.start("a", request);
      return { ok: false, code: "task_running", message: "already" };
    });
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
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
    const store = new GatedStore();
    const scheduler = new Scheduler({ store, fleet, now: () => NOW });
    await enqueue(store, scheduler, spec());
    const later = await enqueue(store, scheduler, spec());
    const ticking = scheduler.tick();
    await Bun.sleep(0);
    expect(await scheduler.cancel(later.id)).toMatchObject({ ok: true });
    held = false;
    gate.resolve();
    await ticking;
    await scheduler.drain();
    expect(scheduler.task(later.id)?.state).toBe("cancelled");
    expect(fleet.spawns.map((s) => s.request.taskId)).toEqual(["t1"]);
  });

  test("a session that reports ended before the despawn's reply lands is answered as the finished task", async () => {
    let scheduler: Scheduler | null = null;
    class EndingFleet extends FakeFleet {
      override async despawn(deviceId: string, request: DespawnRequest): Promise<DespawnResponse> {
        // The pane exits on the despawn, and its `ended` event outruns the reply.
        await scheduler?.onSession(request.id === "%1" ? "t1" : "", "ended", { deviceId, pane: request.id });
        return super.despawn(deviceId, request);
      }
    }
    const env = setup(new EndingFleet([machine("a")]));
    scheduler = env.scheduler;
    const task = await enqueue(env.store, env.scheduler, spec());
    await pass(env.scheduler);
    expect(await env.scheduler.cancel(task.id)).toMatchObject({ ok: true, task: { id: task.id, state: "done" } });
  });

  test("queued, blocked and awaiting-merge tasks have no session to stop: cancelled as they stand", async () => {
    const { store, fleet, scheduler } = setup(new FakeFleet([machine("a", { connected: false })]));
    const placed = { assignment: { deviceId: "a", exclave: "main", clone: "app", pane: "%1" } } as const;
    await store.put("q", 0, { id: "q", spec: spec(), state: "queued", createdAt: NOW });
    await store.put("b", 0, { id: "b", spec: spec(), state: "blocked", createdAt: NOW });
    await store.put("m", 0, { id: "m", spec: spec(), state: "awaiting-merge", createdAt: NOW, ...placed });
    await scheduler.load();
    for (const id of ["q", "b", "m"]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time, so a failure names its task
      expect(await scheduler.cancel(id)).toMatchObject({ ok: true, task: { id, state: "cancelled" } });
    }
    expect(fleet.despawns).toEqual([]);
    expect(fleet.sessionCalls).toEqual([]);
  });

  test("a reserved task is mid-dispatch and refused", async () => {
    const { fleet, scheduler, store } = setup();
    fleet.scripts.set("a", () => unreachable);
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
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
    const tasks = await Promise.all([enqueue(store, scheduler, spec()), enqueue(store, scheduler, spec())]);
    await pass(scheduler);
    // A third task whose spawn never reached its machine, and a fourth that ran and ended.
    fleet.scripts.set("a", () => unreachable);
    fleet.scripts.set("b", () => unreachable);
    const lost = await enqueue(store, scheduler, spec({ pin: { deviceId: "a" } }));
    await pass(scheduler);
    fleet.scripts.clear();
    const ended = await enqueue(store, scheduler, spec({ pin: { deviceId: "b" } }));
    await pass(scheduler);
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
    await pass(successor);
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

  test("asks only what a pass would: a `here` task awaiting its merge costs its machine no sessions", async () => {
    const { fleet, store, scheduler } = setup(new FakeFleet([machine("a"), machine("b")]));
    const prUrl = "https://github.com/acme/app/pull/1";
    const awaiting = { state: "awaiting-merge", createdAt: NOW, prUrl } as const;
    const at = { exclave: "main", clone: "app", pane: "%1" };
    await store.put("h", 0, {
      id: "h",
      spec: spec({ mode: "here" }),
      assignment: { deviceId: "a", ...at },
      ...awaiting,
    });
    await store.put("w", 0, { id: "w", spec: spec(), assignment: { deviceId: "b", ...at }, ...awaiting });
    await scheduler.takeover();
    expect(fleet.sessionCalls).toEqual(["b"]);
  });

  test("a `here` task awaiting its merge on `until: reported` is asked, and a report in `progress` settles it", async () => {
    const { fleet, store, scheduler } = setup(new FakeFleet([machine("a")]));
    const at = { deviceId: "a", exclave: "main", clone: "app", pane: "%1" };
    const prUrl = "https://github.com/acme/app/pull/1";
    await store.put("h", 0, {
      id: "h",
      spec: spec({ mode: "here", until: "reported" }),
      state: "awaiting-merge",
      createdAt: NOW,
      prUrl,
      assignment: at,
    });
    fleet.sessionsReply = () => ({
      ok: true,
      sessions: [],
      progress: [{ taskId: "h", prUrl, at: NOW, reported: true }],
    });
    await scheduler.takeover();
    expect(fleet.sessionCalls).toEqual(["a"]);
    expect(scheduler.task("h")).toMatchObject({ state: "done", doneBy: "reported" });
  });

  test("takeover settles an awaiting-merge task on a worktree from a report in `progress`", async () => {
    const { fleet, store, scheduler } = setup(new FakeFleet([machine("a")]));
    const at = { deviceId: "a", exclave: "main", clone: "app", pane: "%1" };
    const prUrl = "https://github.com/acme/app/pull/1";
    await store.put("w", 0, {
      id: "w",
      spec: spec({ until: "reported" }),
      state: "awaiting-merge",
      createdAt: NOW,
      prUrl,
      assignment: at,
    });
    fleet.sessionsReply = () => ({ ok: true, sessions: [], progress: [{ taskId: "w", at: NOW, reported: true }] });
    await scheduler.takeover();
    expect(scheduler.task("w")).toMatchObject({ state: "done", doneBy: "reported" });
  });

  test("takeover settles a reservation whose spawn landed from a report in `progress`", async () => {
    const fleet = new FakeFleet([machine("a")]);
    const { store, clock, scheduler } = setup(fleet);
    fleet.scripts.set("a", (request) => {
      fleet.start("a", request);
      return unreachable;
    });
    const task = await enqueue(store, scheduler, spec({ until: "reported" }));
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("reserved");
    fleet.sessionsReply = () => ({
      ok: true,
      sessions: fleet.running.get("a") ?? [],
      progress: [{ taskId: task.id, at: NOW, reported: true }],
    });
    const successor = new Scheduler({ store, fleet, now: () => clock.now });
    await successor.takeover();
    expect(successor.task(task.id)).toMatchObject({ state: "done", doneBy: "reported" });
  });

  test("takeover settles a running task, and one whose session is gone, from a report in `progress`", async () => {
    const { fleet, store, scheduler } = setup();
    const live = await enqueue(store, scheduler, spec({ until: "reported" }));
    const gone = await enqueue(store, scheduler, spec({ until: "reported" }));
    await pass(scheduler);
    expect(scheduler.tasks().map((t) => t.state)).toEqual(["running", "running"]);
    fleet.sessionsReply = () => ({
      ok: true,
      sessions: (fleet.running.get("a") ?? []).filter((s) => s.taskId === live.id),
      ended: [gone.id],
      progress: [
        { taskId: live.id, at: NOW, reported: true },
        { taskId: gone.id, at: NOW, reported: true },
      ],
    });
    await scheduler.takeover();
    expect(scheduler.task(live.id)).toMatchObject({ state: "done", doneBy: "reported" });
    expect(scheduler.task(gone.id)).toMatchObject({ state: "done", doneBy: "reported" });
  });

  test("a sweep settles an awaiting-merge `here` task from a report, and a report settles nothing under until: merged", async () => {
    const { fleet, clock, scheduler, store } = setup();
    const at = { deviceId: "a", exclave: "main", clone: "app", pane: "%1" };
    const awaiting = { state: "awaiting-merge", createdAt: NOW, assignment: at } as const;
    await store.put("r", 0, { id: "r", spec: spec({ mode: "here", until: "reported" }), ...awaiting });
    await store.put("m", 0, { id: "m", spec: spec({ mode: "here" }), ...awaiting });
    await scheduler.load();
    fleet.sessionsReply = () => ({
      ok: true,
      sessions: [],
      progress: [
        { taskId: "r", at: NOW, reported: true },
        { taskId: "m", at: NOW, reported: true },
      ],
    });
    clock.now += DEFAULT_CONFIG.sweepIntervalMs;
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(scheduler.task("r")).toMatchObject({ state: "done", doneBy: "reported" });
    expect(scheduler.task("m")?.state).toBe("awaiting-merge");
  });
});

describe("store", () => {
  test("load replaces the view with the store's: a new leader picks up what an old one left", async () => {
    const { store, fleet, scheduler } = setup();
    const task = await enqueue(store, scheduler, spec());
    const successor = new Scheduler({ store, fleet, now: () => NOW });
    await successor.load();
    expect(successor.tasks().map((t) => t.id)).toEqual([task.id]);
    await pass(successor);
    expect(successor.task(task.id)?.state).toBe("running");
  });

  test("a version conflict skips the write and refreshes the held copy from the store", async () => {
    const { store, fleet, scheduler } = setup();
    const task = await enqueue(store, scheduler, spec());
    // Someone else moved it first.
    const current = await stored(store, task.id);
    await store.put(task.id, current?.version ?? 0, { ...task, state: "cancelled" });
    await pass(scheduler);
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
  const gate = Promise.withResolvers<void>();
  class GatedStore extends MemoryQueueStore {
    override async put(id: string, version: number, body: Task): ReturnType<MemoryQueueStore["put"]> {
      if (body.state === "reserved") await gate.promise;
      return super.put(id, version, body);
    }
  }
  const fleet = new FakeFleet([machine("a")]);
  const store = new GatedStore();
  const scheduler = new Scheduler({ store, fleet, now: () => NOW });
  await enqueue(store, scheduler, spec());
  const first = scheduler.tick();
  await Bun.sleep(0);
  // A task arriving mid-pass waits for the pass rather than running beside it.
  await enqueue(store, scheduler, spec());
  const second = scheduler.tick();
  await Bun.sleep(0);
  expect(scheduler.tasks().map((t) => t.state)).toEqual(["ready", "queued"]);
  gate.resolve();
  await Promise.all([first, second]);
  await scheduler.drain();
  expect(fleet.spawns).toHaveLength(2);
  expect(scheduler.tasks().map((t) => t.state)).toEqual(["running", "running"]);
});

describe("a pass never waits on a check", () => {
  const SWEEP = DEFAULT_CONFIG.sweepIntervalMs;

  /** `a` runs a task; its `sessions` answers only once `release` is called. */
  async function slowA() {
    const fleet = new FakeFleet([machine("a"), machine("b")]);
    const env = setup(fleet);
    const run = await enqueue(env.store, env.scheduler, spec());
    await pass(env.scheduler);
    const gate = { open: (): void => {}, asked: 0 };
    const answered = fleet.sessions.bind(fleet);
    fleet.sessions = async (deviceId) => {
      if (deviceId === "a") {
        gate.asked += 1;
        await new Promise<void>((resolve) => {
          gate.open = resolve;
        });
      }
      return answered(deviceId);
    };
    return { ...env, run, release: () => gate.open(), asked: () => gate.asked };
  }

  test("a create during a slow sweep is dispatched while the sweep's sessions is still out", async () => {
    const { asked, clock, fleet, release, scheduler, store } = await slowA();
    clock.now += SWEEP;
    fleet.beat(clock.now);
    await scheduler.tick();
    const fresh = await enqueue(store, scheduler, spec(), undefined, clock.now);
    await scheduler.tick();
    expect(scheduler.task(fresh.id)?.state).not.toBe("queued");
    await until(() => scheduler.task(fresh.id)?.state === "running", "the create running");
    release();
    await scheduler.drain();
    expect(asked()).toBe(1);
  });

  test("one check per machine is out at a time, however many passes run meanwhile", async () => {
    const { asked, clock, fleet, release, run, scheduler } = await slowA();
    clock.now += SWEEP;
    fleet.beat(clock.now);
    await scheduler.tick();
    clock.now += SWEEP;
    fleet.beat(clock.now);
    await scheduler.tick();
    await scheduler.tick();
    expect(asked()).toBe(1);
    fleet.end("a", run.id);
    release();
    await scheduler.drain();
    // The answer settles its task, and the pass it ticks moves what that releases.
    expect(scheduler.task(run.id)?.state).toBe("done");
  });

  test("a machine whose sessions goes unanswered is not asked again until the next sweep, or until it reconnects", async () => {
    const fleet = new FakeFleet([machine("a")]);
    const { clock, scheduler, store } = setup(fleet);
    await store.put("x", 0, {
      id: "x",
      spec: spec(),
      state: "lost",
      createdAt: NOW,
      absentSince: NOW,
      assignment: { deviceId: "a", exclave: "main", clone: "app", pane: "%1" },
    });
    await scheduler.load();
    fleet.sessionsReply = () => unreachable;
    const asked = (): number => fleet.sessionCalls.filter((d) => d === "a").length;
    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- passes in turn, inside one sweep interval
      await pass(scheduler);
    }
    expect(asked()).toBe(1);

    clock.now += SWEEP;
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(asked()).toBe(2);

    fleet.fleet = [machine("a", { connected: false })];
    await pass(scheduler);
    fleet.fleet = [machine("a")];
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(asked()).toBe(3);
    expect(scheduler.task("x")?.state).toBe("lost");
  });
});

describe("a pass never waits on a spawn", () => {
  test("a spawn that never answers holds neither another machine's placement nor its own TTL check", async () => {
    const { fleet, clock, scheduler, store } = setup(new FakeFleet([machine("a"), machine("b")]));
    const hung = Promise.withResolvers<TaskSpawnReply>();
    fleet.scripts.set("a", () => hung.promise);
    const stuck = await enqueue(store, scheduler, spec({ pin: { deviceId: "a" } }));
    await scheduler.tick();
    expect(scheduler.task(stuck.id)?.state).toBe("reserved");

    const next = await enqueue(store, scheduler, spec({ pin: { deviceId: "b" } }));
    await scheduler.tick();
    await until(() => scheduler.task(next.id)?.state === "running", "the second task running");
    expect(scheduler.task(next.id)?.assignment?.deviceId).toBe("b");

    // Past its TTL with its spawn still out, the reservation waits for the verdict, not `sessions`.
    clock.now += DEFAULT_CONFIG.reservationTtlMs;
    fleet.beat(clock.now);
    await scheduler.tick();
    expect(fleet.sessionCalls).not.toContain("a");
    expect(scheduler.task(stuck.id)?.state).toBe("reserved");

    const sent = fleet.spawns[0]?.request;
    if (sent === undefined) throw new Error("no spawn was sent");
    hung.resolve(fleet.start("a", sent));
    await scheduler.drain();
    expect(scheduler.task(stuck.id)?.state).toBe("running");
  });

  test("a verdict for a reservation that was resolved and made again elsewhere changes nothing", async () => {
    const { fleet, scheduler, store } = setup(new FakeFleet([machine("a"), machine("b")]));
    const late = Promise.withResolvers<TaskSpawnReply>();
    fleet.scripts.set("a", () => late.promise);
    const task = await enqueue(store, scheduler, spec({ pin: { deviceId: "a" } }));
    await scheduler.tick();
    // An event resolves the reservation while the spawn is still out.
    await scheduler.onSession(task.id, "ended", { deviceId: "a", pane: "%1" });
    expect(scheduler.task(task.id)?.state).toBe("done");
    late.resolve({ ok: false, code: "repo_not_found", message: "late" });
    await scheduler.drain();
    expect(scheduler.task(task.id)?.state).toBe("done");
  });

  test("a dispatch that throws reaches onError, and the pass it came from is not cut short", async () => {
    const errors: unknown[] = [];
    const fleet = new FakeFleet([machine("a"), machine("b")]);
    fleet.scripts.set("a", () => Promise.reject(new Error("boom")));
    const store = new MemoryQueueStore();
    const scheduler = new Scheduler({ store, fleet, now: () => NOW, onError: (err) => errors.push(err) });
    await enqueue(store, scheduler, spec({ pin: { deviceId: "a" } }));
    const other = await enqueue(store, scheduler, spec({ pin: { deviceId: "b" } }));
    await pass(scheduler);
    expect(errors).toEqual([new Error("boom")]);
    expect(scheduler.task(other.id)?.state).toBe("running");
  });
});

describe("a spawn the relay never delivered", () => {
  test("is ready again at once, and the next pass routes it afresh", async () => {
    const { fleet, scheduler, store } = setup(new FakeFleet([machine("a")]));
    fleet.scripts.set("a", () => ({ ok: false, code: UNDELIVERED, message: "that machine is not connected" }));
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    expect(scheduler.task(task.id)).toMatchObject({ state: "ready" });
    expect(scheduler.task(task.id)?.reservation).toBeUndefined();
    fleet.fleet = [machine("a", { connected: false }), machine("b")];
    await pass(scheduler);
    expect(scheduler.task(task.id)).toMatchObject({ state: "running", assignment: { deviceId: "b" } });
    expect(fleet.spawns.map((s) => s.deviceId)).toEqual(["a", "b"]);
  });
});

describe("a session whose ended event never came", () => {
  test("is done within one sweep, and its slot is free again", async () => {
    const { fleet, clock, scheduler, store } = setup(new FakeFleet([machine("a")]), {
      ...DEFAULT_CONFIG,
      globalMax: 1,
    });
    const first = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    expect(scheduler.task(first.id)?.state).toBe("running");
    // The pane exits; the daemon's event is lost on the way.
    fleet.end("a", first.id);
    const second = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    expect(scheduler.lastDecision(second.id)?.candidates[0]?.rejected).toContainEqual(
      expect.objectContaining({ code: "cap_reached" }),
    );

    clock.now += DEFAULT_CONFIG.sweepIntervalMs;
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(scheduler.task(first.id)?.state).toBe("done");
    // Settled before routing, in the same pass: the freed slot goes to the waiting task.
    expect(scheduler.task(second.id)?.state).toBe("running");
  });

  test("the sweep asks each machine once, only when due, and only machines holding running tasks", async () => {
    const { fleet, clock, scheduler, store } = setup(new FakeFleet([machine("a"), machine("b"), machine("c")]));
    await Promise.all([
      enqueue(store, scheduler, spec()),
      enqueue(store, scheduler, spec()),
      enqueue(store, scheduler, spec()),
    ]);
    fleet.scripts.set("c", () => ({ ok: false, code: "repo_not_found", message: "gone" }));
    await pass(scheduler);
    clock.now += DEFAULT_CONFIG.sweepIntervalMs - 1;
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(fleet.sessionCalls).toEqual([]);
    clock.now += 1;
    fleet.beat(clock.now);
    await pass(scheduler);
    expect(fleet.sessionCalls.toSorted()).toEqual(["a", "b"]);
    expect(
      scheduler
        .tasks()
        .map((t) => t.state)
        .toSorted(),
    ).toEqual(["failed", "running", "running"]);
  });
});

describe("writes to one task never race", () => {
  /** A store whose puts take a round trip, as M3's relay store's will. */
  class SlowStore extends MemoryQueueStore {
    override async put(id: string, version: number, body: Task): ReturnType<MemoryQueueStore["put"]> {
      await Bun.sleep(20);
      return super.put(id, version, body);
    }
  }

  test("an ended event landing while the spawn verdict's write is out is applied after it: done", async () => {
    const fleet = new FakeFleet([machine("a")]);
    const store = new SlowStore();
    const scheduler = new Scheduler({ store, fleet, now: () => NOW });
    const task = await enqueue(store, scheduler, spec());
    await scheduler.tick();
    // The reservation is written; the spawn answered and its `running` write is in flight now.
    await until(() => fleet.spawns.length === 1, "the spawn");
    await scheduler.onSession(task.id, "ended", { deviceId: "a", pane: "%1" });
    await scheduler.drain();
    expect(scheduler.task(task.id)?.state).toBe("done");
    expect((await store.get(task.id))?.body?.state).toBe("done");
  });

  test("a conflict with a writer outside the process is re-read and the change applied to what it finds", async () => {
    const { store, fleet, scheduler } = setup();
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    // Another writer bumps the version without changing the state the event acts on.
    const current = await store.get(task.id);
    const body = current?.body ?? task;
    await store.put(task.id, current?.version ?? 0, { ...body, spec: { ...body.spec, title: "renamed" } });
    await scheduler.onSession(task.id, "needs-input", { deviceId: "a", pane: "%1" });
    expect((await store.get(task.id))?.body).toMatchObject({ state: "needs-input", spec: { title: "renamed" } });
    expect(fleet.spawns).toHaveLength(1);
  });
});
