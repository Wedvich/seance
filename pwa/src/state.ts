import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  METRIC_NAMES,
  type BatchStrategy,
  type MetricName,
  type MetricsSeries,
  type MetricsStep,
  type PauseHold,
  type Decision,
  type SessionEntry,
  type SpawnErrorCode,
  type Task,
  type TaskDep,
  type TaskUntil,
  type UnreadableTaskRef,
} from "@seance/shared";

/** Offered models. The wire keeps `model` a free string so this can change without a daemon deploy. */
export const MODELS = ["fable", "opus", "sonnet", "haiku"] as const;
export type Model = (typeof MODELS)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** `xhigh` capitalises badly; this matches what Claude Code on web shows. */
export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
};

export const MODEL_LABELS: Record<Model, string> = {
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

export type SheetKind = "machine" | "repo" | "model" | "effort" | "after" | "batch";

/** The repo sheet's rescan row: inline scanning/failure state instead of a fire-and-forget close. */
export type RescanState = "idle" | "scanning" | "failed";

export type Verdict =
  | {
      readonly kind: "ok";
      readonly window: string;
      readonly note?: string;
      readonly prompt?: string;
      /** Started, but never registered — the verdict says so instead of claiming it is running. */
      readonly pending?: true;
    }
  | {
      readonly kind: "failed";
      readonly code: SpawnErrorCode;
      readonly message: string;
      readonly repo: string;
      /**
       * What a retry's rescan settled. "missing" is conclusive — the repo is gone,
       * so the verdict stops offering retries. "unreachable" means the scan never
       * got through, so nothing was tried and the retry still stands.
       */
      readonly rescan?: "missing" | "unreachable";
    }
  /**
   * `dropped` — the reply was lost, usually to a background/suspend mid-spawn, so
   * a session may well be running. `undelivered` — the relay refused delivery, so
   * nothing started. Never conflated: one is unknown, the other is a known no.
   */
  | {
      readonly kind: "unknown";
      readonly reason: "dropped" | "undelivered";
      readonly machine: string;
      readonly sessionCount: number | null;
    }
  /**
   * An `auto` spawn the relay's store took. `task` is the newest copy the
   * leader reported — refreshed from `queue` on `queue-changed` and a bounded
   * poll while the verdict is up — so the screen follows it from waiting to
   * placed, with its decision. Until a leader reads it, it is the app's own
   * copy.
   */
  | { readonly kind: "queued"; readonly task: Task; readonly follow?: FollowEnd }
  /**
   * The store refused the task, or its answer never came; `message` says which.
   * `retry` is the task to put again: the same id, so a retry cannot queue twice.
   */
  | {
      readonly kind: "unqueued";
      readonly message: string;
      readonly mayHaveLanded: boolean;
      readonly retry?: Task;
    };

/**
 * Why a queued verdict stopped following its task before it settled.
 * `refused`: the leader answered the read with a refusal (`message`).
 * `gone`: the leader answered without it and the store holds no such task.
 * `unanswered`: the polls ran out with the last one unanswered, so what shows
 * may be stale. `unlisted`: they ran out with the last answer leaving out a
 * task the store still holds. `stopped`: they ran out while the task still waited.
 */
export type FollowEnd =
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "gone" }
  | { readonly kind: "unanswered" }
  | { readonly kind: "unlisted" }
  | { readonly kind: "stopped" };

/** What survives a reload; transient fields are deliberately absent. */
export interface PersistedForm {
  readonly machineId: string | null;
  /**
   * The machine picker's `auto`: the scheduler places the spawn. Beside
   * `machineId` rather than a sentinel in it, so turning it off falls back to
   * the machine picked last.
   */
  readonly auto: boolean;
  /** The repo `auto` runs, by `RepoEntry.origin` — the cross-machine key, since no clone is chosen. */
  readonly autoRepo: string | null;
  /**
   * Last repo picked per machine, by deviceId — the single source of truth for
   * the repo selection, so switching machines restores what you last ran there
   * instead of resetting to its first repo.
   */
  readonly repos: Readonly<Record<string, string>>;
  readonly prompt: string;
  readonly worktree: boolean;
  readonly model: Model;
  readonly effort: Effort;
  /** Per task, `auto` only: the tasks this one waits on. Cleared once a task is queued. */
  readonly after: readonly TaskDep[];
  /** Per task: what settles it. `reported` waits for its session's own done report. */
  readonly until: TaskUntil;
  /** Per task: the Linear issue it is for; empty is none. */
  readonly linearIssue: string;
  /** Spans enqueues: the batch the next one joins, until it is ended. */
  readonly batch: OpenBatch | null;
}

