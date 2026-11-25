import {
  AGENT_NAMES,
  autonomyOf,
  DEFAULT_AUTONOMY,
  PR_STATUS_STALE_MS,
  QUEUE_MAX_TASKS,
  TASK_PHASES,
  TASK_SPEC_LIMITS,
  continueOffer,
  goneContinuation,
  knownAccounts,
  parseTags,
  passOffer,
  taskPrBlock,
  waitingContinuation,
  type DepAfter,
  type FlagReason,
  type KnownAccount,
  type Machine,
  type PauseHold,
  type PrBlockedReason,
  type PrChecks,
  type PrState,
  type Task,
  FLEET_LIMIT_MAX,
  BACKGROUND_KINDS,
  CAPABILITIES,
  parseSessionLive,
  type BackgroundKind,
  type IdleTaskRef,
  type NeedsInputReason,
  type SessionEntry,
  type SessionLive,
} from "@seance/shared";
import { machineAsleep, needsAttention } from "./asleep.ts";
import {
  avoidLine,
  decisionStartNowItem,
  inputWait,
  pinLine,
  notBeforeLine,
  requiresLine,
  taskHeadline,
  waitingText,
  type StartNowItem,
} from "./decision-view.ts";
import { settlingInput } from "./input-debounce.ts";
import {
  accountDisplayName,
  formatUntil,
  sessionRowId,
  sessionRows,
  type SessionRow,
  type SessionTagGroup,
} from "./machines-view.ts";
import { AUTONOMY_LABELS } from "./state.ts";
import { taskTagLines } from "./task-tags.ts";
import { taskTitle } from "./task-title.ts";
import { plain, timed, type Moment, type Timed } from "./timed.ts";
import {
  deriveContinueAvailability,
  deriveContinueHandoffAvailability,
  deriveCodexCheckpointAvailability,
  deriveCodexContinueAvailability,
  deriveLimitsAvailability,
  derivePassAvailability,
  deriveCodexPassAvailability,
  deriveReportedOffered,
  deriveRunNowAvailability,
  deriveRunNowPastPause,
  deriveTaskTagsAvailability,
  failedBody,
  formatSeen,
  seen,
  type AppState,
} from "./view.ts";

/**
 * The Queue screen as data: sections, rows and the hold lines, derived in one
 * pure pass like `deriveView`, so what a row says and may do is testable
 * without a DOM.
 */

export type QueueDot = "ok" | "auto" | "err";

/** The one action a card shows inline; the rest sit behind its ⋯ menu. */
export type QueueInlineAction = "continue";

/**
 * The likeliest next step that acts on the task itself. Follow up, Start now, Mark done and Cancel
 * are never inline: Follow up starts another task, and Start now jumps the queue, so both live only
 * in the menu.
 */
export function primaryAction(row: Pick<QueueRow, "canContinue">): QueueInlineAction | null {
  return row.canContinue ? "continue" : null;
}

export type ArmOp = "cancel" | "mark-done" | "pass" | "close";

/** Names the act and the row, so one item's tap can't arm another's. */
export function armKey(op: ArmOp, rowId: string): string {
  return `${op}:${rowId}`;
}

/** A session row has no task, so neither flag: only its Close arms. */
export type ArmRow = Pick<QueueRow, "id"> & Partial<Pick<QueueRow, "cancelEndsSession" | "markDoneEndsSession">>;

/**
 * An act that ends a session asks twice: a first tap only arms (`fire` false, and the menu stays
 * open to relabel), a second within the arm window fires. `armed` is what the screen holds next.
 */
export function armTap(
  row: ArmRow,
  op: ArmOp,
  armed: string | null,
): { readonly fire: boolean; readonly armed: string | null } {
  const key = armKey(op, row.id);
  // A pass or a close always ends the session it names, and is only offered while one is live.
  const endsSession =
    op === "pass" ||
    op === "close" ||
    (op === "cancel" ? row.cancelEndsSession === true : row.markDoneEndsSession === true);
  if (endsSession && armed !== key) return { fire: false, armed: key };
  return { fire: true, armed: null };
}

/** A row's menu closing, by any means, disarms that row's acts; Clear's arm and other rows' stay. */
export function disarmRow(rowId: string, armed: string | null): string | null {
  const own = (["cancel", "mark-done", "pass", "close"] as const).map((op) => armKey(op, rowId));
  return armed !== null && own.includes(armed) ? null : armed;
}

/** A row prints `headline · age`, so a sentence's full stop would sit mid-line; an ellipsis stays. */
function withoutPeriod(line: Timed): Timed {
  const last = line.at(-1);
  if (typeof last !== "string" || !last.endsWith(".") || last.endsWith("..")) return line;
  return [...line.slice(0, -1), last.slice(0, -1)].filter((part) => part !== "");
}

