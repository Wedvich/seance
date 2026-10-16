import {
  MemoryQueueStore,
  Scheduler,
  UNREACHABLE,
  type Fleet,
  type QueueStore,
  type SchedulerConfig,
  type SessionState,
  type StoreWrite,
  type TaskSessionsReply,
  type Unreachable,
} from "@seance/scheduler";
import {
  quote,
  RequestFailure,
  type DespawnResponse,
  type Envelope,
  type ErrorResponse,
  type SessionsResponse,
  type SpawnResponse,
} from "@seance/shared";
import type { AppRelay } from "./app-relay.ts";
import type { LocalOps } from "./handlers.ts";
import { log } from "./log.ts";

/**
 * The scheduler role (docs/scheduler.md, "`leader.ts`"; DESIGN.md, Scheduler).
 * The only module in the daemon that imports `scheduler/` — the layering test
 * enforces it — so the library can move to a fixed box behind two new adapters.
 *
 * One term is one run: `lead { term }` builds an app-role leg of its own, the
 * `Fleet` over it, a `Scheduler`, and a tick timer; `follow`, the daemon's
 * relay socket dropping, or a `not_leader` answer ends it, and ending it stops
 * every one of those. Nothing of a term survives it — the broker's discipline.
 *
 * Why not `LazyRelay`: it hangs up after five idle minutes and redials on the
 * next call, which suits a Claude session calling hours apart and not a loop
 * that must hear every registry and `status` push between its own calls. Why
 * not the broker's: then either lifecycle could end the other's socket.
 */

// For the daemon's tests, which the layering rule keeps from importing `scheduler/` themselves.
export { MemoryQueueStore, type QueueStore, type Task } from "@seance/scheduler";

/** The library's own cadence for ready tasks (docs/scheduler.md, Routing). */
const TICK_INTERVAL_MS = 30_000;

/**
 * The term's app-role leg: the shared client built with `scheduler: { term }`,
 * so every request is sealed `from: "scheduler"` and carries the term the relay
 * fences on.
 */
export interface LeaderRelay extends AppRelay {
  /** A reply that the relay routed to this daemon's own socket, as every `to: "scheduler"` envelope is. */
  readonly deliver: (env: Envelope) => Promise<void>;
}

export interface LeaderOpts {
  /** This machine. The leader reaches it through `local`, never a relay round trip back to itself. */
  readonly selfDeviceId: string;
  /** A fresh leg per term, never shared with the broker or with another term. */
  readonly createRelay: (term: number) => LeaderRelay;
  /** This machine's ops, audited under origin `leader`. */
  readonly local: LocalOps;
  /**
   * Outlives terms, as the relay's store will (M3): a demoted-then-repromoted
   * daemon picks up what it left and reconciles it. Defaults to the library's
   * `MemoryQueueStore`, which is M2's queue.
   */
  readonly store?: QueueStore;
  readonly config?: SchedulerConfig;
  readonly tickIntervalMs?: number;
  readonly now?: () => number;
}

export interface Leader {
  /** A `lead` frame. The same term again is a no-op; a different one ends the current term first. */
  readonly lead: (term: number) => void;
  /** A `follow` frame or the daemon's relay socket dropping: ends the current term, if any. */
  readonly follow: (why: string) => void;
  /** An envelope `to: "scheduler"` from the daemon's relay leg; dropped unless a term is running. */
  readonly deliver: (env: Envelope) => void;
  /**
   * Item 5's entry point: a `session-event` the daemon has already bound to a
   * task. Dropped outside a running term — takeover reads the same state from
   * `sessions` — so it never queues behind a takeover in flight.
   */
  readonly onSession: (taskId: string, state: SessionState) => Promise<void>;
  /** The term being run, or null while following. */
  readonly term: () => number | null;
  /** Resolves once the current term has taken over and is ticking, or has ended; tests await it. */
  readonly settled: () => Promise<void>;
  readonly stop: () => void;
}

/** A write from a term that has ended: M3's relay answers it `not_leader`; here the store wrapper refuses it first. */
class TermEnded extends Error {
  constructor(term: number) {
    super(`scheduler term ${term} has ended`);
    this.name = "TermEnded";
  }
}

