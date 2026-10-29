import { ATTACHMENT_ALLOWANCE, ATTACHMENT_MAX_OBJECT_BYTES } from "@seance/shared";
import { describe, expect, test } from "bun:test";
import { allowanceLimits, reserve, type HourBucket, type UploadVerdict } from "../src/allowance.ts";

const HOUR = 3_600_000;
const LIMITS = allowanceLimits({});
/** Some instant well into an hour, so retry waits are not whole hours. */
const T0 = 1_000_000 * HOUR + 15 * 60_000;

/** Replays uploads through `reserve` as the Hub does, carrying the stored buckets forward. */
function ledger(limits = LIMITS): {
  readonly upload: (bytes: number, at: number) => UploadVerdict;
  readonly stored: () => readonly HourBucket[];
} {
  let stored: readonly HourBucket[] = [];
  return {
    upload: (bytes, at) => {
      const { verdict, buckets } = reserve(stored, bytes, at, limits);
      if (buckets !== null) stored = buckets;
      return verdict;
    },
    stored: () => stored,
  };
}

describe("upload allowance", () => {
  test("production bounds are shared's, and overrides take only positive numbers", () => {
    expect(LIMITS).toEqual(ATTACHMENT_ALLOWANCE);
    expect(allowanceLimits({ windowBytes: "10", hourBytes: "0", hourUploads: "junk" })).toEqual({
      ...ATTACHMENT_ALLOWANCE,
      windowBytes: 10,
    });
  });

  test("the hour's bytes refuse until the next hour, then admit", () => {
    const { upload } = ledger();
    const perFile = ATTACHMENT_MAX_OBJECT_BYTES;
    const fits = Math.floor(ATTACHMENT_ALLOWANCE.hourBytes / perFile);
    for (let i = 0; i < fits; i += 1) expect(upload(perFile, T0)).toEqual({ ok: true });
    // 45 minutes to the top of the hour.
    expect(upload(perFile, T0)).toEqual({ ok: false, window: "hour", retryAfter: 45 * 60 });
    expect(upload(perFile, T0 + 45 * 60_000)).toEqual({ ok: true });
  });

  test("the hour's upload count refuses the 301st, whatever its size", () => {
    const { upload } = ledger();
    for (let i = 0; i < ATTACHMENT_ALLOWANCE.hourUploads; i += 1) expect(upload(28, T0).ok).toBe(true);
    expect(upload(28, T0)).toMatchObject({ ok: false, window: "hour" });
  });

  test("the month window covers any trailing 30 days, and reopens as its oldest hour ages out", () => {
    const { upload } = ledger();
    // 9 GB in the first hour, 0.5 GB ten days later: the window is full.
    for (let i = 0; i < 9; i += 1) expect(upload(1_000_000_000, T0 + i * HOUR).ok).toBe(true);
    expect(upload(500_000_000, T0 + 240 * HOUR).ok).toBe(true);
    const later = T0 + 300 * HOUR;
    const refused = upload(1, later);
    // The first GB (hour 0) leaves once 721 buckets no longer reach it: hour 721.
    expect(refused).toEqual({ ok: false, window: "month", retryAfter: (721 - 300) * 3600 - 15 * 60 });
    // One hour short of that, still within the window.
    expect(upload(1, T0 + 720 * HOUR)).toMatchObject({ ok: false, window: "month" });
    expect(upload(1, T0 + 721 * HOUR - 15 * 60_000)).toEqual({ ok: true });
  });

  test("the month bound outranks the hour's, and a refusal stores nothing", () => {
    const limits = allowanceLimits({ windowBytes: "100", hourBytes: "60" });
    const { upload, stored } = ledger(limits);
    expect(upload(60, T0).ok).toBe(true);
    expect(upload(30, T0 + HOUR).ok).toBe(true);
    const before = stored();
    // Over both: month, since its reopening also opens a fresh hour.
    expect(upload(61, T0 + HOUR)).toMatchObject({ ok: false, window: "month" });
    expect(stored()).toBe(before);
  });

  test("a reservation larger than the whole window waits one full window, never forever", () => {
    const { upload } = ledger(allowanceLimits({ windowBytes: "10" }));
    expect(upload(11, T0)).toEqual({ ok: false, window: "month", retryAfter: 721 * 3600 - 15 * 60 });
  });

  test("stored buckets are pruned to the window", () => {
    const { upload, stored } = ledger();
    expect(upload(28, T0).ok).toBe(true);
    expect(upload(28, T0 + 100 * HOUR).ok).toBe(true);
    expect(upload(28, T0 + 721 * HOUR).ok).toBe(true);
    const hour0 = Math.floor(T0 / HOUR);
    expect(stored().map(([index]) => index - hour0)).toEqual([100, 721]);
  });
});
