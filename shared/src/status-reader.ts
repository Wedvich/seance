import type { Machine } from "./app-client.ts";
import { REPLAY_WINDOW_MS } from "./crypto.ts";
import {
  CAPABILITIES,
  STATUS_INTERVAL_MS,
  type CustodianStatus,
  type MachineStatus,
  type QuotaObservation,
  type Task,
} from "./types.ts";

/**
 * The rules every reader of a `status` goes through, so the PWA and the
 * scheduler cannot disagree on one. The parser checks types; these check
 * ranges and relations, which need the register blob's exclave list and a
 * clock (DESIGN.md, Presence & identity).
 */

/** Three missed beats: past this a snapshot says nothing about the machine now. */
export const STATUS_STALE_MS = 3 * STATUS_INTERVAL_MS;

/** How far ahead of the reader's clock a stamp may be — the tolerance live frames already get. */
export const STATUS_CLOCK_SKEW_MS = REPLAY_WINDOW_MS;

const MAX_PCT = 100;

/**
 * True once the snapshot is older than `STATUS_STALE_MS`, or stamped further
 * in the future than clock skew explains — a stamp that far ahead would
 * otherwise read as fresh for as long as it claims.
 */
export function isStatusStale(status: MachineStatus, nowMs: number): boolean {
  const ageMs = nowMs - status.at * 1000;
  return ageMs > STATUS_STALE_MS || ageMs < -STATUS_CLOCK_SKEW_MS;
}

/**
 * The status a pressure reader may use: only a connected machine's. A machine
 * whose socket went keeps its last status for its accounts' quota
 * (`newestQuotaByAccount`), but its pressure is unknown however recent that
 * status is — the machine is gone. Age is the caller's next check (`isStatusStale`).
 */
export function liveStatus(machine: Pick<Machine, "connected" | "status">): MachineStatus | undefined {
  return machine.connected ? machine.status : undefined;
}

/**
 * When the machine was closed to new scheduled work (ms), from its newest status, kept or
 * live: closed is sticky, so a sleeping machine's last word stands. Display only; routing
 * reads `liveStatus`.
 */
export function closedAt(machine: Pick<Machine, "status">): number | null {
  return machine.status?.cl ?? null;
}

/**
 * When a closed machine's drain began (ms): the one predicate for the leader's outside pass (the PWA's soft state reads
 * it next). `dr` when sent; else `cl` for a daemon without `softClose` (its close always drained); else null, a soft close.
 */
export function drainStart(machine: Pick<Machine, "status" | "capabilities">): number | null {
  const cl = closedAt(machine);
  if (cl === null) return null;
  const dr = machine.status?.dr;
  if (dr !== undefined) return dr;
  return machine.capabilities?.includes(CAPABILITIES.softClose) === true ? null : cl;
}

/** The custodian seat's view from a status, null when none was sent: display only. */
export function custodianOf(status: MachineStatus | null | undefined): CustodianStatus | null {
  return status?.cu ?? null;
}

/** One exclave's login as a reader sees it; `expiresAt` is ms. */
export type ExclaveAuth =
  | { readonly state: "ok" }
  | { readonly state: "expiring"; readonly expiresAt: number }
  | { readonly state: "expired" }
  | { readonly state: "unknown" };

/**
 * The one rule for an exclave's login — routing, the PWA, MCP and the alert step read it
 * here. `unknown` when there is no live fresh status or the daemon does not advertise
 * `authHealth` (then "not listed" means nothing), and for an exclave in `au`. An `ae` time
 * already past reads expired: the daemon's next read lags it by up to its reread interval.
 */
export function exclaveAuth(
  machine: Pick<Machine, "connected" | "status" | "capabilities">,
  index: number,
  nowMs: number,
): ExclaveAuth {
  const status = liveStatus(machine);
  if (status === undefined || isStatusStale(status, nowMs)) return { state: "unknown" };
  if (machine.capabilities?.includes(CAPABILITIES.authHealth) !== true) return { state: "unknown" };
  if (status.ax?.includes(index) === true) return { state: "expired" };
  const expiring = status.ae?.find(([x]) => x === index);
  if (expiring !== undefined) {
    const expiresAt = expiring[1] * 1000;
    return expiresAt <= nowMs ? { state: "expired" } : { state: "expiring", expiresAt };
  }
  if (status.au?.includes(index) === true) return { state: "unknown" };
  return { state: "ok" };
}

