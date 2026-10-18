import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFailure, type ExecResult } from "./exec.ts";
import { hardenedGit, networkGit, refusalDetail, repoConfigRefusal, type TerminalProbe } from "./git-hardened.ts";

/** At most one `fetch --prune` per clone per day. */
export const FETCH_STALE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

export type FetchOutcome =
  | { readonly kind: "fresh" }
  | { readonly kind: "fetched" }
  | {
      readonly kind: "failed";
      readonly detail: string;
      /** `detail` without git's stderr, which can carry a remote URL's credentials: safe for a log that is not reap's. */
      readonly brief: string;
    };

/**
 * When reap last ran a `fetch --prune` that succeeded, per canonical common
 * dir. Reap's own record, not `FETCH_HEAD`'s mtime: every worktree spawn writes
 * that file with a one-branch fetch that prunes nothing (`base-fetch.ts`), and
 * so does any `git pull`. On a machine that spawns daily it would never age, and
 * a deleted remote branch would never read `[gone]`.
 */
export type PruneLog = Readonly<Record<string, number>>;

/** Missing or unreadable reads as empty — the cost is one extra fetch per clone. */
export async function readPruneLog(path: string): Promise<PruneLog> {
  const parsed: unknown = await Bun.file(path)
    .json()
    .catch(() => null);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, number] => Number.isFinite(entry[1])),
  );
}

/**
 * `staleMs` is the emitter's shorter window. No submodule recursion: nothing here reads a submodule's refs, and
 * each submodule's own config is one `repoConfigRefusal` never read.
 */
export async function fetchIfStale(
  repoPath: string,
  lastPrunedAt: number,
  now: number,
  staleMs = FETCH_STALE_MS,
  terminal?: TerminalProbe,
): Promise<FetchOutcome> {
  if (now - lastPrunedAt < staleMs) return { kind: "fresh" };
  const result = await networkGit(
    repoPath,
    ["fetch", "--prune", "--quiet", "--no-recurse-submodules", "origin"],
    FETCH_TIMEOUT_MS,
    {},
    terminal,
  );
  if ("refused" in result) return { kind: "failed", detail: refusalDetail(result), brief: refusalDetail(result) };
  return result.exitCode === 0
    ? { kind: "fetched" }
    : {
        kind: "failed",
        detail: execFailure(result),
        brief: result.timedOut ? "timed out" : `exit ${result.exitCode}`,
      };
}

/**
 * Network, so only for a repo with no `origin/HEAD` on disk — about a third of
 * clones — which reap needs to know what "merged" is measured against.
 */
export async function resolveRemoteHead(repoPath: string, terminal?: TerminalProbe): Promise<boolean> {
  const result = await networkGit(repoPath, ["remote", "set-head", "origin", "--auto"], FETCH_TIMEOUT_MS, {}, terminal);
  return "exitCode" in result && result.exitCode === 0;
}

export interface WorktreeRecord {
  readonly path: string;
  readonly head: string;
  /** Short name; null when detached, or on a symbolic ref outside `refs/heads/`, which no branch name can spell. */
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
        branch: branchRef?.startsWith("refs/heads/") === true ? branchRef.slice("refs/heads/".length) : null,
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
  const result = await hardenedGit(repoPath, ["worktree", "list", "--porcelain", "-z"]);
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
  const result = await hardenedGit(repoPath, ["for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads"]);
  return result.exitCode === 0 ? parseBranches(result.stdout) : null;
}

