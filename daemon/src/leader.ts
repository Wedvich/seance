import {
  StoreRevoked,
  Scheduler,
  sourceOf,
  type QueueStore,
  type SchedulerAlert,
  type SchedulerConfig,
  type SessionSource,
  type Task,
} from "@seance/scheduler";
import {
  APP_ID,
  isSchedulerOp,
  parseBranchState,
  parseSessionEvent,
  QUEUE_MAX_TASKS,
  QUOTA_KEY,
  quote,
  STORE_PREFIXES,
  type BranchState,
  type Envelope,
  type Plain,
  type PushAlert,
  type QueueChanged,
  type SchedulerEventHandler,
  type SessionState,
} from "@seance/shared";
import type { AppRelay } from "./app-relay.ts";
import { admitAudit, daemonSink } from "./audit.ts";
import type { LocalOps } from "./handlers.ts";
import { createDiskWatch } from "./disk-alerts.ts";
import { fencedStore, termFleet } from "./leader-adapters.ts";
import { requestHandler } from "./leader-requests.ts";
import { log } from "./log.ts";
import { startPrPoller, type PrPollerOpts } from "./pr-status.ts";
import { createPushSender, type PushSender } from "./push-sender.ts";
import { createQueueStore, flooredStore, type StoreLeg } from "./queue-store.ts";
import type { Fetch } from "./seams.ts";
import { createTermSettings, type SettingsState, type TermSettings } from "./settings.ts";
import { createSettingsStore, type SettingsStore } from "./settings-store.ts";
import type { VersionFloor } from "./version-floor.ts";

/**
 * The scheduler role (docs/scheduler.md, "`leader.ts`"; DESIGN.md, Scheduler):
 * the term lifecycle and the daemon's entry to it. With its store adapter
 * (`queue-store.ts`), fleet adapter (`leader-adapters.ts`) and app-request
 * handlers (`leader-requests.ts`), the only daemon modules that import
 * `scheduler/` — `LEADER_MODULES` in the layering test enforces it — so the
 * library can move to a fixed box behind two new adapters.
 *
 * One term is one run: `lead { term }` builds an app-role leg of its own, the
 * `Fleet` over it, a `Scheduler`, a tick timer and the PR poller
 * (`pr-status.ts`, which reads the leader's own `gh`). `follow`, the daemon's
 * relay socket dropping, a `not_leader` answer, the leg's token rejected
 * (which also resigns the role, since the relay cannot know) or `stop` ends
 * it, and ending it stops every one of those. Nothing of a term survives it — the broker's discipline.
 *
 * Why not `LazyRelay`: it hangs up after five idle minutes and redials on the
 * next call, which suits a Claude session calling hours apart and not a loop
 * that must hear every registry and `status` push between its own calls. Why
 * not the broker's: then either lifecycle could end the other's socket.
 */

// For the daemon's tests and its other modules (`sourceOf`: `run-capabilities.ts`), which the
// layering rule keeps from importing `scheduler/` themselves.
export {
  MemoryQueueStore,
  sourceOf,
  StoreRevoked,
  type QueueStore,
  type StoreEntry,
  type Task,
} from "@seance/scheduler";

/** The library's own cadence for ready tasks (docs/scheduler.md, Routing). */
const TICK_INTERVAL_MS = 30_000;

/** The longest the settings read waits between tries after repeated failures. */
const SETTINGS_RETRY_CAP_MS = 300_000;

/**
 * The term's app-role leg: the shared client built with `scheduler: { term }`,
 * so every request is sealed `from: "scheduler"` and carries the term the relay
 * fences on.
 */
export interface LeaderRelay extends AppRelay {
  /** A reply that the relay routed to this daemon's own socket, as every `to: "scheduler"` envelope is. */
  readonly deliver: (env: Envelope) => Promise<void>;
  /** The coalesced nudge to every app that the queue changed (`RelayClient.queueChanged`); false when nothing was sent. */
  readonly queueChanged: (change: QueueChanged) => Promise<boolean>;
  /** Re-reads the fleet quota record into `getState().fleetQuota` (`RelayClient.refreshFleetQuota`); never rejects on a failed read. */
  readonly refreshFleetQuota: () => Promise<void>;
}

