import { describe, expect, test } from "bun:test";
import {
  AGENT_DEP_SENTINEL,
  ATTACHMENTS_DEP_SENTINEL,
  CAPABILITIES,
  depsBasis,
  promptBasis,
  REQUIRES_DEP_SENTINEL,
  TAGS_DEP_SENTINEL,
  taskRecordAtRest,
  type AmendRequest,
  type TaskDep,
} from "@seance/shared";
import {
  DEFAULT_CONFIG,
  MemoryQueueStore,
  Scheduler,
  type StoredTask,
  type Task,
  type TaskSpawnReply,
} from "../src/index.ts";
import { attachment, enqueue, FakeFleet, machine, NOW, readerChecked, spec } from "./fixtures.ts";

function setup(store = new MemoryQueueStore(), fleet = new FakeFleet([machine("a")])) {
  const scheduler = new Scheduler({
    store: readerChecked(store, () => NOW),
    fleet,
    config: DEFAULT_CONFIG,
    now: () => NOW,
  });
  return { store, fleet, scheduler };
}

async function pass(scheduler: Scheduler): Promise<void> {
  await scheduler.tick();
  await scheduler.drain();
}

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

/** A prompt amendment named against the prompt `task` holds now, as `sendAmend` builds it. */
async function against(
  task: Task | undefined,
  prompt: NonNullable<AmendRequest["prompt"]>,
  rest: Partial<AmendRequest> = {},
): Promise<AmendRequest> {
  if (task === undefined) throw new Error("no such task");
  return { taskId: task.id, prompt, basis: await promptBasis(task.spec.prompt), ...rest };
}

const offline = () => new FakeFleet([machine("a", { connected: false })]);

describe("amend lands on a waiting task", () => {
  test("queued, blocked and ready each take it, in place, under the same id", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    const ready = await enqueue(store, scheduler, spec());
    const blocked = await enqueue(store, scheduler, spec({ deps: [{ task: ready.id, after: "done" }] }));
    await pass(scheduler);
    const queued = await enqueue(store, scheduler, spec());
    expect(scheduler.task(ready.id)?.state).toBe("ready");
    expect(scheduler.task(blocked.id)?.state).toBe("blocked");
    expect(scheduler.task(queued.id)?.state).toBe("queued");

    for (const task of [ready, blocked, queued]) {
      // oxlint-disable-next-line no-await-in-loop -- one task at a time keeps each answer readable
      const result = await scheduler.amend(
        await against(scheduler.task(task.id), { mode: "append", text: "also this" }, { title: "renamed" }),
      );
      expect(result).toMatchObject({
        ok: true,
        task: { id: task.id, spec: { prompt: "do it\n\nalso this", title: "renamed" } },
      });
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect((await stored(store, task.id))?.body.spec).toMatchObject({
        prompt: "do it\n\nalso this",
        title: "renamed",
      });
    }
    // The dependent still waits on the same id: its edge is untouched.
    expect(scheduler.task(blocked.id)?.spec.deps).toEqual([{ task: ready.id, after: "done" }]);
    expect(scheduler.task(blocked.id)?.state).toBe("blocked");
  });

  test("replace sets the prompt, null drops a field, and a replace with nothing drops the prompt", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    const task = await enqueue(store, scheduler, spec({ title: "t", model: "opus", effort: "high" }));
    const replaced = await scheduler.amend(
      await against(task, { mode: "replace", text: "new prompt" }, { model: null, effort: "low", title: null }),
    );
    expect(replaced.ok).toBe(true);
    const held = scheduler.task(task.id);
    expect(held?.spec.prompt).toBe("new prompt");
    expect(held?.spec.effort).toBe("low");
    expect(held?.spec).not.toHaveProperty("model");
    expect(held?.spec).not.toHaveProperty("title");

    const emptied = await scheduler.amend(await against(held, { mode: "replace", text: "" }));
    expect(emptied.ok).toBe(true);
    expect(scheduler.task(task.id)?.spec).not.toHaveProperty("prompt");
  });

  test("a no-op amendment answers the task as it stands and writes nothing", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    const task = await enqueue(store, scheduler, spec({ title: "same" }));
    const before = await stored(store, task.id);
    const result = await scheduler.amend({ taskId: task.id, title: "same" });
    expect(result).toMatchObject({ ok: true, task: { id: task.id, spec: { title: "same" } } });
    expect(await stored(store, task.id)).toEqual(before);
  });

  test("fields carrying a sentinel survive the rewrite, and every reader still opens the record", async () => {
    const fleet = new FakeFleet([
      machine("a", { connected: false, capabilities: [CAPABILITIES.attachments, CAPABILITIES.traits] }),
    ]);
    const { store, scheduler } = setup(new MemoryQueueStore(), fleet);
    const files = [attachment(1)];
    const task = await enqueue(store, scheduler, spec({ attachments: files, requires: ["atlas"] }));
    const result = await scheduler.amend(await against(task, { mode: "append", text: "more" }, { effort: "max" }));
    expect(result.ok).toBe(true);
    // `readerChecked` would have thrown on a put no reader opens.
    expect((await stored(store, task.id))?.body.spec).toMatchObject({
      attachments: files,
      requires: ["atlas"],
      prompt: "do it\n\nmore",
      effort: "max",
    });
  });
});

