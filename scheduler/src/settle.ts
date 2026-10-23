import {
  isTransportError,
  REPLAY_WINDOW_MS,
  TARGET_LIMITS,
  TASK_FAILURE_LIMITS,
  type SessionState,
  type TaskFailureCode,
  type TaskProgress,
} from "@seance/shared";
import { ended, progressed } from "./done.ts";
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
  /** Since when every `sessions` to the task's machine has failed; absent once one answers. */
  readonly unansweredSince?: number | undefined;
  readonly reservationTtlMs: number;
  readonly lostAfterMs: number;
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

/**
 * Whether its machine's `sessions` can move it (`settle`): a reservation, a
 * placed task, or one `awaiting-merge` on a task branch. A `here` task's merge
 * is never read from a machine (`trusted`), so no reply moves it — unless it
 * settles on its session's report (`until: "reported"`), which `trusted` passes.
 */
export function answerable(task: Task): boolean {
  if (task.state === "awaiting-merge") return task.spec.mode !== "here" || task.spec.until === "reported";
  return task.state === "reserved" || PLACED.includes(task.state);
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
  const sameDevice = current.assignment?.deviceId === seen.assignment?.deviceId;
  if (seen.state === "awaiting-merge") return current.state === "awaiting-merge" && sameDevice;
  return PLACED.includes(current.state) && PLACED.includes(seen.state) && sameDevice;
}

function liveState(state: Exclude<SessionState, "ended" | "done">): TaskState {
  return state === "needs-input" ? "needs-input" : "running";
}

/**
 * Whether `from`, the machine `task` is on, reports an `ended` that waits for
 * its exit (`sessionChange`'s `awaitsExit`): no PR known, and the task is that
 * machine's — a foreign sender defers nothing, so nothing waits on it.
 */
export function waitsForExit(
  task: Task,
  state: SessionState,
  from: SessionSource | undefined,
  prUrl: string | undefined,
  awaitsExit: boolean,
): boolean {
  if (state !== "ended" || !awaitsExit || from === undefined || prUrl !== undefined || task.prUrl !== undefined) {
    return false;
  }
  const at = task.state === "reserved" ? task.reservation : PLACED.includes(task.state) ? task.assignment : undefined;
  return at?.deviceId === from.deviceId;
}

/**
 * A session's own `done` report (#21): it settles its task `done` by `reported`,
 * only under `until: "reported"` and only from the machine the task was placed
 * (or reserved) on — a task is moved only by the machine it was given. Under
 * `until: "merged"` it is ignored, so a switch is one line here and in `done.ts`.
 */
function reported(task: Task, from: SessionSource | undefined, prUrl: string | undefined): Task | null {
  if (task.spec.until !== "reported" || from === undefined) return null;
  const pr = prUrl === undefined ? {} : { prUrl };
  if (task.state === "reserved") {
    const at = task.reservation;
    if (at === undefined || at.deviceId !== from.deviceId) return null;
    return advance(task, "done", { doneBy: "reported", assignment: assignmentOf(at, { id: from.pane }), ...pr });
  }
  if (!PLACED.includes(task.state) && task.state !== "awaiting-merge") return null;
  const { assignment } = task;
  if (assignment?.deviceId !== from.deviceId) return null;
  // As `sessionChange` names a pane-less assignment: one never confirmed takes the report's pane.
  const named = assignment.pane === undefined ? { assignment: { ...assignment, pane: from.pane } } : {};
  return advance(task, "done", { doneBy: "reported", ...named, ...pr });
}

/**
 * A session event, with the PR URL it carried. A session that ended settles as
 * `ended` does (`awaiting-merge` with a PR, else `done`); one still live moves
 * between `running` and `needs-input`, and records a new PR URL even when its
 * state stands — `after: "opened"` and `awaiting-merge` read it. One that
 * reports `done` settles as `reported` says.
 *
 * `awaitsExit`: the sender's daemon reports exit statuses (`CAPABILITIES.exitStatus`).
 * Its `ended` with no PR known then settles nothing: the event's hook runs
 * before the pane dies, so only the machine's next `sessions` answer can say
 * whether the session failed. A reservation it resolves is `running` on the
 * reporting pane meanwhile; a placed task only takes the pane, if it had none.
 */
