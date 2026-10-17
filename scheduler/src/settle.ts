import {
  isTransportError,
  REPLAY_WINDOW_MS,
  TARGET_LIMITS,
  TASK_FAILURE_LIMITS,
  type TaskFailureCode,
} from "@seance/shared";
import { UNDELIVERED, UNREACHABLE, type TaskSessionsReply, type TaskSpawnReply } from "./ports.ts";
import {
  advance,
  isUnconfirmed,
  PLACED,
  type Assignment,
  type Reservation,
  type Target,
  type Task,
  type TaskState,
} from "./task.ts";

/**
 * How one observation moves one task: a spawn's verdict, a session event, a
 * machine's `sessions` answer. Pure functions of the task and what was seen —
 * the scheduler decides when each runs and writes what it returns; null leaves
 * the task as it is.
 */

type SessionsAnswer = Extract<TaskSessionsReply, { readonly ok: true }>;

/**
 * Who reported a session event: the machine that sealed it (the envelope's
 * AAD-bound `from`) and the pane its daemon bound the event to.
 */
export interface SessionSource {
  readonly deviceId: string;
  readonly pane: string;
}

/** What a settle reads besides the task and the machine's answer. */
export interface Observed {
  readonly now: number;
  /** Whether the task's machine is connected now. */
  readonly connected: boolean;
  readonly reservationTtlMs: number;
}

function targetOf(at: Target): Target {
  return { deviceId: at.deviceId, exclave: at.exclave, clone: at.clone };
}

/** An assignment on `target` at a session's window and pane, or what a reply names of them. */
function assignmentOf(
  target: Target,
  at: { readonly window?: string | undefined; readonly id?: string | undefined },
): Assignment {
  return {
    ...targetOf(target),
    // Cut to what a reader accepts: the daemon names the window, and a record holding a longer one would not read.
    ...(at.window === undefined ? {} : { window: at.window.slice(0, TARGET_LIMITS.window) }),
    ...(at.id === undefined ? {} : { pane: at.id }),
  };
}

export function deviceOf(task: Task): string | undefined {
  return (task.reservation ?? task.assignment)?.deviceId;
}

/** Still reserved under exactly `at`: not resolved by an event, nor released and reserved again. */
export function holds(task: Task, at: Reservation): boolean {
  const { reservation } = task;
  return (
    task.state === "reserved" &&
    reservation !== undefined &&
    reservation.deviceId === at.deviceId &&
    reservation.expiresAt === at.expiresAt
  );
}

/** Where `seen` was when its machine was asked: a `sessions` answer speaks for that, and only that. */
export function asSeen(current: Task, seen: Task): boolean {
  if (seen.state === "reserved") return seen.reservation !== undefined && holds(current, seen.reservation);
  return (
    PLACED.includes(current.state) &&
    PLACED.includes(seen.state) &&
    current.assignment?.deviceId === seen.assignment?.deviceId
  );
}

export function sessionChange(task: Task, to: TaskState, from: SessionSource | undefined): Task | null {
  if (task.state === to) return null;
  if (task.state === "reserved") {
    const at = task.reservation;
    if (at === undefined || from === undefined || from.deviceId !== at.deviceId) return null;
    return advance(task, to, { assignment: assignmentOf(at, { id: from.pane }) });
  }
  // A lost task's machine speaking for it is the proof `lost` waits for.
  if (!PLACED.includes(task.state)) return null;
  // Never confirmed, it is a reservation still: only its own machine, named, may resolve it.
  if (isUnconfirmed(task) && from === undefined) return null;
  const { assignment } = task;
  if (from !== undefined && assignment !== undefined && from.deviceId !== assignment.deviceId) return null;
  // An assignment with no pane (never confirmed, or a `task_running` verdict) takes the event's.
  const named = assignment !== undefined && assignment.pane === undefined && from !== undefined;
  return advance(task, to, named ? { assignment: { ...assignment, pane: from.pane } } : {});
}

/** A reserved or placed task against its machine's `sessions`; null leaves it as it is. */
export function settle(task: Task, reply: TaskSessionsReply, at: Observed): Task | null {
  if (task.state === "reserved") return settleReserved(task, reply, at);
  if (!PLACED.includes(task.state) || !reply.ok) return null;
  return settlePlaced(task, reply);
}

/**
 * Before its TTL only a session carrying the task id, or the id in `ended`,
 * resolves a reservation; anything else is a spawn still on its way. Past it
 * the machine's answer settles it (`settleUnconfirmed`). An unanswered check
 * keeps waiting while the machine is connected; once it is not, the task is
 * `lost` on that machine — never released to `ready` on a silence, since a
 * machine that only sleeps may wake still running it, and `task_running`
 * guards only a re-dispatch to that same machine.
 */
