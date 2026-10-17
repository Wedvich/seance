import {
  DECISION_MAX_CANDIDATES,
  isTransportError,
  REPLAY_WINDOW_MS,
  TARGET_LIMITS,
  TASK_FAILURE_LIMITS,
  type SessionState,
  type TaskFailureCode,
} from "@seance/shared";
import { DEFAULT_CONFIG, type SchedulerConfig } from "./config.ts";
import {
  UNDELIVERED,
  UNREACHABLE,
  type Fleet,
  type QueueStore,
  type StoreEntry,
  type StoreWrite,
  type TaskSessionsReply,
  type TaskSpawnReply,
  type UnreadableTask,
} from "./ports.ts";
import { route, type Decision } from "./route.ts";
import {
  advance,
  canTransition,
  FINISHED,
  isUnconfirmed,
  PLACED,
  type Assignment,
  type Reservation,
  type Target,
  type Task,
  type TaskSpec,
  type TaskState,
} from "./task.ts";

type SessionsAnswer = Extract<TaskSessionsReply, { readonly ok: true }>;

/**
 * The `client` a scheduler spawn audits as: `origin=relay client=scheduler`
 * (Settled defaults 3) on another machine, `origin=leader` on the leader's own.
 */
export const SCHEDULER_CLIENT = "scheduler";

/** A write that keeps meeting another writer's version gives up after this many tries. */
const WRITE_ATTEMPTS = 3;

/**
 * Who reported a session event: the machine that sealed it (the envelope's
 * AAD-bound `from`) and the pane its daemon bound the event to.
 */
export interface SessionSource {
  readonly deviceId: string;
  readonly pane: string;
}

export interface SchedulerOptions {
  readonly store: QueueStore;
  readonly fleet: Fleet;
  readonly config?: SchedulerConfig;
  readonly now: () => number;
  readonly newId?: () => string;
  /**
   * A dispatch runs outside any tick (`#launch`), so its fault has no caller to
   * reject. Without this, the first one surfaces from the next `drain()`.
   */
  readonly onError?: (err: unknown) => void;
}

