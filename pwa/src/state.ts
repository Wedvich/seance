import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  type ArchiveMetricsStep,
  type ArchiveTaskOutcome,
  type ArchiveTasksCursor,
  type ArchivedMachine,
  type ArchivedTask,
  type ArchivistEntry,
  type AutonomyLevel,
  METRIC_NAMES,
  type MetricName,
  type MetricsSeries,
  type PauseHold,
  type Decision,
  type SessionEntry,
  type Task,
  type TaskDep,
  type TaskUntil,
  type IdleTaskRef,
  type UnreadableTaskRef,
} from "@seance/shared";

/** Offered models. The wire keeps `model` a free string so this can change without a daemon deploy. */
export const MODELS = ["fable", "opus", "sonnet", "haiku"] as const;
export type Model = (typeof MODELS)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** `xhigh` capitalises badly; this matches what Claude Code on web shows. */
export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
};

export const MODEL_LABELS: Record<Model, string> = {
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

/** Short enough for a tile and the Queue card's chip. */
export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  steer: "Steer",
  checkpoint: "Checkpoint",
  auto: "Auto",
};

/** The sheet's one line per level, in DESIGN.md's words ("Autonomy level"). */
export const AUTONOMY_HINTS: Record<AutonomyLevel, string> = {
  steer: "Plans first and waits for your approval",
  checkpoint: "Gets on with it, and stops only on a real choice",
  auto: "Also makes reversible choices itself, and notes each one",
};

export type SheetKind = "machine" | "account" | "repo" | "model" | "effort" | "autonomy" | "after" | "requires";

/**
 * The Machine sheet's rescan action: inline scanning/failure state on the row it
 * was asked for, so only that row shows it.
 */
export type RescanState =
  | { readonly kind: "idle" }
  | { readonly kind: "scanning" | "failed"; readonly deviceId: string };

/** One shared object, so `#patch`'s identity check sees an idle rescan as unchanged. */
export const RESCAN_IDLE: RescanState = { kind: "idle" };

export type Verdict =
  /**
   * A spawn the relay's store took. `task` is the newest copy the
   * leader reported — refreshed from `queue` on `queue-changed` and a bounded
   * poll while the verdict is up — so the screen follows it from waiting to
   * placed, with its decision. Until a leader reads it, it is the app's own
   * copy.
   */
  | { readonly kind: "queued"; readonly task: Task; readonly follow?: FollowEnd }
  /**
   * The store refused the task, or its answer never came; `message` says which.
   * `retry` is the task to put again: the same id, so a retry cannot queue twice.
   * `runNow`: it was a Start now, and a retry is one too.
   */
  | {
      readonly kind: "unqueued";
      readonly message: string;
      readonly mayHaveLanded: boolean;
      readonly retry?: Task;
      readonly runNow?: true;
    }
  /** Queued with no relay to take it: kept on this phone (`HeldTask`) and sent when the app reconnects. */
  | { readonly kind: "held"; readonly task: Task };

/**
 * A task queued while the relay was unreachable, kept on this phone until it is
 * sent. The task is whole (its id minted at the tap), so a resend after a lost
 * reply answers `landedEarlier` and cannot queue it twice. `failure`: the send
 * was refused, as a sentence; it waits for a retry instead of being sent again
 * by itself. `sending` is never persisted.
 */
export interface HeldTask {
  readonly task: Task;
  readonly failure: string | null;
  readonly sending: boolean;
}

/** Plaintext prompts at rest, like the draft: bounded so a dead relay can't grow it without limit. */
export const HELD_MAX = 10;

/**
 * Holding rides out a dropped connection, not a long trip offline: a task older than this is
 * dropped unsent, since whatever it was for has likely moved on (and past the leader's admission
 * age it would be refused anyway).
 */
export const HELD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Oldest first, the order held tasks are listed and sent in; ties broken by id so every tab agrees. */
export function heldOrder(a: HeldTask, b: HeldTask): number {
  return a.task.createdAt - b.task.createdAt || (a.task.id < b.task.id ? -1 : 1);
}