function unreachable(message: string): Unreachable {
  return { ok: false, code: UNREACHABLE, message };
}

/**
 * The library writes after awaits — a spawn verdict lands seconds later — so a
 * scheduler whose term ended mid-pass would otherwise write into a store the
 * next term already reads. Reads stay open: they change nothing.
 */
function fencedStore(inner: QueueStore, term: number, live: () => boolean): QueueStore {
  const fence = (write: () => Promise<StoreWrite>): Promise<StoreWrite> =>
    live() ? write() : Promise.reject(new TermEnded(term));
  return {
    list: () => inner.list(),
    get: (id) => inner.get(id),
    put: (id, expect, body) => fence(() => inner.put(id, expect, body)),
    delete: (id, expect) => fence(() => inner.delete(id, expect)),
  };
}

function sessionsOf(reply: SessionsResponse | ErrorResponse | Unreachable): TaskSessionsReply {
  return "ok" in reply ? reply : { ok: true, sessions: reply.sessions };
}

interface TermFleetOpts {
  readonly relay: LeaderRelay;
  readonly selfDeviceId: string;
  readonly local: LocalOps;
  readonly live: () => boolean;
  readonly demote: (why: string) => void;
}

/**
 * The `Fleet` over one term's leg. Every call is refused once the term ends,
 * the local ones included, so a stale pass cannot dispatch here either. "No
 * answer" of any kind — no route, a timeout, the leg stopping — is the
 * library's `unreachable`, which never fails a task; `not_leader` additionally
 * ends the term, since the relay has said it is someone else's.
 */
function termFleet(o: TermFleetOpts): Fleet {
  const remote = async <T>(deviceId: string, op: "spawn" | "sessions" | "despawn", payload: unknown) => {
    try {
      return await o.relay.request<T>(deviceId, op, payload);
    } catch (err) {
      if (!(err instanceof RequestFailure)) throw err;
      if (err.reason === "not_leader") o.demote(`the relay refused ${op} to ${quote(deviceId)} as not_leader`);
      return unreachable(err.message);
    }
  };
  const ended = unreachable("the scheduler term has ended");
  return {
    machines: () => o.relay.getState().machines,
    spawn: async (deviceId, request) => {
      if (!o.live()) return ended;
      if (deviceId === o.selfDeviceId) return o.local.spawn(request);
      return remote<SpawnResponse>(deviceId, "spawn", request);
    },
    sessions: async (deviceId) => {
      if (!o.live()) return ended;
      if (deviceId === o.selfDeviceId) return sessionsOf(await o.local.sessions());
      return sessionsOf(await remote<SessionsResponse>(deviceId, "sessions", {}));
    },
    despawn: async (deviceId, request) => {
      if (!o.live()) return ended;
      if (deviceId === o.selfDeviceId) return o.local.despawn(request);
      return remote<DespawnResponse>(deviceId, "despawn", request);
    },
  };
}

interface TermRun {
  readonly term: number;
  readonly settled: Promise<void>;
  readonly deliver: (env: Envelope) => void;
  readonly onSession: (taskId: string, state: SessionState) => Promise<void>;
  readonly end: () => void;
}

function report(err: unknown): void {
  // A pass the term's end cut short; the next term reconciles whatever it left.
  if (err instanceof TermEnded) return;
  log.warn(`scheduler: ${String(err)}`);
}

