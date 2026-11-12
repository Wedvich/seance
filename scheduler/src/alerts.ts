import {
  quote,
  taskPrBlock,
  type FleetQuotaEntry,
  type Machine,
  type PrBlockedReason,
  type SpillStamp,
} from "@seance/shared";
import { SPAN_MS, windowResetOf, type Decision } from "./route.ts";
import type { Task } from "./task.ts";

/**
 * What the library tells its host as it happens, beside what the record shows:
 * a dispatch past the quota line on an account that may spill into credits (or,
 * `spending`, one already spending them), and a task left waiting for input.
 * The leader logs each line and pushes the same alerts. `message` is a line for
 * a log — ids only, never a prompt or title.
 */
export type SchedulerAlert =
  | {
      readonly kind: "spill";
      readonly taskId: string;
      readonly accountId: string;
      readonly window: string;
      readonly projectedPct: number;
      /** `Candidate.spill`'s: the window already reads full. Absent, the spill is a forecast. */
      readonly spending?: true;
      readonly message: string;
    }
  | {
      readonly kind: "needs-input";
      readonly taskId: string;
      /** When it entered `needs-input`, ms. */
      readonly since: number;
      /** The 30-minute re-alert; false for the first, after `needsInputAlertMs`. */
      readonly escalated: boolean;
      /** The first alert, raised at once because the session waits on an AskUserQuestion (`questionAlert`). */
      readonly question?: true;
      readonly message: string;
    }
  | {
      readonly kind: "pr-blocked";
      readonly taskId: string;
      readonly reason: PrBlockedReason;
      /** The head the alert was raised for: the dedupe key with `reason`, never pushed. */
      readonly head: string;
      readonly message: string;
    };

/**
 * The first alert of a stuck PR: an `awaiting-merge` task whose reading names a reason (`taskPrBlock`,
 * which leaves out an `until: "reported"` task), stamped `prAlert` with that reason and the head it was
 * read at. Null when none is due: no head to key on, a continuation of the task still waiting or
 * running (`continuing`: its session is on the PR, and the next poll alerts if it ends without
 * fixing it), or the same `(reason, head)` already alerted. A fix that fails again is a new head, so
 * it alerts again. On the record, so a new leader does not repeat it.
 */
export function prBlockedAlert(task: Task, continuing: boolean, now: number): Task | null {
  const reason = taskPrBlock(task);
  const head = task.pr?.head;
  if (reason === null || continuing || head === undefined) return null;
  if (task.prAlert?.reason === reason && task.prAlert.head === head) return null;
  return { ...task, prAlert: { reason, head, at: now } };
}

/**
 * The needs-input clock rides the write that moves the state: entering
 * `needs-input` stamps `needsInputSince`, leaving it for any state but `lost`
 * clears it, `inputAlerted`, `escalated` and the stay's `inputReason`/`inputTool`. `lost` keeps them: a machine's absence is not an
 * answer, and the wait resumes where it was when the machine returns. On the
 * record, so a new leader does not restart the clock.
 */
export function inputClock(task: Task, now: number): Task {
  if (task.state === "needs-input") {
    return task.needsInputSince === undefined ? { ...task, needsInputSince: now } : task;
  }
  if (task.state === "lost") return task;
  if (
    task.needsInputSince === undefined &&
    task.escalated === undefined &&
    task.inputAlerted === undefined &&
    task.inputReason === undefined &&
    task.inputTool === undefined
  ) {
    return task;
  }
  const {
    needsInputSince: _since,
    escalated: _escalated,
    inputAlerted: _alerted,
    inputReason: _reason,
    inputTool: _tool,
    ...rest
  } = task;
  return rest;
}

/**
 * The first alert of a stay: a task still waiting for input `afterMs` after it
 * began, once per stay. The wait is debounced because auto mode reports
 * `needs-input` then `busy` around every call its classifier settles (seconds
 * apart, DESIGN.md, "Session events"), and each of those leaves the state and
 * clears the clock. A stay already escalated, never stamped (an older leader's
 * record, whose clock `escalation` starts), or past `escalateAfterMs` (the
 * escalation is due, and its alert is the one: a stay past both is one push,
 * not two) is not due. Null when nothing is.
 */
export function inputAlert(task: Task, now: number, afterMs: number, escalateAfterMs: number): Task | null {
  if (task.state !== "needs-input" || task.inputAlerted === true || task.escalated === true) return null;
  if (task.needsInputSince === undefined) return null;
  const waited = now - task.needsInputSince;
  return waited >= afterMs && waited < escalateAfterMs ? { ...task, inputAlerted: true } : null;
}

/**
 * The first alert of a stay, at once: the session reports its wait is an
 * AskUserQuestion, a real choice that cannot flicker as auto mode's classifier
 * asks do, so it skips `inputAlert`'s debounce and takes its place (the same
 * `inputAlerted`, so neither the pass nor the next leader alerts that stay
 * again). The escalation is untouched. `moved` is what `sessionChange` made of
 * the event, non-null only where it accepted the machine; a null one counts
 * only for a needs-input stay its own machine (`deviceId`) re-reports, so no
 * other machine's claim alerts a task. A stay already past `escalateAfterMs`
 * is not due either: its escalation is, and that alert is the one, as in
 * `inputAlert`. Null when nothing is due.
 */
