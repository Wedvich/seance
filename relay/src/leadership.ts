import { DAEMON_ROLES, type DaemonRole } from "@seance/shared";

/**
 * Scheduler nomination, kept apart from `hub.ts` so it reproduces over plain
 * inputs with no workerd (DESIGN.md, "Scheduler leadership"). Nomination is the
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

/**
 * The leader after a connect, close or sweep. A current leader that is still a
 * capable candidate keeps the role — even across its own reconnect, which
 * resets its `connectedAt` and would otherwise hand the role to whoever has sat
 * connected longest. Otherwise the earliest-connected capable candidate takes
 * it, ties broken by the lowest `deviceId` so two relays fed the same sockets
 * agree. Null when nobody is capable.
 *
 * `connectedAt` is a socket's age, not proof of anything: a bearer-token holder
 * with a self-minted id and signed roles qualifies like any daemon. Readers
 * guard against that today (an unverifiable leader is no leader); a relay-side
 * gate is M3's, and would filter `candidates` before this runs.
 */
export function nominate(candidates: readonly Candidate[], current: string | null): string | null {
  const eligible = candidates.filter(capable);
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
