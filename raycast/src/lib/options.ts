import { DEFAULT_EFFORT, DEFAULT_MODEL } from "@seance/shared";

/**
 * The offered models and efforts. Three copies of this list exist and cannot be
 * one: `pwa/src/state.ts` (a different runtime, no dependency either way), the
 * `preferences[].data` arrays in package.json (Raycast reads static JSON — a
 * manifest cannot import), and this. `options.test.ts` asserts all three agree,
 * so the duplication drifts loudly rather than silently.
 *
 * The wire keeps `model` and `effort` free strings, so adding one here needs no
 * daemon deploy.
 */
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

/**
 * Assigned from the shared wire defaults without a cast on purpose: dropping
 * either from the lists above then fails the build instead of shipping an
 * unselectable default.
 */
export const FALLBACK_MODEL: Model = DEFAULT_MODEL;
export const FALLBACK_EFFORT: Effort = DEFAULT_EFFORT;

export function isModel(value: unknown): value is Model {
  return typeof value === "string" && (MODELS as readonly string[]).includes(value);
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}
