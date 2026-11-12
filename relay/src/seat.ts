import { DAEMON_ROLES } from "@seance/shared";
import { isDeviceId } from "./wire.ts";

/**
 * The archivist's seat (docs/archivist.md, A5/A6/A9): one device id on the
 * `ARCHIVIST` secret may register with the `archivist` role. No terms, no
 * nomination, no standby — so, unlike `SCHEDULER_LEADERS`, one id, never a
 * list. Pure, like `leadership.ts`, so its suite needs no workerd.
 */
export interface ArchivistSeat {
  /** The one id honoured; null honours nobody. */
  readonly id: string | null;
  /** The secret's trimmed value when it was set but is not one deviceId, for the caller to log — never fatal. */
  readonly invalid: string | null;
}

/**
 * Unset, blank, a list, a reserved name or anything outside the deviceId
 * bounds honours nobody — fail closed, never "everyone"; `*` is outside the id
 * charset, so no wildcard can exist.
 */
export function parseArchivist(raw: string | undefined): ArchivistSeat {
  const value = (raw ?? "").trim();
  if (value === "") return { id: null, invalid: null };
  return isDeviceId(value) ? { id: value, invalid: null } : { id: null, invalid: value };
}

/** Why a verified register's roles are refused; null when nothing it claims is refused. */
export type RoleRefusal = "archivist-not-seat" | "archivist-with-scheduler";

/**
 * The role claim alone, after `verifyRegister`: the roles are signed, so this
 * is the id that holds the key claiming them. `archivist` beside `scheduler` is
 * refused even from the seat, so the seat can never be a leader candidate.
 */
export function roleRefusal(deviceId: string, roles: readonly string[], seat: string | null): RoleRefusal | null {
  if (!roles.includes(DAEMON_ROLES.archivist)) return null;
  if (seat === null || deviceId !== seat) return "archivist-not-seat";
  if (roles.includes(DAEMON_ROLES.scheduler)) return "archivist-with-scheduler";
  return null;
}

/**
 * Whether a registry entry is pushed as the seat: decided per push, like
 * `connected`, against the secret as it is now. A stored flag would outlive a
 * moved or unset seat and hide the old entry from every app for good; derived,
 * the old entry reads as an ordinary one apps show and can `forget`.
 */
export function isSeat(
  entry: { readonly deviceId: string; readonly archivistClaim?: true },
  seat: string | null,
): boolean {
  return entry.archivistClaim === true && seat !== null && entry.deviceId === seat;
}
