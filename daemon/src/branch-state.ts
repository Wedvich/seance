import { BRANCH_MAX_LENGTH, type BranchState, type RepoEntry } from "@seance/shared";
import { mapLimit } from "./concurrency.ts";
import { hardenedGit } from "./git-hardened.ts";
import { canonical, inspectCheckout } from "./gitdir.ts";
import type { LaunchLedger, NotedTask } from "./launch-ledger.ts";
import { log } from "./log.ts";
import { classifyTip, fetchIfStale, isMerged, patchIndex, type FetchOutcome, type PatchIndex } from "./reap-git.ts";

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
  const result = await hardenedGit(cwd, ["merge-base", "--is-ancestor", ancestor, of]);
  if (result.exitCode === 0) return true;
  return result.exitCode === 1 ? false : null;
}

/**
 * Own work: a tip the default branch does not already contain, whose tree differs from the one it forked at.
 * An empty commit or a revert of the branch's only change has no net change, and `classifyTip` reads it as
 * an empty "squash" of the default. A git failure reads as no work, the safe direction.
 */
async function holdsOwnWork(repoPath: string, tip: string, base: string): Promise<boolean> {
  if ((await isAncestor(repoPath, tip, base)) !== false) return false;
  const fork = await hardenedGit(repoPath, ["merge-base", tip, base]);
  const forkSha = fork.stdout.trim();
  if (fork.exitCode !== 0 || forkSha === "") return false;
  const trees = await hardenedGit(repoPath, ["rev-parse", `${tip}^{tree}`, `${forkSha}^{tree}`]);
  if (trees.exitCode !== 0) return false;
  const [tipTree, forkTree] = trees.stdout.split("\n");
  return tipTree !== undefined && tipTree !== "" && tipTree !== forkTree;
}

const HEADS = "refs/heads/";

/** `for-each-ref` matches prefixes, so a sibling branch (`b-2` for `b`) is filtered out by exact refname. */
async function readRefs(repoPath: string, branch: string): Promise<Refs | null> {
  const local = `${HEADS}${branch}`;
  const remote = `refs/remotes/origin/${branch}`;
  const result = await hardenedGit(repoPath, ["for-each-ref", "--format=%(refname)%00%(objectname)", local, remote]);
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
  // Not `--short`: with a tag of the same name it prints `heads/<branch>`.
  const head = await hardenedGit(ctx.repo.path, ["-C", note.path, "symbolic-ref", "--quiet", "HEAD"]);
  const ref = head.stdout.trim();
  return head.exitCode === 0 && ref.startsWith(HEADS) ? ref.slice(HEADS.length) : undefined;
}

async function repoBase(repo: RepoEntry): Promise<RepoContext["base"]> {
  if (repo.defaultBranch === null) return null;
  const ref = `refs/remotes/origin/${repo.defaultBranch}`;
  const [sha, tree] = await Promise.all([
    hardenedGit(repo.path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]),
    hardenedGit(repo.path, ["rev-parse", "--verify", "--quiet", `${ref}^{tree}`]),
  ]);
  if (sha.exitCode !== 0 || tree.exitCode !== 0) return null;
  // The sha, not the ref: the ref can move mid-pass, and a verdict and its memo key must be one snapshot.
  const commit = sha.stdout.trim();
  return { sha: commit, tree: tree.stdout.trim(), patches: patchIndex(repo.path, commit) };
}

/**
 * Undelivered states, newest per task, per ledger: `endedTasksFor` keeps one
 * ledger per file per process, so a stopped emitter's backlog reaches the one
 * that replaces it. Lost with the process; `progress` recovers it. Dropped once
 * its task is gone or relaunched (the note's `siteAt` moved).
 */
/** `siteAt`: the launch it was computed under; a relaunch of the id makes it stale. */
interface Pending {
  readonly state: BranchState;
  readonly siteAt: number | undefined;
}

const pendingByLedger = new WeakMap<object, Map<string, Pending>>();

function pendingFor(ledger: object): Map<string, Pending> {
  const known = pendingByLedger.get(ledger);
  if (known !== undefined) return known;
  const made = new Map<string, Pending>();
  pendingByLedger.set(ledger, made);
  return made;
}

