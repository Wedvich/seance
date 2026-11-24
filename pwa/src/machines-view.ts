import {
  accountNameIn,
  CAPABILITIES,
  closedAt,
  custodianOf,
  DRAIN_INTERRUPT_MS,
  drainStart,
  drainStuckText,
  drainSummary,
  drainView,
  displayName,
  joinTags,
  parseTags,
  splitTagKey,
  displayLine,
  httpsUrl,
  taskTagEntries,
  TAG_NAMESPACES,
  type TagScope,
  type DisplayNameSource,
  type JoinedTag,
  type SessionTag,
  leaderCloseNote,
  leadsQueue,
  knownAccounts,
  type KnownAccount,
  effectivePct,
  exclaveAuth,
  loginHealth,
  exclaveTraitHealth,
  isRemoteSessionId,
  lastHeardAt,
  liveStatus,
  METRIC_NAMES,
  MIN_FREE_MIB,
  newestQuotaByAccount,
  sameCreditMonth,
  schedulerRole,
  AGENT_NAMES,
  type AgentLogin,
  type AgentLoginKind,
  type ArchiveStatusResponse,
  type DrainStuck,
  type SessionEntry,
  type ArchiveTableStatus,
  type CustodianState,
  type ArchivistEntry,
  type ExclaveInfo,
  type FleetQuotaEntry,
  type Machine,
  type MachineStatus,
  type NewestQuota,
  type PauseHold,
  type QuotaReading,
  type SchedulerAvailability,
  type SchedulerRole,
  type SourceInfo,
  type Task,
  type UpdateOutcome,
} from "@seance/shared";
import { METRIC_LABELS } from "./chart.ts";
import { taskTitle } from "./task-title.ts";
import {
  historyRanges,
  type ArchiveReach,
  type DeviceCustodian,
  type HistoryRange,
  type HistoryTarget,
} from "./state.ts";
import { timed, type Moment, type Timed } from "./timed.ts";
import { canDrainNow, formatSeen, seen } from "./view.ts";

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

/**
 * One sign-in on a machine card: an exclave, or an agent login (DESIGN.md, Daemon, "Codex login"), one row type for
 * both, told apart by `agent` alone. Drawn only when something needs attention.
 */
export interface SignInRow {
  /** The exclave's id; a login's agent name (one login per agent per machine, D1). */
  readonly id: string;
  readonly agent: AgentMark;
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
  readonly meta: Timed;
  /** Null for every machine but the relay's nominee. */
  readonly role: SchedulerRole | null;
  /** The build its daemon runs — short sha, commit age, branch; null from a daemon that doesn't say. */
  readonly build: Timed | null;
  /** Set only when its last reported update attempt was a skip or a failure; carries its age, since the next check may not have run yet. */
  readonly updateNote: Timed | null;
  /** CPU, memory, and disk fill (percent used on the fullest watched path; red under the scheduler's floor). */
  readonly gauges: readonly Gauge[];
  readonly note: string | null;
  /** Its exclaves, then its agent logins. */
  readonly signIns: readonly SignInRow[];
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
  /**
   * The close sheet's Close is soft (`canSoftClose` over the registry): the machine and the verified leader advertise
   * `softClose`. Otherwise Close drains, as before either did.
   */
  readonly softClose: boolean;
  /**
   * What the drain row and the menu offer a closed machine: on a soft close Drain, and Drain now where its daemon asks
   * its sessions (`drainAsk`); while draining, Drain now only until the ask's interrupt (`DRAIN_INTERRUPT_MS` past
   * `drainStart`), after which it has nothing left to speed up. Empty while open or where no close may be sent.
   */
  readonly drainActions: readonly DrainAction[];
  /** A closed machine's drain under a `drainPass` leader: null otherwise, and while the queue is unread. */
  readonly drain: DrainRow | null;
  /** The custodian seat's row: null unless the machine is connected and advertises `custodian`. */
  readonly custodian: CustodianRow | null;
  /**
   * Round now, pause and resume in the card's menu (the `custodian` op): only for a connected machine advertising
   * `custodian`, which every daemon answering the op does and none before it did. Thresholds, the model and on/off
   * stay in its config.json (C46).
   */
  readonly custodianControls: boolean;
  /** Its sessions by name, from its last `sessions` read; null while connected and unread, unanswered, or asleep. */
  readonly sessions: readonly SessionRow[] | null;
}

