import type { QuotaReading, RepoEntry } from "@seance/shared";
import { attachmentsRoot } from "./attachments.ts";
import { custodianAudit, daemonSink, drainAskAudit, messageAudit, pushAudit, reapAudit } from "./audit.ts";
import { DespawnFailure, type SessionBackend } from "./backend.ts";
import { createBranchStates, type BranchStateDeps } from "./branch-state.ts";
import { brokerRelay, createBroker } from "./broker.ts";
import { REAP_DEFAULTS, type Config, type ResolvedPsk } from "./config.ts";
import type { AuthHealth } from "./auth-health.ts";
import { loadAgent } from "./custodian-agent.ts";
import { createCustodianVerbs, type CustodianVerbs } from "./custodian-verbs.ts";
import { createWorktreeRule } from "./custodian-worktree.ts";
import { countedVerb, emptyCounts, upsertRound } from "./custodian-rounds.ts";
import {
  ensureRoundDir,
  exclaveRootExists,
  launchRound,
  listRoundPanePids,
  listRoundPanes,
  readNotes,
  removeRoundTmp,
  roundDirFor,
  roundDirPlanted,
  sandboxProblem,
  weakerNestedNeeded,
} from "./custodian-launch.ts";
import {
  createCustodianSeat,
  createPick,
  type CustodianSeat,
  custodianPlatform,
  seatEnabled,
  type CloseOutcome,
  type CustodianSeatOpts,
  type SeatRecord,
} from "./custodian-seat.ts";
import { despawnRound } from "./despawn.ts";
import type { ExclaveScan } from "./exclaves.ts";
import { platformFsmonitor } from "./fsmonitor.ts";
import { createDrainAsk, drainInputShows, sendKeys, type DrainAsk } from "./drain-ask.ts";
import { pushForTask } from "./handlers.ts";
import { createPaneActivity, createPaneRetention } from "./pane-activity.ts";
import { createHandOff, createPassClose } from "./handoff.ts";
import { sourceOf, type Leader } from "./leader.ts";
import type { LocalSocketOpts } from "./local-socket.ts";
import { log } from "./log.ts";
import { createMessages } from "./messages.ts";
import { custodianRoundsPath, pruneLogPath, reapRefusalsPath } from "./paths.ts";
import { peerPidSupported } from "./peer.ts";
import { DAY_MS, formatReport, ReapBusy, runReap, withReapLock } from "./reap.ts";
import type { RelayClient } from "./relay-client.ts";
import {
  createSessionEvents,
  listPanePids,
  peerBindingProblem,
  readPanePids,
  type EndedTasks,
  type SessionEvents,
} from "./session-events.ts";
import type { Fetch } from "./seams.ts";
import { listPanes } from "./sessions.ts";
import { capturePane, paneWindowName, tmux } from "./tmux.ts";
import { isDirTrusted } from "./trust.ts";
import type { TraitProbes } from "./trait-probes.ts";
import type { UsageRefresh } from "./usage-refresh.ts";

const RESCAN_INTERVAL_MS = 3_600_000;
/**
 * The schedule asks whether a reap is due this often, against `lastReapAt`
 * in state.json — never on a bare interval from start, which the daemon's
 * frequent restarts (updates, config reloads) would keep resetting.
 */
const REAP_CHECK_INTERVAL_MS = 600_000;