describe("amend notBefore", () => {
  test("setting it holds the task on the next pass; null releases it; no basis needed", async () => {
    const { store, fleet, scheduler } = setup();
    const task = await enqueue(store, scheduler, spec());
    expect(await scheduler.amend({ taskId: task.id, notBefore: NOW + 60_000 })).toMatchObject({
      ok: true,
      task: { spec: { notBefore: NOW + 60_000 } },
    });
    await pass(scheduler);
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("ready");
    expect(fleet.spawns).toEqual([]);

    const released = await scheduler.amend({ taskId: task.id, notBefore: null });
    expect(released.ok).toBe(true);
    expect(scheduler.task(task.id)?.spec).not.toHaveProperty("notBefore");
    await pass(scheduler);
    await until(() => fleet.spawns.length === 1, "the spawn");
  });
});

describe("amend refuses", () => {
  test("an unknown task, and a finished one", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    expect(await scheduler.amend({ taskId: "nobody", title: "x" })).toEqual({ ok: false, code: "not_found" });
    const task = await enqueue(store, scheduler, spec());
    expect(await scheduler.cancel(task.id)).toMatchObject({ ok: true });
    expect(await scheduler.amend({ taskId: task.id, title: "x" })).toEqual({ ok: false, code: "finished" });
  });

  test("a reserved task whose spawn is still out is dispatching; once running it is placed", async () => {
    const { store, fleet, scheduler } = setup();
    const hung = Promise.withResolvers<TaskSpawnReply>();
    fleet.scripts.set("a", () => hung.promise);
    const task = await enqueue(store, scheduler, spec());
    await scheduler.tick();
    expect(scheduler.task(task.id)?.state).toBe("reserved");
    const before = await stored(store, task.id);
    expect(await scheduler.amend({ taskId: task.id, title: "x" })).toEqual({ ok: false, code: "dispatching" });
    expect(await stored(store, task.id)).toEqual(before);

    const sent = fleet.spawns[0]?.request;
    if (sent === undefined) throw new Error("no spawn was sent");
    hung.resolve(fleet.start("a", sent));
    await scheduler.drain();
    expect(scheduler.task(task.id)?.state).toBe("running");
    expect(await scheduler.amend({ taskId: task.id, title: "x" })).toEqual({ ok: false, code: "placed" });
    expect(fleet.spawns[0]?.request.prompt).toBe("do it");
  });

  test("a basis naming another prompt is prompt_changed, and nothing is written", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    const task = await enqueue(store, scheduler, spec());
    const before = await stored(store, task.id);
    const stale = {
      taskId: task.id,
      prompt: { mode: "append", text: "x" },
      basis: await promptBasis("an older prompt"),
    } as const;
    expect(await scheduler.amend(stale)).toEqual({ ok: false, code: "prompt_changed" });
    expect(await stored(store, task.id)).toEqual(before);
  });

  test("of two amends named against one prompt, the one serialized second is prompt_changed", async () => {
    class SlowStore extends MemoryQueueStore {
      override async put(id: string, version: number, body: Task): ReturnType<MemoryQueueStore["put"]> {
        await Bun.sleep(20);
        return super.put(id, version, body);
      }
    }
    const { store, scheduler } = setup(new SlowStore(), offline());
    const task = await enqueue(store, scheduler, spec());
    const one = await against(task, { mode: "append", text: "first" });
    const two = await against(task, { mode: "append", text: "second" });
    const results = await Promise.all([scheduler.amend(one), scheduler.amend(two)]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1]).toEqual({ ok: false, code: "prompt_changed" });
    expect(scheduler.task(task.id)?.spec.prompt).toBe("do it\n\nfirst");
  });

  test("a replace on a successor is append_only; an append to it lands", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
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
    await store.put("succ", 0, successor);
    await scheduler.load();
    expect(await scheduler.amend(await against(successor, { mode: "replace", text: "mine now" }))).toEqual({
      ok: false,
      code: "append_only",
    });
    const appended = await scheduler.amend(await against(successor, { mode: "append", text: "one more thing" }));
    expect(appended.ok).toBe(true);
    expect((await stored(store, "succ"))?.body.spec).toMatchObject({
      prompt: "do it\n\none more thing",
      succeeds: { task: "pred", trigger: "manual" },
    });
  });

  test("effort max on a Codex task is agent_unsupported and writes nothing; another effort lands", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    const task = await enqueue(store, scheduler, spec({ agent: "codex", autonomy: "auto", effort: "high" }));
    const before = await stored(store, task.id);
    expect(await scheduler.amend({ taskId: task.id, effort: "max" })).toEqual({ ok: false, code: "agent_unsupported" });
    expect(await scheduler.amend(await against(task, { mode: "append", text: "more" }, { effort: "max" }))).toEqual({
      ok: false,
      code: "agent_unsupported",
    });
    expect(await stored(store, task.id)).toEqual(before);
    expect(await scheduler.amend({ taskId: task.id, effort: "xhigh" })).toMatchObject({ ok: true });
    expect((await stored(store, task.id))?.body.spec).toMatchObject({ agent: "codex", effort: "xhigh" });
  });

  test("a prompt past the cap is prompt_too_long: the create's, the smaller one beside attachments, and the store's", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    const plain = await enqueue(store, scheduler, spec());
    expect(await scheduler.amend(await against(plain, { mode: "append", text: "x".repeat(8_192) }))).toEqual({
      ok: false,
      code: "prompt_too_long",
    });
    const attached = await enqueue(store, scheduler, spec({ attachments: [attachment(1)] }));
    expect(await scheduler.amend(await against(attached, { mode: "replace", text: "x".repeat(6_145) }))).toEqual({
      ok: false,
      code: "prompt_too_long",
    });
    expect((await scheduler.amend(await against(attached, { mode: "replace", text: "x".repeat(6_144) }))).ok).toBe(
      true,
    );

    class Bounded extends MemoryQueueStore {
      override async put(id: string, version: number, body: Task): ReturnType<MemoryQueueStore["put"]> {
        if (body.spec.prompt?.includes("BIG") === true) return { ok: false, code: "too_large" };
        return super.put(id, version, body);
      }
    }
    const bounded = setup(new Bounded(), offline());
    const task = await enqueue(bounded.store, bounded.scheduler, spec());
    const before = await stored(bounded.store, task.id);
    expect(await bounded.scheduler.amend(await against(task, { mode: "append", text: "BIG" }))).toEqual({
      ok: false,
      code: "prompt_too_long",
    });
    expect(await stored(bounded.store, task.id)).toEqual(before);
    expect(bounded.scheduler.task(task.id)?.spec.prompt).toBe("do it");
  });
});

