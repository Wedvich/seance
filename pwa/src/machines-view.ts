import {
  accountNameIn,
  CAPABILITIES,
  closedAt,
  drainStuckText,
  drainSummary,
  drainView,
  knownAccounts,
  type KnownAccount,
  effectivePct,
  exclaveAuth,
  exclaveTraitHealth,
  lastHeardAt,
  liveStatus,
  METRIC_NAMES,
  MIN_FREE_MIB,
  newestQuotaByAccount,
  sameCreditMonth,
  schedulerRole,
  type ArchiveStatusResponse,
  type DrainStuck,
  type SessionEntry,
  type ArchiveTableStatus,
  type ArchivistEntry,
  type ExclaveInfo,
  type FleetQuotaEntry,
  type Machine,
  type NewestQuota,
  type QuotaReading,
  type SchedulerAvailability,
  type SchedulerRole,
  type SourceInfo,
  type Task,
  type UpdateOutcome,
} from "@seance/shared";
import { METRIC_LABELS } from "./chart.ts";
import { taskTitle } from "./task-title.ts";
import { historyRanges, type ArchiveReach, type HistoryRange, type HistoryTarget } from "./state.ts";
import { canDrainNow, formatSeen } from "./view.ts";

/**
 * The machines screen, derived in one pure pass like `deriveView`: pressure and
 * exclaves per machine, and quota per account across the fleet — an account's
 * quota is spread over every machine hosting one of its exclaves, so it is not
 * a property of any one card.
 */

export type Level = "ok" | "warn" | "err";

/** Which pressure gauge a row is; ornament only, so a quota bar has none. */
export type GaugeIcon = "cpu" | "mem" | "disk";

export interface Gauge {
  readonly label: string;
  readonly icon?: GaugeIcon;
  /** Whole percent, clamped to 0–100 for the bar. */
  readonly pct: number;
  readonly level: Level;
}

export interface ExclaveRow {
  readonly id: string;
  readonly account: string;
  /** Running sessions from the latest status; null when it doesn't say. */
  readonly sessions: number | null;
  /** A login that needs attention: lapsed (err) or expiring within `AUTH_EXPIRING_MS` (warn). Null for ok and for unknown: unread says nothing. */
  readonly auth: { readonly text: string; readonly level: "err" | "warn" } | null;
  /** The traits whose probe reads failing here (`exclaveTraitHealth`); unchecked says nothing, as unread auth does. */
  readonly probes: { readonly text: string; readonly level: "err" } | null;
}

export interface MachineCard {
  readonly deviceId: string;
  readonly name: string;
  readonly connected: boolean;
  readonly meta: string;
  /** Null for every machine but the relay's nominee. */
  readonly role: SchedulerRole | null;
  /** The build its daemon runs — short sha, commit age, branch; null from a daemon that doesn't say. */
  readonly build: string | null;
  /** Set only when its last reported update attempt was a skip or a failure; carries its age, since the next check may not have run yet. */
  readonly updateNote: string | null;
  /** CPU, memory, and disk fill (percent used on the fullest watched path; red under the scheduler's floor). */
  readonly gauges: readonly Gauge[];
  readonly note: string | null;
  readonly exclaves: readonly ExclaveRow[];
  /** Whether a chart can be asked for: connected and the daemon serves `metrics`, or asleep while the archive charts machines. */
  readonly charts: boolean;
  /** Its newest status carries `cl`: closed to new scheduled work. */
  readonly closed: boolean;
  /**
   * The "Open for work" switch: null where the machine cannot be opened or closed (no `close`), `off` while
   * closed (always offered, so a close can be undone), `on` while open only if the verified leader routes
   * around a closed machine (`drain`), since an older one would fail the tasks it sends there.
   */
  readonly openSwitch: "on" | "off" | null;
  /** A closed machine's drain under a `drainPass` leader: null otherwise, and while the queue is unread. */
  readonly drain: DrainRow | null;
}

export interface DrainRow {
  /** `drainSummary`: "moving 2 · 1 stuck", "empty". */
  readonly summary: string;
  /** One line per session the drain cannot move. */
  readonly stuck: readonly string[];
}