/**
 * Where the leader's tasks live. Production gives `storeLeg` and `key`, and
 * each term gets its own adapter over them (`createQueueStore`), so a late
 * pass can never write under its successor's term. `store` is for tests: one
 * store across every term, what `MemoryQueueStore` stands in for. There is no
 * default — a leader that fell back to memory silently would lose its queue.
 */
export type LeaderStore =
  | {
      readonly store: QueueStore;
      /** The settings record's store, for a test that wants one; absent, the term has no settings. */
      readonly settings?: SettingsStore;
      readonly storeLeg?: undefined;
      readonly key?: undefined;
    }
  | {
      readonly storeLeg: StoreLeg;
      readonly key: CryptoKey;
      readonly store?: undefined;
      readonly settings?: undefined;
    };

export type LeaderOpts = LeaderBaseOpts & LeaderStore;

export interface LeaderBaseOpts {
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
   * The process's version floor (`version-floor.ts`), shared by every term so
   * the relay cannot roll a record back under the next one. The daemon always
   * passes it; a test may leave it out to read its store unfloored.
   */
  readonly floor?: VersionFloor;
  readonly config?: SchedulerConfig;
  readonly tickIntervalMs?: number;
  /** The wait before a failed takeover is tried again; defaults to the tick interval. */
  readonly takeoverRetryMs?: number;
  readonly now?: () => number;
  /** Outbound HTTP for the term (push sends); defaults to the global `fetch`. */
  readonly httpFetch?: Fetch;
  /**
   * The VAPID `sub` claim: an `https:` contact URI a push service may show its operator
   * (`https://<relay host>`; Apple refuses a push with none). Never a person's address.
   */
  readonly pushSubject: string;
  /** The PR poller's `gh` and cadence (`pr-status.ts`); absent, it runs on its defaults. */
  readonly prStatus?: PrPollerOpts;
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
   * A `session-event` from this machine, in process (`run-capabilities.ts`): the leader
   * reaches itself only locally. Other machines' arrive through the term's leg.
   * `from` is where the event came from, which is what lets one resolve a task
   * still reserved (`Scheduler.onSession`); `prUrl` is the event's own, which
   * is what makes an ended session `awaiting-merge`. Dropped outside a running
   * term — takeover reads the same state from `sessions` — so it never queues
   * behind a takeover in flight.
   */
  readonly onSession: (taskId: string, state: SessionState, from?: SessionSource, prUrl?: string) => Promise<void>;
  /**
   * A `branch-state` from this machine, in process (`run-capabilities.ts`), as `onSession`
   * is; other machines' arrive through the term's leg. `from` is the sealing
   * daemon (one sealed `from: "app"` is dropped). Feeds `Scheduler.onBranchState`;
   * dropped outside a running term, as `onSession` is.
   */
  readonly onBranchState: (state: BranchState, from: string) => void;
  /**
   * The relay's nudge after an app-leg write to the store (`store-changed`;
   * `RelayClient`'s `onStoreChanged`): refreshes that one task, then ticks.
   * Buffered while the term is taking over, so a create landing between
   * takeover's `list` and its end is not lost; ignored with no term, and for
   * a key outside `task:`.
   */
  readonly onStoreChanged: (key: string, version: number) => void;
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
  readonly onSession: (taskId: string, state: SessionState, from?: SessionSource, prUrl?: string) => Promise<void>;
  readonly onBranchState: (state: BranchState, from: string) => void;
  readonly onStoreChanged: (key: string, version: number) => void;
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

function report(err: unknown): void {
  // A pass the term's end cut short; the next term reconciles whatever it left.
  if (err instanceof StoreRevoked) return;
  log.warn(`scheduler: ${String(err)}`);
}

/**
 * Every write the leader makes is a change an app would show, and the library
 * has no hook for it, so the store is watched instead: `changed` hears the task
 * id (null for the pause record) of every write that landed or may have
 * (`indeterminate`). A refused one changed nothing.
 */
function watched(inner: QueueStore, changed: (id: string | null) => void): QueueStore {
  const landed = <T extends { readonly ok: boolean }>(write: T, id: string | null): T => {
    if (write.ok || ("code" in write && write.code === "indeterminate")) changed(id);
    return write;
  };
  return {
    list: () => inner.list(),
    get: (id) => inner.get(id),
    getPause: () => inner.getPause(),
    put: async (id, expect, body) => {
      const write = landed(await inner.put(id, expect, body), id);
      // Version 1 is an app's create and always `queued`, so the write after it is the leader's
      // first move: admission, unless a cancel or mark-done got there first.
      if (write.ok && expect === 1 && ADMITTED.has(body.state)) await admitted(body);
      return write;
    },
    delete: async (id, expect) => landed(await inner.delete(id, expect), id),
    putPause: async (expect, holds) => landed(await inner.putPause(expect, holds), null),
  };
}

/**
 * What a push says of a library alert: ids and state only, never the message
 * (it names an account) or a title. Here, not in `push-sender.ts`, which stays
 * scheduler-free.
 */
function alertToPush(alert: SchedulerAlert, at: number): PushAlert {
  if (alert.kind === "spill") {
    return { v: 1, kind: "spill", at, taskId: alert.taskId, window: alert.window, projectedPct: alert.projectedPct };
  }
  return { v: 1, kind: "needs-input", at, taskId: alert.taskId, since: alert.since, escalated: alert.escalated };
}

/** Where admission leaves a `queued` task (`admission` in the library). */
const ADMITTED: ReadonlySet<Task["state"]> = new Set(["ready", "blocked", "failed"]);

const admitted = admitAudit(daemonSink);

/** Alerts held for a settings load still pending; a pass raises few, and a stuck load must not grow without bound. */
const PARKED_ALERTS_MAX = 32;

/** One nudge per this long, however many writes: an app re-fetches once, not per transition. */
const NUDGE_COALESCE_MS = 500;

function startTerm(term: number, opts: LeaderOpts, demote: (demotion: Demotion) => void): TermRun {
  let live = true;
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let prs: { readonly stop: () => void } | null = null;
  const now = opts.now ?? Date.now;
  // The relay answered `not_leader` to a write: `fencedStore` throws only once
  // `!live`, so a `StoreRevoked` while live can only be that, and the term is no
  // longer this daemon's to run. One arriving after the term ended is `report`'s.
  const fail = (err: unknown): void => {
    if (err instanceof StoreRevoked) {
      if (live) demote({ why: `the relay revoked the term's store writes (${err.message})`, resign: false });
      return;
    }
    report(err);
  };
  // Coalesced `queue-changed`: the task ids written or refreshed within one window, or the
  // whole queue when too many changed or the holds did. Reads `relay` only when its timer
  // fires, which is after the term built it.
  const nudge = (() => {
    const ids = new Set<string>();
    let whole = false;
    let armed: ReturnType<typeof setTimeout> | null = null;
    const send = (tasks?: readonly string[]): void => {
      relay.queueChanged({ at: now(), ...(tasks === undefined ? {} : { tasks }) }).catch(report);
    };
    return {
      note: (id: string | null): void => {
        if (!live) return;
        if (id === null) whole = true;
        else ids.add(id);
        armed ??= setTimeout(() => {
          armed = null;
          if (!live) return;
          const tasks = whole || ids.size > QUEUE_MAX_TASKS ? undefined : [...ids];
          ids.clear();
          whole = false;
          send(tasks);
        }, NUDGE_COALESCE_MS);
      },
      // Takeover just ended: an app that was answered `not_ready` wants the queue now.
      all: (): void => {
        if (live) send();
      },
      stop: (): void => {
        if (armed !== null) clearTimeout(armed);
        armed = null;
      },
    };
  })();
  // Declared before the leg that calls it; it reads `scheduler` only once a term is running.
  const onSession = async (
    taskId: string,
    state: SessionState,
    from?: SessionSource,
    prUrl?: string,
  ): Promise<void> => {
    if (live && running) await scheduler.onSession(taskId, state, from, prUrl).catch(fail);
  };
  const onBranchState = (state: BranchState, from: string): void => {
    if (live && running) scheduler.onBranchState(state, from).catch(fail);
  };
  // Task ids a `store-changed` named while the term was still taking over, or
  // whose refresh failed: takeover's `load` replaces the held view, so a refresh
  // before it ends would be overwritten, and one that failed must not be lost —
  // the term never lists the store again.
  const changed = new Set<string>();
  const refreshChanged = (): Promise<unknown> => {
    const pending = [...changed];
    changed.clear();
    return Promise.all(
      pending.map((id) =>
        scheduler.refresh(id).then(
          () => nudge.note(id),
          (err: unknown) => {
            changed.add(id);
            fail(err);
          },
        ),
      ),
    );
  };
  const onStoreChanged = (key: string, _version: number): void => {
    if (!live) return;
    // Another daemon's readings: re-read on the leg. A changed record reaches
    // `tick` through the subscription below; an unchanged one needs no pass.
    if (key === QUOTA_KEY) {
      relay.refreshFleetQuota().catch(fail);
      return;
    }
    if (!key.startsWith(STORE_PREFIXES.task.prefix)) return;
    const id = key.slice(STORE_PREFIXES.task.prefix.length);
    if (!running) {
      changed.add(id);
      return;
    }
    // An app's create is a change no leader write covers, so it is nudged from here.
    scheduler.refresh(id).then(
      () => {
        nudge.note(id);
        tick();
      },
      (err: unknown) => {
        changed.add(id);
        fail(err);
      },
    );
  };
  // Like `onSession`, built before the leg and reading `scheduler` and `tick` only once running.
  const onRequest = requestHandler({
    term,
    scheduler: () => scheduler,
    running: () => running,
    now,
    tick: () => tick(),
    fail,
    reply: opts.reply,
    settings: () => settings,
    settingsState: () => (settings === null ? "unavailable" : settingsState),
  });
  // What another daemon or an app sent the scheduler, already opened and
  // replay-checked by the leg. The sealer's id is AAD-bound; an event's fields
  // are its daemon's own binding, re-validated here — the PR URL above all.
  const onEvent: SchedulerEventHandler = (plain, from) => {
    if (isSchedulerOp(plain.op)) {
      onRequest(plain, plain.op, from).catch(fail);
      return;
    }
    // An op this leader does not know, from an app that wants an answer (an older
    // build's `submit`): a refusal beats a timeout. Acts on nothing.
    // Nothing to answer without a string op and id: the reply would echo whatever shape the sender put there.
    if (
      from === APP_ID &&
      typeof plain.op === "string" &&
      typeof plain.id === "string" &&
      plain.re === undefined &&
      plain.op !== "branch-state" &&
      plain.op !== "session-event"
    ) {
      log.warn(`scheduler: refused op=${quote(plain.op)} from=${quote(from)} — not an op this leader handles`);
      void opts.reply(from, {
        id: crypto.randomUUID(),
        ts: Date.now(),
        op: plain.op,
        re: plain.id,
        payload: { ok: false, code: "invalid_request", message: `this leader does not handle ${quote(plain.op)}` },
      });
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
    void onSession(event.taskId, event.state, sourceOf(from, event), event.prUrl);
  };
  const relay = opts.createRelay(term, onEvent);
  const isLive = (): boolean => live;
  const store =
    opts.store !== undefined ? opts.store : createQueueStore({ leg: opts.storeLeg, key: opts.key, term, now });
  // Settings (the VAPID pair, later push subscriptions) are optional: a fault there never touches the queue.
  const settingsStore: SettingsStore | null =
    opts.store !== undefined
      ? (opts.settings ?? null)
      : createSettingsStore({
          leg: opts.storeLeg,
          key: opts.key,
          term,
          live: isLive,
          ...(opts.floor === undefined ? {} : { floor: opts.floor }),
          revoked: (why) => new StoreRevoked(why),
        });
  const settings: TermSettings | null =
    settingsStore === null ? null : createTermSettings({ store: settingsStore, term, log });
  // What `push-subscribe` and `push-unsubscribe` read: pending until the first load decides, and while a retry is due.
  let settingsState: SettingsState = "pending";
  // Set when a read or an unconfirmed write left the record undecided: the tick tries again, backing off.
  let settingsRetry = false;
  let settingsLoading = false;
  // Ticks to skip before the next try, and the ticks between tries after the next failure. The first
  // retry is the next tick; each failure doubles the gap up to about SETTINGS_RETRY_CAP_MS, so a relay
  // that keeps refusing reads is not asked once per tick for the whole term.
  let settingsSkip = 0;
  let settingsGap = 1;
  const settingsGapCap = Math.max(1, Math.floor(SETTINGS_RETRY_CAP_MS / (opts.tickIntervalMs ?? TICK_INTERVAL_MS)));
  // Alerts the scheduler raised before the first load decided. The first pass can beat the read, and an
  // alert is persisted as sent (`escalated`) before it is raised, so one dropped here would never be repeated.
  const parked: PushAlert[] = [];
  const loadSettings = (): void => {
    if (settings === null || settingsLoading || !live) return;
    settingsLoading = true;
    settings.load().then(
      (state) => {
        settingsLoading = false;
        settingsRetry = false;
        settingsSkip = 0;
        settingsGap = 1;
        settingsState = state;
        // What the first pass raised while the record was still being read.
        const waiting = parked.splice(0);
        // A term that ended while the read was out sends nothing: its successor owns the alerts now.
        if (state === "ready" && live) {
          for (const alert of waiting) pushSender?.send(alert);
          diskWatch.check(false);
        }
      },
      (err: unknown) => {
        settingsLoading = false;
        // Ended while it ran: the term's own end is not an outage.
        if (!live) return;
        if (err instanceof StoreRevoked) {
          fail(err);
          return;
        }
        // Once per outage. The name only: the error's text can carry what the relay answered.
        if (!settingsRetry) {
          log.warn(
            `scheduler: term ${term} could not load its settings, retrying: ${err instanceof Error ? err.name : "unknown error"}`,
          );
        }
        settingsRetry = true;
        settingsSkip = settingsGap - 1;
        settingsGap = Math.min(settingsGap * 2, settingsGapCap);
      },
    );
  };
  // Beside the scheduler, never inside its pass: `send` returns at once and throws nothing.
  const pushSender: PushSender | null =
    settings === null
      ? null
      : createPushSender({
          settings,
          httpFetch: opts.httpFetch ?? ((input, init) => fetch(input, init)),
          sub: opts.pushSubject,
          now,
          log,
          onError: fail,
        });
  // Disk alerts ride the registry, not the scheduler: the record's `diskAlerts` list is what keeps a new
  // term from repeating one, and an alert is raised only once that write has landed.
  const diskWatch = createDiskWatch({
    settings: () => settings,
    ready: () => settingsState === "ready",
    machines: () => relay.getState().machines,
    onAlert: (alert) => {
      if (alert.kind === "disk") log.warn(`scheduler: disk nearly full: device=${quote(alert.deviceId)}`);
      pushSender?.send(alert);
    },
    onError: fail,
    now,
    minGapMs: opts.tickIntervalMs ?? TICK_INTERVAL_MS,
  });
  const scheduler = new Scheduler({
    store: watched(
      fencedStore(opts.floor === undefined ? store : flooredStore(store, opts.floor), term, isLive),
      nudge.note,
    ),
    fleet: termFleet({
      relay,
      selfDeviceId: opts.selfDeviceId,
      local: opts.local,
      live: isLive,
      demote: (why) => demote({ why, resign: false }),
    }),
    now,
    onError: fail,
    onAlert: (alert) => {
      log.warn(`scheduler: ${alert.message}`);
      if (pushSender === null) return;
      const push = alertToPush(alert, now());
      if (settingsState !== "pending") pushSender.send(push);
      else if (parked.length < PARKED_ALERTS_MAX) parked.push(push);
    },
    ...(opts.config === undefined ? {} : { config: opts.config }),
  });

  const tick = (): void => {
    if (!live || !running) return;
    if (changed.size === 0) {
      scheduler.tick().catch(fail);
      return;
    }
    // A nudge whose refresh failed is retried here, before the pass reads the held view.
    refreshChanged()
      .then(() => (live && running ? scheduler.tick() : undefined))
      .catch(fail);
  };

  // Takeover waits for an authoritative registry: before it, an empty machine
  // list means "no push yet", and reconciling against it would ask nobody.
  const fleetReady = Promise.withResolvers<void>();
  let seen = relay.getState().machines;
  let seenQuota = relay.getState().fleetQuota;
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
    if (state.machines !== seen || state.fleetQuota !== seenQuota) {
      seen = state.machines;
      seenQuota = state.fleetQuota;
      diskWatch.check(true);
      tick();
    }
  });
  relay.start();