/**
 * One agent login's health as a reader sees it (DESIGN.md, Daemon, "Codex login"): routing, MCP, the PWA and the
 * alert step read it here. From a live fresh status, as `exclaveAuth`: `expired` for `lx`, `unknown` for `lu` (a
 * login before its first probe included, whose blob still says `authOk: false`); then, by the blob, `signed_out`
 * (`authOk: false`) and `unidentified` (signed in with no account id); `blocked` for `lb` (signed in, included usage
 * refused); otherwise `ok`. With no live fresh status, `unknown` for a login the blob holds signed in. No capability
 * check: a daemon that sends `logins` sends these lists with them.
 */
export type LoginHealth = "ok" | "expired" | "blocked" | "unknown" | "signed_out" | "unidentified";

export function loginHealth(
  machine: Pick<Machine, "connected" | "status" | "logins">,
  index: number,
  nowMs: number,
): LoginHealth {
  const login = machine.logins?.[index];
  if (login === undefined) return "signed_out";
  const status = liveStatus(machine);
  if (status === undefined || isStatusStale(status, nowMs)) return login.authOk ? "unknown" : "signed_out";
  if (status.lx?.includes(index) === true) return "expired";
  if (status.lu?.includes(index) === true) return "unknown";
  if (!login.authOk) return "signed_out";
  if (login.accountId === null) return "unidentified";
  return status.lb?.includes(index) === true ? "blocked" : "ok";
}

/** One trait probe as a reader sees it. */
export type TraitHealth = "healthy" | "failing" | "unknown";

/**
 * The one rule for a trait's probe on one exclave — routing, the PWA and MCP read it here.
 * Null when the exclave does not carry `trait`. `unknown` (which routes) when there is no
 * live fresh status, and for a pair in `tu`; `failing` only for a pair in `tf`. No capability
 * check: a daemon without probes never lists a pair, and an absent `tf` reads healthy.
 * The trait index is the position in the exclave's advertised `ExclaveInfo.traits`.
 */
export function exclaveTraitHealth(
  machine: Pick<Machine, "connected" | "status" | "exclaves">,
  index: number,
  trait: string,
  nowMs: number,
): TraitHealth | null {
  const traitIndex = machine.exclaves?.[index]?.traits?.indexOf(trait) ?? -1;
  if (traitIndex === -1) return null;
  const status = liveStatus(machine);
  if (status === undefined || isStatusStale(status, nowMs)) return "unknown";
  if (hasPair(status.tf, index, traitIndex)) return "failing";
  return hasPair(status.tu, index, traitIndex) ? "unknown" : "healthy";
}

/**
 * True only for a probe the daemon itself reports not yet read (a pair in the live fresh
 * status's `tu`). Unlike `exclaveTraitHealth`'s `unknown`, a trait with no probe, or a
 * machine whose status is absent or stale, is not a probe awaiting a reading.
 */
export function exclaveTraitUnchecked(
  machine: Pick<Machine, "connected" | "status" | "exclaves">,
  index: number,
  trait: string,
  nowMs: number,
): boolean {
  const traitIndex = machine.exclaves?.[index]?.traits?.indexOf(trait) ?? -1;
  if (traitIndex === -1) return false;
  const status = liveStatus(machine);
  if (status === undefined || isStatusStale(status, nowMs)) return false;
  return hasPair(status.tu, index, traitIndex);
}

function hasPair(pairs: MachineStatus["tf"], index: number, traitIndex: number): boolean {
  return pairs?.some(([x, t]) => x === index && t === traitIndex) === true;
}

/**
 * When the machine was last heard from: the later of `lastSeen` and the kept
 * `status.at`. While the relay still lists a slept socket, `lastSeen` is the
 * register's time, hours or days old; the last `status` beat is within one
 * beat of the sleep either way (docs/scheduler.md, "Asleep machines").
 * `status.at` is the daemon's clock: a fast one understates the age by its
 * skew, accepted for a display-only "last seen".
 */
export function lastHeardAt(machine: Pick<Machine, "lastSeen" | "status">): number {
  const beat = machine.status === undefined ? 0 : machine.status.at * 1000;
  return Math.max(machine.lastSeen, beat);
}

/**
 * True when the daemon trimmed this status to fit the relay's bound. Its
 * quota is then incomplete: an exclave without an observation is unknown, not
 * unobserved, and an observation may lack its per-model windows and resets.
 */
export function isQuotaTrimmed(status: MachineStatus): boolean {
  return status.tr !== undefined;
}

