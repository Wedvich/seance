import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
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

/** Whether this host can name a peer at all — decided once; `run-capabilities.ts` logs it at start. */
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

/**
 * `proc_pidinfo`'s flavor for struct proc_bsdinfo (<sys/proc_info.h>): 136 bytes. `pbi_ppid` is a uint32 at 16,
 * `pbi_comm[16]` at 48 (the kernel's p_comm), `pbi_name[32]` at 64, and `pbi_start_tvsec`/`pbi_start_tvusec` uint64s
 * at 120 and 128 (the process's start time).
 */
const PROC_PIDTBSDINFO = 3;
const BSDINFO_BYTES = 136;
const BSDINFO_PPID_OFFSET = 16;
const BSDINFO_COMM_OFFSET = 48;
const BSDINFO_COMM_BYTES = 16;
const BSDINFO_NAME_OFFSET = 64;
const BSDINFO_NAME_BYTES = 32;
const BSDINFO_START_SEC_OFFSET = 120;
const BSDINFO_START_USEC_OFFSET = 128;

export interface BsdInfo {
  readonly ppid: number;
  /** `pbi_comm` and `pbi_name`, without their NULs: what the kernel calls the process. */
  readonly names: readonly string[];
  /** Start time as `<sec>.<usec>`: with the pid, who the process is. */
  readonly start: string;
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** The fields of a `proc_bsdinfo` struct this module reads. Null for a buffer that is not one. */
export function parseBsdInfo(info: Uint8Array): BsdInfo | null {
  if (info.byteLength !== BSDINFO_BYTES) return null;
  const view = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const names = [
    cString(info.subarray(BSDINFO_COMM_OFFSET, BSDINFO_COMM_OFFSET + BSDINFO_COMM_BYTES)),
    cString(info.subarray(BSDINFO_NAME_OFFSET, BSDINFO_NAME_OFFSET + BSDINFO_NAME_BYTES)),
  ].filter((name, at, all) => name !== "" && all.indexOf(name) === at);
  const sec = view.getBigUint64(BSDINFO_START_SEC_OFFSET, true);
  const usec = view.getBigUint64(BSDINFO_START_USEC_OFFSET, true);
  return { ppid: view.getUint32(BSDINFO_PPID_OFFSET, true), names, start: `${sec}.${usec}` };
}

function loadProcPidInfo() {
  if (process.platform !== "darwin") return null;
  try {
    const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    return symbols.proc_pidinfo;
  } catch {
    return null;
  }
}

/** Undefined until first asked; null once the call will not load, which is then never retried. */
let procPidInfo: ReturnType<typeof loadProcPidInfo> | undefined;

/**
 * macOS's record of `pid` from the kernel itself, exec-free — what `ps` reads too, for one process instead of all.
 * Null when gone or unreadable, and undefined where the call will not load, so the caller falls back to `ps`.
 */
export function bsdInfo(pid: number): BsdInfo | null | undefined {
  if (procPidInfo === undefined) procPidInfo = loadProcPidInfo();
  if (procPidInfo === null) return undefined;
  const info = new Uint8Array(BSDINFO_BYTES);
  try {
    // Anything short of the whole struct is a failure: 0 for a pid gone or not ours to read.
    if (procPidInfo(pid, PROC_PIDTBSDINFO, 0, ptr(info), BSDINFO_BYTES) !== BSDINFO_BYTES) return null;
  } catch {
    return null;
  }
  return parseBsdInfo(info);
}

/** The kernel's parent of `pid`: see `bsdInfo` for the null and undefined. */
export function bsdParent(pid: number): number | null | undefined {
  const info = bsdInfo(pid);
  return info === undefined ? undefined : (info?.ppid ?? null);
}

/**
 * `/proc/<pid>/stat` after `comm`'s closing paren: field 3 (state) first, so the start time, field 22, is index 19.
 * Null for a zombie or a dead process, which is no process for anything that asks who runs.
 */
export function parseProcStatStart(stat: string): string | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const state = fields[0];
  const start = fields[19];
  if (state === undefined || state === "Z" || state === "X" || state === "x") return null;
  return start !== undefined && /^\d+$/u.test(start) ? start : null;
}