  const intervalMs = opts.tickIntervalMs ?? TICK_INTERVAL_MS;
  const retryMs = opts.takeoverRetryMs ?? intervalMs;
  // Woken early by `end`, so a retry wait never outlives the term.
  let retry: { readonly timer: ReturnType<typeof setTimeout>; readonly wake: () => void } | null = null;
  const pause = (): Promise<void> =>
    new Promise((resolve) => {
      const wake = (): void => {
        if (retry !== null) clearTimeout(retry.timer);
        retry = null;
        resolve();
      };
      retry = { timer: setTimeout(wake, retryMs), wake };
    });

  const settled = (async (): Promise<void> => {
    await fleetReady.promise;
    // The fleet quota record before the first pass: without it an account only
    // the record has seen routes as unobserved. Resolves within the store
    // timeout whatever it finds, so a relay that answers nothing holds no term.
    await relay.refreshFleetQuota();
    if (!live) return;
    // Beside takeover, never ahead of it: push is optional, the queue is not.
    loadSettings();
    // The relay still names this daemon leader, so a takeover that failed is
    // retried rather than left as a term that holds the role and runs nothing.
    for (;;) {
      if (!live) return;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one attempt at a time, by design
        await scheduler.takeover();
        break;
      } catch (err) {
        // Ended while it ran: `end` has already woken a retry that was never armed, so none is.
        if (!live) return;
        if (err instanceof StoreRevoked) {
          fail(err);
          return;
        }
        log.warn(`scheduler: term ${term} takeover failed, retrying in ${retryMs}ms: ${String(err)}`);
      }
      // oxlint-disable-next-line no-await-in-loop -- the wait between attempts
      await pause();
    }
    if (!live) return;
    running = true;
    nudge.all();
    // Takeover's `load` replaced the held view, so only now can a nudge it buffered be applied.
    await refreshChanged();
    if (!live) return;
    seen = relay.getState().machines;
    seenQuota = relay.getState().fleetQuota;
    timer = setInterval(() => {
      // A create stamped ahead of this clock (a phone's fast clock) binds once the clock passes
      // its stamp, and no `store-changed` will say so: re-read it on the timer, one get each, and
      // not on every push's tick.
      for (const entry of scheduler.unreadable()) if (entry.reason === "created_ahead") changed.add(entry.id);
      if (settingsRetry) {
        if (settingsSkip > 0) settingsSkip -= 1;
        else loadSettings();
      }
      // Also on the clock: the first check after settings turn ready, and the retry of one a conflict lost.
      diskWatch.check(false);
      tick();
    }, intervalMs);
    // Only after takeover's load: the poller reads the held tasks and writes through the term's fenced store.
    prs = startPrPoller({
      ...opts.prStatus,
      tasks: () => scheduler.tasks(),
      onStatus: (id, url, status) =>
        live && running ? scheduler.onPrStatus(id, url, status).catch(fail) : Promise.resolve(),
      now,
      log,
    });
    log.info(
      `scheduler: term ${term} took over ${scheduler.tasks().length} tasks (${scheduler.unreadable().length} unreadable) — dispatching`,
    );
    tick();
  })().catch(fail);

  return {
    term,
    settled,
    deliver: (env) => {
      if (live) relay.deliver(env).catch(fail);
    },
    onSession,
    onBranchState,
    onStoreChanged,
    end: () => {
      live = false;
      running = false;
      fleetReady.resolve();
      retry?.wake();
      if (timer !== null) clearInterval(timer);
      timer = null;
      prs?.stop();
      prs = null;
      // Queued pushes are dropped and later alerts ignored: a replaced term must not keep sending.
      pushSender?.stop();
      parked.length = 0;
      nudge.stop();
      unsubscribe();
      // Fails whatever the term still had out as "disconnected" → `unreachable`,
      // and the fenced store refuses the writes those verdicts would make.
      relay.stop();
    },
  };
}

export function createLeader(options: LeaderOpts): Leader {
  const opts = options;
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
    onSession: async (taskId, state, from, prUrl) => current?.onSession(taskId, state, from, prUrl),
    onBranchState: (state, from) => current?.onBranchState(state, from),
    onStoreChanged: (key, version) => current?.onStoreChanged(key, version),
    term: () => current?.term ?? null,
    settled: async () => current?.settled,
    stop: () => {
      stopped = true;
      end("the daemon is stopping");
    },
  };
}