export function createBranchStates(deps: BranchStateDeps): BranchStates {
  const now = deps.now ?? Date.now;
  const fetchStaleMs = deps.fetchStaleMs ?? BRANCH_FETCH_STALE_MS;
  const fetchRepo = deps.fetch ?? fetchIfStale;
  let stopped = false;
  /** Re-sent at the start of each pass. */
  const pending = pendingFor(deps.ledger);
  /** Per repo: consecutive failed fetches and when the next may run (a failure does not move `lastPruned`). */
  const fetchBackoff = new Map<string, { failures: number; nextAt: number }>();
  /**
   * Per common dir: this emitter's last successful `fetch --prune`. Not `FETCH_HEAD`'s mtime — every worktree
   * spawn refreshes that with a one-branch fetch that prunes nothing, so a busy repo would never fetch here.
   */
  const lastPruned = new Map<string, number>();
  /** Repos whose last pass threw, so a run of failures warns once. */
  const failing = new Set<string>();
  /** Latest verdict per task, keyed by every input: an idle branch costs no `classifyTip` per pass. */
  const verdicts = new Map<string, { key: string; merged: boolean }>();
  /** Whether a tip holds own work, per task and tip + default sha: it is up to three git runs. */
  const ownWork = new Map<string, { key: string; own: boolean }>();

  const send = async (state: BranchState, siteAt: number | undefined): Promise<void> => {
    // Noted already, so the state is kept for whichever emitter replaces this one.
    if (stopped) {
      pending.set(state.taskId, { state, siteAt });
      return;
    }
    let delivered = false;
    try {
      delivered = await deps.emit(state);
    } catch {
      // Kept for the next pass, like a false.
    }
    if (delivered) pending.delete(state.taskId);
    else pending.set(state.taskId, { state, siteAt });
  };

  const fetchFor = async (repo: RepoEntry, commonDir: string): Promise<void> => {
    const backoff = fetchBackoff.get(repo.path);
    if (backoff !== undefined && now() < backoff.nextAt) return;
    // Git Credential Manager ignores GIT_TERMINAL_PROMPT and may raise a GUI on WSL/Windows.
    const env = process.env["GCM_INTERACTIVE"] === undefined ? { GCM_INTERACTIVE: "never" } : undefined;
    const outcome: FetchOutcome = await fetchRepo(repo.path, lastPruned.get(commonDir) ?? 0, now(), fetchStaleMs, env);
    if (outcome.kind === "fetched") lastPruned.set(commonDir, now());
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
    if (failures === 1) log.warn(`branch state: fetch failed in ${repo.name} (${outcome.brief})`);
  };

  const ownsWork = async (repoPath: string, taskId: string, tip: string, baseSha: string): Promise<boolean> => {
    const key = `${tip} ${baseSha}`;
    const known = ownWork.get(taskId);
    if (known?.key === key) return known.own;
    const own = await holdsOwnWork(repoPath, tip, baseSha);
    ownWork.set(taskId, { key, own });
    return own;
  };

  const checkTask = async (ctx: RepoContext, note: NotedTask, owner: boolean): Promise<void> => {
    const branch = await liveBranch(ctx, note, owner);
    if (branch === undefined || branch === "" || branch.length > BRANCH_MAX_LENGTH) return;

    const refs = await readRefs(ctx.repo.path, branch);
    if (refs === null) return;
    // The branch can be deleted (claude's worktree-exit) before its PR merges; the commit outlives the ref until gc.
    // A non-owner's name now belongs to a newer launch (a freed worktree name frees its branch too): that local ref is
    // not this task's, so it is judged by its recorded tip alone.
    // Even the owner's local ref must be the recorded work or grow from it: a branch of the same name made by
    // something else once the task's own was removed (a spawn with no task id) is a stranger's, and would
    // overwrite the recorded tip and read the stranger's merge as this task's.
    let tip: string | undefined;
    if (owner && refs.local !== undefined) {
      const grown =
        note.tip === undefined ||
        refs.local === note.tip ||
        (await isAncestor(ctx.repo.path, note.tip, refs.local)) === true;
      if (grown) tip = refs.local;
    }
    if (tip === undefined && note.tip !== undefined && branch === note.branch) {
      const kept = await hardenedGit(ctx.repo.path, ["cat-file", "-e", `${note.tip}^{commit}`]);
      if (kept.exitCode === 0) tip = note.tip;
    }
    if (tip === undefined) return;

    // Own work (`holdsOwnWork`) gates both pushed and merged: a fresh branch is an ancestor of the default and an
    // empty "squash", as is a pushed empty commit, and it may reuse the name of a stale remote ref from an earlier
    // attempt. `ahead` is sticky once seen.
    const liveAhead = ctx.base !== null && (await ownsWork(ctx.repo.path, note.taskId, tip, ctx.base.sha));
    const ahead = note.ahead === true || liveAhead;
    // What the verdicts are about: the tip while it holds own work, else the last tip that did (recorded only while
    // ahead) — a branch reset to main, or whose work was reverted, has none left to call merged. Without an
    // origin/HEAD nothing can be judged ahead, so the tip stands in and only pushed is reported, on an exact match.
    // That pushed cannot make a merged by itself: merged needs a recorded own-work tip, which only a pass with a
    // default branch writes (`liveAhead`), and the verdict needs `ctx.base`.
    const workTip = ctx.base === null || liveAhead ? tip : note.tip;
    const livePushed =
      workTip !== undefined &&
      refs.remote !== undefined &&
      (refs.remote === workTip ||
        (ctx.base !== null && (await isAncestor(ctx.repo.path, workTip, refs.remote)) === true));

    let merged = false;
    const evidence = note.pushed === true || livePushed || note.prUrl !== undefined;
    if (
      ctx.base !== null &&
      workTip !== undefined &&
      evidence &&
      (note.branch === undefined || branch === note.branch)
    ) {
      // Tracked upstreams are meaningless under --no-track: "gone" is a remote ref that was seen and has been pruned.
      const gone = (note.pushed === true || note.prUrl !== undefined) && refs.remote === undefined;
      const key = `${workTip} ${ctx.base.sha} ${refs.remote ?? "-"} ${gone}`;
      const known = verdicts.get(note.taskId);
      if (known?.key === key) merged = known.merged;
      else {
        const verdict = await classifyTip(ctx.repo.path, workTip, ctx.base.sha, ctx.base.tree, gone, ctx.base.patches);
        merged = isMerged(verdict);
        verdicts.set(note.taskId, { key, merged });
      }
    }

    const reportable = branch !== note.branch || (livePushed && note.pushed !== true) || merged;
    const recordable = reportable || (liveAhead && (note.ahead !== true || tip !== note.tip));
    if (!recordable || stopped) return;
    const applied = await deps.ledger.note(
      note.taskId,
      {
        branch,
        // Only a tip with own work: it is what a later pass judges once the local branch is reset or gone.
        ...(liveAhead ? { tip } : {}),
        ...(ahead ? { ahead: true } : {}),
        ...(livePushed ? { pushed: true } : {}),
        ...(merged ? { merged: true } : {}),
      },
      // A relaunch that landed mid-pass owns the note now; this pass judged the old launch.
      { siteAt: note.siteAt },
    );
    if (!applied) return;
    const origin = ctx.repo.origin;
    if (!reportable || origin === undefined || origin === "" || origin.length > 512) return;
    // Past a stop `send` keeps it: the note is written, so no later pass would report it again.
    await send({ taskId: note.taskId, repo: origin, branch, pushed: livePushed, merged, at: now() }, note.siteAt);
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
    const noted = deps.ledger.notes();
    // A retracted or evicted task has nothing left to report, nor has a relaunched one for its earlier launch.
    for (const [id, entry] of pending) {
      const current = noted.find((note) => note.taskId === id);
      if (current === undefined || current.siteAt !== entry.siteAt) pending.delete(id);
    }
    // Each with the time it was observed, not the retry's.
    for (const entry of [...pending.values()]) {
      if (stopped) return;
      // oxlint-disable-next-line no-await-in-loop -- in order, each one's delivery decides its own retry
      await send(entry.state, entry.siteAt);
    }
    const tracked = noted.filter((note) => note.path !== undefined && note.repo !== undefined && note.merged !== true);
    for (const id of verdicts.keys()) if (!tracked.some((note) => note.taskId === id)) verdicts.delete(id);
    for (const id of ownWork.keys()) if (!tracked.some((note) => note.taskId === id)) ownWork.delete(id);
    // A freed worktree name can be reused by a newer spawn: the newest site owns the live read of a path, a merged
    // one included, or its older namesake would read the newer one's branch. By when the site was set, not ledger
    // order: a failed re-dispatch of an old id re-records it at the end. A tie goes to the later in the ledger.
    const newest = new Map<string, NotedTask>();
    for (const note of noted) {
      if (note.path === undefined) continue;
      const held = newest.get(note.path);
      if (held === undefined || (note.siteAt ?? 0) >= (held.siteAt ?? 0)) newest.set(note.path, note);
    }
    const owners = new Map([...newest].map(([path, note]) => [path, note.taskId]));
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
