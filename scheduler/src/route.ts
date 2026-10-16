import {
  CAPABILITIES,
  effectivePct,
  isQuotaTrimmed,
  isStatusStale,
  liveStatus,
  newestQuotaByAccount,
  type Candidate,
  type Decision,
  type ExclaveInfo,
  type Machine,
  type MachineStatus,
  type NewestQuota,
  type QuotaBasis,
  type QuotaObservation,
  type Reason,
  type ScoreComponents,
} from "@seance/shared";
import type { SchedulerConfig } from "./config.ts";
import { IN_FLIGHT, type Placement, type Task } from "./task.ts";

// The decision record is a wire type — `route-preview` and `queue` carry it —
// so its shapes live in the schema of record.
export type { Candidate, Decision, QuotaBasis, Reason, ReasonCode, Score, ScoreComponents } from "@seance/shared";

/**
 * Filter → score → sticky over one snapshot, as one pure function
 * (docs/scheduler.md, "Routing"). Every candidate is a (machine, exclave)
 * pair; each is either rejected with every reason that applies, or scored
 * with every component, so the record explains the choice and each loser.
 */
export interface RouteInput {
  readonly task: Task;
  readonly machines: readonly Machine[];
  /** Every task the scheduler holds; only in-flight ones other than `task` count. */
  readonly tasks: readonly Task[];
  readonly now: number;
  readonly config: SchedulerConfig;
}

const FIVE_HOURS_MS = 5 * 3600_000;
const SEVEN_DAYS_MS = 7 * 86_400_000;
/** The convex cost is unbounded at 100%; this keeps an over-full account finite and still worst. */
const MAX_UTILISATION = 0.99;

interface QuotaWindow {
  readonly label: string;
  readonly pct: number;
  /** Unix seconds. */
  readonly resetsAt: number | undefined;
  readonly lengthMs: number;
}

type AccountQuota =
  | { readonly known: true; readonly newest: NewestQuota; readonly windows: readonly QuotaWindow[] }
  | { readonly known: false; readonly why: "unobserved" | "trimmed" };

/** What every candidate of one routing pass is judged against. */
interface Pass {
  readonly task: Task;
  readonly now: number;
  readonly config: SchedulerConfig;
  readonly inFlight: readonly Task[];
  readonly quotaOf: (accountId: string) => AccountQuota;
  readonly accountAt: (placement: Placement) => string | null;
  readonly capReached: Reason | null;
}

export function route(input: RouteInput): Decision {
  const { task, machines, now, config } = input;
  const inFlight = input.tasks.filter((t) => t.id !== task.id && IN_FLIGHT.includes(t.state));
  const newest = newestQuotaByAccount(machines);
  const pass: Pass = {
    task,
    now,
    config,
    inFlight,
    quotaOf: cached((accountId) => accountQuota(accountId, machines, newest)),
    accountAt: (placement) =>
      machines.find((m) => m.deviceId === placement.deviceId)?.exclaves?.find((x) => x.id === placement.exclave)
        ?.accountId ?? null,
    capReached:
      inFlight.length >= config.globalMax
        ? { code: "cap_reached", inFlight: inFlight.length, max: config.globalMax }
        : null,
  };

  const candidates: Candidate[] = [];
  for (const machine of machines) {
    const machineReasons = [
      ...machineFilter(machine, now, config),
      ...(pass.capReached === null ? [] : [pass.capReached]),
    ];
    if (machine.exclaves === undefined || machine.exclaves.length === 0) {
      candidates.push({ deviceId: machine.deviceId, machine: machine.name, exclave: null, rejected: machineReasons });
      continue;
    }
    for (const exclave of machine.exclaves) candidates.push(judge(pass, machine, machineReasons, exclave));
  }

  const scored = candidates
    .filter((c) => c.score !== undefined)
    .toSorted(
      (a, b) =>
        (a.score?.total ?? 0) - (b.score?.total ?? 0) ||
        // Code-unit order, not localeCompare: a decision must reproduce on any leader's locale.
        codeUnitOrder(a.deviceId, b.deviceId) ||
        codeUnitOrder(a.exclave ?? "", b.exclave ?? ""),
    );
  const best = scored[0];
  const chosen =
    best === undefined || best.exclave === null || best.clone === undefined
      ? null
      : { deviceId: best.deviceId, exclave: best.exclave, clone: best.clone };
  return { at: now, chosen, candidates: [...scored, ...candidates.filter((c) => c.score === undefined)] };
}

