import { describe, expect, test } from "bun:test";
import { importPsk, sealAtRest, toBase64 } from "./crypto.ts";
import { openTaskRecord, sealTaskRecord, taskKey } from "./task-record.ts";
import { APP_ID, SCHEDULER_ID, type Task, type TaskRecord } from "./types.ts";

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

  test("a body that opens but is no task record is malformed", async () => {
    const id = crypto.randomUUID();
    const env = await sealAtRest(key, { to: SCHEDULER_ID, from: APP_ID }, "task", { version: 1, task: { id } });
    expect(await openTaskRecord(key, { key: taskKey(id), version: 1, env }, NOW)).toBe("malformed");
  });
});
