import { describe, expect, test } from "bun:test";
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
  test("two timers started out of phase fire on the same slots", async () => {
    const intervalMs = 400;
    const fired: number[][] = [[], []];
    const stopA = startSlotTimer({ intervalMs, minFirstMs: 0 }, () => fired[0]?.push(Date.now()));
    await Bun.sleep(150);
    const stopB = startSlotTimer({ intervalMs, minFirstMs: 0 }, () => fired[1]?.push(Date.now()));
    await Bun.sleep(intervalMs * 3);
    stopA();
    stopB();
    const slotsOf = (times: readonly number[] | undefined): number[] =>
      (times ?? []).map((t) => Math.floor(t / intervalMs));
    const [a, b] = [slotsOf(fired[0]), slotsOf(fired[1])];
    expect(b.length).toBeGreaterThanOrEqual(2);
    for (const slot of b) expect(a).toContain(slot);
    // Each fires within its slot, not a whole phase away.
    for (const t of [...(fired[0] ?? []), ...(fired[1] ?? [])]) expect(t % intervalMs).toBeLessThan(intervalMs / 2);
  });

  test("nothing fires before the first slot past `minFirstMs`, nor after stop", async () => {
    let count = 0;
    const stop = startSlotTimer({ intervalMs: 100 }, () => (count += 1));
    await Bun.sleep(90); // a non-event can't be polled
    expect(count).toBe(0);
    stop();
    await Bun.sleep(250); // a non-event can't be polled
    expect(count).toBe(0);
  });
});
