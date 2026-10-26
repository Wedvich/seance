import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoEntry } from "@seance/shared";
import { reapAudit, type AuditSink } from "../src/audit.ts";
import { exec } from "../src/exec.ts";
import { tmuxHarvestPanes } from "../src/exit-status.ts";
import type { FsmonitorDaemon, FsmonitorSeams } from "../src/fsmonitor.ts";
import { resolveCommonDir } from "../src/gitdir.ts";
import { LaunchLedger } from "../src/launch-ledger.ts";
import {
  DAY_MS,
  formatReport,
  ReapBusy,
  runReap,
  withReapLock,
  type ReapOptions,
  type ReapReport,
} from "../src/reap.ts";
import { transcriptDir } from "../src/reap-git.ts";
import { scanRepos } from "../src/scan.ts";
import { classifyPane, listPanes } from "../src/sessions.ts";
import { EndedTasks } from "../src/session-events.ts";
import { resolveTargetSession, TASK_OPTION, tmuxOk } from "../src/tmux.ts";
import {
  addWorktree,
  makeClaudeStub,
  makeGitFixture,
  pollUntil,
  DEATH_STAMP_TEST_TIMEOUT_MS,
  untilDeathStamped,
  usePrivateTmux,
  type ClaudeStub,
  type GitFixture,
  type PrivateTmux,
} from "./fixtures.ts";

const GIT_ID = ["-c", "user.email=test@seance.local", "-c", "user.name=Seance Test"];
const WEEK = 7 * DAY_MS;

let base: string;
let privateTmux: PrivateTmux | undefined;
let stub: ClaudeStub;
let session: string;
let fixtures = 0;
const lines: string[] = [];
const collect: AuditSink = (line) => void lines.push(line);

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-reap-"));
  // No machine config may reach these repos: reap runs whatever git is configured to.
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "claude");
  privateTmux = usePrivateTmux(base, "reap");
  stub = await makeClaudeStub(base);
  session = await resolveTargetSession("main");
});

