import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "@seance/shared";
import { execFailure, type ExecResult } from "./exec.ts";
import { askGithub } from "./gh.ts";
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
 * The attributes of each record of `git worktree list --porcelain -z`: NUL-terminated,
 * an empty one ending each record, so a path holding a newline can't split one.
 */
function splitRecords(raw: string): readonly (readonly string[])[] {
  const records: string[][] = [];
  let fields: string[] = [];
  const flush = (): void => {
    if (fields.length > 0) records.push(fields);
    fields = [];
  };
  for (const field of raw.split("\0")) {
    if (field === "") flush();
    else fields.push(field);
  }
  flush();
  return records;
}

function attribute(fields: readonly string[], name: string): string | undefined {
  return fields.find((field) => field.startsWith(`${name} `))?.slice(name.length + 1);
}

/**
 * Pure parser over `git worktree list --porcelain -z` — exported for unit
 * tests. The main worktree comes first; callers that want linked worktrees
 * only drop it.
 */
export function parseWorktreeList(raw: string): readonly WorktreeRecord[] {
  return splitRecords(raw).flatMap((fields): WorktreeRecord[] => {
    const path = attribute(fields, "worktree");
    if (path === undefined) return [];
    const branchRef = attribute(fields, "branch");
    return [
      {
        path,
        head: attribute(fields, "HEAD") ?? "",
        branch: branchRef?.startsWith("refs/heads/") === true ? branchRef.slice("refs/heads/".length) : null,
        locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
        prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
      },
    ];
  });
}

/**
 * The lock on the worktree at `path` in the same output: null when it has none,
 * else its reason ("" when the lock names none). Separate from `WorktreeRecord`
 * since reap reads only whether a lock exists.
 */
export function parseWorktreeLock(raw: string, path: string): { readonly reason: string } | null {
  for (const fields of splitRecords(raw)) {
    if (attribute(fields, "worktree") !== path) continue;
    if (fields.includes("locked")) return { reason: "" };
    const reason = attribute(fields, "locked");
    return reason === undefined ? null : { reason };
  }
  return null;
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
  /** Any upstream is configured — false is a branch never pushed, local-only work. */
  readonly hasUpstream: boolean;
}

const BRANCH_FORMAT = "%(refname)%00%(objectname)%00%(upstream:track)%00%(upstream)";

