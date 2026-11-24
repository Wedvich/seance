import { autonomyOf } from "./autonomy.ts";
import type { TaskSpec } from "./types.ts";

/**
 * What every reader of a Codex task or login holds it to (DESIGN.md, Scheduler, "Codex tasks"; Daemon, "Codex login"):
 * here, in `shared/`, because the daemon's probe and `seance codex`, the leader's routing and the clients' `specError`
 * must agree on them.
 */

/** The version the spikes ran (docs/codex.md, S1–S9): 0.166.0's `account/read` has no `userId`. */
export const CODEX_MIN_VERSION = "0.170.0";

const VERSION_PATTERN = /\b(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[0-9A-Za-z.-]{1,32})?\b/u;

/** `codex --version`'s `codex-cli 0.170.0` → `0.170.0`; null for anything without a version in it. */
export function parseCodexVersion(stdout: string): string | null {
  const match = VERSION_PATTERN.exec(stdout);
  return match === null ? null : match[0];
}

/** Semver order on the numeric triple; a prerelease of the floor itself is below it, and so is no version at all. */
export function versionAtLeast(version: string, floor: string = CODEX_MIN_VERSION): boolean {
  const a = VERSION_PATTERN.exec(version);
  const b = VERSION_PATTERN.exec(floor);
  if (a === null || b === null) return false;
  for (const i of [1, 2, 3]) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff !== 0) return diff > 0;
  }
  return a[4] === undefined || b[4] !== undefined;
}

/**
 * What V1 refuses beside `agent: "codex"` (docs/codex.md, "The task"), named for a client's refusal: effort `max`, any
 * autonomy but `auto` (D6; `steer` is plan mode), `attachments` and `succeeds`. `continues` passes (item 10): its gate
 * is `CAPABILITIES.codexContinue`, the leader's and the target's, never this one. Null
 * for a Claude task or a Codex one V1 runs. `specError` refuses on it before a write; routing rejects every candidate
 * of a record that carries one anyway (`agent_unsupported`), so it stays readable and is placed nowhere until a build
 * that supports it.
 */
export function codexSpecRefusal(
  spec: Pick<TaskSpec, "agent" | "effort" | "plan" | "autonomy" | "attachments" | "succeeds">,
): string | null {
  if (spec.agent === undefined) return null;
  if (spec.effort === "max") return "effort max";
  // `plan: true` alone reads `steer`, and an absent level `checkpoint`: a Codex task says `auto` explicitly.
  const level = autonomyOf(spec);
  if (level !== "auto") return `autonomy ${level}`;
  if (spec.attachments !== undefined) return "attachments";
  if (spec.succeeds !== undefined) return "a successor";
  return null;
}

/**
 * `codexSpecRefusal`'s clause as the line a client refuses with: the autonomy case says what to send instead, since
 * every client defaults to `checkpoint` and a Codex task must say `auto` explicitly (D6).
 */
export function codexRefusalText(refusal: string): string {
  return refusal.startsWith("autonomy ")
    ? `a Codex task runs only at autonomy auto for now, not ${refusal.slice("autonomy ".length)}`
    : `a Codex task can't run with ${refusal} yet`;
}

/**
 * `codexSpecRefusal`'s clause an amendment of `spec` would bring in, or null. Of the fields an amend changes only
 * `effort` meets a refusal, so a Codex task amended to `max` is refused before a write: by `sendAmend` on the spec it
 * reads, and by the leader's `amendSpec` on the one it holds, as a create would be, instead of being placed nowhere.
 */
export function codexAmendRefusal(
  spec: Pick<TaskSpec, "agent" | "effort" | "plan" | "autonomy" | "attachments" | "succeeds">,
  amend: { readonly effort?: string | null },
): string | null {
  return amend.effort === "max" ? codexSpecRefusal({ ...spec, effort: amend.effort }) : null;
}
