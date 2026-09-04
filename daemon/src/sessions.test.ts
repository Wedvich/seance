import { describe, expect, test } from "bun:test";
import type { RepoEntry } from "@seance/shared";
import { parsePanes, parseStuckWindows } from "./sessions.ts";
import { slugify } from "./spawn.ts";

const repos: readonly RepoEntry[] = [
  { name: "seance", path: "/Users/m/repos/seance", defaultBranch: "main" },
  { name: "api", path: "/Users/m/repos/api", defaultBranch: "main" },
];

function line(id: string, name: string, cmd: string, path: string): string {
  return `${id}|${name}|${cmd}|${path}`;
}

describe("parsePanes", () => {
  test("detects claude by version-string title, ignores shells", () => {
    const raw = [
      line("@1", "seance", "2.1.220", "/Users/m/repos/seance"),
      line("@2", "martin", "zsh", "/Users/m"),
    ].join("\n");
    const sessions = parsePanes(raw, repos);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.window).toBe("seance");
    expect(sessions[0]?.repo).toBe("seance");
  });

  test("dedups grouped-session repeats and split panes by window id", () => {
    const raw = [
      line("@1", "seance", "2.1.220", "/Users/m/repos/seance"),
      line("@1", "seance", "2.1.220", "/Users/m/repos/seance"),
      line("@1", "seance", "zsh", "/Users/m/repos/seance"),
    ].join("\n");
    expect(parsePanes(raw, repos)).toHaveLength(1);
  });

  test("maps worktree paths back to their repo", () => {
    const raw = line("@3", "fix (wt)", "2.1.220", "/Users/m/repos/seance/.claude/worktrees/fix-123");
    const sessions = parsePanes(raw, repos);
    expect(sessions[0]?.repo).toBe("seance");
    expect(sessions[0]?.path).toContain("worktrees/fix-123");
  });

  test("repo is null outside every known repo", () => {
    const raw = line("@4", "scratch", "2.1.220", "/Users/m/elsewhere");
    expect(parsePanes(raw, repos)[0]?.repo).toBeNull();
  });

  test("prefix match does not cross sibling boundaries", () => {
    // /Users/m/repos/api-v2 must not match repo "api"
    const raw = line("@5", "x", "2.1.220", "/Users/m/repos/api-v2");
    expect(parsePanes(raw, repos)[0]?.repo).toBeNull();
  });

  test("a separator inside the path keeps the line parseable", () => {
    const raw = line("@6", "seance", "2.1.220", "/Users/m/repos/seance/a|b");
    expect(parsePanes(raw, repos)[0]?.path).toBe("/Users/m/repos/seance/a|b");
  });

  test("tolerates malformed lines and trailing newline", () => {
    expect(parsePanes("garbage\n\n", repos)).toEqual([]);
  });
});

function stuckLine(id: string, ours: string, dead: string, cmd: string, name: string): string {
  return `${id}|${ours}|${dead}|${cmd}|${name}`;
}

describe("parseStuckWindows", () => {
  test("flags a séance window that is alive but never took the version title", () => {
    const raw = [
      stuckLine("@1", "1", "0", "claude", "trust-me"),
      stuckLine("@2", "1", "0", "2.1.220", "running"),
    ].join("\n");
    expect(parseStuckWindows(raw)).toEqual(["trust-me"]);
  });

  test("ignores windows séance did not start — a hand-run shell is not stuck", () => {
    expect(parseStuckWindows(stuckLine("@3", "0", "0", "zsh", "martin"))).toEqual([]);
  });

  test("ignores a dead pane — that is the spawn-time claude_died path, already reported", () => {
    expect(parseStuckWindows(stuckLine("@4", "1", "1", "claude", "died"))).toEqual([]);
  });

  test("a tmux too old for #{m:} matches nothing rather than flagging everything", () => {
    const literal = stuckLine("@5", "#{m:*--remote-control*,#{pane_start_command}}", "0", "claude", "old-tmux");
    expect(parseStuckWindows(literal)).toEqual([]);
  });

  test("dedups split panes by window id and tolerates malformed lines", () => {
    const raw = [stuckLine("@6", "1", "0", "claude", "one"), stuckLine("@6", "1", "0", "claude", "one"), "garbage", ""];
    expect(parseStuckWindows(raw.join("\n"))).toEqual(["one"]);
  });
});

describe("slugify", () => {
  test("ports the /spawn slug rules", () => {
    expect(slugify("Fix the flaky test!")).toBe("fix-the-flaky-test");
    expect(slugify("  --- ")).toBe("session");
    expect(slugify("")).toBe("session");
    expect(slugify("a".repeat(60))).toHaveLength(40);
    expect(slugify(`${"a".repeat(39)}-b`)).toBe("a".repeat(39));
  });
});