describe("amend against a reservation in flight", () => {
  test("a reserve routed on the spec an amend is replacing declines, and the next pass places the amended spec", async () => {
    /** Holds the amend's write, so the pass routes `x` on the spec it is replacing and queues behind it. */
    class Gated extends MemoryQueueStore {
      readonly held = Promise.withResolvers<void>();
      reached = false;
      override async put(id: string, version: number, body: Task): ReturnType<MemoryQueueStore["put"]> {
        if (body.spec.prompt === "amended" && body.state === "ready") {
          this.reached = true;
          await this.held.promise;
        }
        return super.put(id, version, body);
      }
    }
    const store = new Gated();
    const fleet = offline();
    const { scheduler } = setup(store, fleet);
    await enqueue(store, scheduler, spec(), "x");
    await pass(scheduler);
    expect(scheduler.task("x")?.state).toBe("ready");
    fleet.fleet = [machine("a")];

    const amending = scheduler.amend(await against(scheduler.task("x"), { mode: "replace", text: "amended" }));
    await until(() => store.reached, "the amend's write");
    const ticking = scheduler.tick();
    // The pass routes `x` on "do it" and its reservation waits behind the amend's write.
    await Bun.sleep(10);
    store.held.resolve();
    expect((await amending).ok).toBe(true);
    await ticking;
    await scheduler.drain();

    expect(scheduler.task("x")?.state).toBe("ready");
    expect(fleet.spawns).toEqual([]);

    await pass(scheduler);
    expect(scheduler.task("x")?.state).toBe("running");
    expect(fleet.spawns.map((s) => s.request.prompt)).toEqual(["amended"]);
  });
});

