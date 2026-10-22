import { QUEUE_MAX_TASKS, TASK_PHASES, type PauseHold, type Task } from "@seance/shared";
import { taskHeadline } from "./decision-view.ts";
import { accountDisplayName, formatUntil } from "./machines-view.ts";
import { failedBody, formatSeen, originLabel, type AppState } from "./view.ts";

/**
 * The Queue screen as data: sections, rows and the hold lines, derived in one
 * pure pass like `deriveView`, so what a row says and may do is testable
 * without a DOM.
 */

export type QueueDot = "ok" | "auto" | "err";

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
  readonly busy: boolean;
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

function holdText(hold: PauseHold, state: AppState, now: number): string {
  if (hold.account === undefined) return "The whole queue is paused until resumed";
  const who = accountDisplayName(state.relay.machines, hold.account);
  if (hold.until === "resume") return `${who} is paused until resumed`;
  // `formatUntil` reads "resets in 3h"; inside this sentence the verb is already said.
  const when = hold.resumeAt === undefined ? "" : ` (${formatUntil(hold.resumeAt, now).replace(/^resets /u, "")})`;
  return `${who} is paused until its quota resets${when}`;
}

function holdRow(hold: PauseHold, state: AppState, now: number): HoldRow {
  return {
    key: hold.account ?? "queue",
    text: holdText(hold, state, now),
    ...(hold.account === undefined ? {} : { account: hold.account }),
  };
}

/** The window `daemon/src/spawn.ts` names a spawn with no title or prompt (`session`, `session-<n>`): says nothing about the task. */
const NO_SLUG_WINDOW = /^session(?:-\d+)?$/u;

function titleOf(task: Task): string {
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

function bodyOf(task: Task, now: number): string | null {
  if (task.state === "failed") return failedBody(task.failure?.code);
  if (task.state === "needs-input" && task.escalated === true) {
    return task.needsInputSince === undefined
      ? "Waiting for input"
      : `Waiting for input since ${formatSeen(task.needsInputSince, now)}`;
  }
  return null;
}

function rowOf(task: Task, state: AppState, now: number): QueueRow {
  const phase = TASK_PHASES[task.state];
  const actionable = phase !== "dispatching" && phase !== "finished";
  return {
    id: task.id,
    title: titleOf(task),
    headline: taskHeadline(task, state.relay.machines, now),
    body: bodyOf(task, now),
    dot: dotOf(task),
    age: formatSeen(task.createdAt, now),
    canCancel: actionable,
    canMarkDone: actionable,
    cancelEndsSession: phase === "placed",
    markDoneEndsSession: task.state === "running" || task.state === "needs-input" || task.state === "lost",
    busy: state.taskAction?.taskId === task.id,
  };
}

const SECTIONS: readonly { readonly title: string; readonly pick: (task: Task) => number | null }[] = [
  {
    title: "Needs you",
    // Escalated first: those have waited past the leader's patience.
    pick: (t) => (t.state === "needs-input" ? (t.escalated === true ? 0 : 1) : t.state === "lost" ? 2 : null),
  },
  { title: "Running", pick: (t) => (t.state === "reserved" || t.state === "running" ? 0 : null) },
  { title: "Waiting", pick: (t) => (t.state === "queued" || t.state === "blocked" || t.state === "ready" ? 0 : null) },
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

  const sections = SECTIONS.map(({ title, pick }) => {
    const members = tasks
      .map((task) => ({ task, rank: pick(task) }))
      .filter((entry): entry is { task: Task; rank: number } => entry.rank !== null)
      // Stable: equal ranks keep the leader's order.
      .toSorted((a, b) => a.rank - b.rank);
    return { title, rows: members.map(({ task }) => rowOf(task, state, now)) };
  }).filter((section) => section.rows.length > 0);

  const holds = (ok?.holds ?? []).map((hold) => holdRow(hold, state, now));

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
    summary: ok === null ? null : `${count("Running")} running · ${count("Waiting")} waiting`,
    available,
    partial: tasks.length >= QUEUE_MAX_TASKS ? `Showing the ${QUEUE_MAX_TASKS} most relevant tasks` : null,
    holds,
    paused: (ok?.holds ?? []).some((hold) => hold.account === undefined),
    unreadable: unreadableLine(ok?.unreadable.length ?? 0),
    sections,
    empty,
    attention: tasks.some((t) => t.state === "needs-input" && t.escalated === true),
  };
}
