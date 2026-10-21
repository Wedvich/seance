import { describe, expect, test } from "bun:test";
import type { RepoEntry } from "@seance/shared";
import { EXIT_PROMPT_SCREEN } from "../test/fixtures.ts";
import { paneRunningTask, parsePaneInfo, parsePanes, screenState, stuckWindows } from "./sessions.ts";
import { slugify } from "./spawn.ts";

const repos: readonly RepoEntry[] = [
  { name: "seance", path: "/Users/m/repos/seance", defaultBranch: "main" },
  { name: "api", path: "/Users/m/repos/api", defaultBranch: "main" },
];

function line(
  id: string,
  name: string,
  cmd: string,
  titled: "0" | "1",
  path: string,
  ours: "0" | "1" = "0",
  pane = `%${id.slice(1)}`,
  task = "",
): string {
  return `${pane}|${id}|${name}|${cmd}|${ours}|${titled}|${task}|${path}`;
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
    const literal = `%1|@1|seance|claude|1|#{?pane_title,#{?#{==:#{pane_title},#{host}},0,1},0}|/Users/m/repos/seance`;
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

  test("a session carries its claude pane's id, not the id of a split's first pane", () => {
    const raw = [
      line("@1", "seance", "zsh", "0", "/Users/m/repos/seance", "0", "%10"),
      line("@1", "seance", "claude", "1", "/Users/m/repos/seance", "0", "%11"),
    ].join("\n");
    expect(parsePanes(raw, repos).map((s) => s.id)).toEqual(["%11"]);
  });

  test("maps worktree paths back to their repo", () => {
    const raw = line("@3", "fix (wt)", "claude", "1", "/Users/m/repos/seance/.claude/worktrees/fix-123");
    const sessions = parsePanes(raw, repos);
    expect(sessions[0]?.repo).toBe("seance");
    expect(sessions[0]?.path).toContain("worktrees/fix-123");
  });

  test("a pane in a linked worktree goes to the repo sharing its common dir, wherever the worktree sits", () => {
    const links = {
      paneCommonDirs: new Map([["/Users/m/repos/api-pr633/src", "/Users/m/repos/api/.git"]]),
      repoCommonDirs: new Map([
        ["/Users/m/repos/seance", "/Users/m/repos/seance/.git"],
        ["/Users/m/repos/api", "/Users/m/repos/api/.git"],
      ]),
    };
    const raw = line("@7", "pr", "claude", "1", "/Users/m/repos/api-pr633/src");
    expect(parsePanes(raw, repos, links)[0]?.repo).toBe("api");
    expect(parsePanes(raw, repos)[0]?.repo).toBeNull(); // no prefix reaches a sibling worktree
  });

  // A worktree of an unregistered repo placed inside a registered one.
  test("a common dir no registered repo shares falls back to the path prefix", () => {
    const path = "/Users/m/repos/seance/vendor/lib-wt";
    const links = {
      paneCommonDirs: new Map([[path, "/Users/m/elsewhere/lib/.git"]]),
      repoCommonDirs: new Map([["/Users/m/repos/seance", "/Users/m/repos/seance/.git"]]),
    };
    expect(parsePanes(line("@8", "lib", "claude", "1", path), repos, links)[0]?.repo).toBe("seance");
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

  test("reports a spawn's taskId, and none for a pane without one or with a value no spawn could write", () => {
    const raw = [
      line("@1", "tracked", "claude", "1", "/Users/m/repos/seance", "1", "%1", "task-7f3a"),
      line("@2", "plain", "claude", "1", "/Users/m/repos/seance", "1", "%2"),
      line("@3", "forged", "claude", "1", "/Users/m/repos/seance", "1", "%3", "$(rm -rf ~)"),
    ].join("\n");
    const sessions = parsePanes(raw, repos);
    expect(sessions[0]?.taskId).toBe("task-7f3a");
    expect(sessions.slice(1).map((s) => "taskId" in s)).toEqual([false, false]);
  });
});

interface InfoLine {
  readonly pane: string;
  readonly window?: string;
  readonly cmd?: string;
  readonly ours?: string;
  readonly dead?: string;
  readonly deadTime?: string;
  readonly deadStatus?: string;
  readonly deadSignal?: string;
  readonly titled?: string;
  readonly name?: string;
  readonly task?: string;
  readonly path?: string;
}

/** One `list-panes` line in `PANE_INFO_FORMAT` order. */
function infoLine(fields: InfoLine): string {
  return [
    fields.pane,
    fields.window ?? "@1",
    fields.cmd ?? "claude",
    fields.ours ?? "1",
    fields.dead ?? "0",
    fields.deadTime ?? "",
    fields.deadStatus ?? "",
    fields.deadSignal ?? "",
    fields.titled ?? "1",
    fields.name ?? "task",
    fields.task ?? "",
    fields.path ?? "/Users/m/repos/seance",
  ].join("|");
}

describe("parsePaneInfo", () => {
  test("reads every field, with the death time in ms only for a dead pane", () => {
    const raw = [
      infoLine({ pane: "%1", window: "@1", name: "alive", deadTime: "1760000000" }),
      infoLine({ pane: "%2", window: "@2", name: "died", dead: "1", deadTime: "1760000000", titled: "0" }),
    ].join("\n");
    expect(parsePaneInfo(raw)).toEqual([
      {
        paneId: "%1",
        windowId: "@1",
        windowName: "alive",
        ours: true,
        dead: false,
        deadAt: null,
        deadStatus: null,
        titled: true,
        command: "claude",
        path: "/Users/m/repos/seance",
        taskId: null,
      },
      {
        paneId: "%2",
        windowId: "@2",
        windowName: "died",
        ours: true,
        dead: true,
        deadAt: 1_760_000_000_000,
        deadStatus: null,
        titled: false,
        command: "claude",
        path: "/Users/m/repos/seance",
        taskId: null,
      },
    ]);
  });

  test("an exit status only for a dead pane, and only one a process can exit with", () => {
    const status = (fields: Partial<InfoLine>): number | null | undefined =>
      parsePaneInfo(infoLine({ pane: "%1", ...fields }))[0]?.deadStatus;
    expect(status({ dead: "1", deadStatus: "3" })).toBe(3);
    expect(status({ dead: "1", deadStatus: "0" })).toBe(0);
    expect(status({ dead: "1", deadStatus: "" })).toBeNull();
    // A signal death reads as the shell reports it, 128 + signal.
    expect(status({ dead: "1", deadSignal: "9" })).toBe(137);
    expect(status({ dead: "1", deadSignal: "11" })).toBe(139);
    expect(status({ dead: "1", deadSignal: "0" })).toBeNull();
    expect(status({ dead: "1", deadSignal: "200" })).toBeNull();
    expect(status({ dead: "0", deadSignal: "9" })).toBeNull();
    expect(status({ dead: "1", deadStatus: "256" })).toBeNull();
    expect(status({ dead: "1", deadStatus: "-1" })).toBeNull();
    expect(status({ dead: "0", deadStatus: "1" })).toBeNull();
  });

  test("a dead pane on a tmux without pane_dead_time has no death time rather than a bogus one", () => {
    expect(parsePaneInfo(infoLine({ pane: "%1", dead: "1", deadTime: "" }))[0]?.deadAt).toBeNull();
  });

  test("dedups grouped-session repeats by pane id but keeps a split's panes apart", () => {
    const raw = [
      infoLine({ pane: "%1", window: "@1" }),
      infoLine({ pane: "%1", window: "@1" }),
      infoLine({ pane: "%2", window: "@1" }),
    ].join("\n");
    expect(parsePaneInfo(raw).map((pane) => pane.paneId)).toEqual(["%1", "%2"]);
  });

  test("a separator inside the path keeps the line parseable", () => {
    expect(parsePaneInfo(infoLine({ pane: "%1", path: "/tmp/a|b" }))[0]?.path).toBe("/tmp/a|b");
  });

  test("tolerates malformed lines and a trailing newline", () => {
    expect(parsePaneInfo("garbage\n%1|@1\n\n")).toEqual([]);
  });
});

describe("paneRunningTask", () => {
  test("finds the live pane carrying the task, registered or still starting", () => {
    const raw = [
      infoLine({ pane: "%1", window: "@1", task: "other" }),
      infoLine({ pane: "%2", window: "@2", task: "t1", titled: "0" }),
    ].join("\n");
    expect(paneRunningTask(parsePaneInfo(raw), "t1")?.paneId).toBe("%2");
  });

  test("a dead pane has finished with its task", () => {
    const panes = parsePaneInfo(infoLine({ pane: "%1", dead: "1", task: "t1" }));
    expect(paneRunningTask(panes, "t1")).toBeNull();
  });

  test("a pane without a task never matches", () => {
    expect(paneRunningTask(parsePaneInfo(infoLine({ pane: "%1" })), "t1")).toBeNull();
  });
});

describe("stuckWindows", () => {
  test("flags a séance window that is alive but never titled its pane", () => {
    const raw = [
      infoLine({ pane: "%1", window: "@1", titled: "0", name: "trust-me" }),
      infoLine({ pane: "%2", window: "@2", name: "running" }),
    ].join("\n");
    expect(stuckWindows(parsePaneInfo(raw))).toEqual(["trust-me"]);
  });

  test("ignores windows séance did not start — a hand-run shell is not stuck", () => {
    expect(stuckWindows(parsePaneInfo(infoLine({ pane: "%3", ours: "0", cmd: "zsh", titled: "0" })))).toEqual([]);
  });

  test("ignores a dead pane — that is the spawn-time claude_died path, already reported", () => {
    expect(stuckWindows(parsePaneInfo(infoLine({ pane: "%4", dead: "1", titled: "0" })))).toEqual([]);
  });

  test("a tmux too old for #{m:} matches nothing rather than flagging everything", () => {
    const literal = infoLine({ pane: "%5", ours: "#{m:*--remote-control*,#{pane_start_command}}", titled: "0" });
    expect(stuckWindows(parsePaneInfo(literal))).toEqual([]);
  });

  test("a window with no name is reported by its id — what an automatic name can be on macOS", () => {
    expect(stuckWindows(parsePaneInfo(infoLine({ pane: "%8", window: "@8", titled: "0", name: "" })))).toEqual(["@8"]);
  });

  test("dedups split panes by window id", () => {
    const raw = [
      infoLine({ pane: "%6", window: "@6", titled: "0", name: "one" }),
      infoLine({ pane: "%7", window: "@6", titled: "0", name: "one" }),
    ].join("\n");
    expect(stuckWindows(parsePaneInfo(raw))).toEqual(["one"]);
  });
});

const BACKGROUND_PROMPT = [
  " Background work is running",
  " The following will stop when you exit:",
  "   · bun run dev",
  "",
  " ❯ 1. Exit and stop tasks",
  "   2. Move to background and exit",
].join("\n");

describe("screenState", () => {
  test("recognises the worktree exit prompt", () => {
    expect(screenState(EXIT_PROMPT_SCREEN)).toBe("exit-prompt");
  });

  test("recognises the background-work prompt", () => {
    expect(screenState(BACKGROUND_PROMPT)).toBe("background-prompt");
  });

  test("a transcript that quotes the prompt is not the prompt — the options have to sit at the bottom", () => {
    const quoted = [
      EXIT_PROMPT_SCREEN,
      ...Array.from({ length: 10 }, (_, i) => `⏺ discussing the prompt, line ${i}`),
      "> ",
    ];
    expect(screenState(quoted.join("\n"))).toBeNull();
  });

  test("a quote whose options end just above claude's input box is not the prompt", () => {
    const quoted = [
      "⏺ The dialog reads:",
      "  Exiting worktree session",
      "  1. Keep worktree",
      "  2. Remove worktree",
      "────────────────",
      "> ",
      "────────────────",
      "  ? for shortcuts",
    ];
    expect(screenState(quoted.join("\n"))).toBeNull();
  });

  test("prose naming the background options is not the background prompt", () => {
    const prose = " Background work is running.\n Pick Exit and stop tasks\n or Move to background and exit";
    expect(screenState(prose)).toBeNull();
  });

  test("a prompt with the cursor moved off Keep is not one Enter may answer", () => {
    const onRemove = EXIT_PROMPT_SCREEN.replace("❯ 1. Keep worktree", "  1. Keep worktree").replace(
      "  2. Remove worktree",
      "❯ 2. Remove worktree",
    );
    expect(onRemove).toContain("❯ 2. Remove worktree");
    expect(screenState(onRemove)).toBeNull();
  });

  test("the heading alone, or the options alone, is not the prompt", () => {
    expect(screenState(" Exiting worktree session\n\n> ")).toBeNull();
    expect(screenState(" ❯ 1. Keep worktree\n   2. Remove worktree")).toBeNull();
  });

  test("an idle claude's screen reads as neither", () => {
    expect(screenState("⏺ Done.\n\n> \n  ? for shortcuts")).toBeNull();
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
