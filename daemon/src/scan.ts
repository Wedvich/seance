import { access, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { RepoEntry } from "@seance/shared";
import { git } from "./exec.ts";

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
    const match = content.match(/^gitdir:\s*(.+)\s*$/m);
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
 * The network-touching `git remote set-head` belongs to the spawn path, and
 * only when this returns null.
 */
export async function readDefaultBranch(repoPath: string): Promise<string | null> {
  const fromFile = await readDefaultBranchFile(repoPath);
  if (fromFile !== null) return fromFile;
  const result = await git(repoPath, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], 5_000);
  if (result.exitCode !== 0) return null;
  const match = result.stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
  return match?.[1] ?? null;
}

async function readDefaultBranchFile(repoPath: string): Promise<string | null> {
  const gitDir = await resolveGitDir(repoPath);
  if (gitDir === null) return null;
  const headFile = Bun.file(join(gitDir, "refs", "remotes", "origin", "HEAD"));
  if (!(await headFile.exists())) return null;
  const match = (await headFile.text()).match(/^ref: refs\/remotes\/origin\/(.+)$/m);
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

async function discoverRepoPaths(roots: readonly string[]): Promise<readonly string[]> {
  const found = new Set<string>();
  for (const root of roots) {
    for (const level1 of await listDirs(root)) {
      if (await exists(join(level1, ".git"))) {
        found.add(await canonical(level1));
        continue;
      }
      for (const level2 of await listDirs(level1)) {
        if (await exists(join(level2, ".git"))) found.add(await canonical(level2));
      }
    }
  }
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
 * Depth-2 walk under each root. `defaultBranch` carries forward from the
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