/** What `startDaemon` has built by the time the capabilities start: the relay client and the leader among it. */
export interface WiringCtx {
  readonly config: Config;
  readonly resolved: ResolvedPsk;
  readonly key: CryptoKey;
  readonly deviceId: string;
  readonly client: RelayClient;
  readonly leader: Leader;
  readonly backend: SessionBackend;
  readonly endedTasks: EndedTasks;
  readonly repos: () => readonly RepoEntry[];
  readonly exclaveScan: () => ExclaveScan;
  /** Null unless `RunOpts.authHealth` enabled it; its own capability runs its timer, and the refresh reads and pokes it. */
  readonly authHealth: AuthHealth | null;
  /** Null unless `config.traits` declares a probe; its own capability runs its cadence. */
  readonly traitProbes: TraitProbes | null;
  /** Null unless `RunOpts.usageRefresh` enabled it; session events poke it, its own capability runs its timer. */
  readonly usageRefresh: UsageRefresh | null;
  /** `RunOpts.custodian`: null in a test that did not ask for a seat, so it never starts a round in a developer's tmux. */
  readonly custodian: CustodianSeatOpts | null;
  /** The newest raw quota reading per account id (`newestReadings`): the seat ranks exclaves by it. */
  readonly quotaReadings: () => ReadonlyMap<string, QuotaReading>;
  /** The seat's record from the daemon's one `state` (`custodianSeatOf`), and where it is persisted. */
  readonly custodianSeat: () => SeatRecord;
  readonly custodianSaved: (record: SeatRecord) => Promise<void>;
  readonly rescan: () => Promise<unknown>;
  readonly lastReapAt: () => number | undefined;
  /** Persists `lastReapAt` through the daemon's one `state`. */
  readonly reaped: (at: number) => Promise<void>;
  readonly stopped: () => boolean;
  /** This machine's `cl`, or null while open (`closedOf(state)`): a session pass sent then carries `drain`. */
  readonly closed: () => number | null;
  readonly now: () => number;
  /** The outbound HTTP seam, for a capability that polls or pushes (M4). */
  readonly httpFetch: Fetch;
  readonly rescanIntervalMs?: number;
  readonly reapCheckIntervalMs?: number;
  readonly branchState?: Pick<BranchStateDeps, "intervalMs" | "fetchStaleMs">;
}

/** A local op socket surface a capability brings; the socket starts after every capability, with all of them. */
export type LocalSurfaces = Pick<LocalSocketOpts, "broker" | "sessionEvents" | "messages" | "custodian">;

export interface Started {
  readonly stop: () => void;
  readonly local?: LocalSurfaces;
  /** The leader's `pass-close`, once session events run: the handler context reads it late (`run.ts`). */
  readonly armPassClose?: SessionEvents["armPassClose"];
  /** The drain's session ask, once session events run: `run.ts`'s availability reads it late. */
  readonly drainAsk?: DrainAsk;
}

/** One optional subsystem `startDaemon` wires once the relay client exists. */
export type DaemonCapability = (ctx: WiringCtx) => Started;

/**
 * Only where the key is service-delivered: there `seanced mcp` cannot read it,
 * and the broker is its only way to other machines. Anywhere else it reads the
 * key itself, so a broker would only widen what a same-uid process can do
 * without touching the key store — and keep an app-role surface in the daemon.
 * Built over the PSK resolved above — never a second lookup — and dials
 * nothing until a peer first asks it to reach another machine or the
 * scheduler. It also reads `account:` records, so a keyless peer can resolve an
 * account alias. Its app-role
 * socket and timers go with the daemon's handle: a reload builds a fresh
 * broker, and an orphaned one would hold a relay socket forever.
 */
const fleetBroker: DaemonCapability = (ctx) => {
  if (ctx.resolved.source !== "credential") return { stop: (): void => {} };
  const broker = createBroker({
    selfDeviceId: ctx.deviceId,
    relay: brokerRelay(ctx.config, ctx.resolved.psk),
    auditSink: daemonSink,
  });
  return { stop: broker.stop, local: { broker: broker.handle } };
};

/**
 * The custodian's per-pane facts (C15), one per process like `endedTasksFor`: a config reload restarts the daemon in
 * process, and a tracker per instance would forget every pane's state at each one. Its reader is the seat's due check
 * (`custodianSeat`); `paneRetention` holds it by count, so an outgoing instance's stop never halts the incoming
 * one's retention or sampling, and no frame is retained while no seat holds it.
 */
const paneActivity = createPaneActivity({
  panes: readPanePids,
  capture: (paneId) => capturePane(paneId, { history: false }),
});
const paneRetention = createPaneRetention(paneActivity);

