import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec, execFailure, type ExecResult } from "./exec.ts";

/**
 * Every git call `seanced reap` makes. Reap is the first code to run git in
 * every scanned repo, and repo-local config executes: `core.fsmonitor` would
 * start a hook (or a daemon) per worktree and hooks run on ref updates, so both
 * are off for every call. `GIT_OPTIONAL_LOCKS=0` keeps `status` from refreshing
 * the index — whose mtime is one of the age signals, and reap must not reset the
 * age it is measuring. `GIT_TERMINAL_PROMPT=0` plus exec's ignored stdin and a
 * timeout keep a fetch that wants credentials from hanging, as Claude Code does.
 * What still runs is what a fetch needs — credential helpers, `core.sshCommand`.
 */
export async function reapGit(cwd: string, args: readonly string[], timeoutMs = 15_000): Promise<ExecResult> {
  return exec(["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    timeoutMs,
    env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
}

/** Claude Code's rule for its own `--worktree` fetch: only when the last one is over a day old. */
export const FETCH_STALE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

export type FetchOutcome =
  | { readonly kind: "fresh" }
  | { readonly kind: "fetched" }
  | { readonly kind: "failed"; readonly detail: string };

/**
 * The newest `FETCH_HEAD` across the clone and its worktrees: a fetch run inside
 * a linked worktree may record it in that worktree's own git dir.
 */
async function lastFetchedAt(commonDir: string): Promise<number> {
  const worktrees = await readdir(join(commonDir, "worktrees")).catch(() => [] as string[]);
  const candidates = [
    join(commonDir, "FETCH_HEAD"),
    ...worktrees.map((name) => join(commonDir, "worktrees", name, "FETCH_HEAD")),
  ];
  const times = await Promise.all(candidates.map(async (file) => (await stat(file).catch(() => null))?.mtimeMs ?? 0));
  return Math.max(0, ...times);
}

export async function fetchIfStale(repoPath: string, commonDir: string, now: number): Promise<FetchOutcome> {
  if (now - (await lastFetchedAt(commonDir)) < FETCH_STALE_MS) return { kind: "fresh" };
  const result = await reapGit(repoPath, ["fetch", "--prune", "--quiet", "origin"], FETCH_TIMEOUT_MS);
  return result.exitCode === 0 ? { kind: "fetched" } : { kind: "failed", detail: execFailure(result) };
}

/**
 * Network, so only for a repo with no `origin/HEAD` on disk — about a third of
 * clones — which reap needs to know what "merged" is measured against.
 */
export async function resolveRemoteHead(repoPath: string): Promise<boolean> {
  const result = await reapGit(repoPath, ["remote", "set-head", "origin", "--auto"], FETCH_TIMEOUT_MS);
  return result.exitCode === 0;
}

export interface WorktreeRecord {
  readonly path: string;
  readonly head: string;
  /** Short name; null when detached. */
  readonly branch: string | null;
  readonly locked: boolean;
  readonly prunable: boolean;
}

/**
 * Pure parser over `git worktree list --porcelain -z` — exported for unit
 * tests. NUL-terminated attributes, an empty one ending each record, so a path
 * holding a newline can't split one. The main worktree comes first; callers
 * that want linked worktrees only drop it.
 */
export function parseWorktreeList(raw: string): readonly WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let fields: string[] = [];
  const flush = (): void => {
    const path = fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
    if (path !== undefined) {
      const branchRef = fields.find((field) => field.startsWith("branch "))?.slice("branch ".length);
      records.push({
        path,
        head: fields.find((field) => field.startsWith("HEAD "))?.slice("HEAD ".length) ?? "",
        branch: branchRef?.replace(/^refs\/heads\//u, "") ?? null,
        locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
        prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
      });
    }
    fields = [];
  };
  for (const field of raw.split("\0")) {
    if (field === "") flush();
    else fields.push(field);
  }
  flush();
  return records;
}

export async function listWorktrees(repoPath: string): Promise<readonly WorktreeRecord[] | null> {
  const result = await reapGit(repoPath, ["worktree", "list", "--porcelain", "-z"]);
  return result.exitCode === 0 ? parseWorktreeList(result.stdout) : null;
}

export interface BranchRecord {
  readonly name: string;
  readonly sha: string;
  /** Its upstream is configured but the remote branch is gone (`[gone]`) — what a merged PR's deleted branch leaves. */
  readonly upstreamGone: boolean;
}

const BRANCH_FORMAT = "%(refname)%00%(objectname)%00%(upstream:track)";

/** Pure parser over `for-each-ref` in `BRANCH_FORMAT` — exported for unit tests. */
export function parseBranches(raw: string): readonly BranchRecord[] {
  const branches: BranchRecord[] = [];
  for (const line of raw.split("\n")) {
    const [ref, sha, track] = line.split("\0");
    if (ref === undefined || sha === undefined || !ref.startsWith("refs/heads/")) continue;
    branches.push({ name: ref.slice("refs/heads/".length), sha, upstreamGone: track === "[gone]" });
  }
  return branches;
}

export async function listBranches(repoPath: string): Promise<readonly BranchRecord[] | null> {
  const result = await reapGit(repoPath, ["for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads"]);
  return result.exitCode === 0 ? parseBranches(result.stdout) : null;
}

/**
 * Why a tip counts as merged into the default branch, or why it doesn't:
 * - `ancestor` — it is in `origin/<default>`'s history (a merge or fast-forward).
 * - `squash` — merging it changes nothing: its combined diff is already on the
 *   default branch, which is what a squash-merged PR leaves behind.
 * - `gone` — its upstream was deleted and every commit's patch is upstream
 *   (`git cherry`), which catches a rebase-merge the tree check can't once the
 *   default branch has since edited the same lines.
 * - `unmerged-gone` — upstream deleted, but commits whose patch is nowhere
 *   upstream: kept, and reported, since that is unpushed work.
 * - `active` — none of the above; kept quietly.
 */
export type Merged = "ancestor" | "squash" | "gone";
export type BranchVerdict = Merged | "unmerged-gone" | "active";

export async function classifyTip(
  repoPath: string,
  tip: string,
  base: string,
  upstreamGone: boolean,
): Promise<BranchVerdict> {
  const ancestor = await reapGit(repoPath, ["merge-base", "--is-ancestor", tip, base]);
  if (ancestor.exitCode === 0) return "ancestor";
  // A conflict (exit 1) or a git without --write-tree (exit 129) reads as not
  // merged: the safe direction. Writes a few loose objects, which gc collects.
  const [merged, baseTree] = await Promise.all([
    reapGit(repoPath, ["merge-tree", "--write-tree", base, tip]),
    reapGit(repoPath, ["rev-parse", `${base}^{tree}`]),
  ]);
  const mergedTree = merged.stdout.split("\n")[0]?.trim();
  if (merged.exitCode === 0 && baseTree.exitCode === 0 && mergedTree === baseTree.stdout.trim()) return "squash";
  if (!upstreamGone) return "active";
  const cherry = await reapGit(repoPath, ["cherry", base, tip]);
  if (cherry.exitCode !== 0) return "unmerged-gone";
  return cherry.stdout.split("\n").some((line) => line.startsWith("+")) ? "unmerged-gone" : "gone";
}

/** Commits on `tip` that aren't in `base` by sha — the count a kept branch is reported with. */
export async function commitsAhead(repoPath: string, tip: string, base: string): Promise<number> {
  const result = await reapGit(repoPath, ["rev-list", "--count", `${base}..${tip}`]);
  return result.exitCode === 0 ? Number(result.stdout.trim()) : 0;
}

/**
 * Lines of `status --porcelain`: tracked changes and untracked files. Ignored
 * files don't count — `git worktree remove` deletes them, a `.env` copy among
 * them, and that is accepted. Null when status itself failed.
 */
export async function pendingChanges(worktree: string): Promise<number | null> {
  const result = await reapGit(worktree, ["status", "--porcelain"]);
  if (result.exitCode !== 0) return null;
  return result.stdout.split("\n").filter((line) => line !== "").length;
}

export async function gitDirOf(worktree: string): Promise<string | null> {
  const result = await reapGit(worktree, ["rev-parse", "--absolute-git-dir"]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Where Claude Code keeps a directory's transcripts: its path with every non-alphanumeric as `-`. */
export function transcriptDir(path: string): string {
  const configDir = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
  return join(configDir, "projects", path.replaceAll(/[^a-zA-Z0-9]/gu, "-"));
}

async function newestEntry(dir: string): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const times = await Promise.all(
    names.map(async (name) => (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0),
  );
  return Math.max(0, ...times);
}

/**
 * When a worktree was last touched, from what is cheap to read and moves when
 * someone works there: its git dir's HEAD, index and reflog (checkouts,
 * commits, and any `status` a session runs), the worktree root, and the newest
 * Claude transcript recorded for its path — which covers a claude running
 * outside tmux (an editor, a plain terminal) that the pane check can't see.
 * Must be read before reap's own `status`, which `GIT_OPTIONAL_LOCKS=0` keeps
 * from writing the index regardless.
 */
export async function lastTouched(worktree: string, gitDir: string, aliases: readonly string[]): Promise<number> {
  const files = [join(gitDir, "HEAD"), join(gitDir, "index"), join(gitDir, "logs", "HEAD"), worktree];
  const [fileTimes, transcriptTimes] = await Promise.all([
    Promise.all(files.map(async (file) => (await stat(file).catch(() => null))?.mtimeMs ?? 0)),
    Promise.all([...new Set([worktree, ...aliases])].map((path) => newestEntry(transcriptDir(path)))),
  ]);
  return Math.max(0, ...fileTimes, ...transcriptTimes);
}

/** Never `--force`: git refuses a worktree with changes, untracked files or submodules, and that refusal is reported. */
export async function removeWorktree(repoPath: string, worktree: string): Promise<ExecResult> {
  return reapGit(repoPath, ["worktree", "remove", worktree]);
}

export async function pruneWorktrees(repoPath: string): Promise<ExecResult> {
  return reapGit(repoPath, ["worktree", "prune"]);
}

/**
 * Compare-and-delete: `update-ref` refuses when the branch no longer points at
 * the sha it was judged by, so a branch that moved since is kept rather than
 * deleted unseen. Its config section goes too, as `git branch -D` would remove it.
 */
export async function deleteBranch(repoPath: string, name: string, sha: string): Promise<ExecResult> {
  const deleted = await reapGit(repoPath, ["update-ref", "-d", `refs/heads/${name}`, sha]);
  if (deleted.exitCode === 0) await reapGit(repoPath, ["config", "--remove-section", `branch.${name}`]);
  return deleted;
}
