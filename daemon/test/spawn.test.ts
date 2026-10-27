import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoEntry, SessionEntry, SpawnRequest } from "@seance/shared";
import { SpawnFailure, type SpawnOutcome } from "../src/backend.ts";
import { exec, git } from "../src/exec.ts";
import { scanRepos } from "../src/scan.ts";
import { LaunchLedger } from "../src/launch-ledger.ts";
import { reapAudit } from "../src/audit.ts";
import { despawnSession } from "../src/despawn.ts";
import { tmuxHarvestPanes } from "../src/exit-status.ts";
import { EndedTasks } from "../src/session-events.ts";
import { listClaudeSessions, paneInfo } from "../src/sessions.ts";
import { sessionName, spawnSession, type SpawnOptions } from "../src/spawn.ts";
import { FIELD_SEP, tmux, tmuxOk } from "../src/tmux.ts";
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

// A deadline, not a duration: the wait returns on the stub's title (0.3s after
// startup, which macOS can stretch under load), so a wide one adds no latency
// to a spawn that registers. Only the stuck stub ever runs it out, and it
// gets its own budget below. Each carries the fixture home, so pre-trust never
// reaches the developer's own config; set once `beforeAll` has made it.
let WAIT: SpawnOptions;
let STUCK_WAIT: SpawnOptions;
// Failure tests race the stub's actual death (0.3s sleep + process startup)
// against the deadline the same way; polling makes the width free.
let FAIL_WAIT: SpawnOptions;
let base: string;
let home: string;
let privateTmux: PrivateTmux | undefined;
let fixture: GitFixture;
let stub: ClaudeStub;
let repos: readonly RepoEntry[];

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-spawn-"));
  privateTmux = usePrivateTmux(base, "spawn");
  // A tag in the environment the private tmux server boots from — as when the
  // suite runs inside a séance session — which no window may inherit.
  process.env["SEANCE_MACHINE_TAG"] = "outer";
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "claude-config");
  home = join(base, "home");
  await mkdir(home, { recursive: true });
  WAIT = { tmuxSession: "main", waitMs: 5_000, home };
  STUCK_WAIT = { tmuxSession: "main", waitMs: 700, home };
  FAIL_WAIT = { tmuxSession: "main", waitMs: 5_000, home };
  fixture = await makeGitFixture(base);
  stub = await makeClaudeStub(base);
  process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
  repos = await scanRepos([fixture.root]);
});

