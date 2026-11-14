import { chmod, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import {
  DAEMON_ROLES,
  importAccountKey,
  importPsk,
  parseSourceInfo,
  quote,
  type Plain,
  type RelayStatus,
  type SourceInfo,
} from "@seance/shared";
import { appRelayClient } from "../../daemon/src/app-relay.ts";
import { bearerTokenWarnings, pskFingerprint, runnableProblems } from "../../daemon/src/config-checks.ts";
import { CRED_NAME, credentialPskPath, readCredentialPsk } from "../../daemon/src/credential.ts";
import { log } from "../../daemon/src/log.ts";
import { RelayClient } from "../../daemon/src/relay-client.ts";
import { identityOfState, writeRuntime } from "../../daemon/src/state.ts";
import { isUpdateAvailable } from "../../daemon/src/update-notice.ts";
import { Archive } from "./archive.ts";
import { startCollector, type CollectTimings } from "./collect.ts";
import { loadArchivistConfig } from "./config.ts";
import { ARCHIVIST_OPS } from "./answer.ts";
import { answerArchiveStatus, createStatusAnswer, startCountRefresher } from "./health.ts";
import { createIngestClock } from "./ingest-clock.ts";
import { sealArchivistInfo } from "./info.ts";
import { answerArchiveMetrics, answerArchiveTasks, createMetricsAnswer, createTasksAnswer } from "./query.ts";
import { MetricsArchive } from "./metrics-archive.ts";
import { startMetricsCollector, type MetricsTimings } from "./metrics-collect.ts";
import { createRefusalTally } from "./refusal-tally.ts";
import {
  archivePathIn,
  archivistConfigPath,
  archivistStateDir,
  metricsPathIn,
  runtimePathIn,
  servedSourcePathIn,
  statePathIn,
  updateRequestPathIn,
} from "./paths.ts";
import { loadSeatState } from "./state.ts";
import { rootRefusal } from "./unprivileged.ts";
import { createUpdateRequester } from "./update-request.ts";

export interface ArchivistOpts {
  readonly configPath?: string;
  readonly stateDir?: string;
  /** The delivered key's path; null when no credentials were delivered. Default: `$CREDENTIALS_DIRECTORY/seance-psk`. */
  readonly credentialPath?: string | null;
  /** The process's ids; tests pass 0 to prove the refusal. */
  readonly uid?: number;
  readonly gid?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** The collector's pacing; tests shorten it. */
  readonly collect?: Partial<CollectTimings>;
  /** The metrics pull's pacing; tests shorten it. */
  readonly metrics?: Partial<MetricsTimings>;
}

/**
 * The shared client's wire log writes a send and a recv line per store-get; a
 * burst of `queue-changed` is a burst of gets, and the collector says what it
 * archived itself. Timeouts, refusals and drops still log.
 */
export function isStoreGetTraffic(line: string): boolean {
  return /^wire send id=\S+ t=store-get$/u.test(line) || /^wire recv re=\S+ t=store-record pending=/u.test(line);
}

export interface Archivist {
  readonly deviceId: string;
  readonly stop: () => void;
}

/** Owner-only: it holds the identity seed and the plaintext history (DESIGN.md, Archivist, A12). */
const STATE_DIR_MODE = 0o700;

/**
 * The archivist's two legs (DESIGN.md, Archivist, A7, A8): a `/daemon` socket that
 * holds the seat — a v2 register claiming `archivist`, which the relay accepts
 * only from the `ARCHIVIST` id — and an app-role socket for reading, as the
 * leader's own app leg reads. It advertises no repos and no exclaves, answers
 * three ops, from the app only (`archive-status`: counts, sizes and times;
 * `archive-metrics` and `archive-tasks`: reads of its own two files), never enqueues and never writes the store; it writes only
 * `archive.sqlite` (`collect.ts`) and `metrics.sqlite` (`metrics-collect.ts`),
 * plus the update request a fleet announce asks for (`update-request.ts`).
 * What it may import is held by
 * archivist/test/layering.test.ts.
 */
export async function startArchivist(opts: ArchivistOpts = {}): Promise<Archivist> {
  // First, before any file is read or written: a root run must leave nothing behind it owns.
  const refusal = rootRefusal(opts.uid ?? process.getuid?.(), opts.gid ?? process.getgid?.());
  if (refusal !== null) throw new Error(refusal);

  const configPath = opts.configPath ?? archivistConfigPath();
  const config = await loadArchivistConfig(configPath);
  const credentialPath = opts.credentialPath === undefined ? credentialPskPath() : opts.credentialPath;
  const psk = await readCredentialPsk(credentialPath);
  if (psk === null) {
    throw new Error(
      `no key at $CREDENTIALS_DIRECTORY/${CRED_NAME} — the archivist reads its PSK only from its unit's ` +
        `LoadCredentialEncrypted=${CRED_NAME}:<blob> (docs/psk.md)`,
    );
  }
  const problems = runnableProblems(config, psk);
  if (problems.length > 0) throw new Error(`config at ${configPath}: ${problems.join("; ")}`);
  for (const warning of bearerTokenWarnings(config.bearerToken)) log.warn(warning);

  const stateDir = opts.stateDir ?? archivistStateDir();
  await mkdir(stateDir, { recursive: true, mode: STATE_DIR_MODE });
  // mkdir's mode is masked by the umask and ignored for a directory already there.
  await chmod(stateDir, STATE_DIR_MODE);
  const state = await loadSeatState(statePathIn(stateDir));
  const identity = await identityOfState(state);
  const [key, accountKey] = await Promise.all([importPsk(psk), importAccountKey(psk)]);
  const fingerprint = await pskFingerprint(psk);
  const archive = await Archive.open(archivePathIn(stateDir));
  let metricsArchive: MetricsArchive | null = null;
  try {
    metricsArchive = await MetricsArchive.open(metricsPathIn(stateDir));
    return await startLegs(metricsArchive);
  } catch (err) {
    // A throw before the returned `stop` exists would leave the handles, and the files' locks, open.
    archive.close();
    metricsArchive?.close();
    throw err;
  }

  async function startLegs(metrics: MetricsArchive): Promise<Archivist> {
    const startedAt = Date.now();
    const clock = createIngestClock();
    const refusals = createRefusalTally();
    const source = await readServedSource(servedSourcePathIn(stateDir));
    let connectedSince: number | null = null;
    // Chained: the refusal loop flaps connected/disconnected back to back, and unordered renames could leave a stale value.
    let runtimeWrites: Promise<void> = Promise.resolve();
    const updateRuntime = (connected: boolean): void => {
      connectedSince = connected ? (connectedSince ?? Date.now()) : null;
      const runtime = { pid: process.pid, startedAt, connected, connectedSince };
      runtimeWrites = runtimeWrites
        .then(() => writeRuntime(runtime, runtimePathIn(stateDir)))
        .catch((err: unknown) => log.warn(`could not write runtime: ${String(err)}`));
    };

    const appLeg = appRelayClient(config, { key, accountKey }, (line) => {
      if (!isStoreGetTraffic(line)) log.info(`app leg: ${line}`);
    });
    const updates = createUpdateRequester({ path: updateRequestPathIn(stateDir) });
    const requestUpdate = (written: Promise<void>): void => {
      written.catch((err: unknown) => log.warn(`could not request an update check: ${String(err)}`));
    };

    let appStatus: RelayStatus = appLeg.getState().status;
    const unsubscribe = appLeg.subscribe(() => {
      const { status, rejection } = appLeg.getState();
      if (status === appStatus) return;
      appStatus = status;
      log.info(`app leg ${status}${rejection === null ? "" : ` (${rejection})`}`);
    });

    const counts = startCountRefresher({ archive, metrics, log });
    const answerStatus = createStatusAnswer({
      counts: counts.snapshot,
      clock,
      refusals,
      onlineSince: () => connectedSince,
      archivePath: archivePathIn(stateDir),
      metricsPath: metricsPathIn(stateDir),
    });
    const answerMetrics = createMetricsAnswer(metrics);
    const answerTasks = createTasksAnswer(archive, log);

    const seat = new RelayClient({
      url: config.relayUrl,
      bearerToken: config.bearerToken,
      identity,
      key,
      role: DAEMON_ROLES.archivist,
      buildInfo: () =>
        sealArchivistInfo(key, identity.deviceId, {
          archivist: true,
          name: config.name,
          platform: process.platform,
          ...(source === null ? {} : { source }),
        }),
      // Three request ops are the archivist's (`ARCHIVIST_OPS`), answered only to the app; a request for anything
      // else gets no answer. The one other frame it takes is the fleet's update announce, a broadcast no one awaits (A26).
      handle: (plain: Plain, from: string): Promise<Plain | null> => {
        if (plain.op === "archive-status") return answerArchiveStatus(plain, from, answerStatus, log);
        if (plain.op === "archive-metrics") return answerArchiveMetrics(plain, from, answerMetrics, log);
        if (plain.op === "archive-tasks") return answerArchiveTasks(plain, from, answerTasks, log);
        if (plain.op === "update-available") {
          if (isUpdateAvailable(plain.payload)) requestUpdate(updates.announce(plain.payload.sha));
          else log.warn("dropped malformed update-available payload");
          return Promise.resolve(null);
        }
        log.warn(`dropped ${quote(plain.op)} from ${from}: the archivist answers only ${ARCHIVIST_OPS.join(", ")}`);
        return Promise.resolve(null);
      },
      onConnect: () => {
        updateRuntime(true);
        requestUpdate(updates.registered());
        // A 401 on the app leg is permanent for that client; the /daemon upgrade succeeding says the token works now.
        // Fires once the register has left, not when it is accepted (there is no ack): a refused seat gets here too.
        if (appLeg.getState().status === "rejected") appLeg.reconnect();
      },
      onDisconnect: () => updateRuntime(false),
      ...(opts.baseBackoffMs === undefined ? {} : { baseBackoffMs: opts.baseBackoffMs }),
      ...(opts.maxBackoffMs === undefined ? {} : { maxBackoffMs: opts.maxBackoffMs }),
    });

    const collector = startCollector({
      source: appLeg,
      archive,
      accountKey,
      selfId: identity.deviceId,
      log,
      clock,
      refusals,
      ...(opts.collect === undefined ? {} : { timings: opts.collect }),
    });
    const metricsCollector = startMetricsCollector({
      source: appLeg,
      archive: metrics,
      accountKey,
      selfId: identity.deviceId,
      log,
      clock,
      ...(opts.metrics === undefined ? {} : { timings: opts.metrics }),
    });

    log.info(
      `seance-archivist ${quote(config.name)} on ${hostname()}: deviceId ${identity.deviceId}, ` +
        `psk ${fingerprint} (credential), relay ${config.relayUrl}`,
    );
    seat.start();
    appLeg.start();
    updateRuntime(false);

    return {
      deviceId: identity.deviceId,
      stop: (): void => {
        unsubscribe();
        collector.stop();
        counts.stop();
        metricsCollector.stop();
        seat.stop();
        appLeg.stop();
        // After the collectors: a reply landing past this point is dropped there, never written.
        archive.close();
        metrics.close();
      },
    };
  }
}

/**
 * What the update unit recorded of the checkout this process runs: the run
 * process never runs git, so it reads the file. Anything unreadable means no
 * build line, never a refused start.
 */
async function readServedSource(path: string): Promise<SourceInfo | null> {
  try {
    return parseSourceInfo(await Bun.file(path).json());
  } catch {
    return null;
  }
}