/**
 * `null` when the status contradicts itself or the register blob it indexes:
 * a percent over 100, a `sess` that is not one count per exclave, a quota
 * index out of range or repeated, or more entries kept plus trimmed than there
 * are exclaves (the parser has already bounded every integer to the safe
 * range). Like the parser, one
 * bad field costs the tick. A quota observation stamped further ahead than
 * clock skew is dropped alone — it would read as the newest for its account
 * until the clock caught up. Returns `status` itself when nothing is dropped.
 *
 * The agent logins' fields (`lq`, `lx`, `lu`, `lb`) are held to `loginCount`, the blob's `logins`, the same way, but
 * one that contradicts it drops those four fields alone, never the status: a blob whose `logins` this build cannot
 * read (a newer agent kind) holds none while its daemon still reports them, and that must not cost the machine its
 * Claude quota and pressure.
 */
export function sanitizeStatus(
  status: MachineStatus,
  exclaveCount: number,
  nowMs: number,
  loginCount = 0,
): MachineStatus | null {
  const { cpu, mem, disk, sess, quota, tr } = status;
  if (![cpu, mem, disk].every(isPct)) return null;
  if (sess !== undefined && sess.length !== exclaveCount) return null;
  if (quota !== undefined && (quota.length + (tr ?? 0) > exclaveCount || !indicesSane(quota, exclaveCount))) {
    return null;
  }
  if (quota === undefined && (tr ?? 0) > exclaveCount) return null;
  const horizonS = (nowMs + STATUS_CLOCK_SKEW_MS) / 1000;
  const logins = sanitizeLogins(status, loginCount, horizonS);
  const kept = quota?.filter((q) => q.at <= horizonS);
  if (kept?.length === quota?.length && logins === null) return status;
  const { quota: _quota, lq: _lq, lx: _lx, lu: _lu, lb: _lb, ...rest } = status;
  const { lq, lx, lu, lb } = logins ?? status;
  return {
    ...rest,
    ...(kept === undefined || kept.length === 0 ? {} : { quota: kept }),
    ...(lq === undefined ? {} : { lq }),
    ...(lx === undefined ? {} : { lx }),
    ...(lu === undefined ? {} : { lu }),
    ...(lb === undefined ? {} : { lb }),
  };
}

/**
 * Null when the login fields stand as sent; else the ones to keep: none when an index falls outside `loginCount`,
 * repeats, or a reading is not a percent; `lq` without a reading stamped past `horizonS`.
 */
function sanitizeLogins(
  status: MachineStatus,
  loginCount: number,
  horizonS: number,
): Pick<MachineStatus, "lq" | "lx" | "lu" | "lb"> | null {
  const { lq, lx, lu, lb } = status;
  if (lq === undefined && lx === undefined && lu === undefined && lb === undefined) return null;
  const listed = [...(lx ?? []), ...(lu ?? []), ...(lb ?? [])];
  if (listed.some((x) => x >= loginCount) || !indicesSane(lq ?? [], loginCount)) return {};
  const kept = (lq ?? []).filter((q) => q.at <= horizonS);
  if (lq === undefined || kept.length === lq.length) return null;
  return { ...(kept.length === 0 ? {} : { lq: kept }), lx, lu, lb };
}

/** Every observation's index in range and unrepeated, every percent a percent. */
function indicesSane(observations: readonly QuotaObservation[], count: number): boolean {
  const seen = new Set<number>();
  for (const q of observations) {
    if (q.x >= count || seen.has(q.x) || !isSaneObservation(q)) return false;
    seen.add(q.x);
  }
  return true;
}

function isSaneObservation(q: QuotaObservation): boolean {
  if (!isPct(q.h) || !isPct(q.d) || !isPct(q.c)) return false;
  return q.w === undefined || q.w.every((w) => isPct(w.p));
}

function isPct(value: number | undefined): boolean {
  return value === undefined || value <= MAX_PCT;
}

/** States whose headline says the machine is asleep: a session may be alive there, waiting on the lid. */
const SLEEP_AWARE: ReadonlySet<Task["state"]> = new Set(["reserved", "running", "needs-input", "lost"]);

/**
 * The task's machine when it is listed and not `connected` as this client sees
 * it — the signal the Machines card's "asleep" reads, never the relay flag alone
 * (DESIGN.md, "The Queue screen"). A derived view: the leader's state is unchanged.
 */
export function sleepingMachine(task: Task, machines: readonly Machine[]): Machine | undefined {
  if (!SLEEP_AWARE.has(task.state)) return undefined;
  const at = task.assignment ?? task.reservation;
  if (at === undefined) return undefined;
  const machine = machines.find((m) => m.deviceId === at.deviceId);
  return machine?.connected === false ? machine : undefined;
}
