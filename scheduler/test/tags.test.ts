import { describe, expect, test } from "bun:test";
import { CAPABILITIES } from "@seance/shared";
import { chainOwnerTags } from "../src/chain-tags.ts";
import { DEFAULT_CONFIG, MemoryQueueStore, Scheduler, type StoredTask, type Task } from "../src/index.ts";
import { enqueue, FakeFleet, machine, NOW, readerChecked, spec } from "./fixtures.ts";

/** Task tags (docs/tags.md §5): the owner's amend in any state, the reserve that ignores them, and the dispatch's ref. */

const TAGGING = [CAPABILITIES.metrics, CAPABILITIES.taskId, CAPABILITIES.taskTags];

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

async function stored(store: MemoryQueueStore, id: string): Promise<StoredTask | undefined> {
  return (await store.list()).find((s): s is StoredTask => s.id === id && s.body !== undefined);
}

const offline = () => new FakeFleet([machine("a", { connected: false })]);

describe("amend ownerTags", () => {
  test("lands on a queued, a ready, a running and a finished task alike, writing the owner's keys and nothing else", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    const ready = await enqueue(store, scheduler, spec({ tags: { "creator.ref": "linear:ENG-1" } }));
    await pass(scheduler);
    const queued = await enqueue(store, scheduler, spec());
    expect(scheduler.task(ready.id)?.state).toBe("ready");
    expect(scheduler.task(queued.id)?.state).toBe("queued");
    const cancelled = await enqueue(store, scheduler, spec());
    expect(await scheduler.cancel(cancelled.id)).toMatchObject({ ok: true });

    for (const task of [ready, queued, cancelled]) {
      // oxlint-disable-next-line no-await-in-loop -- one task at a time keeps each answer readable
      const result = await scheduler.amend({ taskId: task.id, ownerTags: { label: "mine" } });
      expect(result).toMatchObject({ ok: true, task: { id: task.id, spec: { tags: { "owner.label": "mine" } } } });
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect((await stored(store, task.id))?.body.spec.tags).toMatchObject({ "owner.label": "mine" });
    }
    // The creator's tag is the owner's amend's to leave alone.
    expect(scheduler.task(ready.id)?.spec.tags).toEqual({ "creator.ref": "linear:ENG-1", "owner.label": "mine" });
    expect(scheduler.task(cancelled.id)?.state).toBe("cancelled");

    const placed = setup();
    const running = await enqueue(placed.store, placed.scheduler, spec());
    await pass(placed.scheduler);
    expect(placed.scheduler.task(running.id)?.state).toBe("running");
    const decision = placed.scheduler.task(running.id)?.decision;
    expect(decision).toBeDefined();
    expect(await placed.scheduler.amend({ taskId: running.id, ownerTags: { label: "mine" } })).toMatchObject({
      ok: true,
      task: { id: running.id, state: "running", spec: { tags: { "owner.label": "mine" } } },
    });
    // Nothing the leader routed on moved: the decision stays, and no second spawn went out.
    expect(placed.scheduler.task(running.id)?.decision).toEqual(decision);
    expect(placed.fleet.spawns).toHaveLength(1);
  });

  test("an empty string clears a key, an unknown task is not_found, and a no-op writes nothing", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    expect(await scheduler.amend({ taskId: "nobody", ownerTags: { label: "x" } })).toEqual({
      ok: false,
      code: "not_found",
    });
    const task = await enqueue(
      store,
      scheduler,
      spec({ tags: { "owner.label": "mine", "creator.ref": "linear:ENG-1" } }),
    );
    const before = await stored(store, task.id);
    expect(await scheduler.amend({ taskId: task.id, ownerTags: { label: "mine" } })).toMatchObject({ ok: true });
    expect(await stored(store, task.id)).toEqual(before);
    const cleared = await scheduler.amend({ taskId: task.id, ownerTags: { label: "" } });
    expect(cleared).toMatchObject({ ok: true, task: { spec: { tags: { "creator.ref": "linear:ENG-1" } } } });
    expect((await stored(store, task.id))?.body.spec.tags).toEqual({ "creator.ref": "linear:ENG-1" });
  });

  test("beside another field it meets that field's rules: a running task is placed, and nothing is written", async () => {
    const { store, scheduler } = setup();
    const task = await enqueue(store, scheduler, spec());
    await pass(scheduler);
    expect(scheduler.task(task.id)?.state).toBe("running");
    const before = await stored(store, task.id);
    expect(await scheduler.amend({ taskId: task.id, title: "x", ownerTags: { label: "mine" } })).toEqual({
      ok: false,
      code: "placed",
    });
    expect(await stored(store, task.id)).toEqual(before);
  });

  test("a third owner key is tags_full, and nothing is written", async () => {
    const { store, scheduler } = setup(new MemoryQueueStore(), offline());
    const task = await enqueue(store, scheduler, spec({ tags: { "owner.a": "1", "owner.b": "2" } }));
    const before = await stored(store, task.id);
    expect(await scheduler.amend({ taskId: task.id, ownerTags: { c: "3" } })).toEqual({
      ok: false,
      code: "tags_full",
    });
    expect(await stored(store, task.id)).toEqual(before);
    expect(await scheduler.amend({ taskId: task.id, ownerTags: { a: "9" } })).toMatchObject({ ok: true });
  });
});