afterAll(async () => {
  await privateTmux?.dispose();
  delete process.env["SEANCE_CLAUDE_BIN"];
  delete process.env["SEANCE_MACHINE_TAG"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  await rm(base, { recursive: true, force: true });
});

type TrustMap = Record<string, { hasTrustDialogAccepted?: boolean } | undefined>;

async function trustOf(claudeConfig: string): Promise<TrustMap> {
  const config = (await Bun.file(claudeConfig).json()) as { projects?: TrustMap };
  return config.projects ?? {};
}

describe("spawnSession (real tmux, real git, stub claude)", () => {
  test("scan found the fixture repo with its default branch", () => {
    expect(repos).toHaveLength(1);
    expect(repos[0]?.name).toBe("myrepo");
    expect(repos[0]?.defaultBranch).toBe("main");
  });

  // The worktree itself is claude's (`--worktree` branches from origin/<default>
  // unless the machine sets worktree.baseRef to "head"), and the stub never
  // creates one — so what is asserted here is the daemon's whole share: the
  // flag goes out, origin/<default> is fetched up to origin's tip, and the
  // checkout is otherwise left exactly as it was found.
  test("worktree spawn: passes --worktree, fetches the base, leaves HEAD, detection sees it", async () => {
    await fixture.advanceOrigin();
    const before = await headOf(fixture.repoPath);
    const beforeTracking = await headOf(fixture.repoPath, "origin/main");
    await rm(stub.argvFile, { force: true });

    const outcome = await spawnSession(
      { repo: "myrepo", mode: "worktree", title: "Fix Tests", prompt: "fix the tests" },
      repos,
      WAIT,
    );

    expect(outcome.window).toBe("Fix Tests");
    expect(outcome.path).toEndWith(join(".claude", "worktrees", "fix-tests"));
    expect(outcome.note).toBeUndefined();

    const argv = await stub.argv();
    expect(argv[argv.indexOf("--worktree") + 1]).toBe("fix-tests");

    // With origin ahead of the clone, both halves could move: the tracking ref
    // reaches origin's tip (the base claude will branch from), while HEAD stays
    // put — the deleted ff-only merge must not come back with the fetch.
    expect(await headOf(fixture.repoPath)).toBe(before);
    expect(await headOf(fixture.repoPath, "origin/main")).not.toBe(beforeTracking);
    expect(await headOf(fixture.repoPath, "origin/main")).toBe(await headOf(fixture.barePath, "main"));

    // the window exists in the main session and the pane survived
    const windows = await tmuxOk(["list-windows", "-t", "main", "-F", "#{window_name}"]);
    expect(windows).toContain("Fix Tests");

    // detection: the stub titled its pane, pane path is the repo → mapped
    expect(outcome.registered).toBe(true);
    const found = await waitForSession("Fix Tests");
    expect(found).toBeDefined();
    expect(found?.repo).toBe("myrepo");

    await tmux(["kill-window", "-t", "main:Fix Tests"]);
  });

  // The one case pane liveness and session detection disagree on: a claude
  // parked on a startup dialog is alive, so this is no failure, but it never
  // titles the pane and so never registers. The window is left for a human to
  // attach to, not killed — the ack reports it as pending.
  test("a claude that never titles its pane is alive but unregistered, and stays up", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.stuck;
    try {
      const outcome = await spawnSession({ repo: "myrepo", mode: "here", title: "Stuck" }, repos, STUCK_WAIT);
      expect(outcome.registered).toBe(false);
      const windows = await tmuxOk(["list-windows", "-t", "main", "-F", "#{window_name}"]);
      expect(windows).toContain("Stuck");
      expect((await listClaudeSessions(repos)).find((s) => s.window === "Stuck")).toBeUndefined();
      await killWindow(outcome.window);
    } finally {
      process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
    }
  });

  test("a title carrying the format separator stays detectable", async () => {
    const outcome = await spawnSession({ repo: "myrepo", mode: "here", title: "fix | build" }, repos, WAIT);
    expect(outcome.window).toBe("fix - build");

    expect((await waitForSession(outcome.window))?.repo).toBe("myrepo");

    // renamed outside séance, tmux substitutes the separator out of the format
    await tmuxOk(["rename-window", "-t", `main:${outcome.window}`, "a | b"]);
    expect((await waitForSession("a - b"))?.repo).toBe("myrepo");

    await tmux(["kill-window", "-t", "main:a - b"]);
  });

  test("here mode: launches at the repo root, no git preparation", async () => {
    const outcome = await spawnSession({ repo: "myrepo", mode: "here", title: "Here Now" }, repos, WAIT);
    expect(outcome.path).toBe(fixture.repoPath);
    await tmux(["kill-window", "-t", "main:Here Now"]);
  });

  test("spawn answers claude's trust dialog up front in its config", async () => {
    const claudeConfig = join(home, ".claude.json");
    await Bun.write(claudeConfig, JSON.stringify({ projects: {} }));

    const outcome = await spawnSession({ repo: "myrepo", mode: "here", title: "Trusting" }, repos, WAIT);

    expect((await trustOf(claudeConfig))[fixture.repoPath]?.hasTrustDialogAccepted).toBe(true);
    await tmux(["kill-window", "-t", `main:${outcome.window}`]);
  });

  // The owner's shell hook runs claude in a named exclave with that exclave's
  // config dir, so trust written anywhere else leaves the dialog up and the
  // session dead — whatever CLAUDE_CONFIG_DIR the daemon itself runs with.
  test("a repo in a named exclave is trusted in that exclave's config, not the default one", async () => {
    const workConfig = join(home, ".claude-work", ".claude.json");
    const defaultConfig = join(home, ".claude.json");
    await Bun.write(workConfig, JSON.stringify({ projects: {} }));
    await Bun.write(defaultConfig, JSON.stringify({ projects: {} }));
    const inWork = repos.map((repo) => ({ ...repo, exclave: "work" }));

    const outcome = await spawnSession({ repo: "myrepo", mode: "here", title: "In Work" }, inWork, WAIT);
    try {
      expect((await trustOf(workConfig))[fixture.repoPath]?.hasTrustDialogAccepted).toBe(true);
      expect((await trustOf(defaultConfig))[fixture.repoPath]).toBeUndefined();
    } finally {
      await tmux(["kill-window", "-t", `main:${outcome.window}`]);
    }
  });

  test("worktree name falls back to the prompt slug and dodges a leftover branch", async () => {
    await git(fixture.repoPath, ["branch", "worktree-reuse-the-name"]);
    try {
      const outcome = await spawnSession({ repo: "myrepo", mode: "worktree", prompt: "Reuse the name!" }, repos, WAIT);
      expect(outcome.path).toEndWith(join(".claude", "worktrees", "reuse-the-name-2"));
      expect(outcome.window).toBe("reuse-the-name-2");
      await killWindow(outcome.window);
    } finally {
      await git(fixture.repoPath, ["branch", "-D", "worktree-reuse-the-name"]);
    }
  });

  // The two states the old ff-only preparation refused to proceed cleanly from,
  // reporting a note that claimed the session would be based on the checkout.
  // Neither is the daemon's business now, and neither produces a note.
  test("dirty checkout: no note, and the working tree is left dirty", async () => {
    await Bun.write(join(fixture.repoPath, "README.md"), "# dirtied\n");
    try {
      const outcome = await spawnSession({ repo: "myrepo", mode: "worktree", title: "Dirty" }, repos, WAIT);
      expect(outcome.note).toBeUndefined();
      expect(await Bun.file(join(fixture.repoPath, "README.md")).text()).toBe("# dirtied\n");
      await tmux(["kill-window", "-t", "main:Dirty"]);
    } finally {
      await git(fixture.repoPath, ["checkout", "--", "README.md"]);
    }
  });

  test("checkout parked on a feature branch: no note, and it stays checked out", async () => {
    await git(fixture.repoPath, ["checkout", "-q", "-b", "side"]);
    try {
      const outcome = await spawnSession({ repo: "myrepo", mode: "worktree", title: "From Side" }, repos, WAIT);
      expect(outcome.note).toBeUndefined();
      expect((await git(fixture.repoPath, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("side");
      await killWindow(outcome.window);
    } finally {
      await git(fixture.repoPath, ["checkout", "-q", "main"]);
      await git(fixture.repoPath, ["branch", "-qD", "side"]);
    }
  });

  // Parallel spawns into one clone share a fetch: two racing for the tracking
  // ref's lock would leave the loser reporting a failure that never happened.
  test("parallel worktree spawns into one clone: both land on the fetched tip, no note", async () => {
    await fixture.advanceOrigin();
    const outcomes = await Promise.all(
      ["Twin A", "Twin B"].map((title) => spawnSession({ repo: "myrepo", mode: "worktree", title }, repos, WAIT)),
    );
    expect(outcomes.map((o) => o.note)).toEqual([undefined, undefined]);
    expect(await headOf(fixture.repoPath, "origin/main")).toBe(await headOf(fixture.barePath, "main"));
    await Promise.all(outcomes.map((o) => killWindow(o.window)));
  });

  // Offline or auth-less is no reason to refuse a spawn: it goes ahead on the
  // refs on disk, and the note is the only place the staleness can surface.
  test("unreachable origin: the spawn still lands, and the note says the base may be stale", async () => {
    // Own fetch first, so "last fetched" holds without an earlier test having fetched.
    await git(fixture.repoPath, ["fetch", "-q", "origin"]);
    await git(fixture.repoPath, ["remote", "set-url", "origin", join(base, "nowhere.git")]);
    try {
      const outcome = await spawnSession({ repo: "myrepo", mode: "worktree", title: "Offline" }, repos, WAIT);
      expect(outcome.registered).toBe(true);
      expect(outcome.note).toContain("couldn't fetch origin/main");
      expect(outcome.note).toContain("last fetched");
      await killWindow(outcome.window);
    } finally {
      await git(fixture.repoPath, ["remote", "set-url", "origin", fixture.barePath]);
    }
  });

  test("here spawn on a checkout behind origin: notes how far, and never moves HEAD", async () => {
    await fixture.advanceOrigin();
    const before = await headOf(fixture.repoPath);
    const outcome = await spawnSession({ repo: "myrepo", mode: "here", title: "Behind" }, repos, WAIT);
    const behind = (await git(fixture.repoPath, ["rev-list", "--count", "HEAD..origin/main"])).stdout.trim();
    expect(Number(behind)).toBeGreaterThan(0);
    expect(outcome.note).toContain(`${behind} commit`);
    expect(await headOf(fixture.repoPath)).toBe(before);
    expect(await headOf(fixture.repoPath, "origin/main")).toBe(await headOf(fixture.barePath, "main"));
    await killWindow(outcome.window);
  });

  // "Behind" is measured against the default branch, so a checkout on any
  // other branch has nothing to measure — and no fetch is worth running for it.
  test("here spawn on a feature branch: no fetch, no note", async () => {
    await fixture.advanceOrigin();
    const beforeTracking = await headOf(fixture.repoPath, "origin/main");
    await git(fixture.repoPath, ["checkout", "-q", "-b", "side-here"]);
    try {
      const outcome = await spawnSession({ repo: "myrepo", mode: "here", title: "Side Here" }, repos, WAIT);
      expect(outcome.note).toBeUndefined();
      expect(await headOf(fixture.repoPath, "origin/main")).toBe(beforeTracking);
      await killWindow(outcome.window);
    } finally {
      await git(fixture.repoPath, ["checkout", "-q", "main"]);
      await git(fixture.repoPath, ["branch", "-qD", "side-here"]);
    }
  });

  test("claude exiting nonzero is claude_died with the captured error, window killed", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.failing;
    try {
      await expect(spawnSession({ repo: "myrepo", mode: "here", title: "Doomed" }, repos, FAIL_WAIT)).rejects.toThrow(
        SpawnFailure,
      );
      try {
        await spawnSession({ repo: "myrepo", mode: "here", title: "Doomed" }, repos, FAIL_WAIT);
      } catch (err) {
        expect((err as SpawnFailure).code).toBe("claude_died");
        expect((err as SpawnFailure).message).toContain("boom: untrusted workspace");
      }
      const windows = await tmuxOk(["list-windows", "-t", "main", "-F", "#{window_name}"]);
      expect(windows).not.toContain("Doomed");
    } finally {
      process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
    }
  });

  test("unknown repo is repo_not_found", async () => {
    try {
      await spawnSession({ repo: "nope", mode: "worktree" }, repos, WAIT);
      expect.unreachable();
    } catch (err) {
      expect((err as SpawnFailure).code).toBe("repo_not_found");
    }
  });

  // Was `unreachable origin is fetch_failed`. The daemon no longer fetches, so
  // an unreachable remote is claude's to report: it warns and falls back to the
  // local HEAD inside the pane. `fetch_failed` stays a wire code for daemons a
  // version behind — the PWA still has copy for it.
  test("an unreachable origin no longer concerns the daemon", async () => {
    await git(fixture.repoPath, ["remote", "set-url", "origin", "/nonexistent/origin.git"]);
    try {
      const outcome = await spawnSession({ repo: "myrepo", mode: "worktree", title: "NoNet" }, repos, WAIT);
      expect(outcome.path).toEndWith(join(".claude", "worktrees", "nonet"));
      await killWindow(outcome.window);
    } finally {
      await git(fixture.repoPath, ["remote", "set-url", "origin", fixture.barePath]);
    }
  });

  test("seed prompt reaches claude on stdin, quotes and all — never argv", async () => {
    await rm(stub.argvFile, { force: true });
    await rm(stub.stdinFile, { force: true });
    const prompt = "tricky 'quoted' $prompt";
    const outcome = await spawnSession({ repo: "myrepo", mode: "here", title: "Seeded", prompt }, repos, WAIT);
    try {
      expect(await stub.stdin()).toEndWith(`Task: ${prompt}\n`);
      const argv = await stub.argv();
      // The finding this pins: an argv operand is the prompt in plaintext in
      // every local process list for the session's lifetime, readable by any
      // process the user runs — including a prompt-injected session.
      expect(argv.join("\0")).not.toContain("tricky");
      // `--remote-control [name]` takes an optional value, and a here-mode seed
      // adjacent to it became the session's *name* — the session started idle
      // with the prompt in the title. Nothing trails the terminator now.
      expect(argv.at(-1)).toBe("--");
      // tmux keeps the pane's start command for as long as the pane lives, so
      // the shell string is a second process-table-grade record: it may name
      // the seed file, never quote its contents.
      const paneCommands = await tmuxOk(["list-panes", "-a", "-F", "#{pane_start_command}"]);
      expect(paneCommands).not.toContain("tricky");
    } finally {
      await killWindow(outcome.window);
    }
  });

  test("an unseeded spawn leaves stdin alone — the pane's tty, not a file", async () => {
    await rm(stub.stdinFile, { force: true });
    const outcome = await spawnSession({ repo: "myrepo", mode: "here", title: "Unseeded" }, repos, WAIT);
    try {
      // Negative assertion: nothing to poll for, and the spawn already waited
      // out WAIT. A recorded stdin here would mean the pane lost its keyboard.
      expect(await Bun.file(stub.stdinFile).exists()).toBe(false);
    } finally {
      await killWindow(outcome.window);
    }
  });

  test("machineTag suffixes the remote-control name and leaves the tmux window bare", async () => {
    await rm(stub.argvFile, { force: true });
    const outcome = await spawnSession({ repo: "myrepo", mode: "here", title: "Tagged Run" }, repos, {
      ...WAIT,
      machineTag: "thad",
    });
    try {
      const argv = await stub.argv();
      expect(argv[argv.indexOf("-n") + 1]).toBe("tagged-run (thad)");
      // What the tmux-rename mod strips off a /rename: the suffix exactly as named.
      expect(await stub.machineTag()).toBe("thad");
      // The window is local; the machine is never in question there.
      expect(outcome.window).toBe("Tagged Run");
      const windows = await tmuxOk(["list-windows", "-t", "main", "-F", "#{window_name}"]);
      expect(windows).toContain("Tagged Run");
      expect(windows).not.toContain("(thad)");
    } finally {
      await killWindow(outcome.window);
    }
  });

  test("plan mode passes --permission-mode plan, and every other spawn passes no mode at all", async () => {
    await rm(stub.argvFile, { force: true });
    const planned = await spawnSession({ repo: "myrepo", mode: "here", title: "Planned", plan: true }, repos, WAIT);
    try {
      const argv = await stub.argv();
      expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");
      // untagged machine: set empty, so the server's "outer" never leaks through
      expect(await stub.machineTag()).toBe("");
    } finally {
      await killWindow(planned.window);
    }

    // The regression guard for the PWA, the CLI and every pre-`plan` client:
    // omitting the field must leave the machine's own settings.json in charge.
    await rm(stub.argvFile, { force: true });
    const ambient = await spawnSession({ repo: "myrepo", mode: "here", title: "Ambient" }, repos, WAIT);
    try {
      expect(await stub.argv()).not.toContain("--permission-mode");
    } finally {
      await killWindow(ambient.window);
    }
  });

  test("a taskId rides the pane: listed with the session, and a second spawn for it is refused with that pane", async () => {
    const first = await spawnSession(
      { repo: "myrepo", mode: "here", title: "Task One", taskId: "task-1" },
      repos,
      WAIT,
    );
    try {
      const listed = await waitForSession(first.window);
      expect(listed?.taskId).toBe("task-1");
      // Where it lives is the point: tmux holds it, so a restarted daemon reads the same answer.
      const option = await tmuxOk(["show-options", "-p", "-v", "-t", listed?.id ?? "", "@seance-task"]);
      expect(option.trim()).toBe("task-1");

      // The first spawn has settled, so nothing in-process remembers the task — this refusal is read off tmux.
      const refused = await spawnSession(
        { repo: "myrepo", mode: "here", title: "Task Dup", taskId: "task-1" },
        repos,
        WAIT,
      ).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(SpawnFailure);
      expect(refused).toMatchObject({ code: "task_running", id: listed?.id });
      // Refused before new-window, so there is no window to wait out.
      expect(await tmuxOk(["list-windows", "-t", "main", "-F", "#{window_name}"])).not.toContain("Task Dup");
    } finally {
      await killWindow(first.window);
    }

    // Once the session is gone the task is free again: a re-dispatch after it ended is no duplicate.
    const again = await spawnSession(
      { repo: "myrepo", mode: "here", title: "Task Again", taskId: "task-1" },
      repos,
      WAIT,
    );
    await killWindow(again.window);
  });

  test("a task session's nonzero exit stays on its dead pane until noted, then the pane goes; a clean exit is recorded by its hook, closes, and is noted as 0", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.repl;
    const ledger = LaunchLedger.memory();
    const audited: string[] = [];
    const tasks = new EndedTasks(
      ledger,
      Date.now,
      tmuxHarvestPanes(reapAudit("harvest", (line) => void audited.push(line))),
    );
    try {
      await ledger.record("task-crash");
      await ledger.record("task-clean");
      const crashed = await spawnSession(
        { repo: "myrepo", mode: "here", title: "Task Crash", taskId: "task-crash" },
        repos,
        WAIT,
      );
      const pane = (await waitForSession(crashed.window))?.id ?? "";
      await tmux(["send-keys", "-t", pane, "-l", "/crash 3"]);
      await tmux(["send-keys", "-t", pane, "Enter"]);
      await pollUntil(async () => (await paneInfo(pane))?.dead === true, `pane ${pane} dead`);
      expect((await paneInfo(pane))?.deadStatus).toBe(3);

      await tasks.harvestExits();
      expect(tasks.progress()).toEqual([expect.objectContaining({ taskId: "task-crash", exit: 3 })]);
      expect(await paneInfo(pane)).toBeNull();
      expect(audited).toEqual([expect.stringContaining(`audit reap origin=harvest closed-pane pane=${pane} `)]);

      const clean = await spawnSession(
        { repo: "myrepo", mode: "here", title: "Task Clean", taskId: "task-clean" },
        repos,
        WAIT,
      );
      const cleanPane = (await waitForSession(clean.window))?.id ?? "";
      await tmux(["send-keys", "-t", cleanPane, "-l", "/exit"]);
      await tmux(["send-keys", "-t", cleanPane, "Enter"]);
      await pollUntil(async () => (await paneInfo(cleanPane)) === null, `pane ${cleanPane} closed`);
      // The hook recorded the status before it closed the pane, so closing it from outside cannot lose it.
      expect((await tmuxOk(["show-options", "-g", "-v", "@seance-exit-task-clean"])).trim()).toBe("0:");
      await tasks.harvestExits();
      expect(tasks.progress()).toContainEqual(expect.objectContaining({ taskId: "task-clean", exit: 0 }));
      expect(tasks.progress().find((p) => p.taskId === "task-clean")?.vanished).toBeUndefined();
      expect((await tmux(["show-options", "-g", "-v", "@seance-exit-task-clean"])).exitCode).not.toBe(0);
    } finally {
      process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
      await killWindow("Task Crash");
      await killWindow("Task Clean");
    }
  });

  /** `spawnSession` the way `handleSpawn` does for a task: recorded first, then settled with the server pid. */
  async function launchTask(
    tasks: EndedTasks,
    taskId: string,
    title: string,
  ): Promise<{ pane: string; outcome: SpawnOutcome }> {
    const settle = await tasks.launch(taskId);
    const outcome = await spawnSession({ repo: "myrepo", mode: "here", title, taskId }, repos, WAIT);
    await settle(true, outcome.server === undefined ? {} : { server: outcome.server });
    return { pane: (await waitForSession(outcome.window))?.id ?? "", outcome };
  }

  test("a task window keeps remain-on-exit on, hooks only its own pane, and leaves the global hooks alone; a non-task window gets off", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.repl;
    const tasks = new EndedTasks(LaunchLedger.memory(), Date.now, tmuxHarvestPanes(reapAudit("harvest", () => {})));
    try {
      // The first spawn boots the private server.
      const plain = await spawnSession({ repo: "myrepo", mode: "here", title: "Plain Window" }, repos, WAIT);
      const before = await tmuxOk(["show-hooks", "-g"]);
      const { pane, outcome } = await launchTask(tasks, "task-hooked", "Task Hooked");
      expect(outcome.server).toBe(Number((await tmuxOk(["display-message", "-p", "#{pid}"])).trim()));
      expect(await tmuxOk(["show-hooks", "-g"])).toBe(before);
      expect(await tmuxOk(["show-hooks", "-p", "-t", pane])).toContain("pane-died");
      expect((await tmuxOk(["show-options", "-w", "-v", "-t", pane, "remain-on-exit"])).trim()).toBe("on");
      expect((await tmuxOk(["show-options", "-p", "-v", "-t", pane, "remain-on-exit"])).trim()).toBe("on");

      const plainPane = (await waitForSession(plain.window))?.id ?? "";
      expect((await tmuxOk(["show-options", "-w", "-v", "-t", plainPane, "remain-on-exit"])).trim()).toBe("off");
      expect(plain.server).toBeUndefined();
      await tmux(["kill-window", "-t", plainPane]);
    } finally {
      process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
      await killWindow("Task Hooked");
    }
  });

  test("a task id outside the id pattern gets no hook and no server, and its window still keeps its dead pane", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.repl;
    const odd = "bad id'; kill-server";
    try {
      const outcome = await spawnSession({ repo: "myrepo", mode: "here", title: "Task Odd", taskId: odd }, repos, WAIT);
      const pane = (await waitForSession(outcome.window))?.id ?? "";
      expect(outcome.server).toBeUndefined();
      expect(await tmuxOk(["show-hooks", "-p", "-t", pane])).not.toContain("pane-died");
      await tmux(["send-keys", "-t", pane, "-l", "/exit"]);
      await tmux(["send-keys", "-t", pane, "Enter"]);
      await pollUntil(async () => (await paneInfo(pane))?.dead === true, `pane ${pane} dead`);
      expect((await paneInfo(pane))?.deadStatus).toBe(0);
    } finally {
      process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
      await killWindow("Task Odd");
    }
  });

  test("a task window killed while alive is noted vanished; one despawned through closing, or one that exited, is not", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.repl;
    const tasks = new EndedTasks(LaunchLedger.memory(), Date.now, tmuxHarvestPanes(reapAudit("harvest", () => {})));
    try {
      const killed = await launchTask(tasks, "task-vanish", "Task Vanish");
      const despawned = await launchTask(tasks, "task-despawn", "Task Despawn");
      const exited = await launchTask(tasks, "task-exited", "Task Exited");
      const crashed = await launchTask(tasks, "task-crashed", "Task Crashed");
      await tasks.harvestExits();
      expect(tasks.progress()).toEqual([]);

      await tmuxOk(["kill-window", "-t", killed.pane]);
      await despawnSession(despawned.pane, { force: true, closing: (id) => tasks.closing(id) });
      await tmux(["send-keys", "-t", exited.pane, "-l", "/exit"]);
      await tmux(["send-keys", "-t", exited.pane, "Enter"]);
      await tmux(["send-keys", "-t", crashed.pane, "-l", "/crash 4"]);
      await tmux(["send-keys", "-t", crashed.pane, "Enter"]);
      await pollUntil(async () => (await paneInfo(exited.pane)) === null, `pane ${exited.pane} closed`);
      await pollUntil(async () => (await paneInfo(crashed.pane))?.dead === true, `pane ${crashed.pane} dead`);

      await pollUntil(async () => {
        await tasks.harvestExits();
        return tasks.progress().some((p) => p.taskId === "task-vanish" && p.vanished === true);
      }, "task-vanish noted vanished");
      const progress = tasks.progress();
      expect(progress.filter((p) => p.vanished === true).map((p) => p.taskId)).toEqual(["task-vanish"]);
      expect(progress.find((p) => p.taskId === "task-exited")).toMatchObject({ exit: 0 });
      expect(progress.find((p) => p.taskId === "task-crashed")).toMatchObject({ exit: 4 });
      expect(progress.find((p) => p.taskId === "task-despawn")?.vanished).toBeUndefined();
    } finally {
      process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
      for (const title of ["Task Vanish", "Task Despawn", "Task Exited", "Task Crashed"]) await killWindow(title);
    }
  });

  test("a task pane joined into a window with remain-on-exit off keeps its own on and its hook: a clean exit is still recorded", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.repl;
    const tasks = new EndedTasks(LaunchLedger.memory(), Date.now, tmuxHarvestPanes(reapAudit("harvest", () => {})));
    try {
      const plain = await spawnSession({ repo: "myrepo", mode: "here", title: "Plain Join" }, repos, WAIT);
      const plainPane = (await waitForSession(plain.window))?.id ?? "";
      const { pane } = await launchTask(tasks, "task-joined", "Task Joined");
      await tmuxOk(["join-pane", "-d", "-s", pane, "-t", plainPane]);
      expect((await tmuxOk(["show-options", "-w", "-v", "-t", plainPane, "remain-on-exit"])).trim()).toBe("off");
      expect((await tmuxOk(["show-options", "-p", "-v", "-t", pane, "remain-on-exit"])).trim()).toBe("on");
      expect(await tmuxOk(["show-hooks", "-p", "-t", pane])).toContain("pane-died");

      await tmux(["send-keys", "-t", pane, "-l", "/exit"]);
      await tmux(["send-keys", "-t", pane, "Enter"]);
      await pollUntil(async () => (await paneInfo(pane)) === null, `pane ${pane} closed by its hook`);
      expect((await tmuxOk(["show-options", "-g", "-v", "@seance-exit-task-joined"])).trim()).toBe("0:");
      await tasks.harvestExits();
      expect(tasks.progress().find((p) => p.taskId === "task-joined")).toMatchObject({ exit: 0 });
    } finally {
      process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
      await killWindow("Plain Join");
      await killWindow("Task Joined");
    }
  });

  test.each([
    ["alone", false],
    ["in a session group", true],
  ])(
    "a clean exit of the server's last pane (%s) leaves the dead pane: the server stays up and the exit is noted, not vanished",
    async (name, grouped) => {
      process.env["SEANCE_CLAUDE_BIN"] = stub.repl;
      const shared = process.env["SEANCE_TMUX_SOCKET"];
      const alone = usePrivateTmux(base, `spawn-last-${grouped ? "group" : "alone"}`);
      try {
        const tasks = new EndedTasks(LaunchLedger.memory(), Date.now, tmuxHarvestPanes(reapAudit("harvest", () => {})));
        const { pane, outcome } = await launchTask(tasks, "task-last", "Task Last");
        // A fresh server boots with a bootstrap pane of its own: drop it, so the task's is the only one.
        for (const other of (await tmuxOk(["list-panes", "-a", "-F", "#{pane_id}"])).split("\n")) {
          // oxlint-disable-next-line no-await-in-loop -- one pane at a time
          if (other !== "" && other !== pane) await tmuxOk(["kill-pane", "-t", other]);
        }
        expect((await tmuxOk(["list-panes", "-a", "-F", "#{pane_id}"])).trim()).toBe(pane);
        if (grouped) {
          // A grouped sibling counts in `server_sessions` but shares the one window.
          const session = (await tmuxOk(["display-message", "-p", "-t", pane, "#{session_name}"])).trim();
          await tmuxOk(["new-session", "-d", "-t", session, "-s", `${name.replaceAll(" ", "-")}-sibling`]);
        }
        await tmux(["send-keys", "-t", pane, "-l", "/exit"]);
        await tmux(["send-keys", "-t", pane, "Enter"]);
        await pollUntil(async () => (await paneInfo(pane))?.dead === true, `pane ${pane} dead`);
        // Killed by the hook, the server would have exited with the option it just recorded.
        expect(Number((await tmuxOk(["display-message", "-p", "#{pid}"])).trim())).toBe(outcome.server ?? -1);
        expect((await paneInfo(pane))?.deadStatus).toBe(0);
        await tasks.harvestExits();
        expect(tasks.progress().find((p) => p.taskId === "task-last")).toMatchObject({ exit: 0 });
        expect(tasks.progress().find((p) => p.taskId === "task-last")?.vanished).toBeUndefined();
      } finally {
        process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
        await alone.dispose();
        if (shared !== undefined) process.env["SEANCE_TMUX_SOCKET"] = shared;
      }
    },
  );

  test("despawn notes closing, and waits for it, before it touches a task's pane", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.repl;
    const tasks = new EndedTasks(LaunchLedger.memory(), Date.now, tmuxHarvestPanes(reapAudit("harvest", () => {})));
    try {
      const { pane } = await launchTask(tasks, "task-order", "Task Order");
      const events: string[] = [];
      await despawnSession(pane, {
        force: true,
        closing: async (taskId) => {
          events.push(`closing ${taskId}`);
          // Long enough for a kill that did not wait for us to land.
          await Bun.sleep(300);
          events.push(`pane alive ${(await paneInfo(pane)) !== null}`);
        },
      });
      events.push(`pane alive ${(await paneInfo(pane)) !== null}`);
      expect(events).toEqual(["closing task-order", "pane alive true", "pane alive false"]);
    } finally {
      process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
      await killWindow("Task Order");
    }
  });

  test("a task session killed by a signal reads as 128 + the signal, as a shell reports it", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.repl;
    const ledger = LaunchLedger.memory();
    const tasks = new EndedTasks(ledger, Date.now, tmuxHarvestPanes(reapAudit("harvest", () => {})));
    try {
      await ledger.record("task-kill");
      const killed = await spawnSession(
        { repo: "myrepo", mode: "here", title: "Task Kill", taskId: "task-kill" },
        repos,
        WAIT,
      );
      const pane = (await waitForSession(killed.window))?.id ?? "";
      await tmux(["send-keys", "-t", pane, "-l", "/kill 9"]);
      await tmux(["send-keys", "-t", pane, "Enter"]);
      await pollUntil(async () => (await paneInfo(pane))?.dead === true, `pane ${pane} dead`);
      expect((await paneInfo(pane))?.deadStatus).toBe(137);

      await tasks.harvestExits();
      expect(tasks.progress()).toEqual([expect.objectContaining({ taskId: "task-kill", exit: 137 })]);
      expect(await paneInfo(pane)).toBeNull();
    } finally {
      process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
      await killWindow("Task Kill");
    }
  });

  test("two concurrent spawns for one task start exactly one session", async () => {
    const results = await Promise.allSettled(
      ["Race A", "Race B"].map((title) =>
        spawnSession({ repo: "myrepo", mode: "here", title, taskId: "race" }, repos, WAIT),
      ),
    );
    try {
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const refused = results.find((r) => r.status === "rejected");
      expect(refused?.status === "rejected" ? refused.reason : null).toMatchObject({ code: "task_running" });
    } finally {
      await Promise.all(results.map((r) => (r.status === "fulfilled" ? killWindow(r.value.window) : undefined)));
    }
  });

  test("a spawn without a taskId tags nothing", async () => {
    const outcome = await spawnSession({ repo: "myrepo", mode: "here", title: "Untracked" }, repos, WAIT);
    try {
      const listed = await waitForSession(outcome.window);
      expect(listed).toBeDefined();
      expect(listed !== undefined && "taskId" in listed).toBe(false);
    } finally {
      await killWindow(outcome.window);
    }
  });

  // The `~/pengefix/<repo>-<name>` layout: a hand-made worktree beside the clone,
  // which the scan no longer registers, so no path prefix can attribute it.
  test("a claude in a sibling worktree is listed under the main clone's repo", async () => {
    const sibling = join(fixture.root, "myrepo-pr633");
    await addWorktree(fixture.repoPath, sibling);
    try {
      expect((await scanRepos([fixture.root])).map((r) => r.name)).toEqual(["myrepo"]);
      await tmuxOk(["new-session", "-d", "-s", "sibling", "-n", "Sibling", "-c", sibling, stub.ok]);
      const found = await waitForSession("Sibling");
      expect(found?.path).toBe(await realpath(sibling));
      expect(found?.repo).toBe("myrepo");
    } finally {
      await tmux(["kill-session", "-t", "sibling"]);
      await git(fixture.repoPath, ["worktree", "remove", "--force", sibling]);
      // The fixture repo is shared by the whole file; leave no branch behind.
      await git(fixture.repoPath, ["branch", "-D", "wt-myrepo-pr633"]);
    }
  });
});

