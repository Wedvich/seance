import type { SessionState } from "@seance/shared";
import { DEFAULT_CONFIG, type SchedulerConfig } from "./config.ts";
import { UNREACHABLE, type Fleet, type QueueStore, type TaskSessionsReply, type TaskSpawnReply } from "./ports.ts";
import { route, type Decision } from "./route.ts";
import {
  advance,
  IN_FLIGHT,
  type Assignment,
  type Reservation,
  type Task,
  type TaskSpec,
  type TaskState,
} from "./task.ts";

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
  | { readonly ok: false; readonly code: "not_found" | "dispatching" | "finished" | "despawn_failed" | "conflict" };

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
   * carrying its id counts at any age. A running task whose session is gone
   * ended while no leader was listening, so it is `done` (M2 has no done
   * detection). An unanswered machine leaves its running tasks as they are.
   */
  async takeover(): Promise<void> {
    await this.load();
    const inFlight = this.tasks().filter((t) => IN_FLIGHT.includes(t.state));
    const machines = new Set(inFlight.flatMap((t) => (t.reservation ?? t.assignment)?.deviceId ?? []));
    const replies = new Map(
      await Promise.all([...machines].map(async (id) => [id, await this.#fleet.sessions(id)] as const)),
    );
    await Promise.all(
      inFlight.map(async (task) => {
        const at = task.reservation;
        if (at !== undefined) {
          const reply = replies.get(at.deviceId);
          if (reply !== undefined) await this.#reconcileReserved(task.id, at, reply);
          return;
        }
        const reply = task.assignment === undefined ? undefined : replies.get(task.assignment.deviceId);
        if (reply?.ok !== true || reply.sessions.some((s) => s.taskId === task.id)) return;
        const current = this.task(task.id);
        if (current?.state === "running" || current?.state === "needs-input") {
          await this.#write(current, advance(current, "done"));
        }
      }),
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
    if (task.state !== "running" && task.state !== "needs-input") return;
    if (from !== undefined && task.assignment !== undefined && from.deviceId !== task.assignment.deviceId) return;
    await this.#write(task, advance(task, to));
  }

  /**
   * A reserved task is mid-dispatch: its spawn may already be running, so it is
   * refused until the verdict lands rather than raced.
   */
  async cancel(taskId: string): Promise<CancelResult> {
    const task = this.task(taskId);
    if (task === undefined) return { ok: false, code: "not_found" };
    if (task.state === "reserved") return { ok: false, code: "dispatching" };
    if (task.state !== "ready" && task.state !== "running" && task.state !== "needs-input") {
      return { ok: false, code: "finished" };
    }
    const { assignment } = task;
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
    const next = await this.#write(task, advance(task, "cancelled"));
    if (next === null) return { ok: false, code: "conflict" };
    this.#decisions.delete(taskId);
    return { ok: true, task: next };
  }

  async #pass(): Promise<void> {
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
      const reserved = await this.#write(task, advance(task, "reserved", { reservation, decision }));
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

  /** Past its TTL, a reservation with no verdict is resolved from the machine's own `sessions`. */
  async #resolveExpired(task: Task): Promise<void> {
    const at = task.reservation;
    if (at === undefined || at.expiresAt > this.#now()) return;
    await this.#reconcileReserved(task.id, at, await this.#fleet.sessions(at.deviceId));
  }

  /**
   * A session carrying the task id is the spawn that landed. A task id in the
   * reply's `ended` is one that landed and already finished: done, never
   * re-routed — its reply and its `ended` event were both lost, and its session
   * is gone, so `task_running` could not catch a second spawn. With neither,
   * the reservation stands until its TTL and is released past it. An unanswered
   * check keeps waiting while the machine is connected and releases an expired
   * one once it is not — the daemon's `task_running` is the backstop for a
   * machine that comes back still running it.
   */
  async #reconcileReserved(id: string, at: Reservation, reply: TaskSessionsReply): Promise<void> {
    const current = this.task(id);
    if (current?.state !== "reserved") return;
    const expired = at.expiresAt <= this.#now();
    if (!reply.ok) {
      const connected = this.#fleet.machines().some((m) => m.deviceId === at.deviceId && m.connected);
      if (expired && !connected) await this.#write(current, advance(current, "ready"));
      return;
    }
    const session = reply.sessions.find((s) => s.taskId === id);
    if (session === undefined) {
      if (reply.ended?.includes(id) === true) {
        const target: Assignment = { deviceId: at.deviceId, exclave: at.exclave, clone: at.clone };
        await this.#write(current, advance(current, "done", { assignment: target }));
        return;
      }
      if (expired) await this.#write(current, advance(current, "ready"));
      return;
    }
    const assignment: Assignment = {
      deviceId: at.deviceId,
      exclave: at.exclave,
      clone: at.clone,
      window: session.window,
      ...(session.id === undefined ? {} : { pane: session.id }),
    };
    await this.#write(current, advance(current, "running", { assignment }));
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
