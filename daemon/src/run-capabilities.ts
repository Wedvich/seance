import { join } from "node:path";
import type { CustodianEvent, CustodianStatus, QuotaReading, RepoEntry } from "@seance/shared";
import { createAdapterFeed } from "./adapter-feed.ts";
import { startAdapterHost } from "./adapter-host.ts";
import { attachmentsRoot } from "./attachments.ts";
import {
  adapterAudit,
  custodianAudit,
  daemonSink,
  drainAskAudit,
  messageAudit,
  pushAudit,
  reapAudit,
} from "./audit.ts";
import { DespawnFailure, type SessionBackend } from "./backend.ts";
import { createBranchStates, type BranchStateDeps } from "./branch-state.ts";
import { brokerRelay, createBroker } from "./broker.ts";
import { REAP_DEFAULTS, type Config, type ResolvedPsk } from "./config.ts";
import type { AuthHealth } from "./auth-health.ts";
import { loadAgent } from "./custodian-agent.ts";
import { createPrReader } from "./custodian-pr.ts";
import {
  CUSTODIAN_SOCKET_NAME,
  custodianSocketDir,
  removeCustodianSocketDir,
  startCustodianSocket,
} from "./custodian-socket.ts";
import {
  clearOnNewTurn,
  createCustodianFlags,
  deliverEvent,
  retainFrame,
  type CustodianFlags,
} from "./custodian-flags.ts";
import {
  dropRoundRequest,
  pausedAt,
  peekRoundRequest,
  readControl,
  writeSeatView,
  type PauseRead,
} from "./custodian-control.ts";
import { createConversations, type Conversations, type SessionTagsSource } from "./conversations.ts";
import { roundRemoteId } from "./custodian-remote.ts";
import { createCustodianVerbs, type CustodianVerbs } from "./custodian-verbs.ts";
import { createWorktreeRule } from "./custodian-worktree.ts";
import { countedVerb, emptyCounts, readRounds, upsertRound } from "./custodian-rounds.ts";
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
  toolchainRefusal,
  weakerNestedNeeded,
} from "./custodian-launch.ts";
import {
  createCustodianSeat,
  createPick,
  type CustodianSeat,
  custodianPlatform,
  sandboxDrilled,
  SANDBOX_UNDRILLED,
  lastRoundView,
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
import { createMessages, type Messages } from "./messages.ts";
import {
  adaptersDir,
  custodianActivityPath,
  custodianRoundsPath,
  custodianSessionsPath,
  pruneLogPath,
  reapRefusalsPath,
} from "./paths.ts";
import { readSavedActivity, writeSavedActivity } from "./pane-activity-store.ts";
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
  /** This machine's close and drain start while it drains (`drainingOf`); null while open or soft-closed. */
  readonly draining: () => { readonly cl: number; readonly drainAt: number } | null;
  /** The status loop's `refresh`, late-bound: the seat's view moved and the row should turn over within a beat. */
  readonly refreshStatus?: () => void;
  /** The running source's sha, for `custodian/seat.json`; null when unknown. */
  readonly version: string | null;
  readonly now: () => number;
  /** The outbound HTTP seam, for a capability that polls or pushes (M4). */
  readonly httpFetch: Fetch;
  readonly rescanIntervalMs?: number;
  readonly reapCheckIntervalMs?: number;
  readonly branchState?: Pick<BranchStateDeps, "intervalMs" | "fetchStaleMs">;
}

/** A local op socket surface a capability brings; the socket starts after every capability, with all of them. */
export type LocalSurfaces = Pick<LocalSocketOpts, "broker" | "sessionEvents" | "messages">;