/** Per daemon instance: the session-events instance whose marks the due check reads. */
const eventsOf = new WeakMap<WiringCtx, SessionEvents>();
/** The drain ask's `holds`: a pane it has a live entry for, which `SessionEvents.marked` does not know. */
const drainHoldsOf = new WeakMap<WiringCtx, DrainAsk["holds"]>();

const sessionEvents: DaemonCapability = (ctx) => {
  // Where the kernel cannot name a socket's peer, an event's pane is its own
  // claim — said once, since it changes what an event can be trusted to mean.
  // Where it can, binding still rests on a field Bun leaves undocumented; a
  // failed probe means every event will be refused, and this line is why.
  if (!peerPidSupported()) {
    log.warn(
      "local socket: this host reports no peer pid — session events are bound by the pane they name, and session messages are refused",
    );
  } else {
    void peerBindingProblem().then((problem) => {
      if (problem === null) return;
      log.warn(
        `local socket: peer binding failed its probe (${problem}) — every session event and session message will be refused`,
      );
    });
  }
  const { despawn } = ctx.backend;
  // Without a despawn nothing could close a passed session, so no ask is wired (as for the pass itself).
  // `events` is built from the ask's own `observe`, and the ask reads its `marked`: bound late.
  const late: { events?: SessionEvents } = {};
  const drainAsk =
    despawn === undefined
      ? undefined
      : createDrainAsk({
          closed: ctx.closed,
          panes: listPanePids,
          askable: (taskId) => ctx.endedTasks.askable(taskId),
          marked: (pane) => late.events?.marked(pane) ?? false,
          keys: sendKeys,
          inputShows: drainInputShows,
          audit: drainAskAudit(daemonSink),
        });
  // Beside session events because that capability owns pane binding, the peer warnings above and the `ended` frame
  // that clears a pane's held messages: a second capability would need a late-bound hook into it.
  const messages = createMessages({
    panes: listPanePids,
    windowName: paneWindowName,
    launchedAt: (taskId) => ctx.endedTasks.launchedAt(taskId),
    machine: ctx.config.name,
    audit: messageAudit(daemonSink),
  });
  const events = createSessionEvents({
    panes: listPanePids,
    exclaves: () => ctx.exclaveScan().exclaves,
    // The leader reaches itself in process, never by a relay round trip. A
    // daemon that just lost the role still sends to "scheduler", which the
    // relay routes to whoever leads now.
    forward: (event) => {
      if (ctx.leader.term() !== null) {
        void ctx.leader.onSession(event.taskId, event.state, sourceOf(ctx.deviceId, event), event.prUrl);
        return;
      }
      void ctx.client.sendToScheduler(event).catch((err: unknown) => log.warn(`session-event: ${String(err)}`));
    },
    ended: ctx.endedTasks,
    // Absent without a despawn: the session is then told `unsupported` up front, never `ok` for a close that cannot come.
    ...(despawn === undefined
      ? {}
      : {
          handOff: createHandOff({
            despawn,
            panes: listPanePids,
            closing: (taskId) => ctx.endedTasks.handingOff(taskId),
            sink: daemonSink,
          }),
        }),
    // A session's own pass (`pass_to_successor`). Absent without a despawn, like the hand-off: the pass could then never close.
    ...(despawn === undefined
      ? {}
      : {
          pass: {
            // The same push the scheduler's `push-branch` makes, asked by the session and audited `origin=successor`.
            push: (taskId, options) =>
              pushForTask(
                { tasks: ctx.endedTasks, getRepos: ctx.repos },
                pushAudit("successor", daemonSink),
                taskId,
                options,
              ),
            // In process when this machine leads, else sealed to the scheduler; false when neither could take it
            // (a term still taking over drops it, and the session is told to call again).
            send: (pass) => {
              if (ctx.leader.term() !== null) return Promise.resolve(ctx.leader.onSessionPass(pass, ctx.deviceId));
              return ctx.client.sendSessionPass(pass);
            },
            close: createPassClose({
              despawn,
              panes: listPanePids,
              closing: (taskId) => ctx.endedTasks.closing(taskId),
              sink: daemonSink,
            }),
          },
        }),
    // Activity is when a reading matters; the refresh spawns only if it is stale.
    onActivity: (exclave) => ctx.usageRefresh?.poke(exclave),
    onEnded: messages.onEnded,
    ...(drainAsk === undefined ? {} : { onState: drainAsk.observe, drainMark: (): boolean => ctx.closed() !== null }),
    retain: paneRetention.observe,
  });
  late.events = events;
  eventsOf.set(ctx, events);
  if (drainAsk !== undefined) drainHoldsOf.set(ctx, drainAsk.holds);
  drainAsk?.start();
  return {
    stop: (): void => {
      drainAsk?.stop();
      events.stop();
      messages.stop();
    },
    local: { sessionEvents: events.handle, messages },
    armPassClose: events.armPassClose,
    ...(drainAsk === undefined ? {} : { drainAsk }),
  };
};

