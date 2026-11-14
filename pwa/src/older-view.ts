import {
  ARCHIVE_TASK_OUTCOMES,
  ARCHIVE_TASKS_PAGE,
  autonomyOf,
  DEFAULT_AUTONOMY,
  knownAccounts,
  originLabel,
  sentence,
  taskFailureText,
  type ArchivedTask,
  type ArchiveTaskOutcome,
  type ArchiveTasksCursor,
  type ArchiveTasksRequest,
  type ArchivedMachine,
  type KnownAccount,
  type Task,
} from "@seance/shared";
import { accountDisplayName } from "./machines-view.ts";
import { carriesOnLine, passedToLine, prNames, type QueueRow } from "./queue-view.ts";
import {
  AUTONOMY_LABELS,
  NO_OLDER_FILTERS,
  OLDER_DATE_LABELS,
  OLDER_DATE_SPANS,
  OLDER_DATES,
  type OlderFilters,
  type OlderPick,
  type OlderSheet,
} from "./state.ts";
import { taskTitle } from "./task-title.ts";
import { formatSeen, scopedRepos, type AppState, type Dot, type Tile } from "./view.ts";

/**
 * The Queue screen's Older section as data (DESIGN.md, Archivist, A34, A35,
 * A36g–A36j): the archive's finished tasks past the live list, with its search,
 * filter tiles and sheets, derived in one pure pass like `deriveQueue`.
 */

export const OLDER_TITLE = "Older";

export const OUTCOME_LABELS: Record<ArchiveTaskOutcome, string> = {
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  superseded: "Passed on",
};

const SHEET_TITLES: Record<OlderSheet, string> = {
  repo: "Repo",
  outcome: "Outcome",
  machine: "Machine",
  account: "Account",
  dates: "Dates",
};

export interface OlderOption {
  readonly key: string;
  readonly label: string;
  readonly sub: string | null;
  readonly mono: boolean;
  readonly dot: Dot | null;
  readonly selected: boolean;
  readonly pick: OlderPick;
}

export interface OlderSheetView {
  readonly kind: OlderSheet;
  readonly title: string;
  readonly options: readonly OlderOption[];
}

export interface OlderView {
  readonly open: boolean;
  /** The search field's text, as typed. */
  readonly search: string;
  /** Repo, Outcome, Machine, Account, Dates: the spawn form's grid. */
  readonly tiles: readonly { readonly sheet: OlderSheet; readonly tile: Tile }[];
  /** Archived cards: every action off, so the card has no ⋯ menu and no inline button (A36i). */
  readonly rows: readonly QueueRow[];
  /** Under the filters: "Loading…", a failure, or why nothing is listed; null with rows to show. */
  readonly status: string | null;
  /** "Clear search and filters" is offered: a narrowed read found nothing. */
  readonly clearable: boolean;
  /** "Showing 20 of 134"; null with nothing shown. */
  readonly showing: string | null;
  /** Load older is offered: the archive holds more past the last row. */
  readonly more: { readonly loading: boolean } | null;
  /** Why the last Load older failed. */
  readonly moreError: string | null;
  readonly sheet: OlderSheetView | null;
}

/** Narrowed past the default: a read that finds nothing then says so and offers to clear. */
export function filtersActive(filters: OlderFilters): boolean {
  return (
    filters.repo !== null ||
    filters.outcome !== null ||
    filters.machine !== null ||
    filters.account !== null ||
    filters.dates !== NO_OLDER_FILTERS.dates ||
    filters.title.trim() !== ""
  );
}

/** One page's request: the filters as the archivist takes them, dates bounded from `now`. */
export function olderRequest(filters: OlderFilters, now: number, before?: ArchiveTasksCursor): ArchiveTasksRequest {
  const title = filters.title.trim();
  return {
    limit: ARCHIVE_TASKS_PAGE,
    ...(before === undefined ? {} : { before }),
    ...(filters.repo === null ? {} : { repo: filters.repo }),
    ...(filters.outcome === null ? {} : { outcome: filters.outcome }),
    ...(filters.machine === null ? {} : { machine: filters.machine.id }),
    ...(filters.account === null ? {} : { account: filters.account.id }),
    ...(filters.dates === "any" ? {} : { since: now - OLDER_DATE_SPANS[filters.dates] }),
    ...(title === "" ? {} : { title }),
  };
}

/** The ids the live queue lists: Older leaves them out (A36g). */
export function liveTaskIds(state: AppState): ReadonlySet<string> {
  const view = state.queueView;
  return new Set(view?.kind === "ok" ? view.tasks.map((task) => task.id) : []);
}

