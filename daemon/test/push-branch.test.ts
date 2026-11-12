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

  test("is refused when it tracks a branch of another remote", async () => {
    const path = await worktree("task/foreign-remote");
    await commit(path);
    await git(path, "config", "branch.task/foreign-remote.remote", ".");
    await git(path, "config", "branch.task/foreign-remote.merge", "refs/heads/main");
    expect(await pushTaskBranch(site(path))).toMatchObject({ ok: false, code: "branch_mismatch" });
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
