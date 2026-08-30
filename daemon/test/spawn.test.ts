import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoEntry, SessionEntry, SpawnRequest } from "@seance/shared";
import { SpawnFailure, type SpawnOutcome } from "../src/backend.ts";
import { exec, git } from "../src/exec.ts";
import { scanRepos } from "../src/scan.ts";
import { listClaudeSessions } from "../src/sessions.ts";
import { sessionName, spawnSession } from "../src/spawn.ts";
import { tmux, tmuxOk } from "../src/tmux.ts";
import { makeClaudeStub, makeGitFixture, type ClaudeStub, type GitFixture } from "./fixtures.ts";

const WAIT = { tmuxSession: "main", waitMs: 700 };
// Failure tests race the stub's actual death (0.3s sleep + process startup,
// which macOS can stretch under load) against the deadline. verifyPaneAlive
// polls, so a wide deadline adds no latency to a spawn that really dies.
const FAIL_WAIT = { tmuxSession: "main", waitMs: 5_000 };
let base: string;
let fixture: GitFixture;
let stub: ClaudeStub;
let repos: readonly RepoEntry[];

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-spawn-"));
  process.env["SEANCE_TMUX_SOCKET"] = `seance-spawn-test-${process.pid}`;
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "claude-config");
  fixture = await makeGitFixture(base);
  stub = await makeClaudeStub(base);
  process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
  repos = await scanRepos([fixture.root]);
});

afterAll(async () => {
  await tmux(["kill-server"]);
  delete process.env["SEANCE_TMUX_SOCKET"];
  delete process.env["SEANCE_CLAUDE_BIN"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  await rm(base, { recursive: true, force: true });
});

describe("spawnSession (real tmux, real git, stub claude)", () => {
  test("scan found the fixture repo with its default branch", () => {
    expect(repos).toHaveLength(1);
    expect(repos[0]?.name).toBe("myrepo");
    expect(repos[0]?.defaultBranch).toBe("main");
  });

  test("worktree spawn: creates the tmux window, ffs the default branch, detection sees it", async () => {
    await fixture.advanceOrigin();
    const before = (await git(fixture.repoPath, ["rev-parse", "HEAD"])).stdout.trim();

    const outcome = await spawnSession(
      { repo: "myrepo", mode: "worktree", title: "Fix Tests", prompt: "fix the tests" },
      repos,
      WAIT,
    );

    expect(outcome.window).toBe("Fix Tests");
    expect(outcome.path).toEndWith(join(".claude", "worktrees", "fix-tests"));
    expect(outcome.note).toBeUndefined();

    // clean checkout on main → ff-only moved HEAD to the new origin commit
    const after = (await git(fixture.repoPath, ["rev-parse", "HEAD"])).stdout.trim();
    expect(after).not.toBe(before);
    const originMain = (await git(fixture.repoPath, ["rev-parse", "origin/main"])).stdout.trim();
    expect(after).toBe(originMain);

    // the window exists in the main session and the pane survived
    const windows = await tmuxOk(["list-windows", "-t", "main", "-F", "#{window_name}"]);
    expect(windows).toContain("Fix Tests");

    // detection: stub's comm is "9.9.9", pane path is the repo → mapped
    const found = await waitForSession("Fix Tests");
    expect(found).toBeDefined();
    expect(found?.repo).toBe("myrepo");

    await tmux(["kill-window", "-t", "main:Fix Tests"]);
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
    const claudeConfig = join(base, "claude-config", ".claude.json");
    await Bun.write(claudeConfig, JSON.stringify({ projects: {} }));

    const outcome = await spawnSession({ repo: "myrepo", mode: "here", title: "Trusting" }, repos, WAIT);

    const config = (await Bun.file(claudeConfig).json()) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean } | undefined>;
    };
    expect(config.projects[fixture.repoPath]?.hasTrustDialogAccepted).toBe(true);
    await tmux(["kill-window", "-t", `main:${outcome.window}`]);
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

  test("dirty checkout: spawn proceeds with a note", async () => {
    await Bun.write(join(fixture.repoPath, "README.md"), "# dirtied\n");
    try {
      const outcome = await spawnSession({ repo: "myrepo", mode: "worktree", title: "Dirty" }, repos, WAIT);
      expect(outcome.note).toContain("not on a clean main");
      await tmux(["kill-window", "-t", "main:Dirty"]);
    } finally {
      await git(fixture.repoPath, ["checkout", "--", "README.md"]);
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

  test("unreachable origin is fetch_failed", async () => {
    await git(fixture.repoPath, ["remote", "set-url", "origin", "/nonexistent/origin.git"]);
    try {
      await spawnSession({ repo: "myrepo", mode: "worktree", title: "NoNet" }, repos, WAIT);
      expect.unreachable();
    } catch (err) {
      expect((err as SpawnFailure).code).toBe("fetch_failed");
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

/** Kill by window id — a hostile window *name* is not a safe tmux target string. */
async function killWindow(name: string): Promise<void> {
  const listed = await tmuxOk(["list-windows", "-t", "main", "-F", "#{window_id}\t#{window_name}"]);
  const ids = listed
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts[1] === name)
    .map((parts) => parts[0])
    .filter((id): id is string => id !== undefined);
  await Promise.all(ids.map((id) => tmux(["kill-window", "-t", id])));
}

/**
 * The stub reaches its detectable comm only once bash execs it, which the disk
 * contention of parallel test workers can stretch past the pane-alive wait —
 * so poll for the session instead of sampling once. Absence still resolves,
 * leaving the assertion (not a timeout) to report it.
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
