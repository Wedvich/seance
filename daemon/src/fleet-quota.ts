import {
  FLEET_QUOTA_INTERVAL_MS,
  openFleetQuotaRecord,
  parseFleetQuotaRecord,
  QUOTA_KEY,
  RequestFailure,
  sealFleetQuotaRecord,
  STORE_CREATE_MAX_CT_LENGTH,
  STORE_MAX_CT_LENGTH,
  withObservations,
  type ExclaveInfo,
  type FleetQuotaEntry,
  type MachineStatus,
  type QuotaReading,
  type StoreRecord,
  type StoreReplyFrame,
} from "@seance/shared";
import { log } from "./log.ts";
import type { StoreLeg } from "./queue-store.ts";

/**
 * This daemon's writes into the fleet quota record (DESIGN.md, Scheduler,
 * "Fleet quota record"): read, open, fold in its own newer readings, put at
 * the version read. Runs only inside `startDaemon` — it logs through
 * `log.ts`, which nothing reachable from `seanced mcp` may call — and never
 * logs a key's `env` or `ct`.
 */

/**
 * Awake observation time an unreadable record must stand unchanged, at one
 * store version, before this writer overwrites it. A moving version means a
 * daemon that can read it is still writing it (a straggler on another PSK or
 * build), and overwriting it there would have the two wipe each other every
 * cycle. Time, not reads: register-triggered reads would shorten a count, and
 * an idle legitimate writer (no newer reading for a while) must not read as
 * dead. Each gap between sightings counts at most twice the writer interval,
 * so a fleet asleep over a weekend gives a straggler its window on waking.
 */
export const FLEET_QUOTA_STALL_MS = 24 * 3_600_000;

/** Re-reads after a `version_conflict` before the cycle gives up until the next. */
const CONFLICT_RETRIES = 3;

/**
 * Puts this writer may send per window, whatever the cadence: a reconnect loop
 * or a run of conflicts must not spend the relay's write floor.
 */
export const FLEET_QUOTA_WRITE_BUDGET = { writes: 6, windowMs: 60_000 } as const;

export interface FleetQuotaWriterOpts {
  /** This daemon's own socket (`RelayClient.store`): `quota:` is not term-fenced, so any registered socket writes it. */
  readonly leg: StoreLeg;
  readonly key: CryptoKey;
  readonly deviceId: string;
  /** The newest raw reading per account this daemon holds now — never a merge (`withObservations`). */
  readonly observations: () => ReadonlyMap<string, QuotaReading>;
  /** `RelayClient.registered`: the relay answers no store frame on a socket before its register. */
  readonly ready: () => boolean;
  readonly now: () => number;
  readonly intervalMs?: number;
  readonly writeBudget?: { readonly writes: number; readonly windowMs: number };
  /** Defaults to `log.warn`; tests read what was warned. */
  readonly warn?: (line: string) => void;
}

export interface FleetQuotaWriter {
  readonly start: () => void;
  readonly stop: () => void;
  /**
   * A register left this daemon's socket. After a `forbidden` (the socket the
   * relay now knows may be allowed) it owes one retry, run by the next
   * `sampled` — the register may have changed the scan the snapshot still
   * names. Never a cycle on every redial.
   */
  readonly registered: () => void;
  /**
   * The status loop sampled against the current register blob. Runs a cycle
   * only while a read is owed — the first since start, or the retry after a
   * `forbidden`: at register the snapshot still names the previous blob (at
   * boot, none), so the readings the writer folds in arrive with this sample,
   * not with the register. An owed read is spent by one that got an answer
   * (a refusal included) or timed out; after that the interval retries.
   */
  readonly sampled: () => void;
  /** One cycle now, after any in flight; resolves when it is done. */
  readonly flush: () => Promise<void>;
}

/**
 * The newest raw reading per account in `status` — what the writer folds in —
 * keyed through the register blob `status` indexes into (`info[x]`); a tie
 * goes to the first exclave. Empty when `status` names another blob than
 * `scan`, since its indices would point into the wrong list.
 */
