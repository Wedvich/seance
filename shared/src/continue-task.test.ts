import { describe, expect, test } from "bun:test";
import type { Machine } from "./app-client.ts";
import { continuationSpec, continueOffer } from "./continue-task.ts";
import { parseTaskSpec } from "./parse.ts";
import { CAPABILITIES, type Assignment, type Task, type TaskSpec } from "./types.ts";

const assignment: Assignment = { deviceId: "dev-a", exclave: "default", clone: "app", window: "w", pane: "%1" };

function machine(capabilities: readonly string[] | undefined, deviceId = "dev-a"): Machine {
  return {
    deviceId,
    name: "Box",
    platform: "linux",
    repos: [],
    scannedAt: 0,
    lastSeen: 0,
    connected: true,
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

function failed(over: Partial<Task> = {}, spec: Partial<TaskSpec> = {}): Task {
  return {
    id: "t-old",
    spec: { repo: "github.com/acme/app", mode: "worktree", prompt: "do it", ...spec },
    state: "failed",
    createdAt: 1,
    assignment,
    failure: { code: "session_failed", message: "exited", exit: 137 },
    ...over,
  };
}

const able = [machine([CAPABILITIES.continueTask])];

describe("continueOffer", () => {
  test("a placed session_failed task on a machine that advertises it is offered, at its own target", () => {
    expect(continueOffer(failed(), able, [])).toEqual({
      ok: true,
      at: { deviceId: "dev-a", exclave: "default", clone: "app" },
    });
  });

  test("each way it is not offered says why", () => {
    const refusals: readonly (readonly [string, Task, readonly Machine[]])[] = [
      ["not failed", failed({ state: "running" }), able],
      ["another failure", failed({ failure: { code: "lost_expired", message: "lost" } }), able],
      ["no failure at all", failed({ failure: undefined }), able],
      ["here mode", failed({}, { mode: "here" }), able],
      ["never placed", failed({ assignment: undefined }), able],
      ["machine unlisted", failed(), [machine([CAPABILITIES.continueTask], "dev-other")]],
      ["machine lacks the capability", failed(), [machine([CAPABILITIES.taskId])]],
      ["machine predates capabilities", failed(), [machine(undefined)]],
    ];
    for (const [name, task, machines] of refusals) {
      const offer = continueOffer(task, machines, []);
      expect(offer.ok, name).toBe(false);
      expect(offer.ok ? "" : offer.reason.length, name).toBeGreaterThan(0);
    }
  });
});

describe("continueOffer, a cancelled task", () => {
  const cancelled = (over: Partial<Task> = {}): Task => failed({ state: "cancelled", failure: undefined, ...over });
  const both = [machine([CAPABILITIES.continueTask, CAPABILITIES.continueCancelled])];

  test("offered with an assignment on a machine advertising both capabilities, leftRunning or not", () => {
    const at = { deviceId: "dev-a", exclave: "default", clone: "app" };
    expect(continueOffer(cancelled(), both, [])).toEqual({ ok: true, at });
    expect(continueOffer(cancelled({ leftRunning: true }), both, [])).toEqual({ ok: true, at });
  });

  test("refused without continueCancelled, naming the update", () => {
    const offer = continueOffer(cancelled(), able, []);
    expect(offer.ok).toBe(false);
    expect(offer.ok ? "" : offer.reason).toContain("continue a cancelled session");
  });

  test("refused with no assignment, or when its session had already finished", () => {
    const reasonOf = (task: Task): string => {
      const offer = continueOffer(task, both, []);
      return offer.ok ? "" : offer.reason;
    };
    expect(reasonOf(cancelled({ assignment: undefined }))).toContain("cancelled before it started");
    expect(reasonOf(cancelled({ endedAt: 5 }))).toContain("had already finished");
  });

  test("done and every failure but session_failed are never offered", () => {
    const refused: readonly Task[] = [
      failed({ state: "done", failure: undefined }),
      ...["lost_expired", "merge_expired", "dispatch_unconfirmed", "continue_expired"].map((code) =>
        failed({ failure: { code, message: "m" } }),
      ),
    ];
    for (const task of refused) expect(continueOffer(task, both, []).ok, task.failure?.code ?? task.state).toBe(false);
  });
});

describe("continueOffer, once", () => {
  const old = failed();
  const both = [machine([CAPABILITIES.continueTask, CAPABILITIES.continueCancelled])];
  const continuation = (
    state: Task["state"],
    over: Partial<Task> = {},
    continues = "t-old",
    id = `t-${state}`,
  ): Task => ({
    id,
    spec: {
      repo: old.spec.repo,
      mode: "continue",
      continues: { task: continues, at: { deviceId: "dev-a", exclave: "default", clone: "app" } },
    },
    state,
    createdAt: 2,
    ...over,
  });
  const failing = (code: string): Task => continuation("failed", { failure: { code, message: "m" } });

  test("a continuation that landed holds the offer", () => {
    for (const state of ["reserved", "running", "needs-input", "lost", "awaiting-merge", "done"] as const) {
      const offer = continueOffer(old, able, [old, continuation(state)]);
      expect(offer.ok, state).toBe(false);
      expect(offer.ok ? "" : offer.reason, state).toContain("already underway or finished");
    }
  });

  test("one that failed after landing, or was cancelled after placement, holds it and names itself", () => {
    const takers = [
      failing("session_failed"),
      failing("lost_expired"),
      failing("merge_expired"),
      continuation("cancelled", { assignment }),
    ];
    for (const taker of takers) {
      const offer = continueOffer(old, both, [old, taker]);
      expect(offer.ok, taker.state).toBe(false);
      expect(offer.ok ? "" : offer.reason, taker.state).toContain(taker.id);
    }
  });

  test("a finished taker is pointed at only when it could itself be continued", () => {
    const reasonOf = (taker: Task): string => {
      const offer = continueOffer(old, both, [old, taker]);
      return offer.ok ? "" : offer.reason;
    };
    for (const taker of [failing("session_failed"), continuation("cancelled", { assignment })]) {
      expect(reasonOf(taker)).toContain("continue that one instead");
    }
    for (const taker of [
      failing("lost_expired"),
      failing("merge_expired"),
      continuation("cancelled", { assignment, endedAt: 5 }),
    ]) {
      const reason = reasonOf(taker);
      expect(reason).toContain("nothing left to continue");
      expect(reason).not.toContain("continue that one instead");
    }
  });

  test("one that never landed leaves it open; so does another task's", () => {
    const open: readonly Task[] = [
      continuation("queued"),
      continuation("blocked"),
      continuation("ready"),
      failing("not_continuable"),
      failing("continue_expired"),
      failing("dispatch_unconfirmed"),
      continuation("failed"),
      continuation("cancelled"),
    ];
    for (const y of open) expect(continueOffer(old, able, [old, y]).ok, `${y.state} ${y.failure?.code}`).toBe(true);
    expect(continueOffer(old, able, [old, continuation("running", {}, "t-other")]).ok).toBe(true);
  });

  test("along a chain the newest landed task holds the offer", () => {
    const y = continuation("failed", { failure: { code: "session_failed", message: "m" }, assignment }, "t-old", "t-y");
    const z = continuation("running", {}, "t-y", "t-z");
    expect(continueOffer(old, able, [old, y, z]).ok).toBe(false);
    expect(continueOffer(y, able, [old, y, z]).ok).toBe(false);
    const expired = continuation("failed", { failure: { code: "continue_expired", message: "m" } }, "t-y", "t-z");
    expect(continueOffer(y, able, [old, y, expired]).ok).toBe(true);
  });
});

describe("continuationSpec", () => {
  const at = { deviceId: "dev-a", exclave: "default", clone: "app" };

  test("copies what shapes and settles the session, drops what places or orders it", () => {
    const task = failed(
      {},
      {
        title: "fix it",
        model: "opus",
        effort: "high",
        plan: true,
        until: "reported",
        linear: { issue: "ENG-1" },
        skill: "ship",
        pin: { deviceId: "dev-z" },
        avoid: ["dev-y"],
        lineage: { deviceId: "dev-x", exclave: "default" },
        base: { deviceId: "dev-x", exclave: "default" },
        batch: { id: "b", index: 1, strategy: { mode: "auto" } },
        deps: [{ task: "t-0", after: "merged" }],
        client: "pwa",
      },
    );
    const spec = continuationSpec(task, at);
    expect(spec).toEqual({
      repo: "github.com/acme/app",
      mode: "continue",
      title: "fix it",
      model: "opus",
      effort: "high",
      plan: true,
      until: "reported",
      linear: { issue: "ENG-1" },
      continues: { task: "t-old", at },
    });
    // The result is a spec a leader's parser keeps whole.
    expect(parseTaskSpec(spec)).toEqual(spec);
  });

  test("the old prompt is not carried; a note is, trimmed, and a blank one is left out", () => {
    expect(continuationSpec(failed(), at)).not.toHaveProperty("prompt");
    expect(continuationSpec(failed(), at, "  \n ")).not.toHaveProperty("prompt");
    expect(continuationSpec(failed(), at, "  retry the build  ").prompt).toBe("retry the build");
  });
});
