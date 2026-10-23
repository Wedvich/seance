import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { exec } from "./exec.ts";
import { hardenedGit } from "./git-hardened.ts";

/**
 * `git fsmonitor--daemon` processes, which `core.fsmonitor=true` starts one of
 * per checkout git touches and nothing ever stops: they outlive the worktree
 * they watch. Built into git on macOS and Windows only, and séance runs on
 * Windows only under WSL, so this is macOS's alone.
 */
export interface FsmonitorDaemon {
  readonly pid: number;
  readonly rssKb: number;
  /**
   * The git dir its IPC socket sits in — the only reliable link to a repo: the
   * daemon chdirs away after detaching, and its argv names none. Null when the
   * socket isn't readable as one: a repo on a network FS (git puts the socket
   * in `~/.git-fsmonitor-<hash>`), or a path too long for `sun_path`, which git
   * binds relative to the dir.
   */
  readonly gitDir: string | null;
}

/** Reap's handle on them; injected so reap is testable on any platform, and with no real daemon. */
export interface FsmonitorSeams {
  /** This user's daemons, read once per reap. */
  readonly list: () => Promise<readonly FsmonitorDaemon[]>;
  /** `git fsmonitor--daemon stop` in the worktree; true when one was running and has quit. */
  readonly stop: (worktree: string) => Promise<boolean>;
  /** SIGTERM; false when the process was gone or not ours. */
  readonly signal: (pid: number) => boolean;
}

const SOCKET_NAME = "fsmonitor--daemon.ipc";
const RUN_COMMAND = /(?:^|\/)git fsmonitor--daemon run(?:\s|$)/u;

/** Pure parser over `ps -axo pid=,uid=,rss=,command=` — exported for unit tests. */
export function parseDaemonProcesses(raw: string, uid: number): readonly { pid: number; rssKb: number }[] {
  const daemons: { pid: number; rssKb: number }[] = [];
  for (const line of raw.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (match === null || Number(match[2]) !== uid || !RUN_COMMAND.test(match[4] ?? "")) continue;
    daemons.push({ pid: Number(match[1]), rssKb: Number(match[3]) });
  }
  return daemons;
}

/**
 * Pure parser over `lsof -F pn` — exported for unit tests. Each pid's git dir
 * is that of the one absolute `fsmonitor--daemon.ipc` it holds; any other
 * count reads as unknown.
 */
export function parseSocketDirs(raw: string): ReadonlyMap<number, string | null> {
  const names = new Map<number, string[]>();
  let pid: number | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      if (!names.has(pid)) names.set(pid, []);
    } else if (line.startsWith("n") && pid !== null) {
      const name = line.slice(1);
      if (isAbsolute(name) && name.endsWith(`/${SOCKET_NAME}`)) names.get(pid)?.push(dirname(name));
    }
  }
  return new Map([...names].map(([key, dirs]) => [key, new Set(dirs).size === 1 ? (dirs[0] ?? null) : null]));
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * The worktree a daemon's git dir belongs to, and whether it is gone. A linked
 * worktree's git dir (it has `commondir`) names its checkout in `gitdir`, and
 * outlives a checkout deleted by hand until `worktree prune`; a main clone's is
 * inside the checkout. Anything unreadable reads as present — the safe side.
 */
export async function watchedWorktree(gitDir: string): Promise<{ readonly path: string; readonly gone: boolean }> {
  if (!(await exists(gitDir))) return { path: gitDir, gone: true };
  if (!(await exists(`${gitDir}/commondir`))) return { path: dirname(gitDir), gone: false };
  const pointer = (await readFile(`${gitDir}/gitdir`, "utf8").catch(() => null))?.trim();
  if (pointer === undefined || pointer === "" || !isAbsolute(pointer)) return { path: gitDir, gone: false };
  const path = dirname(pointer);
  return { path, gone: !(await exists(path)) };
}

async function listDaemons(): Promise<readonly FsmonitorDaemon[]> {
  const ps = await exec(["ps", "-axo", "pid=,uid=,rss=,command="], { timeoutMs: 10_000 });
  if (ps.exitCode !== 0) return [];
  const processes = parseDaemonProcesses(ps.stdout, process.getuid?.() ?? -1);
  if (processes.length === 0) return [];
  // Exit 1 whenever a listed pid exited since `ps`; what it did print still holds.
  const lsof = await exec(["lsof", "-nP", "-a", "-U", "-F", "pn", "-p", processes.map((p) => p.pid).join(",")], {
    timeoutMs: 30_000,
  });
  const dirs = parseSocketDirs(lsof.stdout);
  return processes.map(({ pid, rssKb }) => ({ pid, rssKb, gitDir: dirs.get(pid) ?? null }));
}

/** The real seams where git has the daemon built in; null elsewhere, and reap skips every fsmonitor step. */
export function platformFsmonitor(platform: NodeJS.Platform = process.platform): FsmonitorSeams | null {
  if (platform !== "darwin") return null;
  return {
    list: listDaemons,
    // Hardened's `core.fsmonitor=false` doesn't matter: the subcommand forces IPC mode itself.
    stop: async (worktree) => (await hardenedGit(worktree, ["fsmonitor--daemon", "stop"], 10_000)).exitCode === 0,
    signal: (pid) => {
      try {
        process.kill(pid, "SIGTERM");
        return true;
      } catch {
        return false;
      }
    },
  };
}
