import { describe, expect, test } from "bun:test";
import type { Task, TaskState } from "@seance/shared";
import { describeVerdict, type VerdictContent } from "../src/verdict-view.ts";

const NOW = 1_800_000_000_000;

const task = (state: TaskState, extra: Partial<Task> = {}): Task => ({
  id: "t",
  spec: { repo: "github.com/acme/app", mode: "worktree" },
  state,
  createdAt: NOW,
  ...extra,
});

const at = { deviceId: "mac", exclave: "default", clone: "app" };

function verdictOf(t: Task): VerdictContent {
  return describeVerdict({ kind: "queued", task: t }, "Mac", [], NOW, null);
}

describe("a queued verdict's stage track", () => {
  test("waiting is the first bead, reserved the second, placed the third", () => {
    expect(verdictOf(task("queued")).stage).toEqual({ reached: 0 });
    expect(verdictOf(task("blocked")).stage).toEqual({ reached: 0 });
    expect(verdictOf(task("ready")).stage).toEqual({ reached: 0 });
    expect(verdictOf(task("reserved", { reservation: { ...at, expiresAt: NOW + 60_000 } })).stage).toEqual({
      reached: 1,
    });
    expect(verdictOf(task("running", { assignment: at })).stage).toEqual({ reached: 2 });
    expect(verdictOf(task("needs-input", { assignment: at })).stage).toEqual({ reached: 2 });
  });

  test("an outcome is a glyph, not a stage: ended and finished tasks, and a lost one, show none", () => {
    for (const state of ["awaiting-merge", "done", "failed", "cancelled", "lost"] as const) {
      expect(verdictOf(task(state, { assignment: at })).stage).toBeNull();
    }
  });

  test("a direct spawn's verdicts have no track", () => {
    const ok = describeVerdict({ kind: "ok", window: "w" }, "Mac", [], NOW, null);
    expect(ok.stage).toBeNull();
  });
});
