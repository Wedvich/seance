import { describe, expect, test } from "bun:test";
import { importPsk, openAtRest, sealAtRest, toBase64 } from "./crypto.ts";
import { openTaskListing, openTaskRecord, queuedTask, sealTaskRecord, taskKey } from "./task-record.ts";
import {
  APP_ID,
  AT_REST_OPS,
  BATCH_STRATEGY,
  PIN_SENTINEL,
  SCHEDULER_ID,
  TASK_SPEC_LIMITS,
  type Task,
  type TaskRecord,
} from "./types.ts";

const key = await importPsk(toBase64(new Uint8Array(32).fill(7)));
const otherKey = await importPsk(toBase64(new Uint8Array(32).fill(9)));

const NOW = 1_760_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function queued(id: string = crypto.randomUUID()): Task {
  return { id, state: "queued", createdAt: NOW, spec: { repo: "git@github.com:m/seance.git", mode: "worktree" } };
}

describe("task records at rest", () => {
  test("a record sealed days before it is read opens and binds: no replay guard sees it", async () => {
    const task = queued();
    const record: TaskRecord = { version: 1, task };
    const env = await sealTaskRecord(key, APP_ID, record);
    expect(env.to).toBe(SCHEDULER_ID);
    expect(env.from).toBe(APP_ID);
    expect(await openTaskRecord(key, { key: taskKey(task.id), version: 1, env }, NOW + 20 * DAY_MS)).toEqual(record);
  });

  test("a record an older writer sealed with a sequential or parallel batch strategy opens as a plain group", async () => {
    for (const strategy of [{ mode: "sequential" }, { mode: "parallel", max: 2 }]) {
      const task = queued();
      // Raw, as the older writer's sealer emitted it: this build's types cannot carry the old strategy.
      const raw = {
        version: 1,
        task: { ...task, spec: { ...task.spec, batch: { id: crypto.randomUUID(), index: 1, strategy } } },
      };
      const env = await sealAtRest(key, { to: SCHEDULER_ID, from: APP_ID }, AT_REST_OPS.task, raw);
      const read = await openTaskRecord(key, { key: taskKey(task.id), version: 1, env }, NOW);
      if (typeof read === "string") throw new Error(`unreadable: ${read}`);
      expect(read.task.spec.batch).toEqual({ id: raw.task.spec.batch.id, index: 1, strategy: BATCH_STRATEGY });
    }
  });

  test("another key, another op or another addressee is unopenable", async () => {
    const task = queued();
    const stored = { key: taskKey(task.id), version: 1 };
    const foreign = await sealTaskRecord(otherKey, APP_ID, { version: 1, task });
    // Authentic bytes of another kind: a `status` beat holding a task-shaped body.
    const wrongOp = await sealAtRest(key, { to: SCHEDULER_ID, from: APP_ID }, "status", { version: 1, task });
    const toApp = await sealAtRest(key, { to: APP_ID, from: APP_ID }, "task", { version: 1, task });
    for (const env of [foreign, wrongOp, toApp]) {
      expect(await openTaskRecord(key, { ...stored, env }, NOW)).toBe("unopenable");
    }
  });

  test("an authentic blob put back at another version or under another key is refused by the binding", async () => {
    const task = queued();
    const original = await sealTaskRecord(key, APP_ID, { version: 1, task });
    // Rollback: the version-1 blob put back after the leader moved the task to version 3.
    expect(await openTaskRecord(key, { key: taskKey(task.id), version: 3, env: original }, NOW)).toBe(
      "version_mismatch",
    );
    // Re-filed: the same blob created under a fresh key, to run the task twice.
    expect(await openTaskRecord(key, { key: taskKey(crypto.randomUUID()), version: 1, env: original }, NOW)).toBe(
      "key_mismatch",
    );
    const running = await sealTaskRecord(key, SCHEDULER_ID, { version: 1, task: { ...task, state: "running" } });
    expect(await openTaskRecord(key, { key: taskKey(task.id), version: 1, env: running }, NOW)).toBe(
      "created_unqueued",
    );
  });

  test("an account pin or an avoid list is sealed with the sentinel an older leader refuses; the rest without", async () => {
    const at = (value: unknown, name: string): unknown =>
      typeof value === "object" && value !== null ? Object.entries(value).find(([k]) => k === name)?.[1] : undefined;
    // What every leader before `pinAccount` ran on a spec's pin, copied from the previous release's shared/src/parse.ts (e0e3b56):
    // `isPlacementField` (650-652), `parsePin` (660-666), and the `pinned === null` arm of `parseTaskSpec` (717).
    const olderIsPlacementField = (value: unknown): boolean =>
      typeof value === "string" && value.length <= TASK_SPEC_LIMITS.placement && value !== "";
    const olderParsePin = (value: unknown): object | null => {
      if (typeof value !== "object" || value === null) return null;
      const deviceId = at(value, "deviceId");
      const exclave = at(value, "exclave");
      if (deviceId !== undefined && typeof deviceId !== "string") return null;
      if (exclave !== undefined && !olderIsPlacementField(exclave)) return null;
      return { ...(deviceId === undefined ? {} : { deviceId }), ...(exclave === undefined ? {} : { exclave }) };
    };
    // parsePin null makes parseTaskSpec null: the whole record is unreadable to that leader.
    const olderPinParses = (pin: unknown): boolean => olderParsePin(pin) !== null;
    const sealedPin = async (spec: Task["spec"]): Promise<unknown> => {
      const task = { ...queued(), spec };
      const env = await sealTaskRecord(key, APP_ID, { version: 1, task });
      // Reopened through this build's reader, the spec is the one sealed: the sentinel never reaches it.
      expect(await openTaskRecord(key, { key: taskKey(task.id), version: 1, env }, NOW)).toEqual({ version: 1, task });
      const { payload } = await openAtRest(key, env, "task");
      return at(at(at(payload, "task"), "spec"), "pin");
    };
    const base = queued().spec;
    for (const spec of [
      { ...base, pin: { account: "org:acct" } },
      { ...base, avoid: ["dev-b"] },
      { ...base, pin: { deviceId: "dev-a" }, avoid: ["dev-b"] },
    ]) {
      const pin = await sealedPin(spec);
      expect(pin).toMatchObject({ exclave: PIN_SENTINEL });
      expect(olderPinParses(pin)).toBe(false);
    }
    // Nothing an older leader can keep is sealed differently than before.
    expect(await sealedPin(base)).toBeUndefined();
    expect(await sealedPin({ ...base, pin: { deviceId: "dev-a" } })).toEqual({ deviceId: "dev-a" });
  });

  test("a continuation keeps its mode and link through seal and open; the link without the mode is unreadable", async () => {
    const at = { deviceId: "dev-a", exclave: "default", clone: "app" };
    const base = queued();
    const task: Task = { ...base, spec: { ...base.spec, mode: "continue", continues: { task: "t-old", at } } };
    const read = async (t: Task): Promise<unknown> => {
      const env = await sealTaskRecord(key, APP_ID, { version: 1, task: t });
      return openTaskRecord(key, { key: taskKey(t.id), version: 1, env }, NOW);
    };
    expect(await read(task)).toEqual({ version: 1, task });
    // What an older leader's parse would have left: the field it cannot know is dropped with the mode refused,
    // so the pair never reads half-way here either.
    expect(await read({ ...task, spec: { ...task.spec, mode: "worktree" } })).toBe("malformed");
  });

  test("a body that opens but is no task record is malformed", async () => {
    const id = crypto.randomUUID();
    const env = await sealAtRest(key, { to: SCHEDULER_ID, from: APP_ID }, "task", { version: 1, task: { id } });
    expect(await openTaskRecord(key, { key: taskKey(id), version: 1, env }, NOW)).toBe("malformed");
  });
});

