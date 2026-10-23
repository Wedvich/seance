import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDaemonProcesses, parseSocketDirs, platformFsmonitor, watchedWorktree } from "./fsmonitor.ts";

describe("parseDaemonProcesses", () => {
  test("this user's `run` daemons only, whatever git binary path started them", () => {
    const raw = [
      "  101   501  5232 git fsmonitor--daemon run --detach --ipc-threads=8",
      "  102   501  4100 /opt/homebrew/bin/git fsmonitor--daemon run --detach --ipc-threads=8",
      "  103     0  4100 git fsmonitor--daemon run --detach --ipc-threads=8",
      "  104   501   900 git fsmonitor--daemon stop",
      "  105   501   900 vim notes-on-git fsmonitor--daemon run",
      "  106   501   900 /usr/bin/legit fsmonitor--daemon run",
      "garbage",
    ].join("\n");
    expect(parseDaemonProcesses(raw, 501)).toEqual([
      { pid: 101, rssKb: 5232 },
      { pid: 102, rssKb: 4100 },
    ]);
  });
});

describe("parseSocketDirs", () => {
  test("the git dir of the one absolute IPC socket a pid holds; relative, foreign or ambiguous reads as unknown", () => {
    const raw = [
      "p101",
      "n/Users/m/repos/a/.git/worktrees/x/fsmonitor--daemon.ipc",
      "n->0x1234",
      "p102",
      "nfsmonitor--daemon.ipc",
      "p103",
      "n/Users/m/.git-fsmonitor-abc123",
      "p104",
      "n/Users/m/repos/a/.git/fsmonitor--daemon.ipc",
      "n/Users/m/repos/b/.git/fsmonitor--daemon.ipc",
      "p105",
      "n/Users/m/repos/c/.git/fsmonitor--daemon.ipc",
      "n/Users/m/repos/c/.git/fsmonitor--daemon.ipc",
    ].join("\n");
    expect([...parseSocketDirs(raw)]).toEqual([
      [101, "/Users/m/repos/a/.git/worktrees/x"],
      [102, null],
      [103, null],
      [104, null],
      [105, "/Users/m/repos/c/.git"],
    ]);
  });
});

describe("watchedWorktree", () => {
  let base: string;
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "seance-fsmonitor-"));
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function linkedGitDir(name: string, checkout: string): Promise<string> {
    const gitDir = join(base, "clone", ".git", "worktrees", name);
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, "commondir"), "../..\n");
    await writeFile(join(gitDir, "gitdir"), `${join(checkout, ".git")}\n`);
    return gitDir;
  }

  test("a git dir that is gone: the worktree is gone", async () => {
    expect(await watchedWorktree(join(base, "nowhere", ".git"))).toEqual({
      path: join(base, "nowhere", ".git"),
      gone: true,
    });
  });

  test("a main clone's git dir watches the checkout around it, which is there", async () => {
    const gitDir = join(base, "main", ".git");
    await mkdir(gitDir, { recursive: true });
    expect(await watchedWorktree(gitDir)).toEqual({ path: join(base, "main"), gone: false });
  });

  test("a linked git dir whose checkout was deleted by hand, before any prune: gone", async () => {
    const checkout = join(base, "deleted-checkout");
    expect(await watchedWorktree(await linkedGitDir("deleted", checkout))).toEqual({ path: checkout, gone: true });
  });

  test("a linked git dir whose checkout is there: kept", async () => {
    const checkout = join(base, "live-checkout");
    await mkdir(checkout);
    expect(await watchedWorktree(await linkedGitDir("live", checkout))).toEqual({ path: checkout, gone: false });
  });

  test("a linked git dir whose `gitdir` can't be read reads as present", async () => {
    const gitDir = await linkedGitDir("unreadable", join(base, "whatever"));
    await rm(join(gitDir, "gitdir"));
    expect(await watchedWorktree(gitDir)).toEqual({ path: gitDir, gone: false });
  });
});

test("only macOS gets the real seams: git has no built-in daemon on Linux", () => {
  expect(platformFsmonitor("linux")).toBeNull();
  expect(platformFsmonitor("darwin")).not.toBeNull();
});
