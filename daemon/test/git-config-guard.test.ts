import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoEntry } from "@seance/shared";
import { freshenBase } from "../src/base-fetch.ts";
import { createBranchStates } from "../src/branch-state.ts";
import { exec } from "../src/exec.ts";
import { refusedFamily, repoConfigRefusal } from "../src/git-hardened.ts";
import { LaunchLedger } from "../src/launch-ledger.ts";
import { fetchIfStale, resolveRemoteHead } from "../src/reap-git.ts";
import { createUpdater } from "../src/update.ts";
import { captureLog, makeGitFixture, type GitFixture } from "./fixtures.ts";

/**
 * A session can write its clone's `.git/config` and `info/attributes`; the daemon then runs git there on its own
 * (reap, the base fetch, the branch-state emitter, self-update). One recording stub stands in for every command such
 * config could name (ssh, upload-pack, a merge driver, an `ext::` transport): a record line means it ran.
 */

const GIT_ID = ["-c", "user.email=test@seance.local", "-c", "user.name=Seance Test"];
/** Anything in the developer's environment that would reach these gits, as in fetch-ssh.test.ts. */
const AMBIENT = /^(GIT_SSH(_COMMAND|_VARIANT)?|GCM_INTERACTIVE|GIT_CONFIG_(PARAMETERS|COUNT|KEY_\d+|VALUE_\d+))$/u;

let base: string;
let stub: string;
let record: string;
let globalConfig: string;
let seq = 0;
let saved: Readonly<Record<string, string | undefined>> = {};

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-git-guard-"));
  saved = Object.fromEntries(
    [...Object.keys(process.env).filter((key) => AMBIENT.test(key)), "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].map(
      (key) => [key, process.env[key]],
    ),
  );
  for (const key of Object.keys(saved)) delete process.env[key];
  // Stands in for ~/.gitconfig: the owner's own, which must still apply.
  globalConfig = join(base, "gitconfig");
  process.env["GIT_CONFIG_GLOBAL"] = globalConfig;
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  await mkdir(join(base, "bin"));
  stub = join(base, "bin", "stub");
  record = join(base, "record");
  await writeFile(stub, `#!/bin/sh\nprintf 'GCM=%s %s\\n' "$GCM_INTERACTIVE" "$*" >> '${record}'\nexit 1\n`);
  await chmod(stub, 0o755);
  // First exec outside any timed window (CLAUDE.md, "Testing").
  await exec([stub, "warm"]);
});

