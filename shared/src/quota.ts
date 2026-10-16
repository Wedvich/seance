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
 * first in fleet order. Statuses are expected sanitized already (`RelayClient`
 * does it), but an index outside the exclave list is still skipped rather than
 * trusted. Exclaves not signed in have no account and contribute nothing.
 * Live and kept statuses fold alike — an observation carries its own `at`, so
 * an asleep machine's last reading still counts for an account it shares —
 * which is why this reads `status` directly and never through `liveStatus`.
 * A machine with no status at all (not yet reporting, or re-registered since)
 * contributes no numbers: an account absent from the map is unknown, not 0%.
 */
export function newestQuotaByAccount(
  machines: readonly Pick<Machine, "deviceId" | "exclaves" | "status">[],
): ReadonlyMap<string, NewestQuota> {
  const newest = new Map<string, NewestQuota>();
  for (const machine of machines) {
    const exclaves = machine.exclaves ?? [];
    for (const observation of machine.status?.quota ?? []) {
      const accountId = exclaves[observation.x]?.accountId;
      if (accountId === undefined || accountId === null) continue;
      const current = newest.get(accountId);
      if (current !== undefined && observation.at <= current.observation.at) continue;
      newest.set(accountId, { observation, deviceId: machine.deviceId });
    }
  }
  return newest;
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
