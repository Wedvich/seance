import type { Machine } from "./app-client.ts";
import type { FleetQuotaEntry, QuotaObservation, QuotaReading } from "./types.ts";

/**
 * The fleet-wide quota rules, one copy for every reader: the PWA's account
 * cards and the scheduler's filter and score (docs/scheduler.md). An account's
 * quota is spread over every machine hosting one of its exclaves, so it is
 * folded across the fleet — every status, and the fleet quota record — rather
 * than read off any one status.
 */

export interface NewestQuota {
  /** A status's observation keeps its exclave index; a record entry's reading has none. Read neither by it. */
  readonly observation: QuotaObservation | QuotaReading;
  /** The machine that saw it — a status's sender, or a record entry's `observer` — the account's freshest observer. */
  readonly deviceId: string;
}

/**
 * Newest observation per account id, across every machine; ties go to the
 * first in fleet order. Windows the newest lacks come from the next newest
 * that has them (`mergeQuota`), so a machine whose cache never saw a per-model
 * cap doesn't erase the one another machine read. Statuses are expected
 * sanitized already (`RelayClient` does it), but an index outside the exclave
 * list is still skipped rather than trusted. Exclaves not signed in have no
 * account and contribute nothing.
 * Live and kept statuses fold alike — an observation carries its own `at`, so
 * an asleep machine's last reading still counts for an account it shares —
 * which is why this reads `status` directly and never through `liveStatus`.
 * A machine with no status at all (not yet reporting, or re-registered since)
 * contributes no numbers: an account absent from the map is unknown, not 0%.
 *
 * `fleet` is the fleet quota record's entries (DESIGN.md, Scheduler, "Fleet
 * quota record"): each joins its account's candidates after every status, so a
 * tie goes to the status, and its `observer` stands in as the machine — one
 * that may have left the registry, which is what the record is for.
 */
export function newestQuotaByAccount(
  machines: readonly Pick<Machine, "deviceId" | "exclaves" | "status">[],
  fleet: readonly FleetQuotaEntry[] = [],
): ReadonlyMap<string, NewestQuota> {
  const seen = new Map<string, NewestQuota[]>();
  const add = (accountId: string, candidate: NewestQuota): void => {
    const list = seen.get(accountId) ?? [];
    list.push(candidate);
    seen.set(accountId, list);
  };
  for (const machine of machines) {
    const exclaves = machine.exclaves ?? [];
    for (const observation of machine.status?.quota ?? []) {
      const accountId = exclaves[observation.x]?.accountId;
      if (accountId === undefined || accountId === null) continue;
      add(accountId, { observation, deviceId: machine.deviceId });
    }
  }
  for (const entry of fleet) add(entry.accountId, { observation: entry.reading, deviceId: entry.observer });
  const newest = new Map<string, NewestQuota>();
  for (const [accountId, all] of seen) {
    // Stable sort: a tie keeps fleet order.
    const [first, ...older] = all.toSorted((a, b) => b.observation.at - a.observation.at);
    if (first === undefined) continue;
    const observation = older.reduce((merged, next) => mergeQuota(merged, next.observation), first.observation);
    newest.set(accountId, { observation, deviceId: first.deviceId });
  }
  return newest;
}

const FIVE_HOURS_S = 5 * 3_600;
const SEVEN_DAYS_S = 7 * 86_400;

/**
 * `newer` with every window it lacks taken from `older`, under `newer`'s stamp,
 * source and index. Safe because a reading is a lower bound — use only raises
 * it until reset, and a passed reset reads 0% whatever its age
 * (`effectivePct`) — so an older window never understates the account. A
 * window and its reset travel as a pair: `newer`'s `h` never takes `older`'s
 * `hr`. Per-model windows merge by model name. A window with no reset has
 * nothing to expire it, and once filled its age hides behind `newer`'s stamp,
 * so it is taken only from a reading less than one window length older — else
 * a long-asleep machine's reading would pin the account forever. Credits `c`
 * never carry a reset, so they fill only from a reading in `newer`'s credit
 * month: a reading without them (an older daemon's session report) must not
 * erase them. The percent and its amounts travel together, like a window and
 * its reset.
 */
