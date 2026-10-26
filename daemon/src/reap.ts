import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RepoEntry } from "@seance/shared";
import type { ReapAudit } from "./audit.ts";
import { mapLimit } from "./concurrency.ts";
import { answerKeepWorktree } from "./despawn.ts";
import { owesExit } from "./exit-status.ts";
import type { FsmonitorDaemon, FsmonitorSeams } from "./fsmonitor.ts";
import { hardenedGit } from "./git-hardened.ts";
import { canonical, inspectCheckout } from "./gitdir.ts";
import { runDir } from "./paths.ts";
import {
  classifyTip,
  commitsAhead,
  deleteBranch,
  fetchIfStale,
  gitDirOf,
  isMerged,
  lastTouched,
  listBranches,
  listWorktrees,
  patchIndex,
  pendingChanges,
  pruneWorktrees,
  readPruneLog,
  removeWorktree,
  resolveRemoteHead,
  type BranchVerdict,
  type FetchOutcome,
  type Merged,
} from "./reap-git.ts";
import { readDefaultBranch } from "./scan.ts";
import { classifyPane, listPanes, paneInfo, type PaneState } from "./sessions.ts";
import { pidAlive, writeAtomic } from "./state.ts";
import { tmux } from "./tmux.ts";

/** Repos worked at once: each is a handful of git processes, and a fetch may sit on the network. */
const REPO_CONCURRENCY = 4;
const PANE_CONCURRENCY = 4;
/**
 * A dead pane younger than this may still be `spawnSession`'s: it holds a pane
 * with remain-on-exit while it waits to see claude register, and captures and
 * closes a dead one itself.
 */
const DEAD_PANE_MIN_AGE_MS = 60_000;
/** How long an answered exit prompt gets to turn into a closed window before reap reports it still open. */
const EXIT_WAIT_MS = 5_000;
/**
 * An fsmonitor daemon whose repo nothing has used for this long is stopped. Short,
 * unlike a worktree's days: stopping one destroys nothing, and costs only the
 * restart git makes when the repo is next used.
 */
export const MONITOR_IDLE_MS = 60 * 60 * 1000;
/** Each judged with a few `stat`s, stopped with one git process. */
const MONITOR_CONCURRENCY = 8;
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReapOptions {
  /** The daemon's scan set — the only repos reap touches. */
  readonly repos: readonly RepoEntry[];
  readonly dryRun: boolean;
  /** A worktree younger than this is kept, whatever else holds. */
  readonly minAgeMs: number;
  readonly audit: ReapAudit;
  /** The daemon's `harvestExits`: only the process owning the launch ledger can note a status, so the CLI passes none. */
  readonly harvest?: () => Promise<void>;
  readonly now?: number;
  /** Stops between repos — the daemon's stop() ends a scheduled run here. */
  readonly signal?: AbortSignal;
  readonly deadPaneMinAgeMs?: number;
  /**
   * Where reap records its prunes (`PruneLog`). Required, not defaulted to
   * `pruneLogPath()`: a test that forgot it would write the developer's real state dir.
   */
  readonly pruneLogPath: string;
  /**
   * `git fsmonitor--daemon` handling (`platformFsmonitor()`), null where git has
   * none. Required for the same reason as `pruneLogPath`: a test that forgot it
   * would signal the developer's own daemons.
   */
  readonly fsmonitor: FsmonitorSeams | null;
  readonly monitorIdleMs?: number;
}

export interface RepoReport {
  readonly repo: string;
  /** Why nothing was looked at; absent when the repo was reaped. */
  readonly skipped?: string;
  readonly fetch?: FetchOutcome;
  readonly removedWorktrees: readonly {
    readonly path: string;
    readonly branch: string | null;
    readonly why: Merged;
    readonly idleDays: number;
  }[];
  readonly deletedBranches: readonly { readonly name: string; readonly sha: string; readonly why: Merged }[];
  readonly pruned: readonly string[];
  readonly dirty: readonly { readonly path: string; readonly changes: number }[];
  /** Upstream gone, commits on it nowhere upstream: unpushed work, kept. */
  readonly keptBranches: readonly { readonly name: string; readonly ahead: number | null }[];
  /** Linked worktrees on unpushed work — upstream gone, or detached past the default branch. Kept. */
  readonly keptWorktrees: readonly {
    readonly path: string;
    readonly branch: string | null;
    readonly ahead: number | null;
  }[];
  /** Worktrees whose pane is open in tmux — someone is in them. */
  readonly inUse: readonly string[];
  readonly locked: readonly string[];
  /** Merged and clean, but touched more recently than the age gate. */
  readonly young: number;
  /** Unmerged worktrees on a branch whose upstream isn't gone (still tracked, or never pushed): in-flight work, counted only. */
  readonly active: number;
  readonly failed: readonly { readonly what: string; readonly detail: string }[];
}