/** One session on a machine card, named as the owner's own surfaces name it (`displayName`, DESIGN.md, "Tags and session identity"). */
export interface SessionRow {
  /** The tmux pane id: what `session-tag` names, beside the conversation. Null from a daemon too old to send it. */
  readonly pane: string | null;
  readonly name: string;
  /** Said beside a name the owner did not choose: the session's own, or the window's. Null for a label or a task's title. */
  readonly mark: string | null;
  /**
   * Rename: only for a session running no task (a task's session is named by its task) whose conversation its daemon
   * verified, on a connected machine advertising `sessionTag` over an open relay. `label` is the owner's now, `""` for none.
   */
  readonly rename: { readonly pane: string; readonly session: string; readonly label: string } | null;
  /** Its joined tags by namespace (DESIGN.md, "Tags and session identity"), shown folded under the row. */
  readonly tags: readonly SessionTagGroup[];
}

/** One namespace of a session's joined tags, named by its writer: the namespace is the writer (T1). */
export interface SessionTagGroup {
  readonly namespace: string;
  readonly writer: string;
  readonly tags: readonly SessionTagLine[];
}

export interface SessionTagLine {
  readonly suffix: string;
  /** Display text through `displayLine`, never markup. */
  readonly value: string;
  /** Only `creator.ref-url`, and only as `httpsUrl` passes it. */
  readonly url: string | null;
  readonly scope: TagScope;
  /** Only a verified `agent.session`. */
  readonly verified: boolean;
  /** A task tag's is its task's creation: a record holds no per-key time. */
  readonly age: Timed;
}

const WRITERS: Readonly<Record<(typeof TAG_NAMESPACES)[number], string>> = {
  agent: "the agent's mod and hooks",
  seance: "the Séance daemon",
  self: "the session itself",
  owner: "the owner",
  creator: "the task's creator",
  scheduler: "the leader",
};

const WRITER_BY_NAMESPACE: ReadonlyMap<string, string> = new Map(Object.entries(WRITERS));

function writerOf(namespace: string): string {
  const fixed = WRITER_BY_NAMESPACE.get(namespace);
  if (fixed !== undefined) return fixed;
  return namespace.startsWith("adapter.") ? `adapter ${namespace.slice("adapter.".length)}` : namespace;
}

const NAMESPACE_ORDER: readonly string[] = ["agent", "self", "seance", "owner", "creator", "scheduler"];

function tagGroups(joined: Readonly<Record<string, JoinedTag>>, now: number): readonly SessionTagGroup[] {
  const groups = new Map<string, SessionTagLine[]>();
  for (const [key, tag] of Object.entries(joined)) {
    const split = splitTagKey(key);
    if (split === null) continue;
    const value = displayLine(tag.value);
    if (value === "") continue;
    const line: SessionTagLine = {
      suffix: split.suffix,
      value,
      url: key === "creator.ref-url" ? httpsUrl(tag.value) : null,
      scope: tag.scope,
      verified: key === "agent.session" && tag.verified === true,
      age: tag.scope === "task" ? timed`task created ${seen(tag.at, now)}` : timed`${seen(tag.at, now)}`,
    };
    groups.set(split.namespace, [...(groups.get(split.namespace) ?? []), line]);
  }
  const rank = (namespace: string): number => {
    const index = NAMESPACE_ORDER.indexOf(namespace);
    return index === -1 ? NAMESPACE_ORDER.length : index;
  };
  return [...groups.entries()]
    .toSorted(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([namespace, tags]) => ({
      namespace,
      writer: writerOf(namespace),
      tags: tags.toSorted((a, b) => a.suffix.localeCompare(b.suffix)),
    }));
}

const NAME_MARKS: Record<DisplayNameSource, string | null> = {
  owner: null,
  task: null,
  self: "(self-named)",
  window: "(window)",
};

/** `SessionEntry.tags` by scope and its task's record's tags, then `joinTags`: the task's `owner.label` wins. */
function sessionTagsJoined(entry: SessionEntry, task: Task | undefined): Readonly<Record<string, JoinedTag>> {
  const tags = parseTags(entry.tags, { scope: "session" }) ?? {};
  const at = (scope: "conversation" | "process"): Record<string, SessionTag> =>
    Object.fromEntries(Object.entries(tags).filter(([, tag]) => tag.scope === scope));
  const taskLayer = task === undefined ? null : taskTagEntries(task.spec, task.createdAt);
  return joinTags(taskLayer, at("conversation"), at("process"));
}

export function sessionRows(
  entries: readonly SessionEntry[],
  tasks: readonly Task[] | null,
  renameable: boolean,
  now: number,
): readonly SessionRow[] {
  return entries.map((entry) => {
    const task = entry.taskId === undefined ? undefined : tasks?.find((t) => t.id === entry.taskId);
    const joined = sessionTagsJoined(entry, task);
    const name = displayName(joined, task?.spec, entry.window);
    const session = joined["agent.session"];
    const pane = entry.id ?? null;
    return {
      pane,
      name: name.text,
      mark: NAME_MARKS[name.source],
      rename:
        renameable && pane !== null && entry.taskId === undefined && session?.verified === true
          ? { pane, session: session.value, label: joined["owner.label"]?.value ?? "" }
          : null,
      tags: tagGroups(joined, now),
    };
  });
}