const closeOutcome = async (pane: string, graceMs: number | undefined): Promise<CloseOutcome> => {
  try {
    return (await despawnRound(pane, graceMs === undefined ? {} : { graceMs })).outcome;
  } catch (err) {
    if (err instanceof DespawnFailure && err.code === "session_not_found") return "gone";
    throw err;
  }
};

/**
 * The custodian seat (docs/custodian.md; DESIGN.md, "The custodian's seat"). A daemon whose process was started for
 * one (`RunOpts.custodian`) always cleans up after a seat that is not running — a round left by a seat the config or
 * a rollback turned off, or one this host's checks (the sandbox, the agent file) now decline, is closed, never
 * orphaned — and holds a seat only where `seatEnabled` says so, the one predicate the `custodian` capability bit
 * reads too: the bit says a seat is configured, not that its checks passed (the log says when they did not).
 */
const custodianSeat: DaemonCapability = (ctx) => {
  const opts = ctx.custodian;
  if (opts === null) return { stop: (): void => {} };
  const audit = custodianAudit(daemonSink);
  const platform = custodianPlatform(process.platform);
  const settings = ctx.config.custodian;

  // Whatever a seat that is not running left: the record's round, and any other round pane (a stray).
  const sweep = async (): Promise<void> => {
    const round = ctx.custodianSeat().round;
    const panes = await listRoundPanes();
    for (const { pane } of panes) {
      // oxlint-disable-next-line no-await-in-loop -- one pane at a time: each close is a graceful exit
      await audit.kill(pane, "off", await closeOutcome(pane, opts.graceMs));
    }
    if (round === undefined && panes.length === 0) return;
    if (round !== undefined) await removeRoundTmp(round.tmpDir);
    // A round that reported `done` has its healthy entry unless that write failed or the daemon died before it: the
    // upsert never replaces a healthy line, so for those it records the round, without a summary. Any other was lost
    // with nothing counted.
    const done = round?.done === true;
    if (round !== undefined) {
      await upsertRound(custodianRoundsPath(), {
        start: round.startedAt,
        end: ctx.now(),
        outcome: done ? "healthy" : "failed",
        reason: done ? "done" : "lost",
        exclave: round.exclave,
        counts: done ? countedVerb(emptyCounts(), "done", true) : emptyCounts(),
      }).catch((err: unknown) => log.warn(`custodian: could not log a lost round: ${String(err)}`));
    }
    await audit.end(round?.pane ?? panes[0]?.pane ?? null, done ? "healthy" : "failed", done ? "done" : "lost");
    if (!ctx.stopped()) await ctx.custodianSaved({ lastEndedAt: ctx.now() });
  };
  const sweepLeftovers = (): void =>
    void sweep().catch((err: unknown) => log.warn(`custodian: closing a leftover round failed: ${String(err)}`));

  if (!seatEnabled(ctx.config, opts, process.platform) || settings === undefined || platform === null) {
    sweepLeftovers();
    return { stop: (): void => {} };
  }

  // The checks are async and `Started` is sync: the seat starts once they pass, and `stop` before that cancels it.
  let seat: CustodianSeat | null = null;
  let cancelled = false;
  let releaseActivity: (() => void) | null = null;
  /** When this process began retaining pane state: a pane's quiet time is only known from then (`closeVerdict`). */
  let retainedSince: number | null = null;
  const release = (): void => {
    releaseActivity?.();
    releaseActivity = null;
    retainedSince = null;
  };
  // A hand-off, pass or drain ask marked it: one expression for the seat's due check and the `close` verb.
  const untouchable = (pane: string): boolean =>
    eventsOf.get(ctx)?.marked(pane) === true || drainHoldsOf.get(ctx)?.(pane) === true;

  /** The seat's checks failed or it could not start: no round will ever run here, so the verbs say `unsupported`. */
  let seatFailed = false;
  // The verbs exist before the seat does (its checks are async) and answer `not_custodian` until it names a round.
  const { despawn } = ctx.backend;
  const verbs: CustodianVerbs | null =
    despawn === undefined
      ? null
      : createCustodianVerbs({
          roundPane: () => seat?.roundPane() ?? null,
          roundPanePids: listRoundPanePids,
          activity: paneActivity.activity,
          retainedSince: () => retainedSince,
          untouchable,
          tasks: ctx.endedTasks,
          worktree: createWorktreeRule({ tasks: ctx.endedTasks, repos: ctx.repos, listPanes }),
          despawn,
          killPane: async (pane) => (await tmux(["kill-pane", "-t", pane])).exitCode === 0,
          settings,
          seat: {
            count: (verb, ok) => seat?.count(verb, ok),
            countWorktree: (kind) => seat?.countWorktree(kind),
            done: async (summary) => (await seat?.done(summary)) ?? "no_round",
            isDone: () => seat?.isDone() ?? false,
          },
          now: ctx.now,
          audit,
          // Custodian 6's seam: where a kept `dirty` or `unpushed` worktree will be flagged to the owner.
          onKept: (): void => {},
          warn: (line) => log.warn(line),
        });
  const begin = async (): Promise<void> => {
    const problem = await (opts.sandboxProblem ?? ((): Promise<string | null> => sandboxProblem(platform)))();
    if (problem !== null) {
      log.warn(`custodian: no rounds on this host — ${problem}`);
      seatFailed = true;
      // A host that cannot run a round is as off as a seat that is not configured: a round the last process left
      // would otherwise run on with no deadline. Not after a `stop`, whose incoming instance adopts it.
      if (!cancelled) sweepLeftovers();
      return;
    }
    const agents = await loadAgent();
    if (cancelled) return;
    const weakerNested = opts.weakerNested ?? weakerNestedNeeded;
    releaseActivity = paneRetention.acquire();
    retainedSince = ctx.now();
    seat = createCustodianSeat({
      settings,
      now: ctx.now,
      ...(opts.checkIntervalMs === undefined ? {} : { checkIntervalMs: opts.checkIntervalMs }),
      activity: paneActivity.all,
      untouchable,
      appendRound: (entry) => upsertRound(custodianRoundsPath(), entry),
      draining: () => ctx.endedTasks.draining,
      stopped: ctx.stopped,
      record: ctx.custodianSeat,
      save: ctx.custodianSaved,
      pick: createPick({
        scan: ctx.exclaveScan,
        readings: ctx.quotaReadings,
        expired: (id) => ctx.authHealth?.expired(id) ?? false,
        model: settings.model,
        now: ctx.now,
        roundDirFor,
        rootExists: exclaveRootExists,
        trusted: isDirTrusted,
        planted: roundDirPlanted,
        ensureDir: ensureRoundDir,
      }),
      launch: async (exclave, onTmp) =>
        launchRound({
          exclave,
          roundDir: await ensureRoundDir(roundDirFor(exclave)),
          settings,
          agents,
          notes: await readNotes(),
          tmuxSession: ctx.config.tmuxSession,
          ...(ctx.config.machineTag === undefined ? {} : { machineTag: ctx.config.machineTag }),
          weakerNested: await weakerNested(),
          platform,
          onTmp,
        }),
      listRounds: listRoundPanes,
      paneAlive: async (pane) => {
        const found = (await listRoundPanes()).find((entry) => entry.pane === pane);
        if (found === undefined) return "gone";
        return found.dead ? "dead" : "live";
      },
      close: (pane) => closeOutcome(pane, opts.graceMs),
      removeTmp: removeRoundTmp,
      audit,
      warn: (line) => log.warn(line),
    });
    void seat.start();
  };
  void begin().catch((err: unknown) => {
    log.warn(`custodian: the seat did not start: ${String(err)}`);
    seatFailed = true;
    release();
    if (!cancelled) sweepLeftovers();
  });
  return {
    stop: (): void => {
      cancelled = true;
      seat?.stop();
      release();
    },
    ...(verbs === null
      ? {}
      : {
          local: {
            custodian: (raw, peer) =>
              seatFailed ? Promise.resolve({ ok: false, code: "unsupported" }) : verbs.handle(raw, peer),
          },
        }),
  };
};

