import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "@seance/shared";
import { childEnv } from "../exec.ts";
import {
  connectCodex,
  initializeCodex,
  ownDirectory,
  socketState,
  SOCKET_NAME,
  type CodexAnswer,
  type CodexConnection,
} from "./client.ts";
import {
  isRemoteId,
  parseRemoteStatus,
  REMOTE_CLIENTS_MAX,
  type RemoteMethod,
  type RemoteRecord,
  type RemoteStatus,
} from "./remote.ts";

/**
 * The server `seance codex pair | unpair` drive (DESIGN.md, Daemon, "Codex remote control"; docs/codex.md, "Remote
 * control (phase 3)"): a `codex app-server --listen` of the verb's own on the machine's home, never stdio, since a
 * stdio server enrolls an environment of its own that no session's `--listen` server shares (the item 9 spike), so a
 * phone paired through one would never reach a session. Started in a 0700 run dir the verb made (`/tmp/seance-cxp-`,
 * never the panes' `/tmp/seance-cx-` mark), dialled only once `socketState` passes, its `initialize` held to the
 * home's realpath, and killed by process group when the verb ends however it ends.
 *
 * What the verbs keep of the answers: the environment id and client ids (to note and to revoke), the pairing code
 * (printed to the owner's own terminal, nothing else of Codex's is) and its expiry, and a claimed flag. No id reaches
 * the terminal, a log or an audit line.
 */

const PAIR_RUN_PREFIX = "/tmp/seance-cxp-";
const SOCKET_WAIT_MS = 30_000;
const ENVIRONMENT_WAIT_MS = 30_000;
const POLL_MS = 250;
const KILL_AFTER_MS = 5_000;
/** `manualPairingCode` as Codex prints it (`XXXX-XXXX` seen): printable, bounded, so the terminal shows nothing else. */
const CODE_PATTERN = /^[A-Za-z0-9-]{4,32}$/u;
/** `client/list` pages read at most: a bound, not a policy. */
const LIST_PAGES_MAX = 4;

export interface PairServer {
  readonly call: (method: RemoteMethod, params: Readonly<Record<string, unknown>>) => Promise<CodexAnswer>;
  readonly close: () => Promise<void>;
}

export interface PairServerOptions {
  readonly bin: string;
  readonly env: Readonly<Record<string, string>>;
  readonly home: string;
}

/** Starts and dials the verb's server; a string says why it could not, for the owner. */
export async function openPairServer(opts: PairServerOptions): Promise<PairServer | string> {
  const home = await realpath(opts.home).catch(() => null);
  if (home === null) return "the Codex home is missing";
  let runDir: string;
  try {
    runDir = await mkdtemp(PAIR_RUN_PREFIX);
    await chmod(runDir, 0o700);
  } catch {
    return "could not make a run dir under /tmp";
  }
  const cleanup = async (): Promise<void> => {
    await rm(runDir, { recursive: true, force: true });
  };
  if ((await ownDirectory(runDir)) === null) {
    await cleanup();
    return "the run dir is not this user's own";
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([opts.bin, "app-server", "--listen", `unix://${join(runDir, SOCKET_NAME)}`], {
      cwd: opts.home,
      env: childEnv(opts.env, true),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      // Its own group, so a kill reaches whatever it started.
      detached: true,
    });
  } catch {
    await cleanup();
    return "codex app-server could not start";
  }
  let connection: CodexConnection | null = null;
  const close = async (): Promise<void> => {
    connection?.close();
    signal(proc.pid, "SIGTERM");
    // A timer, not `Bun.sleep`: one left pending would hold the CLI's process open for its length.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), KILL_AFTER_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!exited) signal(proc.pid, "SIGKILL");
    await cleanup();
  };
  const deadline = Date.now() + SOCKET_WAIT_MS;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling: each check gates the next
    const state = await socketState(runDir);
    if (state === "ready") break;
    if (state === "refused" || proc.exitCode !== null || Date.now() >= deadline) {
      // oxlint-disable-next-line no-await-in-loop -- leaves the loop
      await close();
      return state === "refused" ? "the server's socket is not this user's own" : "codex app-server did not listen";
    }
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(POLL_MS);
  }
  connection = await connectCodex(runDir);
  if (connection === null) {
    await close();
    return "could not connect to codex app-server";
  }
  const init = await initializeCodex(connection, home, { experimental: true });
  if (!init.ok) {
    await close();
    return init.answer === "home" ? "codex app-server runs on another home" : "codex app-server refused to start";
  }
  const held = connection;
  return { call: (method, params) => held.request(method, params), close };
}

