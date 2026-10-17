import {
  FINISHED,
  MemoryQueueStore,
  StoreRevoked,
  Scheduler,
  UNDELIVERED,
  type CancelResult,
  UNREACHABLE,
  type Fleet,
  type NoAnswer,
  type QueueStore,
  type SchedulerConfig,
  type SessionSource,
  type StoreWrite,
  type TaskSessionsReply,
  type Undelivered,
  type Unreachable,
  winnerOnly,
} from "@seance/scheduler";
import {
  APP_ID,
  isSchedulerOp,
  MAX_ACTIVE_TASKS,
  parseBranchState,
  parseSessionEvent,
  parseTaskRef,
  parseTaskRequest,
  QUEUE_MAX_TASKS,
  QUEUE_PROMPT_PREVIEW,
  quote,
  RequestFailure,
  type BranchState,
  type Decision,
  type DespawnResponse,
  type Envelope,
  type ErrorResponse,
  type FailureReason,
  type Plain,
  type QueueResponse,
  type RoutePreviewResponse,
  type SchedulerError,
  type SchedulerErrorCode,
  type SchedulerEventHandler,
  type SchedulerOp,
  type SessionsResponse,
  type SessionState,
  type SpawnResponse,
  type SubmitResponse,
  type Task,
  type TaskResponse,
} from "@seance/shared";
import type { AppRelay } from "./app-relay.ts";
import { daemonSink, queueAudit } from "./audit.ts";
import type { LocalOps } from "./handlers.ts";
import { log } from "./log.ts";

/**
 * The scheduler role (docs/scheduler.md, "`leader.ts`"; DESIGN.md, Scheduler).
 * The only module in the daemon that imports `scheduler/` — the layering test
 * enforces it — so the library can move to a fixed box behind two new adapters.
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

const audit = queueAudit(daemonSink);

/** M2's in-memory queue keeps this many finished tasks for `queue` to show; older ones are pruned on submit. */
const KEEP_FINISHED = 50;

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

function unreachable(message: string): Unreachable {
  return { ok: false, code: UNREACHABLE, message };
}

function undelivered(message: string): Undelivered {
  return { ok: false, code: UNDELIVERED, message };
}

/**
 * The library writes after awaits — a spawn verdict lands seconds later — so a
 * scheduler whose term ended mid-pass would otherwise write into a store the
 * next term already reads. Reads stay open: they change nothing.
 */
function fencedStore(inner: QueueStore, term: number, live: () => boolean): QueueStore {
  // What M3's relay answers a write from an ended term (`not_leader`), refused here first.
  const fence = (write: () => Promise<StoreWrite>): Promise<StoreWrite> =>
    live() ? write() : Promise.reject(new StoreRevoked(`scheduler term ${term} has ended`));
  return {
    list: () => inner.list(),
    get: (id) => inner.get(id),
    put: (id, expect, body) => fence(() => inner.put(id, expect, body)),
    delete: (id, expect) => fence(() => inner.delete(id, expect)),
    getPause: () => inner.getPause(),
    putPause: (expect, holds) => fence(() => inner.putPause(expect, holds)),
  };
}

function sessionsOf(reply: SessionsResponse | ErrorResponse | NoAnswer): TaskSessionsReply {
  if ("ok" in reply) return reply;
  const { sessions, ended, ledgerSince } = reply;
  // A proof that does not parse proves nothing: the task then fails rather than risk a twin.
  const proof = typeof ledgerSince === "number" && Number.isFinite(ledgerSince) ? { ledgerSince } : {};
  return { ok: true, sessions, ...(ended === undefined ? {} : { ended }), ...proof };
}

interface TermFleetOpts {
  readonly relay: LeaderRelay;
  readonly selfDeviceId: string;
  readonly local: LocalOps;
  readonly live: () => boolean;
  readonly demote: (why: string) => void;
}

/**
 * Failures that prove the request never reached its machine: the relay
 * declined delivery, or there was no socket to send it on. `not_leader` is one
 * too, but it ends the term, whose fenced store then refuses the verdict.
 */
const NEVER_DELIVERED: ReadonlySet<FailureReason> = new Set(["offline", "unknown", "refused", "disconnected"]);

/**
 * The `Fleet` over one term's leg. Every call is refused once the term ends,
 * the local ones included, so a stale pass cannot dispatch here either. A
 * request provably never delivered is the library's `undelivered`, which sends
 * a spawn straight back to `ready`; any other missing answer — a timeout, the
 * socket closing after the send, the leg stopping — is `unreachable`, which
 * never fails a task. `not_leader` additionally ends the term, since the relay
 * has said it is someone else's.
 */