/** Auth health's timer: the first walk runs at once, then every minute. Its `stop` waits for a read in flight. */
const authHealth: DaemonCapability = (ctx) => {
  const health = ctx.authHealth;
  if (health === null) return { stop: (): void => {} };
  health.start();
  return { stop: (): void => void health.stop() };
};

/** Trait probes' cadence: every unit runs once at start, then when due. Its `stop` kills a probe in flight and waits for the lane. */
const traitProbes: DaemonCapability = (ctx) => {
  const probes = ctx.traitProbes;
  if (probes === null) return { stop: (): void => {} };
  probes.start();
  return { stop: (): void => void probes.stop() };
};

/** The refresh's own timer, for exclaves no session is active in. */
const usageRefresh: DaemonCapability = (ctx) => {
  const refresh = ctx.usageRefresh;
  if (refresh === null) return { stop: (): void => {} };
  refresh.start();
  return { stop: refresh.stop };
};

const branchStates: DaemonCapability = (ctx) =>
  createBranchStates({
    ledger: ctx.endedTasks.ledger,
    repos: ctx.repos,
    // The leader reaches itself in process, never by a relay round trip, as session events do.
    emit: (branch) => {
      if (ctx.leader.term() !== null) {
        ctx.leader.onBranchState(branch, ctx.deviceId);
        return Promise.resolve(true);
      }
      return ctx.client.sendBranchState(branch);
    },
    // The rule the `sessions` reply's `ended` uses: a task no live session carries has ended (so is one not yet
    // registered). `repos()`, not `[]`, is load-bearing: `resolveLive` prunes the shared `repoMemo` to each
    // call's keys, so an empty list would evict the entries every other caller relies on.
    liveTasks: async () =>
      new Set((await ctx.backend.sessions(ctx.repos())).flatMap((session) => session.taskId ?? [])),
    ...ctx.branchState,
  });