export function newestReadings(
  status: MachineStatus | null,
  scan: number,
  info: readonly ExclaveInfo[],
): ReadonlyMap<string, QuotaReading> {
  const readings = new Map<string, QuotaReading>();
  if (status === null || status.scan !== scan) return readings;
  for (const { x, ...reading } of status.quota ?? []) {
    const accountId = info[x]?.accountId;
    if (accountId === null || accountId === undefined) continue;
    const held = readings.get(accountId);
    if (held === undefined || reading.at > held.at) readings.set(accountId, reading);
  }
  return readings;
}

type Outcome = "done" | "conflict";

export function createFleetQuotaWriter(opts: FleetQuotaWriterOpts): FleetQuotaWriter {
  const intervalMs = opts.intervalMs ?? FLEET_QUOTA_INTERVAL_MS;
  const budget = opts.writeBudget ?? FLEET_QUOTA_WRITE_BUDGET;
  const warn = opts.warn ?? ((line: string): void => log.warn(line));
  const warned = new Set<string>();
  const warnOnce = (code: string, line: string): void => {
    if (warned.has(code)) return;
    warned.add(code);
    warn(line);
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  /** What the last read (or this writer's own write) showed; null when it showed nothing readable. */
  let lastSeen: readonly FleetQuotaEntry[] | null = null;
  let firstReadOwed = true;
  let forbidden = false;
  let retryOwed = false;
  /** An unreadable record's store version, the awake time it has stood there, and the last sighting. */
  let stalled: { readonly version: number; readonly awakeMs: number; readonly seenMs: number } | null = null;
  const puts: number[] = [];

  const withinBudget = (): boolean => {
    const since = opts.now() - budget.windowMs;
    while (puts.length > 0 && (puts[0] ?? 0) <= since) puts.shift();
    return puts.length < budget.writes;
  };

  const spendOwedRead = (): void => {
    firstReadOwed = false;
    retryOwed = false;
  };

  /** Null when nothing answered or the answer was a refusal (handled here). */
  const read = async (): Promise<{ readonly record: StoreRecord | null } | null> => {
    let reply: StoreReplyFrame | null;
    try {
      reply = await opts.leg.store({ t: "store-get", id: crypto.randomUUID(), key: QUOTA_KEY });
    } catch (err) {
      if (err instanceof RequestFailure && err.reason === "timeout") spendOwedRead();
      throw err;
    }
    spendOwedRead();
    if (reply?.t === "store-record") return { record: reply.record };
    if (reply?.t === "store-refused") refused(reply.code);
    return null;
  };

  const refused = (code: string): void => {
    if (code === "forbidden") {
      forbidden = true;
      warnOnce(
        code,
        `fleet quota: the relay refused this socket's store frames (forbidden); retrying after the next register`,
      );
      return;
    }
    warnOnce(code, `fleet quota: the relay refused the record (${code}); retrying each interval`);
  };

  /** The base to fold into and the version to put at, or null when this cycle writes nothing. */
  const baseOf = async (
    record: StoreRecord | null,
  ): Promise<{
    readonly accounts: readonly FleetQuotaEntry[];
    readonly expect: number;
    /** Set when the put overwrites an unreadable record: logged once it lands. */
    readonly overwriting?: string;
  } | null> => {
    if (record === null) {
      stalled = null;
      return { accounts: [], expect: 0 };
    }
    const opened = await openFleetQuotaRecord(opts.key, record);
    if (typeof opened !== "string") {
      stalled = null;
      warned.delete("unreadable");
      return { accounts: opened.accounts, expect: record.version };
    }
    const nowMs = opts.now();
    stalled =
      stalled?.version === record.version
        ? { ...stalled, awakeMs: stalled.awakeMs + Math.min(nowMs - stalled.seenMs, 2 * intervalMs), seenMs: nowMs }
        : { version: record.version, awakeMs: 0, seenMs: nowMs };
    if (stalled.awakeMs < FLEET_QUOTA_STALL_MS) {
      warnOnce(
        "unreadable",
        `fleet quota: the stored record does not open here (${opened}) — probably a PSK or version mismatch; ` +
          `left alone while another daemon keeps writing it`,
      );
      return null;
    }
    // Unchanged across the stall window: nobody who can read it is writing it,
    // and with no deletes on `quota:` it would otherwise hold the slot for good.
    return {
      accounts: [],
      expect: record.version,
      overwriting: `fleet quota: overwrote the stored record, unreadable here (${opened}) and unchanged at version ${record.version} for ${Math.round(stalled.awakeMs / 3_600_000)}h awake`,
    };
  };

  const attempt = async (local: ReadonlyMap<string, QuotaReading>): Promise<Outcome> => {
    const got = await read();
    if (got === null) return "done";
    const base = await baseOf(got.record);
    lastSeen = base === null || got.record === null ? null : base.accounts;
    if (base === null) return "done";
    const accounts = withObservations(base.accounts, local, opts.deviceId, opts.now());
    if (accounts === null) return "done";
    const record = parseFleetQuotaRecord({ version: base.expect + 1, accounts });
    if (record === null) {
      warnOnce("malformed", "fleet quota: the record this daemon built does not parse; not written");
      return "done";
    }
    const env = await sealFleetQuotaRecord(opts.key, opts.deviceId, record);
    if (env.ct.length > (base.expect === 0 ? STORE_CREATE_MAX_CT_LENGTH : STORE_MAX_CT_LENGTH)) {
      warnOnce("too_large", "fleet quota: the record would pass the store's size cap; not written");
      return "done";
    }
    if (!withinBudget()) return "done";
    puts.push(opts.now());
    const reply = await opts.leg.store({
      t: "store-put",
      id: crypto.randomUUID(),
      key: QUOTA_KEY,
      expect: base.expect,
      env,
    });
    if (reply?.t === "store-written") {
      lastSeen = record.accounts;
      stalled = null;
      if (base.overwriting !== undefined) warn(base.overwriting);
      // A fault that came back after a healthy write is news again.
      warned.clear();
      return "done";
    }
    if (reply?.t !== "store-refused") return "done";
    if (reply.code === "version_conflict") return "conflict";
    refused(reply.code);
    return "done";
  };

  const cycle = async (): Promise<void> => {
    if (stopped || forbidden || !opts.ready()) return;
    const local = opts.observations();
    if (local.size === 0) return;
    // Nothing newer than what the store last showed: no read, no write.
    if (lastSeen !== null && withObservations(lastSeen, local, opts.deviceId, opts.now()) === null) return;
    // Each try re-reads what the conflicting write left, so they run in turn.
    const retry = async (retriesLeft: number): Promise<void> => {
      if (stopped || (await attempt(local)) === "done") return;
      if (retriesLeft > 0) return retry(retriesLeft - 1);
      warnOnce("version_conflict", "fleet quota: gave up after repeated version conflicts; retrying next interval");
    };
    try {
      await retry(CONFLICT_RETRIES);
    } catch (err) {
      // Nothing answered: the next interval reads again. `RelayClient.store` already logged a timeout.
      if (!(err instanceof RequestFailure)) throw err;
    }
  };

  const enqueue = (): Promise<void> => {
    running = running.then(cycle).catch((err: unknown) => warn(`fleet quota: ${String(err)}`));
    return running;
  };

  return {
    start: (): void => {
      if (timer !== null || stopped) return;
      timer = setInterval(() => void enqueue(), intervalMs);
    },
    stop: (): void => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    registered: (): void => {
      if (!forbidden) return;
      forbidden = false;
      retryOwed = true;
    },
    sampled: (): void => {
      if (firstReadOwed || retryOwed) void enqueue();
    },
    flush: enqueue,
  };
}