/** One (machine, exclave): rejected with every reason that applies, else scored. */
function judge(pass: Pass, machine: Machine, machineReasons: readonly Reason[], exclave: ExclaveInfo): Candidate {
  const { task, config, inFlight } = pass;
  const clone = machine.repos.find((r) => r.exclave === exclave.id && r.origin === task.spec.repo);
  const rejected: Reason[] = [...machineReasons, ...pinFilter(task, machine, exclave)];
  if (clone === undefined) rejected.push({ code: "repo_absent" });
  if (!exclave.authOk || exclave.accountId === null) rejected.push({ code: "auth_missing" });
  const account = exclave.accountId === null ? null : judgeAccount(pass, exclave, exclave.accountId);
  if (account?.reason !== undefined) rejected.push(account.reason);

  const base: Candidate = {
    deviceId: machine.deviceId,
    machine: machine.name,
    exclave: exclave.id,
    rejected,
    ...(clone === undefined ? {} : { clone: clone.name }),
    ...(account?.quota === undefined ? {} : { quota: account.quota }),
    ...(account?.spill === undefined ? {} : { spill: account.spill }),
  };
  // machineFilter has rejected every machine without a usable status; the check narrows it.
  const status = liveStatus(machine);
  if (rejected.length > 0 || status === undefined || account === null) return base;

  const placement = { deviceId: machine.deviceId, exclave: exclave.id };
  const components: ScoreComponents = {
    accountPressure: account.pressure,
    machinePressure: Math.max(status.cpu ?? 0, status.mem ?? 0) / 100,
    dependencyDistance: distance(task.spec.base, placement),
    queuePressure: inFlight.filter((t) => (t.assignment ?? t.reservation)?.deviceId === machine.deviceId).length,
  };
  const sticky = samePlacement(task.spec.lineage, placement) ? config.stickyBonus : 0;
  const { weights } = config;
  const total =
    weights.accountPressure * components.accountPressure +
    weights.machinePressure * components.machinePressure +
    weights.dependencyDistance * components.dependencyDistance +
    weights.queuePressure * components.queuePressure -
    sticky;
  return { ...base, score: { components, sticky, total } };
}

interface AccountJudgement {
  readonly reason?: Reason;
  readonly quota?: QuotaBasis;
  readonly spill?: Candidate["spill"];
  readonly pressure: number;
}

/** Projected usage counts this task and every in-flight one on the same account. */
function judgeAccount(pass: Pass, exclave: ExclaveInfo, accountId: string): AccountJudgement {
  const account = pass.quotaOf(accountId);
  if (!account.known) return { reason: { code: "quota_unknown", why: account.why }, pressure: 0 };
  const { observation, deviceId } = account.newest;
  const quota = { observedAt: observation.at, observer: deviceId, source: observation.s };
  const sharing = pass.inFlight.filter((t) => {
    const at = t.assignment ?? t.reservation;
    return at !== undefined && pass.accountAt(at) === accountId;
  }).length;
  const added = pass.config.taskEstimatePct * (sharing + 1);
  const pressure = pressureOf(account.windows, added, pass.now);
  const over = overLine(account.windows, added, pass.now, pass.config);
  if (over === null) return { quota, pressure };
  if (exclave.extraUsageEnabled === true) return { quota, spill: over, pressure };
  return { reason: { code: "quota_over_line", ...over }, quota, pressure };
}

/**
 * Pressure describes the machine now, so only a live, fresh status may answer
 * it; a kept status (an offline machine's) never does. Quota is judged
 * elsewhere, from every status alike.
 */
function machineFilter(machine: Machine, now: number, config: SchedulerConfig): Reason[] {
  const reasons: Reason[] = [];
  const status = liveStatus(machine);
  if (!machine.connected) reasons.push({ code: "offline" });
  else if (status === undefined || isStatusStale(status, now)) reasons.push({ code: "status_stale" });
  else {
    // An absent `free` is a host with no statfs answer — unknown, and the floor guards a known-full disk only.
    if (status.free !== undefined && status.free < config.minFreeMib)
      reasons.push({ code: "disk_low", freeMib: status.free });
    if (status.cpu === undefined && status.mem === undefined) reasons.push({ code: "pressure_unknown" });
  }
  if (machine.capabilities?.includes(CAPABILITIES.taskId) !== true) reasons.push({ code: "task_id_unsupported" });
  // A real daemon always lists `default`, so an empty list is a blob it did not write — as unknown as none.
  if (machine.exclaves === undefined || machine.exclaves.length === 0) reasons.push({ code: "exclaves_unknown" });
  return reasons;
}

