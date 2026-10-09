import { watch } from "node:fs";
import { chmod, link, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

/** A local clone with one commit — `git worktree add` needs one to branch from. Returns its canonical path. */
export async function makeClone(root: string, rel: string): Promise<string> {
  const repo = join(root, rel);
  await mkdir(repo, { recursive: true });
  await run(["git", "init", "-q", "-b", "main"], repo);
  await run(["git", ...GIT_ID, "commit", "-q", "--allow-empty", "-m", "init"], repo);
  return realpath(repo);
}

/** Like `makeClone`, but with its git dir at `gitDir` and only a pointer file at `.git`. */
export async function makeSeparateGitDirClone(root: string, rel: string, gitDir: string): Promise<string> {
  const repo = join(root, rel);
  await mkdir(dirname(gitDir), { recursive: true }); // git won't create the git dir's parent
  await run(["git", "init", "-q", "-b", "main", "--separate-git-dir", gitDir, repo]);
  await run(["git", ...GIT_ID, "commit", "-q", "--allow-empty", "-m", "init"], repo);
  return realpath(repo);
}

/** A linked worktree of `main` at `path`, on a new branch named after it. */
export async function addWorktree(main: string, path: string, ...config: readonly string[]): Promise<void> {
  await run(["git", ...config, "worktree", "add", "-q", "-b", `wt-${basename(path)}`, path], main);
}

export interface ClaudeStub {
  /** Wrapper that records its argv to `argvFile`, titles its pane like a started claude, and stays alive. */
  readonly ok: string;
  /** Like `ok` but never titles the pane — a claude parked on a startup dialog. */
  readonly stuck: string;
  /** Wrapper that prints an error and exits nonzero — the claude_died case. */
  readonly failing: string;
  /** Overwritten on every `ok` launch — rm it before a spawn whose argv the test reads. */
  readonly argvFile: string;
  /** Polls for the record (pane startup can lag the spawn), then returns the argv. */
  readonly argv: () => Promise<readonly string[]>;
  /** SEANCE_MACHINE_TAG as the launch saw it, null when unset. Read alongside `argv`, which it waits on. */
  readonly machineTag: () => Promise<string | null>;
}

const WARM_FLAG = "--stub-warm";

/**
 * Reproduces what tmux sees of a real claude on each host. The native
 * installer keeps the binary under a versioned filename and execs it through a
 * `claude` symlink: macOS tmux reports the resolved basename ("2.1.267"), Linux
 * tmux reports argv[0] ("claude"). Bun under the name "9.9.9", exec'd with
 * `-a claude`, shows both faces. Registration is the pane title claude sets
 * once its TUI is up — the sleeper sets one a beat after starting, or never,
 * so the alive-but-unregistered path is reachable without a real dialog.
 */
export async function makeClaudeStub(base: string): Promise<ClaudeStub> {
  const dir = join(base, "stub");
  await mkdir(dir, { recursive: true });

  const versioned = join(dir, "9.9.9");
  // A hard link, not a copy: macOS scans every never-executed file on its first
  // exec (XprotectService), one file at a time machine-wide, ~0.8s for bun — so
  // five suites' copies queued each first spawn seconds past its registration
  // budget. A link is the running bun's own inode, already scanned; the kernel
  // still reports the link's name. That inode *is* the install, so nothing may
  // write or chmod through it: the rm makes both paths start from no file, and
  // the copy (for where a link can't reach — another filesystem, Linux's
  // protected_hardlinks) is then always a new inode.
  await rm(versioned, { force: true });
  await link(process.execPath, versioned).catch(async () => {
    await Bun.write(versioned, Bun.file(process.execPath));
    await chmod(versioned, 0o755);
  });

  const sleeper = join(dir, "sleeper.ts");
  await Bun.write(
    sleeper,
    [
      'if (Bun.argv[2] === "titled") {',
      "  await Bun.sleep(300);",
      '  process.stdout.write("\\x1b]2;\u2733 stub\\x1b\\\\");',
      "}",
      "await Bun.sleep(120_000);",
      "",
    ].join("\n"),
  );

  // Each wrapper is new, so each pays the first-exec scan above (~0.2s idle,
  // seconds behind a busy queue). The warm-up below pays it here, in setup,
  // rather than inside the first spawn's registration budget; the flag exits
  // before the tag or argv record is touched.
  const head = `#!/bin/bash\n[ "$1" = ${WARM_FLAG} ] && exit 0\n`;

  const ok = join(dir, "claude");
  const argvFile = `${ok}.argv`;
  const tagFile = `${ok}.tag`;
  // NUL separators: seed prompts carry newlines, so a line-based record would lie.
  // The tag is written first, so a complete argv record implies it landed.
  await Bun.write(
    ok,
    head +
      [
        `rm -f "${tagFile}"`,
        `if [ -n "\${SEANCE_MACHINE_TAG+x}" ]; then printf '%s' "$SEANCE_MACHINE_TAG" > "${tagFile}"; fi`,
        `printf '%s\\0' "$@" > "${argvFile}"`,
        `exec -a claude "${versioned}" "${sleeper}" titled`,
        "",
      ].join("\n"),
  );
  await chmod(ok, 0o755);

  const stuck = join(dir, "claude-stuck");
  await Bun.write(stuck, `${head}exec -a claude "${versioned}" "${sleeper}" untitled\n`);
  await chmod(stuck, 0o755);

  const failing = join(dir, "claude-failing");
  // real claude takes >100ms to fail and reports errors on the pty's stdout;
  // instant exit + stderr would lose the output race and the capture
  await Bun.write(failing, `${head}sleep 0.3\necho "boom: untrusted workspace"\nexit 2\n`);
  await chmod(failing, 0o755);

  await Promise.all([
    run([versioned, "--version"]),
    ...[ok, stuck, failing].map((wrapper) => run([wrapper, WARM_FLAG])),
  ]);

  const argv = async (): Promise<readonly string[]> => {
    // the redirect creates the file before printf writes a byte, so existence is
    // not the signal: a read inside that window returns "" and a `not.toContain`
    // assertion passes vacuously. The trailing NUL is what says the write landed.
    const written = async (): Promise<boolean> => {
      const record = await Bun.file(argvFile)
        .text()
        .catch(() => "");
      return record.endsWith("\0");
    };
    await pollUntil(written, `claude stub argv at ${argvFile}`);
    return (await Bun.file(argvFile).text()).split("\0").slice(0, -1);
  };
  const machineTag = async (): Promise<string | null> => {
    await argv();
    return Bun.file(tagFile)
      .text()
      .catch(() => null);
  };
  return { ok, stuck, failing, argvFile, argv, machineTag };
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
