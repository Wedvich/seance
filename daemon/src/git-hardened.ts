import { open } from "node:fs/promises";
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
 * ssh ignores all of those, so the network calls opt into `networkEnv` too,
 * which adds BatchMode where a terminal could be prompted.
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
      // a timed-out fetch would otherwise wait on its transport child, timeout or not
      killGroup: true,
      ...(stdin === undefined ? {} : { stdin }),
    },
  );
}

/** Never prompt, never override: see `sshBatchEnv`. */
const BATCH_SSH = "ssh -o BatchMode=yes";

/**
 * Whether the daemon has a controlling terminal, i.e. whether ssh could prompt at all. A launchd or systemd
 * service has none and cannot be asked, so BatchMode buys nothing there; and on macOS `UseKeychain` may read
 * a passphrase inside the very prompt loop BatchMode disables, so adding it could break fetches that work
 * today. Memoized: it cannot change for the process. Windows has no `/dev/tty`, so it reads as none.
 */
export type TerminalProbe = () => Promise<boolean>;

let terminalMemo: Promise<boolean> | undefined;

export const hasControllingTerminal: TerminalProbe = () => {
  terminalMemo ??= open("/dev/tty", "r").then(
    async (handle) => {
      await handle.close();
      return true;
    },
    () => false,
  );
  return terminalMemo;
};

/** The values of `ssh.variant` / `GIT_SSH_VARIANT` under which ssh takes OpenSSH's `-o`. */
function opensshVariant(value: string): boolean {
  return value === "ssh" || value === "auto";
}

const SSH_CONFIG_KEYS = String.raw`^(core\.sshcommand|ssh\.variant)$`;

/**
 * What makes ssh fail instead of asking for a passphrase on the daemon's
 * terminal: `BatchMode=yes`, which ssh honours where it ignores
 * `GIT_TERMINAL_PROMPT`. An agent-loaded key still works. Only with a
 * controlling terminal, and only when the user chose no ssh of their own: git
 * ranks `GIT_SSH_COMMAND`, then `core.sshCommand`, then `GIT_SSH`, then plain
 * `ssh`, so setting `GIT_SSH_COMMAND` (or `-c core.sshCommand`) would silently
 * replace theirs. A non-OpenSSH `ssh.variant` / `GIT_SSH_VARIANT` (putty,
 * plink...) would read `-o` as something else, so it is left alone too. One
 * `git config --get-regexp` in the repo answers both configs (includes count,
 * keys come back lowercased): exit 1 is none set, any other failure leaves the
 * env alone. `env` is the caller's, the one the fetch itself runs with, so
 * probe and fetch read the same config. One spawn, so callers run it only
 * when they really go to the network.
 */
export async function sshBatchEnv(
  repoPath: string,
  env: Readonly<Record<string, string | undefined>>,
  terminal: TerminalProbe = hasControllingTerminal,
): Promise<Readonly<Record<string, string>>> {
  const effective = { ...process.env, ...env };
  if (effective["GIT_SSH_COMMAND"] !== undefined || effective["GIT_SSH"] !== undefined) return {};
  const variant = effective["GIT_SSH_VARIANT"];
  if (variant !== undefined && !opensshVariant(variant)) return {};
  if (!(await terminal())) return {};
  const configured = await hardenedGit(
    repoPath,
    ["config", "--get-regexp", SSH_CONFIG_KEYS],
    undefined,
    undefined,
    env,
  );
  if (configured.exitCode === 1) return { GIT_SSH_COMMAND: BATCH_SSH };
  if (configured.exitCode !== 0) return {};
  let configVariant: string | undefined;
  for (const line of configured.stdout.split("\n")) {
    const [key = "", ...rest] = line.split(/\s+/u);
    if (key === "core.sshcommand") return {};
    // Git reads the last one set.
    if (key === "ssh.variant") configVariant = rest.join(" ");
  }
  // `GIT_SSH_VARIANT` outranks `ssh.variant`: an env variant that is OpenSSH settles it.
  const settled = variant !== undefined || configVariant === undefined || opensshVariant(configVariant);
  return settled ? { GIT_SSH_COMMAND: BATCH_SSH } : {};
}

/** The env for a `hardenedGit` call that goes to the network: the caller's, plus `sshBatchEnv`'s. */
export async function networkEnv(
  repoPath: string,
  env: Readonly<Record<string, string | undefined>> = {},
  terminal?: TerminalProbe,
): Promise<Readonly<Record<string, string | undefined>>> {
  return { ...env, ...(await sshBatchEnv(repoPath, env, terminal)) };
}