/** Pure parser over `for-each-ref` in `BRANCH_FORMAT` — exported for unit tests. */
export function parseBranches(raw: string): readonly BranchRecord[] {
  const branches: BranchRecord[] = [];
  for (const line of raw.split("\n")) {
    const [ref, sha, track, upstream] = line.split("\0");
    if (ref === undefined || sha === undefined || !ref.startsWith("refs/heads/")) continue;
    branches.push({
      name: ref.slice("refs/heads/".length),
      sha,
      upstreamGone: track === "[gone]",
      hasUpstream: upstream !== undefined && upstream !== "",
    });
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

/** Commits on `tip` that aren't in `base` by sha — the count a kept branch is reported with. Null when rev-list failed: unknown, not zero. */
export async function commitsAhead(repoPath: string, tip: string, base: string): Promise<number | null> {
  const result = await hardenedGit(repoPath, ["rev-list", "--count", `${base}..${tip}`]);
  return result.exitCode === 0 ? Number(result.stdout.trim()) : null;
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

/** The repository `origin` names on GitHub, which binds the merged-PR read; lowercase, as GitHub compares. */
export interface GithubRepo {
  readonly owner: string;
  readonly name: string;
}

const GITHUB_KEY = /^github\.com\/([a-z0-9-]{1,39})\/([a-z0-9._-]{1,100})$/u;

/** From `normalizeOrigin`'s key; null for any other host or shape, where the PR check cannot be evaluated. */
export function githubRepoOf(originKey: string | null): GithubRepo | null {
  const match = originKey === null ? null : GITHUB_KEY.exec(originKey);
  const [, owner, name] = match ?? [];
  return owner === undefined || name === undefined ? null : { owner, name };
}

/**
 * Why the rule could not be evaluated, which keeps a worktree without failing it (custodian C33): git status failed,
 * origin could not be asked or a needed object fetched, a dry run did not fetch one (`fetch-skipped`), or `gh` gave
 * no usable answer.
 */
export type NothingLostUnknown = "status" | "remote" | "fetch-skipped" | "forge";

/**
 * The nothing-lost rule's verdict (DESIGN.md, Reap, "Nothing lost"). `safe` names the way the tip passed: one of
 * `classifyTip`'s merges, `origin` (it is, or is an ancestor of, its branch's tip there) or `pr` (a merged PR's head
 * contains it). `fails` is work that exists only here; `unknown` is the rule not answering, never a failure.
 */
export type NothingLost =
  | { readonly kind: "safe"; readonly how: Merged | "origin" | "pr" }
  | { readonly kind: "fails"; readonly why: "dirty"; readonly changes: number }
  | { readonly kind: "fails"; readonly why: "unpushed" }
  | { readonly kind: "unknown"; readonly why: NothingLostUnknown };

export interface NothingLostInput {
  /** The main clone: every network call and object lookup runs there. */
  readonly repoPath: string;
  readonly worktree: string;
  readonly tip: string;
  /** The worktree's own branch; null (detached) has nothing on origin or GitHub to bind to. */
  readonly branch: string | null;
  readonly github: GithubRepo | null;
  /** A merge `classifyTip` already found: a further way to pass, checked after the clean tree. */
  readonly merged?: Merged;
  /** False in a dry run: a missing object is then not fetched, and the check that needed it is unknown. */
  readonly fetch: boolean;
  /** False once this run found origin unreachable, or is stopping: the network checks are skipped, `unknown remote`. Default true. */
  readonly remote?: boolean;
  /** The `gh` binary; `SEANCE_GH_BIN` then the PATH when absent. */
  readonly gh?: string;
  readonly terminal?: TerminalProbe;
}

const GH_TIMEOUT_MS = 15_000;
/** Merged PRs read per branch; past it, a tip none of them holds is unknown rather than failed. */
const MERGED_PR_PAGE = 20;
const MAX_PR_NUMBER = 2_147_483_647;
const COMMIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

const MERGED_PRS_QUERY = `query($o:String!,$r:String!,$h:String!){ repository(owner:$o,name:$r){ pullRequests(headRefName:$h,states:MERGED,first:${MERGED_PR_PAGE},orderBy:{field:UPDATED_AT,direction:DESC}){ totalCount nodes{ number headRefOid isCrossRepository } } } }`;

interface MergedHeads {
  readonly heads: readonly { readonly number: number; readonly oid: string }[];
  /** Every merged PR on the branch was read. */
  readonly complete: boolean;
}

/**
 * Merged, same-repository PRs whose head branch is `branch`, read by this machine's own `gh` (custodian C36): owner,
 * name and branch reach it only as GraphQL variables (`-f`, never `-F`, which reads `@file`), the query text is
 * constant, and nothing of the answer is logged. A fork's PR from a branch of the same name is not this branch.
 * Null when `gh` gave nothing usable.
 */
async function readMergedHeads(
  github: GithubRepo,
  branch: string,
  gh: string | undefined,
): Promise<MergedHeads | null> {
  const answer = await askGithub({ ...(gh === undefined ? {} : { gh }), timeoutMs: GH_TIMEOUT_MS }, MERGED_PRS_QUERY, [
    "-f",
    `o=${github.owner}`,
    "-f",
    `r=${github.name}`,
    "-f",
    `h=${branch}`,
  ]);
  if (answer.kind !== "ok") return null;
  // `errors` beside `data` is a partial answer: an empty `nodes` in it is not a complete negative.
  const errors = answer.body["errors"];
  if (errors !== undefined && !(Array.isArray(errors) && errors.length === 0)) return null;
  const repository = answer.data["repository"];
  const prs = isRecord(repository) ? repository["pullRequests"] : undefined;
  if (!isRecord(prs)) return null;
  const { totalCount, nodes } = prs;
  if (typeof totalCount !== "number" || !Array.isArray(nodes)) return null;
  const heads: { number: number; oid: string }[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) return null;
    const { number, headRefOid, isCrossRepository } = node;
    if (
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number < 1 ||
      number > MAX_PR_NUMBER ||
      typeof headRefOid !== "string" ||
      !COMMIT_OID.test(headRefOid) ||
      typeof isCrossRepository !== "boolean"
    ) {
      return null;
    }
    if (!isCrossRepository) heads.push({ number, oid: headRefOid });
  }
  return { heads, complete: totalCount <= nodes.length };
}

async function isAncestor(repoPath: string, tip: string, of: string): Promise<boolean | null> {
  const result = await hardenedGit(repoPath, ["merge-base", "--is-ancestor", tip, of]);
  if (result.exitCode === 0) return true;
  return result.exitCode === 1 ? false : null;
}

/**
 * Whether commit `sha` is in the clone, fetching `source` from origin when it is not and `fetch` allows. Null when
 * that fetch failed, `skipped` when it was not allowed (a dry run). Lazy fetch off: a partial clone's lookup would
 * reach the network unbounded.
 */
async function haveCommit(
  input: NothingLostInput,
  sha: string,
  source: readonly string[],
): Promise<boolean | "skipped" | null> {
  const local = (): Promise<ExecResult> =>
    hardenedGit(input.repoPath, ["cat-file", "-e", `${sha}^{commit}`], 15_000, undefined, { GIT_NO_LAZY_FETCH: "1" });
  if ((await local()).exitCode === 0) return true;
  if (!input.fetch) return "skipped";
  const fetched = await networkGit(
    input.repoPath,
    ["fetch", "--quiet", "--no-recurse-submodules", "--no-write-fetch-head", "origin", ...source],
    FETCH_TIMEOUT_MS,
    {},
    input.terminal,
  );
  if (!("exitCode" in fetched) || fetched.exitCode !== 0) return null;
  return (await local()).exitCode === 0;
}

/**
 * Asked of origin itself (`ls-remote`), not of the refs reap's daily fetch left: its branch's tip there now. `absent`
 * is origin answering it has no such branch (exit 2); null is no answer.
 */
async function originHolds(input: NothingLostInput, branch: string): Promise<boolean | "absent" | "skipped" | null> {
  const ref = `refs/heads/${branch}`;
  const listed = await networkGit(
    input.repoPath,
    ["ls-remote", "--exit-code", "origin", ref],
    FETCH_TIMEOUT_MS,
    {},
    input.terminal,
  );
  if (!("exitCode" in listed)) return null;
  if (listed.exitCode === 2) return "absent";
  if (listed.exitCode !== 0) return null;
  // A pattern matches any ref ending in it (`refs/heads/x/refs/heads/<b>`): only the exact one counts.
  const sha = listed.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, name]) => name === ref)?.[0];
  if (sha === undefined) return "absent";
  if (!COMMIT_OID.test(sha)) return null;
  if (sha === input.tip) return true;
  const have = await haveCommit(input, sha, [`+${ref}:refs/remotes/origin/${branch}`]);
  if (have !== true) return have;
  return isAncestor(input.repoPath, input.tip, sha);
}