/** What the drain rows are computed from; absent (the default) draws none. */
export interface DrainInputs {
  /** The verified leader advertises `drainPass`. */
  readonly passes: boolean;
  /** The queue read's tasks; null while unread. */
  readonly tasks: readonly Task[] | null;
  /** Per machine, its `sessions` read; "unknown" when it did not answer. */
  readonly sessions: Readonly<Record<string, { readonly sessions: readonly SessionEntry[] } | "unknown">>;
}

const NO_DRAINS: DrainInputs = { passes: false, tasks: null, sessions: {} };

function sessionsOf(inputs: DrainInputs, deviceId: string): readonly SessionEntry[] | null {
  const read = inputs.sessions[deviceId];
  return read === undefined || read === "unknown" ? null : read.sessions;
}

function stuckLine(tasks: readonly Task[], stuck: DrainStuck): string {
  const task = stuck.taskId === undefined ? undefined : tasks.find((t) => t.id === stuck.taskId);
  const text = drainStuckText(stuck);
  return task === undefined ? text : `${taskTitle(task)}: ${text}`;
}

function drainRow(machine: Machine, inputs: DrainInputs): DrainRow | null {
  if (!inputs.passes || inputs.tasks === null || closedAt(machine) === null) return null;
  const view = drainView(machine, inputs.tasks, sessionsOf(inputs, machine.deviceId));
  // Not yet read is not unreadable: say so until the first answer.
  const reading =
    inputs.sessions[machine.deviceId] === undefined &&
    view.empty === null &&
    view.moving.length === 0 &&
    view.stuck.length === 0;
  return {
    summary: reading ? "reading sessions" : drainSummary(view),
    stuck: view.stuck.map((entry) => stuckLine(inputs.tasks ?? [], entry)),
  };
}

const ASK_LINE = "Its sessions are asked to pass themselves at their next pause (interrupted after 5 minutes).";

/**
 * The close sheet's words: what happens to the running work. Without a `drainPass` leader, item 1's
 * line; with one, the tasks that will be passed and the sessions that cannot be.
 */
export function deriveCloseSheet(machine: Machine, inputs: DrainInputs = NO_DRAINS): readonly string[] {
  const first = `Closing ${machine.name} stops new work landing on it.`;
  const asks = canDrainNow(machine);
  // The drain's reads (queue, sessions) are taken only under a `drainPass` leader, so no counts without one.
  if (!inputs.passes) return [first, asks ? ASK_LINE : "Running work finishes where it is."];
  if (inputs.tasks === null) {
    return [
      first,
      asks
        ? `${ASK_LINE.slice(0, -1)}; any left are passed to other machines 10 minutes after, unless you reopen it.`
        : "Its running tasks are passed to other machines 10 minutes after, unless you reopen it.",
    ];
  }
  const sessions = sessionsOf(inputs, machine.deviceId);
  const view = drainView(machine, inputs.tasks, sessions, null);
  const lines = [first];
  const n = view.moving.length;
  if (n > 0 && asks) {
    lines.push(
      `${n === 1 ? "1 running task" : `${n} running tasks`} will be asked to pass ${n === 1 ? "itself" : "themselves"} at ${n === 1 ? "its" : "their"} next pause (interrupted after 5 minutes); any left are passed to other machines in 10 minutes unless you reopen it.`,
    );
    // A question is dismissed by the interrupt; a permission wait is interrupted at the deadline like a busy turn.
    const waiting = view.moving.filter(
      (m) => m.waitingOnYou && inputs.tasks?.find((t) => t.id === m.taskId)?.inputReason === "question",
    ).length;
    if (waiting > 0) {
      lines.push(
        waiting === 1
          ? "1 waiting on you will have its question dismissed."
          : `${waiting} waiting on you will have their questions dismissed.`,
      );
    }
  } else if (n > 0) {
    lines.push(
      `${n === 1 ? "1 running task" : `${n} running tasks`} will be passed to other machines in 10 minutes unless you reopen it.`,
    );
  } else if (sessions !== null) {
    lines.push("No running task to pass on.");
  } else if (inputs.sessions[machine.deviceId] === undefined) {
    lines.push("Reading what runs there…");
  }
  if (sessions === null && inputs.sessions[machine.deviceId] === "unknown")
    lines.push("Its sessions could not be read.");
  for (const entry of view.stuck) lines.push(stuckLine(inputs.tasks, entry));
  return lines;
}

