import { chmod, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { DAEMON_ROLES, importPsk, quote, type Plain, type RelayStatus } from "@seance/shared";
import { appRelayClient } from "../../daemon/src/app-relay.ts";
import { bearerTokenWarnings, pskFingerprint, runnableProblems } from "../../daemon/src/config-checks.ts";
import { CRED_NAME, credentialPskPath, readCredentialPsk } from "../../daemon/src/credential.ts";
import { log } from "../../daemon/src/log.ts";
import { RelayClient } from "../../daemon/src/relay-client.ts";
import { identityOfState, loadOrInitState, writeRuntime } from "../../daemon/src/state.ts";
import { loadArchivistConfig } from "./config.ts";
import { sealArchivistInfo } from "./info.ts";
import { archivistConfigPath, archivistStateDir, runtimePathIn, statePathIn } from "./paths.ts";
import { rootRefusal } from "./unprivileged.ts";

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
}

export interface Archivist {
  readonly deviceId: string;
  readonly stop: () => void;
}

/** Owner-only: it holds the identity seed now and the plaintext history later (docs/archivist.md, A12). */
const STATE_DIR_MODE = 0o700;

/**
 * The archivist's two legs (docs/archivist.md, A7, A8): a `/daemon` socket that
 * holds the seat — a v2 register claiming `archivist`, which the relay accepts
 * only from the `ARCHIVIST` id — and an app-role socket for reading, as the
 * leader's own app leg reads. It advertises no repos and no exclaves, answers
 * no op, never enqueues and never writes the store; what it may import is held
 * by archivist/test/layering.test.ts.
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
  const state = await loadOrInitState(statePathIn(stateDir));
  const identity = await identityOfState(state);
  const key = await importPsk(psk);

  const startedAt = Date.now();
  let connectedSince: number | null = null;
  const updateRuntime = (connected: boolean): void => {
    connectedSince = connected ? (connectedSince ?? Date.now()) : null;
    writeRuntime({ pid: process.pid, startedAt, connected, connectedSince }, runtimePathIn(stateDir)).catch(
      (err: unknown) => log.warn(`could not write runtime: ${String(err)}`),
    );
  };

  const appLeg = appRelayClient(config, key, (line) => log.info(`app leg: ${line}`));
  let appStatus: RelayStatus = appLeg.getState().status;
  const unsubscribe = appLeg.subscribe(() => {
    const { status, rejection } = appLeg.getState();
    if (status === appStatus) return;
    appStatus = status;
    log.info(`app leg ${status}${rejection === null ? "" : ` (${rejection})`}`);
  });

  const seat = new RelayClient({
    url: config.relayUrl,
    bearerToken: config.bearerToken,
    identity,
    key,
    role: DAEMON_ROLES.archivist,
    buildInfo: () =>
      sealArchivistInfo(key, identity.deviceId, { archivist: true, name: config.name, platform: process.platform }),
    // No op is the archivist's: an app that knows the flag never sends one, and an older one gets no answer.
    handle: (plain: Plain, from: string): Promise<null> => {
      log.warn(`dropped ${quote(plain.op)} from ${from}: the archivist answers no op`);
      return Promise.resolve(null);
    },
    onConnect: () => {
      updateRuntime(true);
      // A 401 on the app leg is permanent for that client; the seat's register being accepted says the token works now.
      if (appLeg.getState().status === "rejected") appLeg.reconnect();
    },
    onDisconnect: () => updateRuntime(false),
    ...(opts.baseBackoffMs === undefined ? {} : { baseBackoffMs: opts.baseBackoffMs }),
    ...(opts.maxBackoffMs === undefined ? {} : { maxBackoffMs: opts.maxBackoffMs }),
  });

  log.info(
    `seance-archivist ${quote(config.name)} on ${hostname()}: deviceId ${identity.deviceId}, ` +
      `psk ${await pskFingerprint(psk)} (credential), relay ${config.relayUrl}`,
  );
  seat.start();
  appLeg.start();
  updateRuntime(false);

  return {
    deviceId: identity.deviceId,
    stop: (): void => {
      unsubscribe();
      seat.stop();
      appLeg.stop();
    },
  };
}