function termFleet(o: TermFleetOpts): Fleet {
  const remote = async <T>(deviceId: string, op: "spawn" | "sessions" | "despawn", payload: unknown) => {
    try {
      return await o.relay.request<T>(deviceId, op, payload);
    } catch (err) {
      if (!(err instanceof RequestFailure)) throw err;
      if (err.reason === "not_leader") o.demote(`the relay refused ${op} to ${quote(deviceId)} as not_leader`);
      return NEVER_DELIVERED.has(err.reason) ? undelivered(err.message) : unreachable(err.message);
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

function schedulerError(code: SchedulerErrorCode, message: string): SchedulerError {
  return { ok: false, code, message };
}

function queueView(scheduler: Scheduler, now: number): QueueResponse {
  return boundedQueue(scheduler.tasks(), (id) => scheduler.lastDecision(id), now);
}

/**
 * UTF-8 bytes of task JSON one `queue` reply may carry. Sealing is base64 of
 * the whole `Plain`, 4/3 of it, against `ENVELOPE_MAX_CT_LENGTH`'s 65 536:
 * 44 000 seals to about 58 900, leaving room for the wrapper and a prompt
 * preview's multi-byte characters.
 */
const QUEUE_REPLY_BUDGET = 44_000;

/** Where the decision is still live: why a task waits, or where it is going. */
const LIVE_DECISION: ReadonlySet<Task["state"]> = new Set(["ready", "reserved"]);

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** A task as `queue` shows it before its decision is chosen: the prompt cut to a preview. */
function undecided(task: Task): Task {
  const { decision: _, spec, ...rest } = task;
  const { prompt } = spec;
  return { ...rest, spec: prompt === undefined ? spec : { ...spec, prompt: prompt.slice(0, QUEUE_PROMPT_PREVIEW) } };
}

/**
 * Newest first and bounded, prompts cut. Full decisions are filled against
 * `QUEUE_REPLY_BUDGET`, live ones first and then newest first; the rest go out
 * `winnerOnly`. Where even those overrun it — every bounded field near its cap —
 * the oldest tasks are left out, finished ones before live ones. Exported for
 * its test: a daemon test cannot build a `Scheduler`.
 */
export function boundedQueue(
  all: readonly Task[],
  decisionOf: (id: string) => Decision | undefined,
  now: number,
): QueueResponse {
  const newest = all
    .toSorted((a, b) => b.createdAt - a.createdAt)
    .slice(0, QUEUE_MAX_TASKS)
    .map(undecided);
  const decisions = new Map<string, { readonly whole: Decision; readonly cut: Decision }>();
  const sizes = new Map<string, number>();
  for (const task of newest) {
    const whole = decisionOf(task.id);
    const cut = whole === undefined ? undefined : winnerOnly(whole);
    if (whole !== undefined && cut !== undefined) decisions.set(task.id, { whole, cut });
    sizes.set(task.id, jsonBytes(withDecision(task, cut)));
  }
  // Every trimmed record is counted up front, so a full one only ever replaces its own.
  let left = QUEUE_REPLY_BUDGET - newest.reduce((sum, task) => sum + (sizes.get(task.id) ?? 0), 0);
  const byClaim = [
    ...newest.filter((t) => LIVE_DECISION.has(t.state)),
    ...newest.filter((t) => !LIVE_DECISION.has(t.state)),
  ];
  // From the back of the claim order, so what a verdict or MCP's placement poll follows goes last.
  const kept = new Set(newest.map((t) => t.id));
  for (const task of byClaim.toReversed()) {
    if (left >= 0) break;
    kept.delete(task.id);
    left += sizes.get(task.id) ?? 0;
  }
  const full = new Set<string>();
  for (const task of byClaim) {
    if (!kept.has(task.id)) continue;
    const decision = decisions.get(task.id);
    if (decision === undefined || decision.cut === decision.whole) continue;
    const extra = jsonBytes(decision.whole) - jsonBytes(decision.cut);
    if (extra > left) continue;
    left -= extra;
    full.add(task.id);
  }
  return {
    tasks: newest
      .filter((task) => kept.has(task.id))
      .map((task) => {
        const decision = decisions.get(task.id);
        return withDecision(task, full.has(task.id) ? decision?.whole : decision?.cut);
      }),
    at: now,
  };
}

function withDecision(task: Task, decision: Decision | undefined): Task {
  return decision === undefined ? task : { ...task, decision };
}

/** What answering one app request reads: the term's scheduler and the request it answers. */
interface Asked {
  readonly scheduler: Scheduler;
  /** The request's own id, which the audit line carries so the app's side can find it. */
  readonly id: string;
  readonly now: number;
  readonly tick: () => void;
  /**
   * Runs submits one at a time. The `MAX_ACTIVE_TASKS` count and the submit it
   * admits sit either side of awaits, so two run together would both pass it.
   */
  readonly admit: <T>(step: () => Promise<T>) => Promise<T>;
}

const CANCEL_REFUSALS: Record<Exclude<CancelResult, { readonly ok: true }>["code"], SchedulerError> = {
  not_found: schedulerError("task_not_found", "the leader holds no task by that id"),
  dispatching: schedulerError("dispatching", "its spawn is in flight; ask again once it lands"),
  finished: schedulerError("finished", "the task has already finished"),
  despawn_failed: schedulerError("despawn_failed", "its machine did not end the session; the task is unchanged"),
  conflict: schedulerError("conflict", "the task changed while the cancel ran; ask again"),
};

/**
 * An app's request to a running term (DESIGN.md, Scheduler, "The leader").
 * The payload is untrusted input to a PSK holder that acts on it, so it is
 * parsed into a fresh value before anything reads it.
 */
async function answer(asked: Asked, op: SchedulerOp, payload: unknown): Promise<unknown> {
  const { scheduler, id, tick } = asked;
  switch (op) {
    case "queue":
      return queueView(scheduler, asked.now);
    case "route-preview": {
      const request = parseTaskRequest(payload);
      if (request === null) return schedulerError("invalid_request", "malformed route-preview request");
      const reply: RoutePreviewResponse = { decision: scheduler.preview(request) };
      return reply;
    }
    // M2 only: the queue is this process's memory, so this is the one way in.
    // M3 replaces it with an app's `store-put` at `expect: 0` and drops the op.
    case "submit": {
      const request = parseTaskRequest(payload);
      if (request === null) return schedulerError("invalid_request", "malformed submit request");
      return asked.admit(async () => {
        await scheduler.prune(KEEP_FINISHED);
        const active = scheduler.tasks().filter((t) => !FINISHED.includes(t.state)).length;
        if (active >= MAX_ACTIVE_TASKS) {
          await audit.refused("submit", id, "queue_full");
          return schedulerError("queue_full", `the leader already holds ${active} unfinished tasks`);
        }
        const reply: SubmitResponse = { task: await scheduler.submit(request) };
        await audit.submitted(id, reply.task.id);
        // Placed now rather than on the next 30s tick; the reply is the task as queued.
        tick();
        return reply;
      });
    }
    case "cancel": {
      const ref = parseTaskRef(payload);
      if (ref === null) return schedulerError("invalid_request", "malformed cancel request");
      const result = await scheduler.cancel(ref.taskId);
      if (!result.ok) {
        await audit.refused("cancel", id, result.code, ref.taskId);
        return CANCEL_REFUSALS[result.code];
      }
      await audit.cancelled(id, result.task);
      // A cancelled task frees its slot for whatever waits.
      tick();
      const reply: TaskResponse = { task: result.task };
      return reply;
    }
    // M3's ops, in the schema ahead of their handlers (M3 items 5 and 6): a
    // refusal rather than silence, which an app would read as a dead leader.
    case "mark-done":
    case "pause":
    case "resume":
      return schedulerError("invalid_request", `this leader does not handle ${op} yet`);
  }
}

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
  let admitting: Promise<unknown> = Promise.resolve();
  const admit = <T>(step: () => Promise<T>): Promise<T> => {
    const turn = admitting.then(step);
    admitting = turn.catch(() => undefined);
    return turn;
  };
  // Declared before the leg that calls it; it reads `scheduler` only once a term is running.
  const onSession = async (taskId: string, state: SessionState, from?: SessionSource): Promise<void> => {
    if (live && running) await scheduler.onSession(taskId, state, from).catch(report);
  };
  // Only an app asks the scheduler anything; a daemon's envelope is an event.
  // Answered `not_ready` until takeover ends: before it the queue is the
  // store's unreconciled view, and a submit would race the load.
  const onRequest = async (plain: Plain, op: SchedulerOp, from: string): Promise<void> => {
    if (from !== APP_ID) {
      log.warn(`scheduler: dropped op=${quote(op)} from=${quote(from)} — requests come from apps only`);
      return;
    }
    log.info(`scheduler: request op=${quote(op)} id=${quote(plain.id)} term=${term}`);
    let payload: unknown;
    try {
      payload = running
        ? await answer({ scheduler, id: plain.id, now: now(), tick, admit }, op, plain.payload)
        : schedulerError("not_ready", `term ${term} is still taking over`);
    } catch (err) {
      log.error(`scheduler: ${quote(op)} crashed: ${String(err)}`);
      payload = schedulerError("internal_error", String(err));
    }
    await opts.reply(from, { id: crypto.randomUUID(), ts: Date.now(), op, re: plain.id, payload });
  };
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
