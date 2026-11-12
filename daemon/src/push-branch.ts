import { isBranchName, type PushBranchErrorCode, type PushBranchResponse } from "@seance/shared";
import { canonical, inspectCheckout } from "./gitdir.ts";
import { hardenedGit, networkGit, pushConfigRefusal } from "./git-hardened.ts";
import { listWorktrees, pendingChanges } from "./reap-git.ts";

/** A task's worktree as the daemon's own launch ledger noted it — never a path or repo from a frame. */
export interface TaskSite {
  readonly repo: string;
  readonly path: string;
}

export interface PushOptions {
  /** The PR head the leader read with its own `gh`; only compared, or taken as the target (see `pushTaskBranch`). */
  readonly expect?: string;
  /** The task has a PR, so a branch with no upstream and no `expect` is the session's to fix (`no_upstream`). */
  readonly hasPr?: boolean;
  /**
   * The push is refused `push_failed` (nothing pushed) when it would start later than this after the call began.
   * Set only for the scheduler's `push-branch`, which the leader waits on for a fixed window; a session's own pass
   * (`pass_to_successor`) has no such window, so it leaves this out.
   */
  readonly startDeadlineMs?: number;
  /** A test seam for the clock `startDeadlineMs` is read against; `Date.now` when absent. */
  readonly now?: () => number;
}

/** Past the 15 s default of the plumbing calls; under the leader's 90 s `push-branch` window with room to fetch. */
const PUSH_TIMEOUT_MS = 45_000;
const FETCH_TIMEOUT_MS = 15_000;
/**
 * A scheduler-sealed push is not started later than this after `pushTaskBranch` began: with `PUSH_TIMEOUT_MS` it keeps
 * the push's landing inside the leader's 90 s `push-branch` window in the common case. Not a guarantee: the reply's
 * transit and a slow `containedInOrigin` still add to it.
 */
export const PUSH_START_DEADLINE_MS = 30_000;
const HEADS = "refs/heads/";
const REMOTES = "refs/remotes/origin/";
const ORIGIN_HEAD = "refs/remotes/origin/HEAD";
const FALLBACK_DEFAULTS: ReadonlySet<string> = new Set(["main", "master"]);

/**
 * Replies carry a code and fixed text only: git's stderr names a URL and the branch, and neither crosses the wire,
 * the audit or the log (DESIGN.md, "Passing to a successor").
 */
const MESSAGES: Readonly<Record<PushBranchErrorCode, string>> = {
  not_launched: "the task has no worktree on this machine",
  detached_head: "the worktree is on a detached HEAD",
  default_branch: "the worktree is on the repo's default branch",
  dirty_worktree: "the worktree has uncommitted changes",
  branch_mismatch: "the branch does not match the task's pull request",
  no_upstream: "the branch has no upstream",
  push_rejected: "the remote rejected the push",
  push_failed: "the push did not complete",
  invalid_request: "the request was not valid",
  internal_error: "the push did not complete",
  too_large: "the reply was too large",
};

function fail(code: PushBranchErrorCode): PushBranchResponse {
  return { ok: false, code, message: MESSAGES[code] };
}

interface Upstream {
  /** The branch the local branch tracks on `origin`, or null when it tracks none there (nothing, or another remote). */
  readonly branch: string | null;
  /** It names `origin` but not a branch git could push to. */
  readonly malformed: boolean;
}

async function configValue(path: string, key: string): Promise<string | null | undefined> {
  const read = await hardenedGit(path, ["config", "--local", "--get", key]);
  if (read.exitCode === 1) return null;
  return read.exitCode === 0 ? read.stdout.trim() : undefined;
}

/**
 * `branch.<b>.remote` and `.merge`, held to what a push to `origin` can mean; `undefined` when git could not say.
 * Another remote, or none, counts as no upstream: a worktree that ran `git push -u fork` is still this task's.
 */
async function upstreamOf(path: string, branch: string): Promise<Upstream | undefined> {
  const remote = await configValue(path, `branch.${branch}.remote`);
  const merge = await configValue(path, `branch.${branch}.merge`);
  if (remote === undefined || merge === undefined) return undefined;
  if (remote !== "origin" || merge === null) return { branch: null, malformed: false };
  const name = merge.startsWith(HEADS) ? merge.slice(HEADS.length) : "";
  return isBranchName(name) ? { branch: name, malformed: false } : { branch: null, malformed: true };
}