export function heldStale(task: Task, now: number): boolean {
  return now - task.createdAt > HELD_MAX_AGE_MS;
}

/** Why a Start now's `run-now` left its task where it was, as a sentence, for the queued verdict of `taskId`. */
export interface StartNowRefusal {
  readonly taskId: string;
  readonly message: string;
}

/**
 * Why a queued verdict stopped following its task before it settled.
 * `refused`: the leader answered the read with a refusal (`message`).
 * `gone`: the leader answered without it and the store holds no such task.
 * `unanswered`: the polls ran out with the last one unanswered, so what shows
 * may be stale. `unlisted`: they ran out with the last answer leaving out a
 * task the store still holds. `stopped`: they ran out while the task still waited.
 */
export type FollowEnd =
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "gone" }
  | { readonly kind: "unanswered" }
  | { readonly kind: "unlisted" }
  | { readonly kind: "stopped" };

/** What survives a reload; transient fields are deliberately absent. */
export interface PersistedForm {
  /** The machine pick, by deviceId; null is `auto`: the scheduler chooses. Written to the task as `pin.deviceId`. */
  readonly machine: string | null;
  /** The account pick, by accountId; null is `auto`. Written as `pin.account`; the alias is display only. */
  readonly account: string | null;
  /** The repo to run, by `RepoEntry.origin` — the cross-machine key, since no clone is chosen. */
  readonly repo: string | null;
  readonly prompt: string;
  readonly worktree: boolean;
  readonly model: Model;
  readonly effort: Effort;
  /** Per task: the tasks this one waits on. Cleared once a task is queued. */
  readonly after: readonly TaskDep[];
  /** Per task: what settles it. `reported` waits for its session's own done report. */
  readonly until: TaskUntil;
  /** Per task: the traits the machine must declare, sorted by the order they were ticked. Cleared once a task is queued. */
  readonly requires: readonly string[];
}

export interface SessionsView {
  readonly sessions: readonly SessionEntry[];
  readonly at: number;
}

/**
 * Pressure belongs to a machine, quota to an account: a machine's chart is its
 * own load, an account's is read from one machine hosting it (`deviceId`, null
 * when none online can serve it) and narrowed to that account's series — or,
 * while the archivist serves it, merged across machines from the archive. Which
 * side answers is the store's choice at ask time (`Store.showHistory`), never
 * part of the target.
 */
export type HistoryTarget =
  | { readonly kind: "machine"; readonly deviceId: string }
  | { readonly kind: "account"; readonly accountId: string; readonly deviceId: string | null };

/**
 * A chart asks for its own series only: every series of a multi-exclave machine
 * at a day's 5-min points overflows the relay's envelope (DESIGN.md, `metrics`).
 * All of them are whole percent, so one 0–100 axis serves either.
 */
export const TARGET_METRICS: Record<HistoryTarget["kind"], readonly MetricName[]> = {
  machine: [METRIC_NAMES.cpu, METRIC_NAMES.mem, METRIC_NAMES.disk],
  account: [METRIC_NAMES.h, METRIC_NAMES.d, METRIC_NAMES.w],
};

/** Ranges a daemon keeps. */
export const SHORT_HISTORY_RANGES = ["6h", "24h", "30d"] as const;
/** Ranges only the archive keeps (DESIGN.md, Archivist, A32), offered only while it serves the chart (A35, A36d). */
export const ARCHIVE_HISTORY_RANGES = ["90d", "1y"] as const;
export const HISTORY_RANGES = [...SHORT_HISTORY_RANGES, ...ARCHIVE_HISTORY_RANGES] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

/** Opens on a day: long enough to show a working pattern, on the tier that fits it. */
export const DEFAULT_HISTORY_RANGE: HistoryRange = "24h";

/**
 * Each range on the coarsest-needed tier, so none crosses `METRICS_MAX_POINTS`.
 * 90 days and a year take the archive's own steps (6 h, 1 d), which no daemon takes.
 */
