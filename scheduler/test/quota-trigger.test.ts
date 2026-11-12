import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Task } from "../src/index.ts";
import { quotaDue, stampQuota } from "../src/quota-trigger.ts";
import type { Exhaustion } from "../src/route.ts";
import { NOW, spec } from "./fixtures.ts";

const CONFIG = DEFAULT_CONFIG;
const RESET = NOW + 3_600_000;
const EX: Exhaustion = { accountId: "org:a", window: "5h", reset: RESET, since: NOW - 60_000, spending: false };

function running(fields: Partial<Task> = {}): Task {
  return {
    id: "t",
    spec: spec(),
    state: "running",
    createdAt: NOW,
    assignment: { deviceId: "a", exclave: "main", clone: "app" },
    ...fields,
  };
}

describe("quotaDue", () => {
  test("acts once on a window with no stamp", () => {
    expect(quotaDue(running(), EX, NOW, CONFIG)).toBe("act");
  });

  test("nothing without an exhaustion: a forecast never acts", () => {
    expect(quotaDue(running(), null, NOW, CONFIG)).toBeNull();
  });

  test("nothing for the window a stamp covers, however much later", () => {
    const stamped = stampQuota(running(), EX, NOW, false);
    expect(stamped).not.toBeNull();
    expect(quotaDue(stamped as Task, EX, NOW + 30 * 60_000, CONFIG)).toBeNull();
  });

  test("acts again on a new reset of the same window, another window, or another account", () => {
    const stamped = stampQuota(running(), EX, NOW, false) as Task;
    const later = NOW + 5 * 3_600_000;
    expect(quotaDue(stamped, { ...EX, reset: RESET + 5 * 3_600_000 }, later, CONFIG)).toBe("act");
    expect(quotaDue(stamped, { ...EX, window: "7d" }, NOW, CONFIG)).toBe("act");
    expect(quotaDue(stamped, { ...EX, accountId: "org:b" }, NOW, CONFIG)).toBe("act");
  });

  test("a reset that drifts within the grace is the same window", () => {
    const stamped = stampQuota(running(), EX, NOW, false) as Task;
    expect(quotaDue(stamped, { ...EX, reset: RESET + CONFIG.resetGraceMs }, NOW, CONFIG)).toBeNull();
  });

  test("with no reset the stamp holds for one span of the window", () => {
    const none = { ...EX, reset: 0 };
    const stamped = stampQuota(running(), none, NOW, false) as Task;
    expect(quotaDue(stamped, none, NOW + 4 * 3_600_000, CONFIG)).toBeNull();
    expect(quotaDue(stamped, none, NOW + 5 * 3_600_000, CONFIG)).toBe("act");
    const weekly = { ...none, window: "7d sonnet" };
    const weeklyStamp = stampQuota(running(), weekly, NOW, false) as Task;
    expect(quotaDue(weeklyStamp, weekly, NOW + 6 * 86_400_000, CONFIG)).toBeNull();
    expect(quotaDue(weeklyStamp, weekly, NOW + 7 * 86_400_000, CONFIG)).toBe("act");
  });

  test("retries once, and only after quotaPassRetryMs, only with retry owed", () => {
    const owed = stampQuota(running(), EX, NOW, true) as Task;
    expect(quotaDue(owed, EX, NOW + CONFIG.quotaPassRetryMs - 1, CONFIG)).toBeNull();
    expect(quotaDue(owed, EX, NOW + CONFIG.quotaPassRetryMs, CONFIG)).toBe("retry");
    // The retry's own write drops `retry`: nothing is owed after it.
    const spent = stampQuota(owed, EX, NOW + CONFIG.quotaPassRetryMs, false) as Task;
    expect(quotaDue(spent, EX, NOW + 10 * CONFIG.quotaPassRetryMs, CONFIG)).toBeNull();
    const plain = stampQuota(running(), EX, NOW, false) as Task;
    expect(quotaDue(plain, EX, NOW + 10 * CONFIG.quotaPassRetryMs, CONFIG)).toBeNull();
  });

  test.each([
    ["needs-input", { state: "needs-input" as const }],
    ["lost", { state: "lost" as const }],
    ["reserved", { state: "reserved" as const }],
    ["passed already", { successor: "next" }],
    ["run in place", { spec: spec({ mode: "here" }) }],
  ])("never acts on a task that is %s", (_name, fields) => {
    expect(quotaDue(running(fields), EX, NOW, CONFIG)).toBeNull();
  });

  test("nothing for a task that was never placed", () => {
    const { assignment: _assignment, ...unplaced } = running();
    expect(quotaDue(unplaced, EX, NOW, CONFIG)).toBeNull();
  });
});

describe("stampQuota", () => {
  test("stamps the window, with retry only when one is owed", () => {
    expect(stampQuota(running(), EX, NOW, false)?.quotaExhausted).toEqual({
      accountId: "org:a",
      window: "5h",
      reset: RESET,
      at: NOW,
    });
    expect(stampQuota(running(), EX, NOW, true)?.quotaExhausted).toMatchObject({ retry: true });
  });

  test("declines a task that is no longer running, so a write that lost a race stamps nothing", () => {
    expect(stampQuota(running({ state: "needs-input" }), EX, NOW, false)).toBeNull();
    expect(stampQuota(running({ successor: "next" }), EX, NOW, false)).toBeNull();
  });
});
