import { describe, expect, test } from "bun:test";
import { BACKGROUND_COUNT_MAX } from "@seance/shared";
import { hookFrame } from "./session-event-cli.ts";

const hook = (name: string, fields: object = {}): object => ({
  session_id: "s",
  transcript_path: "/x",
  cwd: "/y",
  hook_event_name: name,
  ...fields,
});

describe("hookFrame", () => {
  test("a session start at its prompt is idle without a turn's end; a compaction is nothing", () => {
    for (const source of ["startup", "resume", "clear"]) {
      expect(hookFrame(hook("SessionStart", { source }))).toEqual({ state: "idle" });
    }
    expect(hookFrame(hook("SessionStart", { source: "compact" }))).toBeNull();
    expect(hookFrame(hook("SessionStart"))).toBeNull();
  });

  test("Stop counts background work by kind, never carrying a command or description", () => {
    const frame = hookFrame(
      hook("Stop", {
        background_tasks: [
          { id: "b1", type: "shell", status: "running", description: "gh run watch", command: "gh run watch 1" },
          { id: "b2", type: "shell", status: "running", description: "x" },
          { id: "a1", type: "subagent", status: "running", description: "review" },
          { id: "m1", type: "monitor", status: "running" },
          { id: "w1", type: "workflow" },
          { id: "z1", type: "teleport" },
          { id: "z2", type: "constructor" },
          "junk",
        ],
        session_crons: [{ id: "c1", cron: "*/5 * * * *", prompt: "check CI" }],
      }),
    );
    expect(frame).toEqual({
      stop: { background: { shell: 2, agent: 1, monitor: 1, workflow: 1, other: 2, wakeup: 1 } },
    });
    expect(JSON.stringify(frame)).not.toContain("gh run");
  });

  test("Stop with nothing running is an empty note, which clears an earlier one; counts are capped", () => {
    expect(hookFrame(hook("Stop", { stop_hook_active: false }))).toEqual({ stop: { background: {} } });
    const many = Array.from({ length: 150 }, (_, i) => ({ id: `b${i}`, type: "shell" }));
    expect(hookFrame(hook("Stop", { background_tasks: many }))).toEqual({
      stop: { background: { shell: BACKGROUND_COUNT_MAX } },
    });
  });

  test("StopFailure carries a known error, any other as unknown", () => {
    expect(hookFrame(hook("StopFailure", { error: "rate_limit" }))).toEqual({ stop: { stopError: "rate_limit" } });
    expect(hookFrame(hook("StopFailure", { error: "<script>" }))).toEqual({ stop: { stopError: "unknown" } });
  });

  test("an elicitation is needs-input until its result; any other hook or input is nothing", () => {
    expect(hookFrame(hook("Elicitation", { message: "token?" }))).toEqual({
      state: "needs-input",
      reason: "elicitation",
    });
    expect(hookFrame(hook("ElicitationResult", { action: "accept" }))).toEqual({ state: "busy" });
    expect(hookFrame(hook("PreToolUse"))).toBeNull();
    expect(hookFrame("Stop")).toBeNull();
    expect(hookFrame(null)).toBeNull();
  });
});