function startTerm(
  term: number,
  opts: LeaderOpts & { readonly store: QueueStore },
  demote: (why: string) => void,
): TermRun {
  let live = true;
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const relay = opts.createRelay(term);
  const isLive = (): boolean => live;
  const scheduler = new Scheduler({
    store: fencedStore(opts.store, term, isLive),
    fleet: termFleet({ relay, selfDeviceId: opts.selfDeviceId, local: opts.local, live: isLive, demote }),
    now: opts.now ?? Date.now,
    ...(opts.config === undefined ? {} : { config: opts.config }),
  });

  const tick = (): void => {
    if (live && running) scheduler.tick().catch(report);
  };

  // Takeover waits for an authoritative registry: before it, an empty machine
  // list means "no push yet", and reconciling against it would ask nobody.
  const fleetReady = Promise.withResolvers<void>();
  let seen = relay.getState().machines;
  const unsubscribe = relay.subscribe(() => {
    const state = relay.getState();
    // Terminal: the shared client never redials a rejected token, so the term
    // could only sit there unable to reach anyone.
    if (state.status === "rejected") {
      demote(`the relay rejected the leader's app-role leg (${state.rejection ?? "unknown"})`);
      return;
    }
    if (!running) {
      if (state.status === "open" && state.registrySettled) fleetReady.resolve();
      return;
    }
    if (state.machines !== seen) {
      seen = state.machines;
      tick();
    }
  });
  relay.start();

  const intervalMs = opts.tickIntervalMs ?? TICK_INTERVAL_MS;
  // Woken early by `end`, so a retry wait never outlives the term.
  let retry: { readonly timer: ReturnType<typeof setTimeout>; readonly wake: () => void } | null = null;
  const pause = (): Promise<void> =>
    new Promise((resolve) => {
      const wake = (): void => {
        if (retry !== null) clearTimeout(retry.timer);
        retry = null;
        resolve();
      };
      retry = { timer: setTimeout(wake, intervalMs), wake };
    });

  const settled = (async (): Promise<void> => {
    await fleetReady.promise;
    // The relay still names this daemon leader, so a takeover that failed is
    // retried rather than left as a term that holds the role and runs nothing.
    for (;;) {
      if (!live) return;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one attempt at a time, by design
        await scheduler.takeover();
        break;
      } catch (err) {
        if (err instanceof TermEnded) return;
        log.warn(`scheduler: term ${term} takeover failed, retrying in ${intervalMs}ms: ${String(err)}`);
      }
      // oxlint-disable-next-line no-await-in-loop -- the wait between attempts
      await pause();
    }
    if (!live) return;
    running = true;
    seen = relay.getState().machines;
    timer = setInterval(tick, intervalMs);
    log.info(`scheduler: term ${term} took over ${scheduler.tasks().length} tasks — dispatching`);
    tick();
  })().catch(report);

  return {
    term,
    settled,
    deliver: (env) => {
      if (live) relay.deliver(env).catch(report);
    },
    onSession: async (taskId, state) => {
      if (live && running) await scheduler.onSession(taskId, state).catch(report);
    },
    end: () => {
      live = false;
      running = false;
      fleetReady.resolve();
      retry?.wake();
      if (timer !== null) clearInterval(timer);
      timer = null;
      unsubscribe();
      // Fails whatever the term still had out as "disconnected" → `unreachable`,
      // and the fenced store refuses the writes those verdicts would make.
      relay.stop();
    },
  };
}

export function createLeader(options: LeaderOpts): Leader {
  const opts = { ...options, store: options.store ?? new MemoryQueueStore() };
  let current: TermRun | null = null;
  let stopped = false;

  const end = (why: string): void => {
    const run = current;
    if (run === null) return;
    current = null;
    run.end();
    log.info(`scheduler: term ${run.term} ended — ${why}`);
  };

  return {
    lead: (term) => {
      if (stopped || current?.term === term) return;
      end(`the relay nominated this daemon again under term ${term}`);
      log.info(`scheduler: leading under term ${term}`);
      // A holder, not a `const run`: a demote fired synchronously inside
      // `startTerm` (a leg rejected at start) would otherwise read it in its TDZ.
      const self: { run: TermRun | null; early: string | null } = { run: null, early: null };
      const run = startTerm(term, opts, (why) => {
        // Only the run that asked: a late not_leader from an ended term must not end its successor.
        if (self.run === null) self.early ??= why;
        else if (current === self.run) end(why);
      });
      self.run = run;
      current = run;
      if (self.early !== null) end(self.early);
    },
    follow: (why) => end(why),
    deliver: (env) => {
      if (current === null) {
        log.warn(`wire dropped iv=${quote(env.iv)} from=${quote(env.from)} reason=not-leading`);
        return;
      }
      current.deliver(env);
    },
    onSession: async (taskId, state) => current?.onSession(taskId, state),
    term: () => current?.term ?? null,
    settled: async () => current?.settled,
    stop: () => {
      stopped = true;
      end("the daemon is stopping");
    },
  };
}
