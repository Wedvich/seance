import type { SpawnRequest } from "./types.ts";

/**
 * How much a session decides on its own (DESIGN.md, "Autonomy level"): `steer` plans and waits
 * for approval, `checkpoint` proceeds and stops on real choices, `auto` also decides the
 * reversible ones and records them. A prompt rule, never a permission grant: no level loosens
 * the machine's permission mode, and only `steer` tightens it (to `plan`).
 */
export const AUTONOMY_LEVELS = ["steer", "checkpoint", "auto"] as const;

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const DEFAULT_AUTONOMY: AutonomyLevel = "checkpoint";

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return AUTONOMY_LEVELS.some((level) => level === value);
}

/**
 * The level a request runs at. `plan: true` alone is `steer`: that is how an older client asks
 * for it, and why a `steer` request always carries `plan: true` too — a leader or daemon that
 * drops `autonomy` still starts the session in plan mode.
 */
export function autonomyOf(request: Pick<SpawnRequest, "autonomy" | "plan">): AutonomyLevel {
  return request.autonomy ?? (request.plan === true ? "steer" : DEFAULT_AUTONOMY);
}

/**
 * `plan` and `autonomy` as one consistent pair, or null for a contradiction (`plan: true` beside
 * a level other than `steer`). `steer` gains `plan: true`; anything else keeps what it had.
 */
export function withAutonomy<T extends Pick<SpawnRequest, "autonomy" | "plan">>(request: T): T | null {
  const { autonomy, plan } = request;
  if (autonomy === undefined) return request;
  if (autonomy === "steer") return plan === true ? request : { ...request, plan: true };
  return plan === true ? null : request;
}