export interface QueueRow {
  readonly id: string;
  /** The task's own title: the Label dialog shows it, so a label never hides it for good. */
  readonly title: string;
  /** The card's heading: `owner.label` when set (T2: the owner's label outranks the task's title), else `title`. */
  readonly name: string;
  readonly headline: Timed;
  readonly body: Timed | null;
  readonly dot: QueueDot | null;
  readonly age: Moment;
  readonly canCancel: boolean;
  readonly canMarkDone: boolean;
  /** Cancelling despawns a session: the button asks twice. */
  readonly cancelEndsSession: boolean;
  /** Mark done may despawn a session (live, or `lost` with its machine back; the PWA can't tell which): asks twice. */
  readonly markDoneEndsSession: boolean;
  /** Offered while the task can still be waited on; a finished one has nothing left to wait for. "Follow up" prefills the form's After. */
  readonly canFollowUp: boolean;
  /**
   * A failed or cancelled session that can be picked up where it stopped, or an `awaiting-merge` task whose PR
   * is blocked: its machine is present and advertises it, the leader does too, and no continuation of it is
   * already waiting, live or settled.
   */
  readonly canContinue: boolean;
  /**
   * A running task that can hand its work to a successor: it has a branch of its own, its machine
   * and the leader both advertise `successor`, and it is not waiting on anyone (`passOffer`).
   * Only ever in the menu: it ends the session, so it asks twice.
   */
  readonly canPass: boolean;
  /**
   * The owner can label the task (`amend` with `ownerTags`): any task, finished included, while the verified leader
   * takes task tags. Never an archived row: its record left the leader's store.
   */
  readonly canLabel: boolean;
  /** Its `owner.label`, shown in place of the title (`name`); null when unset. */
  readonly label: string | null;
  /** Its `creator.ref`, linked to `creator.ref-url` when that is an https: URL; null without one. */
  readonly ref: { readonly text: string; readonly url: string | null } | null;
  /** Continue is the card's primary action: a blocked PR is what the person was alerted to fix. */
  readonly inlinePrimary: boolean;
  /** A waiting task's Start now menu item: always shown, greyed (`enabled`) by the split button's rules and until it is `ready`; null once it is no longer waiting. */
  readonly startNow: StartNowItem | null;
  /** `primaryAction` of the flags above: the card's one inline button. */
  readonly inline: QueueInlineAction | null;
  /** What it waits on, one line; null when it waits on nothing. */
  readonly deps: string | null;
  /** The earlier session it continues, one line; null for any other task. */
  readonly continues: string | null;
  /** The earlier task whose work this one carries on, one line; null for any other task. */
  readonly carriesOn: LineageLine | null;
  /** The task its work was passed to, one line; null for any other task. */
  readonly passedTo: LineageLine | null;
  /** What its worktree started from, by the leader's `Task.stack`, one line; null until a stacked dispatch ran. */
  readonly stackedOn: LineageLine | null;
  /**
   * A continuation of it still in the queue, one line naming it and revealing its row on tap; else, when one was
   * refused because the worktree and branch are gone, one line saying so (no reveal: that card may sit in Older);
   * null for any other task.
   */
  readonly continuing: LineageLine | null;
  /** Its pin and avoid list, one line in the verdict's wording; null when it has neither. */
  readonly placement: string | null;
  /** Its place in a batch, one line; null outside one. */
  readonly batch: string | null;
  readonly busy: boolean;
  /**
   * The PR its session reported, for the card's chip: `#123` where the URL names a number.
   * `state` and `checks` are the leader's forge reading, null without one (or without checks, or
   * once merged: a settled PR's CI says nothing more); `stale` is a reading old enough that the
   * leader has probably stopped reading, so the chip greys.
   */
  readonly pr: {
    readonly url: string;
    readonly label: string;
    readonly state: PrState | null;
    readonly checks: PrChecks | null;
    readonly stale: boolean;
    /**
     * Why its PR is stuck, in words, when the task waits on the merge and the leader's reading names a
     * reason (`taskPrBlock`: an `until: "reported"` task does not wait on it); null otherwise.
     */
    readonly blocked: string | null;
    /** The chip's `title`: the PR, what the leader read of it, and how long ago. */
    readonly description: string;
    /** The chip's accessible name: what following it does, then the same reading. */
    readonly accessibleName: string;
  } | null;
  /** Its session's claude.ai page, which the title links to; null until its machine reported a Remote Control id. */
  readonly session: string | null;
  /** The card's "Answer in Claude": `session` while the task waits for input there, else null. */
  readonly answer: string | null;
  /** Its autonomy level for the meta line's chip; null at `checkpoint`, the default, as `describeTask` leaves it out. */
  readonly autonomy: string | null;
  /** The agent that runs it, for the meta line's chip; null for Claude Code, the default a record leaves out. */
  readonly agent: string | null;
  /**
   * The custodian's flag on the task: a fixed label for its reason, and the note it wrote. Display-only: the note is
   * model-written from pane text, shown as text and never used to act, sort or section. Null when it has none.
   */
  readonly flag: { readonly label: string; readonly note: string | null } | null;
  /** Its live session's pane, for Close (docs/work.md, "Join"); null while no read lists it, or its machine is away. */
  readonly close: CloseTarget | null;
  /** Its live session's joined tags, folded under the card; empty while no read lists the session. */
  readonly sessionTags: readonly SessionTagGroup[];
}

/** The graceful despawn's target: `SessionEntry.id` on its machine, the only target the daemon takes. */
export interface CloseTarget {
  readonly deviceId: string;
  readonly pane: string;
}

/**
 * A live session the queue's list carries no row for (docs/work.md, WS1): one running no task, or one whose task the
 * capped list leaves out. It has no record to act on, so it offers only what acts on the session itself.
 */
export interface SessionQueueRow {
  /** `sessionRowId`: never a task id, so no task act can name it; the drain row's link focuses it (WS7). */
  readonly id: string;
  readonly deviceId: string;
  /** `displayName` through `sessionRows`. */
  readonly name: string;
  /** `SessionRow.mark`: said beside a name the owner did not choose. */
  readonly nameMark: string | null;
  /** Carries a task the capped list leaves out: marked so, and counted with the tasks in the summary. */
  readonly tasked: boolean;
  /** "Not a task", or "Task not listed". */
  readonly kind: string;
  /** Its machine, then its repo where known. */
  readonly where: string;
  /** What its `live` says, or that there is none. */
  readonly state: Timed;
  readonly close: CloseTarget | null;
  /** `SessionRow.rename`: only an untasked session, on a machine that takes `session-tag`. */
  readonly rename: SessionRow["rename"];
  /** Its `agent.remote` page on claude.ai; null without one. */
  readonly session: string | null;
  readonly tags: readonly SessionTagGroup[];
}

/** What each flag reason says on the card: fixed per reason, the note beside it is the custodian's own words. */
export const FLAG_LABELS: Record<FlagReason, string> = {
  stuck: "Custodian: looks stuck",
  look: "Custodian: take a look",
  dirty: "Custodian: kept its worktree (uncommitted changes)",
  unpushed: "Custodian: kept its worktree (unpushed commits)",
};

