import {
  DECISION_MAX_CANDIDATES,
  MAX_PAUSE_HOLDS,
  PAUSE_KEY,
  quote,
  type BranchState,
  type PauseHold,
  type PauseRequest,
  type ResumeRequest,
  type SessionState,
} from "@seance/shared";
import { escalation, inputClock, type SchedulerAlert } from "./alerts.ts";
import { dispatchOrder } from "./batch.ts";
import { DEFAULT_CONFIG, type SchedulerConfig } from "./config.ts";
import { admission, named } from "./deps.ts";
import { branchChange } from "./done.ts";
import { endClock, expiry } from "./expiry.ts";
import { activeHolds, sameHolds, withHold, withoutHold } from "./pause.ts";
import {
  StoreRevoked,
  UNREACHABLE,
  type Fleet,
  type QueueStore,
  type StoredPause,
  type StoreEntry,
  type StoreWrite,
  type TaskSessionsReply,
  type UnreadablePause,
  type UnreadableTask,
} from "./ports.ts";
import { codeUnitOrder } from "./order.ts";
import { prunable } from "./prune.ts";
import { accountResetAt, route, windowResetOf, type Decision } from "./route.ts";
import { asSeen, deviceOf, holds, sessionChange, settle, verdict, type SessionSource } from "./settle.ts";
import { advance, FINISHED, forgetPrompt, PLACED, type Reservation, type Task, type TaskSpec } from "./task.ts";

export type { SessionSource } from "./settle.ts";

/**
 * The `client` a scheduler spawn audits as: `origin=relay client=scheduler`
 * (Settled defaults 3) on another machine, `origin=leader` on the leader's own.
 */
export const SCHEDULER_CLIENT = "scheduler";

/** A write that keeps meeting another writer's version gives up after this many tries. */
const WRITE_ATTEMPTS = 3;

/**
 * Legacy finished records rewritten lean (`lean`) per pass. Sequential
 * round-trips inside `#pass` delay the next admission and dispatch and nudge
 * every app per write, so the backlog (up to `pruneAt` - 1 records, once) is
 * worked off a few at a time.
 */
const LEAN_PER_PASS = 8;

export interface SchedulerOptions {
  readonly store: QueueStore;
  readonly fleet: Fleet;
  readonly config?: SchedulerConfig;
  readonly now: () => number;
  /**
   * A dispatch runs outside any tick (`#launch`), so its fault has no caller to
   * reject. Without this, the first one surfaces from the next `drain()`.
   */
  readonly onError?: (err: unknown) => void;
  /**
   * A dispatch spending credits (once its spawn is confirmed), or an escalated
   * wait for input (once its write lands) — `SchedulerAlert`. A throw goes to `onError`.
   */
  readonly onAlert?: (alert: SchedulerAlert) => void;
}

/**
 * `pause` and `resume`: every hold in force after the change, or why not.
 * `full`: past `MAX_PAUSE_HOLDS`, one of them kept for the whole-queue hold
 * (account holds stop at one fewer, so a queue `pause` always fits). `conflict`: the record kept changing under
 * the write.
 */
export type PauseResult =
  | { readonly ok: true; readonly holds: readonly PauseHold[] }
  | { readonly ok: false; readonly code: "reset_unknown" | "conflict" | "full" };

export type MarkDoneResult =
  | { readonly ok: true; readonly task: Task }
  | {
      readonly ok: false;
      readonly code: "not_found" | "dispatching" | "finished" | "despawn_failed" | "conflict" | "unrecorded";
    };

export type CancelResult =
  | { readonly ok: true; readonly task: Task }
  | {
      readonly ok: false;
      readonly code: "not_found" | "dispatching" | "finished" | "despawn_failed" | "conflict" | "unrecorded";
    };

/**
 * `discard`: `not_found` when no record by that id is held unreadable,
 * `conflict` when it is held at another version — the caller re-reads first.
 */
export type DiscardResult = { readonly ok: true } | { readonly ok: false; readonly code: "not_found" | "conflict" };

type CancelFailure = { readonly ok: false; readonly code: "despawn_failed" };

interface Held {
  readonly version: number;
  readonly task: Task;
}

/**
 * The loop's state and its transitions, driven by the host: `tick()` on every
 * registry or status push and on a timer (the leader's fires every 30s). It
 * owns no timer, socket or clock, so a host that stops calling it leaves
 * nothing running but the spawns already sent.
 *
 * Writes go through the store per transition, never per tick: an unplaceable
 * task's latest decision is kept here (`lastDecision`) and written only with the
 * reservation it eventually leads to.
 */