export interface PaneNote {
  readonly paneId: string;
  readonly window: string;
}

/**
 * Why reap stopped an fsmonitor daemon: reap removed its worktree, the
 * directory is gone, it holds no repo any more, or it went unused for
 * `monitorIdleMs` with no tmux pane inside.
 */
export type MonitorReason = "removed" | "gone" | "no-repo" | "idle";

export interface StoppedMonitor {
  /** The directory it watched. */
  readonly path: string;
  /** Null for a `removed` one `stop` reached but lsof couldn't map. */
  readonly pid: number | null;
  readonly rssKb: number | null;
  /** `git fsmonitor--daemon stop` in its directory, or SIGTERM where there is no repo to ask through. */
  readonly how: "stop" | "signal";
  readonly why: MonitorReason;
}

/** The daemons reap left running, by why: with `stopped`, every daemon listed. */
export interface KeptMonitors {
  /** A tmux pane is inside its directory. */
  readonly inUse: number;
  /** Used within `monitorIdleMs`. */
  readonly recent: number;
  /** Its directory's `.git` couldn't be read. */
  readonly unreadable: number;
  /** Neither fd 4 nor its socket says what it watches. */
  readonly unmapped: number;
}

export interface ReapReport {
  readonly dryRun: boolean;
  readonly minAgeDays: number;
  readonly repos: readonly RepoReport[];
  readonly closedPanes: readonly (PaneNote & { readonly why: "dead" | "exit-prompt" })[];
  /** Séance windows left open, each with the id `seanced despawn` takes. */
  readonly openPanes: readonly (PaneNote & { readonly state: PaneState })[];
  readonly monitors: {
    readonly stopped: readonly StoppedMonitor[];
    readonly kept: KeptMonitors;
    readonly idleMs: number;
  };
}

export class ReapBusy extends Error {
  constructor(readonly pid: number) {
    super(`a reap is already running (pid ${pid})`);
    this.name = "ReapBusy";
  }
}

/**
 * One reap at a time per machine — the CLI and the daemon's schedule would
 * otherwise race on the same worktrees. Taken by `link`ing a file that already
 * holds the pid, so creating it is the test and no contender ever reads it
 * empty (an `O_EXCL` create then a write would read as a dead holder in
 * between, and be stolen); a file whose pid is gone is a crashed run's, and is
 * taken over.
 */
export async function withReapLock<T>(fn: () => Promise<T>, path: string = join(runDir(), "reap.lock")): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staged = `${path}.${process.pid}`;
  await writeFile(staged, String(process.pid), { mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one retry, after clearing a dead holder's file
        await link(staged, path);
        break;
      } catch (err) {
        if (!(err instanceof Error && "code" in err && err.code === "EEXIST") || attempt > 0) throw err;
      }
      // oxlint-disable-next-line no-await-in-loop
      const holder = Number((await readFile(path, "utf8").catch(() => "")).trim());
      if (holder > 0 && pidAlive(holder)) throw new ReapBusy(holder);
      // oxlint-disable-next-line no-await-in-loop
      await unlink(path).catch(() => {});
    }
  } finally {
    await unlink(staged).catch(() => {});
  }
  try {
    return await fn();
  } finally {
    await unlink(path).catch(() => {});
  }
}

