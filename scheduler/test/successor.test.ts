import { describe, expect, test } from "bun:test";
import {
  CAPABILITIES,
  DEP_MISSING_GRACE_MS,
  type DespawnResponse,
  PASS_CLOSE_GRACE_MS,
  SUCCESSOR_CHAIN_MAX,
  type PrStatus,
  type QuotaObservation,
  type SuccessorTrigger,
} from "@seance/shared";
import {
  DEFAULT_CONFIG,
  MemoryQueueStore,
  Scheduler,
  StoreRevoked,
  type PassResult,
  type PrHeadReading,
  type SchedulerAlert,
  type Task,
  type TaskCreateResult,
} from "../src/index.ts";
import { clone, exclave, FakeFleet, machine, NOW, obs, readerChecked, spec, status, unreachable } from "./fixtures.ts";

/**
 * Passing a running task to a successor (DESIGN.md, "Passing to a successor"), through the scheduler over
 * `MemoryQueueStore` and the fleet double, whose `pushBranch` answers what a machine's daemon would.
 */

const PR = "https://github.com/acme/app/pull/7";
const CAPABLE = [CAPABILITIES.metrics, CAPABILITIES.taskId, CAPABILITIES.successor];
// An exit status makes an `ended` wait for the exit (`#ending`), which a machine without it never does.
const WITH_EXIT = [...CAPABLE, CAPABILITIES.exitStatus];
const SELF = [...CAPABLE, CAPABILITIES.successorSelf];
const TIP = "b".repeat(40);
const PUSHED = { remoteBranch: "feature/x", tip: TIP };
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
  readonly alerts: SchedulerAlert[];
  readonly errors: unknown[];
  /** Another scheduler over the same store, fleet and clock: a new leader's term, once loaded. */
  another: () => Scheduler;
  prHead: PrHeadReading;
  create: (task: Task) => Promise<TaskCreateResult> | TaskCreateResult;
}

