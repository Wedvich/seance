import {
  CAPABILITIES,
  DEFAULT_MODEL,
  effectivePct,
  isQuotaTrimmed,
  isSkillName,
  isStatusStale,
  liveStatus,
  newestQuotaByAccount,
  sameCreditMonth,
  type Candidate,
  type Decision,
  type ExclaveInfo,
  type Machine,
  type MachineStatus,
  type NewestQuota,
  type PauseHold,
  type QuotaBasis,
  type QuotaObservation,
  type Reason,
  type ScoreComponents,
} from "@seance/shared";
import { batchCap } from "./batch.ts";
import type { SchedulerConfig, SeatProfile, WindowSpan } from "./config.ts";
import { codeUnitOrder } from "./order.ts";
import { accountPause, activeHolds, queuePause } from "./pause.ts";
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
  /** What holds dispatch (`queue:pause`); expired ones are ignored here. */
  readonly holds?: readonly PauseHold[];
}

const SPAN_MS: Readonly<Record<WindowSpan, number>> = { "5h": 5 * 3600_000, "7d": 7 * 86_400_000 };
/** The convex cost is unbounded at 100%; this keeps an over-full account finite and still worst. */
const MAX_UTILISATION = 0.99;

interface QuotaWindow {
  readonly label: string;
  readonly pct: number;
  /** Unix seconds. */
  readonly resetsAt: number | undefined;
  readonly span: WindowSpan;
  /** A per-model weekly's display name (`Fable`); absent on the all-models windows. */
  readonly model?: string;
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
  readonly holds: readonly PauseHold[];
  /** The task's skill when the inventory knows it, so it restricts; null when nothing does. */
  readonly skill: string | null;
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
    accountAt: (placement) => accountOfPlacement(machines, placement),
    capReached:
      inFlight.length >= config.globalMax
        ? { code: "cap_reached", inFlight: inFlight.length, max: config.globalMax }
        : null,
    holds: activeHolds(input.holds ?? [], now),
    skill: knownSkill(task, machines),
  };
  const caps = [queuePause(pass.holds), pass.capReached, batchCap(task, input.tasks)].filter((r) => r !== null);

  const candidates: Candidate[] = [];
  for (const machine of machines) {
    const machineReasons = [...machineFilter(machine, now, config), ...caps];
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
  if (pass.skill !== null && !exclave.skills.includes(pass.skill) && clone?.skills?.includes(pass.skill) !== true) {
    rejected.push({ code: "skill_absent", skill: pass.skill });
  }
  if (!exclave.authOk || exclave.accountId === null) rejected.push({ code: "auth_missing" });
  const seat = seatOf(config, exclave.seatTier);
  const gated = gatedModel(task.spec.model ?? DEFAULT_MODEL, config);
  if (gated !== null && !seat.includes.includes(gated)) rejected.push({ code: "model_not_included", model: gated });
  const sharing = exclave.accountId === null ? 0 : accountInFlight(pass, exclave.accountId);
  const account =
    exclave.accountId === null ? null : judgeAccount(pass, exclave, exclave.accountId, sharing, seat.capacity);
  if (account?.reason !== undefined) rejected.push(account.reason);
  if (sharing >= config.accountMax) {
    rejected.push({ code: "cap_reached", inFlight: sharing, max: config.accountMax, scope: "account" });
  }
  const paused = exclave.accountId === null ? null : accountPause(pass.holds, exclave.accountId);
  if (paused !== null) rejected.push(paused);

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

/**
 * In-flight tasks billed to `accountId`, by where each is placed: what the
 * account cap and projected usage both count. A task whose machine has left
 * the registry has no account to read, so it counts toward neither.
 */
function accountInFlight(pass: Pick<Pass, "inFlight" | "accountAt">, accountId: string): number {
  return pass.inFlight.filter((t) => {
    const at = t.assignment ?? t.reservation;
    return at !== undefined && pass.accountAt(at) === accountId;
  }).length;
}

function accountOfPlacement(machines: readonly Machine[], placement: Placement): string | null {
  return (
    machines.find((m) => m.deviceId === placement.deviceId)?.exclaves?.find((x) => x.id === placement.exclave)
      ?.accountId ?? null
  );
}

/**
 * Projected usage counts this task and every in-flight one on the same account
 * (`sharing`), each at the estimate scaled to the seat's `capacity`.
 */
function judgeAccount(
  pass: Pass,
  exclave: ExclaveInfo,
  accountId: string,
  sharing: number,
  capacity: number,
): AccountJudgement {
  const account = pass.quotaOf(accountId);
  if (!account.known) return { reason: { code: "quota_unknown", why: account.why }, pressure: 0 };
  const windows = account.windows.filter((w) => appliesTo(w, pass.task.spec.model ?? DEFAULT_MODEL));
  // Only another model's weekly was read: nothing says how full this task's windows are.
  if (windows.length === 0) return { reason: { code: "quota_unknown", why: "unobserved" }, pressure: 0 };
  const { observation, deviceId } = account.newest;
  const quota = { observedAt: observation.at, observer: deviceId, source: observation.s };
  const added = estimate(pass.config, capacity, sharing + 1);
  const pressure = pressureOf(windows, added, pass.now);
  const over = overLine(windows, added, pass.now, pass.config);
  if (over === null) return { quota, pressure };
  // Spent credits can't take the spill. Unknown credits (a daemon that predates `c`) still may: refusing them would
  // stop every spill until the fleet upgrades.
  const spent = creditsSpent(observation, pass.now);
  if (exclave.extraUsageEnabled === true && !spent) return { quota, spill: over, pressure };
  return {
    reason: { code: "quota_over_line", ...over, ...(exclave.extraUsageEnabled === true ? { creditsSpent: true } : {}) },
    quota,
    pressure,
  };
}

/**
 * From the amounts when they came: `c` rounds for the card, so $49.80 of $50
 * reads 100 there while credits remain. Only a daemon that predates the
 * amounts leaves the percent to decide. Last month's spend is unknown, not spent.
 */
function creditsSpent({ c, cu, cl, at }: QuotaObservation, nowMs: number): boolean {
  if (!sameCreditMonth(at, nowMs / 1000)) return false;
  if (cu !== undefined && cl !== undefined) return cu >= cl;
  return (c ?? 0) >= 100;
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

/**
 * The skill a task needs (DESIGN.md, Scheduler, "Skills filter"): declared, else
 * the prompt's leading `/name` — Claude Code invokes a slash command only as
 * the prompt's first token, so one later in the text is a mention.
 */
function taskSkill(task: Task): string | undefined {
  if (task.spec.skill !== undefined) return task.spec.skill;
  const token = /^\/(\S+)/u.exec(task.spec.prompt ?? "")?.[1];
  return isSkillName(token) ? token : undefined;
}

/**
 * Only a name the inventory knows restricts; an unknown one (a built-in, a
 * plugin's, a typo) passes. The inventory is every exclave's skills, offline
 * machines included as the autocomplete counts them, plus the project skills
 * of this task's repo only: one in another repo cannot be what `/name` means
 * here, and counting it would hold back a same-named command.
 */
function knownSkill(task: Task, machines: readonly Machine[]): string | null {
  const skill = taskSkill(task);
  if (skill === undefined) return null;
  const known = machines.some(
    (m) =>
      m.exclaves?.some((x) => x.skills.includes(skill)) === true ||
      m.repos.some((r) => r.origin === task.spec.repo && r.skills?.includes(skill) === true),
  );
  return known ? skill : null;
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

/**
 * When `accountId`'s quota next frees it, ms, by its newest reading: what a
 * `pause { until: "reset" }` lifts at. All-models windows only: a full
 * per-model weekly holds back that model's tasks, which routing still filters
 * once the pause lifts, not the account. Over the line in any window (one more
 * task's estimate on top of every in-flight one, judged as routing does —
 * `overLine`), the latest reset among those, since
 * an earlier one would lift the hold into a window still full; otherwise the
 * earliest reset still ahead. Null when no reading says — the account unknown
 * (`quota_unknown`'s rules), a deciding window with no reset, or every reset
 * already past, whose next one would be a guess.
 */
export function accountResetAt(
  accountId: string,
  machines: readonly Machine[],
  tasks: readonly Task[],
  now: number,
  config: SchedulerConfig,
): number | null {
  const account = accountQuota(accountId, machines, newestQuotaByAccount(machines));
  if (!account.known) return null;
  const resetMs = (w: QuotaWindow): number[] =>
    w.resetsAt !== undefined && w.resetsAt * 1000 > now ? [w.resetsAt * 1000] : [];
  const sharing = accountInFlight(
    {
      inFlight: tasks.filter((t) => IN_FLIGHT.includes(t.state)),
      accountAt: (placement) => accountOfPlacement(machines, placement),
    },
    accountId,
  );
  const { capacity } = seatOf(config, seatTierOf(machines, accountId));
  const windows = account.windows.filter((w) => w.model === undefined);
  const added = estimate(config, capacity, sharing + 1);
  const over = windows.filter((w) => overLine([w], added, now, config) !== null);
  if (over.length > 0) {
    const resets = over.flatMap(resetMs);
    return resets.length === over.length ? Math.max(...resets) : null;
  }
  const resets = windows.flatMap(resetMs);
  return resets.length === 0 ? null : Math.min(...resets);
}

/** The reset of one window (a `Candidate.spill` label) on `accountId`'s newest reading, unix seconds. */
export function windowResetOf(accountId: string, machines: readonly Machine[], window: string): number | undefined {
  const account = accountQuota(accountId, machines, newestQuotaByAccount(machines));
  return account.known ? account.windows.find((w) => w.label === window)?.resetsAt : undefined;
}

/** `seatTier` is daemon-reported, so only the table's own keys answer — never one off its prototype. */
function seatOf(config: SchedulerConfig, tier: string | undefined): SeatProfile {
  return (
    (tier !== undefined && Object.hasOwn(config.seats, tier) ? config.seats[tier] : undefined) ?? config.unknownSeat
  );
}

/** The tier any exclave signed into `accountId` reports: one account, one seat. */
function seatTierOf(machines: readonly Machine[], accountId: string): string | undefined {
  for (const machine of machines) {
    const tier = machine.exclaves?.find((x) => x.accountId === accountId && x.seatTier !== undefined)?.seatTier;
    if (tier !== undefined) return tier;
  }
  return undefined;
}

/**
 * All-models windows bind every task; a per-model weekly only a task on that
 * model — a full Fable week leaves Opus work free. Matched on the display
 * name's first word (`Fable` in `claude-fable-5-1[1m]`), since the cache
 * holds no model id.
 */
function appliesTo(window: QuotaWindow, model: string): boolean {
  if (window.model === undefined) return true;
  const family = window.model.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  return family !== "" && model.toLowerCase().includes(family);
}

/** The `gatedModels` family `model` names (an alias like `fable`, or an id like `claude-fable-5-1[1m]`), else null. */
function gatedModel(model: string, config: SchedulerConfig): string | null {
  const lower = model.toLowerCase();
  return config.gatedModels.find((family) => lower.includes(family)) ?? null;
}

function hosts(machine: Machine, accountId: string): boolean {
  return machine.exclaves?.some((x) => x.accountId === accountId) === true;
}

function carries(machine: Machine, status: MachineStatus, accountId: string): boolean {
  return (status.quota ?? []).some((q) => machine.exclaves?.[q.x]?.accountId === accountId);
}

/** Every window the reading has; which of them a task is judged on is `appliesTo`'s. */
function windowsOf(o: QuotaObservation): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  if (o.h !== undefined) windows.push({ label: "5h", pct: o.h, resetsAt: o.hr, span: "5h" });
  if (o.d !== undefined) windows.push({ label: "7d", pct: o.d, resetsAt: o.dr, span: "7d" });
  for (const w of o.w ?? []) windows.push({ label: `7d ${w.m}`, pct: w.p, resetsAt: w.r, span: "7d", model: w.m });
  return windows;
}

/** Percent `tasks` add to a window on a seat of `capacity`: the span's estimate, scaled to the seat. */
function estimate(config: SchedulerConfig, capacity: number, tasks: number): (w: QuotaWindow) => number {
  return (w) => (config.taskEstimatePct[w.span] / capacity) * tasks;
}

/** The worst window whose projected usage crosses the line; one resetting within the grace counts as empty. */
function overLine(
  windows: readonly QuotaWindow[],
  added: (w: QuotaWindow) => number,
  now: number,
  config: SchedulerConfig,
): { readonly window: string; readonly projectedPct: number } | null {
  let worst: { readonly window: string; readonly projectedPct: number } | null = null;
  for (const w of windows) {
    const resetsSoon = w.resetsAt !== undefined && w.resetsAt * 1000 - now <= config.resetGraceMs;
    const projectedPct = (resetsSoon ? 0 : w.pct) + added(w);
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
function pressureOf(windows: readonly QuotaWindow[], added: (w: QuotaWindow) => number, now: number): number {
  let worst = 0;
  for (const w of windows) {
    const u = Math.min((effectivePct(w.pct, w.resetsAt, now) + added(w)) / 100, MAX_UTILISATION);
    const remaining = w.resetsAt === undefined ? 1 : clamp((w.resetsAt * 1000 - now) / SPAN_MS[w.span]);
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
