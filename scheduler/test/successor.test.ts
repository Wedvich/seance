import { describe, expect, test } from "bun:test";
import {
  CAPABILITIES,
  DEP_MISSING_GRACE_MS,
  PASS_CLOSE_GRACE_MS,
  SUCCESSOR_CHAIN_MAX,
  type PrStatus,
  type SuccessorTrigger,
} from "@seance/shared";
import {
  MemoryQueueStore,
  Scheduler,
  StoreRevoked,
  type PassResult,
  type PrHeadReading,
  type Task,
  type TaskCreateResult,
} from "../src/index.ts";
import { exclave, FakeFleet, machine, NOW, obs, readerChecked, spec, status, unreachable } from "./fixtures.ts";

/**
 * Passing a running task to a successor (DESIGN.md, "Passing to a successor"), through the scheduler over
 * `MemoryQueueStore` and the fleet double, whose `pushBranch` answers what a machine's daemon would.
 */

const PR = "https://github.com/acme/app/pull/7";
const CAPABLE = [CAPABILITIES.metrics, CAPABILITIES.taskId, CAPABILITIES.successor];
const FAILED_DESPAWN = { ok: false, code: "internal_error", message: "no" } as const;
const OPEN: PrHeadReading = { kind: "read", head: "feature/x", crossRepository: false, state: "open" };

interface Setup {
  readonly store: MemoryQueueStore;
  readonly fleet: FakeFleet;
  readonly clock: { now: number };
  readonly scheduler: Scheduler;
  readonly lines: string[];
  readonly heads: string[];
  readonly creates: Task[];
  prHead: PrHeadReading;
  create: () => Promise<TaskCreateResult> | TaskCreateResult;
}

function setup(machines = [machine("a", { capabilities: CAPABLE })]): Setup {
  const clock = { now: NOW };
  const store = new MemoryQueueStore({ now: () => clock.now });
  const fleet = new FakeFleet(machines);
  const lines: string[] = [];
  const heads: string[] = [];
  const creates: Task[] = [];
  const state = { prHead: OPEN, create: (): TaskCreateResult => ({ ok: true }) } as Pick<Setup, "prHead" | "create">;
  const checked = readerChecked(store, () => clock.now);
  const scheduler = new Scheduler({
    store: checked,
    fleet,
    now: () => clock.now,
    log: (line) => lines.push(line),
    prHead: async (url) => {
      heads.push(url);
      return state.prHead;
    },
    create: async (task) => {
      creates.push(task);
      const made = await state.create();
      if (!made.ok) return made;
      const write = await checked.put(task.id, 0, task);
      return write.ok ? { ok: true } : { ok: false, code: write.code };
    },
  });
  return {
    store,
    fleet,
    clock,
    scheduler,
    lines,
    heads,
    creates,
    get prHead() {
      return state.prHead;
    },
    set prHead(value) {
      state.prHead = value;
    },
    get create() {
      return state.create;
    },
    set create(value) {
      state.create = value;
    },
  };
}

async function tick(scheduler: Scheduler): Promise<void> {
  await scheduler.tick();
  await scheduler.drain();
}

/** A task the scheduler placed and runs on `a`, with the PR a session reported when `pr` is set. */
async function running(s: Setup, pr = true, fields: Partial<Task["spec"]> = {}): Promise<Task> {
  const task: Task = { id: "old", spec: spec(fields), state: "queued", createdAt: NOW };
  await s.store.put(task.id, 0, task);
  await s.scheduler.refresh(task.id);
  await tick(s.scheduler);
  if (s.scheduler.task(task.id)?.state !== "running") throw new Error("the task did not start");
  if (pr) await s.scheduler.onSession(task.id, "busy", { deviceId: "a", pane: "%1" }, PR);
  const held = s.scheduler.task(task.id);
  if (held === undefined) throw new Error("the task vanished");
  return held;
}

function ok(result: PassResult): Extract<PassResult, { readonly ok: true }> {
  if (!result.ok) throw new Error(`pass refused: ${result.code}`);
  return result;
}

