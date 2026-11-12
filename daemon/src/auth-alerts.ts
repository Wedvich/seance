import {
  AUTH_ALERTS_MAX,
  exclaveAuth,
  isStatusStale,
  liveStatus,
  ROUTING_ID_PATTERN,
  type AuthAlerted,
  type Machine,
  type PushAlert,
} from "@seance/shared";

/**
 * Login alerts (DESIGN.md, Scheduler, "Auth alerts"): the pure step the leader runs over the
 * registry, beside `diskAlertStep`. An exclave alerts once on entering `expired` ("needs
 * /login") or `expiring` (within 3 days), and is held until it reads `ok` again, so a state
 * that holds alerts once. `alerted` is the settings record's `authAlerts`, not memory, so a new
 * leader does not repeat an alert for a login that never recovered.
 *
 * Transitions are escalation only: `expiring` then `expired` alerts twice, the reverse never —
 * a login does not become less lapsed, and a reading that says `expiring` over a held `expired`
 * is the daemon's clock disagreeing with the last one. `unknown` (an older daemon, an unreadable
 * store, a fresh daemon that has not read yet) says nothing: it neither alerts nor clears.
 */

export interface AuthAlertStep {
  readonly alerts: readonly PushAlert[];
  /** The list to store when it changed, else null. */
  readonly next: readonly AuthAlerted[] | null;
  /** Entries cleared because the exclave reads `ok` again: the leader logs how long the login stood lapsed. */
  readonly restored: readonly AuthAlerted[];
}

const keyOf = (deviceId: string, exclave: string): string => `${deviceId}\n${exclave}`;

const routable = (id: string): boolean => ROUTING_ID_PATTERN.test(id);

export function authAlertStep(
  machines: readonly Machine[],
  alerted: readonly AuthAlerted[],
  now: number,
): AuthAlertStep {
  const byDevice = new Map(machines.map((m) => [m.deviceId, m]));
  // A machine or an exclave gone from the registry takes its entry with it. A machine whose exclave list is
  // not known says nothing about them.
  const held = new Map(
    alerted
      .filter((a) => {
        const exclaves = byDevice.get(a.deviceId)?.exclaves;
        return byDevice.has(a.deviceId) && (exclaves === undefined || exclaves.some((x) => x.id === a.exclave));
      })
      .map((a) => [keyOf(a.deviceId, a.exclave), a]),
  );
  const alerts: PushAlert[] = [];
  const restored: AuthAlerted[] = [];
  for (const machine of machines) {
    const status = liveStatus(machine);
    // A stale or absent reading says nothing: neither an alert nor a recovery.
    if (status === undefined || isStatusStale(status, now)) continue;
    (machine.exclaves ?? []).forEach((exclave, index) => {
      // Never persisted nor pushed: the record's parser and the service worker would refuse it.
      if (!routable(machine.deviceId) || !routable(exclave.id)) return;
      const key = keyOf(machine.deviceId, exclave.id);
      const entry = held.get(key);
      // Signed out is `auth_missing`, not a lapse: its entry just clears, with no "restored" to report.
      if (!exclave.authOk) {
        held.delete(key);
        return;
      }
      const { state } = exclaveAuth(machine, index, now);
      if (state === "unknown") return;
      if (state === "ok") {
        if (entry === undefined) return;
        held.delete(key);
        restored.push(entry);
        return;
      }
      if (entry !== undefined && (entry.state === "expired" || entry.state === state)) return;
      // Held entries are never evicted to make room (unlike `diskAlertStep`, whose cap exceeds the registry):
      // an evicted lapsed login would alert again at the next check, and so on at every check.
      if (entry === undefined && held.size >= AUTH_ALERTS_MAX) return;
      held.set(key, { deviceId: machine.deviceId, exclave: exclave.id, state, at: now });
      alerts.push({ v: 1, kind: "auth", at: now, deviceId: machine.deviceId, exclave: exclave.id, state });
    });
  }
  const next = [...held.values()];
  const unchanged = next.length === alerted.length && next.every((entry, i) => entry === alerted[i]);
  return { alerts, next: unchanged ? null : next, restored };
}
