import { describe, expect, test } from "bun:test";
import {
  importPsk,
  openFleetQuotaRecord,
  QUOTA_KEY,
  RequestFailure,
  sealFleetQuotaRecord,
  toBase64,
  type ExclaveInfo,
  type FleetQuotaEntry,
  type MachineStatus,
  type QuotaReading,
  type StoreRecord,
  type StoreReplyFrame,
  type StoreRequestFrame,
} from "@seance/shared";
import {
  createFleetQuotaWriter,
  FLEET_QUOTA_STALL_MS,
  newestReadings,
  type FleetQuotaWriterOpts,
} from "./fleet-quota.ts";

const KEY = await importPsk(toBase64(new Uint8Array(32).fill(7)));
const OTHER_KEY = await importPsk(toBase64(new Uint8Array(32).fill(9)));
const S = 1_800_000_000;
const NOW = S * 1000;

/**
 * The relay's store for one key, as the daemon leg sees it: a get answers the
 * record, a put lands only at the version held. `answer` overrides a frame —
 * a reply, `undefined` to fall through, or a thrown `RequestFailure`.
 */
class FakeLeg {
  record: StoreRecord | null = null;
  readonly frames: StoreRequestFrame[] = [];
  answer: ((frame: StoreRequestFrame) => StoreReplyFrame | undefined) | null = null;

  store(frame: StoreRequestFrame): Promise<StoreReplyFrame | null> {
    this.frames.push(frame);
    const overridden = this.answer?.(frame);
    if (overridden !== undefined) return Promise.resolve(overridden);
    if (frame.t === "store-get") return Promise.resolve({ t: "store-record", re: frame.id, record: this.record });
    if (frame.t !== "store-put") return Promise.resolve({ t: "store-refused", re: frame.id, code: "invalid_request" });
    if ((this.record?.version ?? 0) !== frame.expect) {
      return Promise.resolve({ t: "store-refused", re: frame.id, code: "version_conflict" });
    }
    const version = frame.expect + 1;
    this.record = { key: frame.key, version, env: frame.env };
    return Promise.resolve({ t: "store-written", re: frame.id, version });
  }

  puts(): StoreRequestFrame[] {
    return this.frames.filter((frame) => frame.t === "store-put");
  }

  gets(): number {
    return this.frames.filter((frame) => frame.t === "store-get").length;
  }

  async opened(): Promise<readonly FleetQuotaEntry[]> {
    if (this.record === null) throw new Error("no record");
    const opened = await openFleetQuotaRecord(KEY, this.record);
    if (typeof opened === "string") throw new Error(`unreadable: ${opened}`);
    return opened.accounts;
  }
}

async function recordOf(version: number, accounts: readonly FleetQuotaEntry[], key = KEY): Promise<StoreRecord> {
  return { key: QUOTA_KEY, version, env: await sealFleetQuotaRecord(key, "peer", { version, accounts }) };
}

function writerOver(leg: FakeLeg, local: Map<string, QuotaReading>, overrides: Partial<FleetQuotaWriterOpts> = {}) {
  const warnings: string[] = [];
  let ready = true;
  const writer = createFleetQuotaWriter({
    leg,
    key: KEY,
    deviceId: "me",
    observations: () => local,
    ready: () => ready,
    now: () => NOW,
    intervalMs: 3_600_000,
    warn: (line) => void warnings.push(line),
    ...overrides,
  });
  return {
    writer,
    warnings,
    setReady: (next: boolean): void => {
      ready = next;
    },
  };
}

const HOUR_MS = 3_600_000;
const STALL_HOURS = FLEET_QUOTA_STALL_MS / HOUR_MS;
const clock = (): { readonly now: () => number; readonly advance: (ms: number) => void } => {
  let nowMs = NOW;
  return {
    now: () => nowMs,
    advance: (ms) => {
      nowMs += ms;
    },
  };
};

