import { pskFingerprint } from "../../daemon/src/config-checks.ts";
import { credentialPskPath, readCredentialPsk } from "../../daemon/src/credential.ts";
import { parseState, pidAlive, readRuntime } from "../../daemon/src/state.ts";
import { loadArchivistConfig } from "./config.ts";
import { archivistConfigPath, archivistStateDir, runtimePathIn, statePathIn } from "./paths.ts";

export interface StatusOpts {
  readonly configPath?: string;
  readonly stateDir?: string;
  readonly credentialPath?: string | null;
}

/**
 * What `seance-archivist status` prints. Never the seed, the key or the token:
 * the key shows as its fingerprint, and only when this process can read it —
 * outside the unit no credential is delivered, which is the expected answer.
 * Reads only; mints no identity (`parseState`, not `loadOrInitState`).
 */
export async function statusLines(opts: StatusOpts = {}): Promise<readonly string[]> {
  const configPath = opts.configPath ?? archivistConfigPath();
  const stateDir = opts.stateDir ?? archivistStateDir();
  const lines: string[] = [`config:  ${configPath}`];
  try {
    const config = await loadArchivistConfig(configPath);
    lines.push(`name:    ${config.name}`, `relay:   ${config.relayUrl}`);
  } catch (err) {
    lines.push(`         ${err instanceof Error ? err.message : String(err)}`);
  }
  lines.push(`state:   ${stateDir}`);
  const state = await parseState(statePathIn(stateDir));
  const stateUnreadable = state !== null && "problem" in state;
  if (stateUnreadable) {
    // Typically the wrong user: the state dir is 0700 to the archivist's own.
    lines.push(`device:  state ${state.problem} — run status as the archivist's user`);
  } else lines.push(`device:  ${state === null ? "none yet — minted on first run" : state.state.deviceId}`);
  const credentialPath = opts.credentialPath === undefined ? credentialPskPath() : opts.credentialPath;
  const psk = await readCredentialPsk(credentialPath);
  lines.push(
    `psk:     ${psk === null ? "not delivered to this process (only the unit gets it)" : await fingerprintOf(psk)}`,
  );
  if (stateUnreadable) {
    lines.push("running: unknown (state unreadable)");
    return lines;
  }
  const runtime = await readRuntime(runtimePathIn(stateDir));
  if (runtime === null || !pidAlive(runtime.pid)) {
    lines.push("running: no");
    return lines;
  }
  const since = runtime.connectedSince === null ? "" : ` since ${new Date(runtime.connectedSince).toISOString()}`;
  lines.push(`running: pid ${runtime.pid}, ${runtime.connected ? `connected${since}` : "not connected"}`);
  return lines;
}

async function fingerprintOf(psk: string): Promise<string> {
  return pskFingerprint(psk).catch(() => "unreadable (not base64)");
}
