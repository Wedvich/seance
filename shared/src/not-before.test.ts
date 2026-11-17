import { describe, expect, test } from "bun:test";
import {
  formatNotBefore,
  isNotBefore,
  nextClockTime,
  parseDateTime,
  parseDuration,
  resolveNotBefore,
} from "./not-before.ts";

describe("isNotBefore", () => {
  test("positive safe integers only", () => {
    expect(isNotBefore(1)).toBe(true);
    expect(isNotBefore(8.64e15)).toBe(true);
    expect(isNotBefore(8.64e15 + 1)).toBe(false);
    for (const v of [0, -1, 1.5, Number.NaN, Infinity, "1", 2 ** 53, null]) expect(isNotBefore(v)).toBe(false);
  });
});

describe("parseDuration", () => {
  test("valid", () => {
    expect(parseDuration("90m")).toBe(5_400_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d2h")).toBe(86_400_000 + 7_200_000);
  });
  test("invalid", () => {
    for (const v of ["", "0m", "2x", "m", "h", "99999999999999999999d"]) expect(parseDuration(v)).toBeNull();
  });
});

describe("nextClockTime", () => {
  const local = (h: number, m: number, d = 17): number => new Date(2026, 10, d, h, m, 0, 0).getTime();
  test("later today, else tomorrow, strictly after now", () => {
    expect(nextClockTime(21, 30, local(20, 0))).toBe(local(21, 30));
    expect(nextClockTime(21, 30, local(22, 0))).toBe(local(21, 30, 18));
    expect(nextClockTime(21, 30, local(21, 30))).toBe(local(21, 30, 18));
  });
});

describe("parseDateTime", () => {
  test("offsets", () => {
    const utc = Date.UTC(2026, 10, 18, 20, 30);
    expect(parseDateTime("2026-11-18T20:30:00Z", { requireOffset: true })).toBe(utc);
    expect(parseDateTime("2026-11-18T21:30:00+01:00", { requireOffset: true })).toBe(utc);
    expect(parseDateTime("2026-11-18 21:30+01:00", { requireOffset: true })).toBe(utc);
    expect(parseDateTime("2026-11-18T20:30:00.250Z", { requireOffset: true })).toBe(utc + 250);
  });
  test("local when no offset, refused when one is required", () => {
    expect(parseDateTime("2026-11-18T21:30", { requireOffset: false })).toBe(new Date(2026, 10, 18, 21, 30).getTime());
    expect(parseDateTime("2026-11-18T21:30", { requireOffset: true })).toBeNull();
  });
  test("range by round trip", () => {
    expect(parseDateTime("2026-02-30T10:00", { requireOffset: false })).toBeNull();
    expect(parseDateTime("2026-02-30T10:00Z", { requireOffset: true })).toBeNull();
    expect(parseDateTime("2026-11-18T25:00Z", { requireOffset: true })).toBeNull();
    expect(parseDateTime("2026-11-18T10:75", { requireOffset: false })).toBeNull();
    expect(parseDateTime("2026-11-18T10:60", { requireOffset: false })).toBeNull();
    expect(parseDateTime("2026-11-18T24:00", { requireOffset: false })).toBeNull();
    expect(parseDateTime("nope", { requireOffset: false })).toBeNull();
  });
});

describe("resolveNotBefore", () => {
  const now = new Date(2026, 10, 17, 22, 0, 0, 0).getTime();
  test("exclusive, and one required", () => {
    expect(resolveNotBefore({ at: "21:30", in: "1h" }, now).ok).toBe(false);
    expect(resolveNotBefore({}, now).ok).toBe(false);
    expect(resolveNotBefore({ in: "100000000d" }, 1_800_000_000_000).ok).toBe(false);
  });
  test("--in", () => {
    expect(resolveNotBefore({ in: "2h" }, now)).toEqual({ ok: true, at: now + 7_200_000 });
    expect(resolveNotBefore({ in: "x" }, now).ok).toBe(false);
  });
  test("a bare clock in the past is tomorrow", () => {
    expect(resolveNotBefore({ at: "21:30" }, now)).toEqual({
      ok: true,
      at: new Date(2026, 10, 18, 21, 30).getTime(),
    });
  });
  test("a past date-time is refused", () => {
    const r = resolveNotBefore({ at: "2026-11-17T10:00" }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("in the past");
    expect(resolveNotBefore({ at: "2026-11-18T10:00" }, now).ok).toBe(true);
  });
});

describe("formatNotBefore", () => {
  const at = Date.UTC(2026, 10, 18, 20, 30);
  test("literal in a pinned zone", () => {
    expect(formatNotBefore(at, "UTC")).toBe("Wed 18 Nov, 20:30");
    expect(formatNotBefore(at, "Europe/Oslo")).toBe("Wed 18 Nov, 21:30");
  });
  test("with offset", () => {
    expect(formatNotBefore(at, "Europe/Oslo", { withOffset: true })).toBe("Wed 18 Nov, 21:30 GMT+1");
    // The UTC label is ICU-dependent ("GMT", "GMT+0", "UTC"); the point is that one is there.
    expect(formatNotBefore(at, "UTC", { withOffset: true })).toMatch(/^Wed 18 Nov, 20:30 (GMT|UTC)(\+0)?$/u);
  });
});
