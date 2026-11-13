import { describe, expect, test } from "bun:test";
import {
  closedAt,
  exclaveAuth,
  exclaveTraitHealth,
  exclaveTraitUnchecked,
  isQuotaTrimmed,
  isStatusStale,
  lastHeardAt,
  sanitizeStatus,
  STATUS_CLOCK_SKEW_MS,
  STATUS_STALE_MS,
} from "./status-reader.ts";
import type { Machine } from "./app-client.ts";
import { CAPABILITIES, type MachineStatus, type QuotaObservation } from "./types.ts";

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

describe("closedAt", () => {
  test("reads the newest status's close, kept or live; null without one", () => {
    const asleep = { status: { ...status, cl: NOW_MS - 1_000 } };
    expect(closedAt(asleep)).toBe(NOW_MS - 1_000);
    expect(closedAt({ status })).toBeNull();
    expect(closedAt({})).toBeNull();
  });
});

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

describe("exclaveAuth", () => {
  const caps = [CAPABILITIES.authHealth];
  const machine = (
    over: Partial<MachineStatus>,
    extra: { connected?: boolean; capabilities?: readonly string[] } = {},
  ) => ({
    connected: extra.connected ?? true,
    capabilities: "capabilities" in extra ? extra.capabilities : caps,
    status: { ...status, ...over },
  });

  test("ok when the daemon advertises authHealth and lists the exclave nowhere", () => {
    expect(exclaveAuth(machine({}), 0, NOW_MS)).toEqual({ state: "ok" });
  });

  test("unknown for a disconnected machine, a stale status, a daemon without the capability and an au index", () => {
    expect(exclaveAuth(machine({ ax: [0] }, { connected: false }), 0, NOW_MS)).toEqual({ state: "unknown" });
    expect(exclaveAuth(machine({ ax: [0] }), 0, NOW_MS + STATUS_STALE_MS + 1000)).toEqual({ state: "unknown" });
    expect(exclaveAuth(machine({ ax: [0] }, { capabilities: [] }), 0, NOW_MS)).toEqual({ state: "unknown" });
    expect(exclaveAuth(machine({ ax: [0] }, { capabilities: undefined }), 0, NOW_MS)).toEqual({ state: "unknown" });
    expect(exclaveAuth({ connected: true, capabilities: caps }, 0, NOW_MS)).toEqual({ state: "unknown" });
    expect(exclaveAuth(machine({ au: [1] }), 1, NOW_MS)).toEqual({ state: "unknown" });
  });

  test("expired from ax, and from an ae time already past", () => {
    expect(exclaveAuth(machine({ ax: [1] }), 1, NOW_MS)).toEqual({ state: "expired" });
    expect(exclaveAuth(machine({ ae: [[1, NOW_S - 1]] }), 1, NOW_MS)).toEqual({ state: "expired" });
    expect(exclaveAuth(machine({ ae: [[1, NOW_S]] }), 1, NOW_MS)).toEqual({ state: "expired" });
  });

  test("expiring carries its expiry in milliseconds, for its own index only", () => {
    const m = machine({ ae: [[1, NOW_S + 3600]] });
    expect(exclaveAuth(m, 1, NOW_MS)).toEqual({ state: "expiring", expiresAt: NOW_MS + 3_600_000 });
    expect(exclaveAuth(m, 0, NOW_MS)).toEqual({ state: "ok" });
  });
});

describe("exclaveTraitHealth", () => {
  const exclaves = [
    { id: "default", authOk: true, traits: ["atlas", "az"] },
    { id: "work", authOk: true, traits: ["az"] },
    { id: "bare", authOk: true },
  ] as unknown as Machine["exclaves"];
  const machine = (over: Partial<MachineStatus>, extra: { connected?: boolean } = {}) => ({
    connected: extra.connected ?? true,
    exclaves,
    status: { ...status, ...over },
  });

  test("null for an exclave that does not carry the trait, or has no traits at all", () => {
    expect(exclaveTraitHealth(machine({ tf: [[1, 0]] }), 1, "atlas", NOW_MS)).toBeNull();
    expect(exclaveTraitHealth(machine({}), 2, "atlas", NOW_MS)).toBeNull();
    expect(exclaveTraitHealth(machine({}), 7, "atlas", NOW_MS)).toBeNull();
  });

  test("unknown on a disconnected machine and on a stale status, however the lists read", () => {
    expect(exclaveTraitHealth(machine({ tf: [[0, 0]] }, { connected: false }), 0, "atlas", NOW_MS)).toBe("unknown");
    expect(exclaveTraitHealth(machine({ tf: [[0, 0]] }), 0, "atlas", NOW_MS + STATUS_STALE_MS + 1000)).toBe("unknown");
    expect(exclaveTraitHealth({ connected: true, exclaves }, 0, "atlas", NOW_MS)).toBe("unknown");
  });

  test("unchecked only for a pair the live fresh status lists in tu", () => {
    const m = machine({ tu: [[1, 0]] });
    expect(exclaveTraitUnchecked(m, 1, "az", NOW_MS)).toBe(true);
    expect(exclaveTraitUnchecked(m, 0, "az", NOW_MS)).toBe(false);
    expect(exclaveTraitUnchecked(m, 2, "az", NOW_MS)).toBe(false);
    expect(exclaveTraitUnchecked(machine({ tu: [[1, 0]] }, { connected: false }), 1, "az", NOW_MS)).toBe(false);
    expect(exclaveTraitUnchecked(m, 1, "az", NOW_MS + STATUS_STALE_MS + 1000)).toBe(false);
    expect(exclaveTraitUnchecked({ connected: true, exclaves }, 1, "az", NOW_MS)).toBe(false);
  });

  test("failing from tf, unknown from tu, healthy otherwise — by the trait's index in that exclave", () => {
    const m = machine({ tf: [[0, 1]], tu: [[1, 0]] });
    expect(exclaveTraitHealth(m, 0, "az", NOW_MS)).toBe("failing");
    expect(exclaveTraitHealth(m, 0, "atlas", NOW_MS)).toBe("healthy");
    expect(exclaveTraitHealth(m, 1, "az", NOW_MS)).toBe("unknown");
    expect(exclaveTraitHealth(machine({}), 1, "az", NOW_MS)).toBe("healthy");
  });
});