export type CancelResult =
  | { readonly ok: true; readonly task: Task }
  | {
      readonly ok: false;
      readonly code: "not_found" | "dispatching" | "finished" | "despawn_failed" | "conflict";
    };

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
  readonly #newId: () => string;
  readonly #onError: (err: unknown) => void;
  readonly #held = new Map<string, Held>();
  /** Records the store holds that no reader can use: reported, never acted on, never deleted unasked. */
  readonly #unreadable = new Map<string, UnreadableTask>();
  readonly #decisions = new Map<string, Decision>();
  /**
   * deviceId → when a pass first saw it not connected (or gone from the
   * registry), for machines holding placed tasks. Memory only: a new leader
   * starts the count again, which can only delay `lost`, never hasten it — and
   * it is this clock, not `Machine.lastSeen`, because a timeout's offline mark
   * can make a machine read disconnected beside a `lastSeen` hours old.
   */
  readonly #absentSince = new Map<string, number>();
  /** Task id → the tail of its writes (`#serial`). */
  readonly #chains = new Map<string, Promise<void>>();
  /** Task id → its spawn, still out. No pass awaits one; `drain` does. */
  readonly #dispatches = new Map<string, Promise<void>>();
  #sweptAt: number;
  #fault: { readonly err: unknown } | null = null;
  #ticking: Promise<void> | null = null;
  #again = false;

  constructor(options: SchedulerOptions) {
    this.#store = options.store;
    this.#fleet = options.fleet;
    this.#config = options.config ?? DEFAULT_CONFIG;
    this.#now = options.now;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#onError =
      options.onError ??
      ((err) => {
        this.#fault ??= { err };
      });
    this.#sweptAt = this.#now();
  }

  /** The store's view replaces this one, unreconciled — a new leader calls `takeover` instead. */
  async load(): Promise<void> {
    const stored = await this.#store.list();
    this.#held.clear();
    this.#unreadable.clear();
    this.#decisions.clear();
    for (const entry of stored) this.#keep(entry);
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
   * Takeover (docs/scheduler.md): load the store, then check every task the
   * previous leader left reserved or placed against its machine's own
   * `sessions` — one call per machine — before the host's first `tick`
   * dispatches anything. Each is settled as a pass settles it (`settle`), except
   * that a reservation is checked at any age: a session or `ended` entry
   * carrying its id resolves it inside its TTL, and past the TTL an unanswered
   * check on a machine no longer connected makes it `lost`. A placed task whose
   * session is gone is `done` — it ended while no leader was listening. An
   * unanswered machine leaves everything else as it was.
   */
  async takeover(): Promise<void> {
    await this.load();
    this.#sweptAt = this.#now();
    await this.#check(this.tasks().filter((t) => t.state === "reserved" || PLACED.includes(t.state)));
  }

  /**
   * M2's queue is in memory and only grows, so past `keep` the oldest finished
   * tasks are deleted — never one with anything left to happen.
   */
  async prune(keep: number): Promise<void> {
    const finished = this.tasks()
      .filter((t) => FINISHED.includes(t.state))
      .toSorted((a, b) => a.createdAt - b.createdAt);
    for (const task of finished.slice(0, Math.max(0, finished.length - keep))) {
      // oxlint-disable-next-line no-await-in-loop -- a handful at a time, and each delete is its own CAS
      await this.#serial(task.id, async () => {
        const held = this.#held.get(task.id);
        if (held === undefined || !FINISHED.includes(held.task.state)) return;
        const write = await this.#store.delete(task.id, held.version);
        if (!write.ok) {
          this.#refused(task.id, "delete", write);
          return;
        }
        this.#held.delete(task.id);
        this.#decisions.delete(task.id);
      });
    }
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
      }),
    );
  }

  async submit(spec: TaskSpec): Promise<Task> {
    const task: Task = { id: this.#newId(), spec, state: "ready", createdAt: this.#now() };
    const write = await this.#store.put(task.id, 0, task);
    if (!write.ok) throw new Error(`task ${task.id} was not stored (${write.code})`);
    this.#held.set(task.id, { version: write.version, task });
    return task;
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
   * Resolves once no tick runs and no spawn is out, rejecting with the first
   * dispatch fault no `onError` took. For tests, and a host that wants quiet.
   */
  async drain(): Promise<void> {
    for (;;) {
      const out = [...this.#dispatches.values(), ...(this.#ticking === null ? [] : [this.#ticking])];
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
   * task is left to its verdict or its TTL.
   */
  async onSession(taskId: string, state: SessionState, from?: SessionSource): Promise<void> {
    const to: TaskState = state === "ended" ? "done" : state === "needs-input" ? "needs-input" : "running";
    await this.#update(taskId, (task) => sessionChange(task, to, from));
  }

  /**
   * A reserved task is mid-dispatch: its spawn may already be running, so it is
   * refused until the verdict lands rather than raced. A `lost` task whose
   * machine is back is despawned like a running one; with its machine still
   * gone nothing can be despawned, so it is cancelled as it stands and marked
   * `leftRunning` — the record says plainly that a session may outlive it. A
   * task that finishes while the despawn is out (its session reported `ended`
   * first) is answered as it finished.
   */
  async cancel(taskId: string): Promise<CancelResult> {
    const task = this.task(taskId);
    if (task === undefined) return { ok: false, code: "not_found" };
    const refused = cancelRefusal(task);
    if (refused !== null) return refused;
    const { assignment } = task;
    const leftRunning = task.state === "lost" && assignment !== undefined && !this.#connected(assignment.deviceId);
    if (assignment !== undefined && !leftRunning) {
      // A `task_running` verdict may name no pane; the machine's sessions still carry the task id.
      let pane = assignment.pane;
      if (pane === undefined) {
        const listed = await this.#fleet.sessions(assignment.deviceId);
        if (!listed.ok) return { ok: false, code: "despawn_failed" };
        pane = listed.sessions.find((s) => s.taskId === task.id)?.id;
      }
      if (pane !== undefined) {
        const reply = await this.#fleet.despawn(assignment.deviceId, { id: pane, client: SCHEDULER_CLIENT });
        if (!reply.ok && reply.code !== "session_not_found") return { ok: false, code: "despawn_failed" };
      }
    }
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
    });
    if (next === null) return outcome;
    this.#decisions.delete(taskId);
    return { ok: true, task: next };
  }

  #connected(deviceId: string): boolean {
    return this.#fleet.machines().some((m) => m.deviceId === deviceId && m.connected);
  }

  async #pass(): Promise<void> {
    await this.#markAbsent();
    await this.#check(this.#due());
    const ready = this.tasks()
      .filter((t) => t.state === "ready" && !this.#dispatches.has(t.id))
      .toSorted((a, b) => a.createdAt - b.createdAt);
    // Reserve one at a time, so each sees the reservations before it in projected
    // usage. The spawns are not awaited: one slow machine must not hold every
    // other placement, TTL and absence check behind its 90s timeout.
    for (const task of ready) {
      const now = this.#now();
      const decision = capped(
        route({
          task,
          machines: this.#fleet.machines(),
          tasks: this.tasks(),
          now,
          config: this.#config,
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
      this.#launch(reserved, reservation);
    }
  }

  #launch(task: Task, at: Reservation): void {
    const run = this.#dispatch(task, at)
      .catch(this.#onError)
      .finally(() => this.#dispatches.delete(task.id));
    this.#dispatches.set(task.id, run);
  }

  async #dispatch(task: Task, at: Reservation): Promise<void> {
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
    const devices = new Set(placed.flatMap((t) => t.assignment?.deviceId ?? []));
    for (const deviceId of [...this.#absentSince.keys()]) {
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
   * the better answer); a `lost` task whose machine is back; and, once per
   * `sweepIntervalMs`, every running task on a connected machine — the only
   * way a task whose `ended` event was lost ever finishes.
   */
  #due(): readonly Task[] {
    const now = this.#now();
    const connected = this.#connectedIds();
    const sweep = now - this.#sweptAt >= this.#config.sweepIntervalMs;
    if (sweep) this.#sweptAt = now;
    return this.tasks().filter((t) => {
      if (t.state === "reserved") {
        return t.reservation !== undefined && t.reservation.expiresAt <= now && !this.#dispatches.has(t.id);
      }
      const deviceId = t.assignment?.deviceId;
      if (!PLACED.includes(t.state) || deviceId === undefined || !connected.has(deviceId)) return false;
      return t.state === "lost" || sweep;
    });
  }

  /**
   * One `sessions` per machine the tasks name, then each settled from its
   * machine's answer (`settle`) — unless it moved while the call was out, since
   * an answer read before an event landed could undo it.
   */
  async #check(tasks: readonly Task[]): Promise<void> {
    const devices = new Set(tasks.flatMap((t) => deviceOf(t) ?? []));
    const replies = new Map(
      await Promise.all([...devices].map(async (id) => [id, await this.#fleet.sessions(id)] as const)),
    );
    await Promise.all(
      tasks.map(async (seen) => {
        const deviceId = deviceOf(seen);
        const reply = deviceId === undefined ? undefined : replies.get(deviceId);
        if (deviceId === undefined || reply === undefined) return;
        await this.#update(seen.id, (current) =>
          asSeen(current, seen)
            ? settle(current, reply, {
                now: this.#now(),
                connected: this.#connected(deviceId),
                reservationTtlMs: this.#config.reservationTtlMs,
              })
            : null,
        );
      }),
    );
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
   * winner, never the task cut. Null when `change` declines (it returns null
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
        const changed = change(held.task);
        if (changed === null) return null;
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
 * A task whose record would not fit: its decision cut to the candidate it chose,
 * the rest counted in `trimmed`. Everything else a record holds is bounded, so
 * this is the one cut that can make it fit (`STORE_MAX_CT_LENGTH`).
 */
function trimmed(task: Task): Task {
  const { decision } = task;
  if (decision === undefined) return task;
  const { chosen } = decision;
  const kept = decision.candidates.filter(
    (c) => chosen !== null && c.deviceId === chosen.deviceId && c.exclave === chosen.exclave,
  );
  const cut = decision.candidates.length - kept.length;
  if (cut === 0) return task;
  return { ...task, decision: { ...decision, candidates: kept, trimmed: (decision.trimmed ?? 0) + cut } };
}

/** What a settle reads besides the task and the machine's answer. */
interface Observed {
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

function deviceOf(task: Task): string | undefined {
  return (task.reservation ?? task.assignment)?.deviceId;
}

/** Still reserved under exactly `at`: not resolved by an event, nor released and reserved again. */
function holds(task: Task, at: Reservation): boolean {
  const { reservation } = task;
  return (
    task.state === "reserved" &&
    reservation !== undefined &&
    reservation.deviceId === at.deviceId &&
    reservation.expiresAt === at.expiresAt
  );
}

/** Where `seen` was when its machine was asked: a `sessions` answer speaks for that, and only that. */
function asSeen(current: Task, seen: Task): boolean {
  if (seen.state === "reserved") return seen.reservation !== undefined && holds(current, seen.reservation);
  return (
    PLACED.includes(current.state) &&
    PLACED.includes(seen.state) &&
    current.assignment?.deviceId === seen.assignment?.deviceId
  );
}

function cancelRefusal(task: Task): CancelResult | null {
  if (task.state === "reserved") return { ok: false, code: "dispatching" };
  if (FINISHED.includes(task.state)) return { ok: false, code: "finished" };
  // A state not finished and still without the edge is one M3 has not wired yet: a gap, not an input error.
  if (!canTransition(task.state, "cancelled"))
    throw new Error(`task ${task.id}: ${task.state} cannot be cancelled yet`);
  return null;
}

function sessionChange(task: Task, to: TaskState, from: SessionSource | undefined): Task | null {
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
function settle(task: Task, reply: TaskSessionsReply, at: Observed): Task | null {
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
function verdict(task: Task, at: Reservation, reply: TaskSpawnReply): Task | null {
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
