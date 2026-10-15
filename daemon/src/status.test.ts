import { describe, expect, test } from "bun:test";
import {
  APP_ID,
  importPsk,
  seal,
  STATUS_MAX_CT_LENGTH,
  toBase64,
  type MachineStatus,
  type Plain,
} from "@seance/shared";
import { fitStatus, STATUS_PAYLOAD_BUDGET, statusBytes } from "./status.ts";

const T = 1_760_000_000;

function quota(x: number): MachineStatus["quota"] extends readonly (infer Q)[] | undefined ? Q : never {
  return {
    x,
    h: 84,
    d: 41,
    hr: T + 3600,
    dr: T + 86_400,
    w: [{ m: "Fable", p: 25, r: T + 86_400 }],
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

describe("fitStatus", () => {
  test("a status within budget is handed back itself", () => {
    const four = status(4);
    expect(fitStatus(four)).toBe(four);
  });

  test("trims per-model windows, then reset stamps, then exclaves from the last index down, then quota", () => {
    const full = status(3);
    const noWindows = { ...full, quota: full.quota?.map(({ w: _w, ...rest }) => rest) };
    const noResets = { ...noWindows, quota: noWindows.quota?.map(({ hr: _hr, dr: _dr, ...rest }) => rest) };
    expect(fitStatus(full, statusBytes(noWindows))).toEqual(noWindows);
    expect(fitStatus(full, statusBytes(noResets))).toEqual(noResets);
    const twoLeft = fitStatus(full, statusBytes(noResets) - 1);
    expect(twoLeft.quota?.map((q) => q.x)).toEqual([0, 1]);
    const { quota: _quota, ...pressureOnly } = full;
    expect(fitStatus(full, statusBytes(pressureOnly))).toEqual(pressureOnly);
  });

  test("the budget is the relay's bound, measured through a real seal", async () => {
    // Exact at the edge: a payload of the budget seals to the bound, one more byte over it.
    expect(await sealedLength(exactly(STATUS_PAYLOAD_BUDGET))).toBe(STATUS_MAX_CT_LENGTH);
    expect(await sealedLength(exactly(STATUS_PAYLOAD_BUDGET + 1))).toBeGreaterThan(STATUS_MAX_CT_LENGTH);
    // Four exclaves with every field: the headroom the schema's short keys buy; five is over.
    expect(await sealedLength(status(4))).toBeLessThanOrEqual(STATUS_MAX_CT_LENGTH);
    expect(await sealedLength(status(5))).toBeGreaterThan(STATUS_MAX_CT_LENGTH);
    // A dozen, trimmed, always fits.
    const fitted = fitStatus(status(12));
    expect(fitted.quota?.length).toBeGreaterThan(0);
    expect(await sealedLength(fitted)).toBeLessThanOrEqual(STATUS_MAX_CT_LENGTH);
  });
});