export interface QueueSection {
  readonly title: string;
  readonly rows: readonly QueueRow[];
  /** The sessions it places beside its tasks, after them; only Needs you, Running, Idle and Asleep hold any. */
  readonly sessions: readonly SessionQueueRow[];
}

/** The section holding a row, a task's or a session's (the focus a link names); undefined while none lists it. */
export function sectionOf(sections: readonly QueueSection[], rowId: string): string | undefined {
  return sections.find((s) => s.rows.some((r) => r.id === rowId) || s.sessions.some((r) => r.id === rowId))?.title;
}

export interface HoldRow {
  readonly key: string;
  readonly text: Timed;
  readonly account?: string;
}

/** The fleet limit, as the header's count opens it in the Limits sheet. */
export interface LimitView {
  /** The limit in force; null is none. */
  readonly fleet: number | null;
}

/** The banner over a queue whose leader cannot read its limits record. */
export const LIMITS_UNREADABLE =
  "The session limit can't be read, so nothing new starts. Set it again to let the queue go.";

/** The Limits sheet's field as a limit: null for none (empty), undefined for text that is no limit. */
export function parseLimitDraft(draft: string): number | null | undefined {
  const text = draft.trim();
  if (text === "") return null;
  if (!/^\d+$/u.test(text)) return undefined;
  const fleet = Number(text);
  return fleet >= 1 && fleet <= FLEET_LIMIT_MAX ? fleet : undefined;
}

export interface QueueScreenView {
  /**
   * The header's meta line, "2 running · 1 waiting · 3 sessions", or "2/8 running" under a limit; null until a list has
   * been read. Sessions running no task are counted apart, since the fleet cap counts tasks only.
   */
  readonly summary: string | null;
  /**
   * The fleet limit to change; null while no verified leader that keeps one has answered `queue`,
   * and the header's line is then plain text.
   */
  readonly limit: LimitView | null;
  /** `LIMITS_UNREADABLE` while the leader says so, else null. */
  readonly limitsUnreadable: string | null;
  /** A verified leader answers and the socket is open. */
  readonly available: boolean;
  /** The reply held `QUEUE_MAX_TASKS` tasks, so older ones may be left out. */
  readonly partial: string | null;
  readonly holds: readonly HoldRow[];
  /** A whole-queue hold exists: the footer offers Resume. */
  readonly paused: boolean;
  /**
   * Records the leader cannot read, which hold store slots no prune frees: the
   * line the screen offers to clear them under, or null when there are none.
   */
  readonly unreadable: string | null;
  readonly sections: readonly QueueSection[];
  /** Shown in place of the list when there is nothing to list. */
  readonly empty: string | null;
  /** A task escalated for input is waiting. */
  readonly attention: boolean;
}

function statusLine(state: AppState): { text: string; available: boolean } {
  const { relay } = state;
  if (relay.status !== "open") return { text: "Not connected to the relay", available: false };
  const { scheduler } = relay;
  if (scheduler.kind === "none") return { text: "No scheduler is leading right now", available: false };
  if (scheduler.kind === "unverified") {
    return { text: "Leader unverified — it hasn't shown it holds this key", available: false };
  }
  const leader = relay.machines.find((m) => m.deviceId === scheduler.deviceId);
  return { text: `Scheduler on ${leader?.name ?? scheduler.deviceId}`, available: true };
}

function holdText(hold: PauseHold, state: AppState, known: readonly KnownAccount[], now: number): Timed {
  if (hold.account === undefined) return ["The whole queue is paused until resumed"];
  const who = accountDisplayName(known, hold.account, state.accounts.aliases);
  if (hold.until === "resume") return [`${who} is paused until resumed`];
  if (hold.resumeAt === undefined) return [`${who} is paused until its quota resets`];
  // `formatUntil` reads "resets in 3h"; inside this sentence the verb is already said.
  const when = { text: formatUntil(hold.resumeAt, now).replace(/^resets /u, ""), at: hold.resumeAt };
  return timed`${who} is paused until its quota resets (${when})`;
}

function holdRow(hold: PauseHold, state: AppState, known: readonly KnownAccount[], now: number): HoldRow {
  return {
    key: hold.account ?? "queue",
    text: holdText(hold, state, known, now),
    ...(hold.account === undefined ? {} : { account: hold.account }),
  };
}

function dotOf(task: Task): QueueDot | null {
  if (task.state === "failed" || task.escalated === true) return "err";
  const phase = TASK_PHASES[task.state];
  if (phase === "placed") return "ok";
  if (phase === "waiting" || phase === "dispatching") return "auto";
  return null;
}

/**
 * `run-now` takes only a `ready` task and answers anything earlier `not_waiting`, so Start now
 * greys until then rather than offering a tap that is always refused. Shown still: it says why.
 */
function startNowFor(task: Task, pastPause: boolean, leaderNow: number): StartNowItem {
  // `run-now` ignores the time, but a stale decision's machine would be named for a task that is not being routed.
  if (task.state === "ready" && notBeforeLine(task, leaderNow) !== null)
    return { sub: "Skip the queue", enabled: true };
  if (task.state === "blocked") return { sub: "Waiting on the tasks it depends on", enabled: false };
  if (task.state === "queued") return { sub: "Waiting for the scheduler", enabled: false };
  return decisionStartNowItem(task.decision ?? null, pastPause);
}

/** `idle`, its `since` on this device's clock, is set only for a task the leader released idle. */
function bodyOf(task: Task, machines: readonly Machine[], now: number, skew: number, idle?: IdleTaskRef): Timed | null {
  const line = bodyLine(task, machines, now, skew, idle);
  return typeof line === "string" ? [line] : line;
}

const BACKGROUND_NOUNS: Record<BackgroundKind, readonly [string, string]> = {
  shell: ["shell", "shells"],
  agent: ["subagent", "subagents"],
  monitor: ["monitor", "monitors"],
  workflow: ["workflow", "workflows"],
  other: ["other task", "other tasks"],
  wakeup: ["scheduled wake-up", "scheduled wake-ups"],
};