/**
 * Why a tip counts as merged into the default branch, or why it doesn't:
 * - `ancestor` — it is in `origin/<default>`'s history (a merge or fast-forward).
 * - `squash` — merging it changes nothing: its combined diff is already on the
 *   default branch, which is what a squash-merged PR leaves behind.
 *   Also a squash the tree check misses because the default branch has since
 *   edited the same lines: patches checked, and the tip's whole diff from its
 *   merge-base is, patch id for patch id, one commit on the default branch
 *   since that merge-base.
 * - `gone` — patches checked, and every commit's patch is upstream
 *   (`git cherry`), which catches a rebase-merge the tree check can't once the
 *   default branch has since edited the same lines.
 * - `unmerged-gone` — patches checked, but commits whose patch is nowhere
 *   upstream: reap keeps and reports it, since that is unpushed work. A branch
 *   stacked on another PR's branch lands here too: its diff from the default
 *   branch holds the parent's changes as well, so no one commit matches.
 * - `active` — none of the above, patches not checked; kept quietly.
 */
export type Merged = "ancestor" | "squash" | "gone";
export type BranchVerdict = Merged | "unmerged-gone" | "active";

export function isMerged(verdict: BranchVerdict): verdict is Merged {
  return verdict === "ancestor" || verdict === "squash" || verdict === "gone";
}

/** `git patch-id` output as commit → patch id; a diff with no commit header reports the zero sha. */
function parsePatchIds(raw: string): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const [patchId, commit] = line.split(" ");
    if (patchId !== undefined && patchId !== "" && commit !== undefined) ids.set(commit, patchId);
  }
  return ids;
}

async function patchIds(repoPath: string, diff: string): Promise<ReadonlyMap<string, string> | null> {
  const result = await hardenedGit(repoPath, ["patch-id", "--stable"], 60_000, diff);
  return result.exitCode === 0 ? parsePatchIds(result.stdout) : null;
}

export interface PatchIndex {
  /** Whether a non-merge commit in `since..base` has exactly this patch id. */
  readonly landedSince: (since: string, patchId: string) => Promise<boolean>;
}

/**
 * Patch ids of the default branch's commits, each computed once per repo pass
 * however many tips ask: they share most of their `merge-base..base` ranges,
 * and that range can be hundreds of commits.
 */
export function patchIndex(repoPath: string, base: string): PatchIndex {
  const byCommit = new Map<string, string | null>();
  // A range that timed out once would time out for every later tip too, each
  // costing two 60s waits under the reap lock: give up on the index for the pass.
  let broken = false;
  return {
    landedSince: async (since, patchId) => {
      if (broken) return false;
      const revs = await hardenedGit(repoPath, ["rev-list", "--no-merges", `${since}..${base}`]);
      if (revs.exitCode !== 0) return false;
      const range = revs.stdout.split("\n").filter((sha) => sha !== "");
      const missing = range.filter((sha) => !byCommit.has(sha));
      if (missing.length > 0) {
        const diffs = await hardenedGit(repoPath, ["diff-tree", "--stdin", "-p"], 60_000, `${missing.join("\n")}\n`);
        const ids = diffs.exitCode === 0 ? await patchIds(repoPath, diffs.stdout) : null;
        if (ids === null) {
          broken = true;
          return false;
        }
        // An empty commit has no patch id; remembered as such so it isn't asked for again.
        for (const sha of missing) byCommit.set(sha, ids.get(sha) ?? null);
      }
      return range.some((sha) => byCommit.get(sha) === patchId);
    },
  };
}

/**
 * The tip's net change since it forked, as one patch id — what a squash merge
 * of it would carry. Null when the diff is empty or git failed.
 */
async function squashPatchId(repoPath: string, mergeBase: string, tip: string): Promise<string | null> {
  const diff = await hardenedGit(repoPath, ["diff-tree", "-p", mergeBase, tip], 60_000);
  if (diff.exitCode !== 0) return null;
  const ids = await patchIds(repoPath, diff.stdout);
  return ids?.values().next().value ?? null;
}

/**
 * `baseTree` is `base^{tree}`, resolved once per repo by the caller rather than once per tip. `checkPatches` gates
 * the `cherry` and patch-id checks behind a failed tree check: reap's gate is a `[gone]` upstream, the emitter's is
 * pushed evidence, since origin may keep a merged PR's branch (GitHub's default) and the tree check conflicts once
 * the default branch edits the same lines.
 */
