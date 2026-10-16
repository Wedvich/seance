import type { Machine } from "./app-client.ts";
import { REPLAY_WINDOW_MS } from "./crypto.ts";
import { STATUS_INTERVAL_MS, type MachineStatus, type QuotaObservation } from "./types.ts";

/**
 * The rules every reader of a `status` goes through, so the PWA and the
 * scheduler cannot disagree on one. The parser checks types; these check
 * ranges and relations, which need the register blob's exclave list and a
 * clock (DESIGN.md, Presence & identity).
 */

/** Three missed beats: past this a snapshot says nothing about the machine now. */
export const STATUS_STALE_MS = 3 * STATUS_INTERVAL_MS;

/** How far ahead of the reader's clock a stamp may be — the tolerance live frames already get. */
export const STATUS_CLOCK_SKEW_MS = REPLAY_WINDOW_MS;

const MAX_PCT = 100;

/**
 * True once the snapshot is older than `STATUS_STALE_MS`, or stamped further
 * in the future than clock skew explains — a stamp that far ahead would
 * otherwise read as fresh for as long as it claims.
 */
export function isStatusStale(status: MachineStatus, nowMs: number): boolean {
  const ageMs = nowMs - status.at * 1000;
  return ageMs > STATUS_STALE_MS || ageMs < -STATUS_CLOCK_SKEW_MS;
}

/**
 * The status a pressure reader may use: only a connected machine's. A machine
 * whose socket went keeps its last status for its accounts' quota
 * (`newestQuotaByAccount`), but its pressure is unknown however recent that
 * status is — the machine is gone. Age is the caller's next check (`isStatusStale`).
 */
export function liveStatus(machine: Pick<Machine, "connected" | "status">): MachineStatus | undefined {
  return machine.connected ? machine.status : undefined;
}

/**
 * True when the daemon trimmed this status to fit the relay's bound. Its
 * quota is then incomplete: an exclave without an observation is unknown, not
 * unobserved, and an observation may lack its per-model windows and resets.
 */
export function isQuotaTrimmed(status: MachineStatus): boolean {
  return status.tr !== undefined;
}

/**
 * `null` when the status contradicts itself or the register blob it indexes:
 * a percent over 100, a `sess` that is not one count per exclave, a quota
 * index out of range or repeated, or more entries kept plus trimmed than there
 * are exclaves (the parser has already bounded every integer to the safe
 * range). Like the parser, one
 * bad field costs the tick. A quota observation stamped further ahead than
 * clock skew is dropped alone — it would read as the newest for its account
 * until the clock caught up. Returns `status` itself when nothing is dropped.
 */
export function sanitizeStatus(status: MachineStatus, exclaveCount: number, nowMs: number): MachineStatus | null {
  const { cpu, mem, disk, sess, quota, tr } = status;
  if (![cpu, mem, disk].every(isPct)) return null;
  if (sess !== undefined && sess.length !== exclaveCount) return null;
  if (quota === undefined) return (tr ?? 0) > exclaveCount ? null : status;
  if (quota.length + (tr ?? 0) > exclaveCount) return null;
  const seen = new Set<number>();
  for (const q of quota) {
    if (q.x >= exclaveCount || seen.has(q.x) || !isSaneObservation(q)) return null;
    seen.add(q.x);
  }
  const horizonS = (nowMs + STATUS_CLOCK_SKEW_MS) / 1000;
  const kept = quota.filter((q) => q.at <= horizonS);
  if (kept.length === quota.length) return status;
  const { quota: _quota, ...rest } = status;
  return kept.length === 0 ? rest : { ...rest, quota: kept };
}

function isSaneObservation(q: QuotaObservation): boolean {
  if (!isPct(q.h) || !isPct(q.d)) return false;
  return q.w === undefined || q.w.every((w) => isPct(w.p));
}

function isPct(value: number | undefined): boolean {
  return value === undefined || value <= MAX_PCT;
}
