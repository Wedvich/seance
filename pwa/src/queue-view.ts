import {
  autonomyOf,
  DEFAULT_AUTONOMY,
  PR_STATUS_STALE_MS,
  QUEUE_MAX_TASKS,
  TASK_PHASES,
  TASK_SPEC_LIMITS,
  continueOffer,
  knownAccounts,
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
} from "@seance/shared";
import { machineAsleep, needsAttention } from "./asleep.ts";
import {
  avoidLine,
  decisionStartNowItem,
  inputWait,
  pinLine,
  requiresLine,
  taskHeadline,
  waitingText,
  type StartNowItem,
} from "./decision-view.ts";
import { settlingInput } from "./input-debounce.ts";
import { accountDisplayName, formatUntil } from "./machines-view.ts";
import { AUTONOMY_LABELS } from "./state.ts";
import { taskTitle } from "./task-title.ts";
import {
  deriveContinueAvailability,
  deriveContinueHandoffAvailability,
  derivePassAvailability,
  deriveReportedOffered,
  deriveRunNowAvailability,
  failedBody,
  formatSeen,
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

export type ArmOp = "cancel" | "mark-done" | "pass";

/** Names the act and the row, so one item's tap can't arm another's. */
export function armKey(op: ArmOp, rowId: string): string {
  return `${op}:${rowId}`;
}

/**
 * An act that ends a session asks twice: a first tap only arms (`fire` false, and the menu stays
 * open to relabel), a second within the arm window fires. `armed` is what the screen holds next.
 */
export function armTap(
  row: Pick<QueueRow, "id" | "cancelEndsSession" | "markDoneEndsSession">,
  op: ArmOp,
  armed: string | null,
): { readonly fire: boolean; readonly armed: string | null } {
  const key = armKey(op, row.id);
  // A pass always ends the session it passes on, and is only offered while one is live.
  const endsSession = op === "pass" || (op === "cancel" ? row.cancelEndsSession : row.markDoneEndsSession);
  if (endsSession && armed !== key) return { fire: false, armed: key };
  return { fire: true, armed: null };
}

/** A row's menu closing, by any means, disarms that row's acts; Clear's arm and other rows' stay. */
export function disarmRow(rowId: string, armed: string | null): string | null {
  const own = [armKey("cancel", rowId), armKey("mark-done", rowId), armKey("pass", rowId)];
  return armed !== null && own.includes(armed) ? null : armed;
}

export interface QueueRow {
  readonly id: string;
  readonly title: string;
  readonly headline: string;
  readonly body: string | null;
  readonly dot: QueueDot | null;
  readonly age: string;
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
  /** A continuation of it still in the queue, one line naming it, and its row's id to reveal on tap; null for any other task. */
  readonly continuing: { readonly id: string; readonly text: string } | null;
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
  /**
   * The custodian's flag on the task: a fixed label for its reason, and the note it wrote. Display-only: the note is
   * model-written from pane text, shown as text and never used to act, sort or section. Null when it has none.
   */
  readonly flag: { readonly label: string; readonly note: string | null } | null;
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
}

export interface HoldRow {
  readonly key: string;
  readonly text: string;
  readonly account?: string;
}

export interface QueueScreenView {
  /** The header's meta line, "2/8 running · 1 waiting"; null until a list has been read. */
  readonly summary: string | null;
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

function holdText(hold: PauseHold, state: AppState, known: readonly KnownAccount[], now: number): string {
  if (hold.account === undefined) return "The whole queue is paused until resumed";
  const who = accountDisplayName(known, hold.account, state.accounts.aliases);
  if (hold.until === "resume") return `${who} is paused until resumed`;
  // `formatUntil` reads "resets in 3h"; inside this sentence the verb is already said.
  const when = hold.resumeAt === undefined ? "" : ` (${formatUntil(hold.resumeAt, now).replace(/^resets /u, "")})`;
  return `${who} is paused until its quota resets${when}`;
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
function startNowFor(task: Task): StartNowItem {
  if (task.state === "blocked") return { sub: "Waiting on the tasks it depends on", enabled: false };
  if (task.state === "queued") return { sub: "Waiting for the scheduler", enabled: false };
  return decisionStartNowItem(task.decision ?? null);
}

/** `idleSince`, on this device's clock, is set only for a task the leader released idle. */
function bodyOf(
  task: Task,
  machines: readonly Machine[],
  now: number,
  skew: number,
  idleSince?: number,
): string | null {
  // The leader's `lost` is the sleep itself: waking settles it, and giving up is all the phone can do.
  if (task.state === "lost" && machineAsleep(task, machines)) {
    return "Settles when its machine wakes; cancel or mark done to give up on it";
  }
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
      : `${clause} since ${formatSeen(task.needsInputSince - skew, now)}`;
  }
  if (idleSince !== undefined) return `Idle at its prompt since ${formatSeen(idleSince, now)} — its slot is free`;
  return null;
}

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
    ...(checks === null ? [] : [`checks ${checks}`]),
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
 * `remoteSession` passed `isRemoteSessionId` at parse (`session_` and base62 only), so it can
 * name no other path, query or origin.
 */
function sessionOf(task: Task): string | null {
  return task.remoteSession === undefined ? null : `https://claude.ai/code/${task.remoteSession}`;
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

// Live cards link nothing: the other end may sit in collapsed Asleep or in Older, which this view cannot see.
const NO_REVEAL: ReadonlySet<string> = new Set();

function continuingOf(task: Task, tasks: readonly Task[]): QueueRow["continuing"] {
  // A task whose continuation landed (`continuedBy`) is continued by whatever waits on that link, not on itself.
  const link = task.continuedBy === undefined ? undefined : tasks.find((other) => other.id === task.continuedBy?.task);
  const waiting = waitingContinuation(link ?? task, tasks);
  return waiting === undefined ? null : { id: waiting.id, text: `Continuing as ${taskTitle(waiting)} · waiting` };
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
  idle: ReadonlyMap<string, number>,
): QueueRow {
  const phase = TASK_PHASES[task.state];
  const idleSince = idle.get(task.id);
  const actionable = phase !== "dispatching" && phase !== "finished";
  const canFollowUp = phase !== "finished";
  const context = { now: now + skew, leaderHandoff: deriveContinueHandoffAvailability(state.relay) };
  const canContinue =
    continueOffer(task, state.relay.machines, tasks, context).ok && deriveContinueAvailability(state.relay);
  const canPass = passOffer(task, state.relay.machines, derivePassAvailability(state.relay)).ok;
  const waiting = task.state === "queued" || task.state === "blocked" || task.state === "ready";
  const item = startNowFor(task);
  const startNow = waiting ? { ...item, enabled: item.enabled && deriveRunNowAvailability(state.relay) } : null;
  const session = sessionOf(task);
  const autonomy = autonomyOf(task.spec);
  return {
    id: task.id,
    title: taskTitle(task),
    headline: taskHeadline(task, state.relay.machines, now),
    body: bodyOf(task, state.relay.machines, now, skew, idleSince === undefined ? undefined : idleSince - skew),
    dot: dotOf(task),
    age: formatSeen(task.createdAt, now),
    canCancel: actionable,
    canMarkDone: actionable,
    cancelEndsSession: phase === "placed",
    markDoneEndsSession: task.state === "running" || task.state === "needs-input" || task.state === "lost",
    canFollowUp,
    canContinue,
    canPass,
    startNow,
    inline: primaryAction({ canContinue }),
    inlinePrimary: canContinue && taskPrBlock(task) !== null,
    deps: depsLine(task, titles),
    continues: continuesLine(task, titles),
    carriesOn: carriesOnLine(task, titles, NO_REVEAL),
    passedTo: passedToLine(task, titles, NO_REVEAL),
    continuing: continuingOf(task, tasks),
    placement: placementLine(task, state, now),
    batch: batchLine(task),
    busy: state.taskAction?.taskId === task.id,
    pr: prOf(task, now, skew),
    session,
    // `needs-input` only: a `lost` task keeps `needsInputSince` too, but its machine is not there to take an answer.
    answer: task.state === "needs-input" ? session : null,
    autonomy: autonomy === DEFAULT_AUTONOMY ? null : AUTONOMY_LABELS[autonomy],
    flag: task.flag === undefined ? null : { label: FLAG_LABELS[task.flag.reason], note: task.flag.note ?? null },
  };
}

/** A settling task is shown as running, whole: every reader downstream (section, headline, dot, Answer) sees one. */
function asRunning(task: Task, leaderNow: number): Task {
  if (!settlingInput(task, leaderNow)) return task;
  const { needsInputSince: _since, inputReason: _reason, inputTool: _tool, ...rest } = task;
  return { ...rest, state: "running" };
}

/** `idle`: the running tasks the leader released for sitting idle at their prompt, by id. */
type SectionPick = (task: Task, machines: readonly Machine[], idle: ReadonlyMap<string, number>) => number | null;

/**
 * Escalated (past the leader's patience) first, then the rest of needs-input, then lost — a
 * lost task whose machine is back or gone, since one asleep is in Asleep.
 */
const needsYou: SectionPick = (t, machines) => {
  if (machineAsleep(t, machines)) return null;
  if (t.state === "lost") return 2;
  if (t.state !== "needs-input") return null;
  return t.escalated === true ? 0 : 1;
};

/**
 * Nothing on a sleeping machine can be acted on from the phone, so it leaves Needs you and
 * Running for a section of its own (DESIGN.md, "Asleep machines on the Queue screen").
 */
const asleep: SectionPick = (t, machines) => {
  if (!machineAsleep(t, machines)) return null;
  if (t.state === "needs-input") return 0;
  return t.state === "lost" ? 2 : 1;
};

/** The one section the screen renders collapsed until tapped. */
export const ASLEEP_SECTION = "Asleep";

const IDLE_SECTION = "Idle";

const SECTIONS: readonly { readonly title: string; readonly pick: SectionPick; readonly oldestFirst?: true }[] = [
  { title: "Needs you", pick: needsYou },
  {
    title: "Running",
    pick: (t, machines, idle) =>
      (t.state === "reserved" || t.state === "running") && !idle.has(t.id) && !machineAsleep(t, machines) ? 0 : null,
  },
  // Done its turn and waiting on a reply nobody owes it, so it holds no slot (DESIGN.md, "Routing caps").
  { title: IDLE_SECTION, pick: (t, machines, idle) => (idle.has(t.id) && !machineAsleep(t, machines) ? 0 : null) },
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
  const titles = new Map(tasks.map((task) => [task.id, taskTitle(task)]));
  // Only while running: a task the reply's list outlived (settled by an action's own reply) is what it now is.
  const running = new Set(tasks.filter((t) => t.state === "running").map((t) => t.id));
  const idle = new Map((ok?.idle ?? []).filter((r) => running.has(r.taskId)).map((r) => [r.taskId, r.since]));

  const sections = SECTIONS.map(({ title, pick, oldestFirst }) => {
    const members = tasks
      .map((task) => ({ task, rank: pick(task, state.relay.machines, idle) }))
      .filter((entry): entry is { task: Task; rank: number } => entry.rank !== null)
      // Stable: equal ranks keep the leader's order.
      .toSorted((a, b) => a.rank - b.rank || (oldestFirst ? a.task.createdAt - b.task.createdAt : 0));
    return { title, rows: members.map(({ task }) => rowOf(task, state, now, skew, titles, tasks, idle)) };
  }).filter((section) => section.rows.length > 0);

  // Once for every hold: a held account no machine reports still counts as a twin.
  const heldIds = (ok?.holds ?? []).flatMap((hold) => (hold.account === undefined ? [] : [hold.account]));
  const known = knownAccounts(state.relay.machines, heldIds);
  const holds = (ok?.holds ?? []).map((hold) => holdRow(hold, state, known, now));

  // A list already read stays up while the leader is away: the status line says it may be stale.
  let empty: string | null = null;
  if (tasks.length === 0) {
    if (!available) empty = text;
    else if (view === null || view.kind === "loading") empty = "Loading…";
    else if (view.kind === "failed") empty = view.message;
    else empty = "Nothing in the queue.";
  }

  const count = (title: string): number => sections.find((s) => s.title === title)?.rows.length ?? 0;

  return {
    summary:
      ok === null
        ? null
        : [
            `${count("Running")}${ok.globalMax === undefined ? "" : `/${ok.globalMax}`} running`,
            ...(count(IDLE_SECTION) === 0 ? [] : [`${count(IDLE_SECTION)} idle`]),
            `${count("Waiting")} waiting`,
          ].join(" · "),
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
  const tasks = (view?.kind === "ok" ? view.tasks : []).map((task) =>
    asRunning(task, now + (view?.kind === "ok" ? view.skew : 0)),
  );
  const held = new Map(state.form.after.map((dep) => [dep.task, dep.after]));
  const listed = tasks
    .filter(
      (task) =>
        task.state !== "failed" && task.state !== "cancelled" && (task.state !== "superseded" || held.has(task.id)),
    )
    .map((task) => ({
      id: task.id,
      title: taskTitle(task),
      headline: taskHeadline(task, state.relay.machines, now),
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