export interface Started {
  readonly stop: () => void;
  readonly local?: LocalSurfaces;
  /** The leader's `pass-close`, once session events run: the handler context reads it late (`run.ts`). */
  readonly armPassClose?: SessionEvents["armPassClose"];
  /** The leader's forwarded messages and receipts, once session events run: the handler context reads it late (`run.ts`). */
  readonly messages?: Pick<Messages, "deliverRouted" | "receipt">;
  /** The drain's session ask, once session events run: `run.ts`'s availability reads it late. */
  readonly drainAsk?: DrainAsk;
  /** The custodian seat's view for the status's `cu`, read late by `run.ts`; absent where no seat is enabled. */
  readonly custodianStatus?: (now: number) => CustodianStatus | null;
  /** The seat reads the owner's control files now (`CustodianSeat.poke`), read late by `run.ts`'s `custodian` op. */
  readonly custodianPoke?: () => void;
  /** Whether the seat exists: `starting` while its async checks run, `failed` once they declined. The op reads it, never the file view. */
  readonly custodianHost?: () => CustodianHost;
  /** Session identity and tags, once session events run: an app's `sessions` reads it late (`run.ts`). */
  readonly conversations?: SessionTagsSource;
  /** Run once the local op socket is up (`run.ts`): what must not start before a session's `seance` can reach it. */
  readonly afterLocal?: () => void;
}

export type CustodianHost = "starting" | "failed" | "ready";

/** One optional subsystem `startDaemon` wires once the relay client exists. */
export type DaemonCapability = (ctx: WiringCtx) => Started;

/**
 * Only where the key is service-delivered: there `seance mcp` cannot read it,
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
 * one's retention or sampling, and no frame is retained while no seat holds it. Its facts outlive the process in
 * `custodian/activity.json`, so sessions already at rest stay closable across a restart.
 */
const paneActivity = createPaneActivity({
  panes: readPanePids,
  capture: (paneId) => capturePane(paneId, { history: false }),
  store: {
    load: () => readSavedActivity(custodianActivityPath(), (line) => log.warn(line)),
    save: (panes) =>
      writeSavedActivity(custodianActivityPath(), panes).catch((err: unknown) => {
        log.warn(`custodian: could not write pane activity: ${String(err)}`);
        throw err;
      }),
  },
});

/** Settles once the pane-activity writes begun have landed: `stop` waits for it, as it does for state.json's. */
export const paneActivitySettled = (): Promise<void> => paneActivity.settled();
const paneRetention = createPaneRetention(paneActivity);

/** Per daemon instance: the session-events instance whose marks the due check reads. */
const eventsOf = new WeakMap<WiringCtx, SessionEvents>();
/** The drain ask's `holds`: a pane it has a live entry for, which `SessionEvents.marked` does not know. */
const drainHoldsOf = new WeakMap<WiringCtx, DrainAsk["holds"]>();
/**
 * The seat's flag store and event sender, for the session-events capability's new-turn clear (C30): set once the seat's
 * own capability passes `seatEnabled`, read lazily at each frame, so the order the two capabilities start in is moot.
 */
const flagsOf = new WeakMap<WiringCtx, CustodianFlags>();
/**
 * One flag store per file, per process: a store caches the file, so a second one (a config reload starts the seat's
 * capability again) would write its map over the first's entries.
 */
