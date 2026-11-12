import type { UpdateAvailable } from "@seance/shared";

/**
 * Shape check for an `update-available` broadcast's payload. Advisory only — the updater verifies
 * against its own origin — so shape is all there is to check. Its own module so the archivist's
 * seat can follow the announce without loading the daemon's op dispatch.
 */
export function isUpdateAvailable(payload: unknown): payload is UpdateAvailable {
  if (typeof payload !== "object" || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  return typeof obj["sha"] === "string" && obj["sha"] !== "" && typeof obj["commitTs"] === "number";
}
