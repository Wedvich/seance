import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  METRIC_NAMES,
  type MetricName,
  type MetricsSeries,
  type MetricsStep,
  type PauseHold,
  type Decision,
  type SessionEntry,
  type Task,
  type TaskDep,
  type TaskUntil,
  type IdleTaskRef,
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

export type SheetKind = "machine" | "account" | "repo" | "model" | "effort" | "after" | "batch";

/**
 * The Machine sheet's rescan action: inline scanning/failure state on the row it
 * was asked for, so only that row shows it.
 */
export type RescanState =
  | { readonly kind: "idle" }
  | { readonly kind: "scanning" | "failed"; readonly deviceId: string };

/** One shared object, so `#patch`'s identity check sees an idle rescan as unchanged. */
export const RESCAN_IDLE: RescanState = { kind: "idle" };

export type Verdict =
  /**
   * A spawn the relay's store took. `task` is the newest copy the
   * leader reported — refreshed from `queue` on `queue-changed` and a bounded
   * poll while the verdict is up — so the screen follows it from waiting to
   * placed, with its decision. Until a leader reads it, it is the app's own
   * copy.
   */
  | { readonly kind: "queued"; readonly task: Task; readonly follow?: FollowEnd }
  /**
   * The store refused the task, or its answer never came; `message` says which.
   * `retry` is the task to put again: the same id, so a retry cannot queue twice.
   * `runNow`: it was a Start now, and a retry is one too.
   */
  | {
      readonly kind: "unqueued";
      readonly message: string;
      readonly mayHaveLanded: boolean;
      readonly retry?: Task;
      readonly runNow?: true;
    };

/** Why a Start now's `run-now` left its task where it was, as a sentence, for the queued verdict of `taskId`. */
export interface StartNowRefusal {
  readonly taskId: string;
  readonly message: string;
}

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
  /** The machine pick, by deviceId; null is `auto`: the scheduler chooses. Written to the task as `pin.deviceId`. */
  readonly machine: string | null;
  /** The account pick, by accountId; null is `auto`. Written as `pin.account`; the alias is display only. */
  readonly account: string | null;
  /** The repo to run, by `RepoEntry.origin` — the cross-machine key, since no clone is chosen. */
  readonly repo: string | null;
  readonly prompt: string;
  readonly worktree: boolean;
  readonly model: Model;
  readonly effort: Effort;
  /** Per task: the tasks this one waits on. Cleared once a task is queued. */
  readonly after: readonly TaskDep[];
  /** Per task: what settles it. `reported` waits for its session's own done report. */
  readonly until: TaskUntil;
  /** Per task: the Linear issue it is for; empty is none. */
  /** Spans enqueues: the batch the next one joins, until it is ended. */
  readonly batch: OpenBatch | null;
}

/**
 * A batch has no record of its own: each member carries the id, so the form
 * keeps it and numbers the next member. `next` moves only when a member is
 * stored, so a retry re-sends the same index.
 */
export interface OpenBatch {
  readonly id: string;
  readonly next: number;
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
      /** Running tasks the leader holds no slot for while they sit idle at their prompt (`QueueResponse.idle`). */
      readonly idle: readonly IdleTaskRef[];
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

/** Account aliases: the names every client shows for a Claude account, read from the relay's `account:` records. */
export interface AccountsState {
  /** accountId to alias; only readable, non-cleared records. */
  readonly aliases: Readonly<Record<string, string>>;
  /** False on an install saved before account records: it has no account key until the PSK is re-entered. */
  readonly nameable: boolean;
  /** The accountId a rename is in flight for. */
  readonly saving: string | null;
  /** The last rename's refusal or failure, as a sentence; cleared by the next rename or a dismiss. */
  readonly notice: string | null;
}

/** A task's action on its way to the leader (a continue: to the store); the row shows it busy. */
export interface TaskAction {
  readonly taskId: string;
  readonly op: "cancel" | "mark-done" | "run-now" | "continue";
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
  machine: null,
  account: null,
  repo: null,
  prompt: "",
  worktree: true,
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
  after: [],
  until: "merged",
  batch: null,
};

export function isModel(value: unknown): value is Model {
  return typeof value === "string" && (MODELS as readonly string[]).includes(value);
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}
