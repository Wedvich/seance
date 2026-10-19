import { LAUNCH_LEDGER_MAX_AGE_MS, MIN_FREE_MIB } from "@seance/shared";

/** How long a quota window runs: the 5h session window, or any weekly (all-models or per-model). */
export type WindowSpan = "5h" | "7d";

/** One seat tier's size and the gated models its quota covers (docs/scheduler.md, Settled defaults 17). */
export interface SeatProfile {
  /** Quota relative to the largest seat; the per-task estimate there is `taskEstimatePct[span] / capacity`. */
  readonly capacity: number;
  /** `gatedModels` families this seat's quota covers; any other gated one is billed to credits. */
  readonly includes: readonly string[];
}

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
  /**
   * Fixed per-task usage estimate, percent of a window on a capacity-1 seat, by
   * the window's span (v1; tuned later from observed deltas). Per span because a
   * task's share of a week is a fraction of its share of five hours; per-model
   * weeklies take `7d`. A smaller seat's is scaled up by its `capacity`.
   */
  readonly taskEstimatePct: Readonly<Record<WindowSpan, number>>;
  /** By `ExclaveInfo.seatTier`. */
  readonly seats: Readonly<Record<string, SeatProfile>>;
  /**
   * A tier `seats` doesn't name, or none reported (older daemon, non-Team
   * account): estimated as today, but including no gated model — an unknown
   * seat may bill one to credits, so it never gets one.
   */
  readonly unknownSeat: SeatProfile;
  /** Model families a seat bills to credits unless it `includes` them; found case-insensitively in the task's model. */
  readonly gatedModels: readonly string[];
  /** Disk floor, MiB free; above it disk adds nothing to the score. */
  readonly minFreeMib: number;
  /** In-flight (`IN_FLIGHT`: reserved, running, needs-input) scheduler tasks across the fleet. */
  readonly globalMax: number;
  /** The same count per account, by the account of each task's placement. */
  readonly accountMax: number;
  /** A task in `needs-input` this long is escalated once: re-alerted, never killed, its slot kept. */
  readonly needsInputEscalateMs: number;
  readonly reservationTtlMs: number;
  /**
   * A running task whose machine has been absent this long is `lost`: shown as
   * such, never dispatched again, until that machine answers for it or
   * `lostExpiryMs` gives up on it.
   */
  readonly lostAfterMs: number;
  /**
   * A `lost` task whose machine went away (`absentSince`, else `createdAt`)
   * longer ago than this, and is disconnected now (a connected machine's
   * `sessions` is about to settle it), is `failed` `lost_expired`. Never pruned while `lost`,
   * it would hold no slot but outlive every term.
   */
  readonly lostExpiryMs: number;
  /**
   * An `awaiting-merge` task this long past `endedAt` (else `createdAt`) is
   * `failed` `merge_expired`, for the same reason. Its `after: "merged"`
   * dependents fail with it. Seven days because that is as long as a machine can
   * report the merge at all: its launch ledger evicts a task after
   * `LAUNCH_LEDGER_MAX_AGE_MS` or 128 launches, and a `here`
   * task is never read back, so past it nothing waits on a signal that can still arrive.
   */
  readonly mergeExpiryMs: number;
  /**
   * How often a pass also reads `sessions` from each connected machine holding
   * a running or `awaiting-merge` task: the backstop for an `ended` event that
   * never arrived (its task would read `running` and hold its slot for good) and
   * a `branch-state` merge that did not (its dependents would wait for good).
   */
  readonly sweepIntervalMs: number;
  /**
   * Finished tasks kept for `queue` to show; older ones are pruned, so creates
   * stay under the store's `MAX_TASKS`.
   */
  readonly keepFinished: number;
  /**
   * A pass prunes only once the store holds this many records (held plus
   * unreadable): pruning every pass would delete a finished task an app is
   * about to name in `deps` before the app's create reaches us, failing it
   * `dependency_missing`. Below the store's `MAX_TASKS`, so apps' creates still
   * have room until it fires.
   */
  readonly pruneAt: number;
}

export const DEFAULT_CONFIG: SchedulerConfig = {
  // Account pressure is the convex `(u/(1-u))²` cost (1 at 50%, 16 at 80%); the other
  // three are fractions or small counts, so the weights put one busy machine, or the
  // farthest base, on the scale of an account near 70% (docs/scheduler.md).
  weights: { accountPressure: 1, machinePressure: 4, dependencyDistance: 4, queuePressure: 1 },
  stickyBonus: 2,
  quotaLinePct: 90,
  resetGraceMs: 15 * 60_000,
  taskEstimatePct: { "5h": 5, "7d": 1 },
  // Premium seats have 6.25× a standard seat's limits, and only they cover Fable from quota.
  seats: {
    team_tier_1: { capacity: 1, includes: ["fable"] },
    team_standard: { capacity: 1 / 6.25, includes: [] },
  },
  unknownSeat: { capacity: 1, includes: [] },
  gatedModels: ["fable"],
  minFreeMib: MIN_FREE_MIB,
  globalMax: 8,
  // Half the fleet's slots: one account's sessions draw on its 5h window together.
  accountMax: 4,
  needsInputEscalateMs: 30 * 60_000,
  reservationTtlMs: 120_000,
  lostAfterMs: 15 * 60_000,
  lostExpiryMs: 7 * 24 * 60 * 60_000,
  // Tied to the ledger: past its age no machine can report the merge (`mergeExpiryMs` doc).
  mergeExpiryMs: LAUNCH_LEDGER_MAX_AGE_MS,
  sweepIntervalMs: 120_000,
  keepFinished: 50,
  pruneAt: 96,
};