export async function classifyTip(
  repoPath: string,
  tip: string,
  base: string,
  baseTree: string,
  checkPatches: boolean,
  patches: PatchIndex,
): Promise<BranchVerdict> {
  const ancestor = await hardenedGit(repoPath, ["merge-base", "--is-ancestor", tip, base]);
  if (ancestor.exitCode === 0) return "ancestor";
  // A conflict (exit 1) or a git without --write-tree (exit 129) reads as not
  // merged: the safe direction. Writes a few loose objects, which gc collects.
  // Skipped, the same safe direction, where the repo's own config could name a merge driver or filter: it runs them.
  if ((await repoConfigRefusal(repoPath)) === null) {
    const merged = await hardenedGit(repoPath, ["merge-tree", "--write-tree", base, tip]);
    if (merged.exitCode === 0 && merged.stdout.split("\n")[0]?.trim() === baseTree) return "squash";
  }
  if (!checkPatches) return "active";
  const cherry = await hardenedGit(repoPath, ["cherry", base, tip]);
  if (cherry.exitCode !== 0) return "unmerged-gone";
  if (!cherry.stdout.split("\n").some((line) => line.startsWith("+"))) return "gone";
  // Only commits after the fork count: a patch from before it that main since
  // reverted is not on main, and a branch re-applying it is new work.
  const forkedAt = await hardenedGit(repoPath, ["merge-base", base, tip]);
  if (forkedAt.exitCode !== 0) return "unmerged-gone";
  const mergeBase = forkedAt.stdout.trim();
  const patchId = await squashPatchId(repoPath, mergeBase, tip);
  if (patchId === null) return "unmerged-gone";
  return (await patches.landedSince(mergeBase, patchId)) ? "squash" : "unmerged-gone";
}

/** Commits on `tip` that aren't in `base` by sha — the count a kept branch is reported with. */
export async function commitsAhead(repoPath: string, tip: string, base: string): Promise<number> {
  const result = await hardenedGit(repoPath, ["rev-list", "--count", `${base}..${tip}`]);
  return result.exitCode === 0 ? Number(result.stdout.trim()) : 0;
}

/**
 * Lines of `status --porcelain`: tracked changes and untracked files. Ignored
 * files don't count — `git worktree remove` deletes them, a `.env` copy among
 * them, and that is accepted. Null when status itself failed. Untracked and
 * submodule reporting are pinned against repo config: `git worktree remove`'s
 * own clean check is a bare `status`, so under `status.showUntrackedFiles=no`
 * it deletes untracked files unseen, and this is the only gate left.
 */
export async function pendingChanges(worktree: string): Promise<number | null> {
  const result = await hardenedGit(worktree, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
    "--ignore-submodules=none",
  ]);
  if (result.exitCode !== 0) return null;
  return result.stdout.split("\n").filter((line) => line !== "").length;
}

export async function gitDirOf(worktree: string): Promise<string | null> {
  const result = await hardenedGit(worktree, ["rev-parse", "--absolute-git-dir"]);
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
  return hardenedGit(repoPath, ["worktree", "remove", worktree]);
}

export async function pruneWorktrees(repoPath: string): Promise<ExecResult> {
  return hardenedGit(repoPath, ["worktree", "prune"]);
}

/**
 * Compare-and-delete: `update-ref` refuses when the branch no longer points at
 * the sha it was judged by, so a branch that moved since is kept rather than
 * deleted unseen. Its config section goes too, as `git branch -D` would remove it.
 */
export async function deleteBranch(repoPath: string, name: string, sha: string): Promise<ExecResult> {
  const deleted = await hardenedGit(repoPath, ["update-ref", "-d", `refs/heads/${name}`, sha]);
  if (deleted.exitCode === 0) await hardenedGit(repoPath, ["config", "--remove-section", `branch.${name}`]);
  return deleted;
}
