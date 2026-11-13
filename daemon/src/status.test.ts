import { describe, expect, test } from "bun:test";
import {
  APP_ID,
  importPsk,
  seal,
  STATUS_MAX_AUTH_EXPIRED,
  STATUS_MAX_CT_LENGTH,
  STATUS_MAX_TRAIT_PAIRS,
  toBase64,
  type MachineStatus,
  type Plain,
} from "@seance/shared";
import { fitStatus, type PaddedStatus, STATUS_PAYLOAD_BUDGET, statusBytes } from "./status.ts";

const T = 1_760_000_000;

function quota(x: number): MachineStatus["quota"] extends readonly (infer Q)[] | undefined ? Q : never {
  return {
    x,
    h: 84,
    d: 41,
    hr: T + 3600,
    dr: T + 86_400,
    w: [{ m: "Fable", p: 25, r: T + 86_400 }],
    c: 82,
    cu: 4104,
    cl: 5000,
    s: "cache",
    at: T,
  };
}

function status(exclaves: number): MachineStatus {
  return {
    at: T,
    scan: T * 1000,
    cpu: 12,
    mem: 60,
    disk: 40,
    free: 123_456,
    rd: 12,
    wr: 34,
    sess: Array.from({ length: exclaves }, (_, i) => i),
    quota: Array.from({ length: exclaves }, (_, i) => quota(i)),
  };
}

async function sealedLength(payload: MachineStatus): Promise<number> {
  const key = await importPsk(toBase64(new Uint8Array(32).fill(1)));
  const plain: Plain = { id: crypto.randomUUID(), ts: Date.now(), op: "status", payload };
  return (await seal(key, { to: APP_ID, from: "d".repeat(43) }, plain)).ct.length;
}

/** A status of exactly `bytes` — `sess` zeros pad it two bytes at a time, the first element fixes parity. */
function exactly(bytes: number): MachineStatus {
  const base: MachineStatus = { at: T, scan: T * 1000, sess: [] };
  const sess: number[] = (bytes - statusBytes(base)) % 2 === 1 ? [0] : [10];
  while (statusBytes({ ...base, sess }) < bytes) sess.push(0);
  const built = { ...base, sess };
  if (statusBytes(built) !== bytes) throw new Error(`padding missed ${bytes}`);
  return built;
}

/** The smallest budget `fitStatus` keeps `s` whole under: its bytes plus an empty filler's. */
function padded(s: MachineStatus): number {
  const empty: PaddedStatus = { ...s, _: "" };
  return statusBytes(empty);
}

function unpadded(s: PaddedStatus): MachineStatus {
  const { _: _filler, ...rest } = s;
  return rest;
}

