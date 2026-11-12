import { describe, expect, test } from "bun:test";
import { prBlocked, prChipFields, samePrReading, taskPrBlock } from "./pr-blocked.ts";
import type { PrStatus, Task, TaskSpec } from "./types.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function reading(over: Partial<PrStatus> = {}): PrStatus {
  return { state: "open", at: 1, ...over };
}

function waiting(pr: PrStatus, spec: Partial<TaskSpec> = {}, state: Task["state"] = "awaiting-merge"): Task {
  return { id: "t-1", state, createdAt: 1, spec: { repo: "github.com/acme/app", mode: "worktree", ...spec }, pr };
}

describe("prBlocked", () => {
  test("each reason's minimal reading", () => {
    expect(prBlocked(reading({ merge: "dirty" }))).toBe("conflict");
    expect(prBlocked(reading({ required: "failing", failing: ["checks"] }))).toBe("checks");
    expect(prBlocked(reading({ merge: "behind" }))).toBe("behind");
    expect(prBlocked(reading({ required: "passing", merge: "clean" }))).toBe("unarmed");
  });

  test("the first that holds wins: a conflict outranks failing checks, which outrank behind", () => {
    expect(prBlocked(reading({ merge: "dirty", required: "failing", failing: ["a"] }))).toBe("conflict");
    expect(prBlocked(reading({ merge: "behind", required: "failing", failing: ["a"] }))).toBe("checks");
    expect(prBlocked(reading({ merge: "behind", required: "passing" }))).toBe("behind");
  });

  test("unarmed also holds for unstable and has_hooks, and is not raised without a passing required check", () => {
    expect(prBlocked(reading({ required: "passing", merge: "unstable" }))).toBe("unarmed");
    expect(prBlocked(reading({ required: "passing", merge: "has_hooks" }))).toBe("unarmed");
    for (const over of [
      { merge: "clean" as const },
      { required: "pending" as const, merge: "clean" as const },
      { required: "passing" as const, merge: "clean" as const, armed: true as const },
      { required: "passing" as const, merge: "clean" as const, reviewRequested: true as const },
      { required: "passing" as const, merge: "blocked" as const },
      { required: "passing" as const, merge: "unknown" as const },
      { required: "passing" as const },
    ]) {
      expect(prBlocked(reading(over))).toBeNull();
    }
  });

  test("only an open PR is blocked", () => {
    for (const state of ["draft", "merged", "closed"] as const) {
      expect(prBlocked(reading({ state, merge: "dirty" }))).toBeNull();
    }
    expect(prBlocked(undefined)).toBeNull();
  });
});

describe("taskPrBlock", () => {
  const blocked = reading({ merge: "dirty" });

  test("an awaiting-merge task reads its PR's reason", () => {
    expect(taskPrBlock(waiting(blocked))).toBe("conflict");
  });

  test("a running task, or one under until: reported, never does", () => {
    expect(taskPrBlock(waiting(blocked, {}, "running"))).toBeNull();
    expect(taskPrBlock(waiting(blocked, { until: "reported" }))).toBeNull();
    expect(taskPrBlock(waiting(blocked, { until: "merged" }))).toBe("conflict");
  });
});

describe("samePrReading", () => {
  const base = reading({ head: HEAD, required: "failing", failing: ["a", "b"], merge: "clean", armed: true });

  test("`at` is ignored", () => {
    expect(samePrReading(base, { ...base, at: 99 })).toBe(true);
  });

  test("each other field is seen, a head change and a failing change included", () => {
    expect(samePrReading(undefined, base)).toBe(false);
    expect(samePrReading(base, { ...base, head: "f".repeat(40) })).toBe(false);
    expect(samePrReading(base, { ...base, failing: ["a"] })).toBe(false);
    expect(samePrReading(base, { ...base, failing: ["a", "c"] })).toBe(false);
    expect(samePrReading(base, reading({ ...base, merge: "dirty" }))).toBe(false);
    expect(samePrReading(base, { ...base, state: "draft" })).toBe(false);
    const { armed: _armed, ...unarmed } = base;
    expect(samePrReading(base, unarmed)).toBe(false);
    expect(samePrReading(base, { ...base, reviewRequested: true })).toBe(false);
    expect(samePrReading(base, { ...base, required: "pending" })).toBe(false);
  });
});

describe("prChipFields", () => {
  test("keeps what a chip shows and nothing else", () => {
    const full = reading({ checks: "failing", stacked: undefined, head: HEAD, merge: "dirty", armed: true });
    expect(prChipFields(full)).toEqual({ state: "open", checks: "failing", at: 1 });
    expect(prChipFields({ state: "merged", stacked: true, at: 2 })).toEqual({ state: "merged", stacked: true, at: 2 });
  });
});