/**
 * What an idle session's last turn end left behind, as the clause before "since": its own background work (a CI
 * watch), the API error that ended the turn, or plain idle. Exported for tests.
 */
export function idleClause(idle: IdleTaskRef): string {
  const work = BACKGROUND_KINDS.flatMap((kind) => {
    const count = idle.background?.[kind];
    if (count === undefined) return [];
    const [one, many] = BACKGROUND_NOUNS[kind];
    return [`${count} ${count === 1 ? one : many}`];
  });
  if (work.length > 0) return `Idle, waiting on its background work (${work.join(", ")})`;
  if (idle.stopError !== undefined) return `Stopped on an API error (${idle.stopError.replaceAll("_", " ")})`;
  return "Idle at its prompt";
}

function bodyLine(
  task: Task,
  machines: readonly Machine[],
  now: number,
  skew: number,
  idle?: IdleTaskRef,
): string | Timed | null {
  // The leader's `lost` is the sleep itself: waking settles it, and giving up is all the phone can do.
  if (task.state === "lost" && machineAsleep(task, machines)) {
    return "Settles when its machine wakes; cancel or mark done to give up on it";
  }
  const deferred = notBeforeLine(task, now + skew);
  if (deferred !== null) return deferred.replace(/^until/u, "Not placed before");
  const waiting = waitingText(task);
  if (waiting !== null) return `Waiting: ${waiting}`;
  if (task.state === "failed") {
    return failedBody(
      task.failure?.code,
      task.failure?.exit,
      task.spec.until,
      task.failure?.oomKill,
      task.failure?.message,
    );
  }
  if (task.state === "needs-input" && task.escalated === true) {
    const wait = inputWait(task);
    const clause = `${wait.slice(0, 1).toUpperCase()}${wait.slice(1)}`;
    return task.needsInputSince === undefined
      ? clause
      : timed`${clause} since ${seen(task.needsInputSince - skew, now)}`;
  }
  if (idle !== undefined) return timed`${idleClause(idle)} since ${seen(idle.since, now)} — its slot is free`;
  return null;
}

const PR_CHECKS_READING: Record<PrChecks, string> = {
  pending: "checks pending",
  passing: "checks passing",
  failing: "checks failing",
  unrun: "a check never ran",
};

const PR_BLOCKED_LABEL: Record<PrBlockedReason, string> = {
  checks: "check failing",
  conflict: "conflict",
  behind: "behind",
  unarmed: "not set to merge",
};

/** GitHub's `/pull/<n>`, GitLab's `/-/merge_requests/<n>`. */
const PR_NUMBER = /\/(?:pull|merge_requests)\/(\d+)(?:\/|$)/u;

/** A PR's chip label (`#123` where the URL names a number), the noun for sentences, and that noun capitalised. */
export function prNames(prUrl: string): { readonly label: string; readonly noun: string; readonly name: string } {
  const number = PR_NUMBER.exec(new URL(prUrl).pathname)?.[1];
  const noun = number === undefined ? "pull request" : `pull request #${number}`;
  return {
    label: number === undefined ? "PR" : `#${number}`,
    noun,
    name: `${noun.slice(0, 1).toUpperCase()}${noun.slice(1)}`,
  };
}

/**
 * `prUrl` is `https:`-checked at parse (`httpsUrl`), so it is safe as an href. `skew` is the
 * leader's clock minus this device's (`QueueState.skew`): `pr.at` is the leader's, so ageing it
 * against this device's clock alone would grey a chip, or keep one live, by the clocks' difference.
 */
function prOf(task: Task, now: number, skew: number): QueueRow["pr"] {
  if (task.prUrl === undefined) return null;
  const { label, noun, name } = prNames(task.prUrl);
  const { pr } = task;
  const base = { url: task.prUrl, label };
  if (pr === undefined) {
    return {
      ...base,
      state: null,
      checks: null,
      stale: false,
      blocked: null,
      description: name,
      accessibleName: `Open ${noun}`,
    };
  }
  const leaderNow = now + skew;
  const checks = pr.state === "merged" ? null : (pr.checks ?? null);
  const reason = taskPrBlock(task);
  const blocked = reason === null ? null : PR_BLOCKED_LABEL[reason];
  const reading = [
    pr.state,
    ...(checks === null ? [] : [PR_CHECKS_READING[checks]]),
    ...(blocked === null ? [] : [blocked]),
    `read ${formatSeen(pr.at, leaderNow)}`,
  ];
  return {
    ...base,
    state: pr.state,
    checks,
    blocked,
    // A merge does not un-merge, so it keeps its colour however old the reading.
    stale: pr.state !== "merged" && leaderNow - pr.at > PR_STATUS_STALE_MS,
    description: [name, ...reading].join(" · "),
    accessibleName: `Open ${noun} (${reading.join(", ")})`,
  };
}

/**
 * The live session's `agent.remote` from its machine's last `sessions` read, else the task's `remoteSession` (DESIGN.md, "Tags and session identity",
 * `remoteSession` and `agent.remote`). Both passed `isRemoteSessionId` at parse (`session_` and base62 only), so they can name no other path,
 * query or origin.
 */
function sessionOf(task: Task, read: ReadSession | undefined): string | null {
  return remoteLink(read === undefined ? undefined : liveRemote(read.entry), task.remoteSession);
}

function remoteLink(...remotes: readonly (string | undefined)[]): string | null {
  const remote = remotes.find((id) => id !== undefined);
  return remote === undefined ? null : `https://claude.ai/code/${remote}`;
}

function liveRemote(entry: SessionEntry): string | undefined {
  return parseTags(entry.tags, { scope: "session" })?.["agent.remote"]?.value;
}

/** One session from its machine's last `sessions` read, its `live` read through `parseSessionLive`. */
interface ReadSession {
  readonly machine: Machine;
  readonly entry: SessionEntry;
  readonly live: SessionLive | null;
}

