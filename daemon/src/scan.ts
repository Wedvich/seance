import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { RepoEntry } from "@seance/shared";
import { mapLimit } from "./concurrency.ts";
import { git } from "./exec.ts";
import { inspectCheckout, resolveCommonDir } from "./gitdir.ts";

const SCAN_CONCURRENCY = 16;

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
  const commonDir = await resolveCommonDir(repoPath);
  if (commonDir === null) return null;
  const headFile = Bun.file(join(commonDir, "refs", "remotes", "origin", "HEAD"));
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
 * `stat` in flight at once and hit the fd ceiling.
 */
function scanLimit<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  return mapLimit(items, SCAN_CONCURRENCY, fn);
}

async function discoverRepoPaths(roots: readonly string[]): Promise<readonly string[]> {
  const found = new Set<string>();
  // Any `.git` stops the walk, but only a main clone registers. A linked
  // worktree's repo is its main clone's: listed when a root reaches that clone,
  // never under the worktree's own path — a root that is a worktree included.
  // A broken or unreadable `.git` registers nothing and still stops the walk, so
  // what is nested under it can't surface as repos of their own.
  const collect = async (dir: string): Promise<boolean> => {
    const { kind } = await inspectCheckout(dir);
    if (kind === "none") return false;
    if (kind === "main") found.add(await canonical(dir));
    return true;
  };

  // A root that is itself a repo stops the walk there: descending would register
  // its submodules as separate repos.
  const rootHits = await scanLimit(roots, collect);
  const level1 = (
    await scanLimit(
      roots.filter((_, i) => rootHits[i] === false),
      listDirs,
    )
  ).flat();
  const missed = await scanLimit(level1, collect);
  const level2 = (
    await scanLimit(
      level1.filter((_, i) => missed[i] === false),
      listDirs,
    )
  ).flat();
  await scanLimit(level2, collect);
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
