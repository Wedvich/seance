import {
  PR_STATUS_STALE_MS,
  QUEUE_MAX_TASKS,
  TASK_PHASES,
  TASK_SPEC_LIMITS,
  continueOffer,
  knownAccounts,
  type DepAfter,
  type KnownAccount,
  type Machine,
  type PauseHold,
  type PrChecks,
  type PrState,
  type Task,
} from "@seance/shared";
import { machineAsleep, needsAttention } from "./asleep.ts";
import { avoidLine, heldByCapsAlone, pinLine, taskHeadline, waitingText } from "./decision-view.ts";
import { accountDisplayName, formatUntil } from "./machines-view.ts";
import {
  deriveContinueAvailability,
  deriveReportedAvailability,
  deriveRunNowAvailability,
  failedBody,
  formatSeen,
  originLabel,
  type AppState,
} from "./view.ts";

/**
 * The Queue screen as data: sections, rows and the hold lines, derived in one
 * pure pass like `deriveView`, so what a row says and may do is testable
 * without a DOM.
 */

export type QueueDot = "ok" | "auto" | "err";

/** The one action a card shows inline; the rest sit behind its ⋯ menu. */
export type QueueInlineAction = "continue" | "run-now" | "follow-up";

/**
 * The likeliest next step. Continue and Follow up never coexist (Follow up is not offered after a
 * failure or a cancel, the only states Continue is); a `ready` task the caps alone hold also offers
 * Follow up, but placing it is the pressing step. Mark done and Cancel are never inline.
 */
export function primaryAction(
  row: Pick<QueueRow, "canContinue" | "canRunNow" | "canFollowUp">,
): QueueInlineAction | null {
  if (row.canContinue) return "continue";
  if (row.canRunNow) return "run-now";
  if (row.canFollowUp) return "follow-up";
  return null;
}

export type ArmOp = "cancel" | "mark-done";

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
  const endsSession = op === "cancel" ? row.cancelEndsSession : row.markDoneEndsSession;
  if (endsSession && armed !== key) return { fire: false, armed: key };
  return { fire: true, armed: null };
}

/** A row's menu closing, by any means, disarms that row's acts; Clear's arm and other rows' stay. */
export function disarmRow(rowId: string, armed: string | null): string | null {
  return armed === armKey("cancel", rowId) || armed === armKey("mark-done", rowId) ? null : armed;
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
  /** Offered while the task can still be waited on, or finished done: "Follow up" prefills the form's After. */
  readonly canFollowUp: boolean;
  /**
   * A failed or cancelled session that can be picked up where it stopped: its machine is present and
   * advertises it, the leader does too, and no continuation of it is already live or settled.
   */
  readonly canContinue: boolean;
  /** A `ready` task only the concurrency caps hold: "Run now" places it past them. */
  readonly canRunNow: boolean;
  /** `primaryAction` of the flags above: the card's one inline button. */
  readonly inline: QueueInlineAction | null;
  /** What it waits on, one line; null when it waits on nothing. */
  readonly deps: string | null;
  /** The earlier session it continues, one line; null for any other task. */
  readonly continues: string | null;
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
    /** The chip's `title`: the PR, what the leader read of it, and how long ago. */
    readonly description: string;
    /** The chip's accessible name: what following it does, then the same reading. */
    readonly accessibleName: string;
  } | null;
  /** Its session's claude.ai page, which the title links to; null until its machine reported a Remote Control id. */
  readonly session: string | null;
}

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
  /** The header's meta line, "2 running · 1 waiting"; null until a list has been read. */
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

/** The window `daemon/src/spawn.ts` names a spawn with no title or prompt (`session`, `session-<n>`): says nothing about the task. */
const NO_SLUG_WINDOW = /^session(?:-\d+)?$/u;

/** How a task is named wherever it is listed: its title, its prompt's first line, its window, else its repo. */
export function taskTitle(task: Task): string {
  const { spec } = task;
  if (spec.title !== undefined && spec.title !== "") return spec.title;
  const first = spec.prompt
    ?.split("\n")
    .find((l) => l.trim() !== "")
    ?.trim();
  if (first !== undefined) return first.length > 80 ? `${first.slice(0, 79)}…` : first;
  const session = task.assignment?.window;
  if (session !== undefined && !NO_SLUG_WINDOW.test(session)) return session;
  return originLabel(spec.repo);
}

function dotOf(task: Task): QueueDot | null {
  if (task.state === "failed" || task.escalated === true) return "err";
  const phase = TASK_PHASES[task.state];
  if (phase === "placed") return "ok";
  if (phase === "waiting" || phase === "dispatching") return "auto";
  return null;
}

/** `idleSince`, on this device's clock, is set only for a task the leader released idle. */
function bodyOf(task: Task, machines: readonly Machine[], now: number, idleSince?: number): string | null {
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
    return task.needsInputSince === undefined
      ? "Waiting for input"
      : `Waiting for input since ${formatSeen(task.needsInputSince, now)}`;
  }
  if (idleSince !== undefined) return `Idle at its prompt since ${formatSeen(idleSince, now)} — its slot is free`;
  return null;
}

/** GitHub's `/pull/<n>`, GitLab's `/-/merge_requests/<n>`. */
const PR_NUMBER = /\/(?:pull|merge_requests)\/(\d+)(?:\/|$)/u;