describe("a reserve routed before a label was set", () => {
  test("still reserves: tags never route, so the spec compare ignores them", async () => {
    /** Holds the label's write, so the pass routes `x` on the spec it is replacing and its reserve queues behind it. */
    class Gated extends MemoryQueueStore {
      readonly held = Promise.withResolvers<void>();
      reached = false;
      override async put(id: string, version: number, body: Task): ReturnType<MemoryQueueStore["put"]> {
        if (body.spec.tags?.["owner.label"] === "gated" && body.state === "ready") {
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

    const labelling = scheduler.amend({ taskId: "x", ownerTags: { label: "gated" } });
    for (let turn = 0; turn < 200 && !store.reached; turn += 1) {
      // oxlint-disable-next-line no-await-in-loop -- a poll
      await Bun.sleep(1);
    }
    expect(store.reached).toBe(true);
    const ticking = scheduler.tick();
    // The pass routes `x` untagged and its reservation waits behind the label's write.
    await Bun.sleep(10);
    store.held.resolve();
    expect((await labelling).ok).toBe(true);
    await ticking;
    await scheduler.drain();

    expect(fleet.spawns).toHaveLength(1);
    expect(scheduler.task("x")).toMatchObject({ state: "running", spec: { tags: { "owner.label": "gated" } } });
  });
});

describe("the dispatch's ref", () => {
  const refUrl = "https://linear.app/x/issue/ENG-1";

  test("goes only to a daemon advertising taskTags, as the creator's ref and its URL", async () => {
    const tagged = setup(new MemoryQueueStore(), new FakeFleet([machine("a", { capabilities: TAGGING })]));
    await enqueue(
      tagged.store,
      tagged.scheduler,
      spec({ tags: { "creator.ref": "linear:ENG-1", "creator.ref-url": refUrl } }),
    );
    await pass(tagged.scheduler);
    expect(tagged.fleet.spawns[0]?.request.ref).toEqual({ ref: "linear:ENG-1", url: refUrl });

    const older = setup();
    await enqueue(older.store, older.scheduler, spec({ tags: { "creator.ref": "linear:ENG-1" } }));
    await pass(older.scheduler);
    expect(older.fleet.spawns).toHaveLength(1);
    expect(older.fleet.spawns[0]?.request).not.toHaveProperty("ref");
  });

  test("a legacy `linear` task and a task with no ref carry none, and an owner ref is never sent", async () => {
    const s = setup(new MemoryQueueStore(), new FakeFleet([machine("a", { capabilities: TAGGING })]));
    await enqueue(s.store, s.scheduler, spec({ linear: { issue: "ENG-1", url: refUrl } }));
    await enqueue(s.store, s.scheduler, spec({ tags: { "owner.ref": "linear:ENG-2", "owner.label": "mine" } }));
    await enqueue(s.store, s.scheduler, spec());
    await pass(s.scheduler);
    expect(s.fleet.spawns).toHaveLength(3);
    for (const sent of s.fleet.spawns) expect(sent.request).not.toHaveProperty("ref");
  });
});

describe("chainOwnerTags", () => {
  const at = { deviceId: "a", exclave: "main", clone: "app" };
  const task = (id: string, taskSpec: Task["spec"]): Task => ({ id, spec: taskSpec, state: "queued", createdAt: NOW });
  const old = task("old", spec({ tags: { "creator.ref": "linear:ENG-1", "owner.label": "mine", "scheduler.x": "1" } }));
  const tasks = new Map([[old.id, old]]);

  test("copies the owner's keys alone, for a continuation and a successor", () => {
    const continuation = task(
      "c",
      spec({ mode: "continue", continues: { task: "old", at }, tags: { "creator.ref": "linear:ENG-1" } }),
    );
    expect(chainOwnerTags(continuation, tasks)?.tags).toEqual({ "creator.ref": "linear:ENG-1", "owner.label": "mine" });
    const successor = task("s", spec({ succeeds: { task: "old", account: "org:a", trigger: "manual", at } }));
    expect(chainOwnerTags(successor, tasks)?.tags).toEqual({ "owner.label": "mine" });
  });

  test("copies nothing with no predecessor, a pruned one, none of the owner's, or an owner's word already there", () => {
    expect(chainOwnerTags(task("p", spec()), tasks)).toBeNull();
    const pruned = task("c", spec({ mode: "continue", continues: { task: "gone", at } }));
    expect(chainOwnerTags(pruned, tasks)).toBeNull();
    const bare = new Map([["old", task("old", spec({ tags: { "creator.ref": "linear:ENG-1" } }))]]);
    const successor = task("s", spec({ succeeds: { task: "old", account: "org:a", trigger: "manual", at } }));
    expect(chainOwnerTags(successor, bare)).toBeNull();
    const labelled = task(
      "s",
      spec({ succeeds: { task: "old", account: "org:a", trigger: "manual", at }, tags: { "owner.label": "yours" } }),
    );
    expect(chainOwnerTags(labelled, tasks)).toBeNull();
  });
});