export const RANGE_SPANS: Record<HistoryRange, { readonly span: number; readonly step: ArchiveMetricsStep }> = {
  "6h": { span: 6 * 3600, step: 30 },
  "24h": { span: 24 * 3600, step: 300 },
  "30d": { span: 30 * 24 * 3600, step: 3600 },
  "90d": { span: 90 * 24 * 3600, step: 21_600 },
  "1y": { span: 365 * 24 * 3600, step: 86_400 },
};

export function isArchiveRange(range: HistoryRange): boolean {
  return ARCHIVE_HISTORY_RANGES.some((long) => long === range);
}

export type ArchiveReach = Readonly<Record<HistoryTarget["kind"], boolean>>;

/**
 * Which charts the archivist can serve now: none while it is offline (A35). An
 * account's needs the account key too, since the archive files its series under
 * the `account:` store key, never the raw id. The store and the screen read this
 * one rule, so a chart is offered exactly when it can be asked for.
 */
export function archiveCharts(archivist: ArchivistEntry | null, nameable: boolean): ArchiveReach {
  const online = archivist?.connected === true;
  return { machine: online, account: online && nameable };
}

/** The range picker's options: the long ones only while the archive serves the chart (A36d). */
export function historyRanges(archived: boolean): readonly HistoryRange[] {
  return archived ? HISTORY_RANGES : SHORT_HISTORY_RANGES;
}

/** The task history's Dates presets (A36h): no custom range. */
export const OLDER_DATES = ["7d", "30d", "90d", "1y", "any"] as const;
export type OlderDates = (typeof OLDER_DATES)[number];

export const OLDER_DATE_LABELS: Record<OlderDates, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "1y": "Last year",
  any: "Any time",
};

const DAY_MS = 24 * 3600 * 1000;

/** How far back each preset reaches, ms; `any` sends no bound. */
export const OLDER_DATE_SPANS: Record<Exclude<OlderDates, "any">, number> = {
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS,
  "1y": 365 * DAY_MS,
};

/** The Older section's filter sheets, one per tile. */
export type OlderSheet = "repo" | "outcome" | "machine" | "account" | "dates";

/** A picked machine or account: the id the archivist filters on, and the name the tile shows. */
export interface OlderPicked {
  readonly id: string;
  readonly label: string;
}

/** What Older is narrowed to; they never touch the live sections (A36h). */
export interface OlderFilters {
  /** An origin, as `task.spec.repo` holds it. */
  readonly repo: string | null;
  readonly outcome: ArchiveTaskOutcome | null;
  /** By device id, retired machines included. */
  readonly machine: OlderPicked | null;
  /** By `account:` store key: the raw id never goes to the archivist. */
  readonly account: OlderPicked | null;
  readonly dates: OlderDates;
  /** The search field's text as typed; sent trimmed. */
  readonly title: string;
}

/** Any of the sheets' picks: everything but the search. */
export type OlderPick = Partial<Omit<OlderFilters, "title">>;

export const NO_OLDER_FILTERS: OlderFilters = {
  repo: null,
  outcome: null,
  machine: null,
  account: null,
  dates: "any",
  title: "",
};

/** What the archive answered for the current filters, pages appended in order. */
export type OlderList =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly tasks: readonly ArchivedTask[];
      /** Every match, as the archive counts it (live duplicates included). */
      readonly total: number;
      readonly next: ArchiveTasksCursor | null;
      /** The machines the archive holds tasks for, from page one; null from an archivist too old to list them. */
      readonly machines: readonly ArchivedMachine[] | null;
      readonly loadingMore: boolean;
      /** Why the last Load older failed; the rows already read stay. */
      readonly moreError: string | null;
    };