function signal(pid: number, sig: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, sig);
  } catch {
    // group already gone
  }
}

function resultOf(answer: CodexAnswer): unknown {
  return answer.kind === "result" ? answer.value : undefined;
}

/**
 * Remote control on (ephemeral: nothing persists in the home), then the status read until it names the environment:
 * `connected`, or `errored` while a session's server holds the backend's one connection, which still pairs and lists
 * (the item 9 spike). Null when no environment came.
 */
export async function enableForPairing(server: PairServer, now: () => number = Date.now): Promise<string | null> {
  const enabled = parseRemoteStatus(resultOf(await server.call("remoteControl/enable", { ephemeral: true })));
  if (enabled === null || enabled.status === "disabled") return null;
  const deadline = now() + ENVIRONMENT_WAIT_MS;
  let status: RemoteStatus | null = enabled;
  while (status !== null && status.environmentId === null && now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling: each read gates the next
    await Bun.sleep(POLL_MS);
    // oxlint-disable-next-line no-await-in-loop
    status = parseRemoteStatus(resultOf(await server.call("remoteControl/status/read", {})));
  }
  return status?.environmentId ?? null;
}

/** Every client of the environment, by id, at most `REMOTE_CLIENTS_MAX`; null when the list could not be read. */
export async function listClients(server: PairServer, environmentId: string): Promise<readonly string[] | null> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < LIST_PAGES_MAX; page++) {
    const params = { environmentId, ...(cursor === null ? {} : { cursor }) };
    // oxlint-disable-next-line no-await-in-loop -- pages follow their cursor
    const value = resultOf(await server.call("remoteControl/client/list", params));
    if (!isRecord(value) || !Array.isArray(value["data"])) return null;
    for (const client of value["data"]) {
      const id = isRecord(client) ? client["clientId"] : undefined;
      if (isRemoteId(id) && !ids.includes(id) && ids.length < REMOTE_CLIENTS_MAX) ids.push(id);
    }
    const next = value["nextCursor"];
    if (typeof next !== "string" || next === "" || next.length > 1024) return ids;
    cursor = next;
  }
  return ids;
}

export interface PairingCode {
  readonly code: string;
  /** Unix seconds, as Codex answers it. */
  readonly expiresAt: number;
}

export async function startPairing(server: PairServer): Promise<PairingCode | null> {
  const value = resultOf(await server.call("remoteControl/pairing/start", { manualCode: true }));
  if (!isRecord(value)) return null;
  const { manualPairingCode: code, expiresAt } = value;
  if (typeof code !== "string" || !CODE_PATTERN.test(code)) return null;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)) return null;
  return { code, expiresAt };
}

export type PairingWait = "claimed" | "lapsed" | "cancelled" | "failed";

/**
 * Polls `pairing/status` until the code is claimed, it lapses, or `cancelled()` says the owner gave up. A failed read
 * is retried until the code lapses: a phone typing slowly is no failure.
 */
export async function awaitPairing(
  server: PairServer,
  pairing: PairingCode,
  opts: { readonly cancelled: () => boolean; readonly now?: () => number; readonly pollMs?: number },
): Promise<PairingWait> {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 2_000;
  let answered = false;
  while (!opts.cancelled() && now() < pairing.expiresAt * 1000) {
    // oxlint-disable-next-line no-await-in-loop -- polling: each read gates the next
    const value = resultOf(await server.call("remoteControl/pairing/status", { manualPairingCode: pairing.code }));
    if (isRecord(value) && typeof value["claimed"] === "boolean") {
      answered = true;
      if (value["claimed"]) return "claimed";
    }
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(pollMs);
  }
  if (opts.cancelled()) return "cancelled";
  return answered ? "lapsed" : "failed";
}

/** The note a claimed pairing leaves: every client the environment lists now, the new phone among them. */
export function pairedRecord(environmentId: string, clients: readonly string[], at: number): RemoteRecord | null {
  if (clients.length === 0) return null;
  return { v: 1, environmentId, clients: [...clients], at };
}

/** Revokes each client; the count that refused. */
export async function revokeClients(
  server: PairServer,
  environmentId: string,
  clients: readonly string[],
): Promise<number> {
  let failed = 0;
  for (const clientId of clients) {
    // oxlint-disable-next-line no-await-in-loop -- one revoke at a time, each counted
    const answer = await server.call("remoteControl/client/revoke", { environmentId, clientId });
    if (answer.kind !== "result") failed++;
  }
  return failed;
}
