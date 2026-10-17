import { exec, type ExecResult } from "./exec.ts";

/**
 * Git for code that runs in every scanned repo, or fetches before a spawn —
 * `seanced reap` and `base-fetch.ts`. Repo-local config executes: `core.fsmonitor`
 * would start a hook (or a daemon) per worktree and hooks run on ref updates, so
 * both are off for every call. `GIT_OPTIONAL_LOCKS=0` keeps `status` from
 * refreshing the index — whose mtime is one of reap's age signals, and reap must
 * not reset the age it is measuring. `GIT_TERMINAL_PROMPT=0`,
 * `credential.interactive=false`, exec's ignored stdin and a timeout keep a fetch
 * that wants credentials from hanging, as Claude Code does; `stdin` is for the
 * plumbing that reads it (`patch-id`, `diff-tree --stdin`), never a fetch.
 * What still runs is what a fetch needs — credential helpers, `core.sshCommand`.
 * The branch-state emitter (`branch-state.ts`) makes its calls through it too.
 */
export async function hardenedGit(
  cwd: string,
  args: readonly string[],
  timeoutMs = 15_000,
  stdin?: string,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<ExecResult> {
  return exec(
    [
      "git",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.interactive=false",
      ...args,
    ],
    {
      cwd,
      timeoutMs,
      env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...env },
      ...(stdin === undefined ? {} : { stdin }),
    },
  );
}
