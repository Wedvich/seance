import type { AuthAlerted, Machine, PushAlert, SettingsRecord } from "@seance/shared";
import { authAlertStep } from "./auth-alerts.ts";
import { diskAlertStep } from "./disk-alerts.ts";
import type { TermSettings } from "./settings.ts";

export interface MachineAlertWatchOpts {
  readonly settings: () => TermSettings | null;
  /** True once the term's settings load decided `ready`; only then is the record a held, writable thing. */
  readonly ready: () => boolean;
  readonly machines: () => readonly Machine[];
  /** Called for each alert whose list write landed. */
  readonly onAlert: (alert: PushAlert) => void;
  /** Called for each held login alert whose exclave reads `ok` again, once the write clearing it landed. */
  readonly onRestored?: (entry: AuthAlerted, now: number) => void;
  /** A store revocation, for the term's own fault path. */
  readonly onError: (err: unknown) => void;
  readonly now: () => number;
  /** A debounced check runs at most this often, so a burst of status pushes is one write at most. */
  readonly minGapMs: number;
}

export interface MachineAlertWatch {
  /** One step over the registry. `debounce` skips it when one ran less than `minGapMs` ago. */
  readonly check: (debounce: boolean) => void;
}

/**
 * Runs `diskAlertStep` and `authAlertStep` against the term's held settings
 * record, in one write per check (`diskAlerts` and `authAlerts` are fields of
 * the same record, so two writes would only conflict with each other). The
 * lists are written first and the alerts are raised only once that write
 * landed, as the scheduler's own are (a repeat after a lost write would be
 * worse than the next check's recompute); the steps are re-applied to whatever
 * record a conflict re-reads, so they never write over another term's lists.
 *
 * A write whose answer was lost (`indeterminate`) may have committed, and the
 * recompute would then find the machine already held and never alert. Its
 * alerts are kept as `pending`, and the next check settles them: it writes even
 * a no-op, so the store answers a conflict if the first write did land, and the
 * record that conflict re-reads is what shows it. A pending alert is raised once
 * that record holds its entry at the alert's own `at`; one it does not hold
 * never landed, and the step raises it afresh.
 */
export function createMachineAlertWatch(o: MachineAlertWatchOpts): MachineAlertWatch {
  let busy = false;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let pending: readonly PushAlert[] = [];
  const holds = (record: SettingsRecord, alert: PushAlert): boolean => {
    if (alert.kind === "disk") {
      return (record.diskAlerts ?? []).some((e) => e.deviceId === alert.deviceId && e.at === alert.at);
    }
    if (alert.kind !== "auth") return false;
    return (record.authAlerts ?? []).some(
      (e) =>
        e.deviceId === alert.deviceId && e.exclave === alert.exclave && e.state === alert.state && e.at === alert.at,
    );
  };
  return {
    check: (debounce) => {
      const settings = o.settings();
      if (settings === null || !o.ready() || busy) return;
      const at = o.now();
      if (debounce && at - checkedAt < o.minGapMs) return;
      checkedAt = at;
      const held = settings.current();
      if (held === null) return;
      if (
        pending.length === 0 &&
        diskAlertStep(o.machines(), held.diskAlerts ?? [], at).next === null &&
        authAlertStep(o.machines(), held.authAlerts ?? [], at).next === null
      ) {
        return;
      }
      busy = true;
      const unsettled = pending;
      let raised: readonly PushAlert[] = [];
      let restored: readonly AuthAlerted[] = [];
      // Earlier lost writes' alerts that the record the step last saw holds: they did land.
      let confirmed: readonly PushAlert[] = [];
      settings
        .update((record) => {
          confirmed = unsettled.filter((alert) => holds(record, alert));
          const machines = o.machines();
          const disk = diskAlertStep(machines, record.diskAlerts ?? [], at);
          const auth = authAlertStep(machines, record.authAlerts ?? [], at);
          raised = [...disk.alerts, ...auth.alerts];
          restored = auth.restored;
          const { version: _version, ...body } = record;
          // Nothing to change, but an unsettled alert is still to be told from a lost write: write anyway.
          if (disk.next === null && auth.next === null) {
            return unsettled.length > 0 && confirmed.length === 0 ? body : null;
          }
          const { diskAlerts: _disk, authAlerts: _auth, ...rest } = body;
          const diskNext = disk.next ?? record.diskAlerts ?? [];
          const authNext = auth.next ?? record.authAlerts ?? [];
          return {
            ...rest,
            ...(diskNext.length === 0 ? {} : { diskAlerts: diskNext }),
            ...(authNext.length === 0 ? {} : { authAlerts: authNext }),
          };
        })
        .then(
          (result) => {
            busy = false;
            const lost = !result.ok && result.code === "indeterminate";
            pending = lost ? [...unsettled.filter((alert) => !confirmed.includes(alert)), ...raised] : [];
            for (const alert of confirmed) o.onAlert(alert);
            if (!result.ok) return;
            for (const alert of raised) o.onAlert(alert);
            for (const entry of restored) o.onRestored?.(entry, at);
          },
          (err: unknown) => {
            busy = false;
            o.onError(err);
          },
        );
    },
  };
}