/** Every machine's last read, the registry's order. An asleep machine keeps its last read; an unanswered one has none. */
function readSessions(state: AppState): readonly ReadSession[] {
  return state.relay.machines.flatMap((machine) => {
    const read = state.sessions[machine.deviceId];
    // Stored as the reply carried it: a daemon a version ahead is inside the PSK boundary, but a render must not throw.
    if (read === undefined || read === "unknown" || !Array.isArray(read.sessions)) return [];
    return read.sessions.map((entry) => ({ machine, entry, live: parseSessionLive(entry.live) }));
  });
}

/** A listed task's session: the one on its assignment's machine, else any read that carries its id. */
function joinByTask(reads: readonly ReadSession[], tasks: ReadonlyMap<string, Task>): Map<string, ReadSession> {
  const joined = new Map<string, ReadSession>();
  for (const read of reads) {
    const { taskId } = read.entry;
    const task = taskId === undefined ? undefined : tasks.get(taskId);
    if (taskId === undefined || task === undefined) continue;
    const held = joined.get(taskId);
    const assigned = task.assignment?.deviceId;
    if (held === undefined || (read.machine.deviceId === assigned && held.machine.deviceId !== assigned)) {
      joined.set(taskId, read);
    }
  }
  return joined;
}

function closeOf(read: ReadSession, relayOpen: boolean): CloseTarget | null {
  const pane = read.entry.id;
  return relayOpen && read.machine.connected && pane !== undefined ? { deviceId: read.machine.deviceId, pane } : null;
}

const REASON_WORDS: Record<NeedsInputReason, string> = {
  question: "a question",
  permission: "permission",
  elicitation: "an MCP server",
};

/** A session's state line: "Waiting on you: permission since 3m ago", "Idle since 12m ago". Exported for tests. */
export function sessionStateLine(live: SessionLive | null, now: number): Timed {
  if (live === null) return ["State unknown"];
  // The daemon's clock, aged on this device's, as a tag's age is: a `sessions` reply carries no skew.
  const since = seen(live.since, now);
  if (live.state === "needs-input") {
    return timed`Waiting on you${live.reason === undefined ? "" : `: ${REASON_WORDS[live.reason]}`} since ${since}`;
  }
  return live.state === "idle" ? timed`Idle since ${since}` : timed`Working since ${since}`;
}

function depsLine(task: Task, titles: ReadonlyMap<string, string>): string | null {
  const deps = task.spec.deps ?? [];
  const [first] = deps;
  if (first === undefined) return null;
  // One word for the edges only when they agree: a mix would be wrong about some of them.
  const when = deps.every((dep) => dep.after === first.after) ? ` (${first.after})` : "";
  if (deps.length === 1) return `After ${titles.get(first.task) ?? "1 task"}${when}`;
  return `After ${deps.length} tasks${when}`;
}

function continuesLine(task: Task, titles: ReadonlyMap<string, string>): string | null {
  const earlier = task.spec.continues?.task;
  if (earlier === undefined) return null;
  return `Continues ${titles.get(earlier) ?? `task ${earlier.slice(0, 8)}`}`;
}

/** A successor-chain line, and the other task's id to reveal on tap when its card is on screen. */
export interface LineageLine {
  readonly text: string;
  readonly reveal: string | null;
}

function lineage(text: string, other: string, revealable: ReadonlySet<string>): LineageLine {
  return { text, reveal: revealable.has(other) ? other : null };
}

/** Reads only `succeeds.task` and `trigger`: an archived record's `succeeds.account` is a placeholder (A15). */
export function carriesOnLine(
  task: Task,
  titles: ReadonlyMap<string, string>,
  revealable: ReadonlySet<string>,
): LineageLine | null {
  const earlier = task.spec.succeeds?.task;
  if (earlier === undefined) return null;
  const line = `Carries on ${titles.get(earlier) ?? `task ${earlier.slice(0, 8)}`}`;
  const trigger = task.spec.succeeds?.trigger;
  const text =
    trigger === "quota"
      ? `${line} after its usage ran out`
      : trigger === "drain"
        ? `${line} after its machine closed`
        : line;
  return lineage(text, earlier, revealable);
}

export function passedToLine(
  task: Task,
  titles: ReadonlyMap<string, string>,
  revealable: ReadonlySet<string>,
): LineageLine | null {
  const next = task.successor;
  if (next === undefined) return null;
  return lineage(`Passed to ${titles.get(next) ?? `task ${next.slice(0, 8)}`}`, next, revealable);
}

/**
 * `Task.stack` in words: the predecessor's branch, or the default branch and why. Its `task` is the one holding
 * the work, after any pass, so it can differ from the dep the form named.
 */
export function stackedOnLine(
  task: Task,
  titles: ReadonlyMap<string, string>,
  revealable: ReadonlySet<string>,
): LineageLine | null {
  const { stack } = task;
  if (stack === undefined) return null;
  const name = titles.get(stack.task) ?? `task ${stack.task.slice(0, 8)}`;
  const text =
    stack.on === "branch"
      ? `Stacked on ${name}`
      : stack.on === "merged"
        ? `Started from the default branch: ${name} had merged`
        : `Started from the default branch: ${name} left nothing to stack on`;
  return lineage(text, stack.task, revealable);
}

// Live cards link nothing: the other end may sit in collapsed Asleep or in Older, which this view cannot see.
const NO_REVEAL: ReadonlySet<string> = new Set();

function continuingOf(task: Task, tasks: readonly Task[]): QueueRow["continuing"] {
  // A task whose continuation landed (`continuedBy`) is continued by whatever waits on that link, not on itself.
  const link = task.continuedBy === undefined ? undefined : tasks.find((other) => other.id === task.continuedBy?.task);
  const waiting = waitingContinuation(link ?? task, tasks);
  if (waiting !== undefined) return { text: `Continuing as ${taskTitle(waiting)} · waiting`, reveal: waiting.id };
  // Why Continue is gone from this card; the daemon's refusal, with the path, is on the refused one's.
  return goneContinuation(task, tasks) === undefined
    ? null
    : { text: "Can't continue: its worktree and its branch are gone", reveal: null };
}

