import { APP_ID, importPsk, seal, type Envelope, type MachineInfo } from "@seance/shared";
import { loadConfig, loadPsk, runnableProblems, type Config } from "./config.ts";
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
  readonly spawnWaitMs?: number;
  readonly rescanIntervalMs?: number;
}

/** Wires config/state/scan/handlers into a running relay client. */
export async function startDaemon(opts: RunOpts = {}): Promise<DaemonHandle> {
  const config = opts.config ?? (await loadConfig());
  const resolved = await loadPsk(config);
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
      tmuxSession: config.tmuxSession,
      getRepos: () => state.repos,
      rescan,
      ...(opts.spawnWaitMs !== undefined ? { spawnWaitMs: opts.spawnWaitMs } : {}),
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