export interface QuotaBar extends Gauge {
  /** Trailing text: when a window resets, or credits spent of their cap ("$42 of $50"). */
  readonly note: string | null;
}

/** accountId to alias, as `AccountsState.aliases` holds it. */
export type AccountAliases = Readonly<Record<string, string>>;

function aliasOf(aliases: AccountAliases, accountId: string): string | undefined {
  return Object.hasOwn(aliases, accountId) ? aliases[accountId] : undefined;
}

export interface AccountCard {
  readonly accountId: string;
  /** The name set for this account from any client, if one is; it becomes `title`. */
  readonly alias: string | null;
  /** The alias, else `exclaves`. */
  readonly title: string;
  /** The exclave ids that sign in as this account, anywhere in the fleet. */
  readonly exclaves: string;
  /** What it reads as without its alias: email, else short id, with any twin tag. */
  readonly plainName: string;
  /** Named, `exclaves` leads it, since the title no longer says them. */
  readonly detail: string;
  readonly bars: readonly QuotaBar[];
  readonly observed: string;
  /** The machine to read this account's quota history from without the archive; null when none online can serve it. */
  readonly historyFrom: string | null;
  /** Whether a chart can be asked for: from `historyFrom`, or merged from the archive while it charts accounts. */
  readonly charts: boolean;
}

export interface MachinesView {
  /** Header-meta fragment: who leads the scheduler, or that nobody does. */
  readonly scheduler: string;
  readonly cards: readonly MachineCard[];
  readonly accounts: readonly AccountCard[];
  /** The range picker's options per chart kind (`historyRanges`). */
  readonly ranges: Readonly<Record<HistoryTarget["kind"], readonly HistoryRange[]>>;
}

/** Nothing by default, as with no archivist. */
const NO_ARCHIVE: ArchiveReach = { machine: false, account: false };

/** Shared by pressure, disk fill and quota: all are "how close to the wall". */
export function levelFor(pct: number): Level {
  if (pct >= 90) return "err";
  if (pct >= 75) return "warn";
  return "ok";
}

function gauge(label: string, pct: number, icon?: GaugeIcon): Gauge {
  const clamped = Math.min(100, Math.max(0, pct));
  const base = { label, pct: clamped, level: levelFor(clamped) };
  return icon === undefined ? base : { ...base, icon };
}

/**
 * Fill level, but red under the scheduler's floor whatever the percent: a small
 * LXC root at 80% can already be out of routing, and the card must not say amber.
 */