afterAll(async () => {
  delete process.env["GIT_CONFIG_GLOBAL"];
  delete process.env["GIT_CONFIG_NOSYSTEM"];
  for (const [key, value] of Object.entries(saved)) {
    if (value !== undefined) process.env[key] = value;
  }
  await rm(base, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(record, { force: true });
  await writeFile(globalConfig, "");
});

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const result = await exec(["git", ...GIT_ID, ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function recorded(): Promise<readonly string[]> {
  const text = await readFile(record, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "");
}

interface World {
  readonly fixture: GitFixture;
  readonly repo: RepoEntry;
  readonly ledger: LaunchLedger;
}

async function world(): Promise<World> {
  seq += 1;
  const dir = join(base, `w${seq}`);
  const fixture = await makeGitFixture(dir);
  const repo: RepoEntry = { name: "myrepo", path: fixture.repoPath, defaultBranch: "main", origin: "example.test/r" };
  return { fixture, repo, ledger: await LaunchLedger.open(join(dir, "launched.json")) };
}

/** A pushed task with own work, so a pass fetches: the emitter's network call. */
async function pushedTask(w: World, file = "a.txt"): Promise<void> {
  const path = join(w.fixture.repoPath, ".claude", "worktrees", "x");
  await git(w.fixture.repoPath, "worktree", "add", "-q", "--no-track", "-b", "worktree-x", path, "origin/main");
  await w.ledger.record("t1");
  await w.ledger.note("t1", { repo: w.repo.path, path });
  await writeFile(join(path, file), "task\n");
  await git(path, "add", file);
  await git(path, "commit", "-q", "-m", `edit ${file}`);
  await git(path, "push", "-q", "origin", "worktree-x");
}

/** One emitter pass; its log lines. */
async function branchPass(w: World): Promise<readonly string[]> {
  const emitter = createBranchStates({
    ledger: w.ledger,
    repos: () => [w.repo],
    emit: () => Promise.resolve(true),
    intervalMs: 3_600_000,
    fetchStaleMs: 0,
  });
  try {
    return await captureLog(() => emitter.check());
  } finally {
    emitter.stop();
  }
}

/** Repo-local config by `git config` in the repo, as a session would write it; `global` writes ~/.gitconfig's stand-in. */
async function setConfig(w: World, scope: "local" | "global", key: string, value: string): Promise<void> {
  const args = scope === "global" ? ["config", "--global", key, value] : ["config", key, value];
  await git(w.fixture.repoPath, ...args);
}

interface Family {
  readonly label: string;
  /** Writes the config under test at `scope`, plus anything the attack needs beside it. */
  readonly arrange: (w: World, scope: "local" | "global") => Promise<void>;
}

const sshOrigin = async (w: World): Promise<void> => {
  await git(w.fixture.repoPath, "remote", "set-url", "origin", "ssh://seance.invalid/repo.git");
};

const FAMILIES: readonly Family[] = [
  {
    label: "core.sshcommand",
    arrange: async (w, scope) => {
      await sshOrigin(w);
      await setConfig(w, scope, "core.sshCommand", stub);
    },
  },
  {
    label: "remote.*.uploadpack",
    arrange: (w, scope) => setConfig(w, scope, "remote.origin.uploadpack", stub),
  },
  {
    label: "url.*.insteadof",
    arrange: async (w, scope) => {
      // The owner's ssh is the stub; the rewrite is what sends the fetch to it.
      // Rewrite the URL the clone holds, not fixture.barePath: that one is
      // realpath'd, and on macOS the clone's /var/… origin never matches /private/var/….
      await setConfig(w, "global", "core.sshCommand", stub);
      const origin = await git(w.fixture.repoPath, "config", "remote.origin.url");
      await setConfig(w, scope, "url.ssh://seance.invalid/.insteadOf", origin);
    },
  },
  {
    label: "include.*",
    arrange: async (w, scope) => {
      const included = join(base, `include-${seq}`);
      await writeFile(included, `[remote "origin"]\n\tuploadpack = ${stub}\n`);
      await setConfig(w, scope, "include.path", included);
    },
  },
];

describe("refusedFamily", () => {
  test("names the family of each refused key, in any case, and passes everything else", () => {
    const cases: readonly (readonly [string, string | null])[] = [
      ["core.sshCommand", "core.sshcommand"],
      ["core.gitProxy", "core.gitproxy"],
      ["core.askPass", "core.askpass"],
      ["core.attributesFile", "core.attributesfile"],
      ["credential.helper", "credential.*"],
      ["credential.https://user:secret@example.com.helper", "credential.*"],
      ["remote.origin.uploadpack", "remote.*.uploadpack"],
      ["remote.up.stream.receivepack", "remote.*.receivepack"],
      ["protocol.allow", "protocol.allow"],
      ["protocol.ext.allow", "protocol.*.allow"],
      ["url.ext::sh -c x.insteadOf", "url.*.insteadof"],
      ["include.path", "include.*"],
      ["includeIf.gitdir:~/x/.path", "includeif.*"],
      ["merge.evil.driver", "merge.*.driver"],
      ["filter.lfs.smudge", "filter.*"],
      ["core.bare", null],
      ["core.sshVariant", null],
      ["remote.origin.url", null],
      ["remote.origin.fetch", null],
      ["branch.main.remote", null],
      ["merge.conflictstyle", null],
      ["merge.evil.name", null],
      ["url.x.pushInsteadOf", null],
      ["user.name", null],
    ];
    for (const [key, family] of cases) expect([key, refusedFamily([key])]).toEqual([key, family]);
  });
});

describe("repo-local config that would run a command is refused", () => {
  for (const family of FAMILIES) {
    test(`${family.label}: reap's fetch and set-head, the base fetch and a branch-state pass run nothing, and say so`, async () => {
      const w = await world();
      await pushedTask(w);
      await branchPass(w);
      await family.arrange(w, "local");
      const refusal = `refused: repo-local ${family.label}`;

      expect(await fetchIfStale(w.repo.path, 0, Date.now(), 0)).toEqual({
        kind: "failed",
        detail: refusal,
        brief: refusal,
      });
      expect(await resolveRemoteHead(w.repo.path)).toBe(false);
      expect(await freshenBase(w.repo, "worktree")).toContain(`(${refusal})`);
      const lines = await branchPass(w);
      expect(lines.join("\n")).toContain(`branch state: fetch failed in myrepo (${refusal})`);
      expect(await recorded()).toEqual([]);
    });

    test(`${family.label}: the same config in ~/.gitconfig still applies`, async () => {
      const w = await world();
      await family.arrange(w, "global");
      expect(await repoConfigRefusal(w.repo.path)).toBeNull();
      expect((await fetchIfStale(w.repo.path, 0, Date.now(), 0)).kind).toBe("failed");
      expect((await recorded()).length).toBeGreaterThan(0);
    });
  }

  test("an ext:: origin never runs, even where the repo and the owner both allow the transport", async () => {
    const w = await world();
    await git(w.fixture.repoPath, "remote", "set-url", "origin", `ext::${stub} %S`);
    await setConfig(w, "global", "protocol.ext.allow", "always");
    expect(await repoConfigRefusal(w.repo.path)).toBeNull();
    expect((await fetchIfStale(w.repo.path, 0, Date.now(), 0)).kind).toBe("failed");
    expect(await freshenBase(w.repo, "worktree")).toContain("couldn't fetch origin/main");
    await setConfig(w, "local", "protocol.ext.allow", "always");
    expect(await repoConfigRefusal(w.repo.path)).toBe("protocol.*.allow");
    expect(await recorded()).toEqual([]);
  });

  test("credential.* is refused, though only the table says what a helper would do", async () => {
    const w = await world();
    await setConfig(w, "local", "credential.helper", stub);
    expect(await repoConfigRefusal(w.repo.path)).toBe("credential.*");
    await git(w.fixture.repoPath, "config", "--unset", "credential.helper");
    await setConfig(w, "global", "credential.helper", stub);
    expect(await repoConfigRefusal(w.repo.path)).toBeNull();
  });

  test("worktree-scoped config is refused like the clone's own", async () => {
    const w = await world();
    await setConfig(w, "local", "extensions.worktreeConfig", "true");
    await git(w.fixture.repoPath, "config", "--worktree", "core.sshCommand", stub);
    expect(await repoConfigRefusal(w.repo.path)).toBe("core.sshcommand");
  });
});

describe("merge-tree never runs a merge driver the repo names", () => {
  /** A pushed task and a main that both rewrote README.md, fetched: a pass then reaches merge-tree, and its driver. */
  async function conflicted(): Promise<World> {
    const w = await world();
    await pushedTask(w, "README.md");
    await branchPass(w);
    seq += 1;
    const server = join(base, `server-${seq}`);
    await git(base, "clone", "-q", w.fixture.barePath, server);
    await writeFile(join(server, "README.md"), "main\n");
    await git(server, "commit", "-q", "-am", "main rewrites README.md");
    await git(server, "push", "-q", "origin", "main");
    await git(w.fixture.repoPath, "fetch", "-q", "origin");
    return w;
  }

  const DRIVER = (): string => `${stub} %O %A %B`;

  test("a repo-local driver is refused, wherever the attribute comes from", async () => {
    const w = await conflicted();
    const attributes = join(base, `attributes-${seq}`);
    await writeFile(attributes, "* merge=evil\n");
    await setConfig(w, "global", "core.attributesFile", attributes);
    await setConfig(w, "local", "merge.evil.driver", DRIVER());
    const lines = await branchPass(w);
    expect(lines.join("\n")).toContain("refused: repo-local merge.*.driver");
    expect(await recorded()).toEqual([]);
  });

  test("a merge= line in info/attributes is refused, though the driver is the owner's", async () => {
    const w = await conflicted();
    await setConfig(w, "global", "merge.evil.driver", DRIVER());
    await mkdir(join(w.fixture.repoPath, ".git", "info"), { recursive: true });
    await writeFile(join(w.fixture.repoPath, ".git", "info", "attributes"), "# the session's\n* merge=evil\n");
    expect(await repoConfigRefusal(w.repo.path)).toBe("merge= in info/attributes");
    await branchPass(w);
    expect(await recorded()).toEqual([]);
  });

  test("the owner's own driver and attributes still run", async () => {
    const w = await conflicted();
    const attributes = join(base, `attributes-${seq}`);
    await writeFile(attributes, "* merge=evil\n");
    await setConfig(w, "global", "core.attributesFile", attributes);
    await setConfig(w, "global", "merge.evil.driver", DRIVER());
    await branchPass(w);
    expect((await recorded()).length).toBeGreaterThan(0);
  });
});

describe("every network call takes one environment", () => {
  test("reap's fetch and set-head, the base fetch and self-update's fetch all run with GCM_INTERACTIVE=never", async () => {
    const w = await world();
    await setConfig(w, "global", "remote.origin.uploadpack", stub);
    await fetchIfStale(w.repo.path, 0, Date.now(), 0);
    await resolveRemoteHead(w.repo.path);
    await freshenBase(w.repo, "worktree");
    const updater = createUpdater({
      root: w.repo.path,
      debounceMs: 0,
      effects: { install: () => Promise.resolve({ ok: true }), restart: () => Promise.resolve() },
      sink: () => {},
      report: () => Promise.resolve(),
    });
    updater.check("announce");
    await updater.settled();
    const lines = await recorded();
    // One per call site at least; set-head and fetch may each dial more than once.
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.every((line) => line.startsWith("GCM=never "))).toBe(true);
  });

  test("a GCM_INTERACTIVE the user set is theirs", async () => {
    const w = await world();
    await setConfig(w, "global", "remote.origin.uploadpack", stub);
    process.env["GCM_INTERACTIVE"] = "always";
    try {
      await fetchIfStale(w.repo.path, 0, Date.now(), 0);
    } finally {
      delete process.env["GCM_INTERACTIVE"];
    }
    expect(await recorded()).toEqual([expect.stringMatching(/^GCM=always /u)]);
  });

  test("no git network subcommand in daemon/src is spelled outside a networkGit call", async () => {
    const src = join(import.meta.dir, "..", "src");
    const files = (await readdir(src)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    const NETWORK = /\[\s*"(?:fetch|pull|push|clone|ls-remote|submodule)"|"set-head"/gu;
    const CALL = /\b(networkGit|hardenedGit|git|exec|spawn)\(/gu;
    const offenders: string[] = [];
    let sites = 0;
    for (const name of files) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of small files
      const text = await readFile(join(src, name), "utf8");
      for (const match of text.matchAll(NETWORK)) {
        sites += 1;
        const opener = [...text.slice(0, match.index).matchAll(CALL)].at(-1)?.[1];
        if (opener !== "networkGit") offenders.push(`${name}: ${match[0]} in ${opener ?? "no call"}`);
      }
      if (name !== "git-hardened.ts" && text.includes("GCM_INTERACTIVE")) offenders.push(`${name}: GCM_INTERACTIVE`);
    }
    expect(offenders).toEqual([]);
    // reap's fetch and set-head, the base fetch, self-update's set-head and fetch.
    expect(sites).toBe(5);
  });
});
