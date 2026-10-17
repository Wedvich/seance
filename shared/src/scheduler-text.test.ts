import { describe, expect, test } from "bun:test";
import { taskFailureText } from "./scheduler-text.ts";
import { TASK_FAILURE_CODES } from "./types.ts";

describe("taskFailureText", () => {
  test("words every scheduler-set code apart, and leaves a daemon's or a later code to the caller", () => {
    const texts = TASK_FAILURE_CODES.map(taskFailureText);
    expect(texts.every((t) => t !== null && t.length > 0)).toBe(true);
    expect(new Set(texts).size).toBe(TASK_FAILURE_CODES.length);
    expect(taskFailureText("queue_expired")).toContain("30 days");
    expect(taskFailureText("repo_not_found")).toBeNull();
    expect(taskFailureText("minted_later")).toBeNull();
  });
});