export function mergeQuota(newer: QuotaReading, older: QuotaReading): QuotaReading {
  const age = newer.at - older.at;
  const fresh = (resetsAt: number | undefined, lengthS: number): boolean => resetsAt !== undefined || age < lengthS;
  const models = new Set((newer.w ?? []).map((window) => window.m));
  const w = [
    ...(newer.w ?? []),
    ...(older.w ?? []).filter((window) => !models.has(window.m) && fresh(window.r, SEVEN_DAYS_S)),
  ];
  return {
    ...newer,
    ...(newer.h === undefined && older.h !== undefined && fresh(older.hr, FIVE_HOURS_S)
      ? { h: older.h, ...(older.hr === undefined ? {} : { hr: older.hr }) }
      : {}),
    ...(newer.d === undefined && older.d !== undefined && fresh(older.dr, SEVEN_DAYS_S)
      ? { d: older.d, ...(older.dr === undefined ? {} : { dr: older.dr }) }
      : {}),
    ...(w.length === 0 ? {} : { w }),
    ...(newer.c === undefined && older.c !== undefined && sameCreditMonth(newer.at, older.at) ? creditsOf(older) : {}),
  };
}

function creditsOf({ c, cu, cl }: QuotaReading): Pick<QuotaObservation, "c" | "cu" | "cl"> {
  return {
    ...(c === undefined ? {} : { c }),
    ...(cu === undefined || cl === undefined ? {} : { cu, cl }),
  };
}

/**
 * Credits reset at 00:00 UTC on the 1st — the cache carries no reset stamp,
 * so this is the assumed boundary. A reading from an earlier month says
 * nothing about this month's spend.
 */
export function sameCreditMonth(aS: number, bS: number): boolean {
  const a = new Date(aS * 1000);
  const b = new Date(bS * 1000);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

/**
 * A window whose reset has passed is empty however old the reading — its
 * percentage describes a window that no longer exists (docs/scheduler.md,
 * "Quota telemetry": the `resets_at` floor). A cache reading can be hours old,
 * so without this a spent 5h window stays full long after it refilled.
 */
export function effectivePct(pct: number, resetsAtS: number | undefined, nowMs: number): number {
  if (resetsAtS !== undefined && resetsAtS * 1000 <= nowMs) return 0;
  return pct;
}

/** How long a quota window runs: the 5h session window, or any weekly (all-models or per-model). */
export type QuotaSpan = "5h" | "7d";

export const QUOTA_SPAN_MS: Readonly<Record<QuotaSpan, number>> = { "5h": 5 * 3600_000, "7d": 7 * 86_400_000 };

/** The convex cost is unbounded at 100%; this keeps an over-full account finite and still worst. */
const MAX_UTILISATION = 0.99;

export interface QuotaWindow {
  readonly label: string;
  readonly pct: number;
  /** Unix seconds. */
  readonly resetsAt: number | undefined;
  readonly span: QuotaSpan;
  /** A per-model weekly's display name (`Fable`); absent on the all-models windows. */
  readonly model?: string;
}

/** Every window the reading has; which of them a task is judged on is `windowAppliesTo`'s. */
export function quotaWindows(o: QuotaReading): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  if (o.h !== undefined) windows.push({ label: "5h", pct: o.h, resetsAt: o.hr, span: "5h" });
  if (o.d !== undefined) windows.push({ label: "7d", pct: o.d, resetsAt: o.dr, span: "7d" });
  for (const w of o.w ?? []) windows.push({ label: `7d ${w.m}`, pct: w.p, resetsAt: w.r, span: "7d", model: w.m });
  return windows;
}

/**
 * All-models windows bind every task; a per-model weekly only a task on that
 * model — a full Fable week leaves Opus work free. Matched on the display
 * name's first word (`Fable` in `claude-fable-5-1[1m]`), since the cache
 * holds no model id.
 */
export function windowAppliesTo(window: QuotaWindow, model: string): boolean {
  if (window.model === undefined) return true;
  const family = window.model.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  return family !== "" && model.toLowerCase().includes(family);
}

/**
 * max over windows of the convex `(u/(1-u))²` at projected usage, discounted
 * by the share of the window still to run: a nearly-spent 5h window that
 * resets in ten minutes costs little, the same reading on a fresh one a lot.
 */
export function quotaPressure(windows: readonly QuotaWindow[], added: (w: QuotaWindow) => number, now: number): number {
  let worst = 0;
  for (const w of windows) {
    const u = Math.min((effectivePct(w.pct, w.resetsAt, now) + added(w)) / 100, MAX_UTILISATION);
    const remaining = w.resetsAt === undefined ? 1 : clamp((w.resetsAt * 1000 - now) / QUOTA_SPAN_MS[w.span]);
    worst = Math.max(worst, (u / (1 - u)) ** 2 * remaining);
  }
  return worst;
}

function clamp(x: number): number {
  return Math.min(Math.max(x, 0), 1);
}