/** The Queue screen's Older section (A34, A36g–A36j). Memory only, like the Asleep toggle. */
export interface OlderState {
  readonly open: boolean;
  readonly filters: OlderFilters;
  /** The archivist the list was read from: a seat move drops it. */
  readonly deviceId: string | null;
  /** Null until opened, or after whatever dropped it. */
  readonly list: OlderList | null;
  /** The filter sheet showing, a layer like the form's sheets. */
  readonly sheet: OlderSheet | null;
  /** `account:` store key → account id, for the accounts this install knows: an archived row's account shows by its name here. */
  readonly accountKeys: Readonly<Record<string, string>>;
}

export const CLOSED_OLDER: OlderState = {
  open: false,
  filters: NO_OLDER_FILTERS,
  deviceId: null,
  list: null,
  sheet: null,
  accountKeys: {},
};

/** The form's `route-preview`: what the scheduler would decide now, for the repo it was asked about. */
export type PreviewState =
  /** `previous` is the decision a re-ask for the same repo replaces, shown until the answer lands. */
  | { readonly kind: "loading"; readonly repo: string; readonly previous?: Decision }
  | { readonly kind: "ok"; readonly repo: string; readonly decision: Decision }
  | { readonly kind: "failed"; readonly repo: string; readonly message: string };

/** The Queue screen's read of the leader's `queue`: the tasks it keeps in view and what holds dispatch. */
export type QueueState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ok";
      readonly tasks: readonly Task[];
      readonly holds: readonly PauseHold[];
      /** Records the leader cannot read: they hold store slots no prune frees, until a person discards them. */
      readonly unreadable: readonly UnreadableTaskRef[];
      /** Running tasks the leader holds no slot for while they sit idle at their prompt (`QueueResponse.idle`). */
      readonly idle: readonly IdleTaskRef[];
      /** The leader's in-flight cap, the header's denominator; absent from an older leader. */
      readonly globalMax?: number;
      /** The leader's clock when it answered, ms. */
      readonly at: number;
      /**
       * The leader's clock minus this device's as the reply arrived (the trip
       * included), ms: what a leader-stamped time (`Task.pr.at`) needs added to
       * this device's `now` to be compared with it. Local; no frame carries it.
       */
      readonly skew: number;
    }
  | { readonly kind: "failed"; readonly message: string };

/** Account aliases: the names every client shows for a Claude account, read from the relay's `account:` records. */
export interface AccountsState {
  /** accountId to alias; only readable, non-cleared records. */
  readonly aliases: Readonly<Record<string, string>>;
  /** False on an install saved before account records: it has no account key until the PSK is re-entered. */
  readonly nameable: boolean;
  /** The accountId a rename is in flight for. */
  readonly saving: string | null;
  /** The account whose rename dialog is open: a layer, so back closes it. */
  readonly renaming: string | null;
  /** The last rename's refusal or failure, as a sentence; cleared by the next rename or a dismiss. */
  readonly notice: string | null;
}

/** A task's action on its way to the leader (a continue: to the store; a pass: the leader, which pushes first and answers last); the row shows it busy. */
export interface TaskAction {
  readonly taskId: string;
  readonly op: "cancel" | "mark-done" | "run-now" | "continue" | "pass";
}

export type HistoryResult =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly series: readonly MetricsSeries[] }
  | { readonly kind: "failed"; readonly message: string };

/** The one chart open on the machines screen; its window is fixed when asked, in unix seconds. */
export interface HistoryView {
  readonly target: HistoryTarget;
  readonly range: HistoryRange;
  readonly from: number;
  readonly to: number;
  readonly step: ArchiveMetricsStep;
  readonly result: HistoryResult;
}

/**
 * DEFAULT_MODEL / DEFAULT_EFFORT are plain strings on the wire; assigning them
 * here without a cast is deliberate, so dropping one from the offered list
 * fails the build instead of shipping an unselectable default.
 */
export const DEFAULT_FORM: PersistedForm = {
  machine: null,
  account: null,
  repo: null,
  prompt: "",
  worktree: true,
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
  after: [],
  until: "merged",
  requires: [],
};

export function isModel(value: unknown): value is Model {
  return typeof value === "string" && (MODELS as readonly string[]).includes(value);
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}