export function sessionChange(
  task: Task,
  state: SessionState,
  from: SessionSource | undefined,
  prUrl?: string,
  awaitsExit = false,
): Task | null {
  if (state === "done") return reported(task, from, prUrl);
  const pr = prUrl === undefined ? {} : { prUrl };
  const deferred = waitsForExit(task, state, from, prUrl, awaitsExit);
  if (task.state === "reserved") {
    const at = task.reservation;
    if (at === undefined || from === undefined || from.deviceId !== at.deviceId) return null;
    const fields = { assignment: assignmentOf(at, { id: from.pane }), ...pr };
    if (deferred) return advance(task, "running", fields);
    return state === "ended" ? ended(task, undefined, fields) : advance(task, liveState(state), fields);
  }
  // A lost task's machine speaking for it is the proof `lost` waits for.
  if (!PLACED.includes(task.state)) return null;
  // Never confirmed, it is a reservation still: only its own machine, named, may resolve it.
  if (isUnconfirmed(task) && from === undefined) return null;
  const { assignment } = task;
  if (from !== undefined && assignment !== undefined && from.deviceId !== assignment.deviceId) return null;
  // An assignment with no pane (never confirmed, or a `task_running` verdict) takes the event's.
  const named = assignment !== undefined && assignment.pane === undefined && from !== undefined;
  const fields = { ...(named ? { assignment: { ...assignment, pane: from.pane } } : {}), ...pr };
  if (deferred) return named ? { ...task, ...fields } : null;
  if (state === "ended") return ended(task, undefined, fields);
  const to = liveState(state);
  if (task.state !== to) return advance(task, to, fields);
  return prUrl === undefined || prUrl === task.prUrl ? null : { ...task, ...fields };
}

/**
 * A reserved, placed or `awaiting-merge` task against its machine's
 * `sessions`; null leaves it as it is.
 */
export function settle(task: Task, reply: TaskSessionsReply, at: Observed): Task | null {
  if (task.state === "reserved") return settleReserved(task, reply, at);
  if (!reply.ok) return null;
  if (task.state === "awaiting-merge") return changed(task, progressed(task, progressOf(reply, task.id)));
  if (!PLACED.includes(task.state)) return null;
  return settlePlaced(task, reply);
}

function progressOf(reply: SessionsAnswer, taskId: string): TaskProgress | undefined {
  return reply.progress?.find((p) => p.taskId === taskId);
}

/**
 * Whether an ended session cannot be settled yet: the reply was trimmed, it has
 * no entry for the task, and the record holds no PR — settling then would guess
 * "no PR" and call it `done`. A PR the record already holds is proof enough for
 * `awaiting-merge`, which frees the slot; a later read still settles a merge.
 * Without it the task keeps its slot until an untrimmed read (DESIGN.md, "Done
 * detection").
 */
function unknownEnd(task: Task, entry: TaskProgress | undefined, reply: SessionsAnswer): boolean {
  return entry === undefined && reply.progressTrimmed !== undefined && task.prUrl === undefined;
}

function changed(before: Task, after: Task): Task | null {
  return after === before ? null : after;
}

/**
 * Before its TTL only a session carrying the task id, or the id in `ended`,
 * resolves a reservation; anything else is a spawn still on its way. Past it
 * the machine's answer settles it (`settleUnconfirmed`). An unanswered check
 * keeps waiting while the machine may still answer (`goneSince`); once it
 * cannot, the task is `lost` on that machine — never released to `ready` on a
 * silence, since a machine that only sleeps may wake still running it, and
 * `task_running` guards only a re-dispatch to that same machine.
 */
