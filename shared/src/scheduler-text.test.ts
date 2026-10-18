import { describe, expect, test } from "bun:test";
import { reasonText, taskFailureText } from "./scheduler-text.ts";
import { TASK_FAILURE_CODES } from "./types.ts";

describe("taskFailureText", () => {
  test("words every scheduler-set code apart, and leaves a daemon's or a later code to the caller", () => {
    const texts = TASK_FAILURE_CODES.map(taskFailureText);
    expect(texts.every((t) => t !== null && t.length > 0)).toBe(true);
    expect(new Set(texts).size).toBe(TASK_FAILURE_CODES.length);
    expect(taskFailureText("queue_expired")).toContain("30 days");
    expect(taskFailureText("lost_expired")).toContain("may still be running");
    expect(taskFailureText("repo_not_found")).toBeNull();
    expect(taskFailureText("minted_later")).toBeNull();
  });
});

describe("reasonText", () => {
  test("batch_order names the member it waits for by the spec's own index, without claiming it started", () => {
    const text = reasonText({ code: "batch_order", index: 0 });
    expect(text).toContain("#0");
    expect(text).not.toContain("ended");
  });
});
