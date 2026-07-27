import { DEFAULT_EFFORT, DEFAULT_MODEL, type SessionEntry, type SpawnErrorCode } from "@seance/shared";

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

export type SheetKind = "machine" | "repo" | "model" | "effort" | "settings";

export type Verdict =
  | { readonly kind: "ok"; readonly window: string; readonly note?: string }
  | { readonly kind: "failed"; readonly code: SpawnErrorCode; readonly message: string; readonly repo: string }
  /** The reply was lost — usually the app was backgrounded mid-spawn. */
  | { readonly kind: "unknown"; readonly machine: string; readonly sessionCount: number | null };

/** What survives a reload; transient fields are deliberately absent. */
export interface PersistedForm {
  readonly machineId: string | null;
  readonly repo: string | null;
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
 * DEFAULT_MODEL / DEFAULT_EFFORT are plain strings on the wire; assigning them
 * here without a cast is deliberate, so dropping one from the offered list
 * fails the build instead of shipping an unselectable default.
 */
export const DEFAULT_FORM: PersistedForm = {
  machineId: null,
  repo: null,
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