describe("pass", () => {
  test("pushes, creates a blocked successor, commits, closes the session and settles the old task superseded", async () => {
    const s = setup();
    const old = await running(s);
    const result = ok(await s.scheduler.pass(old.id));

    expect(s.fleet.pushes).toEqual([{ deviceId: "a", request: { taskId: "old", expect: "feature/x" } }]);
    expect(s.heads).toEqual([PR]);
    expect(s.fleet.despawns).toHaveLength(1);
    expect(result.task).toMatchObject({ id: "old", state: "superseded", successor: result.successorId });
    const successor = s.scheduler.task(result.successorId);
    expect(successor).toMatchObject({ state: "queued", prUrl: PR });
    expect(successor?.spec).toMatchObject({
      repo: old.spec.repo,
      mode: "worktree",
      client: "scheduler",
      succeeds: { task: "old", account: "org:a", trigger: "manual", at: { deviceId: "a", exclave: "main" } },
    });
    expect(successor?.spec.prompt).toContain("origin/feature/x");
    expect(successor?.spec.prompt).toContain("do it");
    expect(s.lines).toContain(`audit pass task="old" successor="${result.successorId}" trigger=manual`);
  });

  test("the successor is held until the old task is superseded, then placed on the same account like any task", async () => {
    const s = setup();
    const old = await running(s);
    const result = ok(await s.scheduler.pass(old.id));
    await tick(s.scheduler);

    expect(s.fleet.spawns.at(-1)?.request.taskId).toBe(result.successorId);
    expect(s.scheduler.task(result.successorId)?.state).toBe("running");
    expect(s.lines.some((l) => l.startsWith(`successor placed task="${result.successorId}" after=`))).toBe(true);
  });

  test("a successor whose first event is needs-input is counted as placed too", async () => {
    const s = setup();
    const old = await running(s, false);
    const result = ok(await s.scheduler.pass(old.id));
    const gate = Promise.withResolvers<void>();
    s.fleet.scripts.set("a", async (request) => {
      await gate.promise;
      return s.fleet.start("a", request);
    });
    const ticking = tick(s.scheduler);
    await Bun.sleep(5);
    expect(s.scheduler.task(result.successorId)?.state).toBe("reserved");
    await s.scheduler.onSession(result.successorId, "needs-input", { deviceId: "a", pane: "%9" });
    gate.resolve();
    await ticking;
    expect(s.scheduler.task(result.successorId)?.state).toBe("needs-input");
    expect(s.lines.some((l) => l.startsWith(`successor placed task="${result.successorId}" after=`))).toBe(true);
  });

  test("a task without a PR passes with no head to compare, and nothing is read", async () => {
    const s = setup();
    const old = await running(s, false);
    ok(await s.scheduler.pass(old.id));
    expect(s.heads).toEqual([]);
    expect(s.fleet.pushes[0]?.request).toEqual({ taskId: "old" });
  });

  test("a non-GitHub PR skips the cross-check", async () => {
    const s = setup();
    s.prHead = { kind: "skipped" };
    const old = await running(s);
    ok(await s.scheduler.pass(old.id));
    expect(s.fleet.pushes[0]?.request).toEqual({ taskId: "old" });
  });

  test("the trigger rides the successor's spec", async () => {
    const s = setup();
    const old = await running(s, false);
    const trigger: SuccessorTrigger = "session";
    const result = ok(await s.scheduler.pass(old.id, trigger));
    expect(s.scheduler.task(result.successorId)?.spec.succeeds?.trigger).toBe("session");
  });

  test("the successor carries the old task's requires and is placed only where the trait is declared", async () => {
    const s = setup([
      machine("a", { capabilities: CAPABLE, exclaves: [exclave("main", "org:a", { traits: ["atlas"] })] }),
      machine("b", { capabilities: CAPABLE, exclaves: [exclave("main", "org:b")] }),
    ]);
    const old = await running(s, false, { requires: ["atlas"] });
    expect(old.assignment?.deviceId).toBe("a");
    const result = ok(await s.scheduler.pass(old.id));
    expect(s.scheduler.task(result.successorId)?.spec.requires).toEqual(["atlas"]);

    await tick(s.scheduler);
    expect(s.scheduler.task(result.successorId)).toMatchObject({ state: "running", assignment: { deviceId: "a" } });
    const rejected = s.scheduler.lastDecision(result.successorId)?.candidates.find((c) => c.deviceId === "b")?.rejected;
    expect(rejected).toEqual([{ code: "trait_absent", trait: "atlas" }]);
  });

  describe("refused before anything is pushed", () => {
    const refusal = async (s: Setup, id = "old"): Promise<string> => {
      const result = await s.scheduler.pass(id);
      if (result.ok) throw new Error("pass was allowed");
      return result.code;
    };

    test("an unknown task, a finished one, a waiting one", async () => {
      const s = setup();
      expect(await refusal(s, "nope")).toBe("not_found");
      const old = await running(s, false);
      await s.scheduler.cancel(old.id);
      expect(await refusal(s)).toBe("finished");
      const waiting: Task = { id: "w", spec: spec(), state: "blocked", createdAt: NOW };
      await s.store.put("w", 0, waiting);
      await s.scheduler.refresh("w");
      expect(await refusal(s, "w")).toBe("not_running");
      expect(s.fleet.pushes).toEqual([]);
    });

    test("a task waiting on a person is never moved from under them", async () => {
      const s = setup();
      const old = await running(s, false);
      await s.scheduler.onSession(old.id, "needs-input", { deviceId: "a", pane: "%1" });
      expect(await refusal(s)).toBe("needs_input");
      expect(s.fleet.pushes).toEqual([]);
    });

    test("a task run in place has no branch to pass", async () => {
      const s = setup();
      await running(s, false, { mode: "here" });
      expect(await refusal(s)).toBe("here");
    });

    test("an offline machine, a machine without the capability, a host that cannot push or create", async () => {
      const off = setup([machine("a", { capabilities: CAPABLE })]);
      await running(off, false);
      off.fleet.fleet = [machine("a", { capabilities: CAPABLE, connected: false })];
      expect(await refusal(off)).toBe("offline");

      const old = setup([machine("a")]);
      await running(old, false);
      expect(await refusal(old)).toBe("successor_unsupported");

      const bare = setup();
      await running(bare, false);
      bare.fleet.pushBranch = undefined;
      expect(await refusal(bare)).toBe("successor_unsupported");
      expect(bare.fleet.pushes).toEqual([]);
    });

    test("an exclave that reports no account cannot say whose task the successor continues", async () => {
      const s = setup([
        machine("a", { capabilities: CAPABLE, exclaves: [{ ...machine("a").exclaves![0]!, accountId: null }] }),
      ]);
      // Never placed: an exclave with no account is not routable, so the task is built by hand.
      const task: Task = {
        id: "old",
        spec: spec(),
        state: "running",
        createdAt: NOW,
        assignment: { deviceId: "a", exclave: "main", clone: "app" },
      };
      await s.store.put("old", 0, task);
      await s.scheduler.refresh("old");
      expect(await refusal(s)).toBe("account_unknown");
    });

    test("a PR the leader cannot read, one already merged or closed, one from a fork", async () => {
      const s = setup();
      await running(s);
      s.prHead = { kind: "unreadable" };
      expect(await refusal(s)).toBe("pr_unreadable");
      s.prHead = { ...OPEN, state: "merged" } as PrHeadReading;
      expect(await refusal(s)).toBe("pr_not_open");
      s.prHead = { ...OPEN, state: "closed" } as PrHeadReading;
      expect(await refusal(s)).toBe("pr_not_open");
      s.prHead = { ...OPEN, crossRepository: true } as PrHeadReading;
      expect(await refusal(s)).toBe("branch_mismatch");
      expect(s.fleet.pushes).toEqual([]);
      expect(s.creates).toEqual([]);
    });
  });

  describe("a push that did not happen", () => {
    test.each([
      ["dirty_worktree", "dirty_worktree"],
      ["branch_mismatch", "branch_mismatch"],
      ["default_branch", "default_branch"],
      ["detached_head", "detached_head"],
      ["not_launched", "not_launched"],
      ["push_rejected", "push_rejected"],
      ["push_failed", "push_failed"],
      ["no_upstream", "push_failed"],
      ["invalid_request", "push_failed"],
    ] as const)("%s is answered %s and nothing is created", async (code, answered) => {
      const s = setup();
      const old = await running(s, false);
      s.fleet.pushReply = () => ({ ok: false, code, message: "no" });
      const result = await s.scheduler.pass(old.id);
      expect(result).toEqual({ ok: false, code: answered });
      expect(s.creates).toEqual([]);
      expect(s.scheduler.task(old.id)).toMatchObject({ state: "running" });
      expect(s.scheduler.task(old.id)?.successor).toBeUndefined();
    });

    test("a machine that never answers is push_failed, the session untouched", async () => {
      const s = setup();
      const old = await running(s, false);
      s.fleet.pushReply = () => unreachable;
      expect(await s.scheduler.pass(old.id)).toEqual({ ok: false, code: "push_failed" });
      expect(s.fleet.despawns).toEqual([]);
    });
  });

  test("a failed create is pass_failed and writes nothing else", async () => {
    const s = setup();
    const old = await running(s, false);
    s.create = () => ({ ok: false, code: "store_full" });
    expect(await s.scheduler.pass(old.id)).toEqual({ ok: false, code: "pass_failed" });
    expect(s.fleet.despawns).toEqual([]);
    expect(s.scheduler.task(old.id)?.successor).toBeUndefined();
  });

  test("a successor that cannot be read back at once is still named, and a retry creates no second", async () => {
    const s = setup();
    const old = await running(s, false);
    // The store fails one read of the successor, right after its create.
    const read = s.store.get.bind(s.store);
    let failures = 1;
    s.store.get = async (id) => {
      if (id !== old.id && failures > 0) {
        failures -= 1;
        throw new Error("transient");
      }
      return read(id);
    };
    const first = ok(await s.scheduler.pass(old.id));
    expect(failures).toBe(0);
    expect(s.scheduler.task(old.id)).toMatchObject({ state: "superseded", successor: first.successorId });
    expect(ok(await s.scheduler.pass(old.id)).successorId).toBe(first.successorId);
    expect(s.creates).toHaveLength(1);
  });

  test("the task changing under the push is a conflict, and nothing is created", async () => {
    const s = setup();
    const old = await running(s, false);
    s.fleet.pushReply = async () => {
      await s.scheduler.markDone(old.id);
      return { ok: true, remoteBranch: "feature/x", tip: "a".repeat(40), pushed: true };
    };
    expect(await s.scheduler.pass(old.id)).toEqual({ ok: false, code: "conflict" });
    expect(s.creates).toEqual([]);
  });

  describe("one pass per task at a time", () => {
    test("two concurrent passes make one successor and answer alike", async () => {
      const s = setup();
      const old = await running(s, false);
      const gate = Promise.withResolvers<void>();
      const answer = s.fleet.pushReply;
      s.fleet.pushReply = async (request) => {
        await gate.promise;
        return answer(request);
      };
      const first = s.scheduler.pass(old.id);
      const second = s.scheduler.pass(old.id);
      gate.resolve();
      const [a, b] = [ok(await first), ok(await second)];
      expect(b.successorId).toBe(a.successorId);
      expect(s.fleet.pushes).toHaveLength(1);
      expect(s.creates).toHaveLength(1);
      expect(s.lines).toContain(`pass joined task="old"`);
    });

    test("a repeat after the pass answers ok with the same successor, pushing and creating nothing", async () => {
      const s = setup();
      const old = await running(s, false);
      const first = ok(await s.scheduler.pass(old.id));
      const again = ok(await s.scheduler.pass(old.id));
      expect(again.successorId).toBe(first.successorId);
      expect(again.task.state).toBe("superseded");
      expect(s.fleet.pushes).toHaveLength(1);
      expect(s.creates).toHaveLength(1);
    });
  });

  describe("the close after the commit point", () => {
    test("a despawn that fails still answers ok, leaves the task running with its successor, and the next pass closes it", async () => {
      const s = setup();
      const old = await running(s, false);
      s.fleet.despawnReply = () => FAILED_DESPAWN;
      const result = ok(await s.scheduler.pass(old.id));
      expect(result.task).toMatchObject({ state: "running", successor: result.successorId });
      s.fleet.despawnReply = null;
      await tick(s.scheduler);
      expect(s.scheduler.task(old.id)?.state).toBe("superseded");
      // Released in the same pass that settled it, in the next.
      await tick(s.scheduler);
      expect(s.scheduler.task(result.successorId)?.state).toBe("running");
    });

    test("a takeover finds a task carrying successor and closes it", async () => {
      const s = setup();
      const old = await running(s, false);
      s.fleet.despawnReply = () => FAILED_DESPAWN;
      const result = ok(await s.scheduler.pass(old.id));
      s.fleet.despawnReply = null;
      const next = new Scheduler({
        store: readerChecked(s.store, () => s.clock.now),
        fleet: s.fleet,
        now: () => s.clock.now,
      });
      await next.takeover();
      await tick(next);
      expect(next.task(old.id)).toMatchObject({ state: "superseded", successor: result.successorId });
    });

    test("PASS_CLOSE_GRACE_MS is the leader's wait before its own close, which the outside path never uses", () => {
      expect(PASS_CLOSE_GRACE_MS).toBe(120_000);
    });
  });

  describe("a person wins over the superseded settle", () => {
    test("cancel after the commit leaves the task cancelled and fails the successor pass_abandoned", async () => {
      const s = setup();
      const old = await running(s, false);
      s.fleet.despawnReply = () => FAILED_DESPAWN;
      const result = ok(await s.scheduler.pass(old.id));
      s.fleet.despawnReply = null;
      const cancelled = await s.scheduler.cancel(old.id);
      expect(cancelled.ok).toBe(true);
      expect(s.scheduler.task(old.id)).toMatchObject({ state: "cancelled" });
      expect(s.scheduler.task(old.id)?.successor).toBeUndefined();
      await tick(s.scheduler);
      expect(s.scheduler.task(result.successorId)).toMatchObject({
        state: "failed",
        failure: { code: "pass_abandoned" },
      });
    });

    test("the despawn's own ended, arriving while the cancel is out, settles nothing", async () => {
      const s = setup();
      const old = await running(s, false);
      s.fleet.despawnReply = () => FAILED_DESPAWN;
      const result = ok(await s.scheduler.pass(old.id));
      const gate = Promise.withResolvers<void>();
      s.fleet.despawnReply = null;
      const base = s.fleet.despawn.bind(s.fleet);
      s.fleet.despawn = async (deviceId, request) => {
        const reply = await base(deviceId, request);
        // The session's end reaches the scheduler before the cancel's write does.
        await s.scheduler.onSession(old.id, "ended", { deviceId: "a", pane: "%1" });
        await gate.promise;
        return reply;
      };
      const cancelling = s.scheduler.cancel(old.id);
      await Bun.sleep(5);
      gate.resolve();
      const cancelled = await cancelling;
      expect(cancelled.ok).toBe(true);
      expect(s.scheduler.task(old.id)?.state).toBe("cancelled");
      await tick(s.scheduler);
      expect(s.scheduler.task(result.successorId)?.state).toBe("failed");
    });

    test("mark-done while the pass is still pushing wins over the commit that lands under its despawn", async () => {
      const s = setup();
      const old = await running(s, false);
      const pushGate = Promise.withResolvers<void>();
      const despawnGate = Promise.withResolvers<void>();
      const answer = s.fleet.pushReply;
      s.fleet.pushReply = async (request) => {
        await pushGate.promise;
        return answer(request);
      };
      const base = s.fleet.despawn.bind(s.fleet);
      let despawns = 0;
      s.fleet.despawn = async (deviceId, request) => {
        despawns += 1;
        // The first despawn is mark-done's: it stays out while the pass commits.
        if (despawns === 1) await despawnGate.promise;
        return base(deviceId, request);
      };
      const passing = s.scheduler.pass(old.id);
      await Bun.sleep(5);
      const marking = s.scheduler.markDone(old.id);
      await Bun.sleep(5);
      pushGate.resolve();
      const passed = ok(await passing);
      despawnGate.resolve();
      const marked = await marking;
      expect(marked).toMatchObject({ ok: true, task: { state: "done", doneBy: "manual" } });
      expect(s.scheduler.task(old.id)).toMatchObject({ state: "done", doneBy: "manual" });
      expect(s.scheduler.task(old.id)?.successor).toBeUndefined();
      await tick(s.scheduler);
      expect(s.scheduler.task(passed.successorId)).toMatchObject({
        state: "failed",
        failure: { code: "pass_abandoned" },
      });
    });

    test("mark-done after the commit ends the task done, and the successor fails", async () => {
      const s = setup();
      const old = await running(s, false);
      s.fleet.despawnReply = () => FAILED_DESPAWN;
      const result = ok(await s.scheduler.pass(old.id));
      s.fleet.despawnReply = null;
      const marked = await s.scheduler.markDone(old.id);
      expect(marked.ok).toBe(true);
      expect(s.scheduler.task(old.id)).toMatchObject({ state: "done", doneBy: "manual" });
      expect(s.scheduler.task(old.id)?.successor).toBeUndefined();
      await tick(s.scheduler);
      expect(s.scheduler.task(result.successorId)?.state).toBe("failed");
    });
  });

  describe("a merge while the successor waits", () => {
    const merged: PrStatus = { state: "merged", at: NOW };

    test("the old task's PR merging after the commit settles the successor done, unplaced", async () => {
      const s = setup();
      const old = await running(s);
      s.fleet.despawnReply = () => FAILED_DESPAWN;
      const result = ok(await s.scheduler.pass(old.id));
      await s.scheduler.onPrStatus(old.id, PR, merged);
      expect(s.scheduler.task(old.id)).toMatchObject({ state: "done", doneBy: "merged" });
      expect(s.scheduler.task(old.id)?.successor).toBeUndefined();
      await tick(s.scheduler);
      expect(s.scheduler.task(result.successorId)).toMatchObject({ state: "done", doneBy: "merged" });
      expect(s.scheduler.task(result.successorId)?.assignment).toBeUndefined();
      expect(s.lines.some((l) => l.startsWith(`successor settled task="${result.successorId}" state=done`))).toBe(true);
    });

    test("the successor's own PR reading settles it done while it waits for the old task to settle", async () => {
      const s = setup();
      const old = await running(s);
      s.fleet.despawnReply = () => FAILED_DESPAWN;
      const result = ok(await s.scheduler.pass(old.id));
      await s.scheduler.onPrStatus(result.successorId, PR, merged);
      expect(s.scheduler.task(result.successorId)).toMatchObject({ state: "done", doneBy: "merged" });
      expect(s.fleet.spawns.some((sp) => sp.request.taskId === result.successorId)).toBe(false);
    });
  });

  test("a term that ends before the commit lands answers unrecorded, and the successor fails once the task ends otherwise", async () => {
    const s = setup();
    const old = await running(s, false);
    const heldBack = s.store;
    // The commit is the first write after the create: refuse it as a revoked term would.
    const original = heldBack.put.bind(heldBack);
    let creates = 0;
    heldBack.put = async (id, version, body) => {
      if (id === "old" && body.successor !== undefined) throw new StoreRevoked("term over");
      if (version === 0) creates += 1;
      return original(id, version, body);
    };
    const errors: unknown[] = [];
    const scheduler = new Scheduler({
      store: heldBack,
      fleet: s.fleet,
      now: () => s.clock.now,
      onError: (err) => errors.push(err),
      prHead: async () => OPEN,
      create: async (task) => {
        const write = await original(task.id, 0, task);
        return write.ok ? { ok: true } : { ok: false, code: write.code };
      },
    });
    await scheduler.load();
    expect(await scheduler.pass(old.id)).toEqual({ ok: false, code: "unrecorded" });
    expect(errors).toHaveLength(1);
    expect(creates).toBe(0);
    expect(s.fleet.despawns).toEqual([]);
  });
});