export function questionAlert(
  task: Task,
  moved: Task | null,
  deviceId: string,
  now: number,
  escalateAfterMs: number,
): Task | null {
  const heard = moved ?? (task.assignment?.deviceId === deviceId ? task : null);
  if (heard?.state !== "needs-input" || heard.inputAlerted === true || heard.escalated === true) return null;
  if (heard.needsInputSince !== undefined && now - heard.needsInputSince >= escalateAfterMs) return null;
  return { ...heard, inputAlerted: true };
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
 * A confirmed spawn on a candidate that `spill`s: alerted once per account per
 * quota window per level — the forecast (past the line) and `spending` (the
 * window already full) apart, so a window warned of alerts again once it fills
 * — not per task: the record's decision carries the spill for each task. The
 * window is told apart by its reset; two readings of one window differ by
 * seconds, so a reset only counts as a new window when it is later by more
 * than `resetGraceMs` (or the alerted one has passed), and a reading with no
 * reset never does.
 */
export class SpillAlerts {
  readonly #resetGraceMs: number;
  /**
   * `alertKey` -> the window a spill was last alerted for: its reset (ms), 0
   * when that reading carried none, and when it alerted. Seeded at takeover from
   * the stamps dispatches left on their records (`seed`), so a new leader does not
   * alert an ongoing window once more.
   */
  readonly #alerted = new Map<string, { readonly reset: number; readonly at: number }>();

  constructor(resetGraceMs: number) {
    this.#resetGraceMs = resetGraceMs;
  }

  /**
   * Learns a window a previous term alerted: the later reset per key wins, and a
   * reset of 0 (none read) never replaces one that was. A stamp that cannot
   * describe a window running at `now` is dropped, so the window that is alerts
   * once more rather than being taken for the old one: its reset passed beyond
   * the grace, or, with no reset to say, it is older than the window is long.
   */
  seed(stamp: SpillStamp, now: number): void {
    if (this.#stale(stamp.window, stamp.reset, stamp.at, now)) return;
    const key = alertKey(stamp.accountId, stamp.window, stamp.spending === true);
    const held = this.#alerted.get(key);
    if (held === undefined || stamp.reset > held.reset || (stamp.reset === held.reset && stamp.at > held.at)) {
      this.#alerted.set(key, { reset: stamp.reset, at: stamp.at });
    }
  }

  /**
   * Whether an alert for `window` with this reset, made at `at`, no longer says
   * anything about the window running at `now`. The length is the label's: a
   * per-model weekly is `7d <model>`; a label that is neither is held to the
   * shorter, so a doubt costs one repeat, never a missed window.
   */
  #stale(window: string, reset: number, at: number, now: number): boolean {
    if (reset > 0) return reset + this.#resetGraceMs < now;
    return now - at > (window.startsWith("7d") ? SPAN_MS["7d"] : SPAN_MS["5h"]);
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
    const spending = spill.spending === true;
    const key = alertKey(accountId, spill.window, spending);
    const resetS = windowResetOf(accountId, machines, spill.window, fleetQuota);
    const reset = resetS === undefined ? undefined : resetS * 1000;
    const held = this.#alerted.get(key);
    // An alert with no reset that old is of a window long gone: this one is new.
    const gone = held !== undefined && held.reset === 0 && this.#stale(spill.window, 0, held.at, now);
    const alerted = gone ? undefined : held?.reset;
    if (alerted !== undefined) {
      if (reset === undefined) return null;
      // An alert stamped with no reset learns it, without alerting again.
      if (alerted === 0) {
        this.#alerted.set(key, { reset, at: now });
        return null;
      }
      const newWindow = reset - alerted > this.#resetGraceMs || (alerted <= now && reset > now);
      if (!newWindow) return null;
    }
    this.#alerted.set(key, { reset: reset ?? 0, at: now });
    const pct = Math.round(spill.projectedPct);
    const what = spending ? "spending credits" : "may spill into credits";
    const level = spending ? { spending } : {};
    return {
      alert: {
        kind: "spill",
        taskId,
        accountId,
        window: spill.window,
        projectedPct: spill.projectedPct,
        ...level,
        message: `${what}: task=${quote(taskId)} account=${quote(accountId)} window=${quote(spill.window)} projected=${pct}%`,
      },
      stamp: { accountId, window: spill.window, reset: reset ?? 0, at: now, ...level },
    };
  }
}

/** The level leads: a label can hold a space (`7d Fable`), so a trailing word could read as part of it. */
function alertKey(accountId: string, window: string, spending: boolean): string {
  return `${spending ? "spending" : "forecast"} ${accountId} ${window}`;
}
