import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { REPO_MAX_SKILLS, type RepoEntry } from "@seance/shared";
import { mapLimit } from "./concurrency.ts";
import { listSkills } from "./exclaves.ts";
import { git } from "./exec.ts";
import { canonical, inspectCheckout, resolveCommonDir } from "./gitdir.ts";

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

/**
 * The scheduler's repo key: the same across machines where a clone's name
 * (machine-local, collision-disambiguated) is not. Scheme, userinfo and the
 * `.git` suffix go, scp-style `host:path` becomes `host/path`, and the whole
 * thing is lowercased — GitHub and Azure DevOps compare case-insensitively, and
 * a key that differs by case would split one repo in two (DESIGN.md records the
 * collision this accepts on a case-sensitive host). A local path (or
 * `file://`) is some machine's mirror, not a repo identity, so it reads as no
 * remote — a Windows drive-letter or UNC path too, which git takes as local
 * before scp syntax and which would otherwise key `C:/src/repo` as host `c`.
 * Null when nothing usable remains.
 */
export function normalizeOrigin(url: string): string | null {
  let rest = url.trim();
  if (rest === "" || rest.startsWith("/") || rest.startsWith(".")) return null;
  if (/^[a-z]:[\\/]/iu.test(rest) || rest.startsWith("\\\\")) return null;
  const scheme = rest.match(/^([a-z][a-z0-9+.-]*):\/\//iu);
  if (scheme !== null) {
    if (scheme[1]?.toLowerCase() === "file") return null;
    rest = rest.slice(scheme[0].length).replace(/^[^/@]*@/u, "");
  } else {
    // scp-like: `[user@]host:path`
    const scp = rest.match(/^(?:[^/@:]+@)?([^/:]+):(.*)$/u);
    if (scp === null) return null;
    rest = `${scp[1]}/${scp[2]?.replace(/^\/+/u, "") ?? ""}`;
  }
  return originKey(rest);
}

/** `host/path` → the key; null without a path. */
function originKey(hostPath: string): string | null {
  const key = hostPath
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "")
    .replace(/\/+$/u, "")
    .toLowerCase();
  return key.includes("/") ? key : null;
}

/**
 * What a caller typed as an origin, as the keys it could mean, in any case: the
 * input read as a key itself — a listed key with a port (`host:22/path`) would
 * misparse as scp — then keyed as `normalizeOrigin` keys a URL or scp form as
 * `git remote -v` prints it. Empty when neither has a path.
 */
export function originQuery(input: string): readonly string[] {
  const trimmed = input.trim();
  return [...new Set([originKey(trimmed), normalizeOrigin(trimmed)])].filter((key) => key !== null);
}

/**
 * `remote.origin.url` from the common dir's config — the same read `git
 * remote get-url origin` does, without the process. The parser covers what a
 * config written by git holds: sections, `key = value`, comments. `include`
 * directives and `url.<base>.insteadOf` rewrites are not followed, so a repo
 * that only names its remote through them reads as remote-less.
 */
export async function readOriginUrl(commonDir: string): Promise<string | null> {
  let text: string;
  try {
    text = await Bun.file(join(commonDir, "config")).text();
  } catch {
    return null;
  }
  let inOrigin = false;
  for (const line of text.split(/\r?\n/u)) {
    const section = line.match(/^\s*\[([^\s"\]]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]/u);
    if (section !== null) {
      inOrigin = section[1]?.toLowerCase() === "remote" && section[2] === "origin";
      continue;
    }
    if (!inOrigin) continue;
    const entry = line.match(/^\s*url\s*=\s*(.*?)\s*$/iu);
    if (entry === null) continue;
    const raw = entry[1] ?? "";
    // Quoted values keep everything; bare ones end at a comment marker.
    const value = raw.startsWith('"')
      ? (raw.match(/^"((?:[^"\\]|\\.)*)"/u)?.[1] ?? "")
      : raw.replace(/\s*[#;].*$/u, "");
    return value === "" ? null : value; // first `url` is the fetch URL
  }
  return null;
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
    // tmux reports kernel-canonical pane paths (macOS: /var → /private/var) — store canonical paths so prefix mapping works.
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
 * `origin` is re-read every scan: one file, no process, and a remote does get
 * repointed. Basename when there is none — a key, so never absent. Project
 * skills are re-read every scan too, so adding or removing one re-registers.
 */
export async function scanRepos(
  roots: readonly string[],
  previous: readonly RepoEntry[] = [],
): Promise<readonly RepoEntry[]> {
  const prevByPath = new Map(previous.map((r) => [r.path, r]));
  const paths = await discoverRepoPaths(roots);
  const names = assignNames(paths);
  // Bounded like the walk: this is per-repo I/O on every scan now, not only for new clones.
  const entries = await scanLimit(paths, async (path): Promise<RepoEntry> => {
    const cached = prevByPath.get(path)?.defaultBranch ?? null;
    const commonDir = await resolveCommonDir(path);
    const [defaultBranch, url, skills] = await Promise.all([
      cached ?? readDefaultBranch(path),
      commonDir === null ? null : readOriginUrl(commonDir),
      listSkills(join(path, ".claude", "skills")),
    ]);
    const origin = url === null ? null : normalizeOrigin(url);
    return {
      name: names.get(path) ?? path,
      path,
      defaultBranch,
      origin: origin ?? basename(path),
      // A reader drops a longer list whole, so the first names by sort order go rather than none.
      ...(skills.length === 0 ? {} : { skills: skills.slice(0, REPO_MAX_SKILLS) }),
    };
  });
  return entries.toSorted((a, b) => a.name.localeCompare(b.name));
}

export function repoSetsEqual(a: readonly RepoEntry[], b: readonly RepoEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
