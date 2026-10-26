import {
  CAPABILITIES,
  ENVELOPE_MAX_CT_LENGTH,
  FLEET_QUOTA_INTERVAL_MS,
  importPsk,
  ReplayGuard,
  STATUS_INTERVAL_MS,
  type Envelope,
  type MachineInfo,
  type UpdateAvailable,
} from "@seance/shared";
import { homedir } from "node:os";
import { daemonSink, ensureAuditLog, reapAudit } from "./audit.ts";
import { tmuxHarvestPanes } from "./exit-status.ts";
import { createBackend } from "./backend-default.ts";
import type { SessionBackend } from "./backend.ts";
import {
  loadConfig,
  loadPsk,
  pskFingerprint,
  QUOTA_DEFAULTS,
  runnableProblems,
  type Config,
  type ResolvedPsk,
} from "./config.ts";
import { exclaveInfoEqual, scanExclaves, tagExclaves, type ExclaveScan } from "./exclaves.ts";
import { appRelayClient } from "./app-relay.ts";
import type { BranchStateDeps } from "./branch-state.ts";
import { createHandler, createLocalOps, type HandlerContext } from "./handlers.ts";
import { createFleetQuotaWriter, newestReadings } from "./fleet-quota.ts";
import { createLeader, type Leader, type QueueStore } from "./leader.ts";
import { startLocalSocket } from "./local-socket.ts";
import { log } from "./log.ts";
import { sealMachineInfo } from "./machine-info.ts";
import { MetricsStore } from "./metrics-store.ts";
import { procOomProbe } from "./oom-kill.ts";
import type { PrPollerOpts } from "./pr-status.ts";
import { RelayClient } from "./relay-client.ts";
import { startCapabilities } from "./run-capabilities.ts";
import { startStatusLoop } from "./run-collectors.ts";
import { repoSetsEqual, scanRepos } from "./scan.ts";
import { readSource } from "./selfsource.ts";
import { EndedTasks } from "./session-events.ts";
import { LaunchLedger, launchLedgerPath } from "./launch-ledger.ts";
import { VersionFloor, versionFloorPath } from "./version-floor.ts";
import type { Fetch } from "./seams.ts";
import type { HostProbe, Registered } from "./telemetry.ts";
import { createUpdater, type UpdateEffects, type Updater } from "./update.ts";
import { createUsageRefresh, type UsageRefreshOpts } from "./usage-refresh.ts";
import { identityOfState, loadOrInitState, saveState, writeRuntime, type State } from "./state.ts";

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
  /**
   * Enables the `/usage` refresh (`usage-refresh.ts`): a stale exclave's quota
   * cache is refreshed by a `claude -p /usage` run. Off unless supplied — tests
   * run against a real home and must not spawn claude by surprise; main.ts
   * passes `{}`.
   */
  readonly usageRefresh?: UsageRefreshOpts;
  /**
   * Tests seed one store across terms and shorten the tick; absent, the leader
   * runs on the relay store.
   */
  readonly leader?: {
    readonly store?: QueueStore;
    readonly tickIntervalMs?: number;
    readonly takeoverRetryMs?: number;
    /** Tests point the PR poller at a `gh` stub; production runs its defaults. */
    readonly prStatus?: PrPollerOpts;
  };
  /** Tests only: the branch-state emitter's intervals, which are constants in production. */
  readonly branchState?: Pick<BranchStateDeps, "intervalMs" | "fetchStaleMs">;
  /**
   * The clock wiring reads — scan stamps, runtime.json, the reap schedule —
   * and the leader and telemetry inherit; defaults to `Date.now`. A sealed
   * envelope's `ts` stays on the wall clock: replay windows judge it. The
   * leader's clock also judges records peers stamped with theirs (task
   * `created_ahead`, admission age), so a test that queues tasks must keep it
   * near wall time.
   */
  readonly now?: () => number;
  /** Outbound HTTP for the leader and telemetry; defaults to the global `fetch`. */
  readonly httpFetch?: Fetch;
  /** The host telemetry samples; defaults to `hostProbe`. */
  readonly probe?: HostProbe;
  /** Tests only: the fleet quota writer's cadence, `FLEET_QUOTA_INTERVAL_MS` in production. */
  readonly fleetQuota?: { readonly intervalMs?: number };
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
 * hand an app's request to each in turn and run the one prompt once each.
 */
const schedulerGuard = new ReplayGuard();

