import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDaemonProcesses,
  parseRootFds,
  parseSocketDirs,
  platformFsmonitor,
  worktreeOfGitDir,
} from "./fsmonitor.ts";

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

describe("parseRootFds", () => {
  test("fd 4 when it is an absolute directory; anything else on it maps nothing", () => {
    const raw = [
      "p101",
      "f4",
      "tDIR",
      "n/Users/m/repos/a/.claude/worktrees/x",
      "p102",
      "f4",
      "tREG",
      "n/Users/m/some-file",
      "p103",
      "f3",
      "tDIR",
      "n/Users/m/repos/b",
      "p104",
    ].join("\n");
    expect([...parseRootFds(raw)]).toEqual([[101, "/Users/m/repos/a/.claude/worktrees/x"]]);
  });
});

describe("parseSocketDirs", () => {
  test("the git dir of the one absolute IPC socket a pid holds; relative, foreign or ambiguous maps nothing", () => {
    const raw = [
      "p101",
      "f5",
      "n/Users/m/repos/a/.git/worktrees/x/fsmonitor--daemon.ipc",
      "f6",
      "n->0x1234",
      "p102",
      "f5",
      "nfsmonitor--daemon.ipc",
      "p103",
      "f5",
      "n/Users/m/.git-fsmonitor-abc123",
      "p104",
      "f5",
      "n/Users/m/repos/a/.git/fsmonitor--daemon.ipc",
      "f6",
      "n/Users/m/repos/b/.git/fsmonitor--daemon.ipc",
      "p105",
      "f5",
      "n/Users/m/repos/c/.git/fsmonitor--daemon.ipc",
      "f6",
      "n/Users/m/repos/c/.git/fsmonitor--daemon.ipc",
    ].join("\n");
    expect([...parseSocketDirs(raw)]).toEqual([
      [101, "/Users/m/repos/a/.git/worktrees/x"],
      [105, "/Users/m/repos/c/.git"],
    ]);
  });
});

describe("worktreeOfGitDir", () => {
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

  test("a git dir that is gone stands for itself", async () => {
    expect(await worktreeOfGitDir(join(base, "nowhere", ".git"))).toBe(join(base, "nowhere", ".git"));
  });

  test("a main clone's `.git` is inside its checkout; any other main git dir can't be told", async () => {
    await mkdir(join(base, "main", ".git"), { recursive: true });
    await mkdir(join(base, "gitdirs", "web.git"), { recursive: true });
    expect(await worktreeOfGitDir(join(base, "main", ".git"))).toBe(join(base, "main"));
    expect(await worktreeOfGitDir(join(base, "gitdirs", "web.git"))).toBeNull();
  });

  test("a linked git dir names its checkout, whether or not it is still there", async () => {
    const checkout = join(base, "deleted-checkout");
    expect(await worktreeOfGitDir(await linkedGitDir("deleted", checkout))).toBe(checkout);
  });

  test("a linked git dir whose `gitdir` can't be read can't be told", async () => {
    const gitDir = await linkedGitDir("unreadable", join(base, "whatever"));
    await rm(join(gitDir, "gitdir"));
    expect(await worktreeOfGitDir(gitDir)).toBeNull();
  });
});

test("macOS and Linux get the real seams; native Windows, not a séance platform, gets none", () => {
  expect(platformFsmonitor("darwin")).not.toBeNull();
  expect(platformFsmonitor("linux")).not.toBeNull();
  expect(platformFsmonitor("win32")).toBeNull();
});
