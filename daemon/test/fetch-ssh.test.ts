import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/exec.ts";
import { freshenBase } from "../src/base-fetch.ts";
import { sshBatchEnv, type TerminalProbe } from "../src/git-hardened.ts";
import { fetchIfStale, resolveRemoteHead } from "../src/reap-git.ts";

/**
 * The guarded network calls (reap's, the branch-state emitter's, the spawn's
 * base fetch) under an `ssh://` origin, with a recording stub in
 * place of ssh: whichever ssh git picks is the one that runs, so the stub's
 * argv says whether BatchMode reached it and whether the user's choice won.
 */

let base: string;
let stubDir: string;
let stub: string;
let record: string;
let seq = 0;
const savedPath = process.env["PATH"];
/** A developer's own ssh choice must not flip these tests. */
const SSH_ENV = ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT"] as const;
/** Env-injected git config would reach every probe and fetch here, as the developer's own ssh choice would. */
const GIT_CONFIG_ENV = /^GIT_CONFIG_(PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$/u;
const envKeys = (): readonly string[] => [
  ...SSH_ENV,
  ...Object.keys(process.env).filter((key) => GIT_CONFIG_ENV.test(key)),
];
let savedSshEnv: Readonly<Record<string, string | undefined>> = {};

/** The daemon has a terminal (a foreground run) / has none (a service). */
const tty: TerminalProbe = () => Promise.resolve(true);
const noTty: TerminalProbe = () => Promise.resolve(false);

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-fetch-ssh-"));
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  savedSshEnv = Object.fromEntries(envKeys().map((key) => [key, process.env[key]]));
  for (const key of Object.keys(savedSshEnv)) delete process.env[key];
  stubDir = join(base, "bin");
  await mkdir(stubDir);
  stub = join(stubDir, "ssh");
  record = join(base, "ssh-argv");
  await writeFile(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${record}'\nexit 1\n`);
  await chmod(stub, 0o755);
  // First exec outside any timed window (CLAUDE.md, "Testing").
  await exec([stub, "warm"]);
});