function diskGauge(pct: number, freeMib: number | undefined): Gauge {
  const fill = gauge(METRIC_LABELS[METRIC_NAMES.disk], pct, "disk");
  return freeMib !== undefined && freeMib < MIN_FREE_MIB ? { ...fill, level: "err" } : fill;
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
 * One exclave's login line (`exclaveAuth` is the one rule). Whole days from a day out, else whole hours,
 * floored like `formatUntil` and never under 1h: "expires in 0h" would read as lapsed.
 */
function authNote(machine: Machine, index: number, now: number): ExclaveRow["auth"] {
  const auth = exclaveAuth(machine, index, now);
  if (auth.state === "expired") return { text: "needs /login", level: "err" };
  if (auth.state !== "expiring") return null;
  const left = auth.expiresAt - now;
  const text = left >= DAY ? `${Math.floor(left / DAY)}d` : `${Math.max(1, Math.floor(left / HOUR))}h`;
  return { text: `login expires in ${text}`, level: "warn" };
}

/** The exclave's failing probes, by trait: "atlas probe failing", "atlas, az probes failing". */
function probeNote(machine: Machine, exclave: ExclaveInfo, index: number, now: number): ExclaveRow["probes"] {
  const failing = (exclave.traits ?? []).filter(
    (trait) => exclaveTraitHealth(machine, index, trait, now) === "failing",
  );
  if (failing.length === 0) return null;
  return { text: `${failing.join(", ")} ${failing.length === 1 ? "probe" : "probes"} failing`, level: "err" };
}

/** An account as the cards name it, for a screen that holds only its id (a pause's hold). */
export function accountDisplayName(
  known: readonly KnownAccount[],
  accountId: string,
  aliases: AccountAliases = {},
): string {
  return accountNameIn(known, accountId, aliasOf(aliases, accountId));
}

// Through `known`, not the row's own email: one account reports an email on one machine and none on
// another, and has one label everywhere.
function accountLabel(exclave: ExclaveInfo, aliases: AccountAliases, known: readonly KnownAccount[]): string {
  if (exclave.accountId !== null) {
    return accountNameIn(known, exclave.accountId, aliasOf(aliases, exclave.accountId));
  }
  return exclave.authOk ? "signed in" : "not signed in";
}

function machineNote(machine: Machine): string | null {
  if (machine.exclaves === undefined) {
    return "This daemon predates exclaves. Update seanced; until then the scheduler can't route to it.";
  }
  if (machine.connected && machine.status === undefined) return "Waiting for its first status.";
  return null;
}

/** Null for the outcomes that leave the machine on the build it meant to run. */
const UPDATE_TROUBLE: Record<UpdateOutcome, string | null> = {
  ok: null,
  current: null,
  skipped_dirty: "skipped, working tree had uncommitted changes",
  skipped_branch: "skipped, checkout was off its default branch",
  skipped_diverged: "skipped, checkout had diverged from its upstream",
  fetch_failed: "failed, could not fetch",
  install_failed: "failed, installing dependencies failed",
  restart_failed: "failed, updated on disk but the restart failed",
};

function updateNote(machine: Machine, now: number): string | null {
  const report = machine.lastUpdate;
  if (report === undefined) return null;
  const trouble = UPDATE_TROUBLE[report.outcome];
  return trouble === null ? null : `Last update attempt ${formatSeen(report.at, now)}: ${trouble}.`;
}

function buildLine(source: SourceInfo | undefined, now: number): string | null {
  if (source === undefined) return null;
  const where = source.branch ?? "detached";
  return `${source.sha.slice(0, 12)} · committed ${formatSeen(source.commitTs, now)} · ${where}`;
}

/**
 * Named by the registry where the nominee is in it. An unverified one may not
 * be — its entry did not open — and then only its id says which seed it is.
 */
function schedulerLine(machines: readonly Machine[], scheduler: SchedulerAvailability): string {
  if (scheduler.kind === "none") return "no scheduler";
  const name = machines.find((machine) => machine.deviceId === scheduler.deviceId)?.name;
  if (scheduler.kind === "unverified") {
    const who = name ?? `device ${scheduler.deviceId.slice(0, 8)}`;
    return `scheduler ${who} unverified`;
  }
  return `scheduler on ${name ?? scheduler.deviceId.slice(0, 8)} · term ${scheduler.term}`;
}

/** The verified leader advertises `drain` over an open relay: the gate `deriveCloseAvailability` applies, over the registry alone. */
function leaderDrains(machines: readonly Machine[], scheduler: SchedulerAvailability, relayOpen: boolean): boolean {
  if (!relayOpen || scheduler.kind !== "ready") return false;
  return machines.find((m) => m.deviceId === scheduler.deviceId)?.capabilities?.includes(CAPABILITIES.drain) === true;
}

function machineCard(
  machine: Machine,
  now: number,
  scheduler: SchedulerAvailability,
  aliases: AccountAliases,
  known: readonly KnownAccount[],
  archived: boolean,
  canDrain: boolean,
  drains: DrainInputs,
): MachineCard {
  const closed = closedAt(machine) !== null;
  const canClose = machine.capabilities?.includes(CAPABILITIES.close) === true;
  // Not drawn for an asleep card: its status is the one the relay kept, and its
  // last beat would read as current pressure beside "last seen". Its quota
  // still counts — an observation carries its own stamp.
  const status = liveStatus(machine);
  const gauges = [
    status?.cpu === undefined ? null : gauge(METRIC_LABELS[METRIC_NAMES.cpu], status.cpu, "cpu"),
    status?.mem === undefined ? null : gauge(METRIC_LABELS[METRIC_NAMES.mem], status.mem, "mem"),
    status?.disk === undefined ? null : diskGauge(status.disk, status.free),
  ].filter((entry): entry is Gauge => entry !== null);
  const meta = machine.connected
    ? `${machine.platform}${status === undefined ? "" : ` · updated ${formatSeen(status.at * 1000, now)}`}`
    : `asleep · last seen ${formatSeen(lastHeardAt(machine), now)}`;

  return {
    deviceId: machine.deviceId,
    name: machine.name,
    connected: machine.connected,
    meta,
    role: schedulerRole(machine.deviceId, scheduler),
    build: buildLine(machine.source, now),
    updateNote: updateNote(machine, now),
    gauges,
    note: machineNote(machine),
    exclaves: (machine.exclaves ?? []).map((exclave, index) => ({
      id: exclave.id,
      account: accountLabel(exclave, aliases, known),
      sessions: status?.sess?.[index] ?? null,
      auth: authNote(machine, index, now),
      probes: probeNote(machine, exclave, index, now),
    })),
    // An asleep machine's history is the archive's alone (A36f); a connected one's daemon keeps the short ranges.
    charts: servesMetrics(machine) || (archived && !machine.connected),
    closed,
    openSwitch: !canClose ? null : closed ? "off" : canDrain ? "on" : null,
    drain: drainRow(machine, drains),
  };
}

interface AccountGroup {
  readonly accountId: string;
  readonly exclaves: Set<string>;
  readonly machines: Set<string>;
  /** Online hosts that serve `metrics`, in fleet order. */
  readonly charted: string[];
}

function servesMetrics(machine: Machine): boolean {
  return machine.connected && machine.capabilities?.includes(CAPABILITIES.metrics) === true;
}

/** The reset floor is `effectivePct`'s; this only says when the window resets, or that it has. */
function quotaBar(label: string, pct: number, resetsAt: number | undefined, now: number): QuotaBar {
  const bar = gauge(label, effectivePct(pct, resetsAt, now));
  if (resetsAt === undefined) return { ...bar, note: null };
  if (resetsAt * 1000 <= now) return { ...bar, note: "reset" };
  return { ...bar, note: formatUntil(resetsAt * 1000, now) };
}

/**
 * Credits show only while a window is full: that is when use spills into them,
 * and until then they are a monthly figure nothing on the card is spending.
 * Last month's figure says nothing about this one's, so it shows no bar.
 */
function quotaBars(observation: QuotaReading, now: number): QuotaBar[] {
  const bars: QuotaBar[] = [];
  if (observation.h !== undefined) bars.push(quotaBar("5h", observation.h, observation.hr, now));
  if (observation.d !== undefined) bars.push(quotaBar("7d", observation.d, observation.dr, now));
  for (const window of observation.w ?? []) bars.push(quotaBar(`7d ${window.m}`, window.p, window.r, now));
  if (observation.c === undefined || !sameCreditMonth(observation.at, now / 1000)) return bars;
  if (!bars.some((bar) => bar.pct >= 100)) return bars;
  return [...bars, creditsBar(observation)];
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/**
 * A percent like every other row, with "$42 of $50" where a reset goes: the
 * fraction is what the row answers, and whole units keep the note inside the
 * column's floor, so a card spilling into credits keeps its track length.
 * Without amounts (a daemon that predates them) the note is empty.
 * The daemon sends cents.
 */
function creditsBar({ c, cu, cl }: QuotaReading): QuotaBar {
  const base = gauge("Credits", c ?? 0);
  // Credits are only on screen while a window is full, so spending them is never "fine": no green band.
  const bar = base.level === "ok" ? { ...base, level: "warn" as const } : base;
  if (cu === undefined || cl === undefined) return { ...bar, note: null };
  return { ...bar, note: `${money.format(cu / 100)} of ${money.format(cl / 100)}` };
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
  if (quota === undefined) {
    return "No quota seen yet. It shows once a session has run and its machine has reported.";
  }
  // Only the fleet quota record outlives its observer's registry entry.
  if (observer === undefined) {
    return `${quota.observation.s} · ${formatSeen(quota.observation.at * 1000, now)} on a machine no longer listed`;
  }
  const where = observer.connected ? observer.name : `${observer.name}, asleep`;
  return `${quota.observation.s} · ${formatSeen(quota.observation.at * 1000, now)} on ${where}`;
}

/**
 * Grouped by account id across every machine; whose numbers show is
 * `newestQuotaByAccount`'s rule (DESIGN.md, PWA), over the statuses and the fleet quota
 * record. An asleep machine's kept status counts like a live one, its age on the observed
 * line; a machine with no status at all names the account but contributes no numbers, unless
 * the record holds a reading for it. Exclaves that
 * aren't signed in have no account to group under and appear only on their card.
 */
function deriveAccounts(
  machines: readonly Machine[],
  now: number,
  aliases: AccountAliases,
  fleetQuota: readonly FleetQuotaEntry[],
  known: readonly KnownAccount[],
  archived: boolean,
): AccountCard[] {
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
      };
      group.exclaves.add(exclave.id);
      group.machines.add(machine.name);
      if (servesMetrics(machine) && !group.charted.includes(machine.deviceId)) group.charted.push(machine.deviceId);
      groups.set(exclave.accountId, group);
    }
  }

  const newest = newestQuotaByAccount(machines, fleetQuota);
  // Titles tell the cards, and their ⋯ labels, apart: a repeated one gains the exclave ids, then the
  // machines, and finally the account id, which no other account shares.
  const tiers = (group: AccountGroup): string[] => {
    const alias = aliasOf(aliases, group.accountId);
    const exclaves = [...group.exclaves].join(" · ");
    const base = alias ?? exclaves;
    const withExclaves = alias === undefined ? exclaves : `${alias} (${exclaves})`;
    const onMachines = `${exclaves} on ${[...group.machines].join(", ")}`;
    const withMachines = alias === undefined ? onMachines : `${alias} (${onMachines})`;
    return [base, withExclaves, withMachines, `${base} (${group.accountId})`];
  };
  const candidates = new Map([...groups.values()].map((group) => [group.accountId, tiers(group)]));
  const taken = (tier: number, title: string): number =>
    [...candidates.values()].filter((titles) => titles[tier] === title).length;
  const titleOf = (accountId: string): string => {
    const titles = candidates.get(accountId) ?? [];
    const tier = titles.findIndex((title, at) => taken(at, title) === 1);
    return titles[tier === -1 ? titles.length - 1 : tier] ?? "";
  };
  return [...groups.values()].map((group) => {
    const quota = newest.get(group.accountId);
    const observer = machines.find((machine) => machine.deviceId === quota?.deviceId);
    const alias = aliasOf(aliases, group.accountId);
    const exclaves = [...group.exclaves].join(" · ");
    const plainName = accountNameIn(known, group.accountId);
    const where = `${plainName} · on ${[...group.machines].join(", ")}`;
    const historyFrom = historyHost(group, observer);
    return {
      accountId: group.accountId,
      alias: alias ?? null,
      title: titleOf(group.accountId),
      exclaves,
      plainName,
      detail: alias === undefined ? where : `${exclaves} · ${where}`,
      bars: quota === undefined ? [] : quotaBars(quota.observation, now),
      observed: observedLine(quota, observer, now),
      historyFrom,
      charts: archived || historyFrom !== null,
    };
  });
}

