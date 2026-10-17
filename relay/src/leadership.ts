import { DAEMON_ROLES, type DaemonRole } from "@seance/shared";
import { isDeviceId } from "./wire.ts";

/**
 * Scheduler nomination, kept apart from `hub.ts` so it reproduces over plain
 * inputs with no workerd (DESIGN.md, Scheduler, "Leadership"). Nomination is the
 * only election: the relay decides, daemons never vote.
 */
export interface Candidate {
  readonly deviceId: string;
  /** Verified roles only — what a v2 register's signature covered. */
  readonly roles: readonly string[];
  /** Accept time of the daemon's current socket, ms. */
  readonly connectedAt: number;
}

/**
 * The verified roles this relay acts on. What a register signed is kept raw only
 * until it verifies; a socket attachment (2 KiB, shared with `status`) then
 * holds just these.
 */
export function knownRoles(roles: readonly string[]): readonly DaemonRole[] {
  return roles.includes(DAEMON_ROLES.scheduler) ? [DAEMON_ROLES.scheduler] : [];
}

function capable(candidate: Candidate): boolean {
  return candidate.roles.includes(DAEMON_ROLES.scheduler);
}

export interface Leaders {
  /** Device ids the relay may nominate; empty nominates nobody. */
  readonly ids: ReadonlySet<string>;
  /** Entries refused by the deviceId bounds, for the caller to log — never fatal. */
  readonly invalid: readonly string[];
}

/**
 * `SCHEDULER_LEADERS`, comma-separated device ids. Unset or empty is an empty
 * set, never "everyone": the allowlist is the gate on leader capture (DESIGN.md,
 * "Leadership"), so a missing secret must fail closed.
 */
export function parseLeaders(raw: string | undefined): Leaders {
  const ids = new Set<string>();
  const invalid: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const id = entry.trim();
    if (id === "") continue;
    if (isDeviceId(id)) ids.add(id);
    else invalid.push(id);
  }
  return { ids, invalid };
}

/**
 * The leader after a connect, close or sweep. Only a capable candidate on the
 * deploy-time allowlist (`leaders`) is eligible: `connectedAt` is a socket's
 * age, not proof of anything, and a bearer-token holder with a self-minted id
 * and signed roles would otherwise qualify like any daemon. The allowlist is a
 * required input rather than a filter the hub applies first, so no caller can
 * nominate without stating it. A current leader that is still eligible keeps
 * the role — even across its own reconnect, which resets its `connectedAt` and
 * would otherwise hand the role to whoever has sat connected longest; one taken
 * off the list loses it here. Otherwise the earliest-connected eligible
 * candidate takes it, ties broken by the lowest `deviceId` so two relays fed
 * the same sockets agree. Null when nobody is eligible.
 */
export function nominate(
  candidates: readonly Candidate[],
  current: string | null,
  leaders: ReadonlySet<string>,
): string | null {
  const eligible = candidates.filter((candidate) => capable(candidate) && leaders.has(candidate.deviceId));
  if (current !== null && eligible.some((candidate) => candidate.deviceId === current)) return current;
  let best: Candidate | null = null;
  for (const candidate of eligible) {
    if (
      best === null ||
      candidate.connectedAt < best.connectedAt ||
      (candidate.connectedAt === best.connectedAt && candidate.deviceId < best.deviceId)
    ) {
      best = candidate;
    }
  }
  return best?.deviceId ?? null;
}
