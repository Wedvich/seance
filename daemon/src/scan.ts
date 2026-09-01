import { access, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { RepoEntry } from "@seance/shared";
import { git } from "./exec.ts";

const SCAN_CONCURRENCY = 16;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** `.git` may be a dir (main clone) or a `gitdir:` pointer file (linked worktree). */
async function resolveGitDir(repoPath: string): Promise<string | null> {
  const dotGit = join(repoPath, ".git");
  try {
    const info = await stat(dotGit);
    if (info.isDirectory()) return dotGit;
    const content = await Bun.file(dotGit).text();
    const match = content.match(/^gitdir:\s*(.+)\s*$/mu);
    if (!match?.[1]) return null;
    const target = match[1].trim();
    return isAbsolute(target) ? target : resolve(repoPath, target);
  } catch {
    return null;
  }
}

/**
 * Local-only — never touches the network. Loose ref file first (free);
 * reftable repos (git 2.46+, the default for newer clones) keep no loose
 * ref files, so fall back to `git symbolic-ref`, which also only reads disk.
 * The network-touching `git remote set-head` belongs to the self-update path
 * (`update.ts`), and only when this returns null. It ran in the spawn path too
 * until worktree mode stopped resolving the branch at all — claude's
 * `--worktree` does that itself.
 */
export async function readDefaultBranch(repoPath: string): Promise<string | null> {
  const fromFile = await readDefaultBranchFile(repoPath);
  if (fromFile !== null) return fromFile;
  const result = await git(repoPath, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], 5_000);
  if (result.exitCode !== 0) return null;
  const match = result.stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/u);
  return match?.[1] ?? null;
}

async function readDefaultBranchFile(repoPath: string): Promise<string | null> {
  const gitDir = await resolveGitDir(repoPath);
  if (gitDir === null) return null;
  const headFile = Bun.file(join(gitDir, "refs", "remotes", "origin", "HEAD"));
  if (!(await headFile.exists())) return null;
  const match = (await headFile.text()).match(/^ref: refs\/remotes\/origin\/(.+)$/mu);
  return match?.[1]?.trim() ?? null;
}

async function listDirs(parent: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
      .map((e) => join(parent, e.name));
  } catch {
    return []; // missing/unreadable root — doctor flags it, scan stays quiet
  }
}

/** tmux reports kernel-canonical pane paths (macOS: /var → /private/var) — store canonical paths so prefix mapping works. */
async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/**
 * Bounded so a root holding thousands of entries can't put every `readdir`/
 * `stat` in flight at once and hit the fd ceiling. Results keep input order.
 */
async function mapLimit<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const queue = items.entries();
  const results: R[] = [];
  const worker = async (): Promise<void> => {
    // oxlint-disable-next-line no-await-in-loop -- sequential inside one worker is the point; the fan-out is the worker pool
    for (const [index, item] of queue) results[index] = await fn(item);
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, items.length) }, worker));
  return results;
}

async function discoverRepoPaths(roots: readonly string[]): Promise<readonly string[]> {
  const found = new Set<string>();
  const collect = async (dir: string): Promise<boolean> => {
    if (!(await exists(join(dir, ".git")))) return false;
    found.add(await canonical(dir));
    return true;
  };

  // A root that is itself a repo stops the walk there: descending would register
  // its submodules and linked worktrees as separate repos.
  const rootHits = await mapLimit(roots, collect);
  const level1 = (
    await mapLimit(
      roots.filter((_, i) => rootHits[i] === false),
      listDirs,
    )
  ).flat();
  const missed = await mapLimit(level1, collect);
  const level2 = (
    await mapLimit(
      level1.filter((_, i) => missed[i] === false),
      listDirs,
    )
  ).flat();
  await mapLimit(level2, collect);
  return [...found];
}

/** Basename, disambiguated with the parent dir on collision, full path as last resort. */
function assignNames(paths: readonly string[]): ReadonlyMap<string, string> {
  const byBase = new Map<string, string[]>();
  for (const p of paths) {
    const base = basename(p);
    byBase.set(base, [...(byBase.get(base) ?? []), p]);
  }
  const names = new Map<string, string>();
  for (const [base, group] of byBase) {
    if (group.length === 1 && group[0] !== undefined) {
      names.set(group[0], base);
      continue;
    }
    const byParented = new Map<string, string[]>();
    for (const p of group) {
      const parented = `${basename(dirname(p))}/${base}`;
      byParented.set(parented, [...(byParented.get(parented) ?? []), p]);
    }
    for (const [parented, sub] of byParented) {
      if (sub.length === 1 && sub[0] !== undefined) {
        names.set(sub[0], parented);
        continue;
      }
      for (const p of sub) names.set(p, p);
    }
  }
  return names;
}

/**
 * Depth-2 walk under each root, or the root itself when it is a repo (so a
 * lone clone can be exposed without opening its parent). `defaultBranch`
 * carries forward from the
 * previous scan when already resolved — default branches practically never
 * change — and is read from local refs only for new (or still-null) repos.
 */
export async function scanRepos(
  roots: readonly string[],
  previous: readonly RepoEntry[] = [],
): Promise<readonly RepoEntry[]> {
  const prevByPath = new Map(previous.map((r) => [r.path, r]));
  const paths = await discoverRepoPaths(roots);
  const names = assignNames(paths);
  const entries = await Promise.all(
    paths.map(async (path): Promise<RepoEntry> => {
      const cached = prevByPath.get(path)?.defaultBranch ?? null;
      return {
        name: names.get(path) ?? path,
        path,
        defaultBranch: cached ?? (await readDefaultBranch(path)),
      };
    }),
  );
  return entries.toSorted((a, b) => a.name.localeCompare(b.name));
}

export function repoSetsEqual(a: readonly RepoEntry[], b: readonly RepoEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
