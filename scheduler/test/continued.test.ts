import { describe, expect, test } from "bun:test";
import { continuedChange } from "../src/continued.ts";
import type { Task } from "../src/index.ts";
import { NOW, spec } from "./fixtures.ts";

const AT = { deviceId: "a", exclave: "main", clone: "app" } as const;
const HEAD = "0".repeat(40);

function waiting(over: Partial<Task> = {}): Task {
  return {
    id: "t",
    spec: spec(),
    state: "awaiting-merge",
    createdAt: NOW,
    prUrl: "https://github.com/a/b/pull/1",
    ...over,
  };
}

function continuation(id: string, continues: string, state: Task["state"], createdAt = NOW + 1): Task {
  return { id, spec: spec({ mode: "continue", continues: { task: continues, at: AT } }), state, createdAt };
}

describe("continuedChange", () => {
  test("only an awaiting-merge task carries the pointer", () => {
    const done = waiting({ state: "done" });
    expect(continuedChange(done, [done, continuation("c", "t", "running")])).toBeNull();
  });

  test("a continuation that landed running is pointed at, live, and the stamp it follows is dropped", () => {
    const task = waiting({ prAlert: { reason: "checks", head: HEAD, at: NOW } });
    const next = continuedChange(task, [task, continuation("c", "t", "running")]);
    expect(next?.continuedBy).toEqual({ task: "c", createdAt: NOW + 1, live: true });
    expect(next).not.toHaveProperty("prAlert");
  });

  test("it then ending drops live and keeps a stamp written since, as the continuation did not change", () => {
    const stamped = waiting({
      continuedBy: { task: "c", createdAt: NOW + 1, live: true },
      prAlert: { reason: "checks", head: HEAD, at: NOW + 5 },
    });
    const next = continuedChange(stamped, [stamped, continuation("c", "t", "done")]);
    expect(next?.continuedBy).toEqual({ task: "c", createdAt: NOW + 1 });
    expect(next?.prAlert).toEqual({ reason: "checks", head: HEAD, at: NOW + 5 });
  });

  test("an unchanged chain, or no landed continuation at all, writes nothing", () => {
    const pointed = waiting({ continuedBy: { task: "c", createdAt: NOW + 1 } });
    expect(continuedChange(pointed, [pointed, continuation("c", "t", "done")])).toBeNull();
    expect(continuedChange(waiting(), [waiting(), continuation("c", "t", "queued")])).toBeNull();
  });

  test("a chain that moved on points at its newest landed link, and a pointer with nothing behind it is removed", () => {
    const pointed = waiting({ continuedBy: { task: "c1", createdAt: NOW + 1 } });
    const chain = [pointed, continuation("c1", "t", "done"), continuation("c2", "c1", "running", NOW + 2)];
    expect(continuedChange(pointed, chain)?.continuedBy).toEqual({ task: "c2", createdAt: NOW + 2, live: true });
    const gone = continuedChange(pointed, [pointed]);
    expect(gone).not.toBeNull();
    expect(gone).not.toHaveProperty("continuedBy");
  });
});