let heldFlags: { readonly path: string; readonly store: CustodianFlags } | null = null;
const flagStoreFor = (path: string, now: () => number): CustodianFlags => {
  if (heldFlags?.path === path) return heldFlags.store;
  const store = createCustodianFlags({ path, now, warn: (line) => log.warn(line) });
  heldFlags = { path, store };
  return store;
};
const sendEventOf = new WeakMap<WiringCtx, (event: CustodianEvent) => Promise<boolean>>();
/** The session-events capability's messaging, which the custodian's `nudge` delivers through (C26), read at each nudge. */
const messagesOf = new WeakMap<WiringCtx, Messages>();
/** The session-events capability's conversation table, which the adapters' state feed reads. */
const conversationsOf = new WeakMap<WiringCtx, Conversations>();

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
          draining: ctx.draining,
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
    deviceId: ctx.deviceId,
    audit: messageAudit(daemonSink),
    // In process when this machine leads (false while its term is still taking over), else sealed to the scheduler.
    route: (message) =>
      ctx.leader.term() !== null
        ? Promise.resolve(ctx.leader.onSessionMessage(message, ctx.deviceId))
        : ctx.client.sendSessionMessage(message),
  });
  const conversations = createConversations({
    configDirs: () => ctx.exclaveScan().exclaves.map((exclave) => exclave.configDir),
    launchSession: (taskId) => ctx.endedTasks.launchSession(taskId),
    panes: listPanePids,
  });
  const events = createSessionEvents({
    panes: listPanePids,
    exclaves: () => ctx.exclaveScan().exclaves,
    conversations,
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
    retain: retainFrame({
      activity: (paneId) => paneActivity.activity(paneId),
      observe: (pane, state, turnEnded) => paneRetention.observe(pane, state, turnEnded),
      onNewTurn: () => {
        const flags = flagsOf.get(ctx);
        if (flags === undefined) return undefined;
        const deps = { flags, send: sendEventOf.get(ctx), now: ctx.now, warn: (line: string): void => log.warn(line) };
        return (pane) => void clearOnNewTurn(deps, pane.taskId ?? pane.id, pane.taskId);
      },
    }),
  });
  late.events = events;
  eventsOf.set(ctx, events);
  messagesOf.set(ctx, messages);
  conversationsOf.set(ctx, conversations);
  if (drainAsk !== undefined) drainHoldsOf.set(ctx, drainAsk.holds);
  drainAsk?.start();
  // The daemon's own read for sessions that were running before it started and have not reported since.
  void conversations.sweep().catch((err: unknown) => log.warn(`conversations: ${String(err)}`));
  return {
    stop: (): void => {
      drainAsk?.stop();
      events.stop();
      conversations.stop();
      messages.stop();
    },
    local: { sessionEvents: events.handle, messages },
    armPassClose: events.armPassClose,
    messages,
    conversations,
    ...(drainAsk === undefined ? {} : { drainAsk }),
  };
};

/** Adapters' stops in flight: `run.ts`'s stop waits for them, so no child outlives the daemon unsignalled. */
const adapterStops = new Set<Promise<void>>();

/** Resolves once every adapter a stopped daemon instance ran is gone (SIGKILL after its grace). */
export async function adaptersSettled(): Promise<void> {
  await Promise.all(adapterStops);
}

/**
 * The adapters `config.json` names (docs/messaging.md §6; DESIGN.md, "Adapters"): the state feed over the session-events
 * capability's conversation table and this machine's launch ledger, and one supervised child per adapter, started once
 * the local socket is up and the feed's first read is done, never while the daemon drains for a restart (and once the
 * hold lifts, when an update is called off). Absent with no `adapters` key, or without session events.
 */
