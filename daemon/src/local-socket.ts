import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { Socket } from "bun";
import type { ErrorResponse, OpName, Plain } from "@seance/shared";
import { quote } from "@seance/shared";
import type { Check } from "./check.ts";
import { localSocketReachable } from "./local-client.ts";
import { log } from "./log.ts";
import { runDir, socketPath } from "./paths.ts";

/**
 * The daemon's local op surface: semantic ops from another process on this box,
 * with no relay, no envelope and no PSK. It exists so `seanced mcp` can spawn on
 * the machine it runs on without a round trip to Cloudflare and back down the
 * daemon's own websocket.
 *
 * Why this shape rather than handing the key out or letting a second process
 * drive tmux itself: a peer here can ask for two named ops and nothing else. It
 * cannot address another machine, cannot reach the `"machines"` group address,
 * and every request it makes lands in the audit log tagged `origin=local`. That
 * is DESIGN.md's "op-level proxy … never the raw key", as opposed to a crypto
 * oracle, which same-uid peers make unpoliceable.
 *
 * It grants no authority a same-uid process did not already have: such a process
 * can read `config.json` and take the PSK outright, run `seanced spawn`, or talk
 * to the tmux server directly. What it adds is that going through here is the
 * *recorded* way to do it.
 */

/**
 * Ops reachable from the socket. `rescan` is out of scope, and
 * `update-available` is broadcast-shaped — it is fire-and-forget, unauthenticated
 * by construction, and drives the self-updater, so it must not be reachable from
 * a surface whose whole premise is that it skips the envelope. Same posture as
 * the broadcast allowlist in `relay-client.ts`, and for the same reason: the
 * refusal is structural, not a policy check someone can forget to apply.
 */
const LOCAL_OPS: ReadonlySet<string> = new Set<OpName>(["sessions", "spawn"]);

/**
 * A spawn payload carries a free-text prompt, so the cap is generous; it exists
 * to stop an unbounded peer growing the daemon's heap, not to bound a legitimate
 * request. Past it the connection is dropped rather than trimmed — a truncated
 * frame is not a request.
 */
const MAX_FRAME_BYTES = 1_048_576;

const EMPTY = Buffer.alloc(0);

interface Conn {
  inbound: Buffer;
  outbound: Buffer;
}

export interface LocalSocketOpts {
  /** Normally `createHandler(ctx, "local")` — the same routing the relay leg uses. */
  readonly handle: (plain: Plain) => Promise<Plain | null>;
  readonly path?: string;
}

export interface LocalSocketHandle {
  /** Null when the listener could not bind; the daemon serves the relay regardless. */
  readonly path: string | null;
  readonly stop: () => void;
}

function isPlain(raw: unknown): raw is Plain {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  // `op` is checked as a bare string, not against OpName: an unknown op has to
  // reach the allowlist below and be refused, not fail shape validation with a
  // message that says nothing about why.
  return typeof obj["id"] === "string" && typeof obj["ts"] === "number" && typeof obj["op"] === "string";
}

function errorReply(op: string, re: string, message: string): Plain {
  const payload: ErrorResponse = { ok: false, code: "internal_error", message };
  return { id: crypto.randomUUID(), ts: Date.now(), op: op as OpName, re, payload };
}

/**
 * Queued rather than written straight through: a spawn reply embeds a refreshed
 * session list, which is comfortably large enough to meet backpressure, and a
 * short write would truncate the JSON into an unparseable line.
 */
function flush(sock: Socket<undefined>, conn: Conn): void {
  if (conn.outbound.length === 0) return;
  try {
    const written = sock.write(conn.outbound);
    conn.outbound = written >= conn.outbound.length ? EMPTY : conn.outbound.subarray(written);
  } catch {
    // The peer vanished — a Claude session killed mid-spawn is the ordinary
    // case. The spawn itself already happened; there is no one left to tell.
    conn.outbound = EMPTY;
  }
}

function send(sock: Socket<undefined>, conn: Conn, plain: Plain): void {
  conn.outbound = Buffer.concat([conn.outbound, Buffer.from(`${JSON.stringify(plain)}\n`, "utf8")]);
  flush(sock, conn);
}

async function dispatch(
  sock: Socket<undefined>,
  conn: Conn,
  line: string,
  handle: LocalSocketOpts["handle"],
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    log.warn("local socket: dropped a frame that is not JSON");
    sock.end();
    return;
  }
  if (!isPlain(raw)) {
    log.warn("local socket: dropped a malformed frame");
    sock.end();
    return;
  }
  if (!LOCAL_OPS.has(raw.op)) {
    // Logged here rather than left to the handler, which never sees it: a
    // refused op is exactly the line worth having when something local starts
    // probing what the socket will do.
    log.warn(`local socket: refused op=${quote(raw.op)} id=${quote(raw.id)} reason=op-not-allowed`);
    send(sock, conn, errorReply(raw.op, raw.id, `op "${raw.op}" is not available on the local socket`));
    return;
  }
  const reply = await handle(raw);
  if (reply !== null) send(sock, conn, reply);
}

/**
 * The run directory is the access control (see `runDir`), so a directory we do
 * not own is not one to bind in — its mode is not ours to fix and its contents
 * are not ours to trust. Returns the problem, or null when the directory is
 * ready.
 *
 * `enforceMode` is false for a caller-supplied path: its parent is not ours to
 * chmod, and an explicit path under a shared directory would silently tighten
 * that directory to 0700. The uid check still applies.
 */
