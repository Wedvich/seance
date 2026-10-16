import { REPLAY_WINDOW_MS, type SessionState, type TaskFailureCode } from "@seance/shared";
import { DEFAULT_CONFIG, type SchedulerConfig } from "./config.ts";
import { UNREACHABLE, type Fleet, type QueueStore, type TaskSessionsReply, type TaskSpawnReply } from "./ports.ts";
import { route, type Decision } from "./route.ts";
import {
  advance,
  FINISHED,
  IN_FLIGHT,
  isUnconfirmed,
  type Assignment,
  type Reservation,
  type Target,
  type Task,
  type TaskSpec,
  type TaskState,
} from "./task.ts";

type SessionsAnswer = Extract<TaskSessionsReply, { readonly ok: true }>;

/** States of a task whose session was placed on a machine and may still be running there. */
const PLACED: ReadonlySet<TaskState> = new Set(["running", "needs-input", "lost"]);

/** The `client` a scheduler spawn audits as: `origin=relay client=scheduler` (Settled defaults 3). */
export const SCHEDULER_CLIENT = "scheduler";

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
 * registry or status push and on a 30s timer while tasks are ready. It owns no
 * timer, socket or clock, so a host that stops calling it leaves nothing running.
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
  readonly #held = new Map<string, Held>();
  readonly #decisions = new Map<string, Decision>();
  /**
   * deviceId → when a pass first saw it not connected (or gone from the
   * registry), for machines holding placed tasks. Memory only: a new leader
   * starts the count again, which can only delay `lost`, never hasten it — and
   * it is this clock, not `Machine.lastSeen`, because a timeout's offline mark
   * can make a machine read disconnected beside a `lastSeen` hours old.
   */
  readonly #absentSince = new Map<string, number>();
  #ticking: Promise<void> | null = null;
  #again = false;

  constructor(options: SchedulerOptions) {
    this.#store = options.store;
    this.#fleet = options.fleet;
    this.#config = options.config ?? DEFAULT_CONFIG;
    this.#now = options.now;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** The store's view replaces this one, unreconciled — a new leader calls `takeover` instead. */
  async load(): Promise<void> {
    const stored = await this.#store.list();
    this.#held.clear();
    this.#decisions.clear();
    for (const { id, version, body } of stored) this.#held.set(id, { version, task: body });
  }

  /**
   * Takeover (docs/scheduler.md): load the store, then check every task the
   * previous leader left in flight against its machine's own `sessions` — one
   * call per machine — before the host's first `tick` dispatches anything. A
   * reservation is settled as the TTL check settles one, except that a session
   * carrying its id counts at any age. A placed task is settled from its
   * machine's sessions (`#settlePlaced`): gone is `done`, since it ended while
   * no leader was listening (M2 has no done detection), and a `lost` one whose
   * session is there runs again; a `lost` one never confirmed is settled as
   * its reservation would have been. An unanswered machine leaves its tasks as
   * they are.
   */
  async takeover(): Promise<void> {
    await this.load();
    const pending = this.tasks().filter((t) => IN_FLIGHT.includes(t.state) || t.state === "lost");
    const machines = new Set(pending.flatMap((t) => (t.reservation ?? t.assignment)?.deviceId ?? []));
    const replies = new Map(
      await Promise.all([...machines].map(async (id) => [id, await this.#fleet.sessions(id)] as const)),
    );
    await Promise.all(
      pending.map(async (task) => {
        const at = task.reservation;
        if (at !== undefined) {
          const reply = replies.get(at.deviceId);
          if (reply !== undefined) await this.#reconcileReserved(task.id, at, reply);
          return;
        }
        const reply = task.assignment === undefined ? undefined : replies.get(task.assignment.deviceId);
        if (reply !== undefined) await this.#settlePlaced(task.id, reply);
      }),
    );
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
      const held = this.#held.get(task.id);
      if (held === undefined) continue;
      // oxlint-disable-next-line no-await-in-loop -- a handful at a time, and each delete is its own CAS
      const write = await this.#store.delete(task.id, held.version);
      if (!write.ok) continue;
      this.#held.delete(task.id);
      this.#decisions.delete(task.id);
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
    return route({
      task,
      machines: this.#fleet.machines(),
      tasks: this.tasks(),
      now: this.#now(),
      config: this.#config,
    });
  }

  async submit(spec: TaskSpec): Promise<Task> {
    const task: Task = { id: this.#newId(), spec, state: "ready", createdAt: this.#now() };
    const write = await this.#store.put(task.id, 0, task);
    if (!write.ok) throw new Error(`task id ${task.id} already exists`);
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
   * A session's state, from a `session-event`. For a reserved task it is proof
   * the spawn landed — the reply may be lost — so it resolves the reservation:
   * the assignment is the reservation's target plus the reporting pane. `from`
   * is checked against where the task was placed, so a machine can move only
   * the tasks it was given; without `from` (a host that cannot say) a reserved
   * task is left to its verdict or its TTL.
   */
  async onSession(taskId: string, state: SessionState, from?: SessionSource): Promise<void> {
    const task = this.task(taskId);
    if (task === undefined) return;
    const to: TaskState = state === "ended" ? "done" : state === "needs-input" ? "needs-input" : "running";
    if (task.state === to) return;
    if (task.state === "reserved") {
      const at = task.reservation;
      if (at === undefined || from === undefined || from.deviceId !== at.deviceId) return;
      const assignment: Assignment = { deviceId: at.deviceId, exclave: at.exclave, clone: at.clone, pane: from.pane };
      await this.#write(task, advance(task, to, { assignment }));
      return;
    }
    // A lost task's machine speaking for it is the proof `lost` waits for.
    if (task.state !== "running" && task.state !== "needs-input" && task.state !== "lost") return;
    // Never confirmed, it is a reservation still: only its own machine, named, may resolve it.
    if (isUnconfirmed(task) && from === undefined) return;
    const { assignment } = task;
    if (from !== undefined && assignment !== undefined && from.deviceId !== assignment.deviceId) return;
    // An assignment with no pane (never confirmed, or a `task_running` verdict) takes the event's.
    const named = assignment !== undefined && assignment.pane === undefined && from !== undefined;
    await this.#write(task, advance(task, to, named ? { assignment: { ...assignment, pane: from.pane } } : {}));
  }

  /**
   * A reserved task is mid-dispatch: its spawn may already be running, so it is
   * refused until the verdict lands rather than raced. A `lost` task whose
   * machine is back is despawned like a running one; with its machine still
   * gone nothing can be despawned, so it is cancelled as it stands and marked
   * `leftRunning` — the record says plainly that a session may outlive it.
   */
  async cancel(taskId: string): Promise<CancelResult> {
    const task = this.task(taskId);
    if (task === undefined) return { ok: false, code: "not_found" };
    if (task.state === "reserved") return { ok: false, code: "dispatching" };
    if (task.state !== "ready" && task.state !== "running" && task.state !== "needs-input" && task.state !== "lost") {
      return { ok: false, code: "finished" };
    }
    const { assignment } = task;
    if (task.state === "lost" && assignment !== undefined && !this.#connected(assignment.deviceId)) {
      return this.#cancelled(task, advance(task, "cancelled", { leftRunning: true }));
    }
    if (assignment !== undefined) {
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
    return this.#cancelled(task, advance(task, "cancelled"));
  }

  async #cancelled(task: Task, cancelled: Task): Promise<CancelResult> {
    const next = await this.#write(task, cancelled);
    if (next === null) return { ok: false, code: "conflict" };
    this.#decisions.delete(task.id);
    return { ok: true, task: next };
  }

  #connected(deviceId: string): boolean {
    return this.#fleet.machines().some((m) => m.deviceId === deviceId && m.connected);
  }

  async #pass(): Promise<void> {
    await this.#watchAbsence();
    await Promise.all(
      this.tasks()
        .filter((t) => t.state === "reserved")
        .map((t) => this.#resolveExpired(t)),
    );
    const ready = this.tasks()
      .filter((t) => t.state === "ready")
      .toSorted((a, b) => a.createdAt - b.createdAt);
    // Reserve one at a time, so each sees the reservations before it in projected usage;
    // the spawns then run together.
    const dispatches: Promise<void>[] = [];
    for (const task of ready) {
      const now = this.#now();
      const decision = route({
        task,
        machines: this.#fleet.machines(),
        tasks: this.tasks(),
        now,
        config: this.#config,
      });
      this.#decisions.set(task.id, decision);
      if (decision.chosen === null) continue;
      const reservation: Reservation = { ...decision.chosen, expiresAt: now + this.#config.reservationTtlMs };
      // oxlint-disable-next-line no-await-in-loop -- each route must see the reservation before it
      const reserved = await this.#write(task, advance(task, "reserved", { reservation, decision, reservedAt: now }));
      if (reserved === null) continue;
      this.#decisions.delete(task.id);
      dispatches.push(this.#dispatch(reserved, reservation));
    }
    await Promise.all(dispatches);
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
    const current = this.task(task.id);
    if (current?.state !== "reserved") return;
    const next = verdict(current, at, reply);
    if (next !== null) await this.#write(current, next);
  }

  /**
   * A placed task on a machine that stops answering is never routed again: its
   * session may be alive on a machine that only sleeps, and a second dispatch
   * would be its twin. Absent past `lostAfterMs` it is `lost`, so the record
   * says so instead of reading `running` forever; once its machine is
   * connected again, that machine's `sessions` settles it.
   */
  async #watchAbsence(): Promise<void> {
    const now = this.#now();
    const connected = new Set(
      this.#fleet
        .machines()
        .filter((m) => m.connected)
        .map((m) => m.deviceId),
    );
    const placed = this.tasks().filter((t) => PLACED.has(t.state) && t.assignment !== undefined);
    const devices = new Set(placed.flatMap((t) => t.assignment?.deviceId ?? []));
    for (const deviceId of [...this.#absentSince.keys()]) {
      if (!devices.has(deviceId) || connected.has(deviceId)) this.#absentSince.delete(deviceId);
    }
    for (const deviceId of devices) {
      if (!connected.has(deviceId) && !this.#absentSince.has(deviceId)) this.#absentSince.set(deviceId, now);
    }

    const lost: Promise<unknown>[] = [];
    const recover = new Set<string>();
    for (const task of placed) {
      const deviceId = task.assignment?.deviceId ?? "";
      if (task.state === "lost") {
        if (connected.has(deviceId)) recover.add(deviceId);
        continue;
      }
      const since = this.#absentSince.get(deviceId);
      if (since !== undefined && now - since >= this.#config.lostAfterMs) {
        lost.push(this.#write(task, advance(task, "lost", { absentSince: since })));
      }
    }
    await Promise.all(lost);
    await Promise.all(
      [...recover].map(async (deviceId) => {
        const reply = await this.#fleet.sessions(deviceId);
        const back = this.tasks().filter((t) => t.state === "lost" && t.assignment?.deviceId === deviceId);
        await Promise.all(back.map((t) => this.#settlePlaced(t.id, reply)));
      }),
    );
  }

  /**
   * A placed task against its machine's own `sessions`: a session carrying its
   * id is the task still running (a `lost` one runs again, on the pane listed
   * now); none is a session that ended while nobody listened — `done`, whether
   * or not `ended` still remembers it. A `lost` task never confirmed is not
   * placed but a reservation its machine kept, and settles as one
   * (`#settleUnconfirmed`). An unanswered check changes nothing.
   */
  async #settlePlaced(id: string, reply: TaskSessionsReply): Promise<void> {
    const current = this.task(id);
    if (current === undefined || !PLACED.has(current.state) || !reply.ok) return;
    if (isUnconfirmed(current) && current.assignment !== undefined) {
      const { deviceId, exclave, clone } = current.assignment;
      await this.#settleUnconfirmed(current, { deviceId, exclave, clone }, reply);
      return;
    }
    const session = reply.sessions.find((s) => s.taskId === id);
    if (session === undefined) {
      await this.#write(current, advance(current, "done"));
      return;
    }
    if (current.state !== "lost" || current.assignment === undefined) return;
    const { window: _window, pane: _pane, ...target } = current.assignment;
    const assignment: Assignment = {
      ...target,
      window: session.window,
      ...(session.id === undefined ? {} : { pane: session.id }),
    };
    await this.#write(current, advance(current, "running", { assignment }));
  }

  /** Past its TTL, a reservation with no verdict is resolved from the machine's own `sessions`. */
  async #resolveExpired(task: Task): Promise<void> {
    const at = task.reservation;
    if (at === undefined || at.expiresAt > this.#now()) return;
    await this.#reconcileReserved(task.id, at, await this.#fleet.sessions(at.deviceId));
  }

  /**
   * Before its TTL only a session carrying the task id, or the id in `ended`,
   * resolves a reservation; anything else is a spawn still on its way. Past it
   * the machine's answer settles it (`#settleUnconfirmed`). An unanswered check
   * keeps waiting while the machine is connected; once it is not, the task is
   * `lost` on that machine — never released to `ready` on a silence, since a
   * machine that only sleeps may wake still running it, and `task_running`
   * guards only a re-dispatch to that same machine.
   */
  async #reconcileReserved(id: string, at: Reservation, reply: TaskSessionsReply): Promise<void> {
    const current = this.task(id);
    if (current?.state !== "reserved") return;
    const expired = at.expiresAt <= this.#now();
    const target: Target = { deviceId: at.deviceId, exclave: at.exclave, clone: at.clone };
    if (!reply.ok) {
      if (!expired || this.#connected(at.deviceId)) return;
      const reservedAt = current.reservedAt ?? at.expiresAt - this.#config.reservationTtlMs;
      await this.#write(
        current,
        advance(current, "lost", { assignment: target, absentSince: this.#now(), reservedAt }),
      );
      return;
    }
    const known = reply.sessions.some((s) => s.taskId === id) || reply.ended?.includes(id) === true;
    if (!known && !expired) return;
    await this.#settleUnconfirmed(current, target, reply);
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
  async #settleUnconfirmed(current: Task, target: Target, reply: SessionsAnswer): Promise<void> {
    const session = reply.sessions.find((s) => s.taskId === current.id);
    if (session !== undefined) {
      const assignment: Assignment = {
        ...target,
        window: session.window,
        ...(session.id === undefined ? {} : { pane: session.id }),
      };
      await this.#write(current, advance(current, "running", { assignment }));
      return;
    }
    if (reply.ended?.includes(current.id) === true) {
      await this.#write(current, advance(current, "done", { assignment: target }));
      return;
    }
    if (provesNeverLanded(reply, current.reservedAt)) {
      await this.#write(current, advance(current, "ready"));
      return;
    }
    const why =
      reply.ledgerSince === undefined
        ? "its machine keeps no launch ledger"
        : "its machine's launch ledger no longer reaches back to the reservation";
    const failure: { readonly code: TaskFailureCode; readonly message: string } = {
      code: "dispatch_unconfirmed",
      message: `the spawn was never confirmed and ${why}, so it may have started — not dispatched again`,
    };
    await this.#write(current, advance(current, "failed", { assignment: target, failure }));
  }

  /**
   * Null when `task` is no longer the held copy (it moved while the caller
   * awaited) or on a version conflict, after which the held copy is refreshed
   * from the store. The identity check is what stops a stale `next` — say a
   * reservation routed from a snapshot taken before a cancel — overwriting it.
   */
  async #write(task: Task, next: Task): Promise<Task | null> {
    const held = this.#held.get(task.id);
    if (held === undefined || held.task !== task) return null;
    const write = await this.#store.put(task.id, held.version, next);
    if (write.ok) {
      this.#held.set(task.id, { version: write.version, task: next });
      return next;
    }
    const fresh = await this.#store.get(task.id);
    if (fresh === null) this.#held.delete(task.id);
    else this.#held.set(task.id, { version: fresh.version, task: fresh.body });
    return null;
  }
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
 * started or already running → `running`; a daemon refusal → `failed`; no
 * answer, or a transport error that may have come after the spawn ran → stay
 * reserved until the TTL check reads `sessions`.
 */
function verdict(task: Task, at: Reservation, reply: TaskSpawnReply): Task | null {
  const target = { deviceId: at.deviceId, exclave: at.exclave, clone: at.clone };
  if (reply.ok) {
    // Path alone is ambiguous: every `here` session in a clone shares it.
    const pane = reply.sessions.find((s) => s.path === reply.path && s.window === reply.window)?.id;
    return advance(task, "running", {
      assignment: { ...target, window: reply.window, ...(pane === undefined ? {} : { pane }) },
    });
  }
  if (reply.code === "task_running") {
    const pane = "id" in reply ? reply.id : undefined;
    return advance(task, "running", { assignment: { ...target, ...(pane === undefined ? {} : { pane }) } });
  }
  if (reply.code === UNREACHABLE || reply.code === "internal_error" || reply.code === "too_large") return null;
  return advance(task, "failed", { failure: { code: reply.code, message: reply.message } });
}
