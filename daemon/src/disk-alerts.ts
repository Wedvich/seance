import {
  DISK_ALERTS_MAX,
  isStatusStale,
  liveStatus,
  MIN_FREE_MIB,
  type DiskAlerted,
  type Machine,
  type PushAlert,
} from "@seance/shared";

/**
 * Nearly-full-disk alerts (DESIGN.md, Scheduler, "Disk alerts"): the pure step
 * the leader runs over the registry. Scheduler-free, like the rest of the push
 * modules.
 *
 * A machine alerts when its live status reads `disk` at the PWA's red line
 * (`levelFor`, 90%) or `free` under the routing floor (`MIN_FREE_MIB`, where
 * `disk_low` filters it out), and is held in `alerted` until it recovers. The
 * hysteresis is wide on purpose: a disk hovering at the line must not alert on
 * every crossing. `alerted` is the settings record's `diskAlerts`, not memory,
 * so a new leader — 31 terms in 6 h is the measured worst case — does not
 * repeat an alert for a disk that never recovered.
 */

/** At or past this fill (percent) a machine's disk is nearly full. */
export const DISK_ALERT_PCT = 90;

/** A machine re-arms below this fill and at twice the free floor. */
export const DISK_REARM_PCT = 85;

export interface DiskAlertStep {
  readonly alerts: readonly PushAlert[];
  /** The list to store when it changed, else null. */
  readonly next: readonly DiskAlerted[] | null;
}

export function diskAlertStep(
  machines: readonly Machine[],
  alerted: readonly DiskAlerted[],
  now: number,
): DiskAlertStep {
  const known = new Set(machines.map((m) => m.deviceId));
  const held = new Map(alerted.filter((a) => known.has(a.deviceId)).map((a) => [a.deviceId, a]));
  const alerts: PushAlert[] = [];
  for (const machine of machines) {
    const status = liveStatus(machine);
    // A stale or absent reading says nothing: neither an alert nor a recovery.
    if (status === undefined || isStatusStale(status, now)) continue;
    const { disk, free } = status;
    // No figure at all (an older daemon's status) says nothing either: it must not re-arm a held machine.
    if (disk === undefined && free === undefined) continue;
    const full = (disk !== undefined && disk >= DISK_ALERT_PCT) || (free !== undefined && free < MIN_FREE_MIB);
    if (full && !held.has(machine.deviceId)) {
      held.set(machine.deviceId, { deviceId: machine.deviceId, at: now });
      alerts.push({
        v: 1,
        kind: "disk",
        at: now,
        deviceId: machine.deviceId,
        ...(disk === undefined ? {} : { diskPct: Math.round(disk) }),
        ...(free === undefined ? {} : { freeMib: Math.round(free) }),
      });
      continue;
    }
    const recovered = (disk === undefined || disk < DISK_REARM_PCT) && (free === undefined || free >= 2 * MIN_FREE_MIB);
    if (!full && recovered) held.delete(machine.deviceId);
  }
  // Past the cap the oldest alerts go (`held` keeps insertion order): the record must stay one a reader
  // accepts. A machine dropped while still full alerts again at the next check; a fleet that size is no real one.
  const kept = [...held.values()];
  const next = kept.length > DISK_ALERTS_MAX ? kept.slice(-DISK_ALERTS_MAX) : kept;
  const unchanged = next.length === alerted.length && next.every((entry, i) => entry === alerted[i]);
  return { alerts, next: unchanged ? null : next };
}