function inside(dir: string, path: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Cleans up what remote sessions leave behind, in one pass: séance windows
 * that are dead or parked on the worktree exit prompt, then — per repo in the
 * scan set — linked worktrees whose branch is merged, clean and idle, then the
 * merged branches, a removed worktree's included. Everything it destroys is
 * audited; everything it keeps for a reason a human should see is reported.
 */
export async function runReap(opts: ReapOptions): Promise<ReapReport> {
  const now = opts.now ?? Date.now();
  if (!opts.dryRun) await opts.audit.start(opts.repos.length);
  // Exit statuses noted first: a dead task pane holding one is skipped below, so none would be closed at all.
  if (!opts.dryRun) await opts.harvest?.();

  // tmux first: answering an exit prompt lets claude leave its worktree, and
  // the pane check below then sees the cwd gone.
  const panes = await reapPanes(opts, now);
  const paneDirs = await Promise.all((await listPanes()).map((pane) => canonical(pane.path)));

  const { targets, refused } = await mainClones(opts.repos);
  const pruneLog = opts.dryRun ? {} : await readPruneLog(opts.pruneLogPath);
  const monitors = opts.fsmonitor === null ? null : await readMonitors(opts.fsmonitor);
  const reaped = await mapLimit(targets, REPO_CONCURRENCY, async ({ repo, commonDir }) =>
    opts.signal?.aborted === true
      ? skipped(repo.name, "stopped before reaching it")
      : reapRepo(repo, commonDir, opts, now, paneDirs, pruneLog[commonDir] ?? 0, monitors),
  );
  const repos = [...reaped, ...refused];
  // After the repos, so a worktree this run removed whose daemon `stop` missed is swept too.
  const kept = monitors === null ? NO_KEPT_MONITORS : await sweepMonitors(monitors, opts, now);

  if (!opts.dryRun) {
    const pruned = targets.filter((_, i) => reaped[i]?.fetch?.kind === "fetched");
    if (pruned.length > 0) {
      const next = { ...pruneLog, ...Object.fromEntries(pruned.map(({ commonDir }) => [commonDir, now])) };
      // Unwritten, the next run fetches again — never worth failing a run that already reaped.
      await writeAtomic(opts.pruneLogPath, next).catch(() => {});
    }
    await opts.audit.done({
      worktrees: repos.reduce((sum, repo) => sum + repo.removedWorktrees.length, 0),
      branches: repos.reduce((sum, repo) => sum + repo.deletedBranches.length, 0),
      panes: panes.closedPanes.length,
      monitors: monitors?.stopped.length ?? 0,
    });
  }
  return {
    dryRun: opts.dryRun,
    minAgeDays: opts.minAgeMs / DAY_MS,
    repos,
    ...panes,
    monitors: { stopped: monitors?.stopped ?? [], kept, idleMs: opts.monitorIdleMs ?? MONITOR_IDLE_MS },
  };
}

const NO_KEPT_MONITORS: KeptMonitors = { inUse: 0, recent: 0, unreadable: 0, unmapped: 0 };

/** The run's one read of this user's fsmonitor daemons, and what it stopped of them. */
interface Monitors {
  readonly seams: FsmonitorSeams;
  readonly daemons: readonly FsmonitorDaemon[];
  /** By canonical worktree, the form a worktree's `real` path is compared in. */
  readonly byWorktree: ReadonlyMap<string, FsmonitorDaemon>;
  readonly stopped: StoppedMonitor[];
}

async function readMonitors(seams: FsmonitorSeams): Promise<Monitors> {
  const daemons = await seams.list();
  const keyed = await Promise.all(
    daemons.flatMap((daemon) =>
      daemon.worktree === null ? [] : [canonical(daemon.worktree).then((dir) => [dir, daemon] as const)],
    ),
  );
  return { seams, daemons, byWorktree: new Map(keyed), stopped: [] };
}

/** Before the worktree is removed, which takes the socket `stop` reaches its daemon by. */
async function stopMonitor(monitors: Monitors, path: string, real: string, opts: ReapOptions): Promise<void> {
  const mapped = monitors.byWorktree.get(real);
  const stopped: StoppedMonitor = {
    path,
    pid: mapped?.pid ?? null,
    rssKb: mapped?.rssKb ?? null,
    how: "stop",
    why: "removed",
  };
  if (opts.dryRun) {
    if (mapped !== undefined) monitors.stopped.push(stopped);
    return;
  }
  // Asked even unmapped: git finds its own socket whatever lsof could see.
  if (!(await monitors.seams.stop(path))) return;
  monitors.stopped.push(stopped);
  await opts.audit.stoppedMonitor(path, stopped.pid, "stop", "removed");
}

type MonitorVerdict = Exclude<keyof KeptMonitors, "unmapped"> | { readonly why: Exclude<MonitorReason, "removed"> };

/**
 * Pane cwds, and the checkout each sits in. A pane uses the daemon of its own
 * checkout only: a session in `<repo>/.claude/worktrees/x` keeps that worktree's
 * daemon, not the main clone's around it.
 */
interface PaneCheckouts {
  readonly dirs: readonly string[];
  readonly roots: ReadonlySet<string | null>;
}

/** The nearest directory at or above `dir` holding a `.git`, as git's own discovery finds it. */
async function checkoutRoot(dir: string): Promise<string | null> {
  for (let current = dir; ; current = dirname(current)) {
    // oxlint-disable-next-line no-await-in-loop -- one stat per level, nearest first
    if ((await stat(join(current, ".git")).catch(() => null)) !== null) return current;
    if (dirname(current) === current) return null;
  }
}

async function mtimeOf(path: string): Promise<number> {
  return (await stat(path).catch(() => null))?.mtimeMs ?? 0;
}

/**
 * Whether a daemon's directory has a live session or recent use. A tmux pane
 * in its checkout keeps it whatever its age. Use is `lastTouched` — HEAD, index,
 * reflog, the root, Claude transcripts — and the daemon's cookie dir, which every
 * query moves: the daemon answers one by creating and deleting a cookie file
 * under `<git dir>/fsmonitor--daemon/cookies`. The git dir and the level between
 * are read too, in case a git version puts them higher.
 */
async function judgeMonitor(path: string, panes: PaneCheckouts, now: number, idleMs: number): Promise<MonitorVerdict> {
  const real = await canonical(path);
  if ((await stat(real).catch(() => null)) === null) return { why: "gone" };
  const checkout = await inspectCheckout(real);
  if (checkout.kind === "unreadable") return "unreadable";
  const repo = checkout.kind === "main" || checkout.kind === "linked";
  if (repo ? panes.roots.has(real) : panes.dirs.some((dir) => inside(real, dir))) return "inUse";
  // Its `.git` gone — a scratchpad left with only `.claude` — no git can ask it anything.
  if (!repo) return { why: "no-repo" };
  const cookies = [
    checkout.gitDir,
    join(checkout.gitDir, "fsmonitor--daemon"),
    join(checkout.gitDir, "fsmonitor--daemon", "cookies"),
  ];
  const touched = Math.max(
    await lastTouched(real, checkout.gitDir, [path]),
    ...(await Promise.all(cookies.map(mtimeOf))),
  );
  return now - touched < idleMs ? "recent" : { why: "idle" };
}

/**
 * Every daemon reap didn't stop with a removal, judged: one whose directory is
 * gone, holds no repo, or has gone unused for `monitorIdleMs` with no tmux pane
 * inside is stopped — `git fsmonitor--daemon stop` where there is a repo to ask
 * through, SIGTERM where there is none or that fails. Stopping costs one
 * restart, which git does unasked the next time the repo needs it. Unmapped
 * daemons are never touched: nothing says what they watch.
 */
async function sweepMonitors(monitors: Monitors, opts: ReapOptions, now: number): Promise<KeptMonitors> {
  // Read again: a pane opened during the run may now sit in one of these.
  const paneDirs = await Promise.all((await listPanes()).map((pane) => canonical(pane.path)));
  const panes = { dirs: paneDirs, roots: new Set(await Promise.all(paneDirs.map(checkoutRoot))) };
  const idleMs = opts.monitorIdleMs ?? MONITOR_IDLE_MS;
  const taken = new Set(monitors.stopped.map((stopped) => stopped.pid));
  const kept = { inUse: 0, recent: 0, unreadable: 0, unmapped: 0 };
  await mapLimit(monitors.daemons, MONITOR_CONCURRENCY, async (daemon) => {
    if (taken.has(daemon.pid)) return;
    if (daemon.worktree === null) {
      kept.unmapped += 1;
      return;
    }
    const verdict = await judgeMonitor(daemon.worktree, panes, now, idleMs);
    if (typeof verdict === "string") {
      kept[verdict] += 1;
      return;
    }
    const path = daemon.worktree;
    const askable = verdict.why === "idle";
    if (opts.dryRun) {
      const how = askable ? "stop" : "signal";
      monitors.stopped.push({ path, pid: daemon.pid, rssKb: daemon.rssKb, how, why: verdict.why });
      return;
    }
    let how: StoppedMonitor["how"] = "stop";
    if (!askable || !(await monitors.seams.stop(path))) {
      if (!monitors.seams.signal(daemon.pid)) return;
      how = "signal";
    }
    monitors.stopped.push({ path, pid: daemon.pid, rssKb: daemon.rssKb, how, why: verdict.why });
    await opts.audit.stoppedMonitor(path, daemon.pid, how, verdict.why);
  });
  return kept;
}

type PaneOutcome =
  | { readonly closed: PaneNote & { readonly why: "dead" | "exit-prompt" } }
  | { readonly open: PaneNote & { readonly state: PaneState } };

async function reapPanes(opts: ReapOptions, now: number): Promise<Pick<ReapReport, "closedPanes" | "openPanes">> {
  const deadMinAge = opts.deadPaneMinAgeMs ?? DEAD_PANE_MIN_AGE_MS;
  // Séance's own windows only: a hand-started pane is never reap's to close.
  const ours = (await listPanes()).filter((pane) => pane.ours);
  const outcomes = await mapLimit(ours, PANE_CONCURRENCY, async (pane): Promise<PaneOutcome | null> => {
    const note = { paneId: pane.paneId, window: pane.windowName };
    const state = await classifyPane(pane);
    if (state === "dead") {
      // No death time (an old tmux) can't be told from spawn's own pane: leave it. A task pane
      // holding an exit status is the daemon's to note first (`harvestExits`), or the status is lost.
      if (pane.deadAt === null || now - pane.deadAt < deadMinAge || owesExit(pane)) return { open: { ...note, state } };
      if (!opts.dryRun) {
        const killed = await tmux(["kill-pane", "-t", pane.paneId]);
        if (killed.exitCode !== 0) return { open: { ...note, state } };
        await opts.audit.closedPane(pane.paneId, pane.windowName, "dead");
      }
      return { closed: { ...note, why: "dead" } };
    }
    if (state !== "exit-prompt") return { open: { ...note, state } };
    if (opts.dryRun) return { closed: { ...note, why: "exit-prompt" } };
    // Looked at again right before the key: Enter on anything but the prompt
    // would send whatever draft that pane holds.
    const fresh = await paneInfo(pane.paneId);
    // Gone on its own: reap closed nothing, so it neither reports nor audits it.
    if (fresh === null) return null;
    const current = await classifyPane(fresh);
    if (current !== "exit-prompt") return { open: { ...note, state: current } };
    await answerKeepWorktree(pane.paneId);
    if (!(await exits(pane.paneId))) return { open: { ...note, state: "exit-prompt" } };
    await opts.audit.closedPane(pane.paneId, pane.windowName, "exit-prompt");
    return { closed: { ...note, why: "exit-prompt" } };
  });
  return {
    closedPanes: outcomes.flatMap((outcome) => (outcome !== null && "closed" in outcome ? [outcome.closed] : [])),
    openPanes: outcomes.flatMap((outcome) => (outcome !== null && "open" in outcome ? [outcome.open] : [])),
  };
}

/** Gone, or dead under a remain-on-exit someone set — claude left either way. */
async function exits(paneId: string): Promise<boolean> {
  const deadline = Date.now() + EXIT_WAIT_MS;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling
    const pane = await paneInfo(paneId);
    if (pane === null || pane.dead) return true;
    if (Date.now() >= deadline) return false;
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(100);
  }
}