/**
 * A batch has no record of its own: each member carries the id and strategy, so
 * the form keeps them and numbers the next member. `next` moves only when a
 * member is stored, so a retry re-sends the same index.
 */
export interface OpenBatch {
  readonly id: string;
  readonly strategy: BatchStrategy;
  readonly next: number;
}

/** Enough to reconcile a spawn whose reply never arrived, across an app kill. */
export interface PendingSpawn {
  readonly machineId: string;
  readonly repo: string;
  readonly requestedAt: number;
}

export interface SessionsView {
  readonly sessions: readonly SessionEntry[];
  readonly at: number;
}

/**
 * Pressure belongs to a machine, quota to an account: a machine's chart is its
 * own load, an account's is read from one machine hosting it (`deviceId`) and
 * narrowed to that account's series.
 */
export type HistoryTarget =
  | { readonly kind: "machine"; readonly deviceId: string }
  | { readonly kind: "account"; readonly accountId: string; readonly deviceId: string };

/**
 * A chart asks for its own series only: every series of a multi-exclave machine
 * at a day's 5-min points overflows the relay's envelope (DESIGN.md, `metrics`).
 * All of them are whole percent, so one 0–100 axis serves either.
 */
export const TARGET_METRICS: Record<HistoryTarget["kind"], readonly MetricName[]> = {
  machine: [METRIC_NAMES.cpu, METRIC_NAMES.mem, METRIC_NAMES.disk],
  account: [METRIC_NAMES.h, METRIC_NAMES.d, METRIC_NAMES.w],
};

export const HISTORY_RANGES = ["6h", "24h", "30d"] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

/** Opens on a day: long enough to show a working pattern, on the tier that fits it. */
export const DEFAULT_HISTORY_RANGE: HistoryRange = "24h";

/** Each range on the coarsest-needed store tier, so none crosses `METRICS_MAX_POINTS`. */
export const RANGE_SPANS: Record<HistoryRange, { readonly span: number; readonly step: MetricsStep }> = {
  "6h": { span: 6 * 3600, step: 30 },
  "24h": { span: 24 * 3600, step: 300 },
  "30d": { span: 30 * 24 * 3600, step: 3600 },
};

/** The form's `route-preview`: what the scheduler would decide now, for the repo it was asked about. */
export type PreviewState =
  /** `previous` is the decision a re-ask for the same repo replaces, shown until the answer lands. */
  | { readonly kind: "loading"; readonly repo: string; readonly previous?: Decision }
  | { readonly kind: "ok"; readonly repo: string; readonly decision: Decision }
  | { readonly kind: "failed"; readonly repo: string; readonly message: string };

/** The Queue screen's read of the leader's `queue`: the tasks it keeps in view and what holds dispatch. */
export type QueueState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ok";
      readonly tasks: readonly Task[];
      readonly holds: readonly PauseHold[];
      /** Records the leader cannot read: they hold store slots no prune frees, until a person discards them. */
      readonly unreadable: readonly UnreadableTaskRef[];
      /** The leader's clock when it answered, ms. */
      readonly at: number;
      /**
       * The leader's clock minus this device's as the reply arrived (the trip
       * included), ms: what a leader-stamped time (`Task.pr.at`) needs added to
       * this device's `now` to be compared with it. Local; no frame carries it.
       */
      readonly skew: number;
    }
  | { readonly kind: "failed"; readonly message: string };

/** A cancel or mark-done on its way to the leader; the row shows it busy. */
export interface TaskAction {
  readonly taskId: string;
  readonly op: "cancel" | "mark-done";
}

export type HistoryResult =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly series: readonly MetricsSeries[] }
  | { readonly kind: "failed"; readonly message: string };

/** The one chart open on the machines screen; its window is fixed when asked, in unix seconds. */
export interface HistoryView {
  readonly target: HistoryTarget;
  readonly range: HistoryRange;
  readonly from: number;
  readonly to: number;
  readonly step: MetricsStep;
  readonly result: HistoryResult;
}

/**
 * DEFAULT_MODEL / DEFAULT_EFFORT are plain strings on the wire; assigning them
 * here without a cast is deliberate, so dropping one from the offered list
 * fails the build instead of shipping an unselectable default.
 */
export const DEFAULT_FORM: PersistedForm = {
  machineId: null,
  auto: false,
  autoRepo: null,
  repos: {},
  prompt: "",
  worktree: true,
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
  after: [],
  until: "merged",
  linearIssue: "",
  batch: null,
};

export function isModel(value: unknown): value is Model {
  return typeof value === "string" && (MODELS as readonly string[]).includes(value);
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}