export function deriveMachines(
  machines: readonly Machine[],
  now: number,
  scheduler: SchedulerAvailability,
  aliases: AccountAliases = {},
  fleetQuota: readonly FleetQuotaEntry[] = [],
  archive: ArchiveReach = NO_ARCHIVE,
  /** The relay socket is open: a close is not offered without it, as `deriveCloseAvailability`. */
  relayOpen = true,
  drains: DrainInputs = NO_DRAINS,
): MachinesView {
  const known = knownAccounts(machines);
  return {
    scheduler: schedulerLine(machines, scheduler),
    cards: machines.map((machine) =>
      machineCard(
        machine,
        now,
        scheduler,
        aliases,
        known,
        archive.machine,
        leaderDrains(machines, scheduler, relayOpen),
        drains,
      ),
    ),
    accounts: deriveAccounts(machines, now, aliases, fleetQuota, known, archive.account),
    ranges: { machine: historyRanges(archive.machine), account: historyRanges(archive.account) },
  };
}

export interface ArchivistRow {
  readonly label: string;
  readonly detail: string;
  readonly value: string;
  readonly unit: string;
}

export interface ArchivistCard {
  readonly name: string;
  readonly online: boolean;
  readonly meta: string;
  /** The build its service runs; null from an archivist that was not updated since it learned to say. */
  readonly build: string | null;
  /** Empty offline, and online until a reply for this very device is held. */
  readonly rows: readonly ArchivistRow[];
  /** Only offline: what is hidden until it is back. */
  readonly note: string | null;
}

