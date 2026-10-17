import {
  MemoryQueueStore,
  StoreRevoked,
  Scheduler,
  type QueueStore,
  type SchedulerConfig,
  type SessionSource,
} from "@seance/scheduler";
import {
  APP_ID,
  isSchedulerOp,
  parseBranchState,
  parseSessionEvent,
  quote,
  type BranchState,
  type Envelope,
  type Plain,
  type SchedulerEventHandler,
  type SessionState,
} from "@seance/shared";
import type { AppRelay } from "./app-relay.ts";
import type { LocalOps } from "./handlers.ts";
import { fencedStore, termFleet } from "./leader-adapters.ts";
import { requestHandler } from "./leader-requests.ts";
import { log } from "./log.ts";

/**
 * The scheduler role (docs/scheduler.md, "`leader.ts`"; DESIGN.md, Scheduler):
 * the term lifecycle and the daemon's entry to it. With its store and fleet
 * adapters (`leader-adapters.ts`) and its app-request handlers
 * (`leader-requests.ts`), the only daemon modules that import `scheduler/`
 * — `LEADER_MODULES` in the layering test enforces it — so the library can move to a
 * fixed box behind two new adapters.
 *
 * One term is one run: `lead { term }` builds an app-role leg of its own, the
 * `Fleet` over it, a `Scheduler`, and a tick timer. `follow`, the daemon's
 * relay socket dropping, a `not_leader` answer, the leg's token rejected
 * (which also resigns the role, since the relay cannot know) or `stop` ends
 * it, and ending it stops every one of those. Nothing of a term survives it — the broker's discipline.
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
  /**
   * A fresh leg per term, never shared with the broker or with another term.
   * `onEvent` is what the leg hands an envelope that answers nothing — a
   * daemon's `session-event` — once it has opened and replay-checked it.
   */
  readonly createRelay: (term: number, onEvent: SchedulerEventHandler) => LeaderRelay;
  /** This machine's ops, audited under origin `leader`. */
  readonly local: LocalOps;
  /**
   * Sends one answer to an app's scheduler request, over the daemon's own
   * socket, sealed from this machine (`RelayClient.reply` in `relay-client.ts`).
   * Not the term's leg: an answer must also go out while the leg is still
   * dialling, and it writes nothing the term fence exists to stop.
   */
  readonly reply: (to: string, response: Plain) => Promise<boolean>;
  /**
   * Tells the relay this daemon gave the role up, for a term it ended on its
   * own — the relay hears nothing else of it (`RelayClient.resign`).
   */
  readonly resign: () => void;
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
  /**
   * An envelope `to: "scheduler"` from the daemon's relay leg. False when no
   * term runs, so the transport can answer an app's request `not_leader`
   * instead of leaving it to time out.
   */
  readonly deliver: (env: Envelope) => boolean;
  /**
   * A `session-event` from this machine, in process (`run.ts`): the leader
   * reaches itself only locally. Other machines' arrive through the term's leg.
   * `from` is where the event came from, which is what lets one resolve a task
   * still reserved (`Scheduler.onSession`). Dropped outside a running term —
   * takeover reads the same state from `sessions` — so it never queues behind
   * a takeover in flight.
   */
  readonly onSession: (taskId: string, state: SessionState, from?: SessionSource) => Promise<void>;
  /**
   * A `branch-state` from this machine, in process (`run.ts`), as `onSession`
   * is; other machines' arrive through the term's leg. `from` is the sealing
   * daemon (one sealed `from: "app"` is dropped). A sink until the library takes branch state in (M3 item 3).
   */
  readonly onBranchState: (state: BranchState, from: string) => void;
  /** The term being run, or null while following. */
  readonly term: () => number | null;
  /** Resolves once the current term has taken over and is ticking, or has ended; tests await it. */
  readonly settled: () => Promise<void>;
  readonly stop: () => void;
}

interface TermRun {
  readonly term: number;
  readonly settled: Promise<void>;
  readonly deliver: (env: Envelope) => void;
  readonly onSession: (taskId: string, state: SessionState, from?: SessionSource) => Promise<void>;
  readonly onBranchState: (state: BranchState, from: string) => void;
  readonly end: () => void;
}

/**
 * Why a term ends itself. `resign` is set when the relay cannot know: it still
 * names this daemon, so without being told it would route every `auto` here
 * until the daemon's socket next drops.
 */