afterAll(async () => {
  delete process.env["GIT_CONFIG_GLOBAL"];
  delete process.env["GIT_CONFIG_NOSYSTEM"];
  for (const [key, value] of Object.entries(savedSshEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(base, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(record, { force: true });
});

async function sshRepo(): Promise<string> {
  seq += 1;
  const repo = join(base, `r${seq}`);
  expect((await exec(["git", "init", "-q", "-b", "main", repo])).exitCode).toBe(0);
  expect(
    (await exec(["git", "remote", "add", "origin", "ssh://seance.invalid/repo.git"], { cwd: repo })).exitCode,
  ).toBe(0);
  return repo;
}

async function sshCalls(): Promise<readonly string[]> {
  const text = await readFile(record, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "");
}

/** Runs `body` with `vars` set in the daemon's own environment, as a user's shell would hand them in. */
async function withEnv<T>(vars: Readonly<Record<string, string>>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("guarded network calls never let ssh prompt", () => {
  test("with no ssh configured, the fetch's ssh runs with BatchMode", async () => {
    const repo = await sshRepo();
    const outcome = await withEnv({ PATH: `${stubDir}:${savedPath ?? ""}` }, () =>
      fetchIfStale(repo, 0, Date.now(), 0, tty),
    );
    expect(outcome.kind).toBe("failed");
    const calls = await sshCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((argv) => argv.includes("-o BatchMode=yes"))).toBe(true);
  });

  test("the emitter's env (GCM_INTERACTIVE) and reap's set-head get BatchMode too", async () => {
    const repo = await sshRepo();
    await withEnv({ PATH: `${stubDir}:${savedPath ?? ""}` }, async () => {
      await fetchIfStale(repo, 0, Date.now(), 0, tty);
      expect(await resolveRemoteHead(repo, tty)).toBe(false);
    });
    const calls = await sshCalls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((argv) => argv.includes("-o BatchMode=yes"))).toBe(true);
  });

  test("the spawn's base fetch gets BatchMode too", async () => {
    const repo = await sshRepo();
    // An `origin/HEAD` on disk is what names the default branch to fetch.
    expect(
      (await exec(["git", "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: repo }))
        .exitCode,
    ).toBe(0);
    const entry = { name: `r${seq}`, path: repo, defaultBranch: "main" };
    const note = await withEnv({ PATH: `${stubDir}:${savedPath ?? ""}` }, () => freshenBase(entry, "worktree", tty));
    expect(note).toContain("couldn't fetch origin/main");
    const calls = await sshCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((argv) => argv.includes("-o BatchMode=yes"))).toBe(true);
  });

  test("with no terminal (a service) ssh is left as it is, and no config probe runs", async () => {
    const repo = await sshRepo();
    await withEnv({ PATH: `${stubDir}:${savedPath ?? ""}` }, () => fetchIfStale(repo, 0, Date.now(), 0, noTty));
    const calls = await sshCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((argv) => argv.includes("BatchMode"))).toBe(false);
    // The probe would spawn git; a repo that is not one makes it observable: no terminal, no spawn, no failure.
    expect(await sshBatchEnv(join(base, "no-such-dir"), {}, noTty)).toEqual({});
  });

  // A repo's own core.sshCommand is refused before any of this (git-config-guard.test.ts): only the owner's applies.
  test("the owner's core.sshCommand is used as it is", async () => {
    const repo = await sshRepo();
    const owner = join(base, `gitconfig-${seq}`);
    await writeFile(owner, `[core]\n\tsshCommand = ${stub}\n`);
    expect((await withEnv({ GIT_CONFIG_GLOBAL: owner }, () => fetchIfStale(repo, 0, Date.now(), 0, tty))).kind).toBe(
      "failed",
    );
    const calls = await sshCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((argv) => argv.includes("BatchMode"))).toBe(false);
  });

  test("the owner's core.sshCommand reached through an include is honoured too", async () => {
    const repo = await sshRepo();
    const included = join(base, `include-${seq}`);
    await writeFile(included, `[core]\n\tsshCommand = ${stub}\n`);
    const owner = join(base, `gitconfig-${seq}`);
    await writeFile(owner, `[include]\n\tpath = ${included}\n`);
    await withEnv({ GIT_CONFIG_GLOBAL: owner }, () => fetchIfStale(repo, 0, Date.now(), 0, tty));
    const calls = await sshCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((argv) => argv.includes("BatchMode"))).toBe(false);
  });

  test("a GIT_SSH_COMMAND in the environment is used as it is", async () => {
    const repo = await sshRepo();
    await withEnv({ GIT_SSH_COMMAND: stub }, () => fetchIfStale(repo, 0, Date.now(), 0, tty));
    const calls = await sshCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((argv) => argv.includes("BatchMode"))).toBe(false);
  });

  test("a GIT_SSH in the environment is not overridden by our GIT_SSH_COMMAND", async () => {
    const repo = await sshRepo();
    await withEnv({ GIT_SSH: stub }, () => fetchIfStale(repo, 0, Date.now(), 0, tty));
    const calls = await sshCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((argv) => argv.includes("BatchMode"))).toBe(false);
  });

  test("a non-OpenSSH ssh.variant is left alone, ssh.variant=ssh still gets BatchMode", async () => {
    const repo = await sshRepo();
    expect((await exec(["git", "config", "ssh.variant", "putty"], { cwd: repo })).exitCode).toBe(0);
    expect(await sshBatchEnv(repo, {}, tty)).toEqual({});
    expect((await exec(["git", "config", "ssh.variant", "ssh"], { cwd: repo })).exitCode).toBe(0);
    expect(await sshBatchEnv(repo, {}, tty)).toEqual({ GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
  });

  test("a GIT_SSH_VARIANT other than ssh/auto is left alone", async () => {
    const repo = await sshRepo();
    expect(await sshBatchEnv(repo, { GIT_SSH_VARIANT: "plink" }, tty)).toEqual({});
    expect(await sshBatchEnv(repo, { GIT_SSH_VARIANT: "ssh" }, tty)).toEqual({
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    });
  });

  test("GIT_SSH_VARIANT outranks ssh.variant in the config", async () => {
    const repo = await sshRepo();
    expect((await exec(["git", "config", "ssh.variant", "putty"], { cwd: repo })).exitCode).toBe(0);
    expect(await sshBatchEnv(repo, { GIT_SSH_VARIANT: "ssh" }, tty)).toEqual({
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    });
  });

  test("the probe reads the config the fetch will run with (the caller's env)", async () => {
    const repo = await sshRepo();
    const extra = join(base, `extra-${seq}`);
    await writeFile(extra, `[core]\n\tsshCommand = ${stub}\n`);
    // `GIT_CONFIG_GLOBAL` in the caller's env is what the fetch would see; the process env says nothing of it.
    expect(await sshBatchEnv(repo, { GIT_CONFIG_GLOBAL: extra }, tty)).toEqual({});
  });
});