/** The role's name, not the host's: the card is the archivist whatever its machine is called. */
const ARCHIVIST_NAME = "Archivist";
const ARCHIVIST_OFFLINE_NOTE =
  "While it is offline, 90-day and 1-year charts, merged account charts, asleep machines' history and older tasks are hidden until it is back.";

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Whole thousands separated below a million, then one decimal of millions or billions. */
function countText(rows: number): string {
  if (rows < 1_000_000) return rows.toLocaleString("en-US");
  if (rows < 1_000_000_000) return `${(rows / 1_000_000).toFixed(1)}M`;
  return `${(rows / 1_000_000_000).toFixed(1)}B`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** SI, one decimal; value and unit apart, as the row's two cells. */
function bytesText(bytes: number): { readonly value: string; readonly unit: string } {
  let index = 0;
  let size = bytes;
  while (size >= 1000 && index < BYTE_UNITS.length - 1) {
    size /= 1000;
    index += 1;
  }
  return { value: index === 0 ? String(Math.round(size)) : size.toFixed(1), unit: BYTE_UNITS[index] ?? "B" };
}

function tableRow(label: string, table: ArchiveTableStatus | null): ArchivistRow {
  // Null before the archivist's first count pass: a row the card has no number for yet, not an empty table.
  if (table === null) return { label, detail: "", value: "—", unit: "rows" };
  const detail = table.oldest === null ? "none yet" : `since ${dateFormat.format(table.oldest)}`;
  return { label, detail, value: countText(table.rows), unit: "rows" };
}

/**
 * The archivist's card (DESIGN.md, Archivist, A36): built from the flagged registry
 * entry and, online, the last `archive-status` reply held for that same
 * device. Offline it states what is hidden until the archivist is back and
 * shows no counts, which would only be the last ones it gave.
 */
export function deriveArchivist(
  entry: ArchivistEntry | null,
  held: { readonly deviceId: string; readonly reply: ArchiveStatusResponse } | null,
  now: number,
): ArchivistCard | null {
  if (entry === null) return null;
  const build = buildLine(entry.source, now);
  if (!entry.connected) {
    return {
      name: ARCHIVIST_NAME,
      online: false,
      meta: `offline · last seen ${formatSeen(entry.lastSeen, now)}`,
      build,
      rows: [],
      note: ARCHIVIST_OFFLINE_NOTE,
    };
  }
  const reply = held?.deviceId === entry.deviceId ? held.reply : null;
  const ingests = reply === null ? [] : Object.values(reply.lastIngest).filter((at) => at !== null);
  const meta =
    ingests.length === 0 ? entry.platform : `${entry.platform} · last ingest ${formatSeen(Math.max(...ingests), now)}`;
  const database = reply === null ? null : bytesText(reply.database.archiveBytes + reply.database.metricsBytes);
  return {
    name: ARCHIVIST_NAME,
    online: true,
    meta,
    build,
    rows:
      reply === null || database === null
        ? []
        : [
            tableRow("Tasks", reply.tasks),
            tableRow("Samples", reply.samples),
            tableRow("Events", reply.events),
            { label: "Database", detail: "archive + metrics", ...database },
          ],
    note: null,
  };
}
