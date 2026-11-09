import { describe, expect, test } from "bun:test";
import { RequestFailure, type StoreRefusal, type Task, type TaskCreated, type TaskRequest } from "@seance/shared";
import { enqueue, leaderWait, schedulerLine, taskFor } from "./queue.ts";

const request: TaskRequest = { repo: "github.com/me/seance", mode: "worktree", model: "opus", effort: "medium" };

/** The relay's store is the external boundary; each fake answers one way. */
type Create = (task: Task) => Promise<TaskCreated | StoreRefusal | null>;
const answering =
  (reply: TaskCreated | StoreRefusal | null): Create =>
  async () =>
    reply;
const throwing =
  (err: Error): Create =>
  async () => {
    throw err;
  };

describe("taskFor", () => {
  test("mints a queued task stamped as this surface's", () => {
    const { task } = taskFor(request, null, 1_000);
    expect(task).toMatchObject({ spec: { ...request, client: "raycast" }, state: "queued", createdAt: 1_000 });
  });

  test("re-sends an unsettled task for the same form, so a create that landed cannot queue twice", () => {
    const first = taskFor(request, null, 1_000);
    expect(taskFor({ ...request }, first, 2_000)).toBe(first);
  });

  test("a changed form is a new task with a new id", () => {
    const first = taskFor(request, null, 1_000);
    const next = taskFor({ ...request, prompt: "more" }, first, 2_000);
    expect(next.task.id).not.toBe(first.task.id);
  });
});

describe("enqueue", () => {
  const { task } = taskFor(request, null, 1_000);

  test("a stored create is queued, and a repeat of one reads as having landed earlier", async () => {
    expect(await enqueue(answering({ ok: true, landedEarlier: false }), task)).toEqual({
      kind: "queued",
      landedEarlier: false,
    });
    expect(await enqueue(answering({ ok: true, landedEarlier: true }), task)).toEqual({
      kind: "queued",
      landedEarlier: true,
    });
  });

  test("a store refusal stored nothing, worded as every surface words it", async () => {
    expect(await enqueue(answering({ ok: false, code: "store_full" }), task)).toEqual({
      kind: "refused",
      message: "The queue is full; the scheduler prunes finished tasks as it runs — try again later.",
    });
  });

  test("no socket sent nothing, so it is a clean refusal", async () => {
    const outcome = await enqueue(throwing(new RequestFailure("disconnected", "no socket", "relay")), task);
    expect(outcome).toEqual({ kind: "refused", message: "Lost the relay connection before the request went out." });
  });

  test("a timeout or a drop may have landed, and says to look before retrying", async () => {
    for (const reason of ["timeout", "dropped"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- each case in turn
      const outcome = await enqueue(throwing(new RequestFailure(reason, "lost", "relay")), task);
      expect(outcome.kind).toBe("unsure");
      expect(outcome.kind === "unsure" && outcome.message).toContain("check the Queue in the app");
    }
  });

  test("an unreadable answer may have landed too", async () => {
    const outcome = await enqueue(answering(null), task);
    expect(outcome.kind).toBe("unsure");
  });
});

describe("scheduler lines", () => {
  const machines = [{ deviceId: "d1", name: "tower" }] as const;

  test("a verified leader is named, and no wait is said", () => {
    const ready = { kind: "ready", deviceId: "d1", term: 3 } as const;
    expect(leaderWait(ready)).toBeNull();
    expect(schedulerLine(ready, machines)).toBe("Led by tower");
  });

  test("no leader, or an unverified one, says the task waits rather than refusing it", () => {
    expect(leaderWait({ kind: "none" })).toContain("waits in the queue");
    expect(schedulerLine({ kind: "unverified", deviceId: "d1", term: 3 }, machines)).toContain("waits until one shows");
  });
});
