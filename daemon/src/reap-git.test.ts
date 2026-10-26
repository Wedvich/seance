import { describe, expect, test } from "bun:test";
import { parseBranches, parseWorktreeList, parseWorktreeLock, transcriptDir } from "./reap-git.ts";

/** `git worktree list --porcelain -z`: NUL after every attribute, an empty one ending each record. */
function porcelain(...records: readonly (readonly string[])[]): string {
  return records.map((fields) => `${fields.join("\0")}\0\0`).join("");
}

describe("parseWorktreeList", () => {
  test("reads the main worktree, a branch, a detached head, and the locked and prunable flags", () => {
    const raw = porcelain(
      ["worktree /r/main", "HEAD aaa", "branch refs/heads/main"],
      ["worktree /r/main/.claude/worktrees/fix", "HEAD bbb", "branch refs/heads/worktree-fix", "locked on a usb disk"],
      ["worktree /r/main-pr7", "HEAD ccc", "detached", "prunable gitdir file points to non-existent location"],
    );
    expect(parseWorktreeList(raw)).toEqual([
      { path: "/r/main", head: "aaa", branch: "main", locked: false, prunable: false },
      { path: "/r/main/.claude/worktrees/fix", head: "bbb", branch: "worktree-fix", locked: true, prunable: false },
      { path: "/r/main-pr7", head: "ccc", branch: null, locked: false, prunable: true },
    ]);
  });

  test("a path with spaces or a newline stays one path — the reason for -z", () => {
    const raw = porcelain(["worktree /r/odd name\nsecond line", "HEAD aaa", "branch refs/heads/odd", "locked"]);
    expect(parseWorktreeList(raw)).toEqual([
      { path: "/r/odd name\nsecond line", head: "aaa", branch: "odd", locked: true, prunable: false },
    ]);
  });

  test("a branch named like a path keeps its slashes", () => {
    const raw = porcelain(["worktree /r/x", "HEAD aaa", "branch refs/heads/feat/nested/name"]);
    expect(parseWorktreeList(raw)[0]?.branch).toBe("feat/nested/name");
  });

  test("a HEAD on a ref outside refs/heads/ is no branch, not one named like the ref", () => {
    const raw = porcelain(["worktree /r/x", "HEAD aaa", "branch refs/tags/v1"]);
    expect(parseWorktreeList(raw)[0]?.branch).toBeNull();
  });

  test("empty output is no worktrees, not a phantom one", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("parseBranches", () => {
  test("reads name, tip, whether an upstream is set, and whether it is gone", () => {
    const raw = [
      "refs/heads/main\0aaa\0\0refs/remotes/origin/main",
      "refs/heads/feat/x\0bbb\0[gone]\0refs/remotes/origin/feat/x",
      "refs/heads/ahead\0ccc\0[ahead 2]\0refs/remotes/origin/ahead",
      "refs/heads/local\0ddd\0\0",
      "",
    ].join("\n");
    expect(parseBranches(raw)).toEqual([
      { name: "main", sha: "aaa", upstreamGone: false, hasUpstream: true },
      { name: "feat/x", sha: "bbb", upstreamGone: true, hasUpstream: true },
      { name: "ahead", sha: "ccc", upstreamGone: false, hasUpstream: true },
      { name: "local", sha: "ddd", upstreamGone: false, hasUpstream: false },
    ]);
  });

  test("ignores anything that isn't a local branch", () => {
    expect(parseBranches("refs/tags/v1\0aaa\0\ngarbage")).toEqual([]);
  });
});

describe("transcriptDir", () => {
  test("is the path with every non-alphanumeric as a dash, under the Claude config dir", () => {
    const previous = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = "/cfg";
    try {
      expect(transcriptDir("/Users/m/repos/seance/.claude/worktrees/plan-reap")).toBe(
        "/cfg/projects/-Users-m-repos-seance--claude-worktrees-plan-reap",
      );
    } finally {
      if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = previous;
    }
  });
});

describe("parseWorktreeLock", () => {
  const raw = porcelain(
    ["worktree /r/main", "HEAD aaa", "branch refs/heads/main"],
    ["worktree /r/a", "HEAD bbb", "branch refs/heads/a", "locked claude session fix (pid 4242 start 646904935)"],
    ["worktree /r/b", "HEAD ccc", "detached", "locked"],
    ["worktree /r/odd\nname", "HEAD ddd", "detached", "locked on a usb disk"],
    ["worktree /r/short", "HEAD eee", "detached", "locked claude session fix (pid 4242)"],
  );

  test("gives the reason a worktree is locked with, an empty one when none was given, and null when unlocked", () => {
    expect(parseWorktreeLock(raw, "/r/a")).toEqual({ reason: "claude session fix (pid 4242 start 646904935)" });
    expect(parseWorktreeLock(raw, "/r/b")).toEqual({ reason: "" });
    expect(parseWorktreeLock(raw, "/r/main")).toBeNull();
    // The form Claude writes on Windows, with no start time.
    expect(parseWorktreeLock(raw, "/r/short")).toEqual({ reason: "claude session fix (pid 4242)" });
  });

  test("reads the record of the path asked for, newline in it included, and none for an unlisted path", () => {
    expect(parseWorktreeLock(raw, "/r/odd\nname")).toEqual({ reason: "on a usb disk" });
    expect(parseWorktreeLock(raw, "/r/elsewhere")).toBeNull();
  });
});