function setup(machines = [machine("a", { capabilities: CAPABLE })]): Setup {
  const clock = { now: NOW };
  const store = new MemoryQueueStore({ now: () => clock.now });
  const fleet = new FakeFleet(machines);
  const lines: string[] = [];
  const heads: string[] = [];
  const creates: Task[] = [];
  const alerts: SchedulerAlert[] = [];
  const errors: unknown[] = [];
  const state = { prHead: OPEN, create: (): TaskCreateResult => ({ ok: true }) } as Pick<Setup, "prHead" | "create">;
  const checked = readerChecked(store, () => clock.now);
  const make = (): Scheduler =>
    new Scheduler({
      store: checked,
      fleet,
      now: () => clock.now,
      log: (line) => lines.push(line),
      onAlert: (alert) => alerts.push(alert),
      onError: (err) => errors.push(err),
      prHead: async (url) => {
        heads.push(url);
        return state.prHead;
      },
      create: async (task) => {
        creates.push(task);
        const made = await state.create(task);
        if (!made.ok) return made;
        const write = await checked.put(task.id, 0, task);
        // As the real `createTask` reads a conflict on a fresh id: the same create already landed.
        return write.ok || write.code === "version_conflict" ? { ok: true } : { ok: false, code: write.code };
      },
    });
  const scheduler = make();
  return {
    alerts,
    errors,
    another: make,
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
    // The relay answered: a refusal is final, and the same task is not sent again.
    expect(s.creates).toHaveLength(1);
  });

  describe("a create whose reply was lost", () => {
    const unconfirmed: TaskCreateResult = { ok: false, code: "unreachable", unconfirmed: true };

    /** A create that lands on its first call, whatever the answer; `answers` says what each call reports. */
    function landing(s: Setup, answers: readonly TaskCreateResult[]): void {
      let calls = 0;
      s.create = async (task) => {
        const answer = answers[Math.min(calls, answers.length - 1)] ?? unconfirmed;
        if (calls === 0) await s.store.put(task.id, 0, task);
        calls += 1;
        return answer;
      };
    }

    test("one that landed is re-sent identically, read as landed, and the pass goes on", async () => {
      const s = setup();
      const old = await running(s, false);
      landing(s, [unconfirmed, { ok: true }]);
      const result = ok(await s.scheduler.pass(old.id));
      expect(s.creates).toHaveLength(2);
      expect(s.creates[1]).toEqual(s.creates[0]!);
      expect(s.scheduler.task(old.id)).toMatchObject({ state: "superseded", successor: s.creates[0]?.id });
      expect(result.successorId).toBe(s.creates[0]?.id ?? "");
    });

    test("a re-send nothing answered either is read back, and a record seen there counts", async () => {
      const s = setup();
      const old = await running(s, false);
      landing(s, [unconfirmed]);
      const result = ok(await s.scheduler.pass(old.id));
      expect(s.creates).toHaveLength(2);
      expect(result.task).toMatchObject({ state: "superseded", successor: s.creates[0]?.id });
      expect(s.lines).toContain(`pass create unconfirmed task="${old.id}" successor="${s.creates[0]?.id}"`);
    });

    test("and no record seen there is pass_failed, with nothing despawned or named", async () => {
      const s = setup();
      const old = await running(s, false);
      s.create = () => unconfirmed;
      expect(await s.scheduler.pass(old.id)).toEqual({ ok: false, code: "pass_failed" });
      expect(s.creates).toHaveLength(2);
      expect(s.fleet.despawns).toEqual([]);
      expect(s.scheduler.task(old.id)?.successor).toBeUndefined();
    });

    test("a read-back that throws is pass_failed too, and never throws out of the pass", async () => {
      const s = setup();
      const old = await running(s, false);
      landing(s, [unconfirmed]);
      const read = s.store.get.bind(s.store);
      const readBack: string[] = [];
      s.store.get = async (id) => {
        if (id === old.id) return read(id);
        readBack.push(id);
        throw new Error("transient");
      };
      expect(await s.scheduler.pass(old.id)).toEqual({ ok: false, code: "pass_failed" });
      // The create was re-sent, then read back (and the read threw): not a pass_failed taken at the first doubt.
      expect(s.creates).toHaveLength(2);
      expect(readBack).toEqual(s.creates.slice(0, 1).map((task) => task.id));
      expect(s.scheduler.task(old.id)?.successor).toBeUndefined();
    });

    test("a retry after a read-back that saw nothing creates under the same id, so the orphan is found and named", async () => {
      const s = setup();
      const old = await running(s, false);
      landing(s, [unconfirmed]);
      const read = s.store.get.bind(s.store);
      // The create is in flight: it lands only after the read-back has seen nothing.
      let seen = false;
      s.store.get = async (id) => {
        if (id === old.id || seen) return read(id);
        seen = true;
        return null;
      };
      expect(await s.scheduler.pass(old.id)).toEqual({ ok: false, code: "pass_failed" });
      s.create = () => ({ ok: true });
      const result = ok(await s.scheduler.pass(old.id));
      const landed = s.creates[0]?.id ?? "";
      expect(result.successorId).toBe(landed);
      expect(s.creates.map((task) => task.id)).toEqual([landed, landed, landed]);
      expect(s.scheduler.task(old.id)).toMatchObject({ state: "superseded", successor: landed });
    });

    test("a create that threw is retried under the same id too", async () => {
      const s = setup();
      const old = await running(s, false);
      s.create = () => {
        throw new Error("store down");
      };
      await expect(s.scheduler.pass(old.id)).rejects.toThrow("store down");
      s.create = () => ({ ok: true });
      const result = ok(await s.scheduler.pass(old.id));
      expect(s.creates).toHaveLength(2);
      expect(s.creates[1]?.id).toBe(s.creates[0]?.id ?? "");
      expect(result.successorId).toBe(s.creates[0]?.id ?? "");
    });

    test("a refused create is final: the retry is a new successor", async () => {
      const s = setup();
      const old = await running(s, false);
      s.create = () => ({ ok: false, code: "store_full" });
      expect(await s.scheduler.pass(old.id)).toEqual({ ok: false, code: "pass_failed" });
      s.create = () => ({ ok: true });
      ok(await s.scheduler.pass(old.id));
      expect(s.creates[1]?.id).not.toBe(s.creates[0]?.id);
    });
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

  test("a successor another pass named under the push answers ok with that one, creating nothing", async () => {
    const s = setup();
    const old = await running(s, false);
    const answer = s.fleet.pushReply;
    s.fleet.pushReply = async (request) => {
      const held = s.scheduler.task(old.id);
      const entry = await s.store.get(old.id);
      if (held === undefined || entry === null || !("body" in entry)) throw new Error("the task is not held");
      await s.store.put(old.id, entry.version, { ...held, successor: "other" });
      await s.scheduler.refresh(old.id);
      return answer(request);
    };
    const result = ok(await s.scheduler.pass(old.id));
    expect(result.successorId).toBe("other");
    expect(s.creates).toEqual([]);
  });

  test("a successor another pass named during the create answers ok with that one, ours left to end with the task", async () => {
    const s = setup();
    const old = await running(s, false);
    s.create = async () => {
      const held = s.scheduler.task(old.id);
      const entry = await s.store.get(old.id);
      if (held === undefined || entry === null || !("body" in entry)) throw new Error("the task is not held");
      await s.store.put(old.id, entry.version, { ...held, successor: "other" });
      await s.scheduler.refresh(old.id);
      return { ok: true };
    };
    const result = ok(await s.scheduler.pass(old.id));
    expect(result.successorId).toBe("other");
    expect(s.scheduler.task(old.id)?.successor).toBe("other");
  });

  test("a task that needs a person during the create is a conflict, and the successor it left fails once the task ends", async () => {
    const s = setup();
    const old = await running(s, false);
    s.create = async () => {
      await s.scheduler.onSession(old.id, "needs-input", { deviceId: "a", pane: "%1" });
      return { ok: true };
    };
    expect(await s.scheduler.pass(old.id)).toEqual({ ok: false, code: "conflict" });
    expect(s.scheduler.task(old.id)?.successor).toBeUndefined();
    expect(s.fleet.despawns).toEqual([]);
    const orphan = s.creates[0]?.id ?? "";
    await s.scheduler.cancel(old.id);
    await tick(s.scheduler);
    expect(s.scheduler.task(orphan)).toMatchObject({ state: "failed", failure: { code: "pass_abandoned" } });
  });

  test("a task that moved machine under the push is a conflict, and nothing is created", async () => {
    const s = setup([machine("a", { capabilities: CAPABLE }), machine("b", { capabilities: CAPABLE })]);
    const old = await running(s, false);
    const answer = s.fleet.pushReply;
    s.fleet.pushReply = async (request) => {
      const entry = await s.store.get(old.id);
      const held = s.scheduler.task(old.id);
      if (held?.assignment === undefined || entry === null || !("body" in entry))
        throw new Error("the task is not held");
      await s.store.put(old.id, entry.version, { ...held, assignment: { ...held.assignment, deviceId: "b" } });
      await s.scheduler.refresh(old.id);
      return answer(request);
    };
    expect(await s.scheduler.pass(old.id)).toEqual({ ok: false, code: "conflict" });
    expect(s.creates).toEqual([]);
  });

  describe("an already-passed task is answered from its record", () => {
    for (const state of ["needs-input", "lost"] as const) {
      test(`${state} answers ok with its successor, pushing and creating nothing`, async () => {
        const s = setup();
        const old = await running(s, false);
        const held = s.scheduler.task(old.id);
        const entry = await s.store.get(old.id);
        if (held === undefined || entry === null || !("body" in entry)) throw new Error("the task is not held");
        await s.store.put(old.id, entry.version, { ...held, state, successor: "t-next" });
        await s.scheduler.refresh(old.id);
        expect(ok(await s.scheduler.pass(old.id)).successorId).toBe("t-next");
        expect(s.fleet.pushes).toEqual([]);
        expect(s.creates).toEqual([]);
      });
    }
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

    describe("a session that ends by another way than the close settles superseded, with its successor kept", () => {
      /** The pass committed, its despawn failed, and every close the leader retries fails too: only a settle path can end it. */
      async function stuck(s: Setup): Promise<{ readonly oldId: string; readonly successorId: string }> {
        const old = await running(s, false);
        s.fleet.despawnReply = () => FAILED_DESPAWN;
        const result = ok(await s.scheduler.pass(old.id));
        expect(result.task).toMatchObject({ state: "running", successor: result.successorId });
        return { oldId: old.id, successorId: result.successorId };
      }

      test("the sweep: the machine lists no session for it", async () => {
        const s = setup();
        const { oldId, successorId } = await stuck(s);
        s.fleet.sessionsReply = () => ({ ok: true, sessions: [] });
        s.clock.now += DEFAULT_CONFIG.sweepIntervalMs;
        await tick(s.scheduler);
        expect(s.scheduler.task(oldId)).toMatchObject({ state: "superseded", successor: successorId });
      });

      test("the ending timeout: its end waited on the exit past the deadline", async () => {
        const s = setup([machine("a", { capabilities: WITH_EXIT })]);
        const { oldId, successorId } = await stuck(s);
        const listed = { id: "%1", window: "w", repo: "app", path: "/wt/old", taskId: oldId } as const;
        s.fleet.sessionsReply = () => ({ ok: true, sessions: [listed] });
        await s.scheduler.onSession(oldId, "ended", { deviceId: "a", pane: "%1" });
        await s.scheduler.drain();
        expect(s.scheduler.task(oldId)?.state).toBe("running");
        s.clock.now += DEFAULT_CONFIG.endingTimeoutMs;
        // One read begun after the deadline still lists it, then the deadline alone settles.
        await tick(s.scheduler);
        await tick(s.scheduler);
        expect(s.scheduler.task(oldId)).toMatchObject({ state: "superseded", successor: successorId });
      });

      test("the machine's absence while its end waits on the exit", async () => {
        const s = setup([machine("a", { capabilities: WITH_EXIT })]);
        const { oldId, successorId } = await stuck(s);
        const listed = { id: "%1", window: "w", repo: "app", path: "/wt/old", taskId: oldId } as const;
        s.fleet.sessionsReply = () => ({ ok: true, sessions: [listed] });
        await s.scheduler.onSession(oldId, "ended", { deviceId: "a", pane: "%1" });
        await s.scheduler.drain();
        s.fleet.fleet = [machine("a", { capabilities: WITH_EXIT, connected: false })];
        await tick(s.scheduler);
        s.clock.now += DEFAULT_CONFIG.lostAfterMs;
        await tick(s.scheduler);
        expect(s.scheduler.task(oldId)).toMatchObject({ state: "superseded", successor: successorId });
      });
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

    /** The old task's commit write (the first with `successor` set) stays out until the returned gate opens. */
    function holdCommit(s: Setup): { readonly landing: Promise<void>; readonly release: () => void } {
      const gate = Promise.withResolvers<void>();
      const reached = Promise.withResolvers<void>();
      const original = s.store.put.bind(s.store);
      s.store.put = async (id, version, body) => {
        if (id === "old" && body.successor !== undefined) {
          reached.resolve();
          await gate.promise;
        }
        return original(id, version, body);
      };
      return { landing: reached.promise, release: () => gate.resolve() };
    }

    /** The first despawn stays out until the returned gate opens (a stop's own, when it is the one begun first). */
    function holdFirstDespawn(s: Setup, reply?: () => DespawnResponse): () => void {
      const gate = Promise.withResolvers<void>();
      const base = s.fleet.despawn.bind(s.fleet);
      let calls = 0;
      s.fleet.despawn = async (deviceId, request) => {
        calls += 1;
        if (calls > 1) return base(deviceId, request);
        await gate.promise;
        return reply === undefined ? base(deviceId, request) : reply();
      };
      return () => gate.resolve();
    }

    test("mark-done while the pass is committing wins over the commit that lands under its despawn", async () => {
      const s = setup();
      const old = await running(s, false);
      const commit = holdCommit(s);
      const releaseDespawn = holdFirstDespawn(s);
      const passing = s.scheduler.pass(old.id);
      await commit.landing;
      // The commit has passed its check and is writing: the task still reads `running`, so only the in-flight pass tells.
      expect(s.scheduler.task(old.id)?.successor).toBeUndefined();
      const marking = s.scheduler.markDone(old.id);
      await Bun.sleep(5);
      commit.release();
      const passed = ok(await passing);
      releaseDespawn();
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

    test("mark-done while the pass is still pushing refuses the pass before it creates anything", async () => {
      const s = setup();
      const old = await running(s, false);
      const pushGate = Promise.withResolvers<void>();
      const answer = s.fleet.pushReply;
      s.fleet.pushReply = async (request) => {
        await pushGate.promise;
        return answer(request);
      };
      const releaseDespawn = holdFirstDespawn(s);
      const passing = s.scheduler.pass(old.id);
      await Bun.sleep(5);
      const marking = s.scheduler.markDone(old.id);
      await Bun.sleep(5);
      pushGate.resolve();
      expect(await passing).toEqual({ ok: false, code: "conflict" });
      releaseDespawn();
      expect(await marking).toMatchObject({ ok: true, task: { state: "done", doneBy: "manual" } });
      expect(s.creates).toEqual([]);
      expect(s.scheduler.task(old.id)?.successor).toBeUndefined();
    });

    test("mark-done while the successor is being created refuses the commit, and the successor fails", async () => {
      const s = setup();
      const old = await running(s, false);
      const createGate = Promise.withResolvers<void>();
      s.create = async () => {
        await createGate.promise;
        return { ok: true };
      };
      const releaseDespawn = holdFirstDespawn(s);
      const passing = s.scheduler.pass(old.id);
      await Bun.sleep(5);
      expect(s.creates).toHaveLength(1);
      const marking = s.scheduler.markDone(old.id);
      await Bun.sleep(5);
      createGate.resolve();
      expect(await passing).toEqual({ ok: false, code: "conflict" });
      releaseDespawn();
      expect(await marking).toMatchObject({ ok: true, task: { state: "done", doneBy: "manual" } });
      expect(s.scheduler.task(old.id)?.successor).toBeUndefined();
      await tick(s.scheduler);
      expect(s.scheduler.task(s.creates[0]?.id ?? "")).toMatchObject({
        state: "failed",
        failure: { code: "pass_abandoned" },
      });
    });

    for (const stop of ["markDone", "cancel"] as const) {
      test(`a ${stop} begun first wins over a pass that starts during its despawn`, async () => {
        const s = setup();
        const old = await running(s, false);
        const release = holdFirstDespawn(s);
        const stopping = s.scheduler[stop](old.id);
        await Bun.sleep(5);
        expect(await s.scheduler.pass(old.id)).toEqual({ ok: false, code: "conflict" });
        // Refused before anything left the leader: no read, no push, no successor.
        expect(s.heads).toEqual([]);
        expect(s.fleet.pushes).toEqual([]);
        expect(s.creates).toEqual([]);
        release();
        expect(await stopping).toMatchObject({ ok: true, task: { state: stop === "cancel" ? "cancelled" : "done" } });
        expect(s.scheduler.task(old.id)?.successor).toBeUndefined();
        expect(s.fleet.despawns).toHaveLength(1);
      });
    }

    test("a stop whose despawn failed no longer blocks a pass", async () => {
      const s = setup();
      const old = await running(s, false);
      s.fleet.despawnReply = () => FAILED_DESPAWN;
      expect(await s.scheduler.markDone(old.id)).toMatchObject({ ok: false, code: "despawn_failed" });
      s.fleet.despawnReply = null;
      const result = ok(await s.scheduler.pass(old.id));
      expect(result.task).toMatchObject({ state: "superseded" });
    });

    /** A mark-done whose despawn fails while the pass commits: refused, and the pass's own close is held by it. */
    async function failedMarkDuringCommit(s: Setup): Promise<{ readonly oldId: string; readonly successorId: string }> {
      const old = await running(s, false);
      const commit = holdCommit(s);
      const releaseDespawn = holdFirstDespawn(s, () => FAILED_DESPAWN);
      const passing = s.scheduler.pass(old.id);
      await commit.landing;
      const marking = s.scheduler.markDone(old.id);
      await Bun.sleep(5);
      commit.release();
      const passed = ok(await passing);
      releaseDespawn();
      // The person saw it fail: nothing was written for it.
      expect(await marking).toMatchObject({ ok: false, code: "despawn_failed" });
      expect(passed.task).toMatchObject({ state: "running", successor: passed.successorId });
      return { oldId: old.id, successorId: passed.successorId };
    }

    test("a mark-done whose despawn failed leaves the pass standing, retried at its grace", async () => {
      const s = setup();
      const { oldId, successorId } = await failedMarkDuringCommit(s);
      await tick(s.scheduler);
      expect(s.scheduler.task(oldId)).toMatchObject({ state: "running", successor: successorId });
      s.clock.now += PASS_CLOSE_GRACE_MS + 1;
      await tick(s.scheduler);
      expect(s.scheduler.task(oldId)).toMatchObject({ state: "superseded", successor: successorId });
      // Once superseded the successor may run, so a later mark-done says it is finished rather than rewriting it.
      expect(await s.scheduler.markDone(oldId)).toMatchObject({ ok: false, code: "finished" });
    });

    test("a mark-done retried before that grace wins, and the successor fails", async () => {
      const s = setup();
      const { oldId, successorId } = await failedMarkDuringCommit(s);
      expect(await s.scheduler.markDone(oldId)).toMatchObject({ ok: true, task: { state: "done", doneBy: "manual" } });
      expect(s.scheduler.task(oldId)?.successor).toBeUndefined();
      await tick(s.scheduler);
      expect(s.scheduler.task(successorId)).toMatchObject({ state: "failed", failure: { code: "pass_abandoned" } });
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
  async function waiting(s: Setup, pred: Partial<Task> | "unreadable"): Promise<Task> {
    if (pred === "unreadable") {
      s.store.plant("pred", "unopenable");
    } else {
      const predecessor: Task = { id: "pred", spec: spec(), state: "running", createdAt: NOW, ...pred };
      await s.store.put("pred", 0, predecessor);
    }
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

  test("an unreadable predecessor keeps it blocked, past the grace too", async () => {
    const s = setup();
    await waiting(s, "unreadable");
    await tick(s.scheduler);
    s.clock.now += DEP_MISSING_GRACE_MS + 1;
    await tick(s.scheduler);
    expect(s.scheduler.task("succ")?.state).toBe("blocked");
    expect(s.fleet.spawns).toEqual([]);
  });

  test("a running predecessor that already names it keeps it blocked until the close settles", async () => {
    const s = setup();
    // The leader's own close of it (reconcile) must not land, or the predecessor settles and releases the successor.
    s.fleet.despawnReply = () => FAILED_DESPAWN;
    await waiting(s, {
      state: "running",
      successor: "succ",
      assignment: { deviceId: "a", exclave: "main", clone: "app", pane: "%1" },
    });
    await tick(s.scheduler);
    expect(s.scheduler.task("succ")?.state).toBe("blocked");
    expect(s.fleet.spawns).toEqual([]);
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

describe("the session's own pass", () => {
  const self = (record?: string, from = "a") => ({ from, pushed: PUSHED, ...(record === undefined ? {} : { record }) });

  test("skips the push, builds the prompt from the record, arms the daemon's close and leaves the session to it", async () => {
    const s = setup([machine("a", { capabilities: SELF })]);
    const old = await running(s);
    const result = ok(await s.scheduler.pass(old.id, "session", self("done: a; left: b")));

    expect(s.fleet.pushes).toEqual([]);
    expect(s.fleet.passCloses).toEqual([{ deviceId: "a", request: { taskId: "old" } }]);
    // The daemon closes at the turn's end: the leader neither despawns nor settles now.
    expect(s.fleet.despawns).toEqual([]);
    expect(result.task).toMatchObject({ id: "old", state: "running", successor: result.successorId });
    const successor = s.scheduler.task(result.successorId);
    expect(successor?.spec).toMatchObject({ succeeds: { task: "old", trigger: "session" }, client: "scheduler" });
    expect(successor?.spec.prompt).toContain("origin/feature/x");
    expect(successor?.spec.prompt).toContain(TIP);
    expect(successor?.spec.prompt).toContain("done: a; left: b");
    expect(s.lines).toContain(`audit pass task="old" successor="${result.successorId}" trigger=session`);
    expect(s.lines).toContain(`audit pass-close task="old" outcome=armed`);
    expect(s.lines.join("\n")).not.toContain("done: a; left: b");
  });

  test("the session's end settles the old task superseded and releases the successor", async () => {
    const s = setup([machine("a", { capabilities: SELF })]);
    const old = await running(s, false);
    const result = ok(await s.scheduler.pass(old.id, "session", self()));
    await s.scheduler.onSession(old.id, "ended", { deviceId: "a", pane: "%1" });
    await tick(s.scheduler);
    expect(s.scheduler.task(old.id)).toMatchObject({ state: "superseded", successor: result.successorId });
  });

  test("a task waiting on a person is passed, the session being the one that called", async () => {
    const s = setup([machine("a", { capabilities: SELF })]);
    const old = await running(s, false);
    await s.scheduler.onSession(old.id, "needs-input", { deviceId: "a", pane: "%1" });
    expect(s.scheduler.task(old.id)?.state).toBe("needs-input");
    const result = ok(await s.scheduler.pass(old.id, "session", self()));
    expect(result.task).toMatchObject({ state: "needs-input", successor: result.successorId });
    expect(s.fleet.passCloses).toHaveLength(1);
    // The outside paths still refuse it.
    const other = setup();
    const waiting = await running(other, false);
    await other.scheduler.onSession(waiting.id, "needs-input", { deviceId: "a", pane: "%1" });
    expect(await other.scheduler.pass(waiting.id)).toMatchObject({ ok: false, code: "needs_input" });
  });

  test("only the task's own machine may ask, and a refusal changes nothing", async () => {
    const s = setup([machine("a", { capabilities: SELF }), machine("b", { capabilities: SELF })]);
    const old = await running(s, false);
    expect(await s.scheduler.pass(old.id, "session", self(undefined, "b"))).toMatchObject({ ok: false });
    expect(s.creates).toEqual([]);
    expect(s.fleet.passCloses).toEqual([]);
    expect(s.scheduler.task(old.id)?.successor).toBeUndefined();
    expect(s.lines.some((l) => l.includes("op=session-pass") && l.includes(`from="b"`))).toBe(true);
  });

  test("the pass is refused before anything is created when the machine lacks successorSelf or the host cannot arm a close", async () => {
    const plain = setup();
    const a = await running(plain, false);
    expect(await plain.scheduler.pass(a.id, "session", self())).toEqual({ ok: false, code: "successor_unsupported" });
    expect(plain.creates).toEqual([]);

    const noPort = setup([machine("a", { capabilities: SELF })]);
    const b = await running(noPort, false);
    noPort.fleet.passClose = undefined;
    expect(await noPort.scheduler.pass(b.id, "session", self())).toEqual({ ok: false, code: "successor_unsupported" });
    expect(noPort.creates).toEqual([]);
  });

  test("the PR's head is compared with the branch the daemon pushed", async () => {
    const s = setup([machine("a", { capabilities: SELF })]);
    const old = await running(s);
    s.prHead = { ...OPEN, head: "other/branch" };
    expect(await s.scheduler.pass(old.id, "session", self())).toEqual({ ok: false, code: "branch_mismatch" });
    expect(s.creates).toEqual([]);
    expect(s.fleet.passCloses).toEqual([]);

    s.prHead = { ...OPEN, state: "merged" };
    expect(await s.scheduler.pass(old.id, "session", self())).toEqual({ ok: false, code: "pr_not_open" });
    s.prHead = { kind: "unreadable" };
    expect(await s.scheduler.pass(old.id, "session", self())).toEqual({ ok: false, code: "pr_unreadable" });
  });

  test("a record is cut, and only its fact logged, when the prompt would not fit", async () => {
    const s = setup([machine("a", { capabilities: SELF })]);
    const old = await running(s, false);
    // Three-byte text passes the unit bound and meets the byte bound.
    const record = "€".repeat(7_168);
    const result = ok(await s.scheduler.pass(old.id, "session", self(record)));
    expect(s.scheduler.task(result.successorId)?.spec.prompt?.length).toBeLessThanOrEqual(8_192);
    expect(s.lines).toContain(`pass record cut task="old"`);
    expect(s.lines.join("\n")).not.toContain("€€€€");
  });

  test("a second ask joins the first, and a repeat after the commit answers the same successor", async () => {
    const s = setup([machine("a", { capabilities: SELF })]);
    const old = await running(s, false);
    const [x, y] = await Promise.all([
      s.scheduler.pass(old.id, "session", self("one")),
      s.scheduler.pass(old.id, "session", self("two")),
    ]);
    expect(ok(x).successorId).toBe(ok(y).successorId);
    expect(ok(await s.scheduler.pass(old.id, "session", self("three"))).successorId).toBe(ok(x).successorId);
    expect(s.creates).toHaveLength(1);
    expect(s.fleet.passCloses).toHaveLength(1);
  });

  test("a cancel out for the task wins, as it does over an outside pass", async () => {
    const s = setup([machine("a", { capabilities: SELF })]);
    const old = await running(s, false);
    await s.scheduler.cancel(old.id);
    expect(await s.scheduler.pass(old.id, "session", self())).toMatchObject({ ok: false });
    expect(s.fleet.passCloses).toEqual([]);
  });

  describe("the close the daemon was asked for", () => {
    test("a daemon that never answers leaves the pass committed, and the deadline closes it through the leader", async () => {
      const s = setup([machine("a", { capabilities: SELF })]);
      const old = await running(s, false);
      s.fleet.passCloseReply = () => unreachable;
      const result = ok(await s.scheduler.pass(old.id, "session", self()));
      expect(result.task.state).toBe("running");
      await tick(s.scheduler);
      expect(s.fleet.despawns).toEqual([]);
      s.clock.now += PASS_CLOSE_GRACE_MS + 1;
      await tick(s.scheduler);
      expect(s.fleet.despawns).toHaveLength(1);
      expect(s.scheduler.task(old.id)?.state).toBe("superseded");
    });

    test("no_pane means the session is already gone: the next tick settles it, with no grace to wait out", async () => {
      const s = setup([machine("a", { capabilities: SELF })]);
      const old = await running(s, false);
      s.fleet.passCloseReply = () => ({ ok: false, code: "no_pane", message: "gone" });
      const result = ok(await s.scheduler.pass(old.id, "session", self()));
      expect(result.task.state).toBe("running");
      await tick(s.scheduler);
      expect(s.scheduler.task(old.id)).toMatchObject({ state: "superseded", successor: result.successorId });
    });

    test("a takeover's re-ask that finds no pane settles the task on a later tick, not after a fresh grace", async () => {
      const s = setup([machine("a", { capabilities: SELF })]);
      const old = await running(s, false);
      ok(await s.scheduler.pass(old.id, "session", self()));
      s.fleet.passCloseReply = () => ({ ok: false, code: "no_pane", message: "gone" });
      const next = new Scheduler({
        store: readerChecked(s.store, () => s.clock.now),
        fleet: s.fleet,
        now: () => s.clock.now,
      });
      await next.takeover();
      // The re-ask is not awaited by the tick, so its answer lands for the one after.
      await tick(next);
      await tick(next);
      expect(next.task(old.id)?.state).toBe("superseded");
    });

    test("a takeover's tick does not wait for a daemon slow to answer the re-armed close", async () => {
      const s = setup([machine("a", { capabilities: SELF })]);
      const old = await running(s, false);
      ok(await s.scheduler.pass(old.id, "session", self()));
      const release = Promise.withResolvers<void>();
      let asked = 0;
      s.fleet.passClose = async () => {
        asked += 1;
        await release.promise;
        return { ok: true };
      };
      const next = new Scheduler({
        store: readerChecked(s.store, () => s.clock.now),
        fleet: s.fleet,
        now: () => s.clock.now,
      });
      await next.takeover();
      // Resolves while the re-ask is still outstanding.
      await tick(next);
      expect(asked).toBe(1);
      release.resolve();
    });

    test("a takeover asks the daemon again for a session-triggered pass and waits a fresh grace", async () => {
      const s = setup([machine("a", { capabilities: SELF })]);
      const viaSession = await running(s, false);
      ok(await s.scheduler.pass(viaSession.id, "session", self()));
      expect(s.fleet.passCloses).toHaveLength(1);

      const next = new Scheduler({
        store: readerChecked(s.store, () => s.clock.now),
        fleet: s.fleet,
        now: () => s.clock.now,
      });
      await next.takeover();
      await tick(next);
      expect(s.fleet.passCloses).toHaveLength(2);
      expect(s.fleet.despawns).toEqual([]);
      expect(next.task(viaSession.id)?.state).toBe("running");
      s.clock.now += PASS_CLOSE_GRACE_MS + 1;
      await tick(next);
      expect(next.task(viaSession.id)?.state).toBe("superseded");
      expect(s.fleet.despawns).toHaveLength(1);
    });

    test("an outside pass whose close failed is closed at once by the next leader, never asked of the daemon", async () => {
      const s = setup([machine("a", { capabilities: SELF })]);
      const old = await running(s, false);
      s.fleet.despawnReply = () => FAILED_DESPAWN;
      ok(await s.scheduler.pass(old.id));
      s.fleet.despawnReply = null;
      const next = new Scheduler({
        store: readerChecked(s.store, () => s.clock.now),
        fleet: s.fleet,
        now: () => s.clock.now,
      });
      await next.takeover();
      await tick(next);
      expect(s.fleet.passCloses).toEqual([]);
      expect(next.task(old.id)?.state).toBe("superseded");
    });
  });
});

describe("the automatic quota trigger", () => {
  const AUTO = { autonomy: "auto" } as const;
  const RETRY_MS = 5 * 60_000;
  const refused = (code: "dirty_worktree" | "branch_mismatch" | "internal_error" | "default_branch") =>
    ({ ok: false, code, message: "no" }) as const;

  /** `a`, where the task starts (ties go to the first id), and `b` on another account to carry on. */
  const twoMachines = (): ReturnType<typeof machine>[] => [
    machine("a", { capabilities: CAPABLE }),
    machine("b", { capabilities: CAPABLE }),
  ];

  /** `a`'s account reads `fields` (full by default): the newest reading, from a fresh status. */
  function exhaust(s: Setup, fields: Partial<QuotaObservation> = {}, deviceId = "a"): void {
    s.fleet.fleet = s.fleet.fleet.map((m) =>
      m.deviceId === deviceId ? { ...m, status: status({ quota: [obs(0, { h: 100, ...fields })] }) } : m,
    );
  }

  /** Time passes: the machines keep reporting, as a connected fleet does. */
  function later(s: Setup, ms: number): void {
    s.clock.now += ms;
    s.fleet.beat(s.clock.now);
  }

  async function until(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 2_000 && !condition(); i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polling a condition
      await Bun.sleep(1);
    }
    if (!condition()) throw new Error("condition never held");
  }

  function stampOf(s: Setup, id = "old"): Task["quotaExhausted"] {
    return s.scheduler.task(id)?.quotaExhausted;
  }

  test("an auto task is passed, its successor counted from the reading and kept off the old account", async () => {
    const s = setup(twoMachines());
    await running(s, true, AUTO);
    exhaust(s);
    await tick(s.scheduler);

    const old = s.scheduler.task("old");
    expect(old).toMatchObject({ state: "superseded" });
    expect(s.fleet.despawns).toHaveLength(1);
    expect(s.alerts).toEqual([]);
    const successor = s.scheduler.task(old?.successor ?? "");
    expect(successor?.spec.succeeds).toMatchObject({
      task: "old",
      account: "org:a",
      trigger: "quota",
      since: (NOW / 1000 - 60) * 1000,
    });
    // The successor placed on the other account, and the old one was refused for being the old one.
    expect(successor).toMatchObject({ state: "running", assignment: { deviceId: "b" } });
    expect(successor?.decision?.candidates.find((c) => c.deviceId === "a")?.rejected).toContainEqual({
      code: "predecessor_account",
    });
    expect(s.lines).toContain(`audit pass task="old" successor="${successor?.id}" trigger=quota`);
    expect(s.lines).toContain(`successor placed task="${successor?.id}" after=60000 from=since`);

    await tick(s.scheduler);
    expect(s.creates).toHaveLength(1);
  });

  test("a manual pass is still counted from the successor's creation", async () => {
    const s = setup();
    const old = await running(s, false);
    const result = ok(await s.scheduler.pass(old.id));
    await tick(s.scheduler);
    expect(s.lines.some((l) => l.startsWith(`successor placed task="${result.successorId}"`))).toBe(true);
    expect(s.lines.some((l) => l.endsWith("from=created"))).toBe(true);
  });

  test("a task that is not auto is alerted once, the stamp lives on its record, and a new term repeats nothing", async () => {
    const s = setup(twoMachines());
    await running(s, true, { autonomy: "checkpoint" });
    exhaust(s);
    await tick(s.scheduler);
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({ kind: "quota-exhausted", taskId: "old", window: "5h" });
    expect(s.alerts[0]).not.toHaveProperty("reason");
    expect(s.creates).toEqual([]);
    expect(stampOf(s)).toMatchObject({ accountId: "org:a", window: "5h", reset: 0, at: NOW });

    await tick(s.scheduler);
    const next = s.another();
    await next.load();
    await tick(next);
    expect(s.alerts).toHaveLength(1);
    expect(next.task("old")?.state).toBe("running");
  });

  test("a steer task is alerted, not passed", async () => {
    const s = setup(twoMachines());
    await running(s, true, { autonomy: "steer", plan: true });
    exhaust(s);
    await tick(s.scheduler);
    expect(s.alerts.map((a) => a.kind)).toEqual(["quota-exhausted"]);
    expect(s.creates).toEqual([]);
  });

  test("a forecast never acts: over the line but not full, spill or not", async () => {
    const s = setup(twoMachines());
    await running(s, true, AUTO);
    exhaust(s, { h: 95 });
    await tick(s.scheduler);
    s.fleet.fleet = s.fleet.fleet.map((m) =>
      m.deviceId === "a" ? { ...m, exclaves: [exclave("main", "org:a", { extraUsageEnabled: true })] } : m,
    );
    await tick(s.scheduler);
    expect(s.alerts).toEqual([]);
    expect(s.creates).toEqual([]);
    expect(stampOf(s)).toBeUndefined();
  });

  test("a task run in place is left alone: it cannot be passed, so nothing is stamped or alerted", async () => {
    const s = setup(twoMachines());
    await running(s, false, { mode: "here", autonomy: "auto" });
    exhaust(s);
    await tick(s.scheduler);
    expect(s.alerts).toEqual([]);
    expect(s.creates).toEqual([]);
    expect(stampOf(s)).toBeUndefined();
  });

  test("an auto task with no other account to land on is alerted instead, never stranded", async () => {
    const s = setup([machine("a", { capabilities: CAPABLE })]);
    await running(s, true, AUTO);
    exhaust(s);
    await tick(s.scheduler);
    expect(s.creates).toEqual([]);
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({ kind: "quota-exhausted", taskId: "old" });
    expect(s.scheduler.task("old")?.state).toBe("running");
  });

  test("a task on a machine that cannot push for a successor is left alone, and acts once it can", async () => {
    const s = setup([
      machine("a", { capabilities: [CAPABILITIES.metrics, CAPABILITIES.taskId] }),
      machine("b", { capabilities: CAPABLE }),
    ]);
    await running(s, true, AUTO);
    exhaust(s);
    await tick(s.scheduler);
    expect(s.alerts).toEqual([]);
    expect(s.fleet.pushes).toEqual([]);
    expect(stampOf(s)).toBeUndefined();

    s.fleet.fleet = s.fleet.fleet.map((m) => (m.deviceId === "a" ? { ...m, capabilities: CAPABLE } : m));
    await tick(s.scheduler);
    expect(s.scheduler.task("old")?.state).toBe("superseded");
  });

  test("a task waiting on a person is never moved, and is looked at again once it runs", async () => {
    const s = setup(twoMachines());
    await running(s, true, AUTO);
    await s.scheduler.onSession("old", "needs-input", { deviceId: "a", pane: "%1" });
    exhaust(s);
    await tick(s.scheduler);
    expect(s.fleet.pushes).toEqual([]);
    expect(s.alerts).toEqual([]);
    expect(stampOf(s)).toBeUndefined();

    await s.scheduler.onSession("old", "busy", { deviceId: "a", pane: "%1" });
    await tick(s.scheduler);
    expect(s.scheduler.task("old")?.state).toBe("superseded");
  });

  test("the window is stamped before the push is answered, so a new term never attempts it again", async () => {
    const s = setup(twoMachines());
    await running(s, true, AUTO);
    exhaust(s);
    const gate = Promise.withResolvers<void>();
    s.fleet.pushReply = async () => {
      await gate.promise;
      return { ok: true, remoteBranch: "feature/x", tip: TIP, pushed: true };
    };
    const ticking = s.scheduler.tick();
    await until(() => s.fleet.pushes.length === 1);
    const held = await s.store.get("old");
    expect(held?.body?.quotaExhausted).toMatchObject({ window: "5h", accountId: "org:a" });
    expect(held?.body?.quotaExhausted?.retry).toBeUndefined();

    const next = s.another();
    await next.load();
    await tick(next);
    expect(s.fleet.pushes).toHaveLength(1);

    gate.resolve();
    await ticking;
    await s.scheduler.drain();
    expect(s.scheduler.task("old")?.state).toBe("superseded");
  });

  test.each([
    ["dirty_worktree", "dirty"],
    ["branch_mismatch", "branch"],
  ] as const)("a refusal for %s is alerted with its reason and never retried", async (code, reason) => {
    const s = setup(twoMachines());
    await running(s, true, AUTO);
    exhaust(s);
    s.fleet.pushReply = () => refused(code);
    await tick(s.scheduler);
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({ kind: "quota-exhausted", taskId: "old", reason });

    later(s, 3 * RETRY_MS);
    await tick(s.scheduler);
    expect(s.fleet.pushes).toHaveLength(1);
    expect(s.alerts).toHaveLength(1);
    expect(s.scheduler.task("old")?.state).toBe("running");
  });

  test("a failed push is logged and retried once after quotaPassRetryMs; the second failure alerts, and nothing more", async () => {
    const s = setup(twoMachines());
    await running(s, true, AUTO);
    exhaust(s);
    s.fleet.pushReply = () => refused("internal_error");
    await tick(s.scheduler);
    expect(s.lines).toContain(`audit pass refused task="old" trigger=quota outcome=push_failed`);
    expect(s.alerts).toEqual([]);
    expect(stampOf(s)?.retry).toBe(true);

    await tick(s.scheduler);
    expect(s.fleet.pushes).toHaveLength(1);

    later(s, RETRY_MS);
    await tick(s.scheduler);
    expect(s.fleet.pushes).toHaveLength(2);
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({ kind: "quota-exhausted", taskId: "old", window: "5h" });
    expect(s.alerts[0]).not.toHaveProperty("reason");
    expect(stampOf(s)?.retry).toBeUndefined();

    later(s, 10 * RETRY_MS);
    await tick(s.scheduler);
    expect(s.fleet.pushes).toHaveLength(2);
    expect(s.alerts).toHaveLength(1);
  });

  test("a retry that goes through passes the task as the first attempt would have", async () => {
    const s = setup(twoMachines());
    await running(s, true, AUTO);
    exhaust(s);
    s.fleet.pushReply = () => refused("internal_error");
    await tick(s.scheduler);
    s.fleet.pushReply = () => ({ ok: true, remoteBranch: "feature/x", tip: TIP, pushed: true });
    later(s, RETRY_MS);
    await tick(s.scheduler);
    expect(s.scheduler.task("old")?.state).toBe("superseded");
    expect(s.alerts).toEqual([]);
  });

  test("a create that landed unseen is not made twice by the retry: the same successor is found and named", async () => {
    const s = setup(twoMachines());
    await running(s, true, AUTO);
    exhaust(s);
    // Nothing answers either send and the read-back sees nothing, but the first create lands afterwards.
    s.create = async (task) => {
      if (s.creates.length === 1) await s.store.put(task.id, 0, task);
      return { ok: false, code: "unreachable", unconfirmed: true };
    };
    const read = s.store.get.bind(s.store);
    let blind = true;
    s.store.get = async (id) => (id !== "old" && blind ? null : read(id));
    await tick(s.scheduler);
    expect(s.lines).toContain(`audit pass refused task="old" trigger=quota outcome=pass_failed`);
    expect(stampOf(s)?.retry).toBe(true);
    expect(s.alerts).toEqual([]);

    blind = false;
    s.create = () => ({ ok: true });
    later(s, RETRY_MS);
    await tick(s.scheduler);
    const landed = s.creates[0]?.id ?? "";
    expect(s.creates.every((task) => task.id === landed)).toBe(true);
    expect(s.scheduler.task("old")).toMatchObject({ state: "superseded", successor: landed });
    expect(s.alerts).toEqual([]);
  });

  test("a pass that loses a race to a needs-input is looked at again once the task runs", async () => {
    const s = setup(twoMachines());
    await running(s, true, AUTO);
    exhaust(s);
    let raced = false;
    s.fleet.pushReply = async () => {
      if (!raced) {
        raced = true;
        await s.scheduler.onSession("old", "needs-input", { deviceId: "a", pane: "%1" });
      }
      return { ok: true, remoteBranch: "feature/x", tip: TIP, pushed: true };
    };
    await tick(s.scheduler);
    expect(s.creates).toEqual([]);
    expect(s.scheduler.task("old")?.state).toBe("needs-input");
    expect(stampOf(s)).toBeUndefined();
    expect(s.alerts).toEqual([]);

    await s.scheduler.onSession("old", "busy", { deviceId: "a", pane: "%1" });
    await tick(s.scheduler);
    expect(s.fleet.pushes).toHaveLength(2);
    expect(s.scheduler.task("old")?.state).toBe("superseded");
  });

  test("a retry that loses a race is looked at again too, and a pass that throws is a refusal that can pass", async () => {
    const s = setup(twoMachines());
    await running(s, true, AUTO);
    exhaust(s);
    s.create = () => {
      throw new Error("store down");
    };
    await tick(s.scheduler);
    expect(s.lines).toContain(`audit pass refused task="old" trigger=quota outcome=error`);
    expect(s.errors).toHaveLength(1);
    expect(stampOf(s)?.retry).toBe(true);
    expect(s.alerts).toEqual([]);

    let raced = false;
    s.create = async () => {
      if (!raced) {
        raced = true;
        await s.scheduler.onSession("old", "needs-input", { deviceId: "a", pane: "%1" });
      }
      return { ok: true };
    };
    later(s, RETRY_MS);
    await tick(s.scheduler);
    expect(s.scheduler.task("old")?.state).toBe("needs-input");
    // The successor was created before the task moved: it is an orphan, so the window is not attempted again
    // (a second successor), and the owner is told once that the task was not passed.
    expect(stampOf(s)).toBeDefined();
    expect(s.alerts.map((a) => a.kind)).toEqual(["quota-exhausted"]);

    await s.scheduler.onSession("old", "busy", { deviceId: "a", pane: "%1" });
    await tick(s.scheduler);
    expect(s.scheduler.task("old")?.state).toBe("running");
    // The failed create, then the orphan's: no third.
    expect(s.creates).toHaveLength(2);
  });

  test.each([
    [
      "default_branch",
      (s: Setup): void => {
        s.fleet.pushReply = () => refused("default_branch");
      },
    ],
    [
      "pr_not_open",
      (s: Setup): void => {
        s.prHead = { ...OPEN, state: "closed" };
      },
    ],
  ] as const)(
    "a refusal for %s cannot pass by waiting: alerted at once as refused, never retried",
    async (_code, arrange) => {
      const s = setup(twoMachines());
      await running(s, true, AUTO);
      exhaust(s);
      arrange(s);
      await tick(s.scheduler);
      expect(s.alerts).toHaveLength(1);
      expect(s.alerts[0]).toMatchObject({ kind: "quota-exhausted", taskId: "old", reason: "refused" });
      later(s, 3 * RETRY_MS);
      await tick(s.scheduler);
      expect(s.alerts).toHaveLength(1);
      expect(s.creates).toEqual([]);
    },
  );

  test("a manual pass that arrives while an automatic one is out joins it", async () => {
    const s = setup(twoMachines());
    await running(s, true, AUTO);
    exhaust(s);
    const gate = Promise.withResolvers<void>();
    s.fleet.pushReply = async () => {
      await gate.promise;
      return { ok: true, remoteBranch: "feature/x", tip: TIP, pushed: true };
    };
    const ticking = s.scheduler.tick();
    await until(() => s.fleet.pushes.length === 1);
    const manual = s.scheduler.pass("old");
    gate.resolve();
    ok(await manual);
    await ticking;
    await s.scheduler.drain();
    expect(s.fleet.pushes).toHaveLength(1);
    expect(s.creates).toHaveLength(1);
    expect(s.lines).toContain(`pass joined task="old"`);
  });

  describe("what routing would place", () => {
    const spilling = (): ReturnType<typeof machine>[] => [
      machine("a", { capabilities: CAPABLE, exclaves: [exclave("main", "org:a", { extraUsageEnabled: true })] }),
      machine("b", { capabilities: CAPABLE }),
    ];

    test("an auto task spending credits is passed off them when the other account has room", async () => {
      const s = setup(spilling());
      await running(s, true, AUTO);
      exhaust(s);
      await tick(s.scheduler);
      expect(s.scheduler.task("old")?.state).toBe("superseded");
      expect(s.alerts).toEqual([]);
    });

    test("an auto task spilled onto a full account because the other is over the line keeps running, and is alerted once", async () => {
      const s = setup(spilling());
      exhaust(s);
      exhaust(s, { h: 95 }, "b");
      await running(s, true, AUTO);
      expect(s.scheduler.task("old")).toMatchObject({ assignment: { deviceId: "a" } });
      await tick(s.scheduler);
      await tick(s.scheduler);
      expect(s.creates).toEqual([]);
      expect(s.scheduler.task("old")?.state).toBe("running");
      // The spill alert of the dispatch is the one push: the window's full alert would be the same event.
      expect(s.alerts.map((a) => a.kind)).toEqual(["spill"]);
      expect(stampOf(s)).toMatchObject({ accountId: "org:a", window: "5h" });
    });

    test("a spilled checkpoint task gets the spill alert only, not a second push for the same event", async () => {
      const s = setup(spilling());
      exhaust(s);
      exhaust(s, { h: 95 }, "b");
      await running(s, true, { autonomy: "checkpoint" });
      await tick(s.scheduler);
      expect(s.alerts.map((a) => a.kind)).toEqual(["spill"]);
    });

    test("a successor routing could not place is not passed: the other account's seat lacks the model", async () => {
      const s = setup([
        machine("a", { capabilities: CAPABLE, exclaves: [exclave("main", "org:a", { seatTier: "team_tier_1" })] }),
        machine("b", { capabilities: CAPABLE, exclaves: [exclave("main", "org:b", { seatTier: "team_standard" })] }),
      ]);
      await running(s, true, { ...AUTO, model: "fable" });
      exhaust(s);
      await tick(s.scheduler);
      expect(s.creates).toEqual([]);
      expect(s.alerts.map((a) => a.kind)).toEqual(["quota-exhausted"]);
    });

    test("a successor routing could not place is not passed: the other account's login is gone", async () => {
      const s = setup(twoMachines());
      await running(s, true, AUTO);
      s.fleet.fleet = s.fleet.fleet.map((m) =>
        m.deviceId === "b" ? { ...m, exclaves: [exclave("main", "org:b", { authOk: false })] } : m,
      );
      exhaust(s);
      await tick(s.scheduler);
      expect(s.creates).toEqual([]);
      expect(s.alerts.map((a) => a.kind)).toEqual(["quota-exhausted"]);
    });

    test("another exclave on the same account is no room, and an offline other account is none either", async () => {
      const s = setup([
        machine("a", {
          capabilities: CAPABLE,
          exclaves: [exclave("main", "org:a"), exclave("alt", "org:a")],
          repos: [clone("app", "main"), clone("app2", "alt")],
          status: status({ quota: [obs(0), obs(1)] }),
        }),
        machine("b", { capabilities: CAPABLE, connected: false }),
      ]);
      await running(s, true, AUTO);
      exhaust(s);
      await tick(s.scheduler);
      expect(s.creates).toEqual([]);
      expect(s.alerts.map((a) => a.kind)).toEqual(["quota-exhausted"]);
    });

    test("a retry that comes due while the other account has gone is alerted, not dropped", async () => {
      const s = setup(twoMachines());
      await running(s, true, AUTO);
      exhaust(s);
      s.fleet.pushReply = () => refused("internal_error");
      await tick(s.scheduler);
      expect(stampOf(s)?.retry).toBe(true);

      s.fleet.fleet = s.fleet.fleet.map((m) => (m.deviceId === "b" ? { ...m, connected: false } : m));
      later(s, RETRY_MS);
      await tick(s.scheduler);
      expect(s.alerts.map((a) => a.kind)).toEqual(["quota-exhausted"]);
      expect(stampOf(s)?.retry).toBeUndefined();
      await tick(s.scheduler);
      expect(s.alerts).toHaveLength(1);
    });

    test("a skill the prompt names and the other account lacks is no room: the successor carries the prompt", async () => {
      const s = setup([
        machine("a", { capabilities: CAPABLE, exclaves: [exclave("main", "org:a", { skills: ["ship"] })] }),
        machine("b", { capabilities: CAPABLE }),
      ]);
      await running(s, true, { ...AUTO, prompt: "/ship PEN-123" });
      exhaust(s);
      await tick(s.scheduler);
      expect(s.creates).toEqual([]);
      expect(s.scheduler.task("old")?.state).toBe("running");
      expect(s.alerts.map((a) => a.kind)).toEqual(["quota-exhausted"]);
    });

    test("an auto task alerted for lack of room is passed once routing has room, with no second alert", async () => {
      const s = setup(twoMachines());
      await running(s, true, AUTO);
      exhaust(s);
      exhaust(s, { h: 95 }, "b");
      await tick(s.scheduler);
      expect(s.alerts.map((a) => a.kind)).toEqual(["quota-exhausted"]);
      expect(stampOf(s)?.waiting).toBe(true);

      later(s, 60_000);
      await tick(s.scheduler);
      expect(s.scheduler.task("old")?.state).toBe("running");
      expect(s.alerts).toHaveLength(1);

      exhaust(s, { h: 10 }, "b");
      later(s, 60_000);
      await tick(s.scheduler);
      expect(s.scheduler.task("old")?.state).toBe("superseded");
      expect(s.creates).toHaveLength(1);
      expect(s.alerts).toHaveLength(1);
    });

    test("two auto tasks filling at once are not passed into one slot while a pass is still pushing", async () => {
      const s = setup(twoMachines());
      await running(s, false, AUTO);
      const second: Task = { id: "old2", spec: spec(AUTO), state: "queued", createdAt: NOW };
      await s.store.put(second.id, 0, second);
      await s.scheduler.refresh(second.id);
      await tick(s.scheduler);
      expect(s.scheduler.task("old2")?.state).toBe("running");
      exhaust(s);
      const gate = Promise.withResolvers<void>();
      s.fleet.pushReply = async () => {
        await gate.promise;
        return { ok: true, remoteBranch: "feature/x", tip: TIP, pushed: true };
      };
      const ticking = s.scheduler.tick();
      await until(() => s.fleet.pushes.length === 1);
      await s.scheduler.tick();
      expect(s.fleet.pushes).toHaveLength(1);
      gate.resolve();
      await ticking;
      await s.scheduler.drain();
      expect(s.creates.length).toBeGreaterThanOrEqual(1);
    });
  });

  test("a window whose reading gains a reset after the stamp is the same window", async () => {
    const s = setup([machine("a", { capabilities: CAPABLE })]);
    await running(s, true, AUTO);
    exhaust(s);
    await tick(s.scheduler);
    expect(s.alerts).toHaveLength(1);
    exhaust(s, { hr: NOW / 1000 + 3600 });
    later(s, 30_000);
    await tick(s.scheduler);
    expect(s.alerts).toHaveLength(1);
  });

  describe("a session's own refused pass", () => {
    const self = (from = "a") => ({ from, pushed: PUSHED });

    test("is alerted once per task, with nothing but the task", async () => {
      const s = setup();
      const old = await running(s, false);
      expect(await s.scheduler.pass(old.id, "session", self())).toEqual({ ok: false, code: "successor_unsupported" });
      expect(s.alerts).toEqual([
        {
          kind: "pass-refused",
          taskId: "old",
          code: "successor_unsupported",
          message: `pass refused: task="old" outcome=successor_unsupported`,
        },
      ]);
      await s.scheduler.pass(old.id, "session", self());
      expect(s.alerts).toHaveLength(1);
    });

    test("is not alerted when it lost a race or came from another machine", async () => {
      const s = setup([machine("a", { capabilities: [...CAPABLE, CAPABILITIES.successorSelf] }), machine("b")]);
      const old = await running(s, false);
      await s.scheduler.pass(old.id, "session", self("b"));
      expect(s.alerts).toEqual([]);
    });
  });
});
