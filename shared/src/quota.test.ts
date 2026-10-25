import { describe, expect, test } from "bun:test";
import {
  effectivePct,
  liveStatus,
  newestQuotaByAccount,
  type ExclaveInfo,
  type FleetQuotaEntry,
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

  // Only the cache reports credits; a session report one turn later must not
  // erase them, and nothing expires them but the month turning at 00:00 UTC.
  test("credits fill from a reading in the same UTC month, never from last month's", () => {
    const fill = (olderAt: number): number | undefined =>
      newestQuotaByAccount([
        host("tower", [exclave("work", "org:acct")], [{ x: 0, h: 100, s: "session", at: S }]),
        host("laptop", [exclave("main", "org:acct")], [{ x: 0, c: 42, s: "cache", at: olderAt }]),
      ]).get("org:acct")?.observation.c;
    // S is 2027-01-15T08:00Z.
    const firstOfMonth = Date.UTC(2027, 0, 1) / 1000;
    expect(fill(firstOfMonth)).toBe(42);
    expect(fill(firstOfMonth - 1)).toBeUndefined();
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

describe("newestQuotaByAccount with the fleet quota record", () => {
  const entry = (observer: string, reading: FleetQuotaEntry["reading"]): FleetQuotaEntry => ({
    accountId: "org:acct",
    observer,
    reading,
  });

  test("a record entry newer than every status wins, its observer standing in as the machine", () => {
    const newest = newestQuotaByAccount(
      [host("tower", [exclave("main", "org:acct")], [{ x: 0, h: 10, s: "cache", at: S - 600 }])],
      [entry("retired", { h: 70, s: "cache", at: S - 60 })],
    );
    expect(newest.get("org:acct")).toEqual({ observation: { h: 70, s: "cache", at: S - 60 }, deviceId: "retired" });
  });

  test("a status newer than the record wins, and a tie goes to the status", () => {
    const status: QuotaObservation = { x: 0, h: 40, s: "cache", at: S - 60 };
    const machines = [host("tower", [exclave("main", "org:acct")], [status])];
    expect(newestQuotaByAccount(machines, [entry("old", { h: 90, s: "cache", at: S - 600 })]).get("org:acct")).toEqual({
      observation: status,
      deviceId: "tower",
    });
    expect(newestQuotaByAccount(machines, [entry("twin", { h: 90, s: "cache", at: S - 60 })]).get("org:acct")).toEqual({
      observation: status,
      deviceId: "tower",
    });
  });

  test("an account only the record holds is known — a forgotten machine's reading survives it", () => {
    const newest = newestQuotaByAccount([], [entry("forgotten", { d: 33, s: "cache", at: S })]);
    expect(newest.get("org:acct")?.deviceId).toBe("forgotten");
  });

  test("windows merge across the record and statuses under the newest's stamp", () => {
    const newest = newestQuotaByAccount(
      [host("tower", [exclave("main", "org:acct")], [{ x: 0, h: 10, hr: S + 3600, s: "cache", at: S - 600 }])],
      [entry("laptop", { d: 50, dr: S + 86_400, s: "cache", at: S - 60 })],
    );
    expect(newest.get("org:acct")).toEqual({
      observation: { d: 50, dr: S + 86_400, h: 10, hr: S + 3600, s: "cache", at: S - 60 },
      deviceId: "laptop",
    });
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