describe("fitStatus", () => {
  test("a status within budget goes out whole and unmarked, padded to the budget with spaces", () => {
    const five = status(5);
    const fitted = fitStatus(five);
    expect(unpadded(fitted)).toEqual(five);
    expect(fitted.tr).toBeUndefined();
    expect(fitted._).toMatch(/^ *$/u);
    expect(statusBytes(fitted)).toBe(STATUS_PAYLOAD_BUDGET);
  });

  test("trims per-model windows, then reset stamps, then exclaves from the last index down, then quota — marking each", () => {
    const full = status(3);
    const noWindows = { ...full, quota: full.quota?.map(({ w: _w, ...rest }) => rest), tr: 0 };
    const noResets = { ...noWindows, quota: noWindows.quota?.map(({ hr: _hr, dr: _dr, ...rest }) => rest) };
    expect(unpadded(fitStatus(full, padded(noWindows)))).toEqual(noWindows);
    expect(unpadded(fitStatus(full, padded(noResets)))).toEqual(noResets);
    const twoLeft = fitStatus(full, padded(noResets) - 1);
    expect(twoLeft.quota?.map((q) => q.x)).toEqual([0, 1]);
    expect(twoLeft.tr).toBe(1);
    const oneLeft = fitStatus(full, padded({ ...noResets, quota: noResets.quota?.slice(0, 1), tr: 2 }));
    expect(oneLeft.quota?.map((q) => q.x)).toEqual([0]);
    expect(oneLeft.tr).toBe(2);
    const { quota: _quota, ...rest } = full;
    const pressureOnly = { ...rest, tr: 3 };
    expect(unpadded(fitStatus(full, padded(pressureOnly)))).toEqual(pressureOnly);
    // However tight the step, the result lands on the budget exactly.
    for (const budget of [padded(noWindows), padded(noResets) - 1, padded(pressureOnly)]) {
      expect(statusBytes(fitStatus(full, budget))).toBe(budget);
    }
  });

  test("the auth lists are never trimmed: routing reads them when every quota field is gone", () => {
    const auth: MachineStatus = { ...status(3), ax: [1], ae: [[2, 1_760_000_000]], au: [0] };
    const { quota: _quota, ...rest } = auth;
    const fitted = fitStatus(auth, padded({ ...rest, tr: 3 }));
    expect(fitted.quota).toBeUndefined();
    expect(fitted.ax).toEqual([1]);
    expect(fitted.ae).toEqual([[2, 1_760_000_000]]);
    expect(fitted.au).toEqual([0]);
    const crowded = fitStatus({ ...auth, sess: Array.from({ length: 600 }, () => 9) });
    expect(crowded.sess).toBeUndefined();
    expect(crowded.ax).toEqual([1]);
    expect(crowded.ae).toEqual([[2, 1_760_000_000]]);
    expect(crowded.au).toEqual([0]);
  });

  test("the trait probe lists are never trimmed either, beside auth lists at their bounds", () => {
    const pairs = (n: number, trait: number): [number, number][] => Array.from({ length: n }, (_, x) => [x, trait]);
    const traits: MachineStatus = { ...status(3), tf: pairs(3, 0), tu: [[1, 1]], ax: [1] };
    const { quota: _quota, ...rest } = traits;
    const fitted = fitStatus(traits, padded({ ...rest, tr: 3 }));
    expect(fitted.quota).toBeUndefined();
    expect(fitted.tf).toEqual(pairs(3, 0));
    expect(fitted.tu).toEqual([[1, 1]]);
    // Both bounded lists whole at once: 16 auth entries and 16 trait pairs (tf and tu together).
    const ae = Array.from({ length: STATUS_MAX_AUTH_EXPIRED }, (_, x): [number, number] => [x, 1_999_999_999]);
    const tf = pairs(STATUS_MAX_TRAIT_PAIRS - 4, 123);
    const tu = pairs(4, 456);
    const worst = fitStatus({ ...status(12), ae, tf, tu, sess: Array.from({ length: 600 }, () => 9) });
    expect(worst.ae).toEqual(ae);
    expect(worst.tf).toEqual(tf);
    expect(worst.tu).toEqual(tu);
    expect(worst.sess).toBeUndefined();
    expect(statusBytes(worst)).toBe(STATUS_PAYLOAD_BUDGET);
  });

  test("the worst case — 16 expiring exclaves, full quota, a huge sess — keeps every entry and lands on the budget", () => {
    const ae = Array.from({ length: STATUS_MAX_AUTH_EXPIRED }, (_, x): [number, number] => [x, 1_999_999_999]);
    const worst = fitStatus({ ...status(12), ae, sess: Array.from({ length: 600 }, () => 9) });
    expect(worst.ae).toEqual(ae);
    expect(worst.sess).toBeUndefined();
    expect(statusBytes(worst)).toBe(STATUS_PAYLOAD_BUDGET);
  });

  test("the drain flag is never trimmed: routing reads it when quota and sess are gone", () => {
    const drained = { ...status(3), drn: true as const };
    const { quota: _quota, ...rest } = drained;
    const fitted = fitStatus(drained, padded({ ...rest, tr: 3 }));
    expect(fitted.quota).toBeUndefined();
    expect(fitted.drn).toBe(true);
    const crowded = fitStatus({ ...drained, sess: Array.from({ length: 600 }, () => 9) });
    expect(crowded.sess).toBeUndefined();
    expect(crowded.drn).toBe(true);
    expect(statusBytes(crowded)).toBe(STATUS_PAYLOAD_BUDGET);
  });

  test("the closed time is never trimmed: a trimmed one would read as open", () => {
    const closed = { ...status(3), cl: 1_763_000_000_000 };
    const crowded = fitStatus({ ...closed, sess: Array.from({ length: 600 }, () => 9) });
    expect(crowded.sess).toBeUndefined();
    expect(crowded.cl).toBe(1_763_000_000_000);
    expect(statusBytes(crowded)).toBe(STATUS_PAYLOAD_BUDGET);
    expect(fitStatus(closed, padded({ ...closed, quota: undefined, tr: 3 })).cl).toBe(1_763_000_000_000);
  });

  test("an exclave list too long even for sess still says it was trimmed", () => {
    const huge = { ...status(1), sess: Array.from({ length: 600 }, () => 9) };
    const fitted = fitStatus(huge);
    expect(fitted.sess).toBeUndefined();
    expect(fitted.tr).toBe(1);
    expect(statusBytes(fitted)).toBe(STATUS_PAYLOAD_BUDGET);
  });

  test("the budget is the relay's bound, measured through a real seal", async () => {
    // Exact at the edge: a payload of the budget seals to the bound, one more byte over it.
    expect(await sealedLength(exactly(STATUS_PAYLOAD_BUDGET))).toBe(STATUS_MAX_CT_LENGTH);
    expect(await sealedLength(exactly(STATUS_PAYLOAD_BUDGET + 1))).toBeGreaterThan(STATUS_MAX_CT_LENGTH);
    // Six exclaves with every field: the headroom the schema's short keys buy. Seven lose
    // only the per-model windows — the credits, which routing reads, are never trimmed alone.
    expect(fitStatus(status(6)).tr).toBeUndefined();
    const seven = fitStatus(status(7));
    expect(seven.tr).toBe(0);
    expect(seven.quota?.every((q) => q.cu !== undefined && q.hr !== undefined && q.w === undefined)).toBe(true);
    // A dozen, trimmed, always fits.
    const fitted = fitStatus(status(12));
    expect(fitted.quota?.length).toBeGreaterThan(0);
    expect(await sealedLength(fitted)).toBe(STATUS_MAX_CT_LENGTH);
  });

  test("every status seals to one length, so the ciphertext says nothing about what it holds", async () => {
    const minimal: MachineStatus = { at: T, scan: T * 1000 };
    const busy: MachineStatus = { ...status(4), cpu: 100, rd: 987_654, wr: 876_543 };
    const lengths = await Promise.all([minimal, status(1), busy, status(12)].map((s) => sealedLength(fitStatus(s))));
    expect(new Set(lengths)).toEqual(new Set([STATUS_MAX_CT_LENGTH]));
  });
});