/** Whether a merged PR's head contains the tip: the head's object comes from GitHub's `refs/pull/<n>/head`, kept after the branch is deleted. */
async function prHolds(
  input: NothingLostInput,
  github: GithubRepo,
  branch: string,
): Promise<true | false | NothingLostUnknown> {
  const merged = await readMergedHeads(github, branch, input.gh);
  if (merged === null) return "forge";
  let unknown: NothingLostUnknown | null = null;
  for (const head of merged.heads) {
    if (head.oid === input.tip) return true;
    // oxlint-disable-next-line no-await-in-loop -- rarely more than one merged PR per branch
    const have = await haveCommit(input, head.oid, [`refs/pull/${head.number}/head`]);
    // oxlint-disable-next-line no-await-in-loop
    const contains = have === true ? await isAncestor(input.repoPath, input.tip, head.oid) : null;
    if (contains === true) return true;
    if (contains === null) unknown ??= have === "skipped" ? "fetch-skipped" : "remote";
  }
  if (!merged.complete) return "forge";
  return unknown ?? false;
}

/**
 * Whether the worktree can be removed with nothing lost (custodian C32): its tree is clean — no modified, staged or
 * untracked files; ignored ones don't count — and its tip is safe elsewhere, by `merged`, on its branch on `origin`,
 * or in a merged GitHub PR's head. Kept either way when it fails or can't be told; only `fails` is a finding.
 */
export async function nothingLost(input: NothingLostInput): Promise<NothingLost> {
  const changes = await pendingChanges(input.worktree);
  if (changes === null) return { kind: "unknown", why: "status" };
  if (changes > 0) return { kind: "fails", why: "dirty", changes };
  if (input.merged !== undefined) return { kind: "safe", how: input.merged };
  if (input.branch === null) return { kind: "fails", why: "unpushed" };
  if (input.remote === false) return { kind: "unknown", why: "remote" };
  const origin = await originHolds(input, input.branch);
  if (origin === true) return { kind: "safe", how: "origin" };
  const remote: NothingLostUnknown | null = origin === null ? "remote" : origin === "skipped" ? "fetch-skipped" : null;
  // Origin answered and is not on GitHub: no merged PR can hold the tip, so what origin lacks exists only here.
  if (input.github === null) {
    return remote === null ? { kind: "fails", why: "unpushed" } : { kind: "unknown", why: remote };
  }
  const pr = await prHolds(input, input.github, input.branch);
  if (pr === true) return { kind: "safe", how: "pr" };
  const why = remote ?? (pr === false ? null : pr);
  return why === null ? { kind: "fails", why: "unpushed" } : { kind: "unknown", why };
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