const ACCOUNT_KEY_PREFIX = "account:";

/**
 * How an archived account reads: as everywhere else in the app when this
 * install knows the account behind its store key, else by the alias the
 * archive kept, else a short form of the key.
 */
function accountName(
  key: string,
  alias: string | null,
  state: AppState,
  known: readonly KnownAccount[],
  ids: ReadonlyMap<string, string>,
): string {
  const id = ids.get(key);
  if (id !== undefined) return accountDisplayName(known, id, state.accounts.aliases);
  if (alias !== null) return alias;
  const hex = key.startsWith(ACCOUNT_KEY_PREFIX) ? key.slice(ACCOUNT_KEY_PREFIX.length) : key;
  return `acct ${hex.slice(0, 8)}`;
}

/** The registry's name while the machine is listed, else the archive's last known one (A24). */
function machineName(row: ArchivedTask, state: AppState): string | null {
  const deviceId = row.task.assignment?.deviceId;
  const listed = deviceId === undefined ? undefined : state.relay.machines.find((m) => m.deviceId === deviceId);
  return listed?.name ?? row.machine;
}

function outcomePhrase(task: Task): string {
  if (task.state === "cancelled") return "Cancelled";
  if (task.state === "failed") return "It failed";
  if (task.state === "superseded") return "Passed to a successor";
  if (task.doneBy === "merged") return "Its PR merged";
  if (task.doneBy === "reported") return "It reported done";
  if (task.doneBy === "manual") return "Marked done";
  if (task.doneBy === "linear") return "Its Linear issue was closed";
  return "It finished";
}

/** The chip as it last read when archived: no checks icon, never greyed for age, no live block (A36i). */
function archivedPr(task: Task): QueueRow["pr"] {
  if (task.prUrl === undefined) return null;
  const { label, noun, name } = prNames(task.prUrl);
  const state = task.pr?.state ?? null;
  const reading = state === null ? "" : `${state}, `;
  return {
    url: task.prUrl,
    label,
    state,
    checks: null,
    stale: false,
    blocked: null,
    description: [name, ...(state === null ? [] : [state]), "as last archived"].join(" · "),
    accessibleName: `Open ${noun} (${reading}as last archived)`,
  };
}

function archivedRow(
  row: ArchivedTask,
  state: AppState,
  now: number,
  known: readonly KnownAccount[],
  ids: ReadonlyMap<string, string>,
  chain: Chain,
): QueueRow {
  const { task } = row;
  const machine = machineName(row, state);
  const account = row.account === null ? null : accountName(row.account, row.alias, state, known, ids);
  const failure = task.state === "failed" && task.failure !== undefined ? task.failure : undefined;
  const why =
    failure === undefined ? null : taskFailureText(failure.code, failure.exit, task.spec.until, failure.oomKill);
  const autonomy = autonomyOf(task.spec);
  return {
    id: task.id,
    title: taskTitle(task),
    headline: `${outcomePhrase(task)}${machine === null ? "" : ` on ${machine}`}`,
    body: [...(why === null ? [] : [sentence(why)]), `Created ${formatSeen(task.createdAt, now)}.`].join(" "),
    dot: task.state === "failed" ? "err" : null,
    age: formatSeen(row.endedAt, now),
    canCancel: false,
    canMarkDone: false,
    cancelEndsSession: false,
    markDoneEndsSession: false,
    canFollowUp: false,
    canContinue: false,
    canPass: false,
    inlinePrimary: false,
    startNow: null,
    inline: null,
    deps: null,
    continues: null,
    continuing: null,
    carriesOn: carriesOnLine(task, chain.titles, chain.revealable),
    passedTo: passedToLine(task, chain.titles, chain.revealable),
    placement: [originLabel(task.spec.repo), ...(account === null ? [] : [account])].join(" · "),
    batch: null,
    busy: false,
    pr: archivedPr(task),
    // The session is gone with the record; a link would open a page that no longer answers for it.
    session: null,
    answer: null,
    autonomy: autonomy === DEFAULT_AUTONOMY ? null : AUTONOMY_LABELS[autonomy],
  };
}

/** What a successor-chain line can name and link: the live queue's tasks and the Older rows shown. */
interface Chain {
  readonly titles: ReadonlyMap<string, string>;
  readonly revealable: ReadonlySet<string>;
}

function chainOf(state: AppState, shown: readonly ArchivedTask[]): Chain {
  const view = state.queueView;
  const live = view?.kind === "ok" ? view.tasks : [];
  const titles = new Map([...live, ...shown.map((row) => row.task)].map((task) => [task.id, taskTitle(task)]));
  // Every live card is reachable: the Queue screen opens a collapsed Asleep section before revealing into it.
  return { titles, revealable: new Set(titles.keys()) };
}