/**
 * `MachineStatus.cu` as the card shows it. `state` null is a seat that has not reported (a status not in yet, or from
 * a daemon too old to send `cu`).
 */
export interface CustodianRow {
  readonly state: CustodianState | null;
  /** A pause holds: `paused`, or `p` behind `running` or `failing`. The menu offers Resume for it. */
  readonly paused: boolean;
  /** "last round ended 5m ago", or "no round yet"; null while there is no report. */
  readonly ended: Timed | null;
  /** "closed 3 · nudged 1", or "nothing closed"; null with no counts. */
  readonly counts: string | null;
  /** The running round's claude.ai page; null unless it is running and its id passes `isRemoteSessionId` here too. */
  readonly link: string | null;
  /** `failing`: the warn colour. */
  readonly warn: boolean;
}

/** An origin constant, never from a status: the id spliced after it passed `isRemoteSessionId` (`session_` and base62 only). */
const CLAUDE_CODE_URL = "https://claude.ai/code/";

export function custodianRow(machine: Machine, status: MachineStatus | undefined, now: number): CustodianRow | null {
  if (machine.capabilities?.includes(CAPABILITIES.custodian) !== true) return null;
  const cu = custodianOf(status);
  if (cu === null) return { state: null, paused: false, ended: null, counts: null, link: null, warn: false };
  const [closed, nudged, flagged] = cu.n ?? [];
  const parts =
    closed === undefined
      ? []
      : [`closed ${closed}`, ...(nudged ? [`nudged ${nudged}`] : []), ...(flagged ? [`flagged ${flagged}`] : [])];
  return {
    state: cu.s,
    paused: cu.s === "paused" || cu.p === true,
    ended: cu.e === undefined ? timed`no round yet` : timed`last round ended ${seen(cu.e * 1000, now)}`,
    counts: parts.length === 0 ? null : parts.join(" · ") === "closed 0" ? "nothing closed" : parts.join(" · "),
    link: cu.s === "running" && isRemoteSessionId(cu.rc) ? `${CLAUDE_CODE_URL}${cu.rc}` : null,
    warn: cu.s === "failing",
  };
}

/** What the card's custodian menu items and notes show: the store's `asking` entry for the device over the seat's `cu`. */
export interface CustodianMenu {
  /** A `sent` pause or resume shows as asked until the seat's `cu` agrees (the relay's status floor); else what `cu` says. */
  readonly paused: boolean;
  readonly running: boolean;
  /** A request is out: the store takes one per machine at a time. */
  readonly sending: boolean;
  /** A round was asked and accepted. */
  readonly roundRequested: boolean;
}

export function custodianMenu(card: Pick<MachineCard, "custodian">, asking: DeviceCustodian | null): CustodianMenu {
  return {
    paused: asking?.kind === "sent" ? asking.paused : (card.custodian?.paused ?? false),
    running: card.custodian?.state === "running",
    sending: asking?.kind === "sending",
    roundRequested: asking?.kind === "sent" && asking.act === "round",
  };
}

/** A closed machine's further step: start its drain, or start it (or cut its grace) with no wait. */
export type DrainAction = "drain" | "now";

export interface DrainRow {
  /** The drain has started; false on a soft close, whose summary is what still runs there. */
  readonly draining: boolean;
  /** `drainSummary`: "moving 2 · 1 stuck", "empty", or soft "running 2 · 1 idle at its prompt". */
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
  /** The queue read's `idle`: tasks released for sitting at their prompt, lagging the turn's end by 10 minutes. */
  readonly idle?: readonly string[];
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
  const view = drainView(machine, inputs.tasks, sessionsOf(inputs, machine.deviceId), {
    ...(inputs.idle === undefined ? {} : { idle: inputs.idle }),
  });
  // Not yet read is not unreadable: say so until the first answer.
  const reading =
    inputs.sessions[machine.deviceId] === undefined &&
    view.empty === null &&
    view.moving.length === 0 &&
    view.stuck.length === 0;
  return {
    draining: view.draining,
    summary: reading ? "reading sessions" : drainSummary(view),
    stuck: view.stuck.map((entry) => stuckLine(inputs.tasks ?? [], entry)),
  };
}

const ASK_LINE = "Its sessions are asked to pass themselves at their next pause (interrupted after 5 minutes).";

const NO_LEADER: SchedulerAvailability = { kind: "none" };