async function resolve(path: string, ref: string): Promise<string | null> {
  const read = await hardenedGit(path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`, "--"]);
  const sha = read.stdout.trim();
  return read.exitCode === 0 && sha !== "" ? sha : null;
}

/** The repo's default branch as `origin/HEAD` names it; null when it names none (a clone that never resolved it). */
async function defaultBranchOf(path: string): Promise<string | null> {
  const read = await hardenedGit(path, ["symbolic-ref", "--quiet", ORIGIN_HEAD]);
  const ref = read.stdout.trim();
  return read.exitCode === 0 && ref.startsWith(REMOTES) ? ref.slice(REMOTES.length) : null;
}

function isDefault(name: string, defaultBranch: string | null): boolean {
  return defaultBranch === null ? FALLBACK_DEFAULTS.has(name) : name === defaultBranch;
}

/**
 * Pushes a task's worktree branch to a branch on `origin` (`push-branch`, DESIGN.md "Passing to a successor").
 * The site is the launch ledger's, so the wire names nothing to push from. The target is the branch's own upstream
 * (`branch.<b>.remote` exactly `origin`; another remote counts as none); `expect` — the PR head the leader read —
 * must equal it, and is taken as the target only for a branch with no upstream whose `origin/<expect>` (fetched
 * here) is an ancestor of the local tip and of no default branch, which is what a worktree started from that
 * branch's own tip looks like. Never forced, never a hook or a signed push, never the default branch, never a
 * dirty tree. A tip origin already holds is pushed all the same (git answers `=`, `pushed: false`): a tracking
 * ref the last fetch left behind may not be what origin holds. A push refused as a non-fast-forward is
 * `push_rejected` unless origin's branch has moved on past the local tip (see `containedInOrigin`). With
 * `startDeadlineMs`, a push that would start later than that after this call began is `push_failed` with nothing pushed.
 */
export async function pushTaskBranch(site: TaskSite, options: PushOptions = {}): Promise<PushBranchResponse> {
  const { path } = site;
  const now = options.now ?? Date.now;
  const started = now();
  const checkout = await inspectCheckout(path);
  if (checkout.kind !== "linked") return fail("not_launched");
  const here = await canonical(path);
  const trees = await listWorktrees(path);
  if (trees === null) return fail("push_failed");
  const own = (
    await Promise.all(trees.map(async (tree) => ((await canonical(tree.path)) === here ? tree : null)))
  ).find((tree) => tree !== null && tree !== undefined);
  if (own === undefined || own === null) return fail("not_launched");
  const local = own.branch;
  if (local === null) return fail("detached_head");
  if (!isBranchName(local)) return fail("push_failed");

  const upstream = await upstreamOf(path, local);
  if (upstream === undefined) return fail("push_failed");
  if (upstream.malformed) return fail("push_failed");

  const expected = options.expect;
  if (expected !== undefined && !isBranchName(expected)) return fail("invalid_request");

  const defaultBranch = await defaultBranchOf(path);
  let remote: string;
  if (upstream.branch !== null) {
    if (expected !== undefined && expected !== upstream.branch) return fail("branch_mismatch");
    remote = upstream.branch;
  } else if (expected !== undefined) {
    // Before the fetch: the default branch is never adopted, whatever it holds.
    if (isDefault(expected, defaultBranch)) return fail("default_branch");
    const adopted = await adoptable(path, expected, defaultBranch);
    if (adopted !== "yes") return fail(adopted === "no" ? "branch_mismatch" : "push_failed");
    remote = expected;
  } else {
    if (options.hasPr === true) return fail("no_upstream");
    remote = local;
  }

  if (isDefault(local, defaultBranch) || isDefault(remote, defaultBranch)) return fail("default_branch");

  const pending = await pendingChanges(path);
  if (pending === null) return fail("push_failed");
  if (pending > 0) return fail("dirty_worktree");

  const tip = await resolve(path, "HEAD");
  if (tip === null) return fail("push_failed");

  // A repo-local pushurl or pushInsteadOf would send the push somewhere other than the origin the PR head was read from.
  if ((await pushConfigRefusal(path)) !== null) return fail("push_failed");
  // Past this the leader's window may close before the push lands; nothing has been pushed yet, so refusing is clean.
  if (options.startDeadlineMs !== undefined && now() - started > options.startDeadlineMs) return fail("push_failed");
  const pushed = await networkGit(
    path,
    [
      "push",
      "--porcelain",
      "--no-verify",
      "--no-follow-tags",
      "--no-recurse-submodules",
      "--no-signed",
      "origin",
      // The sha read above, not the branch: a commit the live session makes meanwhile cannot make origin differ from `tip`.
      `${tip}:${HEADS}${remote}`,
    ],
    PUSH_TIMEOUT_MS,
  );
  if ("refused" in pushed) return fail("push_failed");
  if (pushed.timedOut) return fail("push_failed");
  const flags = pushed.stdout
    .split("\n")
    .filter((line) => /^[ +\-*=!]\t/u.test(line))
    .map((line) => line.charAt(0));
  if (flags.includes("!")) return containedInOrigin(path, remote, tip);
  if (pushed.exitCode !== 0) return fail("push_failed");
  // Not on exit 0 alone: success is a ref line saying origin now holds the sha (`=`: it already did).
  if (flags.length !== 1) return fail("push_failed");
  return { ok: true, remoteBranch: remote, tip, pushed: flags[0] !== "=" };
}

/**
 * A refused push where origin's branch has moved on (a GitHub "Update branch", a bot's commit) and the local tip
 * is already part of it: nothing is unpushed, so the pass goes on, naming origin's tip, which is what the successor
 * resets to. Anything else is `push_rejected`: a branch holding other work, a rewrite, or one this cannot read (a
 * failed fetch, a timeout): never forced, never merged.
 */
async function containedInOrigin(path: string, remote: string, tip: string): Promise<PushBranchResponse> {
  if ((await fetchBranches(path, [remote])) !== "fetched") return fail("push_rejected");
  const origin = await resolve(path, `${REMOTES}${remote}`);
  if (origin === null) return fail("push_rejected");
  const contained = await hardenedGit(path, ["merge-base", "--is-ancestor", tip, origin]);
  if (contained.exitCode !== 0) return fail("push_rejected");
  return { ok: true, remoteBranch: remote, tip: origin, pushed: false };
}

/** One fetch of branches of `origin` into their tracking refs: `failed` is git's own refusal (a missing branch included), `unreachable` a refused call or a timeout. */
async function fetchBranches(path: string, branches: readonly string[]): Promise<"fetched" | "failed" | "unreachable"> {
  const fetched = await networkGit(
    path,
    [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "origin",
      ...branches.map((name) => `+${HEADS}${name}:${REMOTES}${name}`),
    ],
    FETCH_TIMEOUT_MS,
  );
  if ("refused" in fetched || fetched.timedOut) return "unreachable";
  return fetched.exitCode === 0 ? "fetched" : "failed";
}

/**
 * A branch with no upstream may push to the PR's head only when that head's origin tip is already part of the
 * local branch and not already part of the default branch: `yes`, `no` (it is not, it is, or origin has no such
 * branch), or `error` (git or the network failed). A branch the default already holds (a `develop` the worktree was
 * cut past) is no one task's work, and an open PR cannot have one as its head. The default branch is fetched with
 * it, so "already merged" is judged against what origin holds now, not as of the last reap; a clone whose
 * `origin/HEAD` names no default has nothing to refresh, so it is `error` rather than judged against a stale ref.
 */
async function adoptable(
  path: string,
  expected: string,
  defaultBranch: string | null,
): Promise<"yes" | "no" | "error"> {
  if (defaultBranch === null) return "error";
  const fetched = await fetchBranches(path, [expected, defaultBranch]);
  if (fetched === "unreachable") return "error";
  if (fetched === "failed") return (await absentOnOrigin(path, expected)) ? "no" : "error";
  const ancestor = await hardenedGit(path, ["merge-base", "--is-ancestor", `${REMOTES}${expected}`, "HEAD"]);
  if (ancestor.exitCode !== 0) return ancestor.exitCode === 1 ? "no" : "error";
  const merged = await hardenedGit(path, [
    "merge-base",
    "--is-ancestor",
    `${REMOTES}${expected}`,
    `${REMOTES}${defaultBranch}`,
  ]);
  if (merged.exitCode !== 0 && merged.exitCode !== 1) return "error";
  return merged.exitCode === 0 ? "no" : "yes";
}

/** A failed fetch is "no such branch" only when origin says so (`ls-remote --exit-code` answers 2); auth and network are not. */
async function absentOnOrigin(path: string, branch: string): Promise<boolean> {
  const listed = await networkGit(path, ["ls-remote", "--exit-code", "origin", `${HEADS}${branch}`], FETCH_TIMEOUT_MS);
  return !("refused" in listed) && !listed.timedOut && listed.exitCode === 2;
}
