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
    expect(continueOffer(failed(), able)).toEqual({
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
      const offer = continueOffer(task, machines);
      expect(offer.ok, name).toBe(false);
      expect(offer.ok ? "" : offer.reason.length, name).toBeGreaterThan(0);
    }
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
