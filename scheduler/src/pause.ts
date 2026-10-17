import type { PauseHold, Reason } from "@seance/shared";

/**
 * The holds in `queue:pause` (DESIGN.md, Scheduler, "Pause"): one on the whole
 * queue, or one per account. Pure, so routing and the writer share one reading
 * of which hold is in force.
 */

/** A reset hold lifts at its `resumeAt` with no write; a resume hold waits for a `resume`. */
export function isActive(hold: PauseHold, now: number): boolean {
  return hold.until === "resume" || (hold.resumeAt !== undefined && hold.resumeAt > now);
}

export function activeHolds(holds: readonly PauseHold[], now: number): readonly PauseHold[] {
  return holds.filter((h) => isActive(h, now));
}

/** The whole-queue hold among active ones, as the reason every candidate carries. */
export function queuePause(holds: readonly PauseHold[]): Reason | null {
  const hold = holds.find((h) => h.account === undefined);
  return hold === undefined ? null : { code: "paused", until: hold.until, scope: "queue" };
}

/** `accountId`'s hold among active ones, as the reason its candidates carry. */
export function accountPause(holds: readonly PauseHold[], accountId: string): Reason | null {
  const hold = holds.find((h) => h.account === accountId);
  return hold === undefined ? null : { code: "paused", until: hold.until, scope: "account" };
}

/**
 * `hold` in place of whatever held its scope, expired holds dropped. The same
 * hold already in force is kept as it was, so asking twice writes nothing.
 */
export function withHold(holds: readonly PauseHold[], hold: PauseHold, now: number): readonly PauseHold[] {
  const live = activeHolds(holds, now);
  const current = live.find((h) => h.account === hold.account);
  if (current !== undefined && current.until === hold.until && current.resumeAt === hold.resumeAt) return live;
  return [...live.filter((h) => h.account !== hold.account), hold];
}

/** The hold on `account` (the whole queue when absent) lifted, expired holds dropped. */
export function withoutHold(
  holds: readonly PauseHold[],
  account: string | undefined,
  now: number,
): readonly PauseHold[] {
  return activeHolds(holds, now).filter((h) => h.account !== account);
}

export function sameHolds(a: readonly PauseHold[], b: readonly PauseHold[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}