/**
 * The close sheet's words: what happens to the running work. Without a `drainPass` leader, item 1's
 * line; with one, the tasks that will be passed and the sessions that cannot be. A soft Close leads with what it
 * leaves running, and the drain's lines follow under "Close and drain". Closing the verified leader ends with
 * `leaderCloseNote`: it keeps leading while closed, soft or not.
 */
export function deriveCloseSheet(
  machine: Machine,
  inputs: DrainInputs = NO_DRAINS,
  scheduler: SchedulerAvailability = NO_LEADER,
  soft = false,
): readonly string[] {
  // Read as open: the sheet's list is prospective, so no stamp or successor of an earlier close counts.
  const drain = drainLines(machine, inputs, { cl: null });
  const lines = soft
    ? [
        `Close stops new work on ${machine.name}. Running tasks keep going until they finish or you drain the machine.`,
        // Every line, not just the first: the stuck ones are the drain's, a plain Close moves nothing.
        ...drain.map((line) => `Close and drain: ${lowerFirst(line)}`),
      ]
    : [`Closing ${machine.name} stops new work landing on it.`, ...drain];
  return leadsQueue(machine, scheduler) ? [...lines, leaderCloseNote(machine.name)] : lines;
}

/** The Drain confirm for a soft-closed machine: what its drain will do with what still runs there. */
export function deriveDrainSheet(machine: Machine, inputs: DrainInputs = NO_DRAINS): readonly string[] {
  return [`${machine.name} is closed. Draining it moves its running work off it.`, ...drainLines(machine, inputs, {})];
}

function lowerFirst(line: string): string {
  return line.charAt(0).toLowerCase() + line.slice(1);
}

