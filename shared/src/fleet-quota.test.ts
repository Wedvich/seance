import { describe, expect, test } from "bun:test";
import { importPsk, sealAtRest, toBase64 } from "./crypto.ts";
import { openFleetQuotaRecord, sealFleetQuotaRecord, withObservations } from "./fleet-quota.ts";
import { parseFleetQuotaRecord } from "./parse.ts";
import {
  APP_ID,
  AT_REST_OPS,
  FLEET_QUOTA_MAX_ACCOUNTS,
  FLEET_QUOTA_MAX_WINDOWS,
  FLEET_QUOTA_WINDOW_MODEL_MAX_LENGTH,
  QUOTA_CLOCK_SKEW_MS,
  QUOTA_KEY,
  type FleetQuotaEntry,
  type FleetQuotaRecord,
  type QuotaReading,
} from "./types.ts";

const key = await importPsk(toBase64(new Uint8Array(32).fill(7)));
const otherKey = await importPsk(toBase64(new Uint8Array(32).fill(9)));

const S = 1_800_000_000;
const NOW = S * 1000;

const stored = (accountId: string, reading: QuotaReading, observer = "peer"): FleetQuotaEntry => ({
  accountId,
  observer,
  reading,
});

describe("withObservations", () => {
  test("only a reading newer than its account's entry is written, under the writer's id", () => {
    const record = [stored("org:a", { h: 10, s: "cache", at: S - 600 }), stored("org:b", { h: 20, s: "cache", at: S })];
    const local = new Map<string, QuotaReading>([
      ["org:a", { h: 30, s: "cache", at: S - 60 }],
      ["org:b", { h: 99, s: "cache", at: S - 60 }],
      ["org:c", { d: 5, s: "cache", at: S - 30 }],
    ]);
    expect(withObservations(record, local, "me", NOW)).toEqual([
      stored("org:a", { h: 30, s: "cache", at: S - 60 }, "me"),
      stored("org:b", { h: 20, s: "cache", at: S }),
      stored("org:c", { d: 5, s: "cache", at: S - 30 }, "me"),
    ]);
  });

  test("an account whose entry would not parse is skipped, the rest still written", () => {
    const local = new Map<string, QuotaReading>([
      ["x".repeat(129), { h: 10, s: "cache", at: S }],
      ["org:ok", { h: 20, s: "cache", at: S }],
    ]);
    const out = withObservations([], local, "me", NOW);
    expect(out).toEqual([stored("org:ok", { h: 20, s: "cache", at: S }, "me")]);
    expect(parseFleetQuotaRecord({ version: 1, accounts: out })).not.toBeNull();
    expect(withObservations([], new Map([["x".repeat(129), { h: 10, s: "cache", at: S }]]), "me", NOW)).toBeNull();
  });

  test("nothing newer is null — no write", () => {
    const record = [stored("org:a", { h: 10, s: "cache", at: S })];
    expect(withObservations(record, new Map([["org:a", { h: 50, s: "cache", at: S }]]), "me", NOW)).toBeNull();
    expect(withObservations(record, new Map(), "me", NOW)).toBeNull();
  });

  test("a newer reading replaces the entry whole: an older window is not carried under the newer stamp", () => {
    const record = [stored("org:a", { h: 80, s: "cache", at: S - 3600 })];
    const out = withObservations(record, new Map([["org:a", { d: 40, s: "cache", at: S }]]), "me", NOW);
    expect(out).toEqual([stored("org:a", { d: 40, s: "cache", at: S }, "me")]);
  });

  test("an entry stamped past the clock-skew bound yields to an honest older stamp", () => {
    const ahead = S + QUOTA_CLOCK_SKEW_MS / 1000 + 3600;
    const record = [stored("org:a", { h: 1, s: "cache", at: ahead })];
    const out = withObservations(record, new Map([["org:a", { h: 60, s: "cache", at: S - 60 }]]), "me", NOW);
    expect(out).toEqual([stored("org:a", { h: 60, s: "cache", at: S - 60 }, "me")]);
    // Inside the bound it is still a newer reading.
    const near = [stored("org:a", { h: 1, s: "cache", at: S + 30 })];
    expect(withObservations(near, new Map([["org:a", { h: 60, s: "cache", at: S - 60 }]]), "me", NOW)).toBeNull();
  });

  test("a reading is held to the record's bounds, and the result parses", () => {
    const long = "m".repeat(FLEET_QUOTA_WINDOW_MODEL_MAX_LENGTH + 1);
    const windows = [
      { m: long, p: 100 },
      ...Array.from({ length: FLEET_QUOTA_MAX_WINDOWS + 2 }, (_, i) => ({ m: `model${i}`, p: i * 10 })),
    ];
    // A stray exclave index from a status goes too.
    const reading = { x: 2, h: 5, w: windows, s: "cache", at: S } as const;
    const out = withObservations([], new Map([["org:a", reading]]), "me", NOW);
    const w = out?.[0]?.reading.w ?? [];
    expect(w.map((window) => window.m)).toEqual(["model5", "model4", "model3", "model2"]);
    expect(out?.[0]?.reading).not.toHaveProperty("x");
    expect(parseFleetQuotaRecord({ version: 1, accounts: out })).not.toBeNull();
  });

  test("past the account cap the oldest entries go, and a write that would only be dropped is null", () => {
    const full = Array.from({ length: FLEET_QUOTA_MAX_ACCOUNTS }, (_, i) =>
      stored(`org:${i}`, { h: 1, s: "cache", at: S - 1000 + i }),
    );
    const out = withObservations(full, new Map([["org:new", { h: 2, s: "cache", at: S }]]), "me", NOW);
    expect(out).toHaveLength(FLEET_QUOTA_MAX_ACCOUNTS);
    expect(out?.some((entry) => entry.accountId === "org:0")).toBe(false);
    expect(out?.at(-1)?.accountId).toBe("org:new");
    expect(withObservations(full, new Map([["org:old", { h: 2, s: "cache", at: S - 5000 }]]), "me", NOW)).toBeNull();
  });
});

