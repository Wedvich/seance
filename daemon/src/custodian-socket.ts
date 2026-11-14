import { createHash } from "node:crypto";
import { rmdirSync } from "node:fs";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { Socket } from "bun";
import { isCustodianFrameKind, type CustodianReply } from "./custodian-frame.ts";
import { localSocketReachable } from "./local-client.ts";
import { stateDir } from "./paths.ts";
import { peerPid, socketFd } from "./peer.ts";
import { EMPTY, flush, sendLine } from "./socket-lines.ts";

/**
 * The round's own socket (docs/custodian.md item 4b; DESIGN.md, "The custodian's seat"): the one socket the round's
 * sandbox can reach that acts, and it serves the `custodian` frame kind and nothing else. The daemon's main socket
 * answers that kind `unsupported`, and the sandbox masks the main socket's directory. The binding is still the kernel's
 * peer pid, in the verbs; this file only keeps the surface to one kind.
 *
 * It sits under a literal `/tmp`, outside `stateDir()` and every path the round may write: `tmpdir()` is long on
 * macOS and a unix socket path is 104 bytes there.
 */

/** Notes are at most `NOTES_MAX` (8192 bytes) and a summary 1024: far under this. Past it the connection is dropped. */
const MAX_INBOUND_BYTES = 65_536;
const WARN_EVERY_MS = 60_000;

/**
 * Where this daemon's round socket is, a function of its state dir: stable across a reload and a restart (an adopted
 * round's env still names it), and one per test daemon. Never matches `ROUND_TMP` (`seance-cu-s-…` has a `-` where its
 * six characters are alphanumeric), so the round-tmp sweep never touches it.
 */
export function custodianSocketPath(state: string = stateDir()): string {
  return `/tmp/seance-cu-s-${createHash("sha256").update(state).digest("hex").slice(0, 12)}/c.sock`;
}

export interface CustodianSocketOpts {
  readonly path: string;
  readonly handle: (raw: unknown, peer: number | null) => Promise<CustodianReply>;
  readonly warn: (line: string) => void;
  readonly now?: () => number;
}

export type CustodianSocket = { readonly path: string; readonly stop: () => void } | { readonly problem: string };

interface Conn {
  inbound: Buffer;
  outbound: Buffer;
  readonly peer: number | null;
}

/**
 * Prepares the socket's directory: made 0700 without following anything, then `lstat`ed (a predictable `/tmp` name is
 * one another user could have planted a symlink at, which `stat` would follow). Returns the problem, or null.
 */
async function prepareDir(dir: string): Promise<string | null> {
  try {
    await mkdir(dir, { mode: 0o700 }).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    });
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) return `${dir} is not a directory`;
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) return `${dir} belongs to another user`;
    if ((info.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Binds the round's socket, or says why it could not: a seat with no socket runs no round. */
export async function startCustodianSocket(o: CustodianSocketOpts): Promise<CustodianSocket> {
  const now = o.now ?? Date.now;
  const dir = dirname(o.path);
  const dirProblem = await prepareDir(dir);
  if (dirProblem !== null) return { problem: dirProblem };

  let lastWarn: number | null = null;
  const warnRefused = (): void => {
    const at = now();
    if (lastWarn !== null && at - lastWarn < WARN_EVERY_MS) return;
    lastWarn = at;
    // Never the frame.
    o.warn("custodian socket: refused a non-custodian frame");
  };

  const answer = async (sock: Socket<undefined>, conn: Conn, line: string): Promise<void> => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      sendLine(sock, conn, JSON.stringify({ ok: false, code: "invalid" }));
      return;
    }
    if (!isCustodianFrameKind(raw)) {
      warnRefused();
      sendLine(sock, conn, JSON.stringify({ ok: false, code: "unsupported" }));
      return;
    }
    let reply: CustodianReply;
    try {
      reply = await o.handle(raw, conn.peer);
    } catch (err) {
      // The error's name only: its text may hold notes or a path.
      o.warn(`custodian socket: a verb crashed (${err instanceof Error ? err.name : "error"})`);
      reply = { ok: false, code: "internal" };
    }
    sendLine(sock, conn, JSON.stringify(reply));
  };

  const conns = new Map<Socket<undefined>, Conn>();
  const handlers = {
    open: (sock: Socket<undefined>): void => {
      conns.set(sock, { inbound: EMPTY, outbound: EMPTY, peer: peerPid(socketFd(sock)) });
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
      if (conn.inbound.length > MAX_INBOUND_BYTES) {
        conn.inbound = EMPTY;
        sock.end();
        return;
      }
      for (;;) {
        const nl = conn.inbound.indexOf(0x0a);
        if (nl === -1) break;
        const line = conn.inbound.subarray(0, nl).toString("utf8");
        conn.inbound = conn.inbound.subarray(nl + 1);
        if (line.trim() === "") continue;
        void answer(sock, conn, line).catch(() => {});
      }
    },
  };

  const listen = (): ReturnType<typeof Bun.listen<undefined>> =>
    Bun.listen<undefined>({ unix: o.path, socket: handlers });

  let server: ReturnType<typeof listen>;
  try {
    server = listen();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE") return { problem: err instanceof Error ? err.message : String(err) };
    // A corpse (a daemon killed -9) and a live daemon both give EADDRINUSE: only connecting tells them apart.
    if (await localSocketReachable(o.path)) return { problem: `another daemon owns ${o.path}` };
    await unlink(o.path).catch(() => {});
    try {
      server = listen();
    } catch (retryErr) {
      return { problem: retryErr instanceof Error ? retryErr.message : String(retryErr) };
    }
  }
  // `Bun.listen` creates the socket 0755; the 0700 directory is what the access rests on, as for the main socket.
  await chmod(o.path, 0o600).catch(() => {});

  return {
    path: o.path,
    // Synchronous, as a capability's `stop` is. `stop(true)` unlinks the socket; the directory goes if it is empty.
    stop: (): void => {
      server.stop(true);
      try {
        rmdirSync(dir);
      } catch {
        // Not empty or already gone: nothing of ours is left in it either way.
      }
    },
  };
}