/** A deps amendment of `task` to `list`, named against the list it holds now, as `sendAmend` builds it. */
async function depsTo(
  task: Task | undefined,
  list: readonly TaskDep[],
  rest: Partial<AmendRequest> = {},
): Promise<AmendRequest> {
  if (task === undefined) throw new Error("no such task");
  return { taskId: task.id, deps: { list, basis: await depsBasis(task.spec.deps) }, ...rest };
}

/** Holds the first put of a record `holds` matches, until `release`. */
class HeldStore extends MemoryQueueStore {
  readonly #gate = Promise.withResolvers<void>();
  reached = false;
  /** Every id a put was made for, held or not. */
  readonly ids: string[] = [];
  constructor(readonly holds: (task: Task) => boolean) {
    super();
  }
  release(): void {
    this.#gate.resolve();
  }
  override async put(id: string, version: number, body: Task): ReturnType<MemoryQueueStore["put"]> {
    this.ids.push(id);
    if (!this.reached && this.holds(body)) {
      this.reached = true;
      await this.#gate.promise;
    }
    return super.put(id, version, body);
  }
}

describe("amend deps", () => {
  test("a ready task given an unmet edge goes back to blocked in the same write; dropping it frees it", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    const first = await enqueue(store, scheduler, spec());
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("ready");

    const added = await scheduler.amend(await depsTo(scheduler.task(task.id), [{ task: first.id, after: "merged" }]));
    expect(added).toMatchObject({ ok: true, task: { id: task.id, state: "blocked" } });
    expect((await stored(store, task.id))?.body).toMatchObject({
      state: "blocked",
      spec: { deps: [{ task: first.id, after: "merged" }] },
    });

    const dropped = await scheduler.amend(await depsTo(scheduler.task(task.id), []));
    expect(dropped).toMatchObject({ ok: true, task: { id: task.id, state: "ready" } });
    expect((await stored(store, task.id))?.body.spec).not.toHaveProperty("deps");
  });

  test("an edge to a done task is met at once; one to a superseded task follows its successor", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    const finished = await enqueue(store, scheduler, spec());
    expect(await scheduler.markDone(finished.id)).toMatchObject({ ok: true });
    await store.put("old", 0, { id: "old", spec: spec(), state: "superseded", createdAt: NOW, successor: "new" });
    await scheduler.refresh("old");
    await enqueue(store, scheduler, spec(), "new");
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);

    const done = await scheduler.amend(await depsTo(scheduler.task(task.id), [{ task: finished.id, after: "merged" }]));
    expect(done).toMatchObject({ ok: true, task: { state: "ready" } });
    // `new` holds the work and has not finished, so the edge is unmet rather than failed.
    const chained = await scheduler.amend(await depsTo(scheduler.task(task.id), [{ task: "old", after: "done" }]));
    expect(chained).toMatchObject({ ok: true, task: { state: "blocked" } });
  });

  test("a queued task stays queued for admission, and the list keeps the order given", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    const a = await enqueue(store, scheduler, spec());
    const b = await enqueue(store, scheduler, spec());
    const c = await enqueue(store, scheduler, spec());
    const task = await enqueue(store, scheduler, spec());
    const list: TaskDep[] = [
      { task: c.id, after: "opened" },
      { task: a.id, after: "done" },
      { task: b.id, after: "merged" },
    ];
    const result = await scheduler.amend(await depsTo(task, list));
    expect(result).toMatchObject({ ok: true, task: { state: "queued", spec: { deps: list } } });
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("blocked");
  });

  test("a blocked task whose every edge is met after the amend goes to ready", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    const waiting = await enqueue(store, scheduler, spec());
    const finished = await enqueue(store, scheduler, spec());
    expect(await scheduler.markDone(finished.id)).toMatchObject({ ok: true });
    const task = await enqueue(store, scheduler, spec({ deps: [{ task: waiting.id, after: "done" }] }));
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("blocked");
    const swapped = await scheduler.amend(
      await depsTo(scheduler.task(task.id), [{ task: finished.id, after: "done" }]),
    );
    expect(swapped).toMatchObject({ ok: true, task: { state: "ready" } });
  });

  test("it rides with a prompt append in one write, and every sentinel is back on the sealed record", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    const first = await enqueue(store, scheduler, spec());
    const task = await enqueue(
      store,
      scheduler,
      spec({
        attachments: [attachment(1)],
        requires: ["atlas"],
        tags: { "creator.ref": "linear:ENG-1" },
        agent: "codex",
        autonomy: "auto",
      }),
    );
    const request = await depsTo(task, [{ task: first.id, after: "opened" }], {
      prompt: { mode: "append", text: "it now waits on the schema" },
      basis: await promptBasis(task.spec.prompt),
    });
    expect((await scheduler.amend(request)).ok).toBe(true);
    const held = await stored(store, task.id);
    if (held === undefined) throw new Error("no record");
    expect(held.body.spec).toMatchObject({
      prompt: "do it\n\nit now waits on the schema",
      deps: [{ task: first.id, after: "opened" }],
    });
    expect(taskRecordAtRest({ version: held.version, task: held.body })).toMatchObject({
      task: {
        spec: {
          deps: [
            { task: first.id, after: "opened" },
            ATTACHMENTS_DEP_SENTINEL,
            REQUIRES_DEP_SENTINEL,
            TAGS_DEP_SENTINEL,
            AGENT_DEP_SENTINEL,
          ],
        },
      },
    });
  });
});

