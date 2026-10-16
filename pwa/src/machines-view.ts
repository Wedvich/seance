import {
  CAPABILITIES,
  effectivePct,
  newestQuotaByAccount,
  type ExclaveInfo,
  type Machine,
  type NewestQuota,
  type QuotaObservation,
} from "@seance/shared";
import { formatSeen } from "./view.ts";

/**
 * The machines screen, derived in one pure pass like `deriveView`: pressure and
 * exclaves per machine, and quota per account across the fleet — an account's
 * quota is spread over every machine hosting one of its exclaves, so it is not
 * a property of any one card.
 */

export type Level = "ok" | "warn" | "err";

export interface Gauge {
  readonly label: string;
  /** Whole percent, clamped to 0–100 for the bar. */
  readonly pct: number;
  readonly level: Level;
}

export interface ExclaveRow {
  readonly id: string;
  readonly account: string;
  /** Running sessions from the latest status; null when it doesn't say. */
  readonly sessions: number | null;
}

export interface MachineCard {
  readonly deviceId: string;
  readonly name: string;
  readonly connected: boolean;
  readonly meta: string;
  /**
   * CPU and memory only. Disk is collected and stored but not shown: a fill
   * level is upkeep, not load, and belongs in a health alert (docs/scheduler.md, M4).
   */
  readonly gauges: readonly Gauge[];
  readonly note: string | null;
  readonly exclaves: readonly ExclaveRow[];
  /** Whether a chart can be asked for: connected, and the daemon serves `metrics`. */
  readonly charts: boolean;
}

export interface QuotaBar extends Gauge {
  readonly resets: string | null;
}

export interface AccountCard {
  readonly accountId: string;
  /** The exclave ids that sign in as this account, anywhere in the fleet. */
  readonly title: string;
  readonly detail: string;
  readonly bars: readonly QuotaBar[];
  readonly observed: string;
  /** The machine to read this account's quota history from; null when none online can serve it. */
  readonly historyFrom: string | null;
}

export interface MachinesView {
  readonly cards: readonly MachineCard[];
  readonly accounts: readonly AccountCard[];
}

/** Shared by pressure and quota: both are "how close to the wall". */
export function levelFor(pct: number): Level {
  if (pct >= 90) return "err";
  if (pct >= 75) return "warn";
  return "ok";
}

