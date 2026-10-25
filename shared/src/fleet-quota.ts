import { openAtRest, sealAtRest } from "./crypto.ts";
import { parseFleetQuotaEntry, parseFleetQuotaRecord, parseQuotaReading } from "./parse.ts";
import {
  APP_ID,
  AT_REST_OPS,
  FLEET_QUOTA_MAX_ACCOUNTS,
  FLEET_QUOTA_MAX_WINDOWS,
  FLEET_QUOTA_WINDOW_MODEL_MAX_LENGTH,
  QUOTA_CLOCK_SKEW_MS,
  QUOTA_KEY,
  type Envelope,
  type FleetQuotaEntry,
  type FleetQuotaRecord,
  type QuotaReading,
  type RecordUnreadable,
  type StoreRecord,
} from "./types.ts";

/**
 * The fleet quota record's own rules (DESIGN.md, Scheduler, "Fleet quota
 * record"): what a daemon writes into it, and how any reader opens it. The
 * fold that reads it beside `status` is `newestQuotaByAccount` (`quota.ts`).
 */

/** Why a stored `quota:fleet` record was not read: `RecordUnreadable`'s reasons that apply to it. */
export type FleetQuotaUnreadable = Extract<
  RecordUnreadable,
  "unopenable" | "malformed" | "version_mismatch" | "key_mismatch"
>;

/**
 * Opened at rest under op `quota`, sealed to `"app"`, parsed strictly, and its
 * sealed version the store's: a blob the relay moved from another version (an
 * old one put back) reads `version_mismatch`. Anyone with the PSK may write it,
 * so `from` is not checked — the record is readings, not authority.
 */
export async function openFleetQuotaRecord(
  key: CryptoKey,
  stored: StoreRecord,
): Promise<FleetQuotaRecord | FleetQuotaUnreadable> {
  if (stored.key !== QUOTA_KEY) return "key_mismatch";
  if (stored.env.to !== APP_ID) return "unopenable";
  let payload: unknown;
  try {
    payload = (await openAtRest(key, stored.env, AT_REST_OPS.quota)).payload;
  } catch {
    return "unopenable";
  }
  const record = parseFleetQuotaRecord(payload);
  if (record === null) return "malformed";
  return record.version === stored.version ? record : "version_mismatch";
}

/** Sealed from the writing daemon to `"app"`; the caller seals only what `parseFleetQuotaRecord` returned. */
export function sealFleetQuotaRecord(key: CryptoKey, from: string, record: FleetQuotaRecord): Promise<Envelope> {
  return sealAtRest(key, { to: APP_ID, from }, AT_REST_OPS.quota, record);
}

/**
 * `stored` with every `local` reading that is newer than its account's entry,
 * observed by `observer`; null when none is. Newer is a later `at`, or a stored
 * entry stamped more than `QUOTA_CLOCK_SKEW_MS` past `nowMs` — a fast clock's
 * reading would otherwise hold its account until the clock caught up.
 *
 * A replace, never a merge: an entry stored under a newer `at` with an older
 * reading's windows filled in would hide those windows' age, and
 * `mergeQuota`'s freshness rule for a window without a reset judges by it.
 * Readers merge raw candidates at read time instead.
 *
 * An account whose entry would not parse is skipped.
 *
 * Each written reading is bounded to the record's parse: windows with a model
 * name over `FLEET_QUOTA_WINDOW_MODEL_MAX_LENGTH` dropped, the
 * `FLEET_QUOTA_MAX_WINDOWS` fullest kept; past `FLEET_QUOTA_MAX_ACCOUNTS`
 * entries the newest are kept.
 */
export function withObservations(
  stored: readonly FleetQuotaEntry[],
  local: ReadonlyMap<string, QuotaReading>,
  observer: string,
  nowMs: number,
): FleetQuotaEntry[] | null {
  const next = new Map(stored.map((entry) => [entry.accountId, entry]));
  const replaced = new Set<string>();
  for (const [accountId, reading] of local) {
    const held = next.get(accountId);
    if (held !== undefined && reading.at <= held.reading.at && !aheadOf(held.reading, nowMs)) continue;
    const bounded = boundReading(reading);
    if (bounded === null) continue;
    const candidate = { accountId, observer, reading: bounded };
    // An id the record cannot hold (exclave account ids are not bounded where they are read) would fail the whole record's parse and stop the writer for every account.
    if (parseFleetQuotaEntry(candidate) === null) continue;
    next.set(accountId, candidate);
    replaced.add(accountId);
  }
  if (replaced.size === 0) return null;
  const result = newestFirstCapped([...next.values()]);
  return result.some((entry) => replaced.has(entry.accountId)) ? result : null;
}

/** An over-full record drops its oldest entries; the rest keep their order. */
function newestFirstCapped(entries: FleetQuotaEntry[]): FleetQuotaEntry[] {
  if (entries.length <= FLEET_QUOTA_MAX_ACCOUNTS) return entries;
  const newest = new Set(entries.toSorted((a, b) => b.reading.at - a.reading.at).slice(0, FLEET_QUOTA_MAX_ACCOUNTS));
  return entries.filter((entry) => newest.has(entry));
}

function aheadOf(reading: QuotaReading, nowMs: number): boolean {
  return reading.at * 1000 > nowMs + QUOTA_CLOCK_SKEW_MS;
}

/** Parsed (an exclave index or any other stray field goes) and held to the record's window bounds. */
function boundReading(reading: QuotaReading): QuotaReading | null {
  const parsed = parseQuotaReading(reading);
  if (parsed === null) return null;
  const { w, ...rest } = parsed;
  const windows = (w ?? [])
    .filter((window) => window.m.length <= FLEET_QUOTA_WINDOW_MODEL_MAX_LENGTH)
    .toSorted((a, b) => b.p - a.p)
    .slice(0, FLEET_QUOTA_MAX_WINDOWS);
  return windows.length === 0 ? rest : { ...rest, w: windows };
}
