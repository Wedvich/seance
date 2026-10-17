import {
  APP_ID,
  CAPABILITIES,
  importPsk,
  ReplayGuard,
  seal,
  STATUS_INTERVAL_MS,
  type Envelope,
  type MachineInfo,
  type UpdateAvailable,
} from "@seance/shared";
import { homedir } from "node:os";
import { daemonSink, ensureAuditLog, reapAudit } from "./audit.ts";
import { createBackend } from "./backend-default.ts";
import { brokerRelay, createBroker } from "./broker.ts";
import type { SessionBackend } from "./backend.ts";
import {
  loadConfig,
  loadPsk,
  pskFingerprint,
  REAP_DEFAULTS,
  runnableProblems,
  type Config,
  type ResolvedPsk,
} from "./config.ts";
import { exclaveInfoEqual, scanExclaves, tagExclaves, type ExclaveScan } from "./exclaves.ts";
import { appRelayClient } from "./app-relay.ts";
import { createHandler, createLocalOps, type HandlerContext } from "./handlers.ts";
import { createLeader, type Leader, type LeaderOpts } from "./leader.ts";
import { startLocalSocket } from "./local-socket.ts";
import { log } from "./log.ts";
import { MetricsStore } from "./metrics-store.ts";
import { peerPidSupported } from "./peer.ts";
import { DAY_MS, formatReport, ReapBusy, runReap, withReapLock } from "./reap.ts";
import { RelayClient } from "./relay-client.ts";
import { repoSetsEqual, scanRepos } from "./scan.ts";
import { readSource } from "./selfsource.ts";
import { createSessionEvents, EndedTasks, listPanePids, peerBindingProblem } from "./session-events.ts";
import { SessionQuota } from "./session-quota.ts";
import { LaunchLedger, launchLedgerPath } from "./launch-ledger.ts";
import { fitStatus } from "./status.ts";
import { createTelemetry, type Registered } from "./telemetry.ts";
import { createUpdater, type UpdateEffects, type Updater } from "./update.ts";
import { identityOfState, loadOrInitState, saveState, writeRuntime, type State } from "./state.ts";

const RESCAN_INTERVAL_MS = 3_600_000;
/**
 * The schedule asks whether a reap is due this often, against `lastReapAt`
 * in state.json — never on a bare interval from start, which the daemon's
 * frequent restarts (updates, config reloads) would keep resetting.
 */
const REAP_CHECK_INTERVAL_MS = 600_000;

export interface DaemonHandle {
  readonly client: RelayClient;
  readonly stop: () => void;
  /** Null unless self-update is wired; tests await its `settled()` instead of sleeping. */
  readonly updater: Updater | null;
  /** Where the local op socket bound, or null when it could not — see `local-socket.ts`. */
  readonly localSocket: string | null;
  /** The scheduler role, as far as anything outside the daemon needs it: tests read its term and await its takeover. */
  readonly leader: Pick<Leader, "term" | "settled">;
}

export interface RunOpts {
  readonly config?: Config;
  readonly pingIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** The session backend; defaults to `createBackend(config)`. Tests inject one with a tighter pane-death budget. */
  readonly backend?: SessionBackend;
  readonly rescanIntervalMs?: number;
  /** Where `.exclaves` and the config dirs live; defaults to `homedir()`. Tests point it at a fixture. */
  readonly home?: string;
  /** How often the reap schedule asks whether a run is due; tests shorten it. */
  readonly reapCheckIntervalMs?: number;
  /** Telemetry sample period; defaults to the `status` cadence. Tests shorten it. */
  readonly telemetryIntervalMs?: number;
  /**
   * A psk the caller already resolved, to skip re-reading the platform store.
   * The supervisor passes it so a reload spawns one `security`/DPAPI read
   * instead of three, and so a rollback restores the exact key the running
   * daemon imported rather than whatever the store holds mid-failure.
   */
  readonly resolvedPsk?: ResolvedPsk;
  /**
   * Enables the self-update protocol: an announce when the sha changed since
   * the last run, and a checked pipeline on every register. Off unless
   * supplied — tests and embedders must not reach the network by surprise;
   * main.ts passes `{}`.
   */
  readonly selfUpdate?: SelfUpdateOpts;
  /** The scheduler role's store and tick cadence; tests seed the one and shorten the other. */
  readonly leader?: Pick<LeaderOpts, "store" | "tickIntervalMs">;
}

