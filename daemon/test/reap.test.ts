import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoEntry } from "@seance/shared";
import { reapAudit, type AuditSink } from "../src/audit.ts";
import { exec } from "../src/exec.ts";
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
import { listPanes } from "../src/sessions.ts";
import { resolveTargetSession, tmuxOk } from "../src/tmux.ts";
import {
  addWorktree,
  makeClaudeStub,
  makeGitFixture,
  pollUntil,
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
}

/** A clone of its own origin, fetched once so `FETCH_HEAD` is fresh — the run fetches only where a test ages it. */
async function freshRepo(): Promise<Repo> {
  fixtures += 1;
  const fixture = await makeGitFixture(join(base, `f${fixtures}`));
  await git(fixture.repoPath, "fetch", "-q", "origin");
  return { fixture, repos: await scanRepos([fixture.root]), path: fixture.repoPath };
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
  const old = new Date(Date.now() - 2 * DAY_MS);
  await utimes(join(repo.path, ".git", "FETCH_HEAD"), old, old);
}

async function reap(repo: Repo, overrides: Partial<ReapOptions> = {}): Promise<ReapReport> {
  return runReap({
    repos: repo.repos,
    dryRun: false,
    minAgeMs: WEEK,
    audit: reapAudit("cli", collect),
    deadPaneMinAgeMs: 0,
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

  test("a dirty worktree is reported and left; ignored files alone don't make one dirty", async () => {
    const repo = await freshRepo();
    const dirty = join(repo.path, ".claude", "worktrees", "dirty");
    const ignored = join(repo.path, ".claude", "worktrees", "ignored");
    await addWorktree(repo.path, dirty);
    await addWorktree(repo.path, ignored);
    await appendFile(join(repo.path, ".git", "info", "exclude"), ".env\n");
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

  test("fetches only when FETCH_HEAD is a day old, and then prunes what origin deleted", async () => {
    const repo = await freshRepo();
    await git(repo.path, "push", "-q", "origin", "main:elsewhere");
    await git(repo.path, "fetch", "-q", "origin");
    // On origin itself: a push of the deletion would drop the clone's tracking ref too.
    await git(repo.fixture.barePath, "update-ref", "-d", "refs/heads/elsewhere");

    expect((await reap(repo)).repos[0]?.fetch).toEqual({ kind: "fresh" });
    expect(await gitOk(repo.path, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/elsewhere")).toBe(true);

    await ageFetch(repo);
    expect((await reap(repo)).repos[0]?.fetch).toEqual({ kind: "fetched" });
    expect(await gitOk(repo.path, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/elsewhere")).toBe(false);
  });

  test("an origin that wants credentials fails the fetch fast instead of hanging on a prompt", async () => {
    const server = Bun.serve({
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
    await pollUntil(
      async () => (await listPanes()).some((p) => p.paneId === handStarted && p.titled),
      "hand-started prompt",
    );

    const report = await reap(repo);
    expect(report.closedPanes.map((pane) => [pane.paneId, pane.why])).toContainEqual([ours, "exit-prompt"]);
    expect(await paneExists(ours)).toBe(false);
    expect(lines.join("\n")).toContain(`closed-pane pane=${ours}`);
    expect(await paneExists(handStarted)).toBe(true);
    expect(report.openPanes.map((pane) => pane.paneId)).not.toContain(handStarted);
    await tmuxOk(["kill-pane", "-t", handStarted]);
  });

  test("a dead séance pane is closed once it has been dead long enough; a live one is reported with its id", async () => {
    const repo = await freshRepo();
    const dead = await openWindow(`tmux wait-for reap-dead; exec ${stub.failing} --remote-control`);
    await tmuxOk(["set-option", "-w", "-t", dead, "remain-on-exit", "on"]);
    await tmuxOk(["wait-for", "-S", "reap-dead"]);
    await pollUntil(async () => (await listPanes()).some((p) => p.paneId === dead && p.dead), "pane to die");
    const live = await openWindow(`exec ${stub.ok} --remote-control`);
    await pollUntil(async () => (await listPanes()).some((p) => p.paneId === live && p.titled), "live pane to title");

    const report = await reap(repo);
    expect(report.closedPanes).toContainEqual(expect.objectContaining({ paneId: dead, why: "dead" }));
    expect(await paneExists(dead)).toBe(false);
    expect(report.openPanes).toContainEqual(expect.objectContaining({ paneId: live, state: "live" }));
    expect(formatReport(report).join("\n")).toContain(`seanced despawn ${live}`);
    await tmuxOk(["kill-pane", "-t", live]);
  });
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
