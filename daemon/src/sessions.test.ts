import { describe, expect, test } from "bun:test";
import type { RepoEntry } from "@seance/shared";
import { parsePanes, parseStuckWindows } from "./sessions.ts";
import { slugify } from "./spawn.ts";

const repos: readonly RepoEntry[] = [
  { name: "seance", path: "/Users/m/repos/seance", defaultBranch: "main" },
  { name: "api", path: "/Users/m/repos/api", defaultBranch: "main" },
];

function line(id: string, name: string, cmd: string, titled: "0" | "1", path: string, ours: "0" | "1" = "0"): string {
  return `${id}|${name}|${cmd}|${ours}|${titled}|${path}`;
}

describe("parsePanes", () => {
  test("a titled claude pane is a session under either name tmux gives the process", () => {
    const raw = [
      line("@1", "mac", "2.1.267", "1", "/Users/m/repos/seance"), // macOS: resolved binary's basename
      line("@2", "linux", "claude", "1", "/Users/m/repos/api"), // Linux/WSL: argv[0]
      line("@3", "martin", "zsh", "0", "/Users/m"),
    ].join("\n");
    expect(parsePanes(raw, repos).map((s) => s.window)).toEqual(["mac", "linux"]);
  });

  test("a claude on a startup dialog — process up, pane still untitled — is not a session", () => {
    expect(parsePanes(line("@1", "trust-me", "claude", "0", "/Users/m/repos/seance"), repos)).toEqual([]);
    expect(parsePanes(line("@2", "trust-me", "claude", "0", "/Users/m/repos/seance", "1"), repos)).toEqual([]);
  });

  test("a titled pane that is not claude is not a session either — an editor or shell that set one", () => {
    const raw = [line("@1", "edit", "vim", "1", "/Users/m/repos/seance"), line("@2", "sh", "zsh", "1", "/Users/m")];
    expect(parsePanes(raw.join("\n"), repos)).toEqual([]);
  });

  // The regression the reviewer caught: a dev server under a title-setting
  // shell is `node` + titled, and would have been listed with a repo mapping.
  test("a titled node pane séance did not start is a dev server, not a session", () => {
    expect(parsePanes(line("@1", "dev", "node", "1", "/Users/m/repos/api"), repos)).toEqual([]);
  });

  test("a séance window registers on the title alone, whatever tmux calls the process", () => {
    const raw = [
      line("@1", "npm-claude", "node", "1", "/Users/m/repos/api", "1"),
      line("@2", "mac-wrapped", "caffeinate", "1", "/Users/m/repos/seance", "1"),
    ].join("\n");
    expect(parsePanes(raw, repos).map((s) => s.window)).toEqual(["npm-claude", "mac-wrapped"]);
  });

  test("a tmux too old for the title format lists nothing rather than everything", () => {
    const literal = `@1|seance|claude|1|#{?pane_title,#{?#{==:#{pane_title},#{host}},0,1},0}|/Users/m/repos/seance`;
    expect(parsePanes(literal, repos)).toEqual([]);
  });

  test("dedups grouped-session repeats and split panes by window id", () => {
    const raw = [
      line("@1", "seance", "claude", "1", "/Users/m/repos/seance"),
      line("@1", "seance", "claude", "1", "/Users/m/repos/seance"),
      line("@1", "seance", "zsh", "0", "/Users/m/repos/seance"),
    ].join("\n");
    expect(parsePanes(raw, repos)).toHaveLength(1);
  });

  test("maps worktree paths back to their repo", () => {
    const raw = line("@3", "fix (wt)", "claude", "1", "/Users/m/repos/seance/.claude/worktrees/fix-123");
    const sessions = parsePanes(raw, repos);
    expect(sessions[0]?.repo).toBe("seance");
    expect(sessions[0]?.path).toContain("worktrees/fix-123");
  });

  test("repo is null outside every known repo", () => {
    const raw = line("@4", "scratch", "claude", "1", "/Users/m/elsewhere");
    expect(parsePanes(raw, repos)[0]?.repo).toBeNull();
  });

  test("prefix match does not cross sibling boundaries", () => {
    // /Users/m/repos/api-v2 must not match repo "api"
    const raw = line("@5", "x", "claude", "1", "/Users/m/repos/api-v2");
    expect(parsePanes(raw, repos)[0]?.repo).toBeNull();
  });

  test("a separator inside the path keeps the line parseable", () => {
    const raw = line("@6", "seance", "claude", "1", "/Users/m/repos/seance/a|b");
    expect(parsePanes(raw, repos)[0]?.path).toBe("/Users/m/repos/seance/a|b");
  });

  test("tolerates malformed lines and trailing newline", () => {
    expect(parsePanes("garbage\n\n", repos)).toEqual([]);
  });
});

function stuckLine(id: string, ours: string, dead: string, titled: string, name: string): string {
  return `${id}|${ours}|${dead}|${titled}|${name}`;
}

describe("parseStuckWindows", () => {
  test("flags a séance window that is alive but never titled its pane", () => {
    const raw = [stuckLine("@1", "1", "0", "0", "trust-me"), stuckLine("@2", "1", "0", "1", "running")].join("\n");
    expect(parseStuckWindows(raw)).toEqual(["trust-me"]);
  });

  test("ignores windows séance did not start — a hand-run shell is not stuck", () => {
    expect(parseStuckWindows(stuckLine("@3", "0", "0", "0", "martin"))).toEqual([]);
  });

  test("ignores a dead pane — that is the spawn-time claude_died path, already reported", () => {
    expect(parseStuckWindows(stuckLine("@4", "1", "1", "0", "died"))).toEqual([]);
  });

  test("a tmux too old for #{m:} matches nothing rather than flagging everything", () => {
    const literal = stuckLine("@5", "#{m:*--remote-control*,#{pane_start_command}}", "0", "0", "old-tmux");
    expect(parseStuckWindows(literal)).toEqual([]);
  });

  test("dedups split panes by window id and tolerates malformed lines", () => {
    const raw = [stuckLine("@6", "1", "0", "0", "one"), stuckLine("@6", "1", "0", "0", "one"), "garbage", ""];
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