// A scheduler continuation resumes a failed task's conversation in the worktree its
// launch ledger noted (DESIGN.md, Daemon, "Continuing a session"). The handler
// resolves and checks the path; this is the spawn half, against a real worktree and tmux.
describe("spawnSession continuing a failed task's session", () => {
  const OLD = "cont-old";
  let seq = 0;

  /** A linked worktree under the clone's `.claude/worktrees/`, as claude's `--worktree` leaves one. */
  async function makeWorktree(): Promise<{ readonly name: string; readonly path: string }> {
    seq += 1;
    const name = `cont-${seq}`;
    const raw = join(fixture.repoPath, ".claude", "worktrees", name);
    await addWorktree(fixture.repoPath, raw);
    return { name, path: await realpath(raw) };
  }

  async function dropWorktree(wt: { readonly name: string; readonly path: string }): Promise<void> {
    // Twice: a locked worktree takes `--force` twice, and an unlocked one takes the first.
    await git(fixture.repoPath, ["worktree", "remove", "--force", "--force", wt.path]);
    await git(fixture.repoPath, ["branch", "-D", `wt-${wt.name}`]);
  }

  const continuing = (
    wt: { readonly path: string },
    extra: Partial<SpawnRequest> = {},
    exit?: number,
  ): Promise<SpawnOutcome> =>
    spawnSession(
      {
        repo: "myrepo",
        mode: "continue",
        title: "Cont",
        taskId: `cont-new-${seq}`,
        continues: OLD,
        client: "scheduler",
        ...extra,
      },
      repos,
      WAIT,
      { path: wt.path, ...(exit === undefined ? {} : { exit }) },
    );

  const lockedOf = async (wt: { readonly path: string }): Promise<boolean> => {
    const listed = (await git(fixture.repoPath, ["worktree", "list", "--porcelain"])).stdout;
    const record = listed.split("\n\n").find((r) => r.includes(`worktree ${wt.path}`));
    return record?.includes("\nlocked") === true;
  };

  test("resumes with --continue in the worktree, never --worktree; the pane is that directory, tagged with the new task", async () => {
    const wt = await makeWorktree();
    await rm(stub.argvFile, { force: true });
    await rm(stub.stdinFile, { force: true });
    const claudeConfig = join(home, ".claude.json");
    await Bun.write(claudeConfig, JSON.stringify({ projects: {} }));
    await fixture.advanceOrigin();
    const beforeTracking = await headOf(fixture.repoPath, "origin/main");
    let outcome: SpawnOutcome | undefined;
    try {
      outcome = await continuing(wt, { title: "Cont A", prompt: "the tests still fail" }, 137);
      expect(outcome.path).toBe(wt.path);
      expect(outcome.window).toBe("Cont A");
      const argv = await stub.argv();
      expect(argv).toContain("--continue");
      expect(argv).not.toContain("--worktree");
      // Before the terminator: after it, claude would read it as part of the prompt.
      expect(argv.indexOf("--continue")).toBeLessThan(argv.indexOf("--"));
      expect(argv.at(-1)).toBe("--");
      // The name is the worktree's: no new one is minted for a session that already has a history.
      expect(argv[argv.indexOf("-n") + 1]).toBe(wt.name);

      // Told what happened, and the user's note, over stdin: never argv.
      const seed = await stub.stdin();
      expect(seed).toStartWith(`This session was resumed by séance in the same git worktree at ${wt.path}`);
      expect(seed).toContain("ended unexpectedly");
      expect(seed).toContain("processes it started in the background may still be running");
      expect(seed).toEndWith("\n\nFrom the user: the tests still fail\n");
      expect(argv.join("\0")).not.toContain("still fail");

      const listed = await waitForSession("Cont A");
      expect(listed?.path).toBe(wt.path);
      expect(listed?.taskId).toBe(`cont-new-${seq}`);
      // The worktree's own path is what claude's dialog asks about.
      expect((await trustOf(claudeConfig))[wt.path]?.hasTrustDialogAccepted).toBe(true);
      // Nothing is fetched: the session picks up what the dead one left, not a fresh base.
      expect(await headOf(fixture.repoPath, "origin/main")).toBe(beforeTracking);
    } finally {
      if (outcome !== undefined) await killWindow(outcome.window);
      await dropWorktree(wt);
    }
  });

  test("with no note the seed is the preamble alone — a resume is always seeded, so claude's stale-resume dialog never opens", async () => {
    const wt = await makeWorktree();
    await rm(stub.stdinFile, { force: true });
    let outcome: SpawnOutcome | undefined;
    try {
      outcome = await continuing(wt, { title: "Cont Quiet" });
      const seed = await stub.stdin();
      expect(seed).toStartWith("This session was resumed by séance");
      expect(seed).toContain("was stopped before it finished (cancelled from séance)");
      expect(seed).toContain("processes it started in the background may still be running");
      expect(seed).toEndWith("carry on where it left off.\n");
      expect(seed).not.toContain("From the user");
    } finally {
      if (outcome !== undefined) await killWindow(outcome.window);
      await dropWorktree(wt);
    }
  });

  test("refuses, launching nothing, when the worktree is gone", async () => {
    const wt = await makeWorktree();
    await dropWorktree(wt);
    const refused = await continuing(wt, { title: "Cont Gone" }).catch((err: unknown) => err);
    expect(refused).toMatchObject({ code: "not_continuable", message: expect.stringContaining("is gone") });
    expect(await tmuxOk(["list-windows", "-t", "main", "-F", "#{window_name}"])).not.toContain("Cont Gone");
  });

  test("refuses while the continued task's own session still runs, and while any session is open in the worktree", async () => {
    const wt = await makeWorktree();
    // The old task's pane, tagged with its id, elsewhere (here mode, in the clone).
    const old = await spawnSession({ repo: "myrepo", mode: "here", title: "Old Run", taskId: OLD }, repos, WAIT);
    try {
      const running = await continuing(wt, { title: "Cont Dup" }).catch((err: unknown) => err);
      expect(running).toMatchObject({ code: "not_continuable", message: expect.stringContaining("still running") });
      await killWindow(old.window);

      // A session in the worktree under another task id, or none at all: a second claude would corrupt its history.
      await tmuxOk(["new-window", "-d", "-t", "main:", "-c", wt.path, "-n", "Occupant", stub.ok]);
      await pollUntil(async () => (await waitForSession("Occupant")) !== undefined, "occupant registered");
      const open = await continuing(wt, { title: "Cont Open" }).catch((err: unknown) => err);
      expect(open).toMatchObject({
        code: "not_continuable",
        message: expect.stringContaining("is open in its worktree"),
      });
      expect(await tmuxOk(["list-windows", "-t", "main", "-F", "#{window_name}"])).not.toContain("Cont Open");
    } finally {
      await killWindow("Occupant");
      await killWindow(old.window);
      await dropWorktree(wt);
    }
  });

  test("two continuations of one worktree, under two task ids, start exactly one session", async () => {
    const wt = await makeWorktree();
    const results = await Promise.allSettled(
      ["Twin X", "Twin Y"].map((title, i) => continuing(wt, { title, taskId: `cont-twin-${i}` })),
    );
    try {
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const refused = results.find((r) => r.status === "rejected");
      expect(refused?.status === "rejected" ? refused.reason : null).toMatchObject({ code: "not_continuable" });
    } finally {
      await Promise.all(results.map((r) => (r.status === "fulfilled" ? killWindow(r.value.window) : undefined)));
      await dropWorktree(wt);
    }
  });

  describe("a lock on the worktree", () => {
    // Claude's own wording (2.1.310 adds the start time off Windows); a pid no machine has.
    test.each([
      ["with its start time", (name: string) => `claude session ${name} (pid 99999999 start 646904935)`],
      ["without one (Windows)", (name: string) => `claude session ${name} (pid 99999999)`],
    ])("a dead claude's, %s, is released and the session continues", async (_form, reason) => {
      const wt = await makeWorktree();
      await git(fixture.repoPath, ["worktree", "lock", "--reason", reason(wt.name), wt.path]);
      let outcome: SpawnOutcome | undefined;
      try {
        expect(await lockedOf(wt)).toBe(true);
        outcome = await continuing(wt, { title: "Cont Stale" });
        expect(outcome.registered).toBe(true);
        expect(await lockedOf(wt)).toBe(false);
      } finally {
        if (outcome !== undefined) await killWindow(outcome.window);
        await dropWorktree(wt);
      }
    });

    test("anyone else's, and a live claude's, is refused and left in place", async () => {
      const wt = await makeWorktree();
      try {
        for (const reason of [
          "on a usb disk",
          "",
          `claude session ${wt.name} (pid ${process.pid})`,
          `claude session ${wt.name} (pid ${process.pid} start 646904935)`,
        ]) {
          // oxlint-disable-next-line no-await-in-loop -- one lock at a time on the one worktree
          await git(fixture.repoPath, ["worktree", "lock", ...(reason === "" ? [] : ["--reason", reason]), wt.path]);
          // oxlint-disable-next-line no-await-in-loop
          const refused = await continuing(wt, { title: "Cont Locked" }).catch((err: unknown) => err);
          expect(refused).toMatchObject({ code: "not_continuable", message: expect.stringContaining("is locked") });
          // oxlint-disable-next-line no-await-in-loop
          expect(await lockedOf(wt)).toBe(true);
          // oxlint-disable-next-line no-await-in-loop
          await git(fixture.repoPath, ["worktree", "unlock", wt.path]);
        }
        expect(await tmuxOk(["list-windows", "-t", "main", "-F", "#{window_name}"])).not.toContain("Cont Locked");
      } finally {
        await dropWorktree(wt);
      }
    });
  });

  test("an unknown repo is repo_not_found, and a continuation the backend was handed no path for is not_continuable", async () => {
    const wt = await makeWorktree();
    try {
      expect(await continuing(wt, { repo: "nope" }).catch((err: unknown) => err)).toMatchObject({
        code: "repo_not_found",
      });
      const bare = await spawnSession(
        { repo: "myrepo", mode: "continue", taskId: "cont-bare", continues: OLD, client: "scheduler" },
        repos,
        WAIT,
      ).catch((err: unknown) => err);
      expect(bare).toMatchObject({ code: "not_continuable" });
    } finally {
      await dropWorktree(wt);
    }
  });
});