function settleReserved(task: Task, reply: TaskSessionsReply, at: Observed): Task | null {
  const { reservation } = task;
  if (reservation === undefined) return null;
  const expired = reservation.expiresAt <= at.now;
  const target = targetOf(reservation);
  if (!reply.ok) {
    if (!expired || at.connected) return null;
    const reservedAt = task.reservedAt ?? reservation.expiresAt - at.reservationTtlMs;
    return advance(task, "lost", { assignment: target, absentSince: at.now, reservedAt });
  }
  const known = reply.sessions.some((s) => s.taskId === task.id) || reply.ended?.includes(task.id) === true;
  if (!known && !expired) return null;
  return settleUnconfirmed(task, target, reply);
}

/**
 * A placed task against its machine's own `sessions`: a session carrying its
 * id is the task still running (a `lost` one runs again, on the pane listed
 * now); none is a session that ended while nobody listened — `done`, whether
 * or not `ended` still remembers it. A `lost` task never confirmed is not
 * placed but a reservation its machine kept, and settles as one.
 */
function settlePlaced(task: Task, reply: SessionsAnswer): Task | null {
  const { assignment } = task;
  if (isUnconfirmed(task) && assignment !== undefined) return settleUnconfirmed(task, assignment, reply);
  const session = reply.sessions.find((s) => s.taskId === task.id);
  if (session === undefined) return advance(task, "done");
  if (task.state !== "lost" || assignment === undefined) return null;
  return advance(task, "running", { assignment: assignmentOf(assignment, session) });
}

/**
 * A spawn whose reply never came, against its machine's answer. A session
 * carrying the task id is the spawn that landed. An id in `ended` landed and
 * already finished: `done`, never re-routed — its reply and its `ended` event
 * were both lost and its session is gone, so `task_running` could not catch
 * a second spawn. With neither, the task goes back to `ready` only on the
 * machine's proof (`provesNeverLanded`); without it, `failed` — a terminal
 * state that says what is unknown, where a re-dispatch could start a twin.
 */
function settleUnconfirmed(task: Task, target: Target, reply: SessionsAnswer): Task {
  const session = reply.sessions.find((s) => s.taskId === task.id);
  if (session !== undefined) return advance(task, "running", { assignment: assignmentOf(target, session) });
  if (reply.ended?.includes(task.id) === true) return advance(task, "done", { assignment: targetOf(target) });
  if (provesNeverLanded(reply, task.reservedAt)) return advance(task, "ready");
  const why =
    reply.ledgerSince === undefined
      ? "its machine keeps no launch ledger"
      : "its machine's launch ledger no longer reaches back to the reservation";
  const failure: { readonly code: TaskFailureCode; readonly message: string } = {
    code: "dispatch_unconfirmed",
    message: `the spawn was never confirmed and ${why}, so it may have started — not dispatched again`,
  };
  return advance(task, "failed", { assignment: targetOf(target), failure });
}

/**
 * The machine's ledger was complete before the reservation was made, so a spawn
 * for it would be in `ended` or live: in neither, it never landed. The two
 * stamps are different clocks — `ledgerSince` the daemon's, `reservedAt` the
 * leader's — so the ledger must predate the reservation by the skew the replay
 * window already tolerates: a daemon behind by more refuses every envelope from
 * this leader as from the future, spawns included.
 */
function provesNeverLanded(reply: SessionsAnswer, reservedAt: number | undefined): boolean {
  if (reply.ledgerSince === undefined || reservedAt === undefined) return false;
  return reply.ledgerSince + REPLAY_WINDOW_MS <= reservedAt;
}

/**
 * One spawn resolves its reservation exactly once, with no second spawn:
 * started or already running → `running`; never delivered → `ready`, to be
 * routed afresh, since nothing can have run; a daemon refusal → `failed`; no
 * answer, or a transport error that may have come after the spawn ran → stay
 * reserved until the TTL check reads `sessions`.
 */
export function verdict(task: Task, at: Reservation, reply: TaskSpawnReply): Task | null {
  if (reply.ok) {
    // Path alone is ambiguous: every `here` session in a clone shares it.
    const pane = reply.sessions.find((s) => s.path === reply.path && s.window === reply.window)?.id;
    return advance(task, "running", { assignment: assignmentOf(at, { window: reply.window, id: pane }) });
  }
  if (reply.code === "task_running") {
    return advance(task, "running", { assignment: assignmentOf(at, { id: "id" in reply ? reply.id : undefined }) });
  }
  if (reply.code === UNDELIVERED) return advance(task, "ready");
  if (reply.code === UNREACHABLE || isTransportError(reply.code)) return null;
  // A daemon's message can carry a whole stderr; the record keeps a line of it.
  const failure = { code: reply.code, message: reply.message.slice(0, TASK_FAILURE_LIMITS.message) };
  return advance(task, "failed", { failure });
}