describe("openFleetQuotaRecord", () => {
  const record: FleetQuotaRecord = { version: 3, accounts: [stored("org:a", { h: 10, s: "cache", at: S })] };

  test("round-trips through sealFleetQuotaRecord at the store's version", async () => {
    const env = await sealFleetQuotaRecord(key, "daemon-1", record);
    expect(await openFleetQuotaRecord(key, { key: QUOTA_KEY, version: 3, env })).toEqual(record);
  });

  test("every other blob is unreadable, with its reason", async () => {
    const env = await sealFleetQuotaRecord(key, "daemon-1", record);
    expect(await openFleetQuotaRecord(key, { key: "quota:other", version: 3, env })).toBe("key_mismatch");
    expect(await openFleetQuotaRecord(key, { key: QUOTA_KEY, version: 4, env })).toBe("version_mismatch");
    expect(await openFleetQuotaRecord(otherKey, { key: QUOTA_KEY, version: 3, env })).toBe("unopenable");
    const wrongOp = await sealAtRest(key, { to: APP_ID, from: "daemon-1" }, AT_REST_OPS.account, record);
    expect(await openFleetQuotaRecord(key, { key: QUOTA_KEY, version: 3, env: wrongOp })).toBe("unopenable");
    const wrongTo = await sealAtRest(key, { to: "scheduler", from: "daemon-1" }, AT_REST_OPS.quota, record);
    expect(await openFleetQuotaRecord(key, { key: QUOTA_KEY, version: 3, env: wrongTo })).toBe("unopenable");
    const junk = await sealAtRest(key, { to: APP_ID, from: "daemon-1" }, AT_REST_OPS.quota, { version: 3 });
    expect(await openFleetQuotaRecord(key, { key: QUOTA_KEY, version: 3, env: junk })).toBe("malformed");
  });
});