// Only the branches the spawn case above cannot reach: an absent tag, a tag
// needing normalisation, and unsuffixable ones — blank or with no ASCII
// alphanumerics — that must not render as empty parens or slugify's "session"
// fallback.
describe("sessionName", () => {
  test("normalises the tag and treats an absent or unsuffixable one as none", () => {
    expect(sessionName("fix-the-thing")).toBe("fix-the-thing");
    expect(sessionName("fix-the-thing", "Linux Box")).toBe("fix-the-thing (linux-box)");
    expect(sessionName("fix-the-thing", "   ")).toBe("fix-the-thing");
    expect(sessionName("fix-the-thing", "🖥️")).toBe("fix-the-thing");
    expect(sessionName("fix-the-thing", "###")).toBe("fix-the-thing");
  });
});

describe("exec timeout", () => {
  test("reports timedOut and kills the process", async () => {
    const result = await exec(["sleep", "5"], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });
});

/** Resolves a rev (default HEAD) in the checkout — the "left it alone" assertions compare two of these. */
async function headOf(path: string, rev = "HEAD"): Promise<string> {
  return (await git(path, ["rev-parse", rev])).stdout.trim();
}

/** Kill by window id — a hostile window *name* is not a safe tmux target string. */
async function killWindow(name: string): Promise<void> {
  // FIELD_SEP, not a tab: tmux 3.4 prints a tab as `_` without a UTF-8 locale.
  // Split at the first one only — an id never holds it, a name might.
  const listed = await tmuxOk(["list-windows", "-t", "main", "-F", `#{window_id}${FIELD_SEP}#{window_name}`]);
  const ids = listed.split("\n").flatMap((line) => {
    const at = line.indexOf(FIELD_SEP);
    return at !== -1 && line.slice(at + FIELD_SEP.length) === name ? [line.slice(0, at)] : [];
  });
  await Promise.all(ids.map((id) => tmux(["kill-window", "-t", id])));
}

/**
 * The stub titles its pane only once bash has exec'd it and it has started,
 * which a loaded machine can stretch past the spawn's own wait — so poll for
 * the session instead of sampling once. Absence still resolves, leaving the
 * assertion (not a timeout) to report it.
 */
async function waitForSession(window: string): Promise<SessionEntry | undefined> {
  const deadline = Bun.nanoseconds() + 5_000 * 1e6;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling: each check gates the next, nothing to parallelize
    const found = (await listClaudeSessions(repos)).find((s) => s.window === window);
    if (found !== undefined || Bun.nanoseconds() >= deadline) return found;
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(50);
  }
}

