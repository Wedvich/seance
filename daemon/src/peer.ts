import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFile } from "node:fs/promises";
import { exec } from "./exec.ts";

/**
 * Who is on the other end of a unix socket, as the kernel says — the one fact
 * about a local peer it cannot forge. Bun's socket API surfaces no peer
 * credentials (probed on 1.4.3: no `peerCredentials`, `remoteAddress`
 * undefined), but it does expose the accepted socket's `fd`, so this asks libc
 * directly: `getsockopt(SO_PEERCRED)` on Linux and WSL (struct ucred, pid
 * first), `getsockopt(SOL_LOCAL, LOCAL_PEERPID)` on macOS (a bare pid_t,
 * <sys/un.h> since 10.8). Both record the pid at connect(2), so the answer
 * holds even after the peer exits — though the walk up from it does not.
 *
 * Null when the platform has neither, libc will not load, or the call fails:
 * the caller then has no binding of its own and says so (DESIGN.md, "Session
 * events").
 */

type GetSockOpt = (fd: number, level: number, name: number, value: number, len: number) => number;

interface PeerCall {
  readonly getsockopt: GetSockOpt;
  readonly level: number;
  readonly name: number;
}

let peerCall: PeerCall | null | undefined;

function loadPeerCall(): PeerCall | null {
  const where =
    process.platform === "linux"
      ? { lib: "libc.so.6", level: 1, name: 17 } // SOL_SOCKET, SO_PEERCRED
      : process.platform === "darwin"
        ? { lib: "/usr/lib/libSystem.B.dylib", level: 0, name: 2 } // SOL_LOCAL, LOCAL_PEERPID
        : null;
  if (where === null) return null;
  try {
    const { symbols } = dlopen(where.lib, {
      getsockopt: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    return { getsockopt: symbols.getsockopt as GetSockOpt, level: where.level, name: where.name };
  } catch {
    return null;
  }
}

/**
 * The accepted socket's descriptor. Present on Bun's sockets at runtime (1.4.3)
 * but missing from its types, so read and checked rather than asserted: a Bun
 * that drops it yields -1, which `peerPid` answers with null.
 */
export function socketFd(socket: object): number {
  const fd: unknown = Reflect.get(socket, "fd");
  return typeof fd === "number" && Number.isInteger(fd) ? fd : -1;
}

/** Whether this host can name a peer at all — decided once; `run.ts` logs it at start. */
export function peerPidSupported(): boolean {
  peerCall ??= loadPeerCall();
  return peerCall !== null;
}

export function peerPid(fd: number): number | null {
  peerCall ??= loadPeerCall();
  if (peerCall === null || fd < 0) return null;
  // Room for struct ucred (pid, uid, gid); macOS fills only the first.
  const value = new Int32Array(3);
  const len = new Uint32Array([value.byteLength]);
  try {
    if (peerCall.getsockopt(fd, peerCall.level, peerCall.name, ptr(value), ptr(len)) !== 0) return null;
  } catch {
    return null;
  }
  const pid = value[0] ?? 0;
  return pid > 0 ? pid : null;
}

/** `/proc/<pid>/stat`'s parent: field 4, counted after `comm`'s closing paren, which may itself hold spaces. */
export function parseProcStatPpid(stat: string): number | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : null;
}

/** `ps -Ao pid=,ppid=` as a parent map. */
export function parsePsParents(text: string): ReadonlyMap<number, number> {
  const parents = new Map<number, number>();
  for (const line of text.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/u);
    if (pid !== undefined && ppid !== undefined) parents.set(Number(pid), Number(ppid));
  }
  return parents;
}

/** Bounded: a pid reused mid-walk could close a loop. */
const MAX_DEPTH = 32;

/**
 * The first of `pid` and its ancestors that `targets` holds — the pane whose
 * process tree the peer runs in. Linux reads `/proc` per hop, exec-free; macOS
 * has no `/proc`, so one fixed-argv `ps` lists every parent at once. Nothing a
 * peer sent reaches either.
 */
export async function ancestorIn<T>(pid: number, targets: ReadonlyMap<number, T>): Promise<T | null> {
  const parentOf = await parentLookup();
  let current: number | null = pid;
  for (let depth = 0; current !== null && current > 1 && depth < MAX_DEPTH; depth++) {
    const hit = targets.get(current);
    if (hit !== undefined) return hit;
    // oxlint-disable-next-line no-await-in-loop -- each hop needs the one before it
    current = await parentOf(current);
  }
  return null;
}

async function parentLookup(): Promise<(pid: number) => Promise<number | null>> {
  if (process.platform === "linux") {
    return async (pid) => {
      try {
        return parseProcStatPpid(await readFile(`/proc/${pid}/stat`, "utf8"));
      } catch {
        return null; // gone, or never ours to read
      }
    };
  }
  const listed = await exec(["ps", "-Ao", "pid=,ppid="]).catch(() => null);
  const parents = listed === null || listed.exitCode !== 0 ? new Map<number, number>() : parsePsParents(listed.stdout);
  return async (pid) => parents.get(pid) ?? null;
}
