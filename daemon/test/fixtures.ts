import { chmod, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
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
