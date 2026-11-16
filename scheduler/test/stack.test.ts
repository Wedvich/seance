import { describe, expect, test } from "bun:test";
import type { Machine, SpawnErrorCode, TaskDep } from "@seance/shared";
import { DEFAULT_CONFIG, MemoryQueueStore, Scheduler, SCHEDULER_CLIENT, type Task } from "../src/index.ts";
import { route } from "../src/route.ts";
import { mayStack, stackOf } from "../src/stack.ts";
import { enqueue, FakeFleet, machine, NOW, readerChecked, spec, STACKS } from "./fixtures.ts";

const PR = "https://github.com/acme/app/pull/7";
const opened = (task: string): TaskDep => ({ task, after: "opened" });

/** A predecessor with an open PR on its pushed branch, placed on `a`: what `after: "opened"` releases on. */
function pred(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    spec: spec(),
    state: "awaiting-merge",
    createdAt: NOW,
    assignment: { deviceId: "a", exclave: "main", clone: "app", window: id },
    prUrl: PR,
    branch: `worktree-${id}`,
    pushed: true,
    ...fields,
  };
}

function dependent(deps: readonly TaskDep[], fields: Partial<Task["spec"]> = {}): Task {
  return { id: "b", spec: spec({ deps, ...fields }), state: "ready", createdAt: NOW };
}

const byId = (...tasks: readonly Task[]): ReadonlyMap<string, Task> => new Map(tasks.map((t) => [t.id, t]));

describe("which predecessor it stacks on", () => {
  test("a pushed, unmerged predecessor's own branch, and where it ran", () => {
    expect(stackOf(dependent([opened("a1")]), byId(pred("a1")))).toEqual({
      on: "branch",
      task: "a1",
      branch: "worktree-a1",
      at: { deviceId: "a", exclave: "main" },
    });
  });

  test("the first `after: opened` edge in deps order, never a `merged` or `done` edge before it", () => {
    const task = dependent([{ task: "m", after: "merged" }, opened("a2"), opened("a1")]);
    expect(stackOf(task, byId(pred("m"), pred("a1"), pred("a2")))).toMatchObject({ branch: "worktree-a2" });
  });

  test("a predecessor passed to a successor stacks on the successor's branch", () => {
    const old = pred("a1", { state: "superseded", successor: "a1s", pushed: true });
    const successor = pred("a1s", { branch: "worktree-a1s" });
    expect(stackOf(dependent([opened("a1")]), byId(old, successor))).toMatchObject({
      task: "a1s",
      branch: "worktree-a1s",
    });
  });

  test("a predecessor whose PR merged starts from the default branch, with no note", () => {
    for (const merged of [
      pred("a1", { state: "done", doneBy: "merged" }),
      pred("a1", { merged: true }),
      pred("a1", { pr: { state: "merged", at: NOW } }),
    ]) {
      expect(stackOf(dependent([opened("a1")]), byId(merged))).toEqual({ on: "merged", task: "a1" });
    }
  });

  test("a merge into a stacked parent's branch is not on the default branch, so it still stacks", () => {
    const into = pred("a1", { pr: { state: "merged", stacked: true, at: NOW } });
    expect(stackOf(dependent([opened("a1")]), byId(into))).toMatchObject({ on: "branch" });
  });

  test("a predecessor done with nothing pushed, or a `here` task, leaves nothing to stack on", () => {
    const { prUrl: _pr, pushed: _pushed, ...bare } = pred("a1");
    for (const nothing of [
      { ...bare, state: "done", doneBy: "manual" } satisfies Task,
      { ...pred("a1", { state: "done", doneBy: "session" }), pushed: undefined },
      pred("a1", { spec: spec({ mode: "here" }), branch: "main" }),
      pred("a1", { branch: "../escape" }),
    ]) {
      expect(stackOf(dependent([opened("a1")]), byId(nothing))).toEqual({ on: "nothing", task: "a1" });
    }
  });

  test("only a fresh worktree task with an `opened` edge stacks", () => {
    expect(mayStack(spec({ deps: [opened("a1")] }))).toBe(true);
    expect(mayStack(spec({ deps: [{ task: "a1", after: "merged" }] }))).toBe(false);
    expect(mayStack(spec({ mode: "here", deps: [opened("a1")] }))).toBe(false);
    expect(stackOf(dependent([opened("a1")], { mode: "here" }), byId(pred("a1")))).toEqual({ on: "default" });
  });
});

