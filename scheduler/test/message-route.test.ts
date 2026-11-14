import { describe, expect, test } from "bun:test";
import { SUCCESSOR_CHAIN_MAX } from "@seance/shared";
import { resolveMessageTarget, type Task } from "../src/index.ts";
import { NOW, spec } from "./fixtures.ts";

const AT = { deviceId: "d9", exclave: "main", clone: "app" } as const;

function task(id: string, state: Task["state"], over: Partial<Task> = {}): Task {
  return { id, spec: spec(), state, createdAt: NOW, ...over };
}

function placed(id: string, state: Task["state"], deviceId: string, over: Partial<Task> = {}): Task {
  return task(id, state, { assignment: { deviceId, exclave: "main", clone: "app" }, ...over });
}

function continuation(id: string, continues: string, state: Task["state"], over: Partial<Task> = {}): Task {
  return task(id, state, { spec: spec({ mode: "continue", continues: { task: continues, at: AT } }), ...over });
}

describe("resolveMessageTarget", () => {
  test("a placed task is forwarded to its machine, not settled", () => {
    for (const state of ["running", "needs-input", "lost"] as const) {
      expect(resolveMessageTarget("t", [placed("t", state, "d1")])).toEqual({
        kind: "forward",
        taskId: "t",
        deviceId: "d1",
        settled: false,
      });
    }
  });

  test("a placed state with no assignment is held, not forwarded to nobody", () => {
    expect(resolveMessageTarget("t", [task("t", "running")])).toEqual({ kind: "held", taskId: "t" });
  });

  test("a task waiting for a machine is held, whatever its reason", () => {
    for (const state of ["queued", "ready", "blocked", "reserved"] as const) {
      expect(resolveMessageTarget("t", [task("t", state)])).toEqual({ kind: "held", taskId: "t" });
    }
  });

  test("an absent task is unknown", () => {
    expect(resolveMessageTarget("nope", [placed("t", "running", "d1")])).toEqual({ kind: "unknown" });
  });

  describe("a superseded chain", () => {
    const chain = (end: Task): Task[] => [
      task("p", "superseded", { successor: "s1" }),
      task("s1", "superseded", { successor: "s2" }),
      end,
    ];

    test("follows to the end and forwards to where it runs", () => {
      expect(resolveMessageTarget("p", chain(placed("s2", "running", "d2")))).toEqual({
        kind: "forward",
        taskId: "s2",
        deviceId: "d2",
        settled: false,
      });
    });

    test("holds while the end has not started", () => {
      expect(resolveMessageTarget("p", chain(task("s2", "blocked")))).toEqual({ kind: "held", taskId: "s2" });
    });

    test("a link that is missing, a cycle and an over-long chain are unknown", () => {
      expect(resolveMessageTarget("p", [task("p", "superseded", { successor: "gone" })])).toEqual({ kind: "unknown" });
      expect(
        resolveMessageTarget("a", [
          task("a", "superseded", { successor: "b" }),
          task("b", "superseded", { successor: "a" }),
        ]),
      ).toEqual({ kind: "unknown" });
      const long = Array.from({ length: SUCCESSOR_CHAIN_MAX + 2 }, (_, i) =>
        i === SUCCESSOR_CHAIN_MAX + 1
          ? placed(`n${i}`, "running", "d1")
          : task(`n${i}`, "superseded", { successor: `n${i + 1}` }),
      );
      expect(resolveMessageTarget("n0", long)).toEqual({ kind: "unknown" });
    });
  });

  describe("a finished task", () => {
    test("with a landed continuation goes to it", () => {
      const f = placed("f", "done", "d1");
      const c = continuation("c", "f", "running", { assignment: { deviceId: "d2", exclave: "main", clone: "app" } });
      expect(resolveMessageTarget("f", [f, c])).toEqual({
        kind: "forward",
        taskId: "c",
        deviceId: "d2",
        settled: false,
      });
    });

    test("with a continuation still waiting is held on it", () => {
      const f = placed("f", "done", "d1");
      expect(resolveMessageTarget("f", [f, continuation("c", "f", "queued")])).toEqual({ kind: "held", taskId: "c" });
    });

    test("a finished continuation is forwarded settled", () => {
      const f = placed("f", "done", "d1");
      const c = continuation("c", "f", "done", { assignment: { deviceId: "d2", exclave: "main", clone: "app" } });
      expect(resolveMessageTarget("f", [f, c])).toEqual({
        kind: "forward",
        taskId: "c",
        deviceId: "d2",
        settled: true,
      });
    });

    test("two landed continuations pick the newest", () => {
      const f = placed("f", "done", "d1");
      const older = continuation("c1", "f", "running", {
        createdAt: NOW + 1,
        assignment: { deviceId: "d2", exclave: "main", clone: "app" },
      });
      const newer = continuation("c2", "f", "running", {
        createdAt: NOW + 2,
        assignment: { deviceId: "d3", exclave: "main", clone: "app" },
      });
      expect(resolveMessageTarget("f", [f, older, newer])).toEqual({
        kind: "forward",
        taskId: "c2",
        deviceId: "d3",
        settled: false,
      });
    });

    test("a continuation that was itself superseded follows to its successor", () => {
      const f = placed("f", "done", "d1");
      const c = continuation("c", "f", "superseded", { successor: "s" });
      expect(resolveMessageTarget("f", [f, c, placed("s", "running", "d4")])).toEqual({
        kind: "forward",
        taskId: "s",
        deviceId: "d4",
        settled: false,
      });
    });

    test("with an assignment and no continuation is forwarded settled, awaiting-merge too", () => {
      for (const state of ["done", "failed", "cancelled", "awaiting-merge"] as const) {
        expect(resolveMessageTarget("t", [placed("t", state, "d1")])).toEqual({
          kind: "forward",
          taskId: "t",
          deviceId: "d1",
          settled: true,
        });
      }
    });

    test("with no assignment is ended", () => {
      expect(resolveMessageTarget("t", [task("t", "failed")])).toEqual({ kind: "ended", taskId: "t" });
    });
  });
});
