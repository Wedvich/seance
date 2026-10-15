import {
  APP_ID,
  importPsk,
  METRICS_CAPABILITY,
  seal,
  STATUS_INTERVAL_MS,
  type Envelope,
  type MachineInfo,
  type UpdateAvailable,
} from "@seance/shared";
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
import { createHandler, type HandlerContext } from "./handlers.ts";
import { startLocalSocket } from "./local-socket.ts";
import { log } from "./log.ts";
import { MetricsStore } from "./metrics-store.ts";
import { DAY_MS, formatReport, ReapBusy, runReap, withReapLock } from "./reap.ts";
import { RelayClient } from "./relay-client.ts";
import { repoSetsEqual, scanRepos } from "./scan.ts";
import { readSource } from "./selfsource.ts";
import { fitStatus } from "./status.ts";
import { createTelemetry } from "./telemetry.ts";
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
  let exclaveScan = await scanExclaves(opts.home);
  warnRejected(exclaveScan);
  state = { ...state, repos: tagExclaves(state.repos, exclaveScan.exclaves) };

  // The stamp of the blob last handed to a register, which every `status` names
  // as its `scan`: `state.scannedAt` moves on every hourly rescan while a
  // re-register happens only on a changed repo set, and a reader drops a status
  // whose stamp disagrees with the blob it holds (docs/scheduler.md, "Encoding").
  let registeredScan = 0;
  const buildInfo = async (): Promise<Envelope> => {
    const info: MachineInfo = {
      name: config.name,
      platform: process.platform,
      repos: state.repos,
      scannedAt: state.scannedAt ?? 0,
      exclaves: exclaveScan.info,
      source,
      lastUpdate: state.lastUpdate ?? null,
      capabilities: [METRICS_CAPABILITY],
    };
    registeredScan = info.scannedAt;
    return seal(
      key,
      { to: APP_ID, from: state.deviceId },
      {
        id: crypto.randomUUID(),
        ts: Date.now(),
        op: "machine-info",
        payload: info,
      },
    );
  };

  let stopped = false;

  const rescan = async (): Promise<State["repos"]> => {
    const [repos, exclaves] = await Promise.all([
      scanRepos(config.repoRoots, state.repos),
      scanExclaves(opts.home, exclaveScan.info),
    ]);
    const scanned = tagExclaves(repos, exclaves.exclaves);
    if (stopped) return scanned;
    warnRejected(exclaves);
    // A sign-in or a new line in `.exclaves` re-registers like a new clone does:
    // the blob is the only place apps learn either from.
    const changed = !repoSetsEqual(scanned, state.repos) || !exclaveInfoEqual(exclaves.info, exclaveScan.info);
    exclaveScan = exclaves;
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

  // One context, a handler per inbound surface. The relay leg and the local op
  // socket share the backend, the repo set and the audit sink, and differ only
  // in the origin they are tagged with — which is what keeps "every spawn path
  // audits through one formatter" true as surfaces are added.
  const handlerCtx: HandlerContext = {
    backend: opts.backend ?? createBackend(config),
    getRepos: () => state.repos,
    rescan,
    auditSink: daemonSink,
    metrics: (request) => metrics.query(request),
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
    machine: config.name,
    diskPaths: config.repoRoots,
    exclaves: () => exclaveScan,
    sessions: () => handlerCtx.backend.sessions(state.repos),
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
        const status = fitStatus({ ...snapshot, scan: registeredScan });
        if (status !== snapshot && !trimWarned) {
          // Once: the condition is structural (too many exclaves for the bound),
          // not transient, and the fix is a schema change rather than a retry.
          log.warn("status trimmed to fit the relay's bound — some quota detail is left out of the live view");
          trimWarned = true;
        }
        return client.sendStatus(status);
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

  const client = new RelayClient({
    url: config.relayUrl,
    bearerToken: config.bearerToken,
    identity,
    key,
    buildInfo,
    handle: createHandler(handlerCtx),
    onRegister: sampleNow,
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
    onDisconnect: () => updateRuntime(false),
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

  // After the relay leg, because the local surface is the optional one: it never
  // throws, and a box that cannot bind it still serves every phone.
  const local = await startLocalSocket({
    handle: createHandler(handlerCtx, "local"),
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
  };
}
