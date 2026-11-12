import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { nextSlotAt, startSlotTimer } from "./slot-timer.ts";

const SLOT_MS = 30_000;
const BASE_MS = 1_760_000_010_000; // on a 30 s slot

describe("nextSlotAt", () => {
  test("lands on the epoch-aligned slot, whatever the caller's own phase", () => {
    expect(nextSlotAt(BASE_MS + 7_123, SLOT_MS, 0, 0)).toBe(BASE_MS + SLOT_MS);
    expect(nextSlotAt(BASE_MS + 29_999, SLOT_MS, 0, 0)).toBe(BASE_MS + SLOT_MS);
  });

  test("a time on a slot is that slot when no delay is asked, the next when one is", () => {
    expect(nextSlotAt(BASE_MS, SLOT_MS, 0, 0)).toBe(BASE_MS);
    expect(nextSlotAt(BASE_MS, SLOT_MS, 0, 1)).toBe(BASE_MS + SLOT_MS);
  });

  test("the minimum delay pushes past a slot that is too close", () => {
    expect(nextSlotAt(BASE_MS + 25_000, SLOT_MS, 0, 10_000)).toBe(BASE_MS + 2 * SLOT_MS);
    // One full interval: never sooner than `setInterval` would have fired.
    const at = nextSlotAt(BASE_MS + 1, SLOT_MS, 0, SLOT_MS);
    expect(at).toBe(BASE_MS + 2 * SLOT_MS);
    expect(at - (BASE_MS + 1)).toBeLessThan(2 * SLOT_MS);
  });

  test("an offset shifts the slot within the interval", () => {
    expect(nextSlotAt(BASE_MS + 100, SLOT_MS, 1_000, 0)).toBe(BASE_MS + 1_000);
    expect(nextSlotAt(BASE_MS + 2_000, SLOT_MS, 1_000, 0)).toBe(BASE_MS + SLOT_MS + 1_000);
  });
});

describe("startSlotTimer", () => {
  // Fake, so a slot is an exact time rather than a real timer racing a loaded runner.
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE_MS);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test("two timers started out of phase fire on the same slots", () => {
    const intervalMs = 400;
    const fired: number[][] = [[], []];
    jest.setSystemTime(BASE_MS + 30);
    const stopA = startSlotTimer({ intervalMs, minFirstMs: 0 }, () => fired[0]?.push(Date.now()));
    jest.advanceTimersByTime(150);
    const stopB = startSlotTimer({ intervalMs, minFirstMs: 0 }, () => fired[1]?.push(Date.now()));
    jest.advanceTimersByTime(intervalMs * 3);
    stopA();
    stopB();
    // BASE_MS is on a 400 ms slot too.
    const slots = [1, 2, 3].map((k) => BASE_MS + k * intervalMs);
    expect(fired[0]).toEqual(slots);
    expect(fired[1]).toEqual(slots);
  });

  test("nothing fires before the first slot past `minFirstMs`, nor after stop", () => {
    let count = 0;
    const stop = startSlotTimer({ intervalMs: 100 }, () => (count += 1));
    jest.advanceTimersByTime(99);
    expect(count).toBe(0);
    jest.advanceTimersByTime(1);
    expect(count).toBe(1);
    stop();
    jest.advanceTimersByTime(250);
    expect(count).toBe(1);
  });
});