describe("admission of a successor", () => {
  async function waiting(s: Setup, pred: Partial<Task>): Promise<Task> {
    const predecessor: Task = { id: "pred", spec: spec(), state: "running", createdAt: NOW, ...pred };
    await s.store.put("pred", 0, predecessor);
    const successor: Task = {
      id: "succ",
      spec: spec({
        succeeds: {
          task: "pred",
          account: "org:a",
          at: { deviceId: "a", exclave: "main", clone: "app" },
          trigger: "manual",
        },
      }),
      state: "queued",
      createdAt: NOW,
    };
    await s.store.put("succ", 0, successor);
    await s.scheduler.load();
    return successor;
  }

  test("stays blocked while the predecessor is unfinished, and while it is missing inside the grace", async () => {
    const s = setup();
    await waiting(s, {
      assignment: { deviceId: "a", exclave: "main", clone: "app" },
    });
    await tick(s.scheduler);
    expect(s.scheduler.task("succ")?.state).toBe("blocked");
    expect(s.fleet.spawns).toEqual([]);

    const lone = setup();
    const successor: Task = {
      id: "succ",
      spec: spec({
        succeeds: {
          task: "gone",
          account: "org:a",
          at: { deviceId: "a", exclave: "main", clone: "app" },
          trigger: "manual",
        },
      }),
      state: "queued",
      createdAt: NOW,
    };
    await lone.store.put("succ", 0, successor);
    await lone.scheduler.load();
    await tick(lone.scheduler);
    expect(lone.scheduler.task("succ")?.state).toBe("blocked");
    lone.clock.now += DEP_MISSING_GRACE_MS + 1;
    await tick(lone.scheduler);
    expect(lone.scheduler.task("succ")).toMatchObject({ state: "failed", failure: { code: "pass_abandoned" } });
  });

  test("is released by a predecessor superseded to it, and refused by one superseded to another task", async () => {
    const s = setup();
    await waiting(s, { state: "superseded", successor: "succ" });
    await tick(s.scheduler);
    expect(s.scheduler.task("succ")?.state).toBe("running");

    const other = setup();
    await waiting(other, { state: "superseded", successor: "someone-else" });
    await tick(other.scheduler);
    expect(other.scheduler.task("succ")).toMatchObject({ state: "failed", failure: { code: "pass_abandoned" } });
  });

  test.each(["failed", "cancelled", "done"] as const)(
    "a predecessor that finished %s fails it pass_abandoned",
    async (state) => {
      const s = setup();
      await waiting(s, { state, ...(state === "done" ? { doneBy: "manual" as const } : {}) });
      await tick(s.scheduler);
      expect(s.scheduler.task("succ")).toMatchObject({ state: "failed", failure: { code: "pass_abandoned" } });
    },
  );

  test("a merged predecessor settles it done", async () => {
    const s = setup();
    await waiting(s, { state: "done", doneBy: "merged" });
    await tick(s.scheduler);
    expect(s.scheduler.task("succ")).toMatchObject({ state: "done", doneBy: "merged" });
  });

  test("a successor never spills into credits: past the line on an account that may spend them, it waits", async () => {
    const credits = machine("a", {
      capabilities: CAPABLE,
      exclaves: [exclave("main", "org:a", { extraUsageEnabled: true })],
      status: status({ quota: [obs(0, { h: 95 })] }),
    });
    const s = setup([credits]);
    await waiting(s, { state: "superseded", successor: "succ" });
    await tick(s.scheduler);
    expect(s.scheduler.task("succ")?.state).toBe("ready");
    expect(s.scheduler.lastDecision("succ")?.candidates[0]?.rejected.map((r) => r.code)).toContain("quota_over_line");
    expect(s.fleet.spawns).toEqual([]);
  });
});