describe("a task listing", () => {
  test("reports a key outside task: and every copy of a repeated key; the rest open", async () => {
    const good = queued();
    const twice = queued();
    const outside = queued();
    const env = (task: Task) => sealTaskRecord(key, APP_ID, { version: 1, task });
    const copy = { key: taskKey(twice.id), version: 1, env: await env(twice) };
    const records = [
      { key: taskKey(good.id), version: 1, env: await env(good) },
      copy,
      { ...copy, env: await env(twice) },
      { key: `queue:${outside.id}`, version: 1, env: await env(outside) },
    ];
    const { tasks, unreadable } = await openTaskListing(key, records, NOW);
    expect(tasks).toEqual([{ version: 1, task: good }]);
    expect(unreadable.map((u) => [u.key, u.reason])).toEqual([
      [taskKey(twice.id), "key_mismatch"],
      [taskKey(twice.id), "key_mismatch"],
      [`queue:${outside.id}`, "key_mismatch"],
    ]);
  });
});

describe("queuedTask", () => {
  test("is a version-1 queued task that binds, with a minted id unless one is given", async () => {
    const spec = { repo: "git@github.com:m/seance.git", mode: "worktree" } as const;
    const task = queuedTask(spec, NOW);
    expect(task).toEqual({ id: task.id, spec, state: "queued", createdAt: NOW });
    expect(queuedTask(spec, NOW).id).not.toBe(task.id);
    const env = await sealTaskRecord(key, APP_ID, { version: 1, task });
    expect(await openTaskRecord(key, { key: taskKey(task.id), version: 1, env }, NOW)).toEqual({ version: 1, task });
    expect(queuedTask(spec, NOW, "fixed").id).toBe("fixed");
  });
});