function batchLine(task: Task): string | null {
  const { batch } = task.spec;
  return batch === undefined ? null : `Batch #${batch.index}`;
}

function placementLine(task: Task, state: AppState, now: number): string | null {
  const { machines } = state.relay;
  const parts = [
    pinLine(task, machines, state.accounts.aliases),
    avoidLine(task, machines),
    requiresLine(task, machines, now),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(". ");
}

function rowOf(
  task: Task,
  state: AppState,
  now: number,
  skew: number,
  titles: ReadonlyMap<string, string>,
  tasks: readonly Task[],
  ctx: PickContext,
  read: ReadSession | undefined,
): QueueRow {
  const phase = TASK_PHASES[task.state];
  const live = ctx.live.get(task.id);
  // The leader's idle line says its slot is free: kept beside a live idle, dropped where `live` says it is not idle.
  const idleRef = live === undefined || live.state === "idle" ? ctx.idle.get(task.id) : undefined;
  const actionable = phase !== "dispatching" && phase !== "finished";
  const canFollowUp = phase !== "finished";
  const context = {
    now: now + skew,
    leaderHandoff: deriveContinueHandoffAvailability(state.relay),
    leaderCodexContinue: deriveCodexContinueAvailability(state.relay),
    leaderCodexCheckpoint: deriveCodexCheckpointAvailability(state.relay),
  };
  const canContinue =
    continueOffer(task, state.relay.machines, tasks, context).ok && deriveContinueAvailability(state.relay);
  const canPass = passOffer(
    task,
    state.relay.machines,
    derivePassAvailability(state.relay),
    deriveCodexPassAvailability(state.relay),
    deriveCodexCheckpointAvailability(state.relay),
  ).ok;
  const waiting = task.state === "queued" || task.state === "blocked" || task.state === "ready";
  const item = startNowFor(task, deriveRunNowPastPause(state.relay), now + skew);
  const startNow = waiting ? { ...item, enabled: item.enabled && deriveRunNowAvailability(state.relay) } : null;
  const session = sessionOf(task, read);
  const autonomy = autonomyOf(task.spec);
  const tags = taskTagLines(task);
  const body = bodyOf(
    task,
    state.relay.machines,
    now,
    skew,
    idleRef === undefined ? undefined : { ...idleRef, since: idleRef.since - skew },
  );
  return {
    id: task.id,
    title: taskTitle(task),
    name: tags.label ?? taskTitle(task),
    headline: withoutPeriod(taskHeadline(task, state.relay.machines, state.accounts.aliases, now, now + skew)),
    // Placed in Needs you or Idle by `live` alone: the card says why it sits there.
    body: body ?? (live === undefined || live.state === "busy" ? null : sessionStateLine(live, now)),
    dot: dotOf(task),
    age: seen(task.createdAt, now),
    canCancel: actionable,
    canMarkDone: actionable,
    cancelEndsSession: phase === "placed",
    markDoneEndsSession: task.state === "running" || task.state === "needs-input" || task.state === "lost",
    canFollowUp,
    canContinue,
    canPass,
    canLabel: deriveTaskTagsAvailability(state.relay),
    label: tags.label,
    ref: tags.ref,
    startNow,
    inline: primaryAction({ canContinue }),
    inlinePrimary: canContinue && taskPrBlock(task) !== null,
    deps: depsLine(task, titles),
    continues: continuesLine(task, titles),
    carriesOn: carriesOnLine(task, titles, NO_REVEAL),
    passedTo: passedToLine(task, titles, NO_REVEAL),
    stackedOn: stackedOnLine(task, titles, NO_REVEAL),
    continuing: continuingOf(task, tasks),
    placement: placementLine(task, state, now),
    batch: batchLine(task),
    busy: state.taskAction?.taskId === task.id,
    pr: prOf(task, now, skew),
    session,
    // `needs-input` only: a `lost` task keeps `needsInputSince` too, but its machine is not there to take an answer.
    answer: task.state === "needs-input" ? session : null,
    autonomy: autonomy === DEFAULT_AUTONOMY ? null : AUTONOMY_LABELS[autonomy],
    agent: task.spec.agent === undefined ? null : AGENT_NAMES[task.spec.agent],
    flag: task.flag === undefined ? null : { label: FLAG_LABELS[task.flag.reason], note: task.flag.note ?? null },
    close: read === undefined ? null : closeOf(read, state.relay.status === "open"),
    sessionTags: read === undefined ? [] : (sessionRows([read.entry], tasks, false, now)[0]?.tags ?? []),
  };
}

/** A settling task is shown as running, whole: every reader downstream (section, headline, dot, Answer) sees one. */
function asRunning(task: Task, leaderNow: number): Task {
  if (!settlingInput(task, leaderNow)) return task;
  const { needsInputSince: _since, inputReason: _reason, inputTool: _tool, ...rest } = task;
  return { ...rest, state: "running" };
}

interface PickContext {
  readonly machines: readonly Machine[];
  /** The running tasks the leader released for sitting idle at their prompt, by id. */
  readonly idle: ReadonlyMap<string, IdleTaskRef>;
  /** A running task's session's `live`, where its awake machine's read carried one (WS4): it places the task. */
  readonly live: ReadonlyMap<string, SessionLive>;
}

type SectionPick = (task: Task, ctx: PickContext) => number | null;

/**
 * Escalated (past the leader's patience) first, then the rest of needs-input (a running task whose session says it
 * waits on you among them), then lost — a lost task whose machine is back or gone, since one asleep is in Asleep.
 */
const needsYou: SectionPick = (t, { machines, live }) => {
  if (machineAsleep(t, machines)) return null;
  if (t.state === "lost") return 2;
  if (t.state === "running") return live.get(t.id)?.state === "needs-input" ? 1 : null;
  if (t.state !== "needs-input") return null;
  return t.escalated === true ? 0 : 1;
};

/**
 * Nothing on a sleeping machine can be acted on from the phone, so it leaves Needs you and
 * Running for a section of its own (DESIGN.md, "Asleep machines on the Queue screen").
 */
const asleep: SectionPick = (t, { machines }) => {
  if (!machineAsleep(t, machines)) return null;
  if (t.state === "needs-input") return 0;
  return t.state === "lost" ? 2 : 1;
};

/** A running task's place by its session's `live` where read (WS4: idle the moment its turn ends), else the leader's idle list. */
function runningPlace(t: Task, { idle, live }: PickContext): "busy" | "idle" | "needs-input" {
  return live.get(t.id)?.state ?? (idle.has(t.id) ? "idle" : "busy");
}

/** The one section the screen renders collapsed until tapped. */
export const ASLEEP_SECTION = "Asleep";

const NEEDS_YOU_SECTION = "Needs you";
const RUNNING_SECTION = "Running";
const IDLE_SECTION = "Idle";

const SECTIONS: readonly { readonly title: string; readonly pick: SectionPick; readonly oldestFirst?: true }[] = [
  { title: NEEDS_YOU_SECTION, pick: needsYou },
  {
    title: RUNNING_SECTION,
    pick: (t, ctx) =>
      (t.state === "reserved" || (t.state === "running" && runningPlace(t, ctx) === "busy")) &&
      !machineAsleep(t, ctx.machines)
        ? 0
        : null,
  },
  // Done its turn and waiting on a reply nobody owes it, so it holds no slot (DESIGN.md, "Routing caps").
  {
    title: IDLE_SECTION,
    pick: (t, ctx) =>
      t.state === "running" && runningPlace(t, ctx) === "idle" && !machineAsleep(t, ctx.machines) ? 0 : null,
  },
  {
    title: "Waiting",
    pick: (t) => (t.state === "queued" || t.state === "blocked" || t.state === "ready" ? 0 : null),
    // FIFO, as the scheduler routes ready tasks (batch grouping and blocked tasks aside).
    oldestFirst: true,
  },
  { title: ASLEEP_SECTION, pick: asleep },
  { title: "Awaiting merge", pick: (t) => (t.state === "awaiting-merge" ? 0 : null) },
  { title: "Finished", pick: (t) => (TASK_PHASES[t.state] === "finished" ? 0 : null) },
];

/** A session row's section by its `live` (WS2): no `live` is never idle, so Running, marked unknown. */
function sessionSection(read: ReadSession): string {
  if (!read.machine.connected) return ASLEEP_SECTION;
  if (read.live?.state === "needs-input") return NEEDS_YOU_SECTION;
  return read.live?.state === "idle" ? IDLE_SECTION : RUNNING_SECTION;
}

function sessionRowOf(
  read: ReadSession,
  tasks: readonly Task[],
  relayOpen: boolean,
  now: number,
  listed: boolean,
): SessionQueueRow {
  const { machine, entry } = read;
  const renameable = relayOpen && machine.connected && machine.capabilities?.includes(CAPABILITIES.sessionTag) === true;
  // One entry in, one row out: the per-namespace view's model, kept for this surface.
  const [row] = sessionRows([entry], tasks, renameable, now);
  const tasked = entry.taskId !== undefined;
  return {
    id: sessionRowId(machine.deviceId, entry),
    deviceId: machine.deviceId,
    name: row?.name ?? entry.window,
    nameMark: row?.mark ?? null,
    tasked,
    kind: !tasked ? "Not a task" : listed ? "Another session of a task" : "Task not listed",
    where: entry.repo === null ? machine.name : `${machine.name} · ${entry.repo}`,
    state: sessionStateLine(read.live, now),
    close: closeOf(read, relayOpen),
    rename: row?.rename ?? null,
    session: remoteLink(liveRemote(entry)),
    tags: row?.tags ?? [],
  };
}

function unreadableLine(count: number): string | null {
  if (count === 0) return null;
  return `${count} unreadable ${count === 1 ? "record holds a queue slot" : "records hold queue slots"} — junk, or sealed under an earlier key`;
}

export function deriveQueue(state: AppState, now: number): QueueScreenView {
  const { text, available } = statusLine(state);
  const view = state.queueView;
  const ok = view?.kind === "ok" ? view : null;
  const skew = ok?.skew ?? 0;
  const tasks = (ok?.tasks ?? []).map((task) => asRunning(task, now + skew));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const titles = new Map(tasks.map((task) => [task.id, taskTitle(task)]));
  // Only while running: a task the reply's list outlived (settled by an action's own reply) is what it now is.
  const running = new Set(tasks.filter((t) => t.state === "running").map((t) => t.id));
  const idle = new Map((ok?.idle ?? []).filter((r) => running.has(r.taskId)).map((r) => [r.taskId, r]));

  const reads = readSessions(state);
  const joined = joinByTask(reads, byId);
  const live = new Map<string, SessionLive>();
  for (const [taskId, read] of joined) {
    if (running.has(taskId) && read.machine.connected && read.live !== null) live.set(taskId, read.live);
  }
  const ctx: PickContext = { machines: state.relay.machines, idle, live };

  const relayOpen = state.relay.status === "open";
  // A tasked session waits for a list: before one, every such session would read as a task the list leaves out.
  // One session joins a task: a second carrying the same listed id is a row of its own, so it can still be closed.
  const unjoined = reads
    .filter((read) => read.entry.taskId === undefined || (ok !== null && joined.get(read.entry.taskId) !== read))
    // Longest in its state first; no `live` last.
    .toSorted((a, b) => (a.live?.since ?? Infinity) - (b.live?.since ?? Infinity));
  const placed = new Map<string, SessionQueueRow[]>();
  for (const read of unjoined) {
    const title = sessionSection(read);
    const listed = read.entry.taskId !== undefined && byId.has(read.entry.taskId);
    placed.set(title, [...(placed.get(title) ?? []), sessionRowOf(read, tasks, relayOpen, now, listed)]);
  }

  const sections = SECTIONS.map(({ title, pick, oldestFirst }) => {
    const members = tasks
      .map((task) => ({ task, rank: pick(task, ctx) }))
      .filter((entry): entry is { task: Task; rank: number } => entry.rank !== null)
      // Stable: equal ranks keep the leader's order.
      .toSorted((a, b) => a.rank - b.rank || (oldestFirst ? a.task.createdAt - b.task.createdAt : 0));
    return {
      title,
      rows: members.map(({ task }) => rowOf(task, state, now, skew, titles, tasks, ctx, joined.get(task.id))),
      sessions: placed.get(title) ?? [],
    };
  }).filter((section) => section.rows.length + section.sessions.length > 0);

  // Once for every hold: a held account no machine reports still counts as a twin.
  const heldIds = (ok?.holds ?? []).flatMap((hold) => (hold.account === undefined ? [] : [hold.account]));
  const known = knownAccounts(state.relay.machines, heldIds);
  const holds = (ok?.holds ?? []).map((hold) => holdRow(hold, state, known, now));

  // A list already read stays up while the leader is away: the status line says it may be stale.
  // Why the task list is missing stays up beside session rows: they say nothing of whether the queue was read.
  let empty: string | null = null;
  if (tasks.length === 0) {
    if (!available) empty = text;
    else if (view === null || view.kind === "loading") empty = "Loading…";
    else if (view.kind === "failed") empty = view.message;
    else if (unjoined.length === 0) empty = "Nothing in the queue.";
  }

  // The fleet cap follows the leader's slot accounting, not `live` (WS4): a task it lists idle holds no slot, and one it
  // does not holds one even while its session reads idle. Session rows never count against it.
  const slots = tasks.filter(
    (t) =>
      (t.state === "reserved" || (t.state === "running" && !idle.has(t.id))) && !machineAsleep(t, state.relay.machines),
  ).length;
  const count = (title: string): number => sections.find((s) => s.title === title)?.rows.length ?? 0;
  const untasked = unjoined.length;

  return {
    summary:
      ok === null
        ? null
        : [
            `${slots}${ok.globalMax === undefined ? "" : `/${ok.globalMax}`} running`,
            ...(count(IDLE_SECTION) === 0 ? [] : [`${count(IDLE_SECTION)} idle`]),
            `${count("Waiting")} waiting`,
            ...(untasked === 0 ? [] : [`${untasked} ${untasked === 1 ? "session" : "sessions"}`]),
          ].join(" · "),
    limit: ok !== null && available && deriveLimitsAvailability(state.relay) ? { fleet: ok.globalMax ?? null } : null,
    limitsUnreadable: ok?.limitsUnreadable === true ? LIMITS_UNREADABLE : null,
    available,
    partial: tasks.length >= QUEUE_MAX_TASKS ? `Showing the ${QUEUE_MAX_TASKS} most relevant tasks` : null,
    holds,
    paused: (ok?.holds ?? []).some((hold) => hold.account === undefined),
    unreadable: unreadableLine(ok?.unreadable.length ?? 0),
    sections,
    empty,
    attention: needsAttention(tasks, state.relay.machines),
  };
}

export interface AfterOption {
  readonly id: string;
  readonly title: string;
  readonly headline: string;
  /** The edge the form holds on it; null when it waits on nothing here. */
  readonly when: DepAfter | null;
}

export interface AfterSheetView {
  readonly options: readonly AfterOption[];
  /** The form already holds as many edges as a task may: only removing is offered. */
  readonly full: boolean;
  /** `Done` is offered: the verified leader takes it. */
  readonly doneAvailable: boolean;
  /** Shown beneath the list: why it is short, or empty. */
  readonly note: string | null;
}

/**
 * The tasks a new one may wait on: any the leader still lists that has not failed
 * or been cancelled, since an edge on those would fail the task at once, or been
 * superseded (its successor carries the work and is listed: an edge on the dead one
 * resolves through the chain, but offering both invites picking the dead one). An edge
 * the form holds on a task the list no longer shows, or on a superseded one, stays, so it can be removed.
 */
export function deriveAfterSheet(state: AppState, now: number): AfterSheetView {
  const view = state.queueView;
  const skew = view?.kind === "ok" ? view.skew : 0;
  const tasks = (view?.kind === "ok" ? view.tasks : []).map((task) => asRunning(task, now + skew));
  const held = new Map(state.form.after.map((dep) => [dep.task, dep.after]));
  const listed = tasks
    .filter(
      (task) =>
        task.state !== "failed" && task.state !== "cancelled" && (task.state !== "superseded" || held.has(task.id)),
    )
    .map((task) => ({
      id: task.id,
      title: taskTitle(task),
      headline: plain(taskHeadline(task, state.relay.machines, state.accounts.aliases, now, now + skew)),
      when: held.get(task.id) ?? null,
    }));
  const shown = new Set(listed.map((option) => option.id));
  const strays = state.form.after
    .filter((dep) => !shown.has(dep.task))
    .map((dep) => ({
      id: dep.task,
      title: `Task ${dep.task.slice(0, 8)}`,
      headline: "No longer in the queue",
      when: dep.after,
    }));
  // Chosen first: what the form holds is what a person came to check.
  const options = [...strays, ...listed].toSorted((a, b) => Number(b.when !== null) - Number(a.when !== null));
  let note: string | null = null;
  if (listed.length === 0) {
    if (view === null || view.kind === "loading") note = "Loading the queue…";
    else if (view.kind === "failed") note = view.message;
    else note = "No task in the queue to wait on.";
  }
  return {
    options,
    full: state.form.after.length >= TASK_SPEC_LIMITS.deps,
    doneAvailable: deriveReportedOffered(state.relay),
    note,
  };
}