function accountIds(state: AppState): ReadonlyMap<string, string> {
  return new Map(Object.entries(state.older.accountKeys));
}

function tile(label: string, value: string | null, mono = false): Tile {
  return { label, value: value ?? "Any", mono: mono && value !== null, dot: null, tag: null };
}

const ANY = (kind: string): Omit<OlderOption, "selected" | "pick"> => ({
  key: "any",
  label: "Any",
  sub: `every ${kind}`,
  mono: false,
  dot: null,
});

function repoOptions(state: AppState, rows: readonly ArchivedTask[]): OlderOption[] {
  const { repo } = state.older.filters;
  const origins = new Set(scopedRepos(state.relay.machines, { machine: null, account: null }).map((r) => r.origin));
  for (const row of rows) origins.add(row.task.spec.repo);
  if (repo !== null) origins.add(repo);
  const listed = [...origins]
    .map((origin) => ({ origin, label: originLabel(origin) }))
    .toSorted((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .map(({ origin, label }): OlderOption => ({
      key: origin,
      label,
      sub: origin === label ? null : origin,
      mono: true,
      dot: null,
      selected: origin === repo,
      pick: { repo: origin },
    }));
  return [{ ...ANY("repo"), selected: repo === null, pick: { repo: null } }, ...listed];
}

function outcomeOptions(state: AppState): OlderOption[] {
  const { outcome } = state.older.filters;
  return [
    { ...ANY("outcome"), selected: outcome === null, pick: { outcome: null } },
    ...ARCHIVE_TASK_OUTCOMES.map((value): OlderOption => ({
      key: value,
      label: OUTCOME_LABELS[value],
      sub: null,
      mono: false,
      dot: null,
      selected: value === outcome,
      pick: { outcome: value },
    })),
  ];
}

/**
 * The registry's machines, then those only the archive names: retired, under
 * their last known name (A24, A36h), newest first. The archive's own list says
 * which; the rows read add what an older archivist, which sends none, leaves out.
 */
function machineOptions(
  state: AppState,
  rows: readonly ArchivedTask[],
  archived: readonly ArchivedMachine[],
  now: number,
): OlderOption[] {
  const { machine } = state.older.filters;
  const listed = state.relay.machines.map((m): OlderOption => ({
    key: m.deviceId,
    label: m.name,
    sub: m.connected ? null : `offline · last seen ${formatSeen(m.lastSeen, now)}`,
    mono: false,
    dot: m.connected ? "ok" : "off",
    selected: machine?.id === m.deviceId,
    pick: { machine: { id: m.deviceId, label: m.name } },
  }));
  const registered = new Set(state.relay.machines.map((m) => m.deviceId));
  const shown = (deviceId: string, name: string | null): string => name ?? deviceId.slice(0, 8);
  const retired = new Map<string, { name: string | null; seen: number }>();
  const note = (deviceId: string, name: string | null, seen: number): void => {
    if (registered.has(deviceId)) return;
    const held = retired.get(deviceId);
    if (held === undefined) {
      retired.set(deviceId, { name, seen });
      return;
    }
    // The newer sighting's name wins, but a missing one never hides an older sighting's.
    retired.set(deviceId, {
      name: seen > held.seen ? (name ?? held.name) : (held.name ?? name),
      seen: Math.max(seen, held.seen),
    });
  };
  for (const entry of archived) note(entry.deviceId, entry.name, entry.lastSeen);
  for (const row of rows) {
    const deviceId = row.task.assignment?.deviceId;
    if (deviceId !== undefined) note(deviceId, row.machine, row.endedAt);
  }
  const newest = [...retired].toSorted(([, a], [, b]) => b.seen - a.seen);
  const gone = newest.map(([deviceId, { name, seen }]): OlderOption => ({
    key: deviceId,
    label: shown(deviceId, name),
    sub: `no longer listed · last seen ${formatSeen(seen, now)}`,
    mono: false,
    dot: "off",
    selected: machine?.id === deviceId,
    pick: { machine: { id: deviceId, label: shown(deviceId, name) } },
  }));
  // A pick no row read now names (a reload of the list): kept, so it can be seen and changed.
  const stray: OlderOption[] =
    machine === null || registered.has(machine.id) || retired.has(machine.id)
      ? []
      : [
          {
            key: machine.id,
            label: machine.label,
            sub: "no longer listed",
            mono: false,
            dot: "off",
            selected: true,
            pick: { machine },
          },
        ];
  return [{ ...ANY("machine"), selected: machine === null, pick: { machine: null } }, ...listed, ...gone, ...stray];
}

/** Accounts by store key: those this install can key, then those only archived rows name. */
function accountOptions(
  state: AppState,
  rows: readonly ArchivedTask[],
  known: readonly KnownAccount[],
  ids: ReadonlyMap<string, string>,
): OlderOption[] {
  const { account } = state.older.filters;
  const labels = new Map<string, string>();
  for (const key of ids.keys()) labels.set(key, accountName(key, null, state, known, ids));
  for (const row of rows) {
    if (row.account !== null && !labels.has(row.account)) {
      labels.set(row.account, accountName(row.account, row.alias, state, known, ids));
    }
  }
  if (account !== null && !labels.has(account.id)) labels.set(account.id, account.label);
  const listed = [...labels].map(([key, label]): OlderOption => ({
    key,
    label,
    sub: null,
    mono: false,
    dot: null,
    selected: account?.id === key,
    pick: { account: { id: key, label } },
  }));
  return [{ ...ANY("account"), selected: account === null, pick: { account: null } }, ...listed];
}

function dateOptions(state: AppState): OlderOption[] {
  const { dates } = state.older.filters;
  return OLDER_DATES.map((value): OlderOption => ({
    key: value,
    label: OLDER_DATE_LABELS[value],
    sub: null,
    mono: false,
    dot: null,
    selected: value === dates,
    pick: { dates: value },
  }));
}

function sheetView(
  kind: OlderSheet,
  state: AppState,
  rows: readonly ArchivedTask[],
  archived: readonly ArchivedMachine[],
  now: number,
  known: readonly KnownAccount[],
  ids: ReadonlyMap<string, string>,
): OlderSheetView {
  const options = {
    repo: () => repoOptions(state, rows),
    outcome: () => outcomeOptions(state),
    machine: () => machineOptions(state, rows, archived, now),
    account: () => accountOptions(state, rows, known, ids),
    dates: () => dateOptions(state),
  }[kind]();
  return { kind, title: SHEET_TITLES[kind], options };
}

/** Null while no archivist is online: the screen is then exactly as it is without one (A35). */
export function deriveOlder(state: AppState, now: number): OlderView | null {
  if (state.relay.archivist?.connected !== true) return null;
  const { older } = state;
  const { filters, list } = older;
  const read = list?.kind === "ok" ? list.tasks : [];
  const live = liveTaskIds(state);
  const shown = read.filter((row) => !live.has(row.task.id));
  const known = knownAccounts(state.relay.machines);
  const ids = accountIds(state);
  const chain = chainOf(state, shown);
  const rows = shown.map((row) => archivedRow(row, state, now, known, ids, chain));

  let status: string | null = null;
  let clearable = false;
  if (list === null || list.kind === "loading") status = "Loading…";
  else if (list.kind === "failed") status = list.message;
  else if (rows.length === 0 && list.next !== null && list.loadingMore) status = "Loading…";
  else if (rows.length === 0 && list.next === null) {
    clearable = filtersActive(filters);
    status = clearable ? "No older tasks match." : "No older tasks.";
  }

  const ok = list?.kind === "ok" ? list : null;
  // Live duplicates read so far come off the archive's count, so the two numbers count the same rows.
  const total = ok === null ? 0 : ok.total - (read.length - shown.length);
  return {
    open: older.open,
    search: filters.title,
    tiles: [
      { sheet: "repo", tile: tile("Repo", filters.repo === null ? null : originLabel(filters.repo), true) },
      { sheet: "outcome", tile: tile("Outcome", filters.outcome === null ? null : OUTCOME_LABELS[filters.outcome]) },
      { sheet: "machine", tile: tile("Machine", filters.machine?.label ?? null) },
      { sheet: "account", tile: tile("Account", filters.account?.label ?? null) },
      {
        sheet: "dates",
        tile: { label: "Dates", value: OLDER_DATE_LABELS[filters.dates], mono: false, dot: null, tag: null },
      },
    ],
    rows,
    status,
    clearable,
    showing: rows.length === 0 ? null : `Showing ${rows.length} of ${Math.max(total, rows.length)}`,
    // Also with nothing shown: a read-on that failed or hit its cap, or rows that turned live since the read.
    more: ok !== null && ok.next !== null && (rows.length > 0 || !ok.loadingMore) ? { loading: ok.loadingMore } : null,
    moreError: ok?.moreError ?? null,
    sheet:
      older.sheet === null
        ? null
        : sheetView(older.sheet, state, read, ok?.machines ?? list?.machines ?? [], now, known, ids),
  };
}
