import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/exec.ts";
import { pushTaskBranch } from "../src/push-branch.ts";
import { makeGitFixture, type GitFixture } from "./fixtures.ts";

/**
 * `pushTaskBranch` against real repos: a bare origin, a clone and linked worktrees of it
 * (DESIGN.md, "Passing to a successor"). Each test makes its own branch, so one origin serves them all.
 */

const GIT_ID = ["-c", "user.email=test@seance.local", "-c", "user.name=Seance Test"];

let base: string;
let fixture: GitFixture;
let seq = 0;
let savedGlobal: string | undefined;
let savedNoSystem: string | undefined;

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const result = await exec(["git", ...GIT_ID, ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A linked worktree on a new branch off `from`, with no upstream, as a task's `claude --worktree` leaves it. */
async function worktree(branch: string, from = "origin/main"): Promise<string> {
  const path = join(fixture.repoPath, ".claude", "worktrees", branch.replaceAll("/", "-"));
  await git(fixture.repoPath, "worktree", "add", "-q", "--no-track", "-b", branch, path, from);
  return path;
}

async function commit(path: string, file = `f-${(seq += 1)}.txt`): Promise<string> {
  await writeFile(join(path, file), `${file}\n`);
  await git(path, "add", file);
  await git(path, "commit", "-q", "-m", `add ${file}`);
  return git(path, "rev-parse", "HEAD");
}

async function originTip(branch: string): Promise<string | null> {
  const result = await exec(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: fixture.barePath,
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function site(path: string): { readonly repo: string; readonly path: string } {
  return { repo: "myrepo", path };
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-push-branch-"));
  savedGlobal = process.env["GIT_CONFIG_GLOBAL"];
  savedNoSystem = process.env["GIT_CONFIG_NOSYSTEM"];
  // The developer's own ~/.gitconfig (signing, insteadOf, push.default) must not reach these.
  const globalConfig = join(base, "gitconfig");
  await writeFile(globalConfig, "");
  process.env["GIT_CONFIG_GLOBAL"] = globalConfig;
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  fixture = await makeGitFixture(base);
});

afterAll(async () => {
  if (savedGlobal === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
  else process.env["GIT_CONFIG_GLOBAL"] = savedGlobal;
  if (savedNoSystem === undefined) delete process.env["GIT_CONFIG_NOSYSTEM"];
  else process.env["GIT_CONFIG_NOSYSTEM"] = savedNoSystem;
  await rm(base, { recursive: true, force: true });
});

describe("a branch with no upstream and no PR", () => {
  test("is pushed under its own name, and a second pass sends nothing", async () => {
    const path = await worktree("task/own-name");
    const tip = await commit(path);
    expect(await pushTaskBranch(site(path))).toEqual({ ok: true, remoteBranch: "task/own-name", tip, pushed: true });
    expect(await originTip("task/own-name")).toBe(tip);
    expect(await pushTaskBranch(site(path))).toEqual({ ok: true, remoteBranch: "task/own-name", tip, pushed: false });
  });

  test("with a PR the daemon knows of but no head to compare, is the session's to fix", async () => {
    const path = await worktree("task/needs-upstream");
    await commit(path);
    expect(await pushTaskBranch(site(path), { hasPr: true })).toMatchObject({ ok: false, code: "no_upstream" });
    expect(await originTip("task/needs-upstream")).toBeNull();
  });

  test("is pushed to the PR's head when that head's origin tip is already in it", async () => {
    await fixture.pushBranch("pr/head-ancestor");
    const path = await worktree("task/adopts", "origin/pr/head-ancestor");
    const tip = await commit(path);
    expect(await pushTaskBranch(site(path), { expect: "pr/head-ancestor" })).toEqual({
      ok: true,
      remoteBranch: "pr/head-ancestor",
      tip,
      pushed: true,
    });
    expect(await originTip("pr/head-ancestor")).toBe(tip);
    // Nothing went to a branch named after the local one.
    expect(await originTip("task/adopts")).toBeNull();
  });

  test("is refused when the PR's head holds work it does not", async () => {
    await fixture.pushBranch("pr/head-diverged");
    const path = await worktree("task/diverged");
    await commit(path);
    const before = await originTip("pr/head-diverged");
    expect(await pushTaskBranch(site(path), { expect: "pr/head-diverged" })).toMatchObject({
      ok: false,
      code: "branch_mismatch",
    });
    expect(await originTip("pr/head-diverged")).toBe(before);
  });

  test("is refused when the PR's head is the default branch", async () => {
    const path = await worktree("task/head-is-main");
    await commit(path);
    const before = await originTip("main");
    expect(await pushTaskBranch(site(path), { expect: "main" })).toMatchObject({ ok: false, code: "default_branch" });
    expect(await originTip("main")).toBe(before);
  });

  test("is refused when the PR's head is a branch the default already holds", async () => {
    // A `develop` the worktree was cut past: its tip is in the local history, but it is no one task's work.
    await git(fixture.repoPath, "push", "-q", "origin", "origin/main:refs/heads/rel/merged");
    const path = await worktree("task/past-develop");
    await commit(path);
    const before = await originTip("rel/merged");
    expect(await pushTaskBranch(site(path), { expect: "rel/merged" })).toMatchObject({
      ok: false,
      code: "branch_mismatch",
    });
    expect(await originTip("rel/merged")).toBe(before);
  });

  test("is refused when the PR's head is no branch on origin", async () => {
    const path = await worktree("task/no-such-head");
    await commit(path);
    expect(await pushTaskBranch(site(path), { expect: "pr/never-existed" })).toMatchObject({
      ok: false,
      code: "branch_mismatch",
    });
    expect(await originTip("task/no-such-head")).toBeNull();
  });
});

describe("a branch with an upstream", () => {
  test("is pushed to the branch it tracks, whatever its own name", async () => {
    await fixture.pushBranch("pr/tracked");
    const path = await worktree("task/tracks", "origin/pr/tracked");
    await git(path, "branch", "--set-upstream-to=origin/pr/tracked");
    const tip = await commit(path);
    expect(await pushTaskBranch(site(path), { expect: "pr/tracked" })).toEqual({
      ok: true,
      remoteBranch: "pr/tracked",
      tip,
      pushed: true,
    });
    expect(await originTip("pr/tracked")).toBe(tip);
    expect(await originTip("task/tracks")).toBeNull();
  });

  test("is refused when the PR's head is another branch", async () => {
    await fixture.pushBranch("pr/tracked-elsewhere");
    const path = await worktree("task/tracks-elsewhere", "origin/pr/tracked-elsewhere");
    await git(path, "branch", "--set-upstream-to=origin/pr/tracked-elsewhere");
    await commit(path);
    expect(await pushTaskBranch(site(path), { expect: "pr/another-head" })).toMatchObject({
      ok: false,
      code: "branch_mismatch",
    });
  });

  test("another remote's upstream counts as none: the branch is pushed under its own name", async () => {
    const path = await worktree("task/foreign-remote");
    const tip = await commit(path);
    await git(path, "config", "branch.task/foreign-remote.remote", ".");
    await git(path, "config", "branch.task/foreign-remote.merge", "refs/heads/main");
    expect(await pushTaskBranch(site(path))).toEqual({
      ok: true,
      remoteBranch: "task/foreign-remote",
      tip,
      pushed: true,
    });
  });

  test("another remote's upstream still lets the PR's head be adopted", async () => {
    await fixture.pushBranch("pr/fork-tracked");
    const path = await worktree("task/fork-tracked", "origin/pr/fork-tracked");
    const tip = await commit(path);
    await git(path, "config", "branch.task/fork-tracked.remote", "fork");
    await git(path, "config", "branch.task/fork-tracked.merge", "refs/heads/feature");
    expect(await pushTaskBranch(site(path), { expect: "pr/fork-tracked" })).toEqual({
      ok: true,
      remoteBranch: "pr/fork-tracked",
      tip,
      pushed: true,
    });
    expect(await originTip("pr/fork-tracked")).toBe(tip);
  });

  test("an upstream on origin that is no branch is a failure, not a mismatch", async () => {
    const path = await worktree("task/bad-merge");
    await commit(path);
    await git(path, "config", "branch.task/bad-merge.remote", "origin");
    await git(path, "config", "branch.task/bad-merge.merge", "refs/tags/v1");
    expect(await pushTaskBranch(site(path))).toMatchObject({ ok: false, code: "push_failed" });
    expect(await originTip("task/bad-merge")).toBeNull();
  });

  test("is refused when it would update the repo's default branch", async () => {
    const path = await worktree("task/to-main");
    await git(path, "branch", "--set-upstream-to=origin/main");
    await commit(path);
    const before = await originTip("main");
    expect(await pushTaskBranch(site(path))).toMatchObject({ ok: false, code: "default_branch" });
    expect(await originTip("main")).toBe(before);
  });
});

describe("what stops a push", () => {
  test("uncommitted and untracked files", async () => {
    const path = await worktree("task/dirty");
    await commit(path);
    await writeFile(join(path, "scratch.txt"), "x\n");
    expect(await pushTaskBranch(site(path))).toMatchObject({ ok: false, code: "dirty_worktree" });
    expect(await originTip("task/dirty")).toBeNull();
  });

  test("a detached HEAD", async () => {
    const path = await worktree("task/detached");
    await git(path, "checkout", "-q", "--detach");
    expect(await pushTaskBranch(site(path))).toMatchObject({ ok: false, code: "detached_head" });
  });

  test("a branch origin holds other work on, which is never forced", async () => {
    await fixture.pushBranch("task/taken");
    const path = await worktree("task/taken-local");
    await commit(path);
    await git(path, "config", "branch.task/taken-local.remote", "origin");
    await git(path, "config", "branch.task/taken-local.merge", "refs/heads/task/taken");
    const before = await originTip("task/taken");
    const reply = await pushTaskBranch(site(path));
    expect(reply).toMatchObject({ ok: false, code: "push_rejected" });
    expect(await originTip("task/taken")).toBe(before);
  });

  test("origin's branch moved ahead past a tip already in it: nothing is unpushed, and origin's tip is named", async () => {
    await fixture.pushBranch("pr/moved-ahead");
    const path = await worktree("task/behind-origin", "origin/pr/moved-ahead");
    await git(path, "branch", "--set-upstream-to=origin/pr/moved-ahead");
    // GitHub's "Update branch", or a bot's commit: origin gains a commit this worktree never fetched.
    const updater = await worktree("task/updater", "origin/pr/moved-ahead");
    const ahead = await commit(updater);
    await git(updater, "push", "-q", "origin", "HEAD:refs/heads/pr/moved-ahead");
    expect(await pushTaskBranch(site(path))).toEqual({
      ok: true,
      remoteBranch: "pr/moved-ahead",
      tip: ahead,
      pushed: false,
    });
    expect(await originTip("pr/moved-ahead")).toBe(ahead);
  });

  test("origin's branch moved ahead while this one holds a commit of its own is a divergence, never forced", async () => {
    await fixture.pushBranch("pr/moved-diverged");
    const path = await worktree("task/diverged-from-origin", "origin/pr/moved-diverged");
    await git(path, "branch", "--set-upstream-to=origin/pr/moved-diverged");
    await commit(path);
    const updater = await worktree("task/updater-two", "origin/pr/moved-diverged");
    await commit(updater);
    await git(updater, "push", "-q", "origin", "HEAD:refs/heads/pr/moved-diverged");
    const before = await originTip("pr/moved-diverged");
    expect(await pushTaskBranch(site(path))).toMatchObject({ ok: false, code: "push_rejected" });
    expect(await originTip("pr/moved-diverged")).toBe(before);
  });

  test("a tracking ref the last fetch left behind is not taken for what origin holds", async () => {
    await fixture.pushBranch("pr/rewritten");
    const path = await worktree("task/stale-tracking", "origin/pr/rewritten");
    await git(path, "branch", "--set-upstream-to=origin/pr/rewritten");
    // origin's branch is rewritten from elsewhere; this clone's origin/pr/rewritten still equals HEAD.
    const other = await worktree("task/rewriter");
    await commit(other);
    await git(other, "push", "-q", "-f", "origin", "HEAD:refs/heads/pr/rewritten");
    const before = await originTip("pr/rewritten");
    expect(await pushTaskBranch(site(path))).toMatchObject({ ok: false, code: "push_rejected" });
    expect(await originTip("pr/rewritten")).toBe(before);
  });

  test("a fetch that fails for another reason than a missing branch is a failure, not a mismatch", async () => {
    const path = await worktree("task/offline");
    await commit(path);
    const url = await git(path, "config", "remote.origin.url");
    await git(path, "config", "remote.origin.url", join(base, "gone.git"));
    try {
      expect(await pushTaskBranch(site(path), { expect: "pr/anything" })).toMatchObject({
        ok: false,
        code: "push_failed",
      });
    } finally {
      await git(path, "config", "remote.origin.url", url);
    }
  });

  test("a repo-local pushurl, which would send it somewhere other than origin", async () => {
    const path = await worktree("task/pushurl");
    await commit(path);
    await git(path, "config", "remote.origin.pushurl", join(base, "elsewhere.git"));
    expect(await pushTaskBranch(site(path))).toMatchObject({ ok: false, code: "push_failed" });
    expect(await originTip("task/pushurl")).toBeNull();
    await git(path, "config", "--unset", "remote.origin.pushurl");
  });

  test("a worktree the repo does not know", async () => {
    expect(await pushTaskBranch(site(join(base, "nowhere")))).toMatchObject({ ok: false, code: "not_launched" });
  });

  test("a repo's own checkout is not a task's worktree, whatever path asks for it", async () => {
    await git(fixture.repoPath, "checkout", "-q", "-B", "task/in-the-clone", "origin/main");
    await commit(fixture.repoPath);
    try {
      expect(await pushTaskBranch(site(fixture.repoPath))).toMatchObject({ ok: false, code: "not_launched" });
      expect(await originTip("task/in-the-clone")).toBeNull();
    } finally {
      await git(fixture.repoPath, "checkout", "-q", "main");
    }
  });

  test("a head that is not a branch name never reaches git", async () => {
    const path = await worktree("task/bad-head");
    await commit(path);
    expect(await pushTaskBranch(site(path), { expect: "-oops" })).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
  });
});

describe("what a push never runs", () => {
  test("a pre-push hook of the repo", async () => {
    const path = await worktree("task/hooked");
    const tip = await commit(path);
    const marker = join(base, "hook-ran");
    const hook = join(fixture.repoPath, ".git", "hooks", "pre-push");
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(hook, 0o755);
    expect(await pushTaskBranch(site(path))).toMatchObject({ ok: true, pushed: true, tip });
    expect(
      await stat(marker).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    await rm(hook);
  });
});

describe("what a reply carries", () => {
  test("a code and fixed text, never the branch or the remote", async () => {
    const path = await worktree("task/secret-name");
    await commit(path);
    await writeFile(join(path, "scratch.txt"), "x\n");
    const dirty = JSON.stringify(await pushTaskBranch(site(path)));
    expect(dirty).not.toContain("secret-name");
    expect(dirty).not.toContain(fixture.barePath);
    await rm(join(path, "scratch.txt"));
    await git(path, "config", "branch.task/secret-name.remote", "origin");
    await git(path, "config", "branch.task/secret-name.merge", "refs/heads/main");
    const refused = JSON.stringify(await pushTaskBranch(site(path)));
    expect(refused).not.toContain("secret-name");
  });
});

describe("a branch the default merged after the last fetch", () => {
  let own: GitFixture;
  let outer: GitFixture;

  beforeAll(async () => {
    outer = fixture;
    own = await makeGitFixture(join(base, "fresh-default"));
    fixture = own;
  });

  afterAll(() => {
    fixture = outer;
  });

  test("is not adopted: the default is fetched with the head, not read as the last reap left it", async () => {
    await fixture.pushBranch("rel/merged-since");
    const path = await worktree("task/past-merged-since", "origin/rel/merged-since");
    await commit(path);
    const staleMain = await git(fixture.repoPath, "rev-parse", "refs/remotes/origin/main");
    // origin's main takes the branch (a merge, as GitHub does it) from elsewhere; this clone's tracking ref is behind.
    await git(fixture.repoPath, "push", "-q", "origin", "origin/rel/merged-since:refs/heads/main");
    await git(fixture.repoPath, "update-ref", "refs/remotes/origin/main", staleMain);
    const before = await originTip("rel/merged-since");
    expect(await pushTaskBranch(site(path), { expect: "rel/merged-since" })).toMatchObject({
      ok: false,
      code: "branch_mismatch",
    });
    expect(await originTip("rel/merged-since")).toBe(before);
  });

  test("a clone whose origin/HEAD names no default has none to refresh, so the head is not adopted", async () => {
    await fixture.pushBranch("pr/no-default-ref");
    const path = await worktree("task/no-default-ref", "origin/pr/no-default-ref");
    await commit(path);
    await git(fixture.repoPath, "remote", "set-head", "origin", "--delete");
    try {
      expect(await pushTaskBranch(site(path), { expect: "pr/no-default-ref" })).toMatchObject({
        ok: false,
        code: "push_failed",
      });
    } finally {
      await git(fixture.repoPath, "remote", "set-head", "origin", "main");
    }
  });
});