describe("routing a task that may stack", () => {
  const decide = (machines: readonly Machine[], tasks: readonly Task[]) =>
    route({ task: dependent([opened("a1")]), machines, tasks, now: NOW, config: DEFAULT_CONFIG });

  test("a daemon that cannot stack is base_unsupported, whatever its predecessor did", () => {
    for (const before of [pred("a1"), pred("a1", { state: "done", doneBy: "merged" })]) {
      const decision = decide([machine("old"), machine("new", { capabilities: STACKS })], [before]);
      expect(decision.chosen?.deviceId).toBe("new");
      expect(decision.candidates.find((c) => c.deviceId === "old")?.rejected).toEqual([{ code: "base_unsupported" }]);
    }
  });

  test("prefers the machine its predecessor ran on", () => {
    const decision = decide(
      [machine("a", { capabilities: STACKS }), machine("b", { capabilities: STACKS })],
      [pred("a1")],
    );
    expect(decision.chosen?.deviceId).toBe("a");
    const distance = (id: string) =>
      decision.candidates.find((c) => c.deviceId === id)?.score?.components.dependencyDistance;
    expect([distance("a"), distance("b")]).toEqual([0, 0.5]);
  });

  test("a task with no `opened` edge is held to nothing", () => {
    const task = dependent([{ task: "a1", after: "merged" }]);
    const decision = route({ task, machines: [machine("old")], tasks: [], now: NOW, config: DEFAULT_CONFIG });
    expect(decision.chosen?.deviceId).toBe("old");
  });
});

describe("dispatching a stacked task", () => {
  async function dispatched(before: Task, reply?: { code: SpawnErrorCode; message: string }) {
    const store = new MemoryQueueStore();
    const fleet = new FakeFleet([machine("a", { capabilities: STACKS })]);
    if (reply !== undefined) fleet.scripts.set("a", () => ({ ok: false, ...reply }));
    const scheduler = new Scheduler({ store: readerChecked(store, () => NOW), fleet, now: () => NOW });
    const put = await store.put(before.id, 0, before);
    if (!put.ok) throw new Error("seed refused");
    await scheduler.refresh(before.id);
    const task = await enqueue(store, scheduler, spec({ deps: [opened(before.id)] }), "b");
    await enqueue(store, scheduler, spec({ deps: [{ task: "b", after: "done" }] }), "c");
    for (let i = 0; i < 3; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- passes in order
      await scheduler.tick();
      // oxlint-disable-next-line no-await-in-loop -- passes in order
      await scheduler.drain();
    }
    return { sent: fleet.spawns.find((s) => s.request.taskId === task.id)?.request, scheduler };
  }

  test("sends the predecessor's branch as baseBranch, and records what it stacked on", async () => {
    const { sent, scheduler } = await dispatched(pred("a1"));
    expect(sent).toMatchObject({ baseBranch: "worktree-a1", client: SCHEDULER_CLIENT, taskId: "b" });
    expect(sent).not.toHaveProperty("noBase");
    expect(scheduler.task("b")).toMatchObject({ state: "running", stack: { task: "a1", on: "branch" } });
  });

  test("a merged predecessor starts it from the default branch, with no note", async () => {
    const { sent, scheduler } = await dispatched(pred("a1", { state: "done", doneBy: "merged" }));
    expect(sent).toBeDefined();
    expect(sent).not.toHaveProperty("baseBranch");
    expect(sent).not.toHaveProperty("noBase");
    expect(scheduler.task("b")?.stack).toEqual({ task: "a1", on: "merged" });
  });

  test("a predecessor done with no PR starts it from the default branch, noting there was nothing to stack on", async () => {
    const { prUrl: _pr, pushed: _pushed, ...bare } = pred("a1");
    const { sent, scheduler } = await dispatched({ ...bare, state: "done", doneBy: "manual" });
    expect(sent).toMatchObject({ noBase: true });
    expect(sent).not.toHaveProperty("baseBranch");
    expect(scheduler.task("b")?.stack).toEqual({ task: "a1", on: "nothing" });
  });

  test("base_not_found fails it in words, and its dependents with it", async () => {
    const { scheduler } = await dispatched(pred("a1"), { code: "base_not_found", message: "origin/worktree-a1: none" });
    expect(scheduler.task("b")).toMatchObject({ state: "failed", failure: { code: "base_not_found" } });
    expect(scheduler.task("b")).not.toHaveProperty("stack");
    expect(scheduler.task("b")?.failure?.message).toStartWith("the branch of the task it stacks on is not on origin");
    expect(scheduler.task("c")).toMatchObject({ state: "failed", failure: { code: "dependency_failed" } });
  });
});
