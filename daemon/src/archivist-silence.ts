import type { ArchivistEntry, ArchivistSilence, PushAlert } from "@seance/shared";

/**
 * The archivist's silence alert (DESIGN.md, Scheduler, "Web Push", "Silence alert"; Archivist, A37): the
 * pure step the leader runs over the registry's seat entry, beside `diskAlertStep` and `authAlertStep`.
 * Scheduler-free like them: nothing in routing or the pass reads the archivist (A4).
 *
 * Absent is no connected seat entry — none at all (forgotten, the seat moved to an id not yet
 * registered, a blob this build cannot open) or one the relay holds disconnected. The entry is the one
 * the relay flags per push, so the step follows the seat, never an old id's kept entry. `held` is the
 * settings record's `archivistSilence`, not memory: its existence says a registry held an archivist, and
 * its `since` is when the absence began, so a new leader neither repeats an alert nor restarts the clock.
 */

/** Absent this long, the leader pushes once. */
export const ARCHIVIST_SILENCE_MS = 24 * 60 * 60 * 1000;

export interface ArchivistSilenceStep {
  readonly alerts: readonly PushAlert[];
  /** The state to store when it changed, else null. */
  readonly next: ArchivistSilence | null;
}

const UNCHANGED: ArchivistSilenceStep = { alerts: [], next: null };

export function archivistSilenceStep(
  entry: ArchivistEntry | null,
  held: ArchivistSilence | undefined,
  now: number,
): ArchivistSilenceStep {
  if (entry !== null && entry.connected) {
    return held?.state === "present" ? UNCHANGED : { alerts: [], next: { state: "present" } };
  }
  // Never held: a fleet that has not run an archivist is not missing one.
  if (held === undefined && entry === null) return UNCHANGED;
  if (held?.state === "alerted") return UNCHANGED;
  // Only a record with no field (a leader that never saw it present) trusts the relay's `lastSeen`, clamped
  // since the relay's clock is not this one. After an observed `present` the absence began after this
  // record's last write, and `lastSeen` can be the register of days ago when sockets drop without a close
  // stamp (a relay redeploy), so the leader's own clock is the earliest it knows. Same with no entry.
  const since =
    held?.state === "absent"
      ? held.since
      : held === undefined && entry !== null
        ? Math.min(Math.max(0, entry.lastSeen), now)
        : now;
  if (now - since < ARCHIVIST_SILENCE_MS) {
    return held?.state === "absent" ? UNCHANGED : { alerts: [], next: { state: "absent", since } };
  }
  return { alerts: [{ v: 1, kind: "archivist", at: now, since }], next: { state: "alerted", since } };
}
