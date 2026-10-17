/**
 * Every tunable the routing reads. Defaults are docs/scheduler.md's "Settled
 * defaults"; changing one there is changing it here, and the reverse.
 */
export interface SchedulerConfig {
  /** Score weights; lower total wins. */
  readonly weights: {
    readonly accountPressure: number;
    readonly machinePressure: number;
    readonly dependencyDistance: number;
    readonly queuePressure: number;
  };
  /** Subtracted from the lineage owner's total — the only thing stickiness does. */
  readonly stickyBonus: number;
  /** Projected usage above this, in any window, filters the account unless it may spill into credits. */
  readonly quotaLinePct: number;
  /** A window resetting within this counts as empty for the filter: a task started now runs mostly after it. */
  readonly resetGraceMs: number;
  /** Fixed per-task usage estimate, whole percent per window (v1; tuned later from observed deltas). */
  readonly taskEstimatePct: number;
  /** Disk floor, MiB free; above it disk adds nothing to the score. */
  readonly minFreeMib: number;
  /** In-flight (reserved + running) scheduler tasks across the fleet. */
  readonly globalMax: number;
  readonly reservationTtlMs: number;
  /**
   * A running task whose machine has been absent this long is `lost`: shown as
   * such, never dispatched again, until that machine answers for it.
   */
  readonly lostAfterMs: number;
  /**
   * How often a pass also reads `sessions` from each connected machine holding
   * a running task: the backstop for an `ended` event that never arrived, whose
   * task would otherwise read `running` and hold its slot for good.
   */
  readonly sweepIntervalMs: number;
  /**
   * Finished tasks kept for `queue` to show; older ones are pruned, so creates
   * stay under the store's `MAX_TASKS`.
   */
  readonly keepFinished: number;
}

export const DEFAULT_CONFIG: SchedulerConfig = {
  // Account pressure is the convex `(u/(1-u))²` cost (1 at 50%, 16 at 80%); the other
  // three are fractions or small counts, so the weights put one busy machine, or the
  // farthest base, on the scale of an account near 70% (docs/scheduler.md).
  weights: { accountPressure: 1, machinePressure: 4, dependencyDistance: 4, queuePressure: 1 },
  stickyBonus: 2,
  quotaLinePct: 90,
  resetGraceMs: 15 * 60_000,
  taskEstimatePct: 5,
  minFreeMib: 1024,
  globalMax: 8,
  reservationTtlMs: 120_000,
  lostAfterMs: 15 * 60_000,
  sweepIntervalMs: 120_000,
  keepFinished: 50,
};
