import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { exec } from "./exec.ts";
import { hardenedGit } from "./git-hardened.ts";

/**
 * `git fsmonitor--daemon` processes, which `core.fsmonitor=true` starts one of
 * per checkout git touches and nothing ever stops. Which of them reap stops is
 * its policy (`reap.ts`); this is the listing.
 */
export interface FsmonitorDaemon {
  readonly pid: number;
  readonly rssKb: number;
  /** The directory it watches; null when neither its fd 4 nor its socket says. */
  readonly worktree: string | null;
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
/**
 * The fd git's daemon holds its worktree root open on — every one of 547 on
 * the Mac this was measured on (2026-10-23). Its cwd is `$HOME` (it chdirs
 * after detaching) and its argv names no repo.
 */
const ROOT_FD = "4";

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

interface LsofFile {
  fd?: string;
  type?: string;
  name?: string;
}

/** `lsof -F` output as each pid's files; `p` starts a process, `f` a file within it. */
function parseLsof(raw: string): ReadonlyMap<number, readonly LsofFile[]> {
  const files = new Map<number, LsofFile[]>();
  let current: LsofFile[] | undefined;
  let file: LsofFile | undefined;
  for (const line of raw.split("\n")) {
    const field = line.slice(1);
    if (line.startsWith("p")) {
      current = [];
      files.set(Number(field), current);
      file = undefined;
    } else if (line.startsWith("f")) {
      file = { fd: field };
      current?.push(file);
    } else if (line.startsWith("t") && file !== undefined) {
      file.type = field;
    } else if (line.startsWith("n") && file !== undefined) {
      file.name = field;
    }
  }
  return files;
}

/** Pure parser over `lsof -F ftn` — exported for unit tests. Each pid's fd 4, when it is an absolute directory. */
export function parseRootFds(raw: string): ReadonlyMap<number, string> {
  const roots = new Map<number, string>();
  for (const [pid, files] of parseLsof(raw)) {
    const root = files.find((file) => file.fd === ROOT_FD && file.type === "DIR");
    if (root?.name !== undefined && isAbsolute(root.name)) roots.set(pid, root.name);
  }
  return roots;
}

/**
 * Pure parser over `lsof -U -F n` — exported for unit tests. The git dir of
 * the one absolute `fsmonitor--daemon.ipc` a pid holds. Most aren't absolute:
 * past `sun_path`'s 104 bytes git binds relative to the git dir, and lsof then
 * shows the bare name — 327 of 547 on the Mac measured — hence only a fallback.
 */
export function parseSocketDirs(raw: string): ReadonlyMap<number, string> {
  const dirs = new Map<number, string>();
  for (const [pid, files] of parseLsof(raw)) {
    const found = new Set(
      files.flatMap((file) =>
        file.name !== undefined && isAbsolute(file.name) && file.name.endsWith(`/${SOCKET_NAME}`)
          ? [dirname(file.name)]
          : [],
      ),
    );
    const [only] = found;
    if (found.size === 1 && only !== undefined) dirs.set(pid, only);
  }
  return dirs;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * The worktree a git dir belongs to. A linked worktree's git dir (it has
 * `commondir`) names its checkout in `gitdir`; a main clone's `.git` sits in
 * it. A git dir that is gone stands for itself — its worktree is gone too, or
 * holds no repo any more. Null when it can't be told.
 */
export async function worktreeOfGitDir(gitDir: string): Promise<string | null> {
  if (!(await exists(gitDir))) return gitDir;
  if (!(await exists(`${gitDir}/commondir`))) return basename(gitDir) === ".git" ? dirname(gitDir) : null;
  const pointer = (await readFile(`${gitDir}/gitdir`, "utf8").catch(() => null))?.trim();
  return pointer === undefined || pointer === "" || !isAbsolute(pointer) ? null : dirname(pointer);
}

async function lsof(args: readonly string[], pids: readonly number[]): Promise<string> {
  // Exit 1 whenever a listed pid exited since `ps`, or holds no such fd; what it did print still holds.
  const result = await exec(["lsof", "-nP", "-a", ...args, "-p", pids.join(",")], { timeoutMs: 30_000 });
  return result.stdout;
}

async function listDaemons(): Promise<readonly FsmonitorDaemon[]> {
  const ps = await exec(["ps", "-axo", "pid=,uid=,rss=,command="], { timeoutMs: 10_000 });
  if (ps.exitCode !== 0) return [];
  const processes = parseDaemonProcesses(ps.stdout, process.getuid?.() ?? -1);
  if (processes.length === 0) return [];
  const roots = parseRootFds(
    await lsof(
      ["-d", ROOT_FD, "-F", "ftn"],
      processes.map((p) => p.pid),
    ),
  );
  const rest = processes.filter((p) => !roots.has(p.pid)).map((p) => p.pid);
  const sockets = rest.length === 0 ? new Map<number, string>() : parseSocketDirs(await lsof(["-U", "-F", "fn"], rest));
  return Promise.all(
    processes.map(async ({ pid, rssKb }) => {
      const socketDir = sockets.get(pid);
      const worktree = roots.get(pid) ?? (socketDir === undefined ? null : await worktreeOfGitDir(socketDir));
      return { pid, rssKb, worktree };
    }),
  );
}

/**
 * The real seams on macOS and Linux; null elsewhere, and reap skips every
 * fsmonitor step. Linux too though its git ships no daemon today (2.53): the
 * listing is one `ps` that finds none there, and a build that has one is covered.
 */
export function platformFsmonitor(platform: NodeJS.Platform = process.platform): FsmonitorSeams | null {
  if (platform !== "darwin" && platform !== "linux") return null;
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
