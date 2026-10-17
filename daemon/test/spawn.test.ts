import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoEntry, SessionEntry, SpawnRequest } from "@seance/shared";
import { SpawnFailure, type SpawnOutcome } from "../src/backend.ts";
import { exec, git } from "../src/exec.ts";
import { scanRepos } from "../src/scan.ts";
import { listClaudeSessions } from "../src/sessions.ts";
import { sessionName, spawnSession, type SpawnOptions } from "../src/spawn.ts";
import { FIELD_SEP, tmux, tmuxOk } from "../src/tmux.ts";
import {
  addWorktree,
  makeClaudeStub,
  makeGitFixture,
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

  test("seed prompt reaches claude as the final operand, quotes and all", async () => {
    await rm(stub.argvFile, { force: true });
    const outcome = await spawnSession(
      { repo: "myrepo", mode: "here", title: "Seeded", prompt: "tricky 'quoted' $prompt" },
      repos,
      WAIT,
    );
    try {
      const argv = await stub.argv();
      // Pinned behind `--`: `--remote-control [name]` takes an optional value,
      // and a here-mode seed adjacent to it became the session's *name* — the
      // session started idle with the prompt in the title.
      expect(argv.at(-2)).toBe("--");
      expect(argv.at(-1)).toEndWith("Task: tricky 'quoted' $prompt");
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