type ListKey =
  | "removedWorktrees"
  | "deletedBranches"
  | "pruned"
  | "dirty"
  | "keptBranches"
  | "keptWorktrees"
  | "inUse"
  | "locked"
  | "failed";

/** A repo report's lists, appended to while that repo is reaped. */
type RepoLists = { -readonly [K in ListKey]: RepoReport[K][number][] };

function skipped(repo: string, why: string): RepoReport {
  return { ...emptyRepoReport(repo), skipped: why };
}

function emptyLists(): RepoLists {
  return {
    removedWorktrees: [],
    deletedBranches: [],
    pruned: [],
    dirty: [],
    keptBranches: [],
    keptWorktrees: [],
    inUse: [],
    locked: [],
    failed: [],
  };
}

function emptyRepoReport(repo: string): RepoReport {
  return { repo, ...emptyLists(), young: 0, active: 0 };
}

interface Target {
  readonly repo: RepoEntry;
  readonly commonDir: string;
}

/**
 * Main clones only, one per repository. The scan registers nothing else since
 * 2026-10-09, but a state.json an older daemon wrote still lists sibling
 * worktrees as repos of their own — and each would reap the same shared
 * branches over again. Those are named rather than silently dropped, since
 * they also say the daemon is due a restart.
 */
async function mainClones(
  repos: readonly RepoEntry[],
): Promise<{ readonly targets: readonly Target[]; readonly refused: readonly RepoReport[] }> {
  const checkouts = await mapLimit(repos, REPO_CONCURRENCY, async (repo) => ({
    repo,
    checkout: await inspectCheckout(repo.path),
  }));
  const seen = new Set<string>();
  const targets: Target[] = [];
  const refused: RepoReport[] = [];
  for (const { repo, checkout } of checkouts) {
    if (checkout.kind === "linked") {
      refused.push(
        skipped(repo.name, "a linked worktree, reaped with its main clone — the repo cache predates the scan fix"),
      );
      continue;
    }
    if (checkout.kind !== "main") {
      refused.push(skipped(repo.name, "not a readable git checkout any more"));
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one realpath per repo, in scan order so the first entry wins
    const commonDir = await canonical(checkout.commonDir);
    if (seen.has(commonDir)) {
      refused.push(skipped(repo.name, "the same repository as another entry"));
      continue;
    }
    seen.add(commonDir);
    targets.push({ repo, commonDir });
  }
  return { targets, refused };
}

async function reapRepo(
  repo: RepoEntry,
  commonDir: string,
  opts: ReapOptions,
  now: number,
  paneDirs: readonly string[],
  lastPrunedAt: number,
  monitors: Monitors | null,
): Promise<RepoReport> {
  // A dry run writes nothing, a fetch's refs included, so it judges by the refs on disk.
  const fetch = opts.dryRun ? undefined : await fetchIfStale(repo.path, lastPrunedAt, now);
  let defaultBranch = repo.defaultBranch;
  if (defaultBranch === null && !opts.dryRun && (await resolveRemoteHead(repo.path))) {
    defaultBranch = await readDefaultBranch(repo.path);
  }
  if (defaultBranch === null) {
    return {
      ...skipped(repo.name, "no origin/HEAD to measure merged against — git remote set-head origin --auto"),
      ...(fetch === undefined ? {} : { fetch }),
    };
  }
  const base = `refs/remotes/origin/${defaultBranch}`;
  const [baseTreeOut, worktrees, branches] = await Promise.all([
    hardenedGit(repo.path, ["rev-parse", "--verify", "--quiet", `${base}^{tree}`]),
    listWorktrees(repo.path),
    listBranches(repo.path),
  ]);
  if (baseTreeOut.exitCode !== 0) return skipped(repo.name, `${base} does not exist`);
  if (worktrees === null || branches === null)
    return skipped(repo.name, "git could not list its worktrees or branches");
  const baseTree = baseTreeOut.stdout.trim();

  const report = emptyLists();
  let young = 0;
  let active = 0;

  const byName = new Map(branches.map((branch) => [branch.name, branch]));
  const verdicts = new Map<string, BranchVerdict>();
  const patches = patchIndex(repo.path, base);
  const verdictFor = async (sha: string, branch: string | null): Promise<BranchVerdict> => {
    const key = `${sha} ${branch ?? ""}`;
    const cached = verdicts.get(key);
    if (cached !== undefined) return cached;
    const gone = branch === null ? false : (byName.get(branch)?.upstreamGone ?? false);
    const verdict = await classifyTip(repo.path, sha, base, baseTree, gone, patches);
    verdicts.set(key, verdict);
    return verdict;
  };

  // The main worktree comes first and is never a candidate.
  const linked = worktrees.slice(1);
  // By worktree, not branch name: a branch checked out twice (`worktree add
  // --force`) is still held by the worktree this pass keeps.
  const released = new Set<string>();
  const prunable = linked.filter((worktree) => worktree.prunable);
  for (const worktree of prunable) {
    report.pruned.push(worktree.path);
    released.add(worktree.path);
  }
  if (prunable.length > 0 && !opts.dryRun) {
    const pruned = await pruneWorktrees(repo.path);
    if (pruned.exitCode !== 0) report.failed.push({ what: "worktree prune", detail: pruned.stderr.trim() });
  }

  for (const worktree of linked.filter((candidate) => !candidate.prunable)) {
    if (worktree.locked) {
      report.locked.push(worktree.path);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one worktree at a time within a repo; repos run in parallel
    const real = await canonical(worktree.path);
    if (paneDirs.some((dir) => inside(real, dir))) {
      report.inUse.push(worktree.path);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop
    const verdict = await verdictFor(worktree.head, worktree.branch);
    if (!isMerged(verdict)) {
      // Checked-out branch is skipped by the branch pass, so this row is its only report; a detached tip is never
      // patch-checked (verdict active), listed here because no branch holds its commits.
      if (verdict === "unmerged-gone" || worktree.branch === null) {
        // oxlint-disable-next-line no-await-in-loop
        const ahead = await commitsAhead(repo.path, worktree.head, base);
        report.keptWorktrees.push({ path: worktree.path, branch: worktree.branch, ahead });
      } else {
        active += 1;
      }
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop
    const gitDir = await gitDirOf(worktree.path);
    if (gitDir === null) {
      report.failed.push({ what: `read ${worktree.path}`, detail: "git could not resolve its git dir" });
      continue;
    }
    // Before status, which would otherwise be what last touched it.
    // oxlint-disable-next-line no-await-in-loop
    const touched = await lastTouched(worktree.path, gitDir, [real]);
    if (now - touched < opts.minAgeMs) {
      young += 1;
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop
    const changes = await pendingChanges(worktree.path);
    if (changes === null) {
      report.failed.push({ what: `status ${worktree.path}`, detail: "git status failed" });
      continue;
    }
    if (changes > 0) {
      report.dirty.push({ path: worktree.path, changes });
      continue;
    }
    const idleDays = Math.floor((now - touched) / DAY_MS);
    // oxlint-disable-next-line no-await-in-loop
    if (monitors !== null) await stopMonitor(monitors, worktree.path, real, opts);
    if (!opts.dryRun) {
      // oxlint-disable-next-line no-await-in-loop
      const removed = await removeWorktree(repo.path, worktree.path);
      if (removed.exitCode !== 0) {
        report.failed.push({ what: `remove ${worktree.path}`, detail: removed.stderr.trim() });
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      await opts.audit.removedWorktree(repo.name, worktree.path, worktree.branch, worktree.head);
    }
    report.removedWorktrees.push({ path: worktree.path, branch: worktree.branch, why: verdict, idleDays });
    released.add(worktree.path);
  }

  // Whatever is still checked out stays — the main checkout's branch always.
  // Listed again rather than carried from the start: a worktree a spawn added
  // since then is in it, and its fresh branch, an ancestor of the default,
  // would otherwise read as merged and free. A dry run removed nothing, so it
  // takes the first list less what it would have.
  const current = opts.dryRun
    ? worktrees.filter((worktree) => !released.has(worktree.path))
    : await listWorktrees(repo.path);
  if (current === null) {
    report.failed.push({
      what: "worktree list",
      detail: "git could not list worktrees again before deleting branches",
    });
    return { repo: repo.name, ...(fetch === undefined ? {} : { fetch }), ...report, young, active };
  }
  const checkedOut = new Set(current.flatMap((worktree) => (worktree.branch === null ? [] : [worktree.branch])));
  for (const branch of branches) {
    if (branch.name === defaultBranch || checkedOut.has(branch.name)) continue;
    // oxlint-disable-next-line no-await-in-loop -- sequential within a repo
    const verdict = await verdictFor(branch.sha, branch.name);
    if (verdict === "unmerged-gone") {
      // oxlint-disable-next-line no-await-in-loop
      report.keptBranches.push({ name: branch.name, ahead: await commitsAhead(repo.path, branch.sha, base) });
      continue;
    }
    if (!isMerged(verdict)) continue;
    if (!opts.dryRun) {
      // oxlint-disable-next-line no-await-in-loop
      const deleted = await deleteBranch(repo.path, branch.name, branch.sha);
      if (deleted.exitCode !== 0) {
        report.failed.push({ what: `delete branch ${branch.name}`, detail: deleted.stderr.trim() });
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      await opts.audit.deletedBranch(repo.name, branch.name, branch.sha, verdict);
    }
    report.deletedBranches.push({ name: branch.name, sha: branch.sha, why: verdict });
  }

  return { repo: repo.name, ...(fetch === undefined ? {} : { fetch }), ...report, young, active };
}

function tilde(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function row(label: string, rest: string): string {
  return `  ${label.padEnd(18)} ${rest}`;
}

function megabytes(kb: number): string {
  return `${(kb / 1024).toFixed(1)} MB`;
}

function aheadText(ahead: number | null): string {
  return ahead === null
    ? "commits not on the default branch (count unavailable)"
    : `${plural(ahead, "commit")} not on the default branch`;
}

function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
}

/** What the CLI prints and a scheduled run logs, one line each. Repos with nothing to say are left out. */
export function formatReport(report: ReapReport): readonly string[] {
  const removed = report.dryRun ? "would remove" : "removed";
  const deleted = report.dryRun ? "would delete" : "deleted";
  const pruned = report.dryRun ? "would prune" : "pruned";
  const closed = report.dryRun ? "would close" : "closed";
  const stopped = report.dryRun ? "would stop" : "stopped";
  const lines: string[] = [];

  for (const repo of report.repos) {
    const rows: string[] = [];
    if (repo.skipped !== undefined) rows.push(row("skipped", repo.skipped));
    if (repo.fetch?.kind === "failed")
      rows.push(row("fetch failed", `${repo.fetch.detail} — judged by the refs on disk`));
    for (const worktree of repo.removedWorktrees) {
      const branch = worktree.branch ?? "detached";
      rows.push(
        row(`${removed} worktree`, `${tilde(worktree.path)}   ${branch} (${worktree.why}), idle ${worktree.idleDays}d`),
      );
    }
    for (const path of repo.pruned) rows.push(row(`${pruned} worktree`, `${tilde(path)}   its directory is gone`));
    for (const branch of repo.deletedBranches) {
      rows.push(row(`${deleted} branch`, `${branch.name}   ${branch.sha.slice(0, 12)}   ${branch.why}`));
    }
    for (const dirty of repo.dirty) {
      rows.push(row("dirty worktree", `${tilde(dirty.path)}   ${plural(dirty.changes, "change")} — kept`));
    }
    for (const kept of repo.keptBranches) {
      rows.push(row("kept branch", `${kept.name}   upstream gone, ${aheadText(kept.ahead)}`));
    }
    for (const kept of repo.keptWorktrees) {
      const why = kept.branch === null ? "detached" : `${kept.branch}   upstream gone`;
      rows.push(row("kept worktree", `${tilde(kept.path)}   ${why}, ${aheadText(kept.ahead)}`));
    }
    for (const path of repo.inUse) rows.push(row("in use", `${tilde(path)}   a tmux pane is inside it`));
    for (const path of repo.locked) rows.push(row("locked worktree", tilde(path)));
    for (const failure of repo.failed) rows.push(row("failed", `${failure.what}: ${failure.detail}`));
    if (rows.length > 0) lines.push(repo.repo, ...rows);
  }

  const paneRows = [
    ...report.closedPanes.map((pane) =>
      row(closed, `${pane.paneId} "${pane.window}"   ${pane.why === "dead" ? "dead" : "answered Keep worktree"}`),
    ),
    ...report.openPanes.map((pane) =>
      row(PANE_LABELS[pane.state], `${pane.paneId} "${pane.window}"   — seanced despawn ${pane.paneId}`),
    ),
  ];
  if (paneRows.length > 0) lines.push("sessions", ...paneRows);

  const { stopped: stoppedMonitors, kept, idleMs } = report.monitors;
  const monitorRows = stoppedMonitors.map((monitor) =>
    row(
      stopped,
      `${tilde(monitor.path)}   ${monitor.pid === null ? "" : `pid ${monitor.pid}, `}${MONITOR_LABELS[monitor.why]}${
        monitor.rssKb === null ? "" : `, ${megabytes(monitor.rssKb)}`
      }`,
    ),
  );
  const keptParts = [
    kept.inUse > 0 ? `${kept.inUse} with a tmux pane inside` : null,
    kept.recent > 0 ? `${kept.recent} used in the last ${Math.round(idleMs / 3_600_000)}h` : null,
    kept.unreadable > 0 ? `${kept.unreadable} whose .git couldn't be read` : null,
    kept.unmapped > 0 ? `${kept.unmapped} whose directory lsof didn't say` : null,
  ].filter((part) => part !== null);
  const keptTotal = kept.inUse + kept.recent + kept.unreadable + kept.unmapped;
  if (keptTotal > 0) monitorRows.push(row("left running", `${plural(keptTotal, "daemon")}: ${keptParts.join(", ")}`));
  if (monitorRows.length > 0) lines.push("fsmonitor daemons", ...monitorRows);

  const sum = (pick: (repo: RepoReport) => number): number =>
    report.repos.reduce((total, repo) => total + pick(repo), 0);
  lines.push(
    [
      `${removed} ${plural(
        sum((repo) => repo.removedWorktrees.length),
        "worktree",
      )}`,
      `${deleted} ${plural(
        sum((repo) => repo.deletedBranches.length),
        "branch",
        "branches",
      )}`,
      `${closed} ${plural(report.closedPanes.length, "window")}`,
      // Only where there were any: a git without the daemon has nothing to say.
      ...(report.monitors.stopped.length === 0
        ? []
        : [
            `${stopped} ${plural(report.monitors.stopped.length, "fsmonitor daemon")} (${megabytes(
              report.monitors.stopped.reduce((total, monitor) => total + (monitor.rssKb ?? 0), 0),
            )})`,
          ]),
      `${sum((repo) => repo.dirty.length)} dirty`,
      plural(
        sum((repo) => repo.keptWorktrees.length),
        "kept worktree",
      ),
      `${sum((repo) => repo.active)} active`,
      `${plural(report.openPanes.length, "session")} left open`,
      `${sum((repo) => repo.young)} younger than ${report.minAgeDays}d`,
    ].join(" · "),
  );
  return lines;
}

const MONITOR_LABELS: Readonly<Record<MonitorReason, string>> = {
  removed: "before removing it",
  gone: "its directory is gone",
  "no-repo": "no repo there any more",
  idle: "unused, no tmux pane inside",
};

const PANE_LABELS: Readonly<Record<PaneState, string>> = {
  dead: "dead",
  shell: "shell",
  starting: "starting",
  "exit-prompt": "on exit prompt",
  "background-prompt": "background work",
  live: "live",
};