function gauge(label: string, pct: number): Gauge {
  const clamped = Math.min(100, Math.max(0, pct));
  return { label, pct: clamped, level: levelFor(clamped) };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The forward twin of `formatSeen`, as coarse: a reset is planned around, not timed. */
export function formatUntil(at: number, now: number): string {
  const left = at - now;
  // Floored like `formatSeen`: rounding would print "60m" or "24h" just under each boundary.
  if (left < HOUR) return `resets in ${Math.max(1, Math.floor(left / MINUTE))}m`;
  if (left < DAY) return `resets in ${Math.floor(left / HOUR)}h`;
  return `resets in ${Math.floor(left / DAY)}d`;
}

/**
 * What an account is called on screen: its email, else the account half of
 * `organizationUuid:accountUuid` shortened — enough to tell two apart. M4's
 * alias goes in front of both (docs/scheduler.md, _Account records_).
 */
function accountName(accountId: string, email: string | undefined): string {
  if (email !== undefined) return email;
  const account = accountId.split(":").at(-1) ?? accountId;
  return `acct ${account.slice(0, 8)}`;
}

function accountLabel(exclave: ExclaveInfo): string {
  if (exclave.accountId !== null) return accountName(exclave.accountId, exclave.email);
  return exclave.authOk ? "signed in" : "not signed in";
}

function machineNote(machine: Machine): string | null {
  if (machine.exclaves === undefined) {
    return "This daemon predates exclaves. Update seanced; until then the scheduler can't route to it.";
  }
  if (machine.connected && machine.status === undefined) return "Waiting for its first status.";
  return null;
}

function machineCard(machine: Machine, now: number): MachineCard {
  // Not drawn for an asleep card: the relay can list a socket the app has
  // already seen time out, and its last beat would read as current pressure
  // beside "last seen". Its quota still counts — an observation carries its own stamp.
  const status = machine.connected ? machine.status : undefined;
  const gauges = [
    status?.cpu === undefined ? null : gauge("CPU", status.cpu),
    status?.mem === undefined ? null : gauge("Memory", status.mem),
  ].filter((entry): entry is Gauge => entry !== null);
  const meta = machine.connected
    ? `${machine.platform}${status === undefined ? "" : ` · updated ${formatSeen(status.at * 1000, now)}`}`
    : `asleep · last seen ${formatSeen(machine.lastSeen, now)}`;

  return {
    deviceId: machine.deviceId,
    name: machine.name,
    connected: machine.connected,
    meta,
    gauges,
    note: machineNote(machine),
    exclaves: (machine.exclaves ?? []).map((exclave, index) => ({
      id: exclave.id,
      account: accountLabel(exclave),
      sessions: status?.sess?.[index] ?? null,
    })),
    charts: servesMetrics(machine),
  };
}

interface AccountGroup {
  readonly accountId: string;
  readonly exclaves: Set<string>;
  readonly machines: Set<string>;
  /** Online hosts that serve `metrics`, in fleet order. */
  readonly charted: string[];
  /** The first email any of its exclaves reports; one account has one. */
  email: string | undefined;
}

function servesMetrics(machine: Machine): boolean {
  return machine.connected && machine.capabilities?.includes(CAPABILITIES.metrics) === true;
}

/** The reset floor is `effectivePct`'s; this only says when the window resets, or that it has. */
function quotaBar(label: string, pct: number, resetsAt: number | undefined, now: number): QuotaBar {
  const bar = gauge(label, effectivePct(pct, resetsAt, now));
  if (resetsAt === undefined) return { ...bar, resets: null };
  if (resetsAt * 1000 <= now) return { ...bar, resets: "reset" };
  return { ...bar, resets: formatUntil(resetsAt * 1000, now) };
}

function quotaBars(observation: QuotaObservation, now: number): QuotaBar[] {
  const bars: QuotaBar[] = [];
  if (observation.h !== undefined) bars.push(quotaBar("5h", observation.h, observation.hr, now));
  if (observation.d !== undefined) bars.push(quotaBar("7d", observation.d, observation.dr, now));
  for (const window of observation.w ?? []) bars.push(quotaBar(`7d ${window.m}`, window.p, window.r, now));
  return bars;
}

/**
 * Each daemon stores only what its own exclaves observed, so the host that saw
 * the account last has the freshest history; any other online host beats none.
 */
function historyHost(group: AccountGroup, newest: Machine | undefined): string | null {
  if (newest !== undefined && servesMetrics(newest)) return newest.deviceId;
  return group.charted[0] ?? null;
}

function observedLine(quota: NewestQuota | undefined, observer: Machine | undefined, now: number): string {
  if (quota === undefined || observer === undefined) {
    return "No quota seen yet. It shows once a session has run while its machine is online.";
  }
  return `${quota.observation.s} · ${formatSeen(quota.observation.at * 1000, now)} on ${observer.name}`;
}

/**
 * Grouped by account id across every machine; whose numbers show is
 * `newestQuotaByAccount`'s rule (DESIGN.md, PWA). A machine gone from the relay has no status, so
 * its exclaves still name the account but contribute no numbers. Exclaves that
 * aren't signed in have no account to group under and appear only on their card.
 */
function deriveAccounts(machines: readonly Machine[], now: number): AccountCard[] {
  const groups = new Map<string, AccountGroup>();
  for (const machine of machines) {
    const exclaves = machine.exclaves ?? [];
    for (const exclave of exclaves) {
      if (exclave.accountId === null) continue;
      const group = groups.get(exclave.accountId) ?? {
        accountId: exclave.accountId,
        exclaves: new Set(),
        machines: new Set(),
        charted: [],
        email: undefined,
      };
      group.exclaves.add(exclave.id);
      group.email ??= exclave.email;
      group.machines.add(machine.name);
      if (servesMetrics(machine) && !group.charted.includes(machine.deviceId)) group.charted.push(machine.deviceId);
      groups.set(exclave.accountId, group);
    }
  }

  const newest = newestQuotaByAccount(machines);
  return [...groups.values()].map((group) => {
    const quota = newest.get(group.accountId);
    const observer = machines.find((machine) => machine.deviceId === quota?.deviceId);
    return {
      accountId: group.accountId,
      title: [...group.exclaves].join(" · "),
      detail: `${accountName(group.accountId, group.email)} · on ${[...group.machines].join(", ")}`,
      bars: quota === undefined ? [] : quotaBars(quota.observation, now),
      observed: observedLine(quota, observer, now),
      historyFrom: historyHost(group, observer),
    };
  });
}

export function deriveMachines(machines: readonly Machine[], now: number): MachinesView {
  return {
    cards: machines.map((machine) => machineCard(machine, now)),
    accounts: deriveAccounts(machines, now),
  };
}