const reading = (at: number, h = 10): QuotaReading => ({ h, s: "cache", at });
const entry = (accountId: string, at: number, observer = "peer"): FleetQuotaEntry => ({
  accountId,
  observer,
  reading: reading(at),
});

describe("the fleet quota writer", () => {
  test("creates at expect 0 only when the store holds none, then overwrites at the version read", async () => {
    const leg = new FakeLeg();
    const local = new Map([["org:a", reading(S - 60)]]);
    const { writer } = writerOver(leg, local);
    await writer.flush();
    expect(leg.puts()).toMatchObject([{ expect: 0 }]);
    expect(await leg.opened()).toEqual([entry("org:a", S - 60, "me")]);

    leg.record = await recordOf(4, [entry("org:b", S - 30)]);
    local.set("org:a", reading(S - 10));
    await writer.flush();
    expect(leg.puts()).toMatchObject([{ expect: 0 }, { expect: 4 }]);
    expect(await leg.opened()).toEqual([entry("org:b", S - 30), entry("org:a", S - 10, "me")]);
  });

  test("writes nothing when not newer, and skips the read when nothing is newer than the last record seen", async () => {
    const leg = new FakeLeg();
    leg.record = await recordOf(2, [entry("org:a", S)]);
    const local = new Map([["org:a", reading(S - 60)]]);
    const { writer } = writerOver(leg, local);
    await writer.flush();
    expect(leg.gets()).toBe(1);
    expect(leg.puts()).toEqual([]);
    await writer.flush();
    expect(leg.gets()).toBe(1);
    local.set("org:a", reading(S + 1));
    await writer.flush();
    expect(leg.gets()).toBe(2);
    expect(leg.puts()).toMatchObject([{ expect: 2 }]);
  });

  test("a conflict re-reads and retries, and gives up after three", async () => {
    const leg = new FakeLeg();
    const local = new Map([["org:a", reading(S)]]);
    let conflicts = 1;
    leg.answer = (frame) => {
      if (frame.t !== "store-put" || conflicts === 0) return undefined;
      conflicts -= 1;
      return { t: "store-refused", re: frame.id, code: "version_conflict" };
    };
    const { writer, warnings } = writerOver(leg, local);
    await writer.flush();
    expect(leg.puts()).toHaveLength(2);
    expect(await leg.opened()).toEqual([entry("org:a", S, "me")]);

    leg.answer = (frame) =>
      frame.t === "store-put" ? { t: "store-refused", re: frame.id, code: "version_conflict" } : undefined;
    local.set("org:a", reading(S + 1));
    await writer.flush();
    expect(leg.puts()).toHaveLength(2 + 4);
    expect(warnings.filter((line) => line.includes("version conflicts"))).toHaveLength(1);
  });

  test("before its socket registered it sends nothing", async () => {
    const leg = new FakeLeg();
    const { writer, setReady } = writerOver(leg, new Map([["org:a", reading(S)]]));
    setReady(false);
    await writer.flush();
    expect(leg.frames).toEqual([]);
  });

  test("forbidden holds every cycle until the next register, whose retry lands", async () => {
    const leg = new FakeLeg();
    leg.answer = (frame) =>
      frame.t === "store-get" ? { t: "store-refused", re: frame.id, code: "forbidden" } : undefined;
    const { writer, warnings } = writerOver(leg, new Map([["org:a", reading(S)]]));
    await writer.flush();
    await writer.flush();
    expect(leg.frames).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    leg.answer = null;
    writer.registered();
    await writer.flush();
    expect(await leg.opened()).toEqual([entry("org:a", S, "me")]);
  });

  test("other refusals and a silent relay wait for the next interval, each code warned once", async () => {
    const leg = new FakeLeg();
    const local = new Map([["org:a", reading(S)]]);
    leg.answer = (frame) =>
      frame.t === "store-put" ? { t: "store-refused", re: frame.id, code: "rate_limited" } : undefined;
    const { writer, warnings } = writerOver(leg, local);
    await writer.flush();
    await writer.flush();
    expect(leg.puts()).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    leg.answer = () => {
      throw new RequestFailure("timeout", "no answer");
    };
    await writer.flush();
    leg.answer = null;
    await writer.flush();
    expect(await leg.opened()).toEqual([entry("org:a", S, "me")]);
  });

  test("the write budget holds however many cycles run", async () => {
    const leg = new FakeLeg();
    const local = new Map([["org:a", reading(S)]]);
    const { writer } = writerOver(leg, local, { writeBudget: { writes: 2, windowMs: 60_000 } });
    for (let at = 1; at <= 5; at += 1) {
      local.set("org:a", reading(S + at));
      await writer.flush();
    }
    expect(leg.puts()).toHaveLength(2);
  });

  test("an unreadable record whose version moves is never written, and warned once", async () => {
    const leg = new FakeLeg();
    let nowMs = NOW;
    const { writer, warnings } = writerOver(leg, new Map([["org:a", reading(S)]]), { now: () => nowMs });
    for (let version = 1; version <= 6; version += 1) {
      leg.record = await recordOf(version, [entry("org:b", S)], OTHER_KEY);
      nowMs += FLEET_QUOTA_STALL_MS / 2;
      await writer.flush();
    }
    expect(leg.puts()).toEqual([]);
    expect(warnings.filter((line) => line.includes("PSK or version mismatch"))).toHaveLength(1);
  });

  test("many reads of an unreadable record inside the stall window never overwrite it", async () => {
    const leg = new FakeLeg();
    leg.record = await recordOf(7, [entry("org:b", S)], OTHER_KEY);
    const { writer } = writerOver(leg, new Map([["org:a", reading(S)]]), { now: () => NOW });
    for (let cycle = 0; cycle < 20; cycle += 1) await writer.flush();
    expect(leg.puts()).toEqual([]);
  });

  test("an unreadable record unchanged across the stall window is overwritten at its version, and says so", async () => {
    const leg = new FakeLeg();
    leg.record = await recordOf(7, [entry("org:b", S)], OTHER_KEY);
    const nowMs = clock();
    const { writer, warnings } = writerOver(leg, new Map([["org:a", reading(S)]]), { now: nowMs.now });
    await writer.flush();
    for (let hours = 1; hours < STALL_HOURS; hours += 1) {
      nowMs.advance(HOUR_MS);
      await writer.flush();
    }
    expect(leg.puts()).toEqual([]);
    expect(warnings.filter((line) => line.includes("overwrote"))).toEqual([]);
    nowMs.advance(HOUR_MS);
    await writer.flush();
    expect(leg.puts()).toMatchObject([{ expect: 7 }]);
    expect(await leg.opened()).toEqual([entry("org:a", S, "me")]);
    expect(warnings.filter((line) => line.includes("overwrote"))).toHaveLength(1);
  });

  test("time asleep counts only up to twice the interval per gap", async () => {
    const leg = new FakeLeg();
    leg.record = await recordOf(7, [entry("org:b", S)], OTHER_KEY);
    const nowMs = clock();
    const { writer } = writerOver(leg, new Map([["org:a", reading(S)]]), { now: nowMs.now });
    await writer.flush();
    nowMs.advance(10 * FLEET_QUOTA_STALL_MS);
    await writer.flush();
    expect(leg.puts()).toEqual([]);
    // 2 h so far (the capped gap); 21 more hourly sightings reach 23 h, one more 24 h.
    for (let hours = 0; hours < STALL_HOURS - 3; hours += 1) {
      nowMs.advance(HOUR_MS);
      await writer.flush();
    }
    expect(leg.puts()).toEqual([]);
    nowMs.advance(HOUR_MS);
    await writer.flush();
    expect(leg.puts()).toMatchObject([{ expect: 7 }]);
  });

  test("an overwrite that writes nothing is not announced", async () => {
    const leg = new FakeLeg();
    leg.record = await recordOf(7, [entry("org:b", S)], OTHER_KEY);
    leg.answer = (frame) =>
      frame.t === "store-put" ? { t: "store-refused", re: frame.id, code: "rate_limited" } : undefined;
    const nowMs = clock();
    const { writer, warnings } = writerOver(leg, new Map([["org:a", reading(S)]]), { now: nowMs.now });
    await writer.flush();
    for (let hours = 0; hours < STALL_HOURS + 2; hours += 1) {
      nowMs.advance(HOUR_MS);
      await writer.flush();
    }
    expect(leg.puts().length).toBeGreaterThan(1);
    expect(warnings.filter((line) => line.includes("overwrote"))).toEqual([]);
  });

  test("a readable read in between restarts the stall clock", async () => {
    const leg = new FakeLeg();
    leg.record = await recordOf(7, [entry("org:b", S)], OTHER_KEY);
    const nowMs = clock();
    const local = new Map([["org:a", reading(S)]]);
    const { writer } = writerOver(leg, local, { now: nowMs.now });
    await writer.flush();
    for (let hours = 1; hours < STALL_HOURS; hours += 1) {
      nowMs.advance(HOUR_MS);
      await writer.flush();
    }
    // Readable and newer than ours: nothing is written, so only the read itself can reset the clock.
    leg.record = await recordOf(8, [entry("org:a", S + 100)]);
    nowMs.advance(HOUR_MS);
    await writer.flush();
    expect(leg.puts()).toEqual([]);
    // The same unreadable version as before the readable read: its clock starts over.
    leg.record = await recordOf(7, [entry("org:b", S)], OTHER_KEY);
    local.set("org:a", reading(S + 200));
    nowMs.advance(HOUR_MS);
    await writer.flush();
    expect(leg.puts()).toEqual([]);
    for (let hours = 1; hours < STALL_HOURS; hours += 1) {
      nowMs.advance(HOUR_MS);
      await writer.flush();
    }
    expect(leg.puts()).toEqual([]);
    nowMs.advance(HOUR_MS);
    await writer.flush();
    expect(leg.puts()).toMatchObject([{ expect: 7 }]);
  });

  test("forbidden on the put holds every cycle until the next register", async () => {
    const leg = new FakeLeg();
    const local = new Map([["org:a", reading(S)]]);
    leg.answer = (frame) =>
      frame.t === "store-put" ? { t: "store-refused", re: frame.id, code: "forbidden" } : undefined;
    const { writer, warnings } = writerOver(leg, local);
    await writer.flush();
    await writer.flush();
    expect(leg.puts()).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    leg.answer = null;
    writer.registered();
    await writer.flush();
    expect(await leg.opened()).toEqual([entry("org:a", S, "me")]);
  });

  test("the write budget resumes once its window has passed", async () => {
    const leg = new FakeLeg();
    const local = new Map([["org:a", reading(S)]]);
    let nowMs = NOW;
    const { writer } = writerOver(leg, local, { now: () => nowMs, writeBudget: { writes: 1, windowMs: 60_000 } });
    await writer.flush();
    local.set("org:a", reading(S + 1));
    await writer.flush();
    expect(leg.puts()).toHaveLength(1);
    nowMs += 60_000;
    await writer.flush();
    expect(leg.puts()).toHaveLength(2);
  });

  test("a refused or unanswered first read is spent: later samples wait for the interval", async () => {
    for (const failure of ["refused", "timeout"] as const) {
      const leg = new FakeLeg();
      leg.answer = (frame) => {
        if (failure === "timeout") throw new RequestFailure("timeout", "no answer");
        return { t: "store-refused", re: frame.id, code: "invalid_request" };
      };
      const { writer } = writerOver(leg, new Map([["org:a", reading(S)]]));
      writer.sampled();
      await writer.flush();
      const gets = leg.gets();
      expect(gets).toBeGreaterThanOrEqual(1);
      writer.sampled();
      writer.sampled();
      await writer.flush();
      // Only the explicit flush (the interval's stand-in) read again.
      expect(leg.gets()).toBe(gets + 1);
    }
  });

  test("a forbidden retry waits for a sample that names the register, however stale the snapshot at register", async () => {
    const leg = new FakeLeg();
    leg.answer = (frame) =>
      frame.t === "store-get" ? { t: "store-refused", re: frame.id, code: "forbidden" } : undefined;
    const local = new Map([["org:a", reading(S)]]);
    const { writer } = writerOver(leg, local);
    await writer.flush();
    leg.answer = null;
    // The register changed the scan: the snapshot still names the old blob, so no readings yet.
    local.clear();
    writer.registered();
    await writer.flush();
    expect(leg.frames).toHaveLength(1);
    local.set("org:a", reading(S));
    writer.sampled();
    await writer.flush();
    expect(await leg.opened()).toEqual([entry("org:a", S, "me")]);
  });

  test("sampled runs a cycle only while the first read is owed", async () => {
    const leg = new FakeLeg();
    const local = new Map<string, QuotaReading>();
    const { writer } = writerOver(leg, local);
    writer.sampled();
    await writer.flush();
    expect(leg.frames).toEqual([]);
    local.set("org:a", reading(S));
    writer.sampled();
    await writer.flush();
    expect(leg.puts()).toHaveLength(1);
    const gets = leg.gets();
    writer.sampled();
    await writer.flush();
    expect(leg.gets()).toBe(gets);
  });

  test("a successful write re-arms the warnings", async () => {
    const leg = new FakeLeg();
    const local = new Map([["org:a", reading(S)]]);
    const { writer, warnings } = writerOver(leg, local);
    leg.answer = (frame) =>
      frame.t === "store-put" ? { t: "store-refused", re: frame.id, code: "rate_limited" } : undefined;
    await writer.flush();
    leg.answer = null;
    await writer.flush();
    leg.answer = (frame) =>
      frame.t === "store-put" ? { t: "store-refused", re: frame.id, code: "rate_limited" } : undefined;
    local.set("org:a", reading(S + 1));
    await writer.flush();
    expect(warnings.filter((line) => line.includes("rate_limited"))).toHaveLength(2);
  });
});

