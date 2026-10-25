import { quote, type FleetQuotaEntry, type Machine, type SpillStamp } from "@seance/shared";
import { windowResetOf, type Decision } from "./route.ts";
import type { Task } from "./task.ts";

/**
 * What the library tells its host as it happens, beside what the record shows:
 * a dispatch spending credits, and a task left waiting for input. The leader
 * logs each line and pushes the same alerts. `message` is a line for a log —
 * ids only, never a prompt or title.
 */
export type SchedulerAlert =
  | {
      readonly kind: "spill";
      readonly taskId: string;
      readonly accountId: string;
      readonly window: string;
      readonly projectedPct: number;
      readonly message: string;
    }
  | {
      readonly kind: "needs-input";
      readonly taskId: string;
      /** When it entered `needs-input`, ms. */
      readonly since: number;
      /** The 30-minute re-alert; false for the first, after `needsInputAlertMs`. */
      readonly escalated: boolean;
      readonly message: string;
    };

/**
 * The needs-input clock rides the write that moves the state: entering
 * `needs-input` stamps `needsInputSince`, leaving it for any state but `lost`
 * clears it, `inputAlerted` and `escalated`. `lost` keeps them: a machine's absence is not an
 * answer, and the wait resumes where it was when the machine returns. On the
 * record, so a new leader does not restart the clock.
 */
export function inputClock(task: Task, now: number): Task {
  if (task.state === "needs-input") {
    return task.needsInputSince === undefined ? { ...task, needsInputSince: now } : task;
  }
  if (task.state === "lost") return task;
  if (task.needsInputSince === undefined && task.escalated === undefined && task.inputAlerted === undefined) {
    return task;
  }
  const { needsInputSince: _since, escalated: _escalated, inputAlerted: _alerted, ...rest } = task;
  return rest;
}

/**
 * The first alert of a stay: a task still waiting for input `afterMs` after it
 * began, once per stay. The wait is debounced because auto mode reports
 * `needs-input` then `busy` around every call its classifier settles (seconds
 * apart, DESIGN.md, "Session events"), and each of those leaves the state and
 * clears the clock. A stay already escalated, or never stamped (an older
 * leader's record, whose clock `escalation` starts), is not due. Null when
 * nothing is.
 */
export function inputAlert(task: Task, now: number, afterMs: number): Task | null {
  if (task.state !== "needs-input" || task.inputAlerted === true || task.escalated === true) return null;
  if (task.needsInputSince === undefined) return null;
  return now - task.needsInputSince >= afterMs ? { ...task, inputAlerted: true } : null;
}

/**
 * A task waiting for input past `afterMs` is escalated, once per stay — never
 * killed, its slot kept (docs/scheduler.md, Settled defaults 5). One stamped by
 * no one (an older leader's record) has its clock started instead. Null when
 * nothing is due.
 */
export function escalation(task: Task, now: number, afterMs: number): Task | null {
  if (task.state !== "needs-input" || task.escalated === true) return null;
  if (task.needsInputSince === undefined) return { ...task, needsInputSince: now };
  return now - task.needsInputSince >= afterMs ? { ...task, escalated: true } : null;
}

/**
 * A confirmed spawn on a candidate that `spill`s spends credits: alerted once
 * per account per quota window, not per task — the record's decision carries
 * the spill for each task. The window is told apart by its reset; two
 * readings of one window differ by seconds, so a reset only counts as a new
 * window when it is later by more than `resetGraceMs` (or the alerted one has
 * passed), and a reading with no reset never does.
 */
export class SpillAlerts {
  readonly #resetGraceMs: number;
  /**
   * `account window` → the reset (ms) of the window a spill was last alerted
   * for, 0 when that reading carried none. Seeded at takeover from the stamps
   * dispatches left on their records (`seed`), so a new leader does not alert an
   * ongoing window once more.
   */
  readonly #alerted = new Map<string, number>();

  constructor(resetGraceMs: number) {
    this.#resetGraceMs = resetGraceMs;
  }

  /**
   * Learns a window a previous term alerted: the later reset per key wins, and a
   * reset of 0 (none read) never replaces one that was.
   */
  seed(stamp: SpillStamp): void {
    const key = `${stamp.accountId} ${stamp.window}`;
    const alerted = this.#alerted.get(key);
    if (alerted === undefined || stamp.reset > alerted) this.#alerted.set(key, stamp.reset);
  }

  /**
   * The alert a confirmed spawn under `decision` earns, if any — remembered, so
   * its window earns no other — with the stamp the dispatch's record must carry
   * so a later term holds it too.
   */
  on(
    taskId: string,
    decision: Decision,
    machines: readonly Machine[],
    now: number,
    fleetQuota: readonly FleetQuotaEntry[] = [],
  ): { readonly alert: SchedulerAlert; readonly stamp: SpillStamp } | null {
    const { chosen } = decision;
    if (chosen === null) return null;
    const spill = decision.candidates.find(
      (c) => c.deviceId === chosen.deviceId && c.exclave === chosen.exclave,
    )?.spill;
    if (spill === undefined) return null;
    const accountId = machines
      .find((m) => m.deviceId === chosen.deviceId)
      ?.exclaves?.find((x) => x.id === chosen.exclave)?.accountId;
    if (accountId === undefined || accountId === null) return null;
    const key = `${accountId} ${spill.window}`;
    const resetS = windowResetOf(accountId, machines, spill.window, fleetQuota);
    const reset = resetS === undefined ? undefined : resetS * 1000;
    const alerted = this.#alerted.get(key);
    if (alerted !== undefined) {
      if (reset === undefined) return null;
      // An alert stamped with no reset learns it, without alerting again.
      if (alerted === 0) {
        this.#alerted.set(key, reset);
        return null;
      }
      const newWindow = reset - alerted > this.#resetGraceMs || (alerted <= now && reset > now);
      if (!newWindow) return null;
    }
    this.#alerted.set(key, reset ?? 0);
    const pct = Math.round(spill.projectedPct);
    return {
      alert: {
        kind: "spill",
        taskId,
        accountId,
        window: spill.window,
        projectedPct: spill.projectedPct,
        message: `spending credits: task=${quote(taskId)} account=${quote(accountId)} window=${quote(spill.window)} projected=${pct}%`,
      },
      stamp: { accountId, window: spill.window, reset: reset ?? 0 },
    };
  }
}
