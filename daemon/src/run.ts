import { APP_ID, importPsk, seal, type Envelope, type MachineInfo, type UpdateAvailable } from "@seance/shared";
import { daemonSink, ensureAuditLog } from "./audit.ts";
import { createBackend } from "./backend-default.ts";
import type { SessionBackend } from "./backend.ts";
import { loadConfig, loadPsk, runnableProblems, type Config, type ResolvedPsk } from "./config.ts";
import { createHandler, type HandlerContext } from "./handlers.ts";
import { startLocalSocket } from "./local-socket.ts";
import { log } from "./log.ts";
import { RelayClient } from "./relay-client.ts";
import { repoSetsEqual, scanRepos } from "./scan.ts";
import { readSource } from "./selfsource.ts";
import { createUpdater, type UpdateEffects, type Updater } from "./update.ts";
import { loadOrInitState, saveState, writeRuntime, type State } from "./state.ts";

const RESCAN_INTERVAL_MS = 3_600_000;

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
  /** The session backend; defaults to `createBackend(config)`. Tests inject one with a tighter pane-death budget. */
  readonly backend?: SessionBackend;
  readonly rescanIntervalMs?: number;
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

  const buildInfo = async (): Promise<Envelope> => {
    const info: MachineInfo = {
      name: config.name,
      platform: process.platform,
      repos: state.repos,
      scannedAt: state.scannedAt ?? 0,
      source,
      lastUpdate: state.lastUpdate ?? null,
    };
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
    const scanned = await scanRepos(config.repoRoots, state.repos);
    if (stopped) return scanned;
    const changed = !repoSetsEqual(scanned, state.repos);
    state = { ...state, repos: scanned, scannedAt: Date.now() };
    await saveState(state);
    if (changed) {
      log.info(`repo set changed (${scanned.length} repos) — re-registering`);
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

  // One context, a handler per inbound surface. The relay leg and the local op
  // socket share the backend, the repo set and the audit sink, and differ only
  // in the origin they are tagged with — which is what keeps "every spawn path
  // audits through one formatter" true as surfaces are added.
  const handlerCtx: HandlerContext = {
    backend: opts.backend ?? createBackend(config),
    getRepos: () => state.repos,
    rescan,
    auditSink: daemonSink,
    ...(opts.selfUpdate !== undefined && source !== null
      ? {
          updateAvailable: (notice: UpdateAvailable): void => {
            // The sha we already run is the wave stopping, not a nudge.
            if (notice.sha !== source.sha) updater?.check("announce");
          },
        }
      : {}),
  };

  const client = new RelayClient({
    url: config.relayUrl,
    bearerToken: config.bearerToken,
    deviceId: state.deviceId,
    key,
    buildInfo,
    handle: createHandler(handlerCtx),
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

  log.info(`seanced starting — device ${state.deviceId}, ${state.repos.length} cached repos`);
  client.start();

  // After the relay leg, because the local surface is the optional one: it never
  // throws, and a box that cannot bind it still serves every phone.
  const local = await startLocalSocket({ handle: createHandler(handlerCtx, "local") });

  // Cached repos registered instantly above; refresh in the background now,
  // then hourly. Explicit rescans arrive as ops.
  void rescan();
  const rescanTimer = setInterval(() => void rescan(), opts.rescanIntervalMs ?? RESCAN_INTERVAL_MS);

  return {
    client,
    localSocket: local.path,
    stop: (): void => {
      stopped = true;
      clearInterval(rescanTimer);
      // Before the relay client, so a reload's stop→start sequence has the path
      // free by the time the incoming daemon binds it.
      local.stop();
      // Before the client: a check racing the swap must not report through a
      // stale `state` and clobber what the incoming daemon already saved.
      updater?.stop();
      client.stop();
      updateRuntime(false);
    },
    updater,
  };
}
