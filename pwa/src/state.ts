import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  METRIC_NAMES,
  type MetricName,
  type MetricsSeries,
  type MetricsStep,
  type SessionEntry,
  type SpawnErrorCode,
} from "@seance/shared";

/** Offered models. The wire keeps `model` a free string so this can change without a daemon deploy. */
export const MODELS = ["fable", "opus", "sonnet"] as const;
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
};

export type SheetKind = "machine" | "repo" | "model" | "effort";

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
    };

/** What survives a reload; transient fields are deliberately absent. */
export interface PersistedForm {
  readonly machineId: string | null;
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
  machine: [METRIC_NAMES.cpu, METRIC_NAMES.mem],
  account: [METRIC_NAMES.h, METRIC_NAMES.d, METRIC_NAMES.w],
};

export const HISTORY_RANGES = ["6h", "24h", "30d"] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

/** Each range on the coarsest-needed store tier, so none crosses `METRICS_MAX_POINTS`. */
export const RANGE_SPANS: Record<HistoryRange, { readonly span: number; readonly step: MetricsStep }> = {
  "6h": { span: 6 * 3600, step: 30 },
  "24h": { span: 24 * 3600, step: 300 },
  "30d": { span: 30 * 24 * 3600, step: 3600 },
};

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
  repos: {},
  prompt: "",
  worktree: true,
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
};

export function isModel(value: unknown): value is Model {
  return typeof value === "string" && (MODELS as readonly string[]).includes(value);
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}
