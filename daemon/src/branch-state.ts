import { BRANCH_MAX_LENGTH, type BranchState, type RepoEntry } from "@seance/shared";
import { mapLimit } from "./concurrency.ts";
import { canonical, inspectCheckout } from "./gitdir.ts";
import type { LaunchLedger, NotedTask } from "./launch-ledger.ts";
import { log } from "./log.ts";
import {
  classifyTip,
  fetchIfStale,
  isMerged,
  patchIndex,
  reapGit,
  type FetchOutcome,
  type PatchIndex,
} from "./reap-git.ts";

/**
 * Watches every task branch this daemon launched in worktree mode and tells the
 * scheduler when its name, pushed state or merged state changes (DESIGN.md,
 * "Branch state"). Local git reads each pass; the network only for a repo that
 * holds a pushed, unmerged task branch. Imported by `run.ts` alone — it logs, so
 * nothing `seanced mcp` reaches may import it.
 *
 * Never logs a branch name or a path: the repo name and the failure only.
 */
export const BRANCH_CHECK_INTERVAL_MS = 60_000;
export const BRANCH_FETCH_STALE_MS = 5 * 60_000;
const FETCH_BACKOFF_MAX_MS = 3_600_000;
const GROUP_CONCURRENCY = 4;

export interface BranchStateDeps {
  readonly ledger: Pick<LaunchLedger, "notes" | "note">;
  readonly repos: () => readonly RepoEntry[];
  /** False when the state was not delivered (no relay connection); the in-process leader path is always true. */
  readonly emit: (state: BranchState) => Promise<boolean>;
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly fetchStaleMs?: number;
  /** A seam for tests to count fetches; reap's guarded fetch otherwise. */
  readonly fetch?: typeof fetchIfStale;
}

export interface BranchStates {
  /** Waits for a pass in flight, then runs a fresh one. */
  readonly check: () => Promise<void>;
  readonly stop: () => void;
}

interface RepoContext {
  readonly repo: RepoEntry;
  readonly commonDir: string;
  /** Null when the repo has no `origin/<default>` on disk: nothing can be judged merged, or own work. */
  readonly base: {
    readonly ref: string;
    readonly sha: string;
    readonly tree: string;
    readonly patches: PatchIndex;
  } | null;
}

interface Refs {
  readonly local?: string;
  readonly remote?: string;
}

async function isAncestor(cwd: string, ancestor: string, of: string): Promise<boolean | null> {
  const result = await reapGit(cwd, ["merge-base", "--is-ancestor", ancestor, of]);
  if (result.exitCode === 0) return true;
  return result.exitCode === 1 ? false : null;
}

/** `for-each-ref` matches prefixes, so a sibling branch (`b-2` for `b`) is filtered out by exact refname. */
async function readRefs(repoPath: string, branch: string): Promise<Refs | null> {
  const local = `refs/heads/${branch}`;
  const remote = `refs/remotes/origin/${branch}`;
  const result = await reapGit(repoPath, ["for-each-ref", "--format=%(refname)%00%(objectname)", local, remote]);
  if (result.exitCode !== 0) return null;
  let localSha: string | undefined;
  let remoteSha: string | undefined;
  for (const line of result.stdout.split("\n")) {
    const [name, sha] = line.split("\0");
    if (sha === undefined || sha === "") continue;
    if (name === local) localSha = sha;
    if (name === remote) remoteSha = sha;
  }
  return {
    ...(localSha === undefined ? {} : { local: localSha }),
    ...(remoteSha === undefined ? {} : { remote: remoteSha }),
  };
}

/**
 * The branch a task's worktree has checked out now, so a rename shows up. The
 * last-seen one only when the worktree no longer belongs to the repo. `-C` with
 * the main clone as cwd: `Bun.spawn` throws on a cwd that is gone.
 */