/**
 * Names the breach rather than the symptom: a broken quote usually kills the
 * pane too, and "claude_died" would send the next reader hunting the wrong bug.
 * Marker files are checked first and reported by name, and only then is the
 * spawn required to have succeeded — a metacharacter-laden title is still
 * legitimate input, not an error.
 */
async function expectNoInjection(request: SpawnRequest, markers: readonly string[]): Promise<void> {
  const result: SpawnOutcome | Error = await spawnSession(request, repos, WAIT).catch((err: unknown) =>
    err instanceof Error ? err : new Error(String(err)),
  );
  try {
    const created = (
      await Promise.all(markers.map(async (marker) => ((await Bun.file(marker).exists()) ? marker : null)))
    ).filter((marker) => marker !== null);
    expect(created).toEqual([]);
    expect(result).not.toBeInstanceOf(Error);
  } finally {
    if (!(result instanceof Error)) await killWindow(result.window);
  }
}
/**
 * The daemon's two standing invariants, pinned. Both hold by construction today
 * — `repo` is a name lookup and every value reaching the one shell string goes
 * through `shq()` — and both are one careless refactor from being false.
 */
describe("wire input cannot escape the repo set or the shell", () => {
  test("path-shaped repo values are repo_not_found — resolution is a name lookup, never a path join", async () => {
    const cases = ["../../etc", "/etc", "myrepo/../../etc", "./myrepo", "myrepo\n", "…/myrepo"];
    const errors = await Promise.all(
      cases.map((repo) => spawnSession({ repo, mode: "here" }, repos, WAIT).catch((err: unknown) => err)),
    );
    for (const err of errors) {
      expect(err).toBeInstanceOf(SpawnFailure);
      expect((err as SpawnFailure).code).toBe("repo_not_found");
    }
  });

  test("title metacharacters stay data — none of the three injection forms run", async () => {
    const semi = join(base, "pwned-semicolon");
    const subst = join(base, "pwned-substitution");
    const tick = join(base, "pwned-backtick");
    await expectNoInjection(
      { repo: "myrepo", mode: "here", title: `x'; touch ${semi} #$(touch ${subst})\`touch ${tick}\`` },
      [semi, subst, tick],
    );
  });

  test("model and effort metacharacters stay data", async () => {
    const viaModel = join(base, "pwned-model");
    const viaEffort = join(base, "pwned-effort");
    await expectNoInjection(
      {
        repo: "myrepo",
        mode: "here",
        title: "Flags",
        model: `opus'; touch ${viaModel} #`,
        effort: `medium$(touch ${viaEffort})`,
      },
      [viaModel, viaEffort],
    );
  });

  test("prompt metacharacters stay data — the seed file is read, not evaluated", async () => {
    const viaQuote = join(base, "pwned-prompt-quote");
    const viaSubst = join(base, "pwned-prompt-subst");
    await expectNoInjection(
      { repo: "myrepo", mode: "here", title: "Prompted", prompt: `"; touch ${viaQuote} #$(touch ${viaSubst})` },
      [viaQuote, viaSubst],
    );
  });
});

