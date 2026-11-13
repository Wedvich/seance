import { describe, expect, test } from "bun:test";
import { CAPABILITIES, type DrainRefusal } from "@seance/shared";
import { DEFAULT_CONFIG, type Task } from "../src/index.ts";
import { drainDue, drainWaitMs, stampDrain, stampDrainRefusal } from "../src/drain-trigger.ts";
import { machine, NOW, spec, status } from "./fixtures.ts";

const CL = NOW;
const WAIT = DEFAULT_CONFIG.drainSelfPassMs;
const RETRY = DEFAULT_CONFIG.drainRetryMs;
const AT = CL + WAIT;

const closed = (fields: Partial<ReturnType<typeof machine>> = {}): ReturnType<typeof machine> =>
  machine("a", {
    capabilities: [CAPABILITIES.metrics, CAPABILITIES.taskId, CAPABILITIES.successor],
    status: status({ cl: CL }),
    ...fields,
  });

const task = (fields: Partial<Task> = {}): Task => ({
  id: "t",
  spec: spec({}),
  state: "running",
  createdAt: NOW,
  assignment: { deviceId: "a", exclave: "main", clone: "app" },
  ...fields,
});

describe("drainWaitMs", () => {
  test("is the self-pass wait on every machine", () => {
    expect(drainWaitMs(closed(), DEFAULT_CONFIG)).toBe(WAIT);
    expect(drainWaitMs(closed({ capabilities: [] }), DEFAULT_CONFIG)).toBe(WAIT);
  });
});

describe("drainDue", () => {
  test("is false before the wait and true at it", () => {
    expect(drainDue(task(), closed(), AT - 1, DEFAULT_CONFIG)).toBe(false);
    expect(drainDue(task(), closed(), AT, DEFAULT_CONFIG)).toBe(true);
    expect(drainDue(task({ state: "needs-input" }), closed(), AT, DEFAULT_CONFIG)).toBe(true);
  });

  test("is false for an open, disconnected or successor-less machine", () => {
    expect(drainDue(task(), closed({ status: status() }), AT, DEFAULT_CONFIG)).toBe(false);
    expect(drainDue(task(), closed({ connected: false }), AT, DEFAULT_CONFIG)).toBe(false);
    expect(drainDue(task(), closed({ capabilities: [] }), AT, DEFAULT_CONFIG)).toBe(false);
  });

  test("is false for a task elsewhere, not running, run in place, or with a successor", () => {
    const elsewhere = task({ assignment: { deviceId: "b", exclave: "main", clone: "app" } });
    expect(drainDue(elsewhere, closed(), AT, DEFAULT_CONFIG)).toBe(false);
    expect(drainDue(task({ state: "ready" }), closed(), AT, DEFAULT_CONFIG)).toBe(false);
    expect(drainDue(task({ spec: spec({ mode: "here" }) }), closed(), AT, DEFAULT_CONFIG)).toBe(false);
    expect(drainDue(task({ successor: "s" }), closed(), AT, DEFAULT_CONFIG)).toBe(false);
  });

  test("a stamp at this close holds for the retry wait; an older close's holds nothing; held holds for good", () => {
    const stamped = task({ drained: { at: CL, tried: AT } });
    expect(drainDue(stamped, closed(), AT + RETRY - 1, DEFAULT_CONFIG)).toBe(false);
    expect(drainDue(stamped, closed(), AT + RETRY, DEFAULT_CONFIG)).toBe(true);
    expect(drainDue(task({ drained: { at: CL - 1, tried: AT } }), closed(), AT, DEFAULT_CONFIG)).toBe(true);
    const held = task({ drained: { at: CL, tried: AT, held: true } });
    expect(drainDue(held, closed(), AT + 10 * RETRY, DEFAULT_CONFIG)).toBe(false);
  });
});

describe("stampDrain", () => {
  test("writes the attempt, dropping an old refusal, and declines a task no longer due", () => {
    const old = task({ drained: { at: CL - 1, tried: 5, refused: "dirty_worktree" } });
    expect(stampDrain(old, closed(), AT, DEFAULT_CONFIG)?.drained).toEqual({ at: CL, tried: AT });
    expect(stampDrain(task({ state: "ready" }), closed(), AT, DEFAULT_CONFIG)).toBeNull();
  });
});

describe("stampDrainRefusal", () => {
  const refused: DrainRefusal = "push_failed";
  test("records the refusal only on the attempt at this close of a live, unpassed task", () => {
    const attempt = task({ drained: { at: CL, tried: AT } });
    expect(stampDrainRefusal(attempt, CL, refused)?.drained).toEqual({ at: CL, tried: AT, refused });
    expect(stampDrainRefusal(attempt, CL, "held")?.drained).toEqual({ at: CL, tried: AT, held: true });
    expect(stampDrainRefusal(attempt, CL + 1, refused)).toBeNull();
    expect(stampDrainRefusal(task(), CL, refused)).toBeNull();
    expect(stampDrainRefusal({ ...attempt, successor: "s" }, CL, refused)).toBeNull();
    expect(stampDrainRefusal({ ...attempt, state: "done" }, CL, refused)).toBeNull();
  });
});