export interface SelfUpdateOpts {
  /** Checkout to announce and update; defaults to this one. Tests point it at a fixture. */
  readonly root?: string;
  readonly debounceMs?: number;
  readonly effects?: UpdateEffects;
}

/** Every scan, not once: the line nags until the file is fixed, which is the point. */
function warnRejected(scan: ExclaveScan): void {
  if (scan.rejected.length === 0) return;
  log.warn(`~/.exclaves: skipped ${scan.rejected.map((line) => JSON.stringify(line)).join(", ")}`);
}

/**
 * One per ledger file per process: a config reload restarts `startDaemon` in
 * process while the outgoing instance may still be mid-spawn, and two ledgers
 * over one file would each overwrite the other's launches — or answer
 * `sessions` without waiting for the other's spawn.
 */
const endedTasksByLedger = new Map<string, Promise<EndedTasks>>();

/**
 * Every envelope `to: "scheduler"` this process opens — each term's leg and the
 * `not_leader` answer — goes through this one guard. The relay chooses which
 * term an envelope reaches, so a guard per term, or per reload, would let it
 * hand an app's `submit` to each in turn and run the one prompt once each.
 */
const schedulerGuard = new ReplayGuard();

function endedTasksFor(path: string): Promise<EndedTasks> {
  let tasks = endedTasksByLedger.get(path);
  if (tasks === undefined) {
    tasks = LaunchLedger.open(path).then((ledger) => new EndedTasks(ledger));
    endedTasksByLedger.set(path, tasks);
  }
  return tasks;
}