export class Scheduler {
  readonly #store: QueueStore;
  readonly #fleet: Fleet;
  readonly #config: SchedulerConfig;
  readonly #now: () => number;
  readonly #onError: (err: unknown) => void;
  readonly #onAlert: (alert: SchedulerAlert) => void;
  readonly #held = new Map<string, Held>();
  /** `queue:pause` as last read or written; version 0 before the first pause. */
  #pause: { readonly version: number; readonly holds: readonly PauseHold[] } = { version: 0, holds: [] };
  /**
   * `account window` → the reset (ms) of the window a spill was last alerted
   * for, 0 when that reading carried none: one alert per account per window,
   * not per task. Memory only, so a new leader alerts an ongoing spill once more.
   */
  readonly #spilled = new Map<string, number>();
  /** Records the store holds that no reader can use: reported, never acted on, never deleted unasked. */
  readonly #unreadable = new Map<string, UnreadableTask>();
  readonly #decisions = new Map<string, Decision>();
  /**
   * deviceId → when a pass first saw it not connected (or gone from the
   * registry), for machines holding placed or `awaiting-merge` tasks. Memory
   * only: a new leader starts the count again, which can only delay `lost`,
   * never hasten it — and it is this clock, not `Machine.lastSeen`, because a
   * timeout's offline mark can make a machine read disconnected beside a
   * `lastSeen` hours old.
   */
  readonly #absentSince = new Map<string, number>();
  /**
   * deviceId → when its `sessions` first failed, until one answers: how long
   * a connected machine has said nothing usable, for a reservation past its
   * TTL (`goneSince`). Memory only, as `#absentSince` is.
   */
  readonly #unansweredSince = new Map<string, number>();
  /**
   * Machines seen absent that are connected again, until the next `#due` reads
   * their tasks' `sessions`: what they sent while away (`branch-state`) went
   * to no one, and `progress` holds it.
   */
  #returned = new Set<string>();
  /**
   * Finished records whose leaning write (`#leanFinished`) did not land this
   * term: a refusal repeats, so retrying would take a slot of every pass and
   * log every time. Cleared on takeover.
   */
  readonly #leanFailed = new Set<string>();
  /** Task id → the tail of its writes (`#serial`). */
  readonly #chains = new Map<string, Promise<void>>();
  /** Task id → its spawn, still out. No pass awaits one; `drain` does. */
  readonly #dispatches = new Map<string, Promise<void>>();
  /** deviceId → its `sessions` check, still out (`#checkOut`): one per machine. No pass awaits one; `drain` does. */
  readonly #checks = new Map<string, Promise<void>>();
  /**
   * deviceId → whether it was connected when its `sessions` went unanswered:
   * not asked again until the next sweep, unless that changes. A hung peer
   * would otherwise cost a timed-out call every pass, and passes run on every
   * registry push. Memory only.
   */
  readonly #quiet = new Map<string, boolean>();
  #sweptAt: number;
  #fault: { readonly err: unknown } | null = null;
  #ticking: Promise<void> | null = null;
  #again = false;

  constructor(options: SchedulerOptions) {
    this.#store = options.store;
    this.#fleet = options.fleet;
    this.#config = options.config ?? DEFAULT_CONFIG;
    this.#now = options.now;
    this.#onError =
      options.onError ??
      ((err) => {
        this.#fault ??= { err };
      });
    this.#onAlert = options.onAlert ?? (() => {});
    this.#sweptAt = this.#now();
  }

  /** The store's view replaces this one, unreconciled — a new leader calls `takeover` instead. */
  async load(): Promise<void> {
    const stored = await this.#store.list();
    this.#held.clear();
    this.#unreadable.clear();
    this.#decisions.clear();
    for (const entry of stored) this.#keep(entry);
    this.#pause = this.#pauseOf(await this.#store.getPause());
  }

  /** The holds in force now: a reset hold past its `resumeAt` has lifted, written or not. */
  holds(): readonly PauseHold[] {
    return activeHolds(this.#pause.holds, this.#now());
  }

  /**
   * Holds dispatch on the whole queue (no `account`) or on one account's
   * candidates; running sessions are never touched. `until: "reset"` lifts at
   * the account's next reset (`accountResetAt`), resolved now and stored, so a
   * later leader lifts it at the same time.
   */
  async pause(request: PauseRequest): Promise<PauseResult> {
    const now = this.#now();
    const { account } = request;
    let hold: PauseHold;
    if (request.until === "resume") {
      hold = { ...(account === undefined ? {} : { account }), until: "resume", at: now };
    } else {
      const resumeAt =
        account === undefined ? null : accountResetAt(account, this.#fleet.machines(), this.tasks(), now, this.#config);
      if (account === undefined || resumeAt === null) return { ok: false, code: "reset_unknown" };
      hold = { account, until: "reset", at: now, resumeAt };
    }
    return this.#writeHolds((current) => withHold(current, hold, now));
  }

  /** Lifts the hold on `account`, or the whole-queue hold when absent; lifting none writes nothing. */
  async resume(request: ResumeRequest): Promise<PauseResult> {
    return this.#writeHolds((current) => withoutHold(current, request.account, this.#now()));
  }

  /**
   * One record re-read, as `load` reads them all — what a host calls when the
   * store says a key changed under it (`store-changed`). Serialized with the
   * task's own writes, so it never lands between a write and its refresh.
   */
  async refresh(id: string): Promise<void> {
    await this.#serial(id, async () => {
      const entry = await this.#store.get(id);
      this.#held.delete(id);
      this.#unreadable.delete(id);
      if (entry === null) {
        this.#decisions.delete(id);
        return;
      }
      this.#keep(entry);
    });
  }

