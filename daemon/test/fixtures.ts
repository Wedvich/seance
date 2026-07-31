import { watch } from "node:fs";
import { chmod, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { watchConfigFile } from "../src/config.ts";
import { exec } from "../src/exec.ts";

async function run(argv: readonly string[], cwd?: string): Promise<void> {
  const result = await exec(argv, cwd !== undefined ? { cwd } : {});
  if (result.exitCode !== 0) {
    throw new Error(`fixture command failed: ${argv.join(" ")}\n${result.stderr}`);
  }
}

const GIT_ID = ["-c", "user.email=test@seance.local", "-c", "user.name=Seance Test"];

export interface GitFixture {
  /** Scannable repo root (contains myrepo). */
  readonly root: string;
  readonly repoPath: string;
  readonly barePath: string;
  /** Adds a commit to origin that the clone doesn't have. */
  readonly advanceOrigin: () => Promise<void>;
}

/** Bare origin + a clone with origin/HEAD set, like any real `git clone`. */
export async function makeGitFixture(base: string): Promise<GitFixture> {
  const barePath = join(base, "origin.git");
  const seedPath = join(base, "seed");
  const root = join(base, "repos");
  await mkdir(root, { recursive: true });

  await run(["git", "init", "--bare", "-b", "main", barePath]);
  await run(["git", "init", "-b", "main", seedPath]);
  await Bun.write(join(seedPath, "README.md"), "# fixture\n");
  await run(["git", ...GIT_ID, "add", "."], seedPath);
  await run(["git", ...GIT_ID, "commit", "-m", "initial"], seedPath);
  await run(["git", "remote", "add", "origin", barePath], seedPath);
  await run(["git", "push", "origin", "main"], seedPath);

  const clonePath = join(root, "myrepo");
  await run(["git", "clone", barePath, clonePath]);
  await run(["git", "config", "user.email", "test@seance.local"], clonePath);
  await run(["git", "config", "user.name", "Seance Test"], clonePath);
  // scan stores kernel-canonical paths (macOS tmpdir is a /var → /private/var
  // symlink) — hand tests the same form so path assertions compare equal
  const repoPath = await realpath(clonePath);

  let counter = 0;
  const advanceOrigin = async (): Promise<void> => {
    counter += 1;
    await Bun.write(join(seedPath, `file-${counter}.txt`), `${counter}\n`);
    await run(["git", ...GIT_ID, "add", "."], seedPath);
    await run(["git", ...GIT_ID, "commit", "-m", `advance ${counter}`], seedPath);
    await run(["git", "push", "origin", "main"], seedPath);
  };

  return { root: await realpath(root), repoPath, barePath: await realpath(barePath), advanceOrigin };
}

export interface ClaudeStub {
  /** Wrapper that ignores claude's args and stays alive — pane shows comm "9.9.9". */
  readonly ok: string;
  /** Wrapper that prints an error and exits nonzero — the claude_died case. */
  readonly failing: string;
  readonly version: string;
}

/**
 * pane_current_command reports the executable's comm name, which macOS sets
 * from the resolved binary's basename. Real claude shows "2.1.220" because
 * its installer stores the executable under a versioned filename. The stub
 * reproduces that: a copy of bun named "9.9.9" running a sleeper script.
 */
export async function makeClaudeStub(base: string): Promise<ClaudeStub> {
  const dir = join(base, "stub");
  await mkdir(dir, { recursive: true });

  const bunPath = Bun.which("bun");
  if (bunPath === null) throw new Error("bun not on PATH");
  const versioned = join(dir, "9.9.9");
  await Bun.write(versioned, Bun.file(bunPath));
  await chmod(versioned, 0o755);

  const sleeper = join(dir, "sleeper.ts");
  await Bun.write(sleeper, "await Bun.sleep(120_000);\n");

  const ok = join(dir, "claude");
  await Bun.write(ok, `#!/bin/bash\nexec "${versioned}" "${sleeper}"\n`);
  await chmod(ok, 0o755);

  const failing = join(dir, "claude-failing");
  // real claude takes >100ms to fail and reports errors on the pty's stdout;
  // instant exit + stderr would lose the output race and the capture
  await Bun.write(failing, `#!/bin/bash\nsleep 0.3\necho "boom: untrusted workspace"\nexit 2\n`);
  await chmod(failing, 0o755);

  return { ok, failing, version: "9.9.9" };
}

/**
 * Blocks until a directory watch armed on `dir` is actually delivering events.
 *
 * macOS brings an `fs.watch` FSEvents stream up asynchronously, so `watch()`
 * returning does not mean it is live — a write landing in that window is
 * dropped outright, measured at ~20% under a saturated `--parallel` run and 0%
 * unloaded. No deadline recovers it: the event is never delivered at all, which
 * is what made these look like slow tests rather than lost ones. The daemon
 * never meets this in production (it arms the watch at startup and edits arrive
 * long afterwards); tests edit microseconds later, so they wait here first.
 *
 * A second watcher on the same directory is the signal: it is armed after the
 * one under test, so once it delivers, the earlier one is live too. Its own
 * sentinel writes reach the supervisor as changes it deep-equals away.
 */
export async function awaitWatcherLive(dir: string): Promise<void> {
  const sentinel = join(dir, ".watch-probe");
  const poke = (): void => void writeFile(sentinel, String(Date.now())).catch(() => {});
  let probe: ReturnType<typeof watch> | null = null;
  // Poked repeatedly rather than once: the stream comes up at some unobservable
  // point, and only a change *after* that is delivered.
  const poking = setInterval(poke, 10);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no watch event from ${dir} in 5s — fs.watch is not working here`)),
        5_000,
      );
      probe = watch(dir, () => {
        clearTimeout(timer);
        resolve();
      });
      poke();
    });
  } finally {
    clearInterval(poking);
    (probe as ReturnType<typeof watch> | null)?.close();
    await rm(sentinel, { force: true });
  }
}

/**
 * Replaces a fixed sleep before a *positive* assertion, which is a latent flake:
 * the sleep has to outlast the slowest machine, asserts nothing about what it
 * waited for, and reports a timeout rather than the thing that never happened.
 * A sleep before a *negative* assertion is fine — a non-event can't be polled.
 */
export async function pollUntil(
  ready: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await ready()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await Bun.sleep(10);
  }
}

export interface ConfigTrigger {
  /** Stands in for `watchConfigFile`: keeps the callback instead of arming `fs.watch`. */
  readonly watch: typeof watchConfigFile;
  /** Delivers one change, as the real watcher would once its debounce elapsed. */
  readonly fire: () => void;
  /** False before the supervisor arms and after it unwatches. */
  readonly watching: () => boolean;
}

/**
 * The supervisor's config-watch seam, driven by the test instead of by the
 * filesystem. Everything about *reacting* to a config change — the deep-equal
 * guard, the bad-edit and rollback paths — is then exercised with no timing at
 * all: write the file, fire, and `current()` resolves when the reload is done.
 * Only tests about the watcher itself need the real thing (and
 * `awaitWatcherLive` with it).
 */
export function makeConfigTrigger(): ConfigTrigger {
  let onChange: (() => void) | null = null;
  return {
    watch: (cb) => {
      onChange = cb;
      return (): void => {
        onChange = null;
      };
    },
    fire: (): void => {
      if (onChange === null) throw new Error("fire() before the supervisor armed its watch");
      onChange();
    },
    watching: (): boolean => onChange !== null,
  };
}