/**
 * What tells one process from a later one with the same pid: its start time (clock ticks after boot on Linux, the
 * kernel's `sec.usec` on macOS). Null when the process is gone, a zombie or unreadable, and where nothing reads it
 * (macOS without libproc), so a caller binds nothing to a process it cannot tell apart. Synchronous on purpose: the
 * read is a few microseconds and callers check it in the middle of a sweep.
 */
export function processStart(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      return parseProcStatStart(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return null;
    }
  }
  return bsdInfo(pid)?.start ?? null;
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
  return (await ancestorBelow(pid, targets))?.hit ?? null;
}

/**
 * `ancestorIn` plus the chain under the hit: the pids from the peer up to, not including, the target, peer first (empty
 * when the peer is the target itself). Messaging looks for the `claude` process on it, since a hand-started session's
 * pane process is the shell, which outlives the `claude` that is its child.
 */
export async function ancestorBelow<T>(
  pid: number,
  targets: ReadonlyMap<number, T>,
): Promise<{ readonly hit: T; readonly below: readonly number[] } | null> {
  const parentOf = await parentLookup();
  let current: number | null = pid;
  const below: number[] = [];
  for (let depth = 0; current !== null && current > 1 && depth < MAX_DEPTH; depth++) {
    const hit = targets.get(current);
    if (hit !== undefined) return { hit, below };
    below.push(current);
    // oxlint-disable-next-line no-await-in-loop -- each hop needs the one before it
    current = await parentOf(current);
  }
  return null;
}

/**
 * What a process is called to tmux and `ps`, as `CLAUDE_PANES.command` (`agents/panes.ts`) expects it. Linux: argv[0]'s basename
 * (the symlink name `claude`) and the kernel's comm (the versioned filename, or a script's own name). macOS: the
 * kernel's `pbi_comm` and `pbi_name` from `proc_pidinfo`, exec-free, else (libproc will not load, or the process is
 * another user's) `ps -o comm=`, which prints argv[0] as exec'd. Either way a name is something the process or its exec
 * caller chose: a hint where to look on the process tree, never proof of a claude. Empty when the process is gone.
 */
export async function processNames(pid: number): Promise<readonly string[]> {
  if (process.platform === "linux") {
    const names: string[] = [];
    const argv0 = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0")[0] ?? "";
    if (argv0 !== "") names.push(basename(argv0));
    const comm = (await readFile(`/proc/${pid}/comm`, "utf8").catch(() => "")).trim();
    if (comm !== "") names.push(comm);
    return names;
  }
  const info = bsdInfo(pid);
  if (info !== undefined && info !== null) return info.names;
  // A pid gone is gone to `ps` too: only a refused or unloadable read is worth the exec.
  if (info === null && !exists(pid)) return [];
  const listed = await exec(["ps", "-o", "comm=", "-p", String(pid)], { timeoutMs: 5_000 }).catch(() => null);
  const path = listed?.exitCode === 0 ? listed.stdout.trim() : "";
  return path === "" ? [] : [basename(path)];
}

export async function parentLookup(): Promise<(pid: number) => Promise<number | null>> {
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
  return async (pid) => {
    const parent = bsdParent(pid);
    if (typeof parent === "number") return parent;
    // A pid gone is gone to `ps` too: only a refused hop is worth listing every process for.
    return exists(pid) ? (await (listing ??= psParents()))(pid) : null;
  };
}

/** Signal 0 sends nothing: EPERM is a live process that is not ours, ESRCH one that is gone. */
function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

async function psParents(): Promise<(pid: number) => Promise<number | null>> {
  const listed = await exec(["ps", "-Ao", "pid=,ppid="]).catch(() => null);
  const parents = listed === null || listed.exitCode !== 0 ? new Map<number, number>() : parsePsParents(listed.stdout);
  return async (pid) => parents.get(pid) ?? null;
}