function drainLines(machine: Machine, inputs: DrainInputs, at: { readonly cl?: null }): readonly string[] {
  const asks = canDrainNow(machine);
  // The drain's reads (queue, sessions) are taken only under a `drainPass` leader, so no counts without one.
  if (!inputs.passes) return [asks ? ASK_LINE : "Running work finishes where it is."];
  if (inputs.tasks === null) {
    return [
      asks
        ? `${ASK_LINE.slice(0, -1)}; any left are passed to other machines 10 minutes after, unless you reopen it.`
        : "Its running tasks are passed to other machines 10 minutes after, unless you reopen it.",
    ];
  }
  const sessions = sessionsOf(inputs, machine.deviceId);
  const view = drainView(machine, inputs.tasks, sessions, { ...at, draining: true });
  const lines: string[] = [];
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
  readonly note: Timed | null;
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
  /** The alias, else `members`, made unique among the cards. */
  readonly title: string;
  /**
   * What signs in as this account, anywhere in the fleet: a Claude account's exclave ids; an agent login's agent name
   * (one login per agent per machine, so `detail`'s machines say the rest). The card reads alike for both.
   */
  readonly members: string;
  /** Whose account it is, shown as the agent's logo before the title, on every card so the list reads alike. */
  readonly agent: AgentMark;
  /** What it reads as without its alias: email, else short id, with any twin tag. */
  readonly plainName: string;
  /** Named, what the title no longer says leads it, then its machines. */
  readonly detail: string;
  readonly bars: readonly QuotaBar[];
  readonly observed: Timed;
  /** The machine to read this account's quota history from without the archive; null when none online can serve it. */
  readonly historyFrom: string | null;
  /** Whether a chart can be asked for: from `historyFrom`, or merged from the archive while it charts accounts. */
  readonly charts: boolean;
  /**
   * The "Open for work" switch: the leader's account hold, read off the queue's holds. Null while it cannot be
   * flipped (no relay, no verified leader, or no queue read to know the holds by), `off` under a hold of any kind.
   */
  readonly openSwitch: "on" | "off" | null;
  /** Why the account takes no new work: its hold in words; null while open or the holds are unknown. */
  readonly hold: Timed | null;
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

/** `formatUntil` with its instant kept, for a line that shows the timestamp on hover. */
export function until(at: number, now: number): Moment {
  return { text: formatUntil(at, now), at };
}

/**
 * One exclave's login line (`exclaveAuth` is the one rule). Whole days from a day out, else whole hours,
 * floored like `formatUntil` and never under 1h: "expires in 0h" would read as lapsed.
 */
function authNote(machine: Machine, index: number, now: number): SignInRow["auth"] {
  const auth = exclaveAuth(machine, index, now);
  if (auth.state === "expired") return { text: "needs /login", level: "err" };
  if (auth.state !== "expiring") return null;
  const left = auth.expiresAt - now;
  const text = left >= DAY ? `${Math.floor(left / DAY)}d` : `${Math.max(1, Math.floor(left / HOUR))}h`;
  return { text: `login expires in ${text}`, level: "warn" };
}

/** The exclave's failing probes, by trait: "atlas probe failing", "atlas, az probes failing". */
function probeNote(machine: Machine, exclave: ExclaveInfo, index: number, now: number): SignInRow["probes"] {
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
function accountLabel(
  login: Pick<ExclaveInfo | AgentLogin, "accountId" | "authOk">,
  aliases: AccountAliases,
  known: readonly KnownAccount[],
): string {
  if (login.accountId !== null) {
    return accountNameIn(known, login.accountId, aliasOf(aliases, login.accountId));
  }
  return login.authOk ? "signed in" : "not signed in";
}

/** The agent's own sign-in verb: a login is signed in on its machine's shell, never from the PWA. */
/** An agent's logo key and its name, the name being the logo's text for a screen reader and a hover. */
export interface AgentMark {
  readonly kind: AgentKind;
  readonly name: string;
}

/** Claude, which owns the exclaves, beside every agent that signs in as a login. */
export type AgentKind = "claude" | AgentLoginKind;

function agentMark(agent: AgentLoginKind | null): AgentMark {
  return agent === null ? { kind: "claude", name: "Claude" } : { kind: agent, name: AGENT_NAMES[agent] };
}

const LOGIN_VERBS: Readonly<Record<AgentLoginKind, string>> = { codex: "seance codex login" };

/** `loginHealth` in words; null for ok, and for unknown: unread says nothing, as for an exclave. */
function loginNote(machine: Machine, login: AgentLogin, index: number, now: number): SignInRow["auth"] {
  switch (loginHealth(machine, index, now)) {
    case "expired":
      return { text: `expired: run ${LOGIN_VERBS[login.agent]}`, level: "err" };
    case "signed_out":
      return { text: `run ${LOGIN_VERBS[login.agent]}`, level: "warn" };
    case "unidentified":
      return { text: "account not identified", level: "warn" };
    case "blocked":
      return { text: "included usage blocked", level: "err" };
    case "ok":
    case "unknown":
      return null;
  }
}

function loginRow(
  machine: Machine,
  login: AgentLogin,
  index: number,
  aliases: AccountAliases,
  known: readonly KnownAccount[],
  now: number,
): SignInRow {
  return {
    id: AGENT_NAMES[login.agent],
    agent: agentMark(login.agent),
    account: accountLabel(login, aliases, known),
    sessions: null,
    auth: loginNote(machine, login, index, now),
    probes: null,
  };
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

function updateNote(machine: Machine, now: number): Timed | null {
  const report = machine.lastUpdate;
  if (report === undefined) return null;
  const trouble = UPDATE_TROUBLE[report.outcome];
  return trouble === null ? null : timed`Last update attempt ${seen(report.at, now)}: ${trouble}.`;
}

function buildLine(source: SourceInfo | undefined, now: number): Timed | null {
  if (source === undefined) return null;
  const where = source.branch ?? "detached";
  return timed`${source.sha.slice(0, 12)} · committed ${seen(source.commitTs, now)} · ${where}`;
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

/**
 * The verified leader advertises `capability` over an open relay: for `drain`, the gate `deriveCloseAvailability`
 * applies, and for `softClose` `canSoftClose`'s leader half, over the registry alone.
 */
function leaderAdvertises(
  machines: readonly Machine[],
  scheduler: SchedulerAvailability,
  relayOpen: boolean,
  capability: string,
): boolean {
  if (!relayOpen || scheduler.kind !== "ready") return false;
  return machines.find((m) => m.deviceId === scheduler.deviceId)?.capabilities?.includes(capability) === true;
}

function drainActions(machine: Machine, canClose: boolean, now: number): readonly DrainAction[] {
  // An asleep machine answers nothing, so a drain asked of it would only fail.
  if (!canClose || !machine.connected || closedAt(machine) === null) return [];
  const asks = canDrainNow(machine);
  const start = drainStart(machine);
  if (start === null) return asks ? ["drain", "now"] : ["drain"];
  return asks && now < start + DRAIN_INTERRUPT_MS ? ["now"] : [];
}

function machineCard(
  machine: Machine,
  now: number,
  scheduler: SchedulerAvailability,
  aliases: AccountAliases,
  known: readonly KnownAccount[],
  archived: boolean,
  leader: { readonly drains: boolean; readonly softCloses: boolean },
  drains: DrainInputs,
  relayOpen: boolean,
): MachineCard {
  const canDrain = leader.drains;
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
  const updated = status === undefined ? timed`` : timed` · updated ${seen(status.at * 1000, now)}`;
  const meta = machine.connected
    ? timed`${machine.platform}${updated}`
    : timed`asleep · last seen ${seen(lastHeardAt(machine), now)}`;

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
    signIns: [
      ...(machine.exclaves ?? []).map((exclave, index) => ({
        id: exclave.id,
        agent: agentMark(null),
        account: accountLabel(exclave, aliases, known),
        sessions: status?.sess?.[index] ?? null,
        auth: authNote(machine, index, now),
        probes: probeNote(machine, exclave, index, now),
      })),
      ...(machine.logins ?? []).map((login, index) => loginRow(machine, login, index, aliases, known, now)),
    ],
    // An asleep machine's history is the archive's alone (A36f); a connected one's daemon keeps the short ranges.
    charts: servesMetrics(machine) || (archived && !machine.connected),
    closed,
    openSwitch: !canClose ? null : closed ? "off" : canDrain ? "on" : null,
    softClose:
      canClose && canDrain && leader.softCloses && machine.capabilities?.includes(CAPABILITIES.softClose) === true,
    drainActions: drainActions(machine, canClose && canDrain, now),
    drain: drainRow(machine, drains),
    // Asleep, the seat reports nothing a reader can act on: the row would only ever say `no report yet`.
    custodian: machine.connected ? custodianRow(machine, status, now) : null,
    custodianControls: machine.connected && machine.capabilities?.includes(CAPABILITIES.custodian) === true,
    sessions: sessionsOfCard(machine, drains, relayOpen, now),
  };
}

function sessionsOfCard(
  machine: Machine,
  inputs: DrainInputs,
  relayOpen: boolean,
  now: number,
): readonly SessionRow[] | null {
  const entries = sessionsOf(inputs, machine.deviceId);
  if (!machine.connected || entries === null) return null;
  const renameable = relayOpen && machine.capabilities?.includes(CAPABILITIES.sessionTag) === true;
  return sessionRows(entries, inputs.tasks, renameable, now);
}

interface AccountGroup {
  readonly accountId: string;
  /** Null for Claude. An id is one agent's by construction (a login's is prefixed), so one group has one. */
  readonly agent: AgentLoginKind | null;
  /** Exclave ids for Claude; the agent's name for a login. */
  readonly members: Set<string>;
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
  // "now" keeps the reset's instant like every other note, so a hover still says when it was.
  if (resetsAt * 1000 <= now) return { ...bar, note: ["reset ", { text: "now", at: resetsAt * 1000 }] };
  return { ...bar, note: [until(resetsAt * 1000, now)] };
}

/**
 * Credits show only while a window is full: that is when use spills into them,
 * and until then they are a figure nothing on the card is spending.
 * Last month's Claude figure says nothing about this one's, so it shows no bar;
 * an agent login's `c` is no monthly figure (`loginCreditsBar`).
 */
function quotaBars(observation: QuotaReading, now: number, login: boolean): QuotaBar[] {
  const bars: QuotaBar[] = [];
  if (observation.h !== undefined) bars.push(quotaBar("5h", observation.h, observation.hr, now));
  if (observation.d !== undefined) bars.push(quotaBar("7d", observation.d, observation.dr, now));
  for (const window of observation.w ?? []) bars.push(quotaBar(`7d ${window.m}`, window.p, window.r, now));
  if (observation.c === undefined || !bars.some((bar) => bar.pct >= 100)) return bars;
  if (login) return [...bars, loginCreditsBar(observation.c)];
  if (!sameCreditMonth(observation.at, now / 1000)) return bars;
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
  return { ...bar, note: [`${money.format(cu / 100)} of ${money.format(cl / 100)}`] };
}

/**
 * An agent login's Credits bar (docs/codex.md, "Credits and spill"): `c` is 100 less the member limit's remaining
 * percent where one is reported, else 0 while the account can spend and 100 once it cannot. So the note names the
 * state where the dollar note would go: available at 0 (a member limit untouched reads the same, and is), spent at
 * 100, the member limit's share between. Never an amount: Codex's unit is unstated until a real spill settles it (O2).
 */
function loginCreditsBar(c: number): QuotaBar {
  const base = gauge("Credits", c);
  // As Claude's (`creditsBar`): on screen only while spending, so never green.
  const bar = base.level === "ok" ? { ...base, level: "warn" as const } : base;
  const note = bar.pct >= 100 ? "spent" : bar.pct <= 0 ? "available" : "member limit";
  return { ...bar, note: [note] };
}

/**
 * Each daemon stores only what its own exclaves observed, so the host that saw
 * the account last has the freshest history; any other online host beats none.
 */
function historyHost(group: AccountGroup, newest: Machine | undefined): string | null {
  if (newest !== undefined && servesMetrics(newest)) return newest.deviceId;
  return group.charted[0] ?? null;
}

function observedLine(quota: NewestQuota | undefined, observer: Machine | undefined, now: number): Timed {
  // One text for every kind: a Claude account's reading comes from a session, a login's from its machine's probe.
  if (quota === undefined) return ["No quota seen yet. It shows once its machine has reported."];
  // Only the fleet quota record outlives its observer's registry entry.
  if (observer === undefined) {
    return timed`${quota.observation.s} · ${seen(quota.observation.at * 1000, now)} on a machine no longer listed`;
  }
  const where = observer.connected ? observer.name : `${observer.name}, asleep`;
  return timed`${quota.observation.s} · ${seen(quota.observation.at * 1000, now)} on ${where}`;
}

/**
 * Grouped by account id across every machine; whose numbers show is
 * `newestQuotaByAccount`'s rule (DESIGN.md, PWA), over the statuses and the fleet quota
 * record. An asleep machine's kept status counts like a live one, its age on the observed
 * line; a machine with no status at all names the account but contributes no numbers, unless
 * the record holds a reading for it. Exclaves and agent logins that
 * aren't signed in have no account to group under and appear only on their card.
 * An agent login's account is a card like a Claude one (docs/codex.md, "Goal"), badged with its agent
 * and titled by its name rather than by exclave ids, which it has none of.
 */
function deriveAccounts(
  machines: readonly Machine[],
  now: number,
  aliases: AccountAliases,
  fleetQuota: readonly FleetQuotaEntry[],
  known: readonly KnownAccount[],
  archived: boolean,
  holds: AccountHolds,
): AccountCard[] {
  const groups = new Map<string, AccountGroup>();
  const join = (machine: Machine, accountId: string, agent: AgentLoginKind | null, member: string): void => {
    const group = groups.get(accountId) ?? {
      accountId,
      agent,
      members: new Set(),
      machines: new Set(),
      charted: [],
    };
    group.members.add(member);
    group.machines.add(machine.name);
    if (servesMetrics(machine) && !group.charted.includes(machine.deviceId)) group.charted.push(machine.deviceId);
    groups.set(accountId, group);
  };
  for (const machine of machines) {
    for (const exclave of machine.exclaves ?? []) {
      if (exclave.accountId !== null) join(machine, exclave.accountId, null, exclave.id);
    }
    for (const login of machine.logins ?? []) {
      if (login.accountId !== null) join(machine, login.accountId, login.agent, AGENT_NAMES[login.agent]);
    }
  }

  const newest = newestQuotaByAccount(machines, fleetQuota);
  // Titles tell the cards, and their ⋯ labels, apart: a repeated one gains the exclave ids, then the machines, and
  // finally the account id, which no other account shares.
  const tiers = (group: AccountGroup): string[] => {
    const alias = aliasOf(aliases, group.accountId);
    const on = [...group.machines].join(", ");
    const exclaves = [...group.members].join(" · ");
    const base = alias ?? exclaves;
    const named = (inner: string): string => (alias === undefined ? inner : `${alias} (${inner})`);
    return [base, named(exclaves), named(`${exclaves} on ${on}`), `${base} (${group.accountId})`];
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
    const members = [...group.members].join(" · ");
    const plainName = accountNameIn(known, group.accountId);
    const on = `on ${[...group.machines].join(", ")}`;
    const historyFrom = historyHost(group, observer);
    const held = holds.known ? accountHold(holds.holds, group.accountId, now) : undefined;
    return {
      accountId: group.accountId,
      alias: alias ?? null,
      title: titleOf(group.accountId),
      members,
      agent: agentMark(group.agent),
      plainName,
      detail: [...(alias === undefined ? [] : [members]), plainName, on].join(" · "),
      bars: quota === undefined ? [] : quotaBars(quota.observation, now, group.agent !== null),
      observed: observedLine(quota, observer, now),
      historyFrom,
      charts: archived || historyFrom !== null,
      openSwitch: !holds.known || !holds.switchable ? null : held === undefined ? "on" : "off",
      hold: held === undefined ? null : holdLine(held, now),
    };
  });
}

/**
 * The leader's holds as the account cards read them. `known` once a queue read landed, `switchable` while a pause
 * or resume could also be sent (the relay is open and a verified leader leads).
 */
interface AccountHolds {
  readonly known: boolean;
  readonly switchable: boolean;
  readonly holds: readonly PauseHold[];
}

/** The account's hold in force: a reset hold past its `resumeAt` has lifted, as the leader judges it (`pause.ts`). */
function accountHold(holds: readonly PauseHold[], accountId: string, now: number): PauseHold | undefined {
  return holds.find(
    (hold) =>
      hold.account === accountId && (hold.until === "resume" || (hold.resumeAt !== undefined && hold.resumeAt > now)),
  );
}

function holdLine(hold: PauseHold, now: number): Timed {
  if (hold.until === "resume") return timed`Closed to new work ${seen(hold.at, now)}. Running sessions keep going.`;
  if (hold.resumeAt === undefined) return ["Closed to new work until its quota resets"];
  const when = { text: formatUntil(hold.resumeAt, now).replace(/^resets /u, ""), at: hold.resumeAt };
  return timed`Closed to new work until its quota resets (${when})`;
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
  /** The leader's holds from the last queue read; null before one landed, when no account's switch is offered. */
  holds: readonly PauseHold[] | null = null,
): MachinesView {
  const known = knownAccounts(machines);
  const leader = {
    drains: leaderAdvertises(machines, scheduler, relayOpen, CAPABILITIES.drain),
    softCloses: leaderAdvertises(machines, scheduler, relayOpen, CAPABILITIES.softClose),
  };
  return {
    scheduler: schedulerLine(machines, scheduler),
    cards: machines.map((machine) =>
      machineCard(machine, now, scheduler, aliases, known, archive.machine, leader, drains, relayOpen),
    ),
    accounts: deriveAccounts(machines, now, aliases, fleetQuota, known, archive.account, {
      known: holds !== null,
      switchable: relayOpen && scheduler.kind === "ready",
      holds: holds ?? [],
    }),
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
  readonly meta: Timed;
  /** The build its service runs; null from an archivist that was not updated since it learned to say. */
  readonly build: Timed | null;
  /** Empty offline, and online until a reply for this very device is held. */
  readonly rows: readonly ArchivistRow[];
  /** Only offline: what is hidden until it is back. */
  readonly note: string | null;
  /** Only online, from a reply held for this device: task reads gone stale, task rows refused (A36k). */
  readonly warnings: readonly string[];
}

/** The role's name, not the host's: the card is the archivist whatever its machine is called. */
const ARCHIVIST_NAME = "Archivist";
const ARCHIVIST_OFFLINE_NOTE =
  "While it is offline, 90-day and 1-year charts, merged account charts, asleep machines' history and older tasks are hidden until it is back.";

/**
 * A healthy collector reads the task listing at least every 10 min (`COLLECT_TIMINGS.pollMs`); an hour without
 * any task read is a listing failing, which the newest-of-all "last ingest" in the meta line would hide behind the
 * registry. A named task get also counts as a read, so a listing that fails while nudged gets land stays silent.
 */
export const ARCHIVIST_STORE_STALE_MS = 60 * 60_000;
const JOURNAL_HINT = "The archivist's journal says why.";

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
      meta: timed`offline · last seen ${seen(entry.lastSeen, now)}`,
      build,
      rows: [],
      note: ARCHIVIST_OFFLINE_NOTE,
      warnings: [],
    };
  }
  const reply = held?.deviceId === entry.deviceId ? held.reply : null;
  const ingests = reply === null ? [] : Object.values(reply.lastIngest).filter((at) => at !== null);
  const meta =
    ingests.length === 0 ? [entry.platform] : timed`${entry.platform} · last ingest ${seen(Math.max(...ingests), now)}`;
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
    warnings: reply === null ? [] : archivistWarnings(reply, now),
  };
}

