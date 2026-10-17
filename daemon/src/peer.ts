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

type ProcPidInfo = (pid: number, flavor: number, arg: number, buffer: number, size: number) => number;

/** `proc_pidinfo`'s flavor for struct proc_bsdinfo (<sys/proc_info.h>): 136 bytes, `pbi_ppid` a uint32 at 16. */
const PROC_PIDTBSDINFO = 3;
const BSDINFO_BYTES = 136;
const BSDINFO_PPID_OFFSET = 16;

let procPidInfo: ProcPidInfo | null | undefined;

function loadProcPidInfo(): ProcPidInfo | null {
  if (process.platform !== "darwin") return null;
  try {
    const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    return symbols.proc_pidinfo as ProcPidInfo;
  } catch {
    return null;
  }
}

/**
 * macOS's parent of `pid` from the kernel's own record, exec-free — what `ps`
 * reads too, for one process instead of all. Null when gone or unreadable, and
 * undefined where the call will not load, so the caller falls back to `ps`.
 */
export function bsdParent(pid: number): number | null | undefined {
  procPidInfo ??= loadProcPidInfo();
  if (procPidInfo === null) return undefined;
  const info = new Uint8Array(BSDINFO_BYTES);
  try {
    // Anything short of the whole struct is a failure: 0 for a pid gone or not ours to read.
    if (procPidInfo(pid, PROC_PIDTBSDINFO, 0, ptr(info), BSDINFO_BYTES) !== BSDINFO_BYTES) return null;
  } catch {
    return null;
  }
  return new DataView(info.buffer).getUint32(BSDINFO_PPID_OFFSET, true);
}

/** Bounded: a pid reused mid-walk could close a loop. */
const MAX_DEPTH = 32;

/**
 * The first of `pid` and its ancestors that `targets` holds — the pane whose
 * process tree the peer runs in. Linux reads `/proc` per hop and macOS asks
 * `proc_pidinfo` per hop, both exec-free; where that will not load, one
 * fixed-argv `ps` lists every parent at once. Nothing a peer sent reaches any.
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
  // 0.3 µs a hop against 20 ms for a `ps` that lists every process on the machine.
  if (bsdParent(process.pid) === undefined) return psParents();
  // `proc_pidinfo` refuses another user's process, which `ps` reads: a `sudo` between
  // pane and peer would otherwise end the walk where it used to carry on.
  let listing: Promise<(pid: number) => Promise<number | null>> | null = null;
  return async (pid) => bsdParent(pid) ?? (await (listing ??= psParents()))(pid);
}

async function psParents(): Promise<(pid: number) => Promise<number | null>> {
  const listed = await exec(["ps", "-Ao", "pid=,ppid="]).catch(() => null);
  const parents = listed === null || listed.exitCode !== 0 ? new Map<number, number>() : parsePsParents(listed.stdout);
  return async (pid) => parents.get(pid) ?? null;
}