/** Cached repos registered at once; refresh in the background now, then hourly. Explicit rescans arrive as ops. */
const rescanSchedule: DaemonCapability = (ctx) => {
  void ctx.rescan();
  const timer = setInterval(() => void ctx.rescan(), ctx.rescanIntervalMs ?? RESCAN_INTERVAL_MS);
  return { stop: (): void => clearInterval(timer) };
};

/**
 * Off unless configured. The report goes to the log, one line each; what it
 * destroyed is in the audit trail as origin=schedule. A run the CLI already
 * holds the lock for is skipped and tried at the next check.
 */
const reapSchedule: DaemonCapability = (ctx) => {
  const settings = ctx.config.reap ?? REAP_DEFAULTS;
  const everyMs = settings.intervalHours * 3_600_000;
  const abort = new AbortController();
  let reaping = false;
  const reapIfDue = async (): Promise<void> => {
    if (reaping || ctx.stopped() || ctx.now() - (ctx.lastReapAt() ?? 0) < everyMs) return;
    reaping = true;
    try {
      const report = await withReapLock(() =>
        runReap({
          repos: ctx.repos(),
          dryRun: false,
          minAgeMs: settings.minAgeDays * DAY_MS,
          audit: reapAudit("schedule", daemonSink),
          harvest: () => ctx.endedTasks.harvestExits(),
          closing: (id) => ctx.endedTasks.closing(id),
          signal: abort.signal,
          pruneLogPath: pruneLogPath(),
          refusalsPath: reapRefusalsPath(),
          attachments: attachmentsRoot(),
          fsmonitor: platformFsmonitor(),
        }),
      );
      for (const line of formatReport(report)) log.info(`reap: ${line}`);
      // A run the stop cut short isn't the one the schedule promised.
      if (ctx.stopped()) return;
      await ctx.reaped(ctx.now());
    } catch (err) {
      log.warn(err instanceof ReapBusy ? `reap: skipped — ${err.message}` : `reap failed: ${String(err)}`);
    } finally {
      reaping = false;
    }
  };
  const timer =
    everyMs > 0 ? setInterval(() => void reapIfDue(), ctx.reapCheckIntervalMs ?? REAP_CHECK_INTERVAL_MS) : null;
  return {
    stop: (): void => {
      if (timer !== null) clearInterval(timer);
      abort.abort();
    },
  };
};

