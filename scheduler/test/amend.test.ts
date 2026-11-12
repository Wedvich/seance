import { describe, expect, test } from "bun:test";
import { CAPABILITIES, promptBasis, type AmendRequest } from "@seance/shared";
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