async function liveBranch(ctx: RepoContext, note: NotedTask, owner: boolean): Promise<string | undefined> {
  if (!owner || note.path === undefined) return note.branch;
  const checkout = await inspectCheckout(note.path);
  if (checkout.kind !== "linked" || (await canonical(checkout.commonDir)) !== ctx.commonDir) return note.branch;
  const head = await reapGit(ctx.repo.path, ["-C", note.path, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  return head.exitCode === 0 ? head.stdout.trim() : undefined;
}

async function repoBase(repo: RepoEntry): Promise<RepoContext["base"]> {
  if (repo.defaultBranch === null) return null;
  const ref = `refs/remotes/origin/${repo.defaultBranch}`;
  const [sha, tree] = await Promise.all([
    reapGit(repo.path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]),
    reapGit(repo.path, ["rev-parse", "--verify", "--quiet", `${ref}^{tree}`]),
  ]);
  if (sha.exitCode !== 0 || tree.exitCode !== 0) return null;
  return { ref, sha: sha.stdout.trim(), tree: tree.stdout.trim(), patches: patchIndex(repo.path, ref) };
}

export function createBranchStates(deps: BranchStateDeps): BranchStates {
  const now = deps.now ?? Date.now;
  const fetchStaleMs = deps.fetchStaleMs ?? BRANCH_FETCH_STALE_MS;
  const fetchRepo = deps.fetch ?? fetchIfStale;
  let stopped = false;
  /** Undelivered, newest per task: re-sent at the start of each pass. Lost with the process; `progress` recovers it. */
  const pending = new Map<string, BranchState>();
  /** Per repo: consecutive failed fetches and when the next may run (`FETCH_HEAD` does not move on a failure). */
  const fetchBackoff = new Map<string, { failures: number; nextAt: number }>();
  /** Repos whose last pass threw, so a run of failures warns once. */
  const failing = new Set<string>();
  /** Latest verdict per task, keyed by every input: an idle branch costs no `classifyTip` per pass. */
  const verdicts = new Map<string, { key: string; merged: boolean }>();

  const send = async (state: BranchState): Promise<void> => {
    if (stopped) return;
    let delivered = false;
    try {
      delivered = await deps.emit(state);
    } catch {
      // Kept for the next pass, like a false.
    }
    if (delivered) pending.delete(state.taskId);
    else pending.set(state.taskId, state);
  };

  const fetchFor = async (repo: RepoEntry, commonDir: string): Promise<void> => {
    const backoff = fetchBackoff.get(repo.path);
    if (backoff !== undefined && now() < backoff.nextAt) return;
    // Git Credential Manager ignores GIT_TERMINAL_PROMPT and may raise a GUI on WSL/Windows.
    const env = process.env["GCM_INTERACTIVE"] === undefined ? { GCM_INTERACTIVE: "never" } : undefined;
    const outcome: FetchOutcome = await fetchRepo(repo.path, commonDir, now(), fetchStaleMs, env);
    if (outcome.kind !== "failed") {
      fetchBackoff.delete(repo.path);
      return;
    }
    const failures = (backoff?.failures ?? 0) + 1;
    const base = Math.max(fetchStaleMs, BRANCH_FETCH_STALE_MS);
    fetchBackoff.set(repo.path, {
      failures,
      nextAt: now() + Math.min(base * 2 ** Math.min(failures - 1, 16), FETCH_BACKOFF_MAX_MS),
    });
    if (failures === 1) log.warn(`branch state: fetch failed in ${repo.name} (${outcome.detail})`);
  };

  const checkTask = async (ctx: RepoContext, note: NotedTask, owner: boolean): Promise<void> => {
    const branch = await liveBranch(ctx, note, owner);
    if (branch === undefined || branch === "" || branch.length > BRANCH_MAX_LENGTH) return;

    const refs = await readRefs(ctx.repo.path, branch);
    if (refs === null) return;
    // The branch can be deleted (claude's worktree-exit) before its PR merges; the commit outlives the ref until gc.
    let tip = refs.local;
    if (tip === undefined && note.tip !== undefined && branch === note.branch) {
      const kept = await reapGit(ctx.repo.path, ["cat-file", "-e", `${note.tip}^{commit}`]);
      if (kept.exitCode === 0) tip = note.tip;
    }
    if (tip === undefined) return;

    // Own work gates both pushed and merged: a fresh branch is an ancestor of the default and an empty "squash",
    // and may reuse the name of a stale remote ref from an earlier attempt. Sticky once seen.
    const liveAhead = ctx.base !== null && (await isAncestor(ctx.repo.path, tip, ctx.base.sha)) === false;
    const ahead = note.ahead === true || liveAhead;
    // Without an origin/HEAD nothing can be judged ahead: pushed is then reported on the remote ref alone, merged never.
    const mayPush = ahead || ctx.base === null;
    const livePushed =
      mayPush &&
      refs.remote !== undefined &&
      (refs.remote === tip || (await isAncestor(ctx.repo.path, tip, refs.remote)) === true);

    let merged = false;
    const evidence = note.pushed === true || livePushed || note.prUrl !== undefined;
    if (ctx.base !== null && ahead && evidence && (note.branch === undefined || branch === note.branch)) {
      // Tracked upstreams are meaningless under --no-track: "gone" is a remote ref that was seen and has been pruned.
      const gone = (note.pushed === true || note.prUrl !== undefined) && refs.remote === undefined;
      const key = `${tip} ${ctx.base.sha} ${refs.remote ?? "-"} ${gone}`;
      const known = verdicts.get(note.taskId);
      if (known?.key === key) merged = known.merged;
      else {
        const verdict = await classifyTip(ctx.repo.path, tip, ctx.base.ref, ctx.base.tree, gone, ctx.base.patches);
        merged = isMerged(verdict);
        verdicts.set(note.taskId, { key, merged });
      }
    }

    const reportable = branch !== note.branch || (livePushed && note.pushed !== true) || merged;
    const recordable = reportable || (liveAhead && note.ahead !== true) || (ahead && tip !== note.tip);
    if (!recordable || stopped) return;
    await deps.ledger.note(note.taskId, {
      branch,
      tip,
      ...(ahead ? { ahead: true } : {}),
      ...(livePushed ? { pushed: true } : {}),
      ...(merged ? { merged: true } : {}),
    });
    const origin = ctx.repo.origin;
    if (!reportable || stopped || origin === undefined || origin === "" || origin.length > 512) return;
    await send({ taskId: note.taskId, repo: origin, branch, pushed: livePushed, merged, at: now() });
  };

  const checkRepo = async (
    repo: RepoEntry,
    tasks: readonly NotedTask[],
    owners: ReadonlyMap<string, string>,
  ): Promise<void> => {
    const checkout = await inspectCheckout(repo.path);
    if (checkout.kind !== "main") return;
    const commonDir = await canonical(checkout.commonDir);
    if (tasks.some((task) => task.ahead === true && (task.pushed === true || task.prUrl !== undefined))) {
      await fetchFor(repo, commonDir);
    }
    // After the fetch, which may have moved origin.
    const judged: RepoContext = { repo, commonDir, base: await repoBase(repo) };
    for (const task of tasks) {
      if (stopped) return;
      // oxlint-disable-next-line no-await-in-loop -- one task at a time within a repo; repos run in parallel
      await checkTask(judged, task, task.path !== undefined && owners.get(task.path) === task.taskId);
    }
  };

  const pass = async (): Promise<void> => {
    if (stopped) return;
    for (const state of [...pending.values()]) {
      if (stopped) return;
      // oxlint-disable-next-line no-await-in-loop -- in order, each one's delivery decides its own retry
      await send({ ...state, at: now() });
    }
    const tracked = deps.ledger
      .notes()
      .filter((note) => note.path !== undefined && note.repo !== undefined && note.merged !== true);
    for (const id of verdicts.keys()) if (!tracked.some((note) => note.taskId === id)) verdicts.delete(id);
    // A freed worktree name can be reused by a newer spawn: the newest launch owns the live read of a path.
    const owners = new Map<string, string>();
    for (const note of tracked) if (note.path !== undefined) owners.set(note.path, note.taskId);
    const groups = new Map<string, NotedTask[]>();
    for (const note of tracked) {
      if (note.repo === undefined) continue;
      groups.set(note.repo, [...(groups.get(note.repo) ?? []), note]);
    }
    const repos = deps.repos();
    await mapLimit([...groups], GROUP_CONCURRENCY, async ([path, tasks]) => {
      const repo = repos.find((entry) => entry.path === path);
      if (repo === undefined) return;
      try {
        await checkRepo(repo, tasks, owners);
        failing.delete(path);
      } catch (err) {
        if (failing.has(path)) return;
        failing.add(path);
        const code = err instanceof Error && "code" in err ? String(err.code) : "error";
        log.warn(`branch state: could not check ${repo.name} (${code})`);
      }
    });
  };

  let queue: Promise<void> = Promise.resolve();
  let waiting = 0;
  const check = (): Promise<void> => {
    waiting += 1;
    const run = queue.then(pass).finally(() => {
      waiting -= 1;
    });
    queue = run.catch(() => {});
    return run;
  };
  const checkQuietly = (): void => {
    check().catch((err: unknown) => {
      log.warn(`branch state: a pass failed (${String(err)})`);
    });
  };

  checkQuietly();
  const timer = setInterval(() => {
    if (waiting === 0) checkQuietly();
  }, deps.intervalMs ?? BRANCH_CHECK_INTERVAL_MS);
  timer.unref();

  return {
    check,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