  /** What the store holds that this scheduler cannot read, and why — for the host to report. */
  unreadable(): readonly UnreadableTask[] {
    return [...this.#unreadable.values()];
  }

  /**
   * Deletes a record held as unreadable (`unreadable`), at the version it was
   * read at: junk a token holder planted, or a record sealed under an old PSK.
   * Nothing else ever deletes one, and each holds a slot of the store's cap.
   * A readable task is never `discard`ed, nor one that changed since the caller
   * saw it. A lost reply or a conflict is read back, as prune reads it: gone
   * is done, otherwise the record is held as it now reads. A refusal throws,
   * as the pause's does: no race to retry.
   */
  async discard(taskId: string, version: number): Promise<DiscardResult> {
    return this.#serial(taskId, async (): Promise<DiscardResult> => {
      const held = this.#unreadable.get(taskId);
      if (held === undefined) return { ok: false, code: "not_found" };
      if (held.version !== version) return { ok: false, code: "conflict" };
      const write = await this.#store.delete(taskId, version);
      if (write.ok) {
        this.#unreadable.delete(taskId);
        return { ok: true };
      }
      if (write.code !== "version_conflict" && write.code !== "indeterminate") {
        throw new Error(`store refused delete of task ${taskId}: ${write.code}`);
      }
      const fresh = await this.#store.get(taskId);
      this.#unreadable.delete(taskId);
      if (fresh === null) return { ok: true };
      this.#keep(fresh);
      return { ok: false, code: "conflict" };
    });
  }

  /**
   * Takeover (docs/scheduler.md): load the store, then check every task the
   * previous leader left reserved or placed against its machine's own
   * `sessions` — one call per machine — before the host's first `tick`
   * dispatches anything. Each is settled as a pass settles it (`settle`), except
   * that a reservation is checked at any age: a session or `ended` entry
   * carrying its id resolves it inside its TTL, and past the TTL an unanswered
   * check on a machine no longer connected makes it `lost`. A placed task whose
   * session is gone ended while no leader was listening: `awaiting-merge` if its
   * machine's `progress` (or its record) shows a PR, `done` if the branch merged
   * meanwhile or there was none. An `awaiting-merge` task is read back the same
   * way, for a merge the gap hid. An unanswered machine leaves everything else
   * as it was. Expiry, pruning and leaning finished records (`#leanFinished`)
   * run in the first pass after it, which the host ticks right away, so the
   * term answers after one list and one round of `sessions`.
   */
  async takeover(): Promise<void> {
    await this.load();
    this.#sweptAt = this.#now();
    this.#leanFailed.clear();
    this.#unansweredSince.clear();
    this.#quiet.clear();
    await this.#check(
      this.tasks().filter((t) => t.state === "reserved" || t.state === "awaiting-merge" || PLACED.includes(t.state)),
    );
  }

  /**
   * The store caps `task:` (`MAX_TASKS`), so past `keep` the oldest finished
   * tasks are deleted (`prunable`) — never one with anything left to happen,
   * nor one an unfinished task names. Runs at the end of a pass once the store
   * holds `pruneAt` records — an app's create meeting `store_full` is never
   * seen here. The deletes go out together: each is its own CAS on its own
   * task's chain, so crossing `pruneAt` costs one round trip, not one per record.
   */
  async prune(keep = this.#config.keepFinished): Promise<void> {
    await Promise.all(
      prunable(this.tasks(), keep).map((task) =>
        this.#serial(task.id, async () => {
          const held = this.#held.get(task.id);
          if (held === undefined || !FINISHED.includes(held.task.state) || named(this.tasks()).has(task.id)) return;
          const write = await this.#store.delete(task.id, held.version);
          if (write.ok) {
            this.#held.delete(task.id);
            this.#decisions.delete(task.id);
            return;
          }
          if (write.code !== "version_conflict" && write.code !== "indeterminate") {
            this.#refused(task.id, "delete", write);
            return;
          }
          // A lost reply may be our delete landing, a conflict another write: the store says which,
          // and a record held after it is gone would take a slot of every later prune.
          const fresh = await this.#store.get(task.id);
          this.#held.delete(task.id);
          if (fresh === null) {
            this.#decisions.delete(task.id);
            return;
          }
          this.#keep(fresh);
        }),
      ),
    );
  }

  tasks(): readonly Task[] {
    return [...this.#held.values()].map((h) => h.task);
  }

  task(id: string): Task | undefined {
    return this.#held.get(id)?.task;
  }

  /** The newest routing outcome for a task, placed or not. */
  lastDecision(id: string): Decision | undefined {
    return this.#decisions.get(id) ?? this.#held.get(id)?.task.decision;
  }

  /** A dry run over the current fleet: what `tick` would decide for this spec now. */
  preview(spec: TaskSpec): Decision {
    const task: Task = { id: "", spec, state: "ready", createdAt: this.#now() };
    return capped(
      route({
        task,
        machines: this.#fleet.machines(),
        tasks: this.tasks(),
        now: this.#now(),
        config: this.#config,
        holds: this.#pause.holds,
      }),
    );
  }

  /** Coalesces: a tick asked for while one runs runs once more after it, never alongside. */
  tick(): Promise<void> {
    if (this.#ticking !== null) {
      this.#again = true;
      return this.#ticking;
    }
    this.#ticking = (async () => {
      try {
        do {
          this.#again = false;
          // oxlint-disable-next-line no-await-in-loop -- passes are sequential by design: that is the coalescing
          await this.#pass();
        } while (this.#again);
      } finally {
        this.#ticking = null;
      }
    })();
    return this.#ticking;
  }

  /**
   * Resolves once no tick runs and no spawn or check is out, rejecting with the
   * first fault no `onError` took. For tests, and a host that wants quiet.
   */
  async drain(): Promise<void> {
    for (;;) {
      const out = [
        ...this.#dispatches.values(),
        ...this.#checks.values(),
        ...(this.#ticking === null ? [] : [this.#ticking]),
      ];
      if (out.length === 0) break;
      // oxlint-disable-next-line no-await-in-loop -- a settled spawn's verdict can start no other, but a tick can
      await Promise.allSettled(out);
    }
    const fault = this.#fault;
    this.#fault = null;
    if (fault !== null) throw fault.err;
  }

  /**
   * A session's state, from a `session-event`. For a reserved task it is proof
   * the spawn landed — the reply may be lost — so it resolves the reservation:
   * the assignment is the reservation's target plus the reporting pane. `from`
   * is checked against where the task was placed, so a machine can move only
   * the tasks it was given; without `from` (a host that cannot say) a reserved
   * task is left to its verdict or its TTL. `prUrl` is the event's: a session
   * that ends with one is `awaiting-merge`, not `done`.
   */
  async onSession(taskId: string, state: SessionState, from?: SessionSource, prUrl?: string): Promise<void> {
    await this.#update(taskId, (task) => sessionChange(task, state, from, prUrl));
  }

  /**
   * A task branch's state, from a `branch-state` sealed by `from`: its branch
   * and `pushed` recorded, a merge making it `done` (`branchChange`). Only the
   * machine the task was placed on moves it. A dependent it releases moves on
   * the next pass.
   */
  async onBranchState(state: BranchState, from: string): Promise<void> {
    await this.#update(state.taskId, (task) => branchChange(task, state, from));
  }

  /**
   * A reserved task is mid-dispatch: its spawn may already be running, so it is
   * refused until the verdict lands rather than raced. A `queued`, `blocked` or
   * `awaiting-merge` task has no session to stop, so it is cancelled as it
   * stands. A `lost` task whose
   * machine is back is despawned like a running one; with its machine still
   * gone nothing can be despawned, so it is cancelled as it stands and marked
   * `leftRunning` — the record says plainly that a session may outlive it. A
   * task that finishes while the despawn is out (its session reported `ended`
   * first) is answered as it finished. A despawn that ran and then lost the
   * right to write `cancelled` is `unrecorded`: the session is gone, the term
   * ends, and asking again is safe (the despawn finds no session).
   */
  async cancel(taskId: string): Promise<CancelResult> {
    const task = this.task(taskId);
    if (task === undefined) return { ok: false, code: "not_found" };
    const refused = cancelRefusal(task);
    if (refused !== null) return refused;
    const { assignment } = task;
    const leftRunning = task.state === "lost" && assignment !== undefined && !this.#connected(assignment.deviceId);
    const ended = leftRunning ? { ok: true as const, despawned: false } : await this.#endSession(task);
    if (!ended.ok) return ended;
    const { despawned } = ended;
    let outcome: CancelResult = { ok: false, code: "conflict" };
    const next = await this.#update(taskId, (current) => {
      if (FINISHED.includes(current.state)) {
        outcome = { ok: true, task: current };
        return null;
      }
      const refusal = cancelRefusal(current);
      if (refusal !== null) {
        outcome = refusal;
        return null;
      }
      // What was despawned, or found gone, must still be what is cancelled.
      if (leftRunning ? current.state !== "lost" : current.assignment?.deviceId !== assignment?.deviceId) return null;
      return advance(current, "cancelled", leftRunning ? { leftRunning: true } : {});
    }).catch((err: unknown) => {
      // The session is gone but the record still says otherwise: the term must end, yet the
      // caller must not read that as "nothing happened".
      if (!despawned || !(err instanceof StoreRevoked)) throw err;
      this.#onError(err);
      outcome = { ok: false, code: "unrecorded" };
      return null;
    });
    if (next === null) return outcome;
    this.#decisions.delete(taskId);
    return { ok: true, task: next };
  }

  /**
   * Ends the session of a placed task: whether it was despawned, or refused as
   * `despawn_failed`. No pane to name and none listed is nothing to end.
   */
  async #endSession(task: Task): Promise<{ readonly ok: true; readonly despawned: boolean } | CancelFailure> {
    const { assignment } = task;
    if (assignment === undefined || !PLACED.includes(task.state)) return { ok: true, despawned: false };
    // A `task_running` verdict may name no pane; the machine's sessions still carry the task id.
    let pane = assignment.pane;
    if (pane === undefined) {
      const listed = await this.#fleet.sessions(assignment.deviceId);
      if (!listed.ok) return { ok: false, code: "despawn_failed" };
      pane = listed.sessions.find((s) => s.taskId === task.id)?.id;
    }
    if (pane === undefined) return { ok: true, despawned: false };
    const reply = await this.#fleet.despawn(assignment.deviceId, { id: pane, client: SCHEDULER_CLIENT });
    if (!reply.ok && reply.code !== "session_not_found") return { ok: false, code: "despawn_failed" };
    return { ok: true, despawned: true };
  }

  /**
   * Settles an unfinished task `done` (`doneBy: "manual"`) as it stands: the
   * human says its work is over, so it wins over whatever else the task was
   * waiting for. A `running` or `needs-input` task, or a `lost` one whose
   * machine is connected, has its session ended first, as `cancel` does, since a
   * `done` task holds no slot and a session left running would keep working
   * beyond the caps. `lost`, `awaiting-merge` and the waiting states are settled
   * as they stand (their session is gone, or unreachable, or never was); a
   * `lost` one is marked `leftRunning`, as `cancel` marks it. A later event for a `done` task is ignored
   * (`sessionChange` and `branchChange` touch placed tasks only). `reserved` is
   * refused as `cancel` refuses it: its spawn is in flight. A despawn that ran
   * and then lost the right to write `done` is `unrecorded`, as for `cancel`.
   */
  async markDone(taskId: string): Promise<MarkDoneResult> {
    const task = this.task(taskId);
    if (task === undefined) return { ok: false, code: "not_found" };
    if (task.state === "reserved") return { ok: false, code: "dispatching" };
    if (FINISHED.includes(task.state)) return { ok: false, code: "finished" };
    const { assignment } = task;
    const lostReachable = task.state === "lost" && assignment !== undefined && this.#connected(assignment.deviceId);
    const live = task.state === "running" || task.state === "needs-input" || lostReachable;
    const ended = live ? await this.#endSession(task) : { ok: true as const, despawned: false };
    if (!ended.ok) return ended;
    let outcome: MarkDoneResult = { ok: false, code: "conflict" };
    const next = await this.#update(taskId, (current) => {
      if (FINISHED.includes(current.state)) {
        // The despawn's `ended` event may have settled it first: as for cancel, that is the answer.
        outcome = ended.despawned ? { ok: true, task: current } : { ok: false, code: "finished" };
        return null;
      }
      if (current.state === "reserved") {
        outcome = { ok: false, code: "dispatching" };
        return null;
      }
      // No despawn ran, yet a session is live now: it would outlive a `done` write.
      if (!live && (current.state === "running" || current.state === "needs-input")) return null;
      // What was despawned must still be what is settled.
      if (live && current.assignment?.deviceId !== assignment?.deviceId) return null;
      const leftRunning = !live && current.state === "lost";
      return advance(current, "done", { doneBy: "manual", ...(leftRunning ? { leftRunning: true } : {}) });
    }).catch((err: unknown) => {
      if (!ended.despawned || !(err instanceof StoreRevoked)) throw err;
      this.#onError(err);
      outcome = { ok: false, code: "unrecorded" };
      return null;
    });
    if (next === null) return outcome;
    this.#decisions.delete(taskId);
    return { ok: true, task: next };
  }

  #connected(deviceId: string): boolean {
    return this.#fleet.machines().some((m) => m.deviceId === deviceId && m.connected);
  }

  /**
   * `lost` and `awaiting-merge` are never pruned, hold no slot and outlive
   * every term: past their bound they fail (`expiry`). Before admission, so
   * dependents fail in the same pass. A task whose machine's check is out is
   * left to it, so a machine back in time settles its task first; so is a
   * `lost` task whose machine is connected now, for the next check. Judged
   * again inside the write, since either may change between the two.
   */
  async #expire(): Promise<void> {
    const now = this.#now();
    const spared = (t: Task): boolean => {
      const deviceId = deviceOf(t);
      if (deviceId === undefined) return false;
      return this.#checks.has(deviceId) || (t.state === "lost" && this.#connected(deviceId));
    };
    await Promise.all(
      this.tasks()
        .filter((t) => expiry(t, now, this.#config) !== null && !spared(t))
        .map((seen) =>
          this.#update(seen.id, (current) => (spared(current) ? null : expiry(current, now, this.#config))),
        ),
    );
  }

  async #pass(): Promise<void> {
    await this.#markAbsent();
    this.#checkOut(this.#due());
    await this.#expire();
    await this.#escalate();
    // A check ticks again once its answer is settled, so a predecessor it settled releases or fails its dependents then.
    await this.#admit();
    const ready = dispatchOrder(this.tasks().filter((t) => t.state === "ready" && !this.#dispatches.has(t.id)));
    // Reserve one at a time, so each sees the reservations before it in projected
    // usage and its batch's bound. The spawns are not awaited: one slow machine
    // must not hold every other placement, TTL and absence check behind its 90s
    // timeout.
    for (const task of ready) {
      const now = this.#now();
      const decision = capped(
        route({
          task,
          machines: this.#fleet.machines(),
          tasks: this.tasks(),
          now,
          config: this.#config,
          holds: this.#pause.holds,
        }),
      );
      this.#decisions.set(task.id, decision);
      if (decision.chosen === null) continue;
      const reservation: Reservation = { ...decision.chosen, expiresAt: now + this.#config.reservationTtlMs };
      // oxlint-disable-next-line no-await-in-loop -- each route must see the reservation before it
      const reserved = await this.#update(task.id, (current) =>
        // Routed from a snapshot: a task that moved meanwhile (a cancel) keeps what it moved to.
        current.state === "ready" ? advance(current, "reserved", { reservation, decision, reservedAt: now }) : null,
      );
      if (reserved === null) continue;
      this.#decisions.delete(task.id);
      this.#launch(reserved, reservation, decision);
    }
    // Lazily: a finished task an app is about to name in `deps` must outlive the refresh that tells us of it.
    await this.#pruneDue();
    await this.#leanFinished();
  }

  /**
   * Finished records written before a finished task was kept lean (`lean`), or
   * by an older leader, still hold a prompt or a full decision: rewrite them
   * lean, oldest first and at most `LEAN_PER_PASS` per pass, each its own
   * fenced CAS'd put. `#update` leans at the boundary, so handing back
   * `current` is enough. A write that did not land is reported by `#update`,
   * and the record stays as it was and is skipped until the next term
   * (`#leanFailed`). `StoreRevoked` propagates: the term is over. Not in
   * `takeover`: a throw there fails the takeover and blocks the term.
   */
  async #leanFinished(): Promise<void> {
    const stale = this.tasks()
      .filter((t) => lean(t) !== t && !this.#leanFailed.has(t.id))
      .toSorted((a, b) => a.createdAt - b.createdAt || codeUnitOrder(a.id, b.id))
      .slice(0, LEAN_PER_PASS);
    for (const task of stale) {
      // oxlint-disable-next-line no-await-in-loop -- one CAS'd write at a time
      const written = await this.#update(task.id, (current) => (lean(current) === current ? null : current));
      if (written === null) this.#leanFailed.add(task.id);
    }
  }

  /**
   * A confirmed spawn on a candidate that `spill`s spends credits: alerted once
   * per account per quota window, not per task — the record's decision carries
   * the spill for each task. The window is told apart by its reset; two
   * readings of one window differ by seconds, so a reset only counts as a new
   * window when it is later by more than `resetGraceMs` (or the alerted one has
   * passed), and a reading with no reset never does.
   */
  #spill(taskId: string, decision: Decision): void {
    const { chosen } = decision;
    if (chosen === null) return;
    const spill = decision.candidates.find(
      (c) => c.deviceId === chosen.deviceId && c.exclave === chosen.exclave,
    )?.spill;
    if (spill === undefined) return;
    const machines = this.#fleet.machines();
    const accountId = machines
      .find((m) => m.deviceId === chosen.deviceId)
      ?.exclaves?.find((x) => x.id === chosen.exclave)?.accountId;
    if (accountId === undefined || accountId === null) return;
    const key = `${accountId} ${spill.window}`;
    const resetS = windowResetOf(accountId, machines, spill.window);
    const reset = resetS === undefined ? undefined : resetS * 1000;
    const now = this.#now();
    const alerted = this.#spilled.get(key);
    if (alerted !== undefined) {
      if (reset === undefined) return;
      // An alert stamped with no reset learns it, without alerting again.
      if (alerted === 0) {
        this.#spilled.set(key, reset);
        return;
      }
      const newWindow = reset - alerted > this.#config.resetGraceMs || (alerted <= now && reset > now);
      if (!newWindow) return;
    }
    this.#spilled.set(key, reset ?? 0);
    const pct = Math.round(spill.projectedPct);
    this.#alert({
      kind: "spill",
      taskId,
      accountId,
      window: spill.window,
      projectedPct: spill.projectedPct,
      message: `spending credits: task=${quote(taskId)} account=${quote(accountId)} window=${quote(spill.window)} projected=${pct}%`,
    });
  }

  /** An alert is a side channel: a host that throws must not strand a reservation or end a pass. */
  #alert(alert: SchedulerAlert): void {
    try {
      this.#onAlert(alert);
    } catch (err) {
      this.#onError(err);
    }
  }

  /**
   * A task waiting for input past `needsInputEscalateMs` is marked `escalated`
   * — one write per stay — and alerted once that write lands, so a new leader
   * reading the record never alerts it again.
   */
  async #escalate(): Promise<void> {
    const now = this.#now();
    const after = this.#config.needsInputEscalateMs;
    await Promise.all(
      this.tasks()
        .filter((t) => escalation(t, now, after) !== null)
        .map(async (seen) => {
          const next = await this.#update(seen.id, (current) => escalation(current, now, after));
          if (next?.escalated !== true || next.needsInputSince === undefined) return;
          const minutes = Math.round((now - next.needsInputSince) / 60_000);
          this.#alert({
            kind: "needs-input",
            taskId: next.id,
            since: next.needsInputSince,
            message: `needs input: task=${quote(next.id)} waiting ${minutes} min — escalated, its slot kept`,
          });
        }),
    );
  }

  /**
   * `queue:pause` as read. Unreadable fails closed — the whole queue held until
   * a `resume`, which overwrites it at its version: a pause is usually about
   * spending, and dispatching through one nobody can read is the costlier guess.
   */
  #pauseOf(read: StoredPause | UnreadablePause | null): {
    readonly version: number;
    readonly holds: readonly PauseHold[];
  } {
    if (read === null) return { version: 0, holds: [] };
    if (read.reason === undefined) return { version: read.version, holds: read.holds };
    this.#onError(
      new Error(`${PAUSE_KEY} is unreadable (${read.reason}): the whole queue is held until a resume overwrites it`),
    );
    return { version: read.version, holds: [{ until: "resume", at: this.#now() }] };
  }

  /**
   * The one way `queue:pause` is written, serialized like a task's writes
   * (`PAUSE_KEY` is no task id). A conflict or a lost reply re-reads and
   * applies `change` again, as `#update` does; after a lost reply the one
   * version past ours is ours, the pause being the leader's alone. A change
   * that leaves the holds as they are writes nothing.
   */
  #writeHolds(change: (holds: readonly PauseHold[]) => readonly PauseHold[]): Promise<PauseResult> {
    return this.#serial(PAUSE_KEY, async (): Promise<PauseResult> => {
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
        const held = this.#pause;
        const next = change(held.holds);
        if (next.filter((h) => h.account !== undefined).length >= MAX_PAUSE_HOLDS) return { ok: false, code: "full" };
        if (sameHolds(next, held.holds)) return { ok: true, holds: this.holds() };
        // oxlint-disable-next-line no-await-in-loop -- each attempt follows the refresh before it
        const write = await this.#store.putPause(held.version, next);
        if (write.ok) {
          this.#pause = { version: write.version, holds: next };
          return { ok: true, holds: this.holds() };
        }
        if (write.code !== "version_conflict" && write.code !== "indeterminate") {
          throw new Error(`store refused put of ${PAUSE_KEY}: ${write.code}`);
        }
        // oxlint-disable-next-line no-await-in-loop -- as above
        const fresh = await this.#store.getPause();
        if (write.code === "indeterminate" && fresh?.reason === undefined && fresh?.version === held.version + 1) {
          this.#pause = { version: fresh.version, holds: next };
          return { ok: true, holds: this.holds() };
        }
        this.#pause = this.#pauseOf(fresh);
      }
      return { ok: false, code: "conflict" };
    });
  }

  /**
   * Gated, not unconditional: a create naming a finished task may be in flight
   * at any pass, and pruning only past `pruneAt` narrows that race (it does not
   * close it).
   */
  async #pruneDue(): Promise<void> {
    if (this.#held.size + this.#unreadable.size >= this.#config.pruneAt) await this.prune();
  }

  /**
   * Admission (`admission`): each `queued` or `blocked` task to where its edges
   * put it. Computed over one snapshot, so a cascade lands whole; each write
   * re-checks that its task is still waiting where it was.
   */
  async #admit(): Promise<void> {
    const moves = admission(this.tasks(), new Set(this.#unreadable.keys()), this.#now());
    await Promise.all(
      [...moves].map(([id, move]) =>
        this.#update(id, (current) => {
          if ((current.state !== "queued" && current.state !== "blocked") || current.state === move.state) return null;
          return advance(current, move.state, move.state === "failed" ? { failure: move.failure } : {});
        }),
      ),
    );
  }

  #launch(task: Task, at: Reservation, decision: Decision): void {
    const run = this.#dispatch(task, at, decision)
      .catch(this.#onError)
      .finally(() => this.#dispatches.delete(task.id));
    this.#dispatches.set(task.id, run);
  }

  async #dispatch(task: Task, at: Reservation, decision: Decision): Promise<void> {
    const { spec } = task;
    const reply = await this.#fleet.spawn(at.deviceId, {
      repo: at.clone,
      mode: spec.mode,
      ...(spec.prompt === undefined ? {} : { prompt: spec.prompt }),
      ...(spec.title === undefined ? {} : { title: spec.title }),
      ...(spec.model === undefined ? {} : { model: spec.model }),
      ...(spec.effort === undefined ? {} : { effort: spec.effort }),
      ...(spec.plan === undefined ? {} : { plan: spec.plan }),
      client: SCHEDULER_CLIENT,
      taskId: task.id,
    });
    // An event may have resolved it while the spawn was out; a verdict answers only its own reservation.
    await this.#update(task.id, (current) => (holds(current, at) ? verdict(current, at, reply) : null));
    // Only a confirmed spawn spent anything: a refused one must not alert or burn the window's one alert.
    if (reply.ok) this.#spill(task.id, decision);
  }

  /**
   * A placed task on a machine that stops answering is never routed again: its
   * session may be alive on a machine that only sleeps, and a second dispatch
   * would be its twin. Absent past `lostAfterMs` it is `lost`, so the record
   * says so instead of reading `running` forever; once its machine is
   * connected again, that machine's `sessions` settles it (`#due`).
   */
  async #markAbsent(): Promise<void> {
    const now = this.#now();
    const connected = this.#connectedIds();
    const placed = this.tasks().filter((t) => PLACED.includes(t.state) && t.assignment !== undefined);
    const devices = new Set(
      this.tasks()
        .filter((t) => PLACED.includes(t.state) || t.state === "awaiting-merge")
        .flatMap((t) => t.assignment?.deviceId ?? []),
    );
    for (const deviceId of [...this.#absentSince.keys()]) {
      if (devices.has(deviceId) && connected.has(deviceId)) this.#returned.add(deviceId);
      if (!devices.has(deviceId) || connected.has(deviceId)) this.#absentSince.delete(deviceId);
    }
    for (const deviceId of devices) {
      if (!connected.has(deviceId) && !this.#absentSince.has(deviceId)) this.#absentSince.set(deviceId, now);
    }
    await Promise.all(
      placed.map(async (task) => {
        const deviceId = task.assignment?.deviceId ?? "";
        const since = this.#absentSince.get(deviceId);
        if (task.state === "lost" || since === undefined || now - since < this.#config.lostAfterMs) return;
        await this.#update(task.id, (current) =>
          current.state !== "lost" && PLACED.includes(current.state) && current.assignment?.deviceId === deviceId
            ? advance(current, "lost", { absentSince: since })
            : null,
        );
      }),
    );
  }

  /**
   * What this pass checks against `sessions`: a reservation past its TTL whose
   * spawn is no longer out (one still out may yet land, and its verdict is
   * the better answer); a `lost` task whose machine is back; every placed or
   * `awaiting-merge` task on a machine back from an absence, whose
   * `branch-state`s went nowhere meanwhile; and, once per `sweepIntervalMs`,
   * every running or `awaiting-merge` task on a connected machine — the only
   * way a task whose `ended` or `merged` event was lost ever finishes. None on
   * a machine whose check is still out, or that went unanswered since the last
   * sweep (`#quiet`); a machine skipped keeps its return for the pass that asks it.
   */
  #due(): readonly Task[] {
    const now = this.#now();
    const connected = this.#connectedIds();
    const sweep = now - this.#sweptAt >= this.#config.sweepIntervalMs;
    if (sweep) {
      this.#sweptAt = now;
      this.#quiet.clear();
    }
    // Dropped the moment it differs, so a machine that leaves and comes back between two checks is asked.
    for (const [deviceId, was] of this.#quiet) if (was !== connected.has(deviceId)) this.#quiet.delete(deviceId);
    const skipped = (deviceId: string): boolean => this.#checks.has(deviceId) || this.#quiet.has(deviceId);
    const returned = this.#returned;
    this.#returned = new Set([...returned].filter(skipped));
    return this.tasks().filter((t) => {
      const deviceId = deviceOf(t);
      if (deviceId === undefined || skipped(deviceId)) return false;
      if (t.state === "reserved") {
        return t.reservation !== undefined && t.reservation.expiresAt <= now && !this.#dispatches.has(t.id);
      }
      if (!connected.has(deviceId)) return false;
      // A `here` task's merge is never read from a machine (`trusted`): no reply can change it.
      if (t.state === "awaiting-merge") return t.spec.mode !== "here" && (sweep || returned.has(deviceId));
      if (!PLACED.includes(t.state)) return false;
      return t.state === "lost" || sweep || returned.has(deviceId);
    });
  }

  /** Every machine's check at once, awaited: takeover's, before the term's first pass. */
  async #check(tasks: readonly Task[]): Promise<void> {
    await Promise.all([...byDevice(tasks)].map(([deviceId, mine]) => this.#checkDevice(deviceId, mine)));
  }

  /**
   * A pass's checks, not awaited: one slow `sessions` must not hold every
   * admission and dispatch behind it. Each ticks again once its answer is
   * settled, while still counted out, so that tick asks the machine nothing.
   */
  #checkOut(tasks: readonly Task[]): void {
    for (const [deviceId, mine] of byDevice(tasks)) {
      const run = this.#checkDevice(deviceId, mine)
        .then(() => this.tick())
        .catch(this.#onError)
        .finally(() => this.#checks.delete(deviceId));
      this.#checks.set(deviceId, run);
    }
  }

  /**
   * One `sessions` to a machine, then each of its tasks settled from the answer
   * (`settle`) — unless it moved while the call was out, since an answer read
   * before an event landed could undo it.
   */
  async #checkDevice(deviceId: string, tasks: readonly Task[]): Promise<void> {
    const reply = await this.#fleet.sessions(deviceId);
    this.#heard(deviceId, reply);
    await Promise.all(
      tasks.map((seen) =>
        this.#update(seen.id, (current) =>
          asSeen(current, seen)
            ? settle(current, reply, {
                now: this.#now(),
                connected: this.#connected(deviceId),
                unansweredSince: this.#unansweredSince.get(deviceId),
                reservationTtlMs: this.#config.reservationTtlMs,
                lostAfterMs: this.#config.lostAfterMs,
              })
            : null,
        ),
      ),
    );
  }

  /** What a `sessions` answer says of its machine: since when it has failed (`#unansweredSince`), and whether to stop asking (`#quiet`). */
  #heard(deviceId: string, reply: TaskSessionsReply): void {
    if (reply.ok) {
      this.#unansweredSince.delete(deviceId);
      this.#quiet.delete(deviceId);
      return;
    }
    if (!this.#unansweredSince.has(deviceId)) this.#unansweredSince.set(deviceId, this.#now());
    if (reply.code === UNREACHABLE) this.#quiet.set(deviceId, this.#connected(deviceId));
  }

  #connectedIds(): ReadonlySet<string> {
    return new Set(
      this.#fleet
        .machines()
        .filter((m) => m.connected)
        .map((m) => m.deviceId),
    );
  }

  /** Runs `step` after every earlier step for the same task has finished, failed or not. */
  #serial<T>(id: string, step: () => Promise<T>): Promise<T> {
    const turn = (this.#chains.get(id) ?? Promise.resolve()).then(step);
    const tail = turn.then(
      () => undefined,
      () => undefined,
    );
    this.#chains.set(id, tail);
    void tail.then(() => {
      if (this.#chains.get(id) === tail) this.#chains.delete(id);
    });
    return turn;
  }

  /**
   * The one way a held task is written. Serialized per task, with `change`
   * computed from the copy held when its turn comes, so two writers never race
   * one version: an `ended` event landing while a verdict's write is out
   * applies after it, to what it wrote. A version conflict is a write this
   * process did not make — a term that ended without hearing it had, or a
   * create racing its own — so the held copy is refreshed from the store and
   * `change` applied again to what it finds. A lost reply (`indeterminate`) is
   * read the same way, except that the one version after ours is ours. A record
   * past the store's bound is written again with its decision cut to the
   * winner, never the task cut. The needs-input clock (`inputClock`) rides
   * whatever state a write lands, so no path can enter or leave `needs-input`
   * without it, and the merge clock (`endClock`) rides entering `awaiting-merge` the same way.
   * A finished task is kept lean on the same write (`lean`), so none reaches
   * the store with a prompt or the losers of its decision. Null when `change` declines (it returns null
   * for a task no longer in the state it acts on), the task is gone or
   * unreadable, the store refused the write, or the conflicts outlast
   * `WRITE_ATTEMPTS`. `StoreRevoked` is not caught: the term is over.
   */
  #update(id: string, change: (task: Task) => Task | null): Promise<Task | null> {
    return this.#serial(id, async () => {
      let trim = false;
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
        const held = this.#held.get(id);
        if (held === undefined) return null;
        const proposed = change(held.task);
        if (proposed === null) return null;
        const now = this.#now();
        const changed = lean(endClock(held.task, inputClock(proposed, now), now));
        const next = trim ? trimmed(changed) : changed;
        // oxlint-disable-next-line no-await-in-loop -- each attempt follows the refresh before it
        const write = await this.#store.put(id, held.version, next);
        if (write.ok) {
          this.#held.set(id, { version: write.version, task: next });
          return next;
        }
        if (write.code === "too_large" && !trim && next.decision !== undefined) {
          trim = true;
          continue;
        }
        if (write.code !== "version_conflict" && write.code !== "indeterminate") {
          this.#refused(id, "put", write);
          return null;
        }
        // oxlint-disable-next-line no-await-in-loop -- as above
        const fresh = await this.#store.get(id);
        this.#held.delete(id);
        if (fresh === null) return null;
        // Every overwrite of a task is the leader's, so the one version after ours, after a
        // lost reply, is our write — adopted as written, or the change would decline itself.
        if (write.code === "indeterminate" && fresh.body !== undefined && fresh.version === held.version + 1) {
          this.#held.set(id, { version: fresh.version, task: next });
          return next;
        }
        this.#keep(fresh);
        if (fresh.body === undefined) return null;
      }
      return null;
    });
  }

  /** A record as read: held when it opened, set aside with its reason when it did not. */
  #keep(entry: StoreEntry): void {
    if (entry.body === undefined) {
      this.#unreadable.set(entry.id, entry);
      this.#decisions.delete(entry.id);
      return;
    }
    this.#unreadable.delete(entry.id);
    this.#held.set(entry.id, { version: entry.version, task: entry.body });
  }

  /** A write the store refused outright: no race to retry, so it is a fault for the host to see. */
  #refused(id: string, op: string, write: Extract<StoreWrite, { readonly ok: false }>): void {
    this.#onError(new Error(`store refused ${op} of task ${id}: ${write.code}`));
  }
}

