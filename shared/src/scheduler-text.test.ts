import { describe, expect, test } from "bun:test";
import { reasonText, schedulerErrorText, storeErrorText, taskFailureText } from "./scheduler-text.ts";
import { SCHEDULER_ERROR_CODES, STORE_ERROR_CODES, TASK_FAILURE_CODES } from "./types.ts";

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

describe("storeErrorText", () => {
  test("words every store refusal, apart where the cause differs, and names a code it does not know", () => {
    for (const code of STORE_ERROR_CODES) expect(storeErrorText(code).length).toBeGreaterThan(0);
    expect(storeErrorText("version_conflict")).toContain("earlier attempt");
    expect(storeErrorText("too_large")).toContain("shorten");
    expect(storeErrorText("rate_limited")).toContain("wait a minute");
    expect(storeErrorText("store_full")).toContain("queue is full");
    expect(storeErrorText("minted_later")).toContain("minted_later");
  });
});

describe("schedulerErrorText", () => {
  test("words every scheduler code, push-subscribe's included, and names one it does not know", () => {
    for (const code of SCHEDULER_ERROR_CODES) expect(schedulerErrorText(code)).not.toContain("does not know");
    expect(SCHEDULER_ERROR_CODES).toContain("settings_unavailable");
    expect(schedulerErrorText("settings_unavailable")).toContain("push is off");
    expect(schedulerErrorText("minted_later")).toContain("minted_later");
  });
});