function settleReserved(task: Task, reply: TaskSessionsReply, at: Observed): Task | null {
  const { reservation } = task;
  if (reservation === undefined) return null;
  const expired = reservation.expiresAt <= at.now;
  const target = targetOf(reservation);
  if (!reply.ok) {
    const since = expired ? goneSince(reservation, at) : null;
    if (since === null) return null;
    const reservedAt = task.reservedAt ?? reservation.expiresAt - at.reservationTtlMs;
    return advance(task, "lost", { assignment: target, absentSince: since, reservedAt });
  }
  const known = reply.sessions.some((s) => s.taskId === task.id) || reply.ended?.includes(task.id) === true;
  if (!known && !expired) return null;
  return settleUnconfirmed(task, target, reply);
}

/**
 * When a past-TTL reservation's machine stopped counting as there: now, once
 * it is not connected; once its checks have failed for `lostAfterMs` past the
 * TTL, when they began. A machine that answers only errors would otherwise hold
 * the slot for good, and past the TTL no spawn can still land — a daemon drops
 * an envelope older than the replay window. Null while it may yet answer.
 */
function goneSince(reservation: Reservation, at: Observed): number | null {
  if (!at.connected) return at.now;
  if (at.unansweredSince === undefined) return null;
  const since = Math.max(at.unansweredSince, reservation.expiresAt);
  return at.now - since >= at.lostAfterMs ? since : null;
}

/**
 * A placed task against its machine's own `sessions`: a session carrying its
 * id is the task still running (a `lost` one runs again, on the pane listed
 * now, or waits for input again if it was waiting when lost), with its
 * `progress` applied; none is a session that ended while nobody listened —
 * settled by its PR as `ended` settles one, whether or not `ended` still
 * remembers it, unless a trimmed reply leaves that unknown (`unknownEnd`). A
 * `lost` task never confirmed is not placed but a reservation its machine
 * kept, and settles as one.
 */
function settlePlaced(task: Task, reply: SessionsAnswer): Task | null {
  const { assignment } = task;
  if (isUnconfirmed(task) && assignment !== undefined) return settleUnconfirmed(task, assignment, reply);
  const entry = progressOf(reply, task.id);
  const session = reply.sessions.find((s) => s.taskId === task.id);
  if (session === undefined) {
    if (unknownEnd(task, entry, reply)) return null;
    return ended(task, entry);
  }
  // `lost` keeps `needsInputSince` only for a task that was waiting, and no event re-sends the wait on reconnect.
  const live =
    task.state === "lost" && assignment !== undefined
      ? advance(task, task.needsInputSince === undefined ? "running" : "needs-input", {
          assignment: assignmentOf(assignment, session),
        })
      : task;
  return changed(task, progressed(live, entry));
}

/**
 * A spawn whose reply never came, against its machine's answer. A session
 * carrying the task id is the spawn that landed. An id in `ended` landed and
 * already finished — settled by its PR as `ended` settles one, never re-routed:
 * its reply and its `ended` event were both lost and its session is gone, so
 * `task_running` could not catch a second spawn. With neither, the task goes
 * back to `ready` only on the machine's proof (`provesNeverLanded`); without
 * it, `failed` — a terminal state that says what is unknown, where a
 * re-dispatch could start a twin.
 */
function settleUnconfirmed(task: Task, target: Target, reply: SessionsAnswer): Task | null {
  const entry = progressOf(reply, task.id);
  const session = reply.sessions.find((s) => s.taskId === task.id);
  if (session !== undefined) {
    return progressed(advance(task, "running", { assignment: assignmentOf(target, session) }), entry);
  }
  if (reply.ended?.includes(task.id) === true) {
    if (unknownEnd(task, entry, reply)) return null;
    return ended(task, entry, { assignment: targetOf(target) });
  }
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