afterAll(async () => {
  await privateTmux?.dispose();
  delete process.env["GIT_CONFIG_GLOBAL"];
  delete process.env["GIT_CONFIG_NOSYSTEM"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  await rm(base, { recursive: true, force: true });
});

beforeEach(() => {
  lines.length = 0;
});

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const result = await exec(["git", ...GIT_ID, ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function gitOk(cwd: string, ...args: readonly string[]): Promise<boolean> {
  return (await exec(["git", ...args], { cwd })).exitCode === 0;
}

interface Repo {
  readonly fixture: GitFixture;
  readonly repos: readonly RepoEntry[];
  readonly path: string;
  /** This repo's own prune log, so no test reads another's — or the developer's. */
  readonly pruneLog: string;
}

/** A clone of its own origin, logged as just pruned — the run fetches only where a test ages that. */
async function freshRepo(): Promise<Repo> {
  fixtures += 1;
  const fixture = await makeGitFixture(join(base, `f${fixtures}`));
  await git(fixture.repoPath, "fetch", "-q", "origin");
  const repo = {
    fixture,
    repos: await scanRepos([fixture.root]),
    path: fixture.repoPath,
    pruneLog: join(base, `prune-log-${fixtures}.json`),
  };
  await logPrune(repo, Date.now());
  return repo;
}

async function logPrune(repo: Repo, at: number): Promise<void> {
  const commonDir = await resolveCommonDir(repo.path);
  await writeFile(repo.pruneLog, JSON.stringify({ [commonDir ?? ""]: at }));
}

async function commit(cwd: string, file: string): Promise<string> {
  await writeFile(join(cwd, file), `${file}\n`);
  await git(cwd, "add", file);
  await git(cwd, "commit", "-q", "-m", `add ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

/**
 * What GitHub's squash-merge leaves: the branch's combined diff as one new
 * commit on origin's main, the branch deleted there — done through a throwaway
 * clone, as a merge on the server would be.
 */
async function squashMergeOnOrigin(repo: Repo, branch: string): Promise<void> {
  fixtures += 1;
  const server = join(base, `server-${fixtures}`);
  await git(base, "clone", "-q", repo.fixture.barePath, server);
  await git(server, "merge", "--squash", `origin/${branch}`);
  await git(server, "commit", "-q", "-m", `${branch} (#1)`);
  await git(server, "push", "-q", "origin", "main", `:${branch}`);
}

/** Another developer's later edit to `file` on origin's main, pushed from a throwaway clone. */
async function editOnOrigin(repo: Repo, file: string): Promise<void> {
  fixtures += 1;
  const server = join(base, `server-${fixtures}`);
  await git(base, "clone", "-q", repo.fixture.barePath, server);
  await writeFile(join(server, file), "since edited\n");
  await git(server, "commit", "-q", "-am", `edit ${file}`);
  await git(server, "push", "-q", "origin", "main");
}

/** Every signal `lastTouched` reads, set ten days back. */
async function age(worktree: string): Promise<void> {
  const gitDir = await git(worktree, "rev-parse", "--absolute-git-dir");
  const old = new Date(Date.now() - 10 * DAY_MS);
  for (const file of [join(gitDir, "HEAD"), join(gitDir, "index"), join(gitDir, "logs", "HEAD"), worktree]) {
    // oxlint-disable-next-line no-await-in-loop
    await utimes(file, old, old).catch(() => {});
  }
}

async function ageFetch(repo: Repo): Promise<void> {
  await logPrune(repo, Date.now() - 2 * DAY_MS);
}

async function reap(repo: Repo, overrides: Partial<ReapOptions> = {}): Promise<ReapReport> {
  return runReap({
    repos: repo.repos,
    dryRun: false,
    minAgeMs: WEEK,
    audit: reapAudit("cli", collect),
    deadPaneMinAgeMs: 0,
    pruneLogPath: repo.pruneLog,
    fsmonitor: null,
    ...overrides,
  });
}

async function exists(path: string): Promise<boolean> {
  return Bun.file(join(path, ".git")).exists();
}

async function branchExists(repo: Repo, name: string): Promise<boolean> {
  return gitOk(repo.path, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`);
}

async function openWindow(command: string, cwd: string = base): Promise<string> {
  const paneId = await tmuxOk(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${session}:`, "-c", cwd, command]);
  return paneId.trim();
}

async function paneExists(paneId: string): Promise<boolean> {
  return (await listPanes()).some((pane) => pane.paneId === paneId);
}

async function onExitPrompt(paneId: string): Promise<boolean> {
  const pane = (await listPanes()).find((p) => p.paneId === paneId);
  return pane !== undefined && (await classifyPane(pane)) === "exit-prompt";
}

describe("reap: worktrees and branches (real git)", () => {
  test("a squash-merged branch's old, clean worktree goes, then the branch, audited with its full sha", async () => {
    const repo = await freshRepo();
    const worktree = join(repo.path, ".claude", "worktrees", "sq");
    await addWorktree(repo.path, worktree);
    await commit(worktree, "one.txt");
    const tip = await commit(worktree, "two.txt");
    await git(worktree, "push", "-q", "-u", "origin", "wt-sq");
    await squashMergeOnOrigin(repo, "wt-sq");
    await git(repo.path, "fetch", "-q", "--prune", "origin");
    await age(worktree);

    const report = await reap(repo);
    const [result] = report.repos;
    expect(result?.removedWorktrees).toEqual([{ path: worktree, branch: "wt-sq", why: "squash", idleDays: 10 }]);
    expect(result?.deletedBranches).toEqual([{ name: "wt-sq", sha: tip, why: "squash" }]);
    expect(await exists(worktree)).toBe(false);
    expect(await branchExists(repo, "wt-sq")).toBe(false);
    expect(lines.join("\n")).toContain(`deleted-branch repo="myrepo" branch="wt-sq" sha=${tip} reason=squash`);
    // The audit line is the recovery.
    await git(repo.path, "branch", "wt-sq", tip);
    expect(await branchExists(repo, "wt-sq")).toBe(true);
  });

  test("a sibling-layout worktree on an ancestor branch goes, and so does a merged branch nothing checks out", async () => {
    const repo = await freshRepo();
    const sibling = join(repo.fixture.root, "myrepo-pr7");
    await addWorktree(repo.path, sibling);
    await git(repo.path, "branch", "plain");
    await age(sibling);

    const [result] = (await reap(repo)).repos;
    expect(result?.removedWorktrees.map((w) => w.path)).toEqual([sibling]);
    expect(result?.deletedBranches.map((b) => b.name).toSorted()).toEqual(["plain", "wt-myrepo-pr7"]);
    expect(await exists(sibling)).toBe(false);
  });

  test("upstream gone with every patch upstream: a rebase-merge the tree check can't see once origin moved on", async () => {
    const repo = await freshRepo();
    await git(repo.path, "switch", "-q", "-c", "rebased");
    await commit(repo.path, "feature.txt");
    await git(repo.path, "push", "-q", "-u", "origin", "rebased");
    await git(repo.path, "switch", "-q", "main");
    // Origin takes the same patch, then edits the same file: merging the branch
    // now conflicts, so only the patch ids say it is in.
    fixtures += 1;
    const server = join(base, `server-${fixtures}`);
    await git(base, "clone", "-q", repo.fixture.barePath, server);
    // Something else lands first, so the picked commit is a new one, not the branch's own.
    await commit(server, "unrelated.txt");
    await git(server, "cherry-pick", "origin/rebased");
    await writeFile(join(server, "feature.txt"), "since edited\n");
    await git(server, "commit", "-q", "-am", "edit feature");
    await git(server, "push", "-q", "origin", "main", ":rebased");
    await git(repo.path, "fetch", "-q", "--prune", "origin");

    const [result] = (await reap(repo)).repos;
    expect(result?.deletedBranches.map((b) => [b.name, b.why])).toEqual([["rebased", "gone"]]);
  });

  test("a squash-merged branch whose lines origin has since edited again: the patch id finds the squash the tree check can't", async () => {
    const repo = await freshRepo();
    await git(repo.path, "switch", "-q", "-c", "sq-edited");
    await commit(repo.path, "one.txt");
    const tip = await commit(repo.path, "two.txt");
    await git(repo.path, "push", "-q", "-u", "origin", "sq-edited");
    await git(repo.path, "switch", "-q", "main");
    await squashMergeOnOrigin(repo, "sq-edited");
    await editOnOrigin(repo, "two.txt");
    await git(repo.path, "fetch", "-q", "--prune", "origin");

    const [result] = (await reap(repo)).repos;
    expect(result?.deletedBranches).toEqual([{ name: "sq-edited", sha: tip, why: "squash" }]);
    expect(result?.keptBranches).toEqual([]);
  });

  test("a branch stacked on a squash-merged one carries its parent's diff too, so it is kept, not mistaken for that squash", async () => {
    const repo = await freshRepo();
    await git(repo.path, "switch", "-q", "-c", "parent");
    await commit(repo.path, "parent.txt");
    await commit(repo.path, "parent-2.txt");
    await git(repo.path, "push", "-q", "-u", "origin", "parent");
    await git(repo.path, "switch", "-q", "-c", "child");
    await commit(repo.path, "child.txt");
    await git(repo.path, "push", "-q", "-u", "origin", "child");
    await git(repo.path, "switch", "-q", "main");
    await squashMergeOnOrigin(repo, "parent");
    await git(repo.path, "push", "-q", "origin", ":child");
    await editOnOrigin(repo, "parent.txt");
    await git(repo.path, "fetch", "-q", "--prune", "origin");

    const [result] = (await reap(repo)).repos;
    expect(result?.deletedBranches.map((b) => [b.name, b.why])).toEqual([["parent", "squash"]]);
    expect(result?.keptBranches).toEqual([{ name: "child", ahead: 3 }]);
  });

  test("a branch re-applying a change main reverted before it forked is new work, not that change landed", async () => {
    const repo = await freshRepo();
    const landed = await commit(repo.path, "relanded.txt");
    await git(repo.path, "revert", "--no-edit", landed);
    await git(repo.path, "push", "-q", "origin", "main");
    await git(repo.path, "switch", "-q", "-c", "reland");
    await commit(repo.path, "relanded.txt");
    await git(repo.path, "push", "-q", "-u", "origin", "reland");
    await git(repo.path, "switch", "-q", "main");
    await git(repo.path, "push", "-q", "origin", ":reland");
    await git(repo.path, "fetch", "-q", "--prune", "origin");

    const [result] = (await reap(repo)).repos;
    expect(result?.deletedBranches).toEqual([]);
    expect(result?.keptBranches).toEqual([{ name: "reland", ahead: 1 }]);
  });

  test("upstream gone but commits nowhere upstream: the branch is kept and reported, untouched", async () => {
    const repo = await freshRepo();
    await git(repo.path, "switch", "-q", "-c", "wip");
    await commit(repo.path, "pushed.txt");
    await git(repo.path, "push", "-q", "-u", "origin", "wip");
    const tip = await commit(repo.path, "unpushed.txt");
    await git(repo.path, "switch", "-q", "main");
    await git(repo.path, "push", "-q", "origin", ":wip");
    await git(repo.path, "fetch", "-q", "--prune", "origin");

    const [result] = (await reap(repo)).repos;
    expect(result?.keptBranches).toEqual([{ name: "wip", ahead: 2 }]);
    expect(result?.deletedBranches).toEqual([]);
    expect(await git(repo.path, "rev-parse", "wip")).toBe(tip);
  });

  test("unmerged worktrees are kept: gone-upstream and detached ones listed, active ones counted", async () => {
    const repo = await freshRepo();
    const gone = join(repo.path, ".claude", "worktrees", "gone");
    const detached = join(repo.path, ".claude", "worktrees", "detached");
    const active = join(repo.path, ".claude", "worktrees", "active");
    const locked = join(repo.path, ".claude", "worktrees", "locked");
    await addWorktree(repo.path, gone);
    await commit(gone, "pushed.txt");
    await git(gone, "push", "-q", "-u", "origin", "wt-gone");
    await commit(gone, "unpushed.txt");
    await git(repo.path, "push", "-q", "origin", ":wt-gone");
    await git(repo.path, "worktree", "add", "-q", "--detach", detached);
    await commit(detached, "loose.txt");
    await addWorktree(repo.path, active);
    await commit(active, "wip.txt");
    await git(active, "push", "-q", "-u", "origin", "wt-active");
    await addWorktree(repo.path, locked);
    await commit(locked, "held.txt");
    await git(locked, "push", "-q", "-u", "origin", "wt-locked");
    await commit(locked, "held-unpushed.txt");
    await git(repo.path, "push", "-q", "origin", ":wt-locked");
    await git(repo.path, "worktree", "lock", locked);
    await git(repo.path, "fetch", "-q", "--prune", "origin");
    for (const worktree of [gone, detached, active, locked]) {
      // oxlint-disable-next-line no-await-in-loop
      await age(worktree);
    }

    const preview = formatReport(await reap(repo, { dryRun: true })).join("\n");
    expect(preview).toContain(
      `kept worktree      ${gone}   wt-gone   upstream gone, 2 commits not on the default branch`,
    );
    expect(preview).toContain(`kept worktree      ${detached}   detached, 1 commit not on the default branch`);
    expect(preview).toContain("2 kept worktrees · 1 active");

    const report = await reap(repo);
    const [result] = report.repos;
    // `git worktree list` order is the filesystem's, not ours.
    expect((result?.keptWorktrees ?? []).toSorted((a, b) => a.path.localeCompare(b.path))).toEqual(
      [
        { path: detached, branch: null, ahead: 1 },
        { path: gone, branch: "wt-gone", ahead: 2 },
      ].toSorted((a, b) => a.path.localeCompare(b.path)),
    );
    expect(result?.locked).toEqual([locked]);
    expect(result?.active).toBe(1);
    expect(result?.removedWorktrees).toEqual([]);
    expect(result?.keptBranches).toEqual([]);
    for (const worktree of [gone, detached, active, locked]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await exists(worktree)).toBe(true);
    }
  });

  test("a dirty worktree is reported and left, whatever showUntrackedFiles says; ignored files alone don't make one dirty", async () => {
    const repo = await freshRepo();
    const dirty = join(repo.path, ".claude", "worktrees", "dirty");
    const ignored = join(repo.path, ".claude", "worktrees", "ignored");
    await addWorktree(repo.path, dirty);
    await addWorktree(repo.path, ignored);
    await appendFile(join(repo.path, ".git", "info", "exclude"), ".env\n");
    // Hides the untracked file from a bare status — `git worktree remove`'s own check included.
    await git(repo.path, "config", "status.showUntrackedFiles", "no");
    await writeFile(join(dirty, "notes.txt"), "half done\n");
    await writeFile(join(ignored, ".env"), "SECRET=copied-from-main\n");
    await age(dirty);
    await age(ignored);

    const [result] = (await reap(repo)).repos;
    expect(result?.dirty).toEqual([{ path: dirty, changes: 1 }]);
    expect(await exists(dirty)).toBe(true);
    expect(result?.removedWorktrees.map((w) => w.path)).toEqual([ignored]);
    expect(await exists(ignored)).toBe(false);
  });

  test("a worktree younger than the age gate is kept — and a fresh Claude transcript makes an old one young", async () => {
    const repo = await freshRepo();
    const recent = join(repo.path, ".claude", "worktrees", "recent");
    const talkedTo = join(repo.path, ".claude", "worktrees", "talked");
    await addWorktree(repo.path, recent);
    await addWorktree(repo.path, talkedTo);
    await age(talkedTo);
    // A session in an editor, invisible to tmux, still writes here.
    await mkdir(transcriptDir(talkedTo), { recursive: true });
    await writeFile(join(transcriptDir(talkedTo), "session.jsonl"), "{}\n");

    const [result] = (await reap(repo)).repos;
    expect(result?.young).toBe(2);
    expect(result?.removedWorktrees).toEqual([]);
    expect(await exists(recent)).toBe(true);
    expect(await exists(talkedTo)).toBe(true);
  });

  test("a worktree with a tmux pane inside it is in use, whoever's pane it is", async () => {
    const repo = await freshRepo();
    const worktree = join(repo.path, ".claude", "worktrees", "busy");
    await addWorktree(repo.path, worktree);
    await mkdir(join(worktree, "src"));
    await age(worktree);
    const paneId = await openWindow("sleep 120", join(worktree, "src"));
    // tmux prints the id once forked, before the child has chdir'd; under load the first listing can still show the server's cwd.
    await pollUntil(
      async () =>
        (await listPanes()).some((pane) => pane.paneId === paneId && pane.path.endsWith("/worktrees/busy/src")),
      "pane in the worktree",
    );

    const [result] = (await reap(repo)).repos;
    expect(result?.inUse).toEqual([worktree]);
    expect(await exists(worktree)).toBe(true);
    await tmuxOk(["kill-pane", "-t", paneId]);
  });

  test("the default branch and whatever is checked out are never candidates; a locked worktree is reported", async () => {
    const repo = await freshRepo();
    const locked = join(repo.path, ".claude", "worktrees", "locked");
    await addWorktree(repo.path, locked);
    await git(repo.path, "worktree", "lock", locked);
    await age(locked);

    const [result] = (await reap(repo)).repos;
    expect(result?.locked).toEqual([locked]);
    expect(result?.deletedBranches).toEqual([]);
    expect(await branchExists(repo, "main")).toBe(true);
    expect(await branchExists(repo, "wt-locked")).toBe(true);
  });

  test("a worktree whose directory is gone is pruned, and its branch freed in the same pass", async () => {
    const repo = await freshRepo();
    const gone = join(repo.path, ".claude", "worktrees", "gone");
    await addWorktree(repo.path, gone);
    await rm(gone, { recursive: true, force: true });

    const [result] = (await reap(repo)).repos;
    expect(result?.pruned).toEqual([gone]);
    expect(result?.deletedBranches.map((b) => b.name)).toEqual(["wt-gone"]);
    expect(await git(repo.path, "worktree", "list", "--porcelain")).not.toContain(gone);
  });

  test("a dry run changes nothing and records nothing, and says what it would do", async () => {
    const repo = await freshRepo();
    const worktree = join(repo.path, ".claude", "worktrees", "preview");
    await addWorktree(repo.path, worktree);
    await git(repo.path, "branch", "merged-already");
    await age(worktree);
    await ageFetch(repo);
    const snapshot = async (): Promise<string> =>
      [
        await git(repo.path, "for-each-ref"),
        await git(repo.path, "worktree", "list", "--porcelain"),
        (await listPanes()).map((pane) => pane.paneId).join(","),
      ].join("\n---\n");
    const before = await snapshot();

    const report = await reap(repo, { dryRun: true });
    expect(await snapshot()).toBe(before);
    expect(lines).toEqual([]);
    expect(report.repos[0]?.removedWorktrees.map((w) => w.path)).toEqual([worktree]);
    const printed = formatReport(report).join("\n");
    expect(printed).toContain("would remove worktree");
    expect(printed).toContain("would delete branch");
  });

  test("prunes only when its own last prune is a day old, and then drops what origin deleted", async () => {
    const repo = await freshRepo();
    await git(repo.path, "push", "-q", "origin", "main:elsewhere");
    await git(repo.path, "fetch", "-q", "origin");
    // On origin itself: a push of the deletion would drop the clone's tracking ref too.
    await git(repo.fixture.barePath, "update-ref", "-d", "refs/heads/elsewhere");

    expect((await reap(repo)).repos[0]?.fetch).toEqual({ kind: "fresh" });
    expect(await gitOk(repo.path, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/elsewhere")).toBe(true);

    await ageFetch(repo);
    // What every worktree spawn does: a one-branch fetch, a fresh FETCH_HEAD, nothing pruned.
    // It must not pass for the prune it isn't.
    await git(repo.path, "fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main");
    expect((await reap(repo)).repos[0]?.fetch).toEqual({ kind: "fetched" });
    expect(await gitOk(repo.path, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/elsewhere")).toBe(false);

    // and the prune it ran is logged, so the next run within the day leaves the network alone
    expect((await reap(repo)).repos[0]?.fetch).toEqual({ kind: "fresh" });
  });

  test("a missing or corrupt prune log reads as never pruned, and the run rewrites it", async () => {
    const repo = await freshRepo();
    await writeFile(repo.pruneLog, "{ not json");
    expect((await reap(repo)).repos[0]?.fetch).toEqual({ kind: "fetched" });
    expect((await reap(repo)).repos[0]?.fetch).toEqual({ kind: "fresh" });

    // in a state dir that doesn't exist yet, too
    const absent = { pruneLogPath: join(base, `absent-${fixtures}`, "reap-fetch.json") };
    expect((await reap(repo, absent)).repos[0]?.fetch).toEqual({ kind: "fetched" });
    expect((await reap(repo, absent)).repos[0]?.fetch).toEqual({ kind: "fresh" });
  });

  test("an origin that wants credentials fails the fetch fast instead of hanging on a prompt", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("auth required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="x"' } }),
    });
    try {
      const repo = await freshRepo();
      await git(repo.path, "remote", "set-url", "origin", `http://127.0.0.1:${server.port}/repo.git`);
      await ageFetch(repo);
      const started = Date.now();
      const fetch = (await reap(repo)).repos[0]?.fetch;
      expect(fetch?.kind).toBe("failed");
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await server.stop(true);
    }
  });
});

describe("reap: séance windows (real tmux, stub claude)", () => {
  test("a séance claude on the exit prompt is answered with Keep and its window closes; a hand-started one is left", async () => {
    const repo = await freshRepo();
    const ours = await openWindow(`exec ${stub.exitPrompt} --remote-control`);
    const handStarted = await openWindow("bash --noprofile --norc -i");
    await tmuxOk(["send-keys", "-t", handStarted, "-l", stub.exitPrompt]);
    await tmuxOk(["send-keys", "-t", handStarted, "Enter"]);
    // Each pane on its own dialog before the reap: the two stubs boot
    // independently, so one being ready says nothing about the other.
    await pollUntil(() => onExitPrompt(ours), "séance claude on its exit prompt");
    await pollUntil(() => onExitPrompt(handStarted), "hand-started claude on its exit prompt");

    const report = await reap(repo);
    expect(report.closedPanes.map((pane) => [pane.paneId, pane.why])).toContainEqual([ours, "exit-prompt"]);
    expect(await paneExists(ours)).toBe(false);
    expect(lines.join("\n")).toContain(`closed-pane pane=${ours}`);
    expect(await paneExists(handStarted)).toBe(true);
    expect(report.openPanes.map((pane) => pane.paneId)).not.toContain(handStarted);
    await tmuxOk(["kill-pane", "-t", handStarted]);
  });

  test(
    "a dead séance pane is closed once it has been dead long enough; a live one is reported with its id",
    async () => {
      const repo = await freshRepo();
      const dead = await openWindow(`tmux wait-for reap-dead; exec ${stub.failing} --remote-control`);
      await tmuxOk(["set-option", "-w", "-t", dead, "remain-on-exit", "on"]);
      await tmuxOk(["wait-for", "-S", "reap-dead"]);
      await untilDeathStamped(dead);
      const live = await openWindow(`exec ${stub.ok} --remote-control`);
      await pollUntil(async () => (await listPanes()).some((p) => p.paneId === live && p.titled), "live pane to title");

      const report = await reap(repo);
      expect(report.closedPanes).toContainEqual(expect.objectContaining({ paneId: dead, why: "dead" }));
      expect(await paneExists(dead)).toBe(false);
      expect(report.openPanes).toContainEqual(expect.objectContaining({ paneId: live, state: "live" }));
      expect(formatReport(report).join("\n")).toContain(`seanced despawn ${live}`);
      await tmuxOk(["kill-pane", "-t", live]);
    },
    DEATH_STAMP_TEST_TIMEOUT_MS,
  );

  test(
    "a dead registered task pane holding an exit status is left open without a harvest; with one it is noted, closed and audited as harvest",
    async () => {
      const repo = await freshRepo();
      const dead = await openWindow(`tmux wait-for reap-owes; exec ${stub.failing} --remote-control`);
      await tmuxOk(["set-option", "-w", "-t", dead, "remain-on-exit", "on"]);
      await tmuxOk(["set-option", "-p", "-t", dead, TASK_OPTION, "t-owes"]);
      await tmuxOk(["select-pane", "-t", dead, "-T", "claude session"]);
      await tmuxOk(["wait-for", "-S", "reap-owes"]);
      await untilDeathStamped(dead);

      const bare = await reap(repo);
      expect(bare.closedPanes.map((pane) => pane.paneId)).not.toContain(dead);
      expect(bare.openPanes).toContainEqual(expect.objectContaining({ paneId: dead, state: "dead" }));
      expect(await paneExists(dead)).toBe(true);

      const ledger = LaunchLedger.memory();
      await ledger.record("t-owes");
      const audited: string[] = [];
      const tasks = new EndedTasks(
        ledger,
        Date.now,
        tmuxHarvestPanes(reapAudit("harvest", (line) => void audited.push(line))),
      );
      await reap(repo, { harvest: () => tasks.harvestExits() });
      expect(ledger.progress()).toEqual([expect.objectContaining({ taskId: "t-owes", exit: 2 })]);
      expect(await paneExists(dead)).toBe(false);
      expect(audited).toEqual([expect.stringContaining(`audit reap origin=harvest closed-pane pane=${dead} `)]);
    },
    DEATH_STAMP_TEST_TIMEOUT_MS,
  );
});

describe("withReapLock", () => {
  test("one reap at a time; a crashed run's lock is taken over", async () => {
    const path = join(base, "locks", "reap.lock");
    const running = Promise.withResolvers<void>();
    const held = withReapLock(() => running.promise, path);
    await pollUntil(() => Bun.file(path).exists(), "lock file");
    const busy = await withReapLock(() => Promise.resolve(), path).catch((err: unknown) => err);
    expect(busy).toBeInstanceOf(ReapBusy);
    running.resolve();
    await held;

    // A pid no process holds: what a killed run leaves behind.
    await writeFile(path, "2147483646");
    expect(await withReapLock(() => Promise.resolve("ran"), path)).toBe("ran");
    expect(await Bun.file(path).exists()).toBe(false);
  });
});

describe("reap: fsmonitor daemons (injected — Linux git ships no daemon)", () => {
  const HOUR = 60 * 60 * 1000;

  interface FakeMonitors {
    readonly seams: FsmonitorSeams;
    /** Each stop, and whether its directory was still on disk when asked. */
    readonly stops: { readonly path: string; readonly existed: boolean }[];
    readonly signalled: number[];
  }

  function fakeMonitors(daemons: readonly FsmonitorDaemon[], stopAnswers = true): FakeMonitors {
    const stops: { path: string; existed: boolean }[] = [];
    const signalled: number[] = [];
    return {
      stops,
      signalled,
      seams: {
        list: () => Promise.resolve(daemons),
        stop: async (path) => {
          stops.push({ path, existed: await Bun.file(join(path, ".git")).exists() });
          return stopAnswers;
        },
        signal: (pid) => {
          signalled.push(pid);
          return true;
        },
      },
    };
  }

  interface Fleet {
    readonly repo: Repo;
    readonly removable: string;
    readonly young: string;
    readonly paned: string;
    readonly scratch: string;
    readonly gone: string;
    readonly paneId: string;
    readonly daemons: readonly FsmonitorDaemon[];
  }

  /**
   * One daemon per case, by pid: 11 a merged, old worktree reap removes; 12 a
   * worktree too young to remove; 13 the main clone; 14 a worktree with a tmux
   * pane inside; 15 a scratchpad left with only `.claude`; 16 a directory gone;
   * 17 unmapped.
   */
  async function fleet(): Promise<Fleet> {
    const repo = await freshRepo();
    const removable = join(repo.path, ".claude", "worktrees", "done");
    const young = join(repo.path, ".claude", "worktrees", "busy");
    const paned = join(repo.path, ".claude", "worktrees", "paned");
    const scratch = join(base, `scratch-${fixtures}`);
    const gone = join(base, `gone-${fixtures}`);
    await addWorktree(repo.path, removable);
    await addWorktree(repo.path, young);
    await addWorktree(repo.path, paned);
    await age(removable);
    await mkdir(join(scratch, ".claude"), { recursive: true });
    const paneId = await openWindow("sleep 600", paned);
    await pollUntil(
      async () => (await listPanes()).some((pane) => pane.paneId === paneId && pane.path.endsWith("/worktrees/paned")),
      "pane in the worktree",
    );
    const daemons = [
      { pid: 11, rssKb: 5120, worktree: removable },
      { pid: 12, rssKb: 5120, worktree: young },
      { pid: 13, rssKb: 5120, worktree: repo.path },
      { pid: 14, rssKb: 5120, worktree: paned },
      { pid: 15, rssKb: 3072, worktree: scratch },
      { pid: 16, rssKb: 1024, worktree: gone },
      { pid: 17, rssKb: 5120, worktree: null },
    ];
    return { repo, removable, young, paned, scratch, gone, paneId, daemons };
  }

  function byPid(report: ReapReport): readonly (readonly [number | null, string, string])[] {
    return report.monitors.stopped
      .map((m) => [m.pid, m.how, m.why] as const)
      .toSorted((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  }

  test("stops a removed worktree's daemon first, then ones on no repo or a gone directory; recent and paned ones run on", async () => {
    const { repo, removable, scratch, paneId, daemons } = await fleet();
    const fake = fakeMonitors(daemons);

    const report = await reap(repo, { fsmonitor: fake.seams, monitorIdleMs: 10 * DAY_MS });
    await tmuxOk(["kill-pane", "-t", paneId]);
    expect(report.repos[0]?.removedWorktrees.map((w) => w.path)).toEqual([removable]);
    expect(fake.stops).toEqual([{ path: removable, existed: true }]);
    expect(fake.signalled.toSorted()).toEqual([15, 16]);
    expect(byPid(report)).toEqual([
      [11, "stop", "removed"],
      [15, "signal", "no-repo"],
      [16, "signal", "gone"],
    ]);
    expect(report.monitors.kept).toEqual({ inUse: 1, recent: 2, unreadable: 0, unmapped: 1 });
    expect(lines).toContain(
      `audit reap origin=cli stopped-fsmonitor path="${removable}" pid=11 how=stop reason=removed`,
    );
    expect(lines).toContain(
      `audit reap origin=cli stopped-fsmonitor path="${scratch}" pid=15 how=signal reason=no-repo`,
    );
    expect(lines.at(-1)).toContain("monitors=3");
    const printed = formatReport(report).join("\n");
    expect(printed).toContain("stopped 3 fsmonitor daemons (9.0 MB)");
    // Every daemon listed is accounted for: three stopped, four left running.
    expect(printed).toContain(
      "4 daemons: 1 with a tmux pane inside, 2 used in the last 240h, 1 whose directory lsof didn't say",
    );
  });

  test("an idle repo's daemon is asked to stop, and signalled when the ask fails; a pane inside still keeps one", async () => {
    const { repo, young, paneId, daemons } = await fleet();
    const fake = fakeMonitors(daemons, false);

    // A day on: past the hour for every repo, short of the week a worktree needs.
    const report = await reap(repo, { fsmonitor: fake.seams, monitorIdleMs: HOUR, now: Date.now() + DAY_MS });
    await tmuxOk(["kill-pane", "-t", paneId]);
    expect(fake.stops.map((stop) => stop.path).toSorted()).toEqual(
      [join(repo.path, ".claude", "worktrees", "done"), young, repo.path].toSorted(),
    );
    expect(byPid(report)).toEqual([
      [11, "signal", "gone"],
      [12, "signal", "idle"],
      [13, "signal", "idle"],
      [15, "signal", "no-repo"],
      [16, "signal", "gone"],
    ]);
    expect(report.monitors.kept).toEqual({ inUse: 1, recent: 0, unreadable: 0, unmapped: 1 });
  });

  test("a dry run stops and signals nothing, records nothing, and says how it would stop each", async () => {
    const { repo, removable, paneId, daemons } = await fleet();
    const fake = fakeMonitors(daemons);

    const report = await reap(repo, {
      fsmonitor: fake.seams,
      dryRun: true,
      monitorIdleMs: HOUR,
      now: Date.now() + DAY_MS,
    });
    await tmuxOk(["kill-pane", "-t", paneId]);
    expect(fake.stops).toEqual([]);
    expect(fake.signalled).toEqual([]);
    expect(lines).toEqual([]);
    expect(await exists(removable)).toBe(true);
    expect(byPid(report)).toEqual([
      [11, "stop", "removed"],
      [12, "stop", "idle"],
      [13, "stop", "idle"],
      [15, "signal", "no-repo"],
      [16, "signal", "gone"],
    ]);
    expect(formatReport(report).join("\n")).toContain("would stop 5 fsmonitor daemons");
  });

  test("with no seams, as on native Windows, the report says nothing about daemons", async () => {
    const { repo, paneId } = await fleet();
    const report = await reap(repo);
    await tmuxOk(["kill-pane", "-t", paneId]);
    expect(report.monitors.stopped).toEqual([]);
    expect(report.monitors.kept).toEqual({ inUse: 0, recent: 0, unreadable: 0, unmapped: 0 });
    expect(formatReport(report).join("\n")).not.toContain("fsmonitor");
  });
});
