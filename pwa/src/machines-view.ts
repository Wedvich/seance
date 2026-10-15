import { METRICS_CAPABILITY, type ExclaveInfo, type Machine, type QuotaObservation } from "@seance/shared";
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
  if (left <= 0) return "resets now";
  if (left < HOUR) return `resets in ${Math.max(1, Math.round(left / MINUTE))}m`;
  if (left < DAY) return `resets in ${Math.round(left / HOUR)}h`;
  return `resets in ${Math.round(left / DAY)}d`;
}

/** The account half of `organizationUuid:accountUuid`, shortened: enough to tell two apart. */
function shortAccount(accountId: string): string {
  const account = accountId.split(":").at(-1) ?? accountId;
  return `acct ${account.slice(0, 8)}`;
}

function accountLabel(exclave: ExclaveInfo): string {
  if (exclave.accountId !== null) return shortAccount(exclave.accountId);
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
  const { status } = machine;
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

interface Observed {
  readonly observation: QuotaObservation;
  readonly machine: Machine;
}

interface AccountGroup {
  readonly accountId: string;
  readonly exclaves: Set<string>;
  readonly machines: Set<string>;
  /** Online hosts that serve `metrics`, in fleet order. */
  readonly charted: string[];
  newest: Observed | null;
}

function servesMetrics(machine: Machine): boolean {
  return machine.connected && machine.capabilities?.includes(METRICS_CAPABILITY) === true;
}

function quotaBars(observation: QuotaObservation, now: number): QuotaBar[] {
  const resets = (at: number | undefined): string | null => (at === undefined ? null : formatUntil(at * 1000, now));
  const bars: QuotaBar[] = [];
  if (observation.h !== undefined) bars.push({ ...gauge("5h", observation.h), resets: resets(observation.hr) });
  if (observation.d !== undefined) bars.push({ ...gauge("7d", observation.d), resets: resets(observation.dr) });
  for (const window of observation.w ?? []) {
    bars.push({ ...gauge(`7d ${window.m}`, window.p), resets: resets(window.r) });
  }
  return bars;
}

/**
 * Each daemon stores only what its own exclaves observed, so the host that saw
 * the account last has the freshest history; any other online host beats none.
 */
function historyHost(group: AccountGroup): string | null {
  const newest = group.newest?.machine;
  if (newest !== undefined && servesMetrics(newest)) return newest.deviceId;
  return group.charted[0] ?? null;
}

/**
 * Grouped by account id across every machine, newest observation wins — the
 * reader's rule from docs/scheduler.md. An asleep machine has no status, so its
 * exclaves still name the account but contribute no numbers. Exclaves that
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
        newest: null,
      };
      group.exclaves.add(exclave.id);
      group.machines.add(machine.name);
      if (servesMetrics(machine) && !group.charted.includes(machine.deviceId)) group.charted.push(machine.deviceId);
      groups.set(exclave.accountId, group);
    }
    for (const observation of machine.status?.quota ?? []) {
      const accountId = exclaves[observation.x]?.accountId;
      const group = accountId === undefined || accountId === null ? undefined : groups.get(accountId);
      if (group === undefined) continue;
      if (group.newest === null || observation.at > group.newest.observation.at) {
        group.newest = { observation, machine };
      }
    }
  }

  return [...groups.values()].map((group) => ({
    accountId: group.accountId,
    title: [...group.exclaves].join(" · "),
    detail: `${shortAccount(group.accountId)} · on ${[...group.machines].join(", ")}`,
    bars: group.newest === null ? [] : quotaBars(group.newest.observation, now),
    observed:
      group.newest === null
        ? "No quota seen yet. It shows once a session has run while its machine is online."
        : `${group.newest.observation.s} · ${formatSeen(group.newest.observation.at * 1000, now)} on ${group.newest.machine.name}`,
    historyFrom: historyHost(group),
  }));
}

export function deriveMachines(machines: readonly Machine[], now: number): MachinesView {
  return {
    cards: machines.map((machine) => machineCard(machine, now)),
    accounts: deriveAccounts(machines, now),
  };
}
