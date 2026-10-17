import { DAEMON_ROLES, type DaemonRole, type Envelope } from "@seance/shared";
import { isDeviceId } from "./wire.ts";

/**
 * Scheduler nomination and the term's record and checks, kept apart from
 * `hub.ts` so they reproduce over plain inputs with no workerd (DESIGN.md,
 * Scheduler, "Leadership"). Nomination is the only election: the relay decides,
 * daemons never vote. Storage I/O stays in the hub, which owns every write and
 * its `failed to persist` logging.
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

/**
 * The scheduler leader record. In storage rather than on an attachment because
 * `term` must outlive every socket — it is monotonic for the life of the DO, so
 * a term a demoted leader holds can never come round again.
 */
export const LEADER_KEY = "scheduler:term";

export interface LeaderRecord {
  readonly term: number;
  readonly deviceId: string | null;
  /** The leader socket's accept time: a new socket under the same id is a new term. */
  readonly connectedAt: number | null;
  /** The first `lead-proof` that socket sent under this term; a new term starts without one. */
  readonly proof?: Envelope;
}

export const NO_LEADER: LeaderRecord = { term: 0, deviceId: null, connectedAt: null };

/** What a term was issued to: a daemon socket's registered id and accept time. */
export interface LeaderSocket {
  readonly deviceId: string;
  readonly connectedAt: number;
}

/**
 * The daemon-leg check (`lead-proof`, store writes). The term is public — every
 * registry push carries it — so a write is the leader's only from the socket the
 * term was issued to: same `deviceId` and `connectedAt`.
 */
export function holdsTerm(record: LeaderRecord, term: number | undefined, socket: LeaderSocket | null): boolean {
  return (
    term !== undefined &&
    socket !== null &&
    record.term === term &&
    record.deviceId === socket.deviceId &&
    record.connectedAt === socket.connectedAt
  );
}

/**
 * The fence for `msg` sent `from: "scheduler"` on the leader's **app-role** leg.
 * App sockets carry no identity, so it can check only the term. It stops a stale
 * leader, never a stranger.
 */
export function isCurrentTerm(record: LeaderRecord, term: number | undefined, leaderConnected: boolean): boolean {
  return term !== undefined && leaderConnected && record.deviceId !== null && record.term === term;
}

/** The record after a re-nomination, or null when nothing moved. A new term starts without a proof. */
export function nextLeaderRecord(
  record: LeaderRecord,
  next: string | null,
  connectedAt: number | null,
): LeaderRecord | null {
  if (next === record.deviceId && connectedAt === record.connectedAt) return null;
  return { term: record.term + 1, deviceId: next, connectedAt };
}