/**
 * The capabilities list: started in this order once the relay client exists,
 * stopped in reverse. A subsystem M4 adds (push) is one more entry. The local op socket is not one: it is the surface the entries'
 * `local` handlers are served on, started after all of them.
 */
export const DAEMON_CAPABILITIES: readonly DaemonCapability[] = [
  fleetBroker,
  sessionEvents,
  authHealth,
  traitProbes,
  usageRefresh,
  branchStates,
  rescanSchedule,
  reapSchedule,
  custodianSeat,
];

export interface StartedCapabilities {
  readonly armPassClose?: SessionEvents["armPassClose"];
  readonly drainAsk?: DrainAsk;
  readonly local: LocalSurfaces;
  readonly stop: () => void;
}

export function startCapabilities(ctx: WiringCtx): StartedCapabilities {
  return startEach(ctx, DAEMON_CAPABILITIES);
}

/** Generic over the context so a test can start a fake list without building a `WiringCtx`. */
export function startEach<C>(ctx: C, capabilities: readonly ((ctx: C) => Started)[]): StartedCapabilities {
  const started: Started[] = [];
  const stop = (): void => {
    for (const entry of started.toReversed()) entry.stop();
  };
  try {
    let local: LocalSurfaces = {};
    let armPassClose: Started["armPassClose"];
    let drainAsk: Started["drainAsk"];
    for (const capability of capabilities) {
      const entry = capability(ctx);
      started.push(entry);
      local = mergeSurfaces(local, entry);
      armPassClose ??= entry.armPassClose;
      drainAsk ??= entry.drainAsk;
    }
    return {
      local,
      stop,
      ...(armPassClose === undefined ? {} : { armPassClose }),
      ...(drainAsk === undefined ? {} : { drainAsk }),
    };
  } catch (err) {
    // Already-started ones hold timers and sockets nothing else will stop.
    stop();
    throw err;
  }
}

/** Throws on a duplicate: a second capability silently replacing a surface would widen the local socket unseen. */
function mergeSurfaces(surfaces: LocalSurfaces, entry: Started): LocalSurfaces {
  for (const name of Object.keys(entry.local ?? {})) {
    if (name in surfaces) throw new Error(`two capabilities serve the local socket's "${name}" surface`);
  }
  return { ...surfaces, ...entry.local };
}