describe("dependents of a passed task", () => {
  async function chain(s: Setup, links: readonly Partial<Task>[]): Promise<void> {
    for (const [i, link] of links.entries()) {
      const id = `t${i}`;
      await s.store.put(id, 0, { id, spec: spec(), state: "queued", createdAt: NOW, ...link });
    }
    await s.store.put("dep", 0, {
      id: "dep",
      spec: spec({ deps: [{ task: "t0", after: "done" }] }),
      state: "queued",
      createdAt: NOW,
    });
    await s.scheduler.load();
  }

  test("wait on the end of the chain, and run when it is done", async () => {
    const s = setup();
    await chain(s, [
      { state: "superseded", successor: "t1" },
      { state: "superseded", successor: "t2" },
      { state: "done", doneBy: "merged" },
    ]);
    await tick(s.scheduler);
    expect(s.scheduler.task("dep")?.state).toBe("running");
  });

  test("fail when the chain ends failed", async () => {
    const s = setup();
    await chain(s, [
      { state: "superseded", successor: "t1" },
      { state: "failed", failure: { code: "session_failed", message: "x" } },
    ]);
    await tick(s.scheduler);
    expect(s.scheduler.task("dep")).toMatchObject({ state: "failed", failure: { code: "dependency_failed" } });
  });

  test("wait, and log once, on a chain longer than the bound or with a link gone", async () => {
    const s = setup();
    const links: Partial<Task>[] = Array.from({ length: SUCCESSOR_CHAIN_MAX + 2 }, (_, i) => ({
      state: "superseded" as const,
      successor: `t${i + 1}`,
    }));
    await chain(s, links);
    await tick(s.scheduler);
    await tick(s.scheduler);
    expect(s.scheduler.task("dep")?.state).toBe("blocked");
    expect(s.lines.filter((l) => l === `dependency chain unreadable task="dep"`)).toHaveLength(1);
  });

  test("a waiting successor's predecessor is kept from pruning", async () => {
    const s = setup();
    await chain(s, [
      { state: "superseded", successor: "t1" },
      {
        state: "queued",
        spec: spec({
          succeeds: {
            task: "t0",
            account: "org:a",
            at: { deviceId: "a", exclave: "main", clone: "app" },
            trigger: "manual",
          },
        }),
      },
    ]);
    await tick(s.scheduler);
    await s.scheduler.prune(0);
    expect(s.scheduler.task("t0")).toBeDefined();
  });
});
