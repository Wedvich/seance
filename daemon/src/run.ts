import { APP_ID, importPsk, seal, type Envelope, type MachineInfo } from "@seance/shared";
import { daemonSink } from "./audit.ts";
import { createBackend } from "./backend-default.ts";
import type { SessionBackend } from "./backend.ts";
import { loadConfig, loadPsk, runnableProblems, type Config, type ResolvedPsk } from "./config.ts";
import { createHandler } from "./handlers.ts";
import { log } from "./log.ts";
import { RelayClient } from "./relay-client.ts";
import { repoSetsEqual, scanRepos } from "./scan.ts";
import { loadOrInitState, saveState, writeRuntime, type State } from "./state.ts";

const RESCAN_INTERVAL_MS = 3_600_000;

export interface DaemonHandle {
  readonly client: RelayClient;
  readonly stop: () => void;
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

  let state: State = await loadOrInitState();
  const key = await importPsk(resolved.psk);
  const startedAt = Date.now();

  const buildInfo = async (): Promise<Envelope> => {
    const info: MachineInfo = {
      name: config.name,
      platform: process.platform,
      repos: state.repos,
      scannedAt: state.scannedAt ?? 0,
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

  const rescan = async (): Promise<State["repos"]> => {
    const scanned = await scanRepos(config.repoRoots, state.repos);
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
    void writeRuntime({
      pid: process.pid,
      startedAt,
      connected,
      connectedSince: connected ? Date.now() : null,
    });
  };

  const client = new RelayClient({
    url: config.relayUrl,
    bearerToken: config.bearerToken,
    deviceId: state.deviceId,
    key,
    buildInfo,
    handle: createHandler({
      backend: opts.backend ?? createBackend(config),
      getRepos: () => state.repos,
      rescan,
      auditSink: daemonSink,
    }),
    onConnect: () => updateRuntime(true),
    onDisconnect: () => updateRuntime(false),
    ...(opts.pingIntervalMs !== undefined ? { pingIntervalMs: opts.pingIntervalMs } : {}),
    ...(opts.pongTimeoutMs !== undefined ? { pongTimeoutMs: opts.pongTimeoutMs } : {}),
    ...(opts.baseBackoffMs !== undefined ? { baseBackoffMs: opts.baseBackoffMs } : {}),
  });

  log.info(`seanced starting — device ${state.deviceId}, ${state.repos.length} cached repos`);
  client.start();

  // Cached repos registered instantly above; refresh in the background now,
  // then hourly. Explicit rescans arrive as ops.
  void rescan();
  const rescanTimer = setInterval(() => void rescan(), opts.rescanIntervalMs ?? RESCAN_INTERVAL_MS);

  return {
    client,
    stop: (): void => {
      clearInterval(rescanTimer);
      client.stop();
      updateRuntime(false);
    },
  };
}
