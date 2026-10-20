import type { Machine } from "./app-client.ts";
import type { QuotaObservation } from "./types.ts";

/**
 * The fleet-wide quota rules, one copy for every reader: the PWA's account
 * cards today, the scheduler's filter and score in M2 (docs/scheduler.md). An
 * account's quota is spread over every machine hosting one of its exclaves, so
 * it is folded across the fleet rather than read off any one status.
 */

export interface NewestQuota {
  readonly observation: QuotaObservation;
  /** The machine whose status carried it — the account's freshest observer. */
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
 */
export function newestQuotaByAccount(
  machines: readonly Pick<Machine, "deviceId" | "exclaves" | "status">[],
): ReadonlyMap<string, NewestQuota> {
  const seen = new Map<string, NewestQuota[]>();
  for (const machine of machines) {
    const exclaves = machine.exclaves ?? [];
    for (const observation of machine.status?.quota ?? []) {
      const accountId = exclaves[observation.x]?.accountId;
      if (accountId === undefined || accountId === null) continue;
      const list = seen.get(accountId) ?? [];
      list.push({ observation, deviceId: machine.deviceId });
      seen.set(accountId, list);
    }
  }
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
/** Credits reset monthly, on a day the cache doesn't name — the longest month bounds a reading's life. */
const CREDIT_MONTH_S = 31 * 86_400;

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
 * never carry a reset, so they follow that rule over a month: only the cache
 * reports them, and a newer session report must not erase them. The percent
 * and its amounts travel together, like a window and its reset.
 */
export function mergeQuota(newer: QuotaObservation, older: QuotaObservation): QuotaObservation {
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
    ...(newer.c === undefined && older.c !== undefined && age < CREDIT_MONTH_S ? creditsOf(older) : {}),
  };
}

function creditsOf({ c, cu, cl, cc }: QuotaObservation): Pick<QuotaObservation, "c" | "cu" | "cl" | "cc"> {
  return {
    ...(c === undefined ? {} : { c }),
    ...(cu === undefined || cl === undefined || cc === undefined ? {} : { cu, cl, cc }),
  };
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