/** Wires config/state/scan/handlers into a running relay client. */
export async function startDaemon(opts: RunOpts = {}): Promise<DaemonHandle> {
  const config = opts.config ?? (await loadConfig());
  const resolved = opts.resolvedPsk ?? (await loadPsk(config));
  const problems = runnableProblems(config, resolved?.psk ?? null);
  // `resolved === null` is already in `problems`; naming it here narrows the
  // type so the import below needs no assertion.
  if (problems.length > 0 || resolved === null) {
    for (const problem of problems) log.error(`config: ${problem}`);
    throw new Error("config is not runnable — fix the problems above");
  }

  // Before the first audit line, and on every start: the service redirect
  // creates the log as whoever opened it (root, under a system unit) at that
  // manager's umask, and only the daemon runs often enough to put it back.
  const logProblem = await ensureAuditLog();
  if (logProblem !== null) log.warn(logProblem);

  let state: State = await loadOrInitState();
  const identity = await identityOfState(state);
  const key = await importPsk(resolved.psk);
  const startedAt = Date.now();

  // Read once per process: this is the code actually running, not whatever a
  // later `git pull` puts on disk. The previous run's sha decides the announce
  // below — captured before the stamp overwrites it.
  const source = await readSource(opts.selfUpdate?.root);
  const previousSha = state.lastRunSha;
  if (source !== null && previousSha !== source.sha) {
    state = { ...state, lastRunSha: source.sha };
    await saveState(state);
  }

  // Read with the repos, so the blob's `exclaves` and each repo's `exclave`
  // come from one reading of `.exclaves`: a status quota entry indexes into
  // this list, and the cached repos get re-tagged here so the instant register
  // below can't pair a stale tag with a fresh list.
  // One home for the scan and the backend, so a spawn pre-trusts the repo in
  // the config dir of the exclave the scan placed it in.
  const home = opts.home ?? homedir();
  let exclaveScan = await scanExclaves(home);
  warnRejected(exclaveScan);
  state = { ...state, repos: tagExclaves(state.repos, exclaveScan.exclaves) };

  // The stamp and exclave list of the blob last registered, which every
  // `status` names as its `scan` and indexes into: `state.scannedAt` moves on
  // every hourly rescan while a re-register happens only on a changed set, and
  // a reader drops a status whose stamp disagrees with the blob it holds
  // (DESIGN.md, Presence & identity). Committed only once the frame has left —
  // keyed by the blob, so two overlapping registers each commit their own.
  let registered: Registered = { scan: 0, exclaves: exclaveScan };
  const candidates = new WeakMap<Envelope, Registered>();
  const buildInfo = async (): Promise<Envelope> => {
    const info: MachineInfo = {
      name: config.name,
      platform: process.platform,
      repos: state.repos,
      scannedAt: state.scannedAt ?? 0,
      exclaves: exclaveScan.info,
      source,
      lastUpdate: state.lastUpdate ?? null,
      capabilities: [CAPABILITIES.metrics, CAPABILITIES.taskId],
    };
    const candidate: Registered = { scan: info.scannedAt, exclaves: exclaveScan };
    const sealed = await seal(
      key,
      { to: APP_ID, from: state.deviceId },
      {
        id: crypto.randomUUID(),
        ts: Date.now(),
        op: "machine-info",
        payload: info,
      },
    );
    candidates.set(sealed, candidate);
    return sealed;
  };

  let stopped = false;

  const scanOnce = async (): Promise<State["repos"]> => {
    const [repos, exclaves] = await Promise.all([
      scanRepos(config.repoRoots, state.repos),
      scanExclaves(home, exclaveScan.info),
    ]);
    const scanned = tagExclaves(repos, exclaves.exclaves);
    if (stopped) return scanned;
    warnRejected(exclaves);
    // A sign-in or a new line in `.exclaves` re-registers like a new clone does:
    // the blob is the only place apps learn either from.
    const changed = !repoSetsEqual(scanned, state.repos) || !exclaveInfoEqual(exclaves.info, exclaveScan.info);
    exclaveScan = exclaves;
    // Same blob list, fresh paths: a moved exclave root is counted where it now
    // is without a register, since every index still means the same exclave.
    if (exclaveInfoEqual(exclaves.info, registered.exclaves.info)) registered = { ...registered, exclaves };
    state = { ...state, repos: scanned, scannedAt: Date.now() };
    await saveState(state);
    if (changed) {
      log.info(
        `repo set or exclaves changed (${scanned.length} repos, ${exclaves.info.length} exclaves) — re-registering`,
      );
      await client.reRegister();
    }
    return scanned;
  };
  // One scan at a time, each begun after the last has registered. Two in flight
  // (the boot or hourly one, and an app's) diff against and commit to the same
  // `state`: the one begun first, blind to a clone made since, could land last
  // and take the clone back out — and a register built between the two commits
  // carried whichever was current, so the app's own rescan never re-registered.
  let scanning: Promise<unknown> = Promise.resolve();
  const rescan = (): Promise<State["repos"]> => {
    const next = scanning.then(scanOnce);
    scanning = next.catch(() => undefined);
    return next;
  };

  const updateRuntime = (connected: boolean): void => {
    // Unawaited, so its rejection has to land somewhere: `status` reading a
    // stale runtime.json is a nuisance, an unhandled rejection is the daemon.
    void writeRuntime({
      pid: process.pid,
      startedAt,
      connected,
      connectedSince: connected ? Date.now() : null,
      sha: source?.sha ?? null,
    }).catch((err: unknown) => log.warn(`could not write runtime.json: ${String(err)}`));
  };

  // Created after the client (its report re-registers); the closures below
  // read it late through this let. One announce per process: the wave must
  // not re-fire on every reconnect.
  let updater: Updater | null = null;
  let announcePending =
    opts.selfUpdate !== undefined && source !== null && previousSha !== undefined && previousSha !== source.sha;

  // Sampling from the first start on, whether or not anything asks: the history
  // the `metrics` op serves has to predate the chart that opens it. A state dir
  // that refuses the file costs the history, never the daemon.
  const metrics = await MetricsStore.open().catch((err: unknown) => {
    log.warn(`metrics store unavailable (${String(err)}) — keeping history in memory`);
    return MetricsStore.memory();
  });

  // Session events (the session-events mod): quota reports fold into telemetry,
  // ended tasks into the `sessions` reply, and task sessions' states go to the
  // leader. Built before the handler context, which reads the two stores.
  const sessionQuota = await SessionQuota.open();
  const endedTasks = await endedTasksFor(launchLedgerPath());

  // One context, a handler per inbound surface. The relay leg and the local op
  // socket share the backend, the repo set and the audit sink, and differ only
  // in the origin they are tagged with — which is what keeps "every spawn path
  // audits through one formatter" true as surfaces are added.
  const handlerCtx: HandlerContext = {
    backend: opts.backend ?? createBackend(config, { home }),
    getRepos: () => state.repos,
    rescan,
    auditSink: daemonSink,
    metrics: (request) => metrics.query(request),
    tasks: endedTasks,
    ...(opts.selfUpdate !== undefined && source !== null
      ? {
          updateAvailable: (notice: UpdateAvailable): void => {
            // The sha we already run is the wave stopping, not a nudge.
            if (notice.sha !== source.sha) updater?.check("announce");
          },
        }
      : {}),
  };

  const telemetry = createTelemetry(metrics, {
    diskPaths: config.repoRoots,
    registered: () => registered,
    sessions: () => handlerCtx.backend.sessions(state.repos),
    sessionQuota: (exclave, account) => sessionQuota.get(exclave, account),
  });
  const statusIntervalMs = opts.telemetryIntervalMs ?? STATUS_INTERVAL_MS;
  let telemetryTimer: ReturnType<typeof setInterval> | null = null;
  let trimWarned = false;
  // Each sample also goes out as `status` while the socket is up — whether or
  // not anyone is watching, so a freshly opened app finds the latest on the
  // relay instead of waiting a beat.
  const sampleTelemetry = (): void => {
    if (stopped) return;
    telemetry
      .tick()
      .then((snapshot) => {
        if (stopped || !client.connected) return false;
        // A tick begun before the latest register names the blob before it —
        // at boot, none at all — and every reader would drop it. Sent anyway it
        // spends the relay's one-per-interval floor, and the tick the register
        // queued behind it, carrying the right stamp, is the one refused. Asked
        // again by `sendStatus` after its seal, since a register can leave meanwhile.
        const current = (): boolean => snapshot.scan === registered.scan;
        if (!current()) return false;
        const status = fitStatus(snapshot);
        if (status.tr !== undefined && !trimWarned) {
          // Once: the condition is structural (too many exclaves for the bound),
          // not transient, and the fix is a schema change rather than a retry.
          log.warn("status trimmed to fit the relay's bound — some quota detail is left out of the live view");
          trimWarned = true;
        }
        return client.sendStatus(status, current);
      })
      .catch((err: unknown) => log.warn(`telemetry: ${String(err)}`));
  };
  // Also right after every register, re-arming the beat so the next lands past
  // the relay's floor: the register just changed the blob a status indexes, and
  // the registry push an app got carries no snapshot until this one.
  const sampleNow = (): void => {
    if (telemetryTimer !== null) clearInterval(telemetryTimer);
    telemetryTimer = setInterval(sampleTelemetry, statusIntervalMs);
    sampleTelemetry();
  };

  // Every daemon may be nominated; this is what runs if it is. Its app-role leg
  // is built per term over the key imported above, never the broker's.
  const leader = createLeader({
    selfDeviceId: state.deviceId,
    createRelay: (term, onEvent) =>
      appRelayClient(config, key, (line) => log.info(line), { term, onEvent, guard: schedulerGuard }),
    local: createLocalOps(handlerCtx, "leader"),
    // Late-bound: the client below is built after the leader it hands frames to.
    reply: (to, response) => client.reply(to, response),
    resign: () => void client.resign(),
    ...opts.leader,
  });

  const client = new RelayClient({
    url: config.relayUrl,
    bearerToken: config.bearerToken,
    identity,
    key,
    buildInfo,
    handle: createHandler(handlerCtx),
    onLead: (term) => leader.lead(term),
    onFollow: () => leader.follow("the relay moved the role elsewhere"),
    onScheduler: (env) => leader.deliver(env),
    schedulerGuard,
    onRegister: (info): void => {
      registered = candidates.get(info) ?? registered;
      sampleNow();
    },
    onConnect: (): void => {
      updateRuntime(true);
      if (announcePending && source !== null) {
        const notice: UpdateAvailable = { sha: source.sha, commitTs: source.commitTs };
        // Spent only once it is actually on the wire: a socket that dropped
        // during the seal would otherwise burn the single announce this
        // process ever makes, and no one would re-fire it.
        void client.broadcast("update-available", notice).then((sent) => {
          if (sent) announcePending = false;
        });
      }
      // Every register, not just boot: the daemon survives sleep, and a woken
      // machine's redial is the only moment it can learn what it missed.
      updater?.check("register");
    },
    onDisconnect: () => {
      updateRuntime(false);
      // The term belongs to this socket: replies to the leader arrive on it, and
      // the relay re-nominates — under a new term — once the redial registers.
      leader.follow("the daemon's relay socket dropped");
    },
    ...(opts.pingIntervalMs !== undefined ? { pingIntervalMs: opts.pingIntervalMs } : {}),
    ...(opts.pongTimeoutMs !== undefined ? { pongTimeoutMs: opts.pongTimeoutMs } : {}),
    ...(opts.baseBackoffMs !== undefined ? { baseBackoffMs: opts.baseBackoffMs } : {}),
    ...(opts.maxBackoffMs !== undefined ? { maxBackoffMs: opts.maxBackoffMs } : {}),
  });

  if (opts.selfUpdate !== undefined && source !== null) {
    const su = opts.selfUpdate;
    updater = createUpdater({
      ...(su.root !== undefined ? { root: su.root } : {}),
      ...(su.debounceMs !== undefined ? { debounceMs: su.debounceMs } : {}),
      ...(su.effects !== undefined ? { effects: su.effects } : {}),
      sink: daemonSink,
      report: async (report) => {
        state = { ...state, lastUpdate: report };
        await saveState(state);
        // The register blob carries lastUpdate, so the app-visible record
        // refreshes without waiting for the next reconnect.
        await client.reRegister();
      },
    });
  }

  // Which key we came up with, so a half-rotated PSK reads as a mismatch in the
  // log instead of a silent stream of undecryptable frames. On a credential-
  // delivered box nothing outside the unit can read the key, so this line is
  // the only place its fingerprint can come from.
  log.info(
    `seanced starting — device ${state.deviceId}, ${state.repos.length} cached repos, ` +
      `psk ${await pskFingerprint(resolved.psk)} (${resolved.source})`,
  );
  client.start();
  // The first sample waits for no socket: history starts with the process.
  sampleNow();

  try {
    await handlerCtx.backend.start?.();
  } catch (err) {
    log.warn(`backend start failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Only where the key is service-delivered: there `seanced mcp` cannot read it,
  // and the broker is its only way to other machines. Anywhere else it reads the
  // key itself, so a broker would only widen what a same-uid process can do
  // without touching the key store — and keep an app-role surface in the daemon.
  // Built over the key imported above — never a second lookup — and dials
  // nothing until a peer first asks it to reach another machine.
  const broker =
    resolved.source === "credential"
      ? createBroker({ selfDeviceId: state.deviceId, relay: brokerRelay(config, key), auditSink: daemonSink })
      : null;

  // Where the kernel cannot name a socket's peer, an event's pane is its own
  // claim — said once, since it changes what an event can be trusted to mean.
  // Where it can, binding still rests on a field Bun leaves undocumented; a
  // failed probe means every event will be refused, and this line is why.
  if (!peerPidSupported()) {
    log.warn("local socket: this host reports no peer pid — session events are bound by the pane they name");
  } else {
    void peerBindingProblem().then((problem) => {
      if (problem === null) return;
      log.warn(`local socket: peer binding failed its probe (${problem}) — every session event will be refused`);
    });
  }
  const sessionEvents = createSessionEvents({
    panes: listPanePids,
    exclaves: () => exclaveScan.exclaves,
    accountOf: (exclave) => exclaveScan.info.find((info) => info.id === exclave)?.accountId ?? null,
    // The leader reaches itself in process, never by a relay round trip. A
    // daemon that just lost the role still sends to "scheduler", which the
    // relay routes to whoever leads now.
    forward: (event) => {
      if (leader.term() !== null) {
        void leader.onSession(event.taskId, event.state, { deviceId: state.deviceId, pane: event.session });
        return;
      }
      void client.sendToScheduler(event).catch((err: unknown) => log.warn(`session-event: ${String(err)}`));
    },
    quota: sessionQuota,
    ended: endedTasks,
  });

  // After the relay leg, because the local surface is the optional one: it never
  // throws, and a box that cannot bind it still serves every phone.
  const local = await startLocalSocket({
    handle: createHandler(handlerCtx, "local"),
    sessionEvents: sessionEvents.handle,
    ...(broker === null ? {} : { broker: broker.handle }),
  });

  // Cached repos registered instantly above; refresh in the background now,
  // then hourly. Explicit rescans arrive as ops.
  void rescan();
  const rescanTimer = setInterval(() => void rescan(), opts.rescanIntervalMs ?? RESCAN_INTERVAL_MS);

  // Off unless configured. The report goes to the log, one line each; what it
  // destroyed is in the audit trail as origin=schedule. A run the CLI already
  // holds the lock for is skipped and tried at the next check.
  const reapSettings = config.reap ?? REAP_DEFAULTS;
  const reapEveryMs = reapSettings.intervalHours * 3_600_000;
  const reapAbort = new AbortController();
  let reaping = false;
  const reapIfDue = async (): Promise<void> => {
    if (reaping || stopped || Date.now() - (state.lastReapAt ?? 0) < reapEveryMs) return;
    reaping = true;
    try {
      const report = await withReapLock(() =>
        runReap({
          repos: state.repos,
          dryRun: false,
          minAgeMs: reapSettings.minAgeDays * DAY_MS,
          audit: reapAudit("schedule", daemonSink),
          signal: reapAbort.signal,
        }),
      );
      for (const line of formatReport(report)) log.info(`reap: ${line}`);
      // A run the stop cut short isn't the one the schedule promised.
      if (stopped) return;
      state = { ...state, lastReapAt: Date.now() };
      await saveState(state);
    } catch (err) {
      log.warn(err instanceof ReapBusy ? `reap: skipped — ${err.message}` : `reap failed: ${String(err)}`);
    } finally {
      reaping = false;
    }
  };
  const reapTimer =
    reapEveryMs > 0 ? setInterval(() => void reapIfDue(), opts.reapCheckIntervalMs ?? REAP_CHECK_INTERVAL_MS) : null;

  return {
    client,
    localSocket: local.path,
    stop: (): void => {
      stopped = true;
      clearInterval(rescanTimer);
      if (telemetryTimer !== null) clearInterval(telemetryTimer);
      handlerCtx.backend.stop?.();
      if (reapTimer !== null) clearInterval(reapTimer);
      reapAbort.abort();
      // Its app-role socket and timers go with this handle: a reload builds a
      // fresh broker, and an orphaned one would hold a relay socket forever.
      broker?.stop();
      // Its leg, timer and loop go with the handle too, before the client it hears terms on.
      leader.stop();
      sessionEvents.stop();
      // Before the relay client, so a reload's stop→start sequence has the path
      // free by the time the incoming daemon binds it.
      local.stop();
      // Before the client: a check racing the swap must not report through a
      // stale `state` and clobber what the incoming daemon already saved.
      updater?.stop();
      client.stop();
      // Last, after every timer that writes: a tick still in flight fails its
      // write into the warn above rather than a closed-handle throw elsewhere.
      metrics.close();
      updateRuntime(false);
    },
    updater,
    leader,
  };
}