/**
 * `prUrl` is `https:`-checked at parse (`httpsUrl`), so it is safe as an href. `skew` is the
 * leader's clock minus this device's (`QueueState.skew`): `pr.at` is the leader's, so ageing it
 * against this device's clock alone would grey a chip, or keep one live, by the clocks' difference.
 */
function prOf(task: Task, now: number, skew: number): QueueRow["pr"] {
  if (task.prUrl === undefined) return null;
  const number = PR_NUMBER.exec(new URL(task.prUrl).pathname)?.[1];
  const label = number === undefined ? "PR" : `#${number}`;
  const noun = number === undefined ? "pull request" : `pull request #${number}`;
  const name = `${noun.slice(0, 1).toUpperCase()}${noun.slice(1)}`;
  const { pr } = task;
  const base = { url: task.prUrl, label };
  if (pr === undefined) {
    return { ...base, state: null, checks: null, stale: false, description: name, accessibleName: `Open ${noun}` };
  }
  const leaderNow = now + skew;
  const checks = pr.state === "merged" ? null : (pr.checks ?? null);
  const reading = [pr.state, ...(checks === null ? [] : [`checks ${checks}`]), `read ${formatSeen(pr.at, leaderNow)}`];
  return {
    ...base,
    state: pr.state,
    checks,
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

function batchLine(task: Task): string | null {
  const { batch } = task.spec;
  return batch === undefined ? null : `Batch #${batch.index}`;
}

function placementLine(task: Task, state: AppState): string | null {
  const { machines } = state.relay;
  const parts = [pinLine(task, machines, state.accounts.aliases), avoidLine(task, machines)].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : parts.join(". ");
}

/**
 * Some candidate of its latest decision was turned down for `cap_reached` and nothing else. The
 * leader routes again on the tap, so a decision gone stale costs a refusal, never a wrong placement.
 */
function heldByCapsOnly(task: Task): boolean {
  const { decision } = task;
  if (task.state !== "ready" || decision === undefined || decision.chosen !== null) return false;
  return decision.candidates.some(heldByCapsAlone);
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
  const canFollowUp = phase !== "finished" || task.state === "done";
  const canContinue = continueOffer(task, state.relay.machines, tasks).ok && deriveContinueAvailability(state.relay);
  const canRunNow = heldByCapsOnly(task) && deriveRunNowAvailability(state.relay);
  return {
    id: task.id,
    title: taskTitle(task),
    headline: taskHeadline(task, state.relay.machines, now),
    body: bodyOf(task, state.relay.machines, now, idleSince === undefined ? undefined : idleSince - skew),
    dot: dotOf(task),
    age: formatSeen(task.createdAt, now),
    canCancel: actionable,
    canMarkDone: actionable,
    cancelEndsSession: phase === "placed",
    markDoneEndsSession: task.state === "running" || task.state === "needs-input" || task.state === "lost",
    canFollowUp,
    canContinue,
    canRunNow,
    inline: primaryAction({ canContinue, canRunNow, canFollowUp }),
    deps: depsLine(task, titles),
    continues: continuesLine(task, titles),
    placement: placementLine(task, state),
    batch: batchLine(task),
    busy: state.taskAction?.taskId === task.id,
    pr: prOf(task, now, skew),
    session: sessionOf(task),
  };
}

/** `idle`: the running tasks the leader released for sitting idle at their prompt, by id. */
type Pick = (task: Task, machines: readonly Machine[], idle: ReadonlyMap<string, number>) => number | null;

/**
 * Escalated (past the leader's patience) first, then the rest of needs-input, then lost — a
 * lost task whose machine is back or gone, since one asleep is in Asleep.
 */
const needsYou: Pick = (t, machines) => {
  if (machineAsleep(t, machines)) return null;
  if (t.state === "lost") return 2;
  if (t.state !== "needs-input") return null;
  return t.escalated === true ? 0 : 1;
};

/**
 * Nothing on a sleeping machine can be acted on from the phone, so it leaves Needs you and
 * Running for a section of its own (DESIGN.md, "Asleep machines on the Queue screen").
 */
const asleep: Pick = (t, machines) => {
  if (!machineAsleep(t, machines)) return null;
  if (t.state === "needs-input") return 0;
  return t.state === "lost" ? 2 : 1;
};

/** The one section the screen renders collapsed until tapped. */
export const ASLEEP_SECTION = "Asleep";

const IDLE_SECTION = "Idle";

const SECTIONS: readonly { readonly title: string; readonly pick: Pick; readonly oldestFirst?: true }[] = [
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
  const tasks = ok?.tasks ?? [];
  const titles = new Map(tasks.map((task) => [task.id, taskTitle(task)]));
  const skew = ok?.skew ?? 0;
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
            `${count("Running")} running`,
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
 * or been cancelled, since an edge on those would fail the task at once. An edge
 * the form holds on a task the list no longer shows stays, by id, so it can be removed.
 */
export function deriveAfterSheet(state: AppState, now: number): AfterSheetView {
  const view = state.queueView;
  const tasks = view?.kind === "ok" ? view.tasks : [];
  const held = new Map(state.form.after.map((dep) => [dep.task, dep.after]));
  const listed = tasks
    .filter((task) => task.state !== "failed" && task.state !== "cancelled")
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
    doneAvailable: deriveReportedAvailability(state.relay),
    note,
  };
}