describe("newestReadings", () => {
  const exclave = (id: string, accountId: string | null): ExclaveInfo => ({
    id,
    accountId,
    extraUsageEnabled: null,
    authOk: true,
    skills: [],
  });
  const info = [exclave("default", "org:a"), exclave("work", "org:a"), exclave("solo", "org:b"), exclave("out", null)];

  test("keeps each account's newest raw reading, a tie to the first exclave, and skips a signed-out one", () => {
    const status: MachineStatus = {
      at: S,
      scan: 5,
      quota: [
        { x: 0, h: 10, s: "cache", at: S - 60 },
        { x: 1, h: 20, s: "cache", at: S - 30 },
        { x: 2, h: 30, s: "cache", at: S - 10 },
        { x: 2, h: 31, s: "cache", at: S - 10 },
        { x: 3, h: 40, s: "cache", at: S },
        { x: 9, h: 50, s: "cache", at: S },
      ],
    };
    expect(newestReadings(status, 5, info)).toEqual(
      new Map([
        ["org:a", { h: 20, s: "cache", at: S - 30 }],
        ["org:b", { h: 30, s: "cache", at: S - 10 }],
      ]),
    );
  });

  test("a status naming another blob, or none yet, reads as no readings", () => {
    const status: MachineStatus = { at: S, scan: 4, quota: [{ x: 0, h: 10, s: "cache", at: S }] };
    expect(newestReadings(status, 5, info).size).toBe(0);
    expect(newestReadings(null, 5, info).size).toBe(0);
  });
});
