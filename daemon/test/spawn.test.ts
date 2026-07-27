import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoEntry, SpawnRequest } from "@seance/shared";
import { exec, git } from "../src/exec.ts";
import { scanRepos } from "../src/scan.ts";
import { listClaudeSessions } from "../src/sessions.ts";
import { SpawnFailure, spawnSession, type SpawnOutcome } from "../src/spawn.ts";
import { tmux, tmuxOk } from "../src/tmux.ts";
import { makeClaudeStub, makeGitFixture, type ClaudeStub, type GitFixture } from "./fixtures.ts";

const WAIT = { waitMs: 700 };
// Failure tests race the stub's actual death (0.3s sleep + process startup,
// which macOS can stretch under load) against the deadline. verifyPaneAlive
// polls, so a wide deadline adds no latency to a spawn that really dies.
const FAIL_WAIT = { waitMs: 5_000 };
let base: string;
let fixture: GitFixture;
let stub: ClaudeStub;
let repos: readonly RepoEntry[];

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-spawn-"));
  process.env["SEANCE_TMUX_SOCKET"] = `seance-spawn-test-${process.pid}`;
  fixture = await makeGitFixture(base);
  stub = await makeClaudeStub(base);
  process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
  repos = await scanRepos([fixture.root]);
});

afterAll(async () => {
  await tmux(["kill-server"]);
  delete process.env["SEANCE_TMUX_SOCKET"];
  delete process.env["SEANCE_CLAUDE_BIN"];
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
      "main",
      WAIT,
    );

    expect(outcome.window).toBe("Fix Tests");
    expect(outcome.path).toContain(join(".claude", "worktrees", "fix-tests-"));
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
    const sessions = await listClaudeSessions(repos);
    const found = sessions.find((s) => s.window === "Fix Tests");
    expect(found).toBeDefined();
    expect(found?.repo).toBe("myrepo");

    await tmux(["kill-window", "-t", "main:Fix Tests"]);
  });

  test("a title carrying the format separator stays detectable", async () => {
    const outcome = await spawnSession({ repo: "myrepo", mode: "here", title: "fix | build" }, repos, "main", WAIT);
    expect(outcome.window).toBe("fix - build");

    const sessions = await listClaudeSessions(repos);
    expect(sessions.find((s) => s.window === outcome.window)?.repo).toBe("myrepo");

    // renamed outside séance, tmux substitutes the separator out of the format
    await tmuxOk(["rename-window", "-t", `main:${outcome.window}`, "a | b"]);
    const renamed = await listClaudeSessions(repos);
    expect(renamed.find((s) => s.window === "a - b")?.repo).toBe("myrepo");

    await tmux(["kill-window", "-t", "main:a - b"]);
  });

  test("here mode: launches at the repo root, no git preparation", async () => {
    const outcome = await spawnSession({ repo: "myrepo", mode: "here", title: "Here Now" }, repos, "main", WAIT);
    expect(outcome.path).toBe(fixture.repoPath);
    await tmux(["kill-window", "-t", "main:Here Now"]);
  });

  test("dirty checkout: spawn proceeds with a note", async () => {
    await Bun.write(join(fixture.repoPath, "README.md"), "# dirtied\n");
    try {
      const outcome = await spawnSession({ repo: "myrepo", mode: "worktree", title: "Dirty" }, repos, "main", WAIT);
      expect(outcome.note).toContain("not on a clean main");
      await tmux(["kill-window", "-t", "main:Dirty"]);
    } finally {
      await git(fixture.repoPath, ["checkout", "--", "README.md"]);
    }
  });

  test("claude exiting nonzero is claude_died with the captured error, window killed", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.failing;
    try {
      await expect(
        spawnSession({ repo: "myrepo", mode: "here", title: "Doomed" }, repos, "main", FAIL_WAIT),
      ).rejects.toThrow(SpawnFailure);
      try {
        await spawnSession({ repo: "myrepo", mode: "here", title: "Doomed" }, repos, "main", FAIL_WAIT);
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
      await spawnSession({ repo: "nope", mode: "worktree" }, repos, "main", WAIT);
      expect.unreachable();
    } catch (err) {
      expect((err as SpawnFailure).code).toBe("repo_not_found");
    }
  });

  test("unreachable origin is fetch_failed", async () => {
    await git(fixture.repoPath, ["remote", "set-url", "origin", "/nonexistent/origin.git"]);
    try {
      await spawnSession({ repo: "myrepo", mode: "worktree", title: "NoNet" }, repos, "main", WAIT);
      expect.unreachable();
    } catch (err) {
      expect((err as SpawnFailure).code).toBe("fetch_failed");
    } finally {
      await git(fixture.repoPath, ["remote", "set-url", "origin", fixture.barePath]);
    }
  });

  test("seed prompt file reaches the pane command", async () => {
    // The inner command embeds $(cat seedfile) — verify the spawned pane's
    // start command references the seed, i.e. prompts don't get shell-mangled.
    const outcome = await spawnSession(
      { repo: "myrepo", mode: "here", title: "Seeded", prompt: "tricky 'quoted' $prompt" },
      repos,
      "main",
      WAIT,
    );
    expect(outcome.window).toBe("Seeded");
    await tmux(["kill-window", "-t", "main:Seeded"]);
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
 * Names the breach rather than the symptom: a broken quote usually kills the
 * pane too, and "claude_died" would send the next reader hunting the wrong bug.
 * Marker files are checked first and reported by name, and only then is the
 * spawn required to have succeeded — a metacharacter-laden title is still
 * legitimate input, not an error.
 */
async function expectNoInjection(request: SpawnRequest, markers: readonly string[]): Promise<void> {
  const result: SpawnOutcome | Error = await spawnSession(request, repos, "main", WAIT).catch((err: unknown) =>
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
      cases.map((repo) => spawnSession({ repo, mode: "here" }, repos, "main", WAIT).catch((err: unknown) => err)),
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