describe("amend deps refuses, writing nothing", () => {
  test("each refusal code, checked before the write", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    const a = await enqueue(store, scheduler, spec());
    const b = await enqueue(store, scheduler, spec({ deps: [{ task: a.id, after: "done" }] }));
    const cancelled = await enqueue(store, scheduler, spec());
    expect(await scheduler.cancel(cancelled.id)).toMatchObject({ ok: true });
    store.plant("junk", "unopenable");
    await scheduler.refresh("junk");
    await store.put("succ", 0, {
      id: "succ",
      spec: spec({
        succeeds: {
          task: a.id,
          account: "org:a",
          at: { deviceId: "a", exclave: "main", clone: "app" },
          trigger: "manual",
        },
      }),
      state: "queued",
      createdAt: NOW,
    });
    await scheduler.refresh("succ");

    const before = await stored(store, a.id);
    const stale = { taskId: a.id, deps: { list: [], basis: await depsBasis([{ task: b.id, after: "done" }]) } };
    const cases: [AmendRequest, Extract<Awaited<ReturnType<Scheduler["amend"]>>, { ok: false }>["code"]][] = [
      [stale, "deps_changed"],
      [await depsTo(scheduler.task("succ"), [{ task: b.id, after: "done" }]), "deps_successor"],
      [await depsTo(a, [{ task: a.id, after: "done" }]), "dep_self"],
      [await depsTo(a, [{ task: "nobody", after: "done" }]), "dep_unknown"],
      [await depsTo(a, [{ task: "junk", after: "done" }]), "dep_unreadable"],
      [await depsTo(a, [{ task: cancelled.id, after: "done" }]), "dep_ended"],
      [await depsTo(a, [{ task: b.id, after: "done" }]), "dep_cycle"],
    ];
    for (const [request, code] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time keeps each answer readable
      expect(await scheduler.amend(request)).toEqual({ ok: false, code });
    }
    expect(await stored(store, a.id)).toEqual(before);
  });

  test("a task in the store the leader has not seen yet is read once and taken (Q1b)", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    const task = await enqueue(store, scheduler, spec());
    await store.put("fresh", 0, { id: "fresh", spec: spec(), state: "queued", createdAt: NOW });
    expect(scheduler.task("fresh")).toBeUndefined();
    const result = await scheduler.amend(await depsTo(task, [{ task: "fresh", after: "opened" }]));
    expect(result).toMatchObject({ ok: true, task: { spec: { deps: [{ task: "fresh", after: "opened" }] } } });
  });

  test("inside the write: a predecessor cancelled while the task's turn is held is dep_ended", async () => {
    const store = new HeldStore((t) => t.spec.title === "held");
    const { scheduler } = setup(store, offline());
    const pred = await enqueue(store, scheduler, spec());
    const task = await enqueue(store, scheduler, spec());
    // A title amend's write holds the task's turn, so the deps amend checks first and writes after it.
    const titled = scheduler.amend({ taskId: task.id, title: "held" });
    await until(() => store.reached, "the title's write");
    const amending = scheduler.amend(await depsTo(task, [{ task: pred.id, after: "done" }]));
    // Time for its check before the turn to pass, so the cancel lands between that check and the write. Either
    // order answers dep_ended: a slow machine only moves the refusal to the earlier check.
    await Bun.sleep(30);
    expect(await scheduler.cancel(pred.id)).toMatchObject({ ok: true });
    store.release();
    expect((await titled).ok).toBe(true);
    expect(await amending).toEqual({ ok: false, code: "dep_ended" });
    expect(scheduler.task(task.id)?.spec).not.toHaveProperty("deps");
  });

  test("two amends that would close a loop between them: one lands, the other is dep_cycle", async () => {
    // b waits on c and d on a already; a → b and c → d close a → b → c → d → a. Neither amend names the
    // task the other writes, so no per-task turn orders them: only the leader-wide one does.
    const store = new HeldStore((t) => t.id === "a" && t.spec.deps !== undefined);
    const { scheduler } = setup(store, offline());
    const a = await enqueue(store, scheduler, spec(), "a");
    const c = await enqueue(store, scheduler, spec(), "c");
    await enqueue(store, scheduler, spec({ deps: [{ task: "c", after: "done" }] }), "b");
    await enqueue(store, scheduler, spec({ deps: [{ task: "a", after: "done" }] }), "d");
    const one = scheduler.amend(await depsTo(a, [{ task: "b", after: "done" }]));
    await until(() => store.reached, "the first write");
    const writes = store.ids.length;
    const two = scheduler.amend(await depsTo(c, [{ task: "d", after: "done" }]));
    // A sleep before a negative assertion: c's amend must not reach the store while a's write is out.
    await Bun.sleep(30);
    expect(store.ids.slice(writes)).toEqual([]);
    store.release();
    expect(await one).toMatchObject({ ok: true });
    expect(await two).toEqual({ ok: false, code: "dep_cycle" });
    expect(scheduler.task("c")?.spec).not.toHaveProperty("deps");
  });

  test("a finished predecessor an amend names survives a prune while its write is out", async () => {
    const store = new HeldStore((t) => t.spec.deps !== undefined);
    const { scheduler } = setup(store, offline());
    const pred = await enqueue(store, scheduler, spec());
    expect(await scheduler.markDone(pred.id)).toMatchObject({ ok: true });
    const task = await enqueue(store, scheduler, spec());
    const amending = scheduler.amend(await depsTo(task, [{ task: pred.id, after: "done" }]));
    await until(() => store.reached, "the amend's write");
    // No record names `pred` yet: only the amend in flight does.
    await scheduler.prune(0);
    expect(await stored(store, pred.id)).toBeDefined();
    store.release();
    expect(await amending).toMatchObject({ ok: true });
  });

  test("a prune that deleted the predecessor first leaves the amend dep_unknown, never a dangling edge", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    const pred = await enqueue(store, scheduler, spec());
    expect(await scheduler.markDone(pred.id)).toMatchObject({ ok: true });
    const task = await enqueue(store, scheduler, spec());
    await scheduler.prune(0);
    expect(await stored(store, pred.id)).toBeUndefined();
    expect(await scheduler.amend(await depsTo(task, [{ task: pred.id, after: "done" }]))).toEqual({
      ok: false,
      code: "dep_unknown",
    });
  });
});
