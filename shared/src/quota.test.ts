import { describe, expect, test } from "bun:test";
import {
  effectivePct,
  liveStatus,
  newestQuotaByAccount,
  type ExclaveInfo,
  type Machine,
  type QuotaObservation,
} from "./index.ts";

const S = 1_800_000_000;

function exclave(id: string, accountId: string | null): ExclaveInfo {
  return { id, accountId, extraUsageEnabled: null, authOk: accountId !== null, skills: [] };
}

function host(
  deviceId: string,
  exclaves: readonly ExclaveInfo[],
  quota: readonly QuotaObservation[],
): Pick<Machine, "deviceId" | "exclaves" | "status"> {
  return { deviceId, exclaves, status: { at: S, scan: 1, quota } };
}

describe("newestQuotaByAccount", () => {
  test("an account seen on two machines takes the newer observation, wherever it sits in the fleet", () => {
    const newer: QuotaObservation = { x: 1, h: 50, s: "cache", at: S - 60 };
    const newest = newestQuotaByAccount([
      host("a", [exclave("main", "org:acct")], [{ x: 0, h: 10, s: "cache", at: S - 600 }]),
      host("b", [exclave("other", "org:else"), exclave("work", "org:acct")], [newer]),
      host("c", [exclave("late", "org:acct")], [{ x: 0, h: 90, s: "cache", at: S - 3600 }]),
    ]);
    expect(newest.get("org:acct")).toEqual({ observation: newer, deviceId: "b" });
  });

  // `/usage` on the laptop cached the Fable cap; the tower's newer cache never
  // saw it. The tower's 5h/7d win, the laptop's Fable window survives.
  test("windows the newest observation lacks come from the next newest that has them", () => {
    const newest = newestQuotaByAccount([
      host(
        "laptop",
        [exclave("main", "org:acct")],
        [{ x: 0, h: 10, hr: S + 60, d: 20, w: [{ m: "Fable", p: 30, r: S + 99 }], s: "cache", at: S - 600 }],
      ),
      host("tower", [exclave("work", "org:acct")], [{ x: 0, h: 40, d: 28, s: "cache", at: S - 60 }]),
      host(
        "old",
        [exclave("main", "org:acct")],
        [
          {
            x: 0,
            w: [
              { m: "Fable", p: 5 },
              { m: "Next", p: 7 },
            ],
            s: "cache",
            at: S - 3600,
          },
        ],
      ),
    ]);
    expect(newest.get("org:acct")).toEqual({
      // The tower's `h` keeps no reset rather than borrowing the laptop's `hr`.
      observation: {
        x: 0,
        h: 40,
        d: 28,
        w: [
          { m: "Fable", p: 30, r: S + 99 },
          { m: "Next", p: 7 },
        ],
        s: "cache",
        at: S - 60,
      },
      deviceId: "tower",
    });
  });

  // Nothing expires a window with no reset, and filled it would wear the newer
  // reading's stamp, so only a reading under one window length older fills it.
  test("a reset-less window is filled only from a reading less than one window length older", () => {
    const newest = newestQuotaByAccount([
      host("tower", [exclave("work", "org:acct")], [{ x: 0, s: "cache", at: S }]),
      host(
        "asleep",
        [exclave("main", "org:acct")],
        [
          {
            x: 0,
            h: 99,
            d: 98,
            w: [
              { m: "Fable", p: 97 },
              { m: "Next", p: 96, r: S - 1 },
            ],
            s: "cache",
            at: S - 8 * 86_400,
          },
        ],
      ),
      host("laptop", [exclave("main", "org:acct")], [{ x: 0, h: 50, d: 40, s: "cache", at: S - 6 * 3_600 }]),
    ]);
    expect(newest.get("org:acct")?.observation).toEqual({
      x: 0,
      d: 40,
      w: [{ m: "Next", p: 96, r: S - 1 }],
      s: "cache",
      at: S,
    });
  });

  test("a tie keeps the first machine in fleet order", () => {
    const newest = newestQuotaByAccount([
      host("a", [exclave("one", "org:acct")], [{ x: 0, h: 10, s: "cache", at: S }]),
      host("b", [exclave("two", "org:acct")], [{ x: 0, h: 20, s: "session", at: S }]),
    ]);
    expect(newest.get("org:acct")?.deviceId).toBe("a");
  });

  test("a signed-out exclave and an out-of-range index contribute nothing, and leave the account unknown", () => {
    const newest = newestQuotaByAccount([
      host(
        "a",
        [exclave("signed-out", null), exclave("main", "org:acct")],
        [
          { x: 0, h: 99, s: "cache", at: S },
          { x: 2, h: 99, s: "cache", at: S },
          { x: -1, h: 99, s: "cache", at: S },
        ],
      ),
    ]);
    expect([...newest.keys()]).toEqual([]);
  });

  // Quota is the observation's, pressure the machine's (docs/scheduler.md,
  // "Quota freshness"): the asleep laptop saw the account last, so its kept
  // reading wins over an older live one — while its pressure is unknown.
  test("an asleep machine's kept status folds like a live one, and reads as no pressure", () => {
    const kept: QuotaObservation = { x: 0, h: 70, s: "cache", at: S - 60 };
    const asleep = { ...host("laptop", [exclave("main", "org:acct")], [kept]), connected: false };
    const awake = {
      ...host("tower", [exclave("work", "org:acct")], [{ x: 0, h: 5, s: "cache", at: S - 3600 }]),
      connected: true,
    };
    expect(newestQuotaByAccount([awake, asleep]).get("org:acct")).toEqual({ observation: kept, deviceId: "laptop" });
    expect(liveStatus(asleep)).toBeUndefined();
    expect(liveStatus(awake)).toBe(awake.status);
  });

  test("a machine with no status or no exclave list names no numbers", () => {
    const newest = newestQuotaByAccount([
      { deviceId: "asleep", exclaves: [exclave("main", "org:acct")] },
      { deviceId: "old", status: { at: S, scan: 1, quota: [{ x: 0, h: 99, s: "cache", at: S }] } },
    ]);
    expect(newest.size).toBe(0);
  });
});

describe("effectivePct", () => {
  const now = S * 1000;

  test("a window past its reset reads 0, however full the reading was", () => {
    expect(effectivePct(100, S - 1, now)).toBe(0);
    // The reset instant itself has passed: the window it described is gone.
    expect(effectivePct(100, S, now)).toBe(0);
  });

  test("a window still running, or with no reset known, reads as reported", () => {
    expect(effectivePct(73, S + 1, now)).toBe(73);
    expect(effectivePct(73, undefined, now)).toBe(73);
  });
});