/**
 * Both lines are this archivist process's own view: its clock and tally start empty at each restart. Staleness is
 * judged against `countedAt`, the archivist's own clock when the counts were taken, never the viewer's: a phone
 * with a skewed clock, or a reply held while the tab was hidden, then shows no false line. Before the first count
 * pass there is no reference and no stale line.
 */
function archivistWarnings(reply: ArchiveStatusResponse, now: number): string[] {
  const warnings: string[] = [];
  const { store } = reply.lastIngest;
  const at = reply.countedAt;
  if (at !== null) {
    if (store !== null && at - store > ARCHIVIST_STORE_STALE_MS) {
      warnings.push(`Last task read from the relay store ${formatSeen(store, at)}. ${JOURNAL_HINT}`);
    } else if (store === null && reply.onlineSince !== null && at - reply.onlineSince > ARCHIVIST_STORE_STALE_MS) {
      warnings.push(
        `No task read from the relay store since it came online ${formatSeen(reply.onlineSince, at)}. ${JOURNAL_HINT}`,
      );
    }
  }
  const refused = reply.refused;
  if (refused !== undefined && refused.tasks > 0) {
    const count = `${refused.tasks} finished task${refused.tasks === 1 ? "" : "s"}`;
    const first = refused.since === null ? "" : `; the first was refused ${formatSeen(refused.since, now)}`;
    warnings.push(`${count} could not be archived${first}, since the archivist last started. ${JOURNAL_HINT}`);
  }
  return warnings;
}