const adapters: DaemonCapability = (ctx) => {
  const configured = ctx.config.adapters;
  const conversations = conversationsOf.get(ctx);
  if (configured === undefined || Object.keys(configured).length === 0 || conversations === undefined) {
    return { stop: (): void => {} };
  }
  const feed = createAdapterFeed({
    conversations,
    tasks: ctx.endedTasks,
    exclaves: () => ctx.exclaveScan().exclaves,
    repos: ctx.repos,
  });
  const host = startAdapterHost({
    adapters: configured,
    feed,
    taskRepo: (taskId) => ctx.endedTasks.taskRepo(taskId),
    machine: { deviceId: ctx.deviceId, name: ctx.config.name },
    version: ctx.version ?? "unknown",
    audit: adapterAudit(daemonSink),
    root: adaptersDir(),
    held: () => ctx.endedTasks.draining || ctx.stopped(),
  });
  let stopped = false;
  const offGate = ctx.endedTasks.onGate((closed) => {
    if (!closed && !stopped) host.start();
  });
  return {
    afterLocal: (): void => {
      void feed
        .start()
        .then(() => {
          if (!stopped) host.start();
        })
        .catch((err: unknown) => log.warn(`adapters: the state feed did not start (${String(err)})`));
    },
    stop: (): void => {
      stopped = true;
      offGate();
      feed.stop();
      const stop = host.stop().finally(() => adapterStops.delete(stop));
      adapterStops.add(stop);
    },
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

  /** A fresh socket dir this process made: one nothing recorded yet, so whoever stops or fails owns removing it. */
  let servedDir: string | null = null;
  // Whatever a seat that is not running left: the record's round, any other round pane (a stray) and its socket dir.
  // `keepRecorded` is for a socket that would not bind: the recorded dir may be another instance's live one.
  const sweep = async (keepRecorded = false): Promise<void> => {
    const record = ctx.custodianSeat();
    const { round, socketDir } = record;
    for (const dir of new Set([keepRecorded ? undefined : socketDir, servedDir])) {
      // oxlint-disable-next-line no-await-in-loop -- at most two, each an unlink and an rmdir
      if (dir !== undefined && dir !== null && !ctx.stopped()) await removeCustodianSocketDir(dir);
    }
    const panes = await listRoundPanes();
    for (const { pane } of panes) {
      // oxlint-disable-next-line no-await-in-loop -- one pane at a time: each close is a graceful exit
      await audit.kill(pane, "off", await closeOutcome(pane, opts.graceMs));
    }
    if (round === undefined && panes.length === 0) {
      if (socketDir !== undefined && !keepRecorded && !ctx.stopped()) {
        const { socketDir: _socketDir, ...rest } = record;
        await ctx.custodianSaved(rest);
      }
      return;
    }
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
  const sweepLeftovers = (keepRecorded = false): void =>
    void sweep(keepRecorded).catch((err: unknown) =>
      log.warn(`custodian: closing a leftover round failed: ${String(err)}`),
    );

  if (!seatEnabled(ctx.config, opts, process.platform) || settings === undefined || platform === null) {
    sweepLeftovers();
    return { stop: (): void => {} };
  }

  const flags = flagStoreFor(custodianSessionsPath(), ctx.now);
  // In process when this machine leads (false while its term is still taking over), else sealed to the scheduler.
  // On the relay leg true is only that the envelope was written to the socket: no ack comes back, so a relay with no
  // leader behind it loses the event, and the resends the callers keep (a held `failing`, a kept entry) are what covers
  // the ordinary gap.
  const sendEvent = (event: CustodianEvent): Promise<boolean> =>
    deliverEvent(
      {
        leads: () => ctx.leader.term() !== null,
        inProcess: (e) => ctx.leader.onCustodianEvent(e, ctx.deviceId),
        relay: (e) => ctx.client.sendCustodianEvent(e),
      },
      event,
    );
  flagsOf.set(ctx, flags);
  sendEventOf.set(ctx, sendEvent);

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
  // Its last turn left background work or a cron to wake it: `close` refuses it, and it makes no round due.
  const awaitsWake = (pane: string, taskId?: string | null): boolean =>
    eventsOf.get(ctx)?.awaitsWake(pane, taskId) === true;

  /** The seat's checks failed, it refused this host or it could not start: no round will ever run here. */
  let seatFailed = false;
  /** What the status shows for a failed seat: `failing`, with the log's last round (read once, when it failed). */
  let failedLast: Pick<CustodianStatus, "e" | "n"> = {};
  /** The pause as last read once the seat failed (no seat's `view` reads it then): `p` keeps it visible behind `failing`. */
  let failedControl: PauseRead = { pause: null, unreadable: false };
  const readFailedControl = (): void => {
    void readControl()
      .then((read) => {
        failedControl = read;
        return null;
      })
      .catch(() => {})
      .finally(() => ctx.refreshStatus?.());
  };
  const publish = (view: CustodianStatus, failed: boolean): Promise<void> =>
    writeSeatView({
      s: view.s,
      ...(view.e === undefined ? {} : { e: view.e }),
      ...(view.n === undefined ? {} : { n: view.n }),
      at: ctx.now(),
      failed,
      version: ctx.version ?? "unknown",
    });
  const markFailed = (): void => {
    seatFailed = true;
    readFailedControl();
    void readRounds(custodianRoundsPath())
      .then((entries) => {
        failedLast = lastRoundView(entries.at(-1));
        return null;
      })
      .catch(() => {})
      .then(() => publish({ s: "failing", ...failedLast }, true))
      .catch((err: unknown) => log.warn(`custodian: publishing the seat's view failed: ${String(err)}`))
      .finally(() => ctx.refreshStatus?.());
  };
  // The verbs exist before the seat does (its checks are async) and answer `not_custodian` until it names a round.
  const { despawn } = ctx.backend;
  const verbs: CustodianVerbs | null =
    despawn === undefined
      ? null
      : createCustodianVerbs({
          roundPane: () => seat?.roundPane() ?? null,
          roundPanePids: listRoundPanePids,
          activity: paneActivity.activity,
          sample: paneActivity.sample,
          activityNow: paneActivity.now,
          // A restored entry a sample confirmed carries facts from before this process: retention reaches back to it.
          retainedSince: () =>
            retainedSince === null ? null : Math.min(retainedSince, paneActivity.restoredSince() ?? retainedSince),
          untouchable,
          awaitsWake,
          tasks: ctx.endedTasks,
          readPr: createPrReader({ now: ctx.now }),
          worktree: createWorktreeRule({ tasks: ctx.endedTasks, repos: ctx.repos, listPanes }),
          despawn,
          killPane: async (pane) => (await tmux(["kill-pane", "-t", pane])).exitCode === 0,
          // Without messaging here (no session-events capability) a nudge has no delivery: `unsupported`.
          deliver: (pane, text, expect) =>
            messagesOf.get(ctx)?.deliverAsCustodian(pane, text, expect) ??
            Promise.resolve({ ok: false, code: "unsupported" }),
          canDeliver: (pane, expect) => messagesOf.get(ctx)?.canDeliver(pane, expect) ?? Promise.resolve(false),
          keys: sendKeys,
          settings,
          flags,
          sendEvent,
          seat: {
            count: (verb, ok) => seat?.count(verb, ok),
            countWorktree: (kind) => seat?.countWorktree(kind),
            countFlagged: () => seat?.countFlagged(),
            done: async (summary) => (await seat?.done(summary)) ?? "no_round",
            isDone: () => seat?.isDone() ?? false,
          },
          now: ctx.now,
          audit,
          warn: (line) => log.warn(line),
        });
  // The round's own socket (`custodian-socket.ts`): the seat owns its lifetime, and the verbs are served nowhere else.
  let roundSocket: { readonly stop: () => void } | null = null;
  const stopSocket = (): void => {
    roundSocket?.stop();
    roundSocket = null;
  };
  /** The machine's own roots, masked from a round and never to be covered by an allow entry. */
  const rootMasks = (): string[] => [...ctx.config.repoRoots, ...ctx.exclaveScan().exclaves.map((each) => each.root)];
  const begin = async (): Promise<void> => {
    if (verbs === null) {
      // A round with no way to close anything can act on nothing.
      log.warn("custodian: this backend cannot close a session — no rounds");
      markFailed();
      if (!cancelled) sweepLeftovers();
      return;
    }
    const problem = await (opts.sandboxProblem ?? ((): Promise<string | null> => sandboxProblem(platform)))();
    if (problem !== null) {
      log.warn(`custodian: no rounds on this host — ${problem}`);
      markFailed();
      // A host that cannot run a round is as off as a seat that is not configured: a round the last process left
      // would otherwise run on with no deadline. Not after a `stop`, whose incoming instance adopts it.
      if (!cancelled) sweepLeftovers();
      return;
    }
    // Refused, not launched: an unreadable `main.ts` makes bun exec it again and again, so a layout the round's
    // sandbox could not read fails closed here, with a fixed audited reason.
    const toolchain = await toolchainRefusal(platform, rootMasks());
    if (toolchain !== null) {
      log.warn(`custodian: no rounds on this host — ${toolchain}`);
      if (cancelled) return;
      await audit.refused("toolchain");
      markFailed();
      if (!cancelled) sweepLeftovers();
      return;
    }
    const weakerNested = opts.weakerNested ?? weakerNestedNeeded;
    if (!(opts.sandboxDrilled ?? sandboxDrilled)(platform)) {
      log.warn(`custodian: ${SANDBOX_UNDRILLED}`);
      if (cancelled) return;
      await audit.refused("sandbox_undrilled");
      markFailed();
      if (!cancelled) sweepLeftovers();
      return;
    }
    const agents = await loadAgent();
    if (cancelled) return;
    const record = ctx.custodianSeat();
    const chosen = await custodianSocketDir(record.socketDir);
    if ("problem" in chosen) {
      log.warn(`custodian: no rounds — ${chosen.problem}`);
      markFailed();
      if (!cancelled) sweepLeftovers();
      return;
    }
    if (!chosen.reused) servedDir = chosen.dir;
    if (cancelled) {
      if (!chosen.reused) await removeCustodianSocketDir(chosen.dir);
      return;
    }
    if (!chosen.reused && chosen.rejected !== undefined) {
      log.warn(`custodian: the recorded round socket dir was not kept (${chosen.rejected}); serving a fresh one`);
    }
    const started = await startCustodianSocket({
      path: join(chosen.dir, CUSTODIAN_SOCKET_NAME),
      handle: verbs.handle,
      warn: (line) => log.warn(line),
    });
    if ("problem" in started) {
      log.warn(`custodian: no rounds — ${started.problem}`);
      markFailed();
      if (!cancelled) sweepLeftovers(true);
      return;
    }
    roundSocket = started;
    if (cancelled) {
      stopSocket();
      // A fresh dir nothing recorded: the incoming instance will never serve it.
      if (!chosen.reused) await removeCustodianSocketDir(chosen.dir);
      return;
    }
    // Recorded before any round can launch, so a restart or reload serves the same dir. A recorded round is left to
    // the seat's adoption, whose end writes it (a write here would make an unreachable round look reachable).
    if (record.round === undefined && record.socketDir !== chosen.dir && !ctx.stopped()) {
      // A failed write is not a failed seat: every later seat write carries the dir too.
      await ctx
        .custodianSaved({ ...ctx.custodianSeat(), socketDir: chosen.dir })
        .catch((err: unknown) => log.warn(`custodian: could not record the round socket dir: ${String(err)}`));
      // `stop` closed the socket meanwhile, and left a dir nothing recorded to this check.
      if (cancelled) {
        if (!chosen.reused && ctx.custodianSeat().socketDir !== chosen.dir) await removeCustodianSocketDir(chosen.dir);
        return;
      }
    }
    releaseActivity = paneRetention.acquire();
    retainedSince = ctx.now();
    seat = createCustodianSeat({
      settings,
      now: ctx.now,
      ...(opts.checkIntervalMs === undefined ? {} : { checkIntervalMs: opts.checkIntervalMs }),
      activity: paneActivity.all,
      untouchable: (pane) => untouchable(pane) || awaitsWake(pane),
      busyReach: verbs.reach,
      appendRound: (entry) => upsertRound(custodianRoundsPath(), entry),
      readRounds: () => readRounds(custodianRoundsPath()),
      readControl: () => readControl(),
      peekRoundRequest: (now) => peekRoundRequest(now),
      dropRoundRequest: () => dropRoundRequest(),
      remoteId: async (round) => {
        const exclave = ctx.exclaveScan().exclaves.find((entry) => entry.id === round.exclave);
        if (exclave === undefined || round.pane === null) return null;
        const pids = await listRoundPanePids().catch(() => null);
        const panePid = [...(pids ?? [])].find(([, pane]) => pane === round.pane)?.[0];
        if (panePid === undefined) return null;
        return roundRemoteId(exclave.configDir, { panePid, startedAt: round.startedAt });
      },
      publishView: (view) => publish(view, false),
      onFailing: () => sendEvent({ kind: "failing", at: ctx.now() }),
      ...(ctx.refreshStatus === undefined ? {} : { onView: ctx.refreshStatus }),
      draining: () => ctx.endedTasks.draining,
      stopped: ctx.stopped,
      record: ctx.custodianSeat,
      roundReachable: chosen.reused,
      // Every seat write carries the dir: the seat's own records are whole, and know nothing of the socket.
      save: (next) => ctx.custodianSaved({ ...next, socketDir: chosen.dir }),
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
          custodianSocket: started.path,
          rootMasks: rootMasks(),
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
    stopSocket();
    markFailed();
    release();
    if (!cancelled) sweepLeftovers();
  });
  return {
    stop: (): void => {
      cancelled = true;
      seat?.stop();
      stopSocket();
      release();
      // A fresh dir no write recorded (a round's adoption had not finished): the incoming instance never learns it.
      if (servedDir !== null && ctx.custodianSeat().socketDir !== servedDir) {
        void removeCustodianSocketDir(servedDir);
      }
    },
    custodianStatus: (now) =>
      seatFailed
        ? { s: "failing", ...failedLast, ...(pausedAt(failedControl, now) ? { p: true as const } : {}) }
        : seat?.ready() === true
          ? seat.view(now)
          : null,
    // A failed seat has no tick to read the owner's act: re-read the pause for the row.
    custodianPoke: () => (seatFailed ? readFailedControl() : seat?.poke()),
    custodianHost: () => (seatFailed ? "failed" : seat?.ready() === true ? "ready" : "starting"),
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
  adapters,
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
  /** The leader's forwarded messages and receipts, once session events run: the handler context reads it late (`run.ts`). */
  readonly messages?: Pick<Messages, "deliverRouted" | "receipt">;
  readonly drainAsk?: DrainAsk;
  readonly custodianStatus?: (now: number) => CustodianStatus | null;
  readonly custodianPoke?: () => void;
  readonly custodianHost?: () => CustodianHost;
  readonly conversations?: SessionTagsSource;
  readonly local: LocalSurfaces;
  /** Every capability's `afterLocal`, in start order. */
  readonly afterLocal: () => void;
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
    let messages: Started["messages"];
    let drainAsk: Started["drainAsk"];
    let custodianStatus: Started["custodianStatus"];
    let custodianPoke: Started["custodianPoke"];
    let custodianHost: Started["custodianHost"];
    let conversations: Started["conversations"];
    for (const capability of capabilities) {
      const entry = capability(ctx);
      started.push(entry);
      local = mergeSurfaces(local, entry);
      armPassClose ??= entry.armPassClose;
      messages ??= entry.messages;
      drainAsk ??= entry.drainAsk;
      custodianStatus ??= entry.custodianStatus;
      custodianPoke ??= entry.custodianPoke;
      custodianHost ??= entry.custodianHost;
      conversations ??= entry.conversations;
    }
    const afterLocal = (): void => {
      for (const entry of started) entry.afterLocal?.();
    };
    return {
      local,
      afterLocal,
      stop,
      ...(armPassClose === undefined ? {} : { armPassClose }),
      ...(messages === undefined ? {} : { messages }),
      ...(drainAsk === undefined ? {} : { drainAsk }),
      ...(custodianStatus === undefined ? {} : { custodianStatus }),
      ...(custodianPoke === undefined ? {} : { custodianPoke }),
      ...(custodianHost === undefined ? {} : { custodianHost }),
      ...(conversations === undefined ? {} : { conversations }),
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
