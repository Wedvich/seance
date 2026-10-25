import {
  isStatusStale,
  liveStatus,
  MIN_FREE_MIB,
  type DiskAlerted,
  type Machine,
  type PushAlert,
} from "@seance/shared";
import type { TermSettings } from "./settings.ts";

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
  const next = [...held.values()];
  const unchanged = next.length === alerted.length && next.every((entry, i) => entry === alerted[i]);
  return { alerts, next: unchanged ? null : next };
}

export interface DiskWatchOpts {
  readonly settings: () => TermSettings | null;
  /** True once the term's settings load decided `ready`; only then is the record a held, writable thing. */
  readonly ready: () => boolean;
  readonly machines: () => readonly Machine[];
  /** Called for each alert whose list write landed. */
  readonly onAlert: (alert: PushAlert) => void;
  /** A store revocation, for the term's own fault path. */
  readonly onError: (err: unknown) => void;
  readonly now: () => number;
  /** A debounced check runs at most this often, so a burst of status pushes is one write at most. */
  readonly minGapMs: number;
}

export interface DiskWatch {
  /** One step over the registry. `debounce` skips it when one ran less than `minGapMs` ago. */
  readonly check: (debounce: boolean) => void;
}

/**
 * Runs `diskAlertStep` against the term's held settings record. The list is
 * written first and the alerts are raised only once that write landed, as the
 * scheduler's own are (a repeat after a lost write would be worse than the
 * next check's recompute); the step is re-applied to whatever record a
 * conflict re-reads, so it never writes over another term's list.
 */
export function createDiskWatch(o: DiskWatchOpts): DiskWatch {
  let busy = false;
  let checkedAt = Number.NEGATIVE_INFINITY;
  return {
    check: (debounce) => {
      const settings = o.settings();
      if (settings === null || !o.ready() || busy) return;
      const at = o.now();
      if (debounce && at - checkedAt < o.minGapMs) return;
      checkedAt = at;
      const held = settings.current();
      if (held === null || diskAlertStep(o.machines(), held.diskAlerts ?? [], at).next === null) return;
      busy = true;
      let raised: readonly PushAlert[] = [];
      settings
        .update((record) => {
          const step = diskAlertStep(o.machines(), record.diskAlerts ?? [], at);
          raised = step.alerts;
          if (step.next === null) return null;
          const { version: _version, diskAlerts: _held, ...rest } = record;
          return step.next.length === 0 ? rest : { ...rest, diskAlerts: step.next };
        })
        .then(
          (result) => {
            busy = false;
            if (result.ok) for (const alert of raised) o.onAlert(alert);
          },
          (err: unknown) => {
            busy = false;
            o.onError(err);
          },
        );
    },
  };
}
