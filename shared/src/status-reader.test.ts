import { describe, expect, test } from "bun:test";
import {
  isQuotaTrimmed,
  isStatusStale,
  lastHeardAt,
  sanitizeStatus,
  STATUS_CLOCK_SKEW_MS,
  STATUS_STALE_MS,
} from "./status-reader.ts";
import type { MachineStatus, QuotaObservation } from "./types.ts";

const NOW_MS = 1_760_000_000_000;
const NOW_S = NOW_MS / 1000;

function observation(x: number, overrides: Partial<QuotaObservation> = {}): QuotaObservation {
  return {
    x,
    h: 40,
    d: 20,
    hr: NOW_S + 3600,
    w: [{ m: "Fable", p: 25, r: NOW_S + 86_400 }],
    s: "cache",
    at: NOW_S - 60,
    ...overrides,
  };
}

const status: MachineStatus = {
  at: NOW_S,
  scan: NOW_MS - 3_600_000,
  cpu: 12,
  mem: 60,
  disk: 40,
  free: 123_456,
  sess: [1, 0],
  quota: [observation(0), observation(1)],
};

describe("sanitizeStatus", () => {
  test("a consistent status comes back as itself", () => {
    expect(sanitizeStatus(status, 2, NOW_MS)).toBe(status);
    expect(sanitizeStatus({ at: NOW_S, scan: 1 }, 0, NOW_MS)).toEqual({ at: NOW_S, scan: 1 });
  });

  test("a percent over 100 is refused — pressure, quota windows and per-model caps", () => {
    expect(sanitizeStatus({ ...status, cpu: 101 }, 2, NOW_MS)).toBeNull();
    expect(sanitizeStatus({ ...status, disk: 100 }, 2, NOW_MS)).not.toBeNull();
    expect(sanitizeStatus({ ...status, quota: [observation(0, { h: 101 })] }, 2, NOW_MS)).toBeNull();
    expect(
      sanitizeStatus({ ...status, quota: [observation(0, { w: [{ m: "Fable", p: 250 }] })] }, 2, NOW_MS),
    ).toBeNull();
  });

  test("sess must hold one count per exclave of the register blob", () => {
    expect(sanitizeStatus(status, 3, NOW_MS)).toBeNull();
    expect(sanitizeStatus({ ...status, sess: [1] }, 2, NOW_MS)).toBeNull();
    const { sess: _sess, ...noSess } = status;
    expect(sanitizeStatus(noSess, 2, NOW_MS)).toBe(noSess);
  });

  test("a quota index must name an exclave, once", () => {
    expect(sanitizeStatus({ ...status, quota: [observation(2)] }, 2, NOW_MS)).toBeNull();
    expect(sanitizeStatus({ ...status, quota: [observation(1), observation(1)] }, 2, NOW_MS)).toBeNull();
  });

  test("entries kept plus entries trimmed cannot outnumber the exclaves", () => {
    expect(sanitizeStatus({ ...status, quota: [observation(0)], tr: 1 }, 2, NOW_MS)).not.toBeNull();
    expect(sanitizeStatus({ ...status, quota: [observation(0)], tr: 2 }, 2, NOW_MS)).toBeNull();
    const { quota: _quota, ...pressure } = status;
    expect(sanitizeStatus({ ...pressure, tr: 3 }, 2, NOW_MS)).toBeNull();
  });

  test("an observation stamped past clock skew is dropped alone, and the field goes with the last one", () => {
    const ahead = NOW_S + STATUS_CLOCK_SKEW_MS / 1000 + 1;
    const withinSkew = { ...status, quota: [observation(0, { at: NOW_S + 30 }), observation(1)] };
    expect(sanitizeStatus(withinSkew, 2, NOW_MS)).toBe(withinSkew);
    const sanitized = sanitizeStatus({ ...status, quota: [observation(0, { at: ahead }), observation(1)] }, 2, NOW_MS);
    expect(sanitized?.quota?.map((q) => q.x)).toEqual([1]);
    expect(sanitized?.cpu).toBe(12);
    const allAhead = sanitizeStatus({ ...status, quota: [observation(0, { at: ahead })] }, 2, NOW_MS);
    expect(allAhead).not.toBeNull();
    expect(allAhead).not.toHaveProperty("quota");
  });
});

describe("isStatusStale", () => {
  test("fresh within three beats, stale past them", () => {
    expect(isStatusStale(status, NOW_MS + STATUS_STALE_MS)).toBe(false);
    expect(isStatusStale(status, NOW_MS + STATUS_STALE_MS + 1000)).toBe(true);
  });

  test("a stamp further ahead than clock skew is not fresh — it would stay so for as long as it claims", () => {
    expect(isStatusStale(status, NOW_MS - STATUS_CLOCK_SKEW_MS)).toBe(false);
    expect(isStatusStale(status, NOW_MS - STATUS_CLOCK_SKEW_MS - 1000)).toBe(true);
  });
});

describe("isQuotaTrimmed", () => {
  test("any trim marks the quota incomplete, a detail-only trim included; no marker, no trim", () => {
    expect(isQuotaTrimmed(status)).toBe(false);
    expect(isQuotaTrimmed({ ...status, tr: 0 })).toBe(true);
    expect(isQuotaTrimmed({ ...status, tr: 2 })).toBe(true);
  });
});

describe("lastHeardAt", () => {
  test("a status beat newer than lastSeen wins, in milliseconds", () => {
    expect(lastHeardAt({ lastSeen: NOW_MS - 3 * 86_400_000, status: { ...status, at: NOW_S - 180 } })).toBe(
      NOW_MS - 180_000,
    );
  });

  test("no status falls back to lastSeen", () => {
    expect(lastHeardAt({ lastSeen: NOW_MS - 60_000 })).toBe(NOW_MS - 60_000);
  });

  test("a status older than a later register's lastSeen never wins", () => {
    expect(lastHeardAt({ lastSeen: NOW_MS - 5_000, status: { ...status, at: NOW_S - 600 } })).toBe(NOW_MS - 5_000);
  });
});