function endedTasksFor(path: string): Promise<EndedTasks> {
  let tasks = endedTasksByLedger.get(path);
  if (tasks === undefined) {
    tasks = LaunchLedger.open(path).then(
      (ledger) => new EndedTasks(ledger, Date.now, tmuxHarvestPanes(reapAudit("harvest", daemonSink)), procOomProbe()),
    );
    endedTasksByLedger.set(path, tasks);
  }
  return tasks;
}

/**
 * The leader's version floor, one per file per process for `schedulerGuard`'s
 * reason: a floor per term, or per reload, would let the relay roll a record
 * back under whichever one had not seen it yet.
 */
const floorsByPath = new Map<string, Promise<VersionFloor>>();

function versionFloorFor(path: string): Promise<VersionFloor> {
  let floor = floorsByPath.get(path);
  if (floor === undefined) {
    floor = VersionFloor.open(path);
    floorsByPath.set(path, floor);
  }
  return floor;
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
  const now = opts.now ?? Date.now;
  const httpFetch: Fetch = opts.httpFetch ?? ((input, init) => fetch(input, init));
  const startedAt = now();

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
  let lastSizeReport: string | null = null;
  const buildInfo = async (): Promise<Envelope> => {
    const info: MachineInfo = {
      name: config.name,
      platform: process.platform,
      repos: state.repos,
      scannedAt: state.scannedAt ?? 0,
      exclaves: exclaveScan.info,
      source,
      lastUpdate: state.lastUpdate ?? null,
      capabilities: [
        CAPABILITIES.metrics,
        CAPABILITIES.taskId,
        CAPABILITIES.exitStatus,
        CAPABILITIES.reportedDone,
        CAPABILITIES.pinAccount,
        CAPABILITIES.continueTask,
      ],
    };
    const candidate: Registered = { scan: info.scannedAt, exclaves: exclaveScan };
    const { sealed, droppedSkills, oversized } = await sealMachineInfo(key, state.deviceId, info);
    // Once per size-deciding content: `scannedAt`/`lastUpdate` change every rescan without changing the
    // size, and a line after each hourly rescan and reconnect would say nothing new.
    const content = JSON.stringify({ repos: info.repos, exclaves: info.exclaves });
    if (content !== lastSizeReport) {
      lastSizeReport = content;
      if (droppedSkills) log.warn(`register blob over ${ENVELOPE_MAX_CT_LENGTH} chars — sent without project skills`);
      if (oversized)
        log.error(
          `register blob over ${ENVELOPE_MAX_CT_LENGTH} chars with nothing left to drop — the relay will refuse it`,
        );
    }
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
    state = { ...state, repos: scanned, scannedAt: now() };
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
      connectedSince: connected ? now() : null,
      sha: source?.sha ?? null,
    }).catch((err: unknown) => log.warn(`could not write runtime.json: ${String(err)}`));
  };

  // Created after the client (its report re-registers); the closures below
  // read it late through this let. One announce per process: the wave must
  // not re-fire on every reconnect.
  let updater: Updater | null = null;
  let announcedHere = false;
  let announcePending =
    opts.selfUpdate !== undefined && source !== null && previousSha !== undefined && previousSha !== source.sha;

  // Sampling from the first start on, whether or not anything asks: the history
  // the `metrics` op serves has to predate the chart that opens it. A state dir
  // that refuses the file costs the history, never the daemon.
  const metrics = await MetricsStore.open().catch((err: unknown) => {
    log.warn(`metrics store unavailable (${String(err)}) — keeping history in memory`);
    return MetricsStore.memory();
  });

  // Session events (the session-events mod): ended tasks fold into the `sessions`
  // reply, and task sessions' states go to the leader. Built before the handler
  // context, which reads the store.
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

  // Created before the client, whose every register samples at once; reads it late.
  const status = startStatusLoop(
    metrics,
    {
      config,
      registered: () => registered,
      sessions: () => handlerCtx.backend.sessions(state.repos),
      now,
      httpFetch,
      ...(opts.probe === undefined ? {} : { probe: opts.probe }),
    },
    {
      intervalMs: opts.telemetryIntervalMs ?? STATUS_INTERVAL_MS,
      connected: () => client.connected,
      send: (snapshot, current) => client.sendStatus(snapshot, current),
      // Late-bound: the writer is built after the loop it reads.
      onSample: () => fleetQuota.sampled(),
    },
  );

  // Every daemon may be nominated; this is what runs if it is. Its app-role leg
  // is built per term over the key imported above, never the broker's.
  const leader = createLeader({
    selfDeviceId: state.deviceId,
    createRelay: (term, onEvent) =>
      appRelayClient(
        config,
        key,
        (line) => log.info(line),
        { term, onEvent, guard: schedulerGuard },
        FLEET_QUOTA_INTERVAL_MS,
      ),
    local: createLocalOps(handlerCtx, "leader"),
    // Late-bound: the client below is built after the leader it hands frames to.
    reply: (to, response) => client.reply(to, response),
    resign: () => void client.resign(),
    floor: await versionFloorFor(versionFloorPath()),
    // Production leads on the relay store, over this daemon's own socket (the
    // term fence is that socket); tests seed one store across terms instead.
    ...(opts.leader?.store !== undefined
      ? { store: opts.leader.store }
      : { storeLeg: { store: (frame) => client.store(frame) }, key }),
    ...(opts.leader?.tickIntervalMs === undefined ? {} : { tickIntervalMs: opts.leader.tickIntervalMs }),
    ...(opts.leader?.takeoverRetryMs === undefined ? {} : { takeoverRetryMs: opts.leader.takeoverRetryMs }),
    now,
    httpFetch,
    prStatus: opts.leader?.prStatus ?? {},
  });

  // Over this daemon's own socket, which `quota:` needs registered, not fenced.
  // Late-bound to the client like the leader; started once the client is.
  const fleetQuota = createFleetQuotaWriter({
    leg: { store: (frame) => client.store(frame) },
    key,
    deviceId: state.deviceId,
    observations: () => newestReadings(status.latest(), registered.scan, registered.exclaves.info),
    ready: () => client.registered,
    now,
    ...(opts.fleetQuota?.intervalMs === undefined ? {} : { intervalMs: opts.fleetQuota.intervalMs }),
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
    onStoreChanged: (storeKey, version) => leader.onStoreChanged(storeKey, version),
    schedulerGuard,
    onRegister: (info): void => {
      registered = candidates.get(info) ?? registered;
      status.sampleNow();
      fleetQuota.registered();
    },
    onConnect: (): void => {
      updateRuntime(true);
      announcedHere = false;
      if (announcePending && source !== null) {
        const notice: UpdateAvailable = { sha: source.sha, commitTs: source.commitTs };
        // Spent only once it is actually on the wire: a socket that dropped
        // during the seal would otherwise burn the single announce this
        // process ever makes, and no one would re-fire it.
        void client.broadcast("update-available", notice).then((sent) => {
          if (!sent) return;
          announcePending = false;
          announcedHere = true;
        });
      }
      // Every register, not just boot: the daemon survives sleep, and a woken
      // machine's redial is the only moment it can learn what it missed.
      updater?.check("register");
    },
    // On the wire is not delivered: the relay drops the announce along with a
    // register it refuses, so the redial that registers sends it again.
    onRefused: () => {
      if (announcedHere) announcePending = true;
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
      last: state.lastUpdate ?? null,
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
  fleetQuota.start();
  // The first sample waits for no socket: history starts with the process.
  status.sampleNow();

  try {
    await handlerCtx.backend.start?.();
  } catch (err) {
    log.warn(`backend start failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const capabilities = startCapabilities({
    config,
    resolved,
    key,
    deviceId: state.deviceId,
    client,
    leader,
    backend: handlerCtx.backend,
    endedTasks,
    repos: () => state.repos,
    exclaveScan: () => exclaveScan,
    usageRefresh:
      opts.usageRefresh === undefined
        ? null
        : createUsageRefresh({
            // Read per startDaemon, so a config reload's new daemon takes a changed value.
            staleAfterMs: (config.quota ?? QUOTA_DEFAULTS).staleAfterMinutes * 60_000,
            ...opts.usageRefresh,
            scan: () => exclaveScan,
            home,
          }),
    rescan,
    lastReapAt: () => state.lastReapAt,
    reaped: async (at) => {
      state = { ...state, lastReapAt: at };
      await saveState(state);
    },
    stopped: () => stopped,
    now,
    httpFetch,
    ...(opts.rescanIntervalMs === undefined ? {} : { rescanIntervalMs: opts.rescanIntervalMs }),
    ...(opts.reapCheckIntervalMs === undefined ? {} : { reapCheckIntervalMs: opts.reapCheckIntervalMs }),
    ...(opts.branchState === undefined ? {} : { branchState: opts.branchState }),
  });

  // After the relay leg, because the local surface is the optional one: it never
  // throws, and a box that cannot bind it still serves every phone.
  const local = await startLocalSocket({ handle: createHandler(handlerCtx, "local"), ...capabilities.local });

  return {
    client,
    localSocket: local.path,
    stop: (): void => {
      stopped = true;
      status.stop();
      fleetQuota.stop();
      handlerCtx.backend.stop?.();
      capabilities.stop();
      // Its leg, timer and loop go with the handle too, before the client it hears terms on.
      leader.stop();
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