interface Demotion {
  readonly why: string;
  readonly resign: boolean;
}

// Deliberately a no-op: item 3 feeds it to the library (`Scheduler` has no branch-state entry until 4a adds one).
function onBranchState(_state: BranchState, _from: string): void {}

function report(err: unknown): void {
  // A pass the term's end cut short; the next term reconciles whatever it left.
  if (err instanceof StoreRevoked) return;
  log.warn(`scheduler: ${String(err)}`);
}

function startTerm(
  term: number,
  opts: LeaderOpts & { readonly store: QueueStore },
  demote: (demotion: Demotion) => void,
): TermRun {
  let live = true;
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const now = opts.now ?? Date.now;
  // Declared before the leg that calls it; it reads `scheduler` only once a term is running.
  const onSession = async (taskId: string, state: SessionState, from?: SessionSource): Promise<void> => {
    if (live && running) await scheduler.onSession(taskId, state, from).catch(report);
  };
  // Like `onSession`, built before the leg and reading `scheduler` and `tick` only once running.
  const onRequest = requestHandler({
    term,
    scheduler: () => scheduler,
    running: () => running,
    now,
    tick: () => tick(),
    reply: opts.reply,
  });
  // What another daemon or an app sent the scheduler, already opened and
  // replay-checked by the leg. The sealer's id is AAD-bound; an event's fields
  // are its daemon's own binding, re-validated here — the PR URL above all.
  const onEvent: SchedulerEventHandler = (plain, from) => {
    if (isSchedulerOp(plain.op)) {
      onRequest(plain, plain.op, from).catch(report);
      return;
    }
    // Only a daemon observes branches: an app's would let any holder of the PSK settle a task done.
    if (plain.op === "branch-state" && from !== APP_ID) {
      const branchState = parseBranchState(plain.payload);
      if (branchState !== null) {
        onBranchState(branchState, from);
        return;
      }
    }
    const event = plain.op === "session-event" ? parseSessionEvent(plain.payload) : null;
    if (event === null) {
      log.warn(`scheduler: dropped op=${quote(plain.op)} from=${quote(from)} — not a session event or branch state`);
      return;
    }
    void onSession(event.taskId, event.state, { deviceId: from, pane: event.session });
  };
  const relay = opts.createRelay(term, onEvent);
  const isLive = (): boolean => live;
  const scheduler = new Scheduler({
    store: fencedStore(opts.store, term, isLive),
    fleet: termFleet({
      relay,
      selfDeviceId: opts.selfDeviceId,
      local: opts.local,
      live: isLive,
      demote: (why) => demote({ why, resign: false }),
    }),
    now,
    onError: report,
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
    // could only sit there unable to reach anyone. The relay still names this
    // daemon, though — nothing it can see changed — so the role goes back.
    if (state.status === "rejected") {
      demote({ why: `the relay rejected the leader's app-role leg (${state.rejection ?? "unknown"})`, resign: true });
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
        if (err instanceof StoreRevoked) return;
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
    onSession,
    onBranchState,
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

  const demoted = (demotion: Demotion): void => {
    end(demotion.why);
    if (demotion.resign) opts.resign();
  };

  return {
    lead: (term) => {
      if (stopped || current?.term === term) return;
      end(`the relay nominated this daemon again under term ${term}`);
      log.info(`scheduler: leading under term ${term}`);
      // A holder, not a `const run`: a demote fired synchronously inside
      // `startTerm` (a leg rejected at start) would otherwise read it in its TDZ.
      const self: { run: TermRun | null; early: Demotion | null } = { run: null, early: null };
      const run = startTerm(term, opts, (demotion) => {
        // Only the run that asked: a late not_leader from an ended term must not end its successor.
        if (self.run === null) self.early ??= demotion;
        else if (current === self.run) demoted(demotion);
      });
      self.run = run;
      current = run;
      if (self.early !== null) demoted(self.early);
    },
    follow: (why) => end(why),
    deliver: (env) => {
      if (current === null) return false;
      current.deliver(env);
      return true;
    },
    onSession: async (taskId, state, from) => current?.onSession(taskId, state, from),
    onBranchState: (state, from) => current?.onBranchState(state, from),
    term: () => current?.term ?? null,
    settled: async () => current?.settled,
    stop: () => {
      stopped = true;
      end("the daemon is stopping");
    },
  };
}