// docs/scheduler.md M4: a plain `seanced spawn` queues through the relay, so
// `seanced spawn --now` is the form that must still work with the relay unreachable.
describe("seanced spawn (the CLI, as a subprocess)", () => {
  test("spawn --now never dials the relay, audited origin=cli", async () => {
    const configDir = join(base, "cli-config");
    const stateDir = join(base, "cli-state");
    await mkdir(configDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    // A relay that counts any request or upgrade: spawn --now must never dial it.
    let dialled = 0;
    const relay = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        dialled += 1;
        return new Response("no", { status: 503 });
      },
    });
    const { port } = relay;
    await Bun.write(
      join(configDir, "config.json"),
      JSON.stringify({
        name: "CliBox",
        relayUrl: `ws://127.0.0.1:${port}/daemon`,
        bearerToken: "token",
        psk: "",
        repoRoots: [fixture.root],
      }),
    );
    const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const proc = Bun.spawn([process.execPath, mainPath, "spawn", "--now", "myrepo", "--here", "-t", "No Relay"], {
      env: { ...process.env, SEANCE_CONFIG_DIR: configDir, SEANCE_STATE_DIR: stateDir, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    try {
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("spawned 'No Relay'");
      const log = await Bun.file(join(stateDir, "seanced.log")).text();
      expect(log).toContain("audit spawn origin=cli");
      expect(log).not.toContain("audit enqueue");
      // After the positive result: a non-event, so it is asserted once the spawn is done.
      expect(dialled).toBe(0);
    } finally {
      // `tmux` returns a failed kill (no such window) rather than throwing, so this cannot mask the real failure.
      await tmux(["kill-window", "-t", "main:No Relay"]);
      await relay.stop(true);
    }
  }, 30_000);
});