function pinFilter(task: Task, machine: Machine, exclave: ExclaveInfo): Reason[] {
  const pin = task.spec.pin;
  const reasons: Reason[] = [];
  if (pin?.deviceId !== undefined && pin.deviceId !== machine.deviceId)
    reasons.push({ code: "pin_mismatch", field: "deviceId" });
  if (pin?.exclave !== undefined && pin.exclave !== exclave.id)
    reasons.push({ code: "pin_mismatch", field: "exclave" });
  return reasons;
}

/**
 * docs/scheduler.md, "Missing quota is unknown, never 0%": scored only on a
 * reading the account actually has. Unknown when nothing carries it, or when a
 * trimmed status from a host of it does not carry it and nothing newer than
 * that status does — the trim may have dropped exactly the reading that said
 * it was full.
 */
function accountQuota(
  accountId: string,
  machines: readonly Machine[],
  newest: ReadonlyMap<string, NewestQuota>,
): AccountQuota {
  const found = newest.get(accountId);
  for (const machine of machines) {
    const status = machine.status;
    if (status === undefined || !isQuotaTrimmed(status)) continue;
    if (!hosts(machine, accountId) || carries(machine, status, accountId)) continue;
    if (found === undefined || found.observation.at < status.at) return { known: false, why: "trimmed" };
  }
  if (found === undefined) return { known: false, why: "unobserved" };
  const windows = windowsOf(found.observation);
  return windows.length === 0 ? { known: false, why: "unobserved" } : { known: true, newest: found, windows };
}

function hosts(machine: Machine, accountId: string): boolean {
  return machine.exclaves?.some((x) => x.accountId === accountId) === true;
}

function carries(machine: Machine, status: MachineStatus, accountId: string): boolean {
  return (status.quota ?? []).some((q) => machine.exclaves?.[q.x]?.accountId === accountId);
}

/** Readers take the max over `d` and the per-model weeklies (`QuotaObservation.w`), so all count. */
function windowsOf(o: QuotaObservation): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  if (o.h !== undefined) windows.push({ label: "5h", pct: o.h, resetsAt: o.hr, lengthMs: FIVE_HOURS_MS });
  if (o.d !== undefined) windows.push({ label: "7d", pct: o.d, resetsAt: o.dr, lengthMs: SEVEN_DAYS_MS });
  for (const w of o.w ?? []) windows.push({ label: `7d ${w.m}`, pct: w.p, resetsAt: w.r, lengthMs: SEVEN_DAYS_MS });
  return windows;
}

/** The worst window whose projected usage crosses the line; one resetting within the grace counts as empty. */
function overLine(
  windows: readonly QuotaWindow[],
  added: number,
  now: number,
  config: SchedulerConfig,
): { readonly window: string; readonly projectedPct: number } | null {
  let worst: { readonly window: string; readonly projectedPct: number } | null = null;
  for (const w of windows) {
    const resetsSoon = w.resetsAt !== undefined && w.resetsAt * 1000 - now <= config.resetGraceMs;
    const projectedPct = (resetsSoon ? 0 : w.pct) + added;
    if (projectedPct > config.quotaLinePct && (worst === null || projectedPct > worst.projectedPct)) {
      worst = { window: w.label, projectedPct };
    }
  }
  return worst;
}

/**
 * max over windows of the convex `(u/(1-u))²` at projected usage, discounted
 * by the share of the window still to run: a nearly-spent 5h window that
 * resets in ten minutes costs little, the same reading on a fresh one a lot.
 */
function pressureOf(windows: readonly QuotaWindow[], added: number, now: number): number {
  let worst = 0;
  for (const w of windows) {
    const u = Math.min((effectivePct(w.pct, w.resetsAt, now) + added) / 100, MAX_UTILISATION);
    const remaining = w.resetsAt === undefined ? 1 : clamp((w.resetsAt * 1000 - now) / w.lengthMs);
    worst = Math.max(worst, (u / (1 - u)) ** 2 * remaining);
  }
  return worst;
}

/** 0 where the base lives, 0.25 on its machine in another exclave, 0.5 elsewhere (it must be pushed). */
function distance(base: Placement | undefined, at: Placement): number {
  if (base === undefined || samePlacement(base, at)) return 0;
  return base.deviceId === at.deviceId ? 0.25 : 0.5;
}

function samePlacement(a: Placement | undefined, b: Placement): boolean {
  return a !== undefined && a.deviceId === b.deviceId && a.exclave === b.exclave;
}

function codeUnitOrder(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function clamp(x: number): number {
  return Math.min(Math.max(x, 0), 1);
}

function cached<T>(fn: (key: string) => T): (key: string) => T {
  const cache = new Map<string, T>();
  return (key) => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const value = fn(key);
    cache.set(key, value);
    return value;
  };
}
