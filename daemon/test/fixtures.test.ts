import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/exec.ts";
import { makeGitFixture, type GitFixture } from "./fixtures.ts";

let base: string;
let fixture: GitFixture;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-fixtures-"));
  fixture = await makeGitFixture(base);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const result = await exec(["git", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** The commit a ref names on the bare origin, or "" when origin has no such branch. */
function onOrigin(branch: string): Promise<string> {
  return git(fixture.barePath, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);
}

describe("GitFixture.pushBranch", () => {
  test("a new branch lands on origin from its own worktree, one commit past main, and the clone's origin ref moves", async () => {
    const worktree = await fixture.pushBranch("feature/one");
    expect(worktree).toBe(join(fixture.repoPath, ".claude", "worktrees", "feature-one"));
    const head = await git(worktree, "rev-parse", "HEAD");
    expect(await onOrigin("feature/one")).toBe(head);
    expect(await git(worktree, "rev-parse", "HEAD~1")).toBe(await onOrigin("main"));
    expect(await git(worktree, "show", "--name-only", "--format=", "HEAD")).toBe("one.txt");
    // Pushed through `origin`, so the clone's remote-tracking ref moved too — what the daemon reads.
    expect(await git(fixture.repoPath, "rev-parse", "refs/remotes/origin/feature/one")).toBe(head);
  });

  test("a `worktree-<name>` branch gets claude's folder, `.claude/worktrees/<name>`", async () => {
    const worktree = await fixture.pushBranch("worktree-lay");
    expect(worktree).toBe(join(fixture.repoPath, ".claude", "worktrees", "lay"));
  });

  test("`from` pushes a further commit from an existing worktree, and `force` replaces a rewritten branch", async () => {
    const worktree = await fixture.pushBranch("feature/two");
    await fixture.pushBranch("feature/two", { from: worktree, file: "more.txt" });
    expect(await onOrigin("feature/two")).toBe(await git(worktree, "rev-parse", "HEAD"));

    await git(worktree, "reset", "-q", "--hard", "origin/main");
    await expect(fixture.pushBranch("feature/two", { from: worktree, file: "redo.txt" })).rejects.toThrow(
      /fixture command failed/u,
    );
    await git(worktree, "reset", "-q", "--hard", "origin/main");
    await fixture.pushBranch("feature/two", { from: worktree, file: "redo.txt", force: true });
    expect(await onOrigin("feature/two")).toBe(await git(worktree, "rev-parse", "HEAD"));
  });
});