async function prepareRunDir(dir: string, enforceMode: boolean): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await stat(dir);
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) return `${dir} belongs to another user`;
    // `mode` on mkdir only applies where it creates, so a directory left behind
    // by an older daemon is tightened here, on every start.
    if (enforceMode && (info.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Binds the local op socket, or reports why it could not and lets the daemon run
 * on. A box with no local surface still relays, exactly as a box with an
 * unwritable audit log still serves — degrading loudly beats refusing to start.
 */
export async function startLocalSocket(opts: LocalSocketOpts): Promise<LocalSocketHandle> {
  const path = opts.path ?? socketPath();
  const ownDir = opts.path === undefined;
  const dir = ownDir ? runDir() : dirname(path);

  const dirProblem = await prepareRunDir(dir, ownDir);
  if (dirProblem !== null) {
    log.warn(`local socket: not listening — ${dirProblem}`);
    return { path: null, stop: (): void => {} };
  }

  const conns = new Map<Socket<undefined>, Conn>();
  const handlers = {
    open: (sock: Socket<undefined>): void => {
      conns.set(sock, { inbound: EMPTY, outbound: EMPTY });
    },
    close: (sock: Socket<undefined>): void => {
      conns.delete(sock);
    },
    error: (sock: Socket<undefined>): void => {
      conns.delete(sock);
    },
    drain: (sock: Socket<undefined>): void => {
      const conn = conns.get(sock);
      if (conn !== undefined) flush(sock, conn);
    },
    data: (sock: Socket<undefined>, chunk: Buffer): void => {
      const conn = conns.get(sock);
      if (conn === undefined) return;
      conn.inbound = Buffer.concat([conn.inbound, chunk]);
      if (conn.inbound.length > MAX_FRAME_BYTES) {
        log.warn(`local socket: dropped a peer over ${MAX_FRAME_BYTES} bytes`);
        conn.inbound = EMPTY;
        sock.end();
        return;
      }
      for (;;) {
        // Split on the newline *byte*: 0x0a never appears inside a multi-byte
        // UTF-8 sequence, so a prompt's non-ASCII text cannot be cut here.
        const nl = conn.inbound.indexOf(0x0a);
        if (nl === -1) break;
        const line = conn.inbound.subarray(0, nl).toString("utf8");
        conn.inbound = conn.inbound.subarray(nl + 1);
        if (line.trim() === "") continue;
        void dispatch(sock, conn, line, opts.handle).catch((err: unknown) => {
          log.error(`local socket: dispatch crashed: ${String(err)}`);
        });
      }
    },
  };

  const listen = (): ReturnType<typeof Bun.listen<undefined>> =>
    Bun.listen<undefined>({ unix: path, socket: handlers });

  let server: ReturnType<typeof listen>;
  try {
    server = listen();
  } catch (err) {
    // EADDRINUSE covers both an orphaned socket file (a daemon killed -9) and a
    // non-socket squatting on the name. Probing by connecting is what tells a
    // corpse from a live daemon; only the corpse is ours to clear.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE") {
      log.warn(`local socket: not listening at ${path} — ${err instanceof Error ? err.message : String(err)}`);
      return { path: null, stop: (): void => {} };
    }
    if (await localSocketReachable(path)) {
      log.warn(`local socket: not listening — another daemon already owns ${path}`);
      return { path: null, stop: (): void => {} };
    }
    await unlink(path).catch(() => {});
    try {
      server = listen();
    } catch (retryErr) {
      log.warn(
        `local socket: not listening at ${path} — ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
      );
      return { path: null, stop: (): void => {} };
    }
  }

  // Belt-and-braces only: `Bun.listen` creates the socket 0755 and there is a
  // window before this lands, which is exactly why `runDir()` is 0700 and this
  // is not what the security argument rests on.
  await chmod(path, 0o600).catch(() => {});
  log.info(`local socket listening at ${path}`);

  return {
    path,
    // stop(true) unlinks the path, so a clean shutdown leaves nothing for the
    // next start to probe — and the supervisor's reload stops before it starts.
    stop: (): void => server.stop(true),
  };
}

/**
 * Doctor's view of the local surface. The directory mode is checked as well as
 * reachability, because it is the access control and a daemon that has not
 * restarted since it was loosened would not have tightened it yet.
 */
export async function localSocketChecks(path: string = socketPath()): Promise<readonly Check[]> {
  const checks: Check[] = [];
  const dir = dirname(path);
  const info = await stat(dir).catch(() => null);
  if (info !== null && (info.mode & 0o777) !== 0o700) {
    const mode = (info.mode & 0o777).toString(8).padStart(4, "0");
    checks.push({
      level: "warn",
      message: `${dir} is ${mode}, and its mode is what keeps the op socket to this user — \`seanced restart\` tightens it to 0700`,
    });
  }
  checks.push(
    (await localSocketReachable(path))
      ? { level: "ok", message: `local op socket at ${path} — MCP spawns on this machine skip the relay` }
      : {
          level: "warn",
          message: `no local op socket at ${path} — MCP spawns targeting this machine will fail until the daemon is running`,
        },
  );
  return checks;
}