/** At most `DECISION_MAX_CANDIDATES`, cut from the end — the rejected trail — and counted in `trimmed`. */
function capped(decision: Decision): Decision {
  const over = decision.candidates.length - DECISION_MAX_CANDIDATES;
  if (over <= 0) return decision;
  return {
    ...decision,
    candidates: decision.candidates.slice(0, DECISION_MAX_CANDIDATES),
    trimmed: (decision.trimmed ?? 0) + over,
  };
}

/**
 * A finished task as it is kept: no prompt (`forgetPrompt`), and its decision
 * cut to the winner (`trimmed`) — nothing re-routes it, and the losers of a
 * large fleet's decision would otherwise ride every listing and re-seal until
 * it is pruned. Returns `task` itself when there is nothing to drop.
 */
function lean(task: Task): Task {
  if (!FINISHED.includes(task.state)) return task;
  return trimmed(forgetPrompt(task));
}

/**
 * A task whose record would not fit: its decision cut to the candidate it chose,
 * the rest counted in `trimmed`. Everything else a record holds is bounded, so
 * this is the one cut that can make it fit (`STORE_MAX_CT_LENGTH`).
 */
function trimmed(task: Task): Task {
  const { decision } = task;
  if (decision === undefined) return task;
  const cut = winnerOnly(decision);
  return cut === decision ? task : { ...task, decision: cut };
}

/**
 * The winner's candidate alone, the rest added to `trimmed`: still where and
 * why, without the losers that make a record grow with the fleet. Unchanged
 * when there is nothing to cut.
 */
export function winnerOnly(decision: Decision): Decision {
  const { chosen } = decision;
  const kept = decision.candidates.filter(
    (c) => chosen !== null && c.deviceId === chosen.deviceId && c.exclave === chosen.exclave,
  );
  const cut = decision.candidates.length - kept.length;
  if (cut === 0) return decision;
  return { ...decision, candidates: kept, trimmed: (decision.trimmed ?? 0) + cut };
}

/** Tasks grouped by the machine they are reserved or placed on; one with neither is left out. */
function byDevice(tasks: readonly Task[]): ReadonlyMap<string, readonly Task[]> {
  const out = new Map<string, Task[]>();
  for (const task of tasks) {
    const deviceId = deviceOf(task);
    if (deviceId !== undefined) out.set(deviceId, [...(out.get(deviceId) ?? []), task]);
  }
  return out;
}

function cancelRefusal(task: Task): CancelResult | null {
  if (task.state === "reserved") return { ok: false, code: "dispatching" };
  if (FINISHED.includes(task.state)) return { ok: false, code: "finished" };
  return null;
}
