import { readFile, open } from "node:fs/promises";
import { join } from "node:path";
import { exec, type ExecResult } from "./exec.ts";
import { resolveCommonDir } from "./gitdir.ts";

/**
 * Git for code that runs in every scanned repo, or fetches before a spawn —
 * `seanced reap` and `base-fetch.ts`. Repo-local config executes, and a session can
 * write it (`git config` in a worktree writes the clone's shared `.git/config`):
 * `core.fsmonitor` would start a hook (or a daemon) per worktree and hooks run on
 * ref updates, so both are off for every call, as is the `ext::` transport, which
 * runs its URL as a command. The rest of what a call could run (`core.sshCommand`,
 * a credential helper, a merge driver) is refused per repo before the calls that
 * would run it: `networkGit` and `classifyTip`'s `merge-tree`, through
 * `repoConfigRefusal`. `GIT_OPTIONAL_LOCKS=0` keeps `status` from
 * refreshing the index — whose mtime is one of reap's age signals, and reap must
 * not reset the age it is measuring. `GIT_TERMINAL_PROMPT=0`,
 * `credential.interactive=false`, exec's ignored stdin and a timeout keep a fetch
 * that wants credentials from hanging, as Claude Code does; `stdin` is for the
 * plumbing that reads it (`patch-id`, `diff-tree --stdin`), never a fetch.
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
      // Outranks any `protocol.allow` / `protocol.ext.allow` a repo sets.
      "-c",
      "protocol.ext.allow=never",
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

/**
 * Repo-local (and worktree) config families that make one of the daemon's own git calls run a program the
 * session chose, or fetch from somewhere it chose: an ssh or proxy command, an askpass, a credential helper, an
 * upload-pack, a protocol or URL rewrite (`ext::` runs its URL), an include that could hold any of them, a merge
 * driver or filter (`merge-tree`), an attributes file naming one. `*` stands for any subsection. The same keys in
 * global or system config are the owner's and still apply. Labels, not the keys themselves, are what is reported:
 * a subsection can be a URL that carries credentials.
 */
const REFUSED_FAMILIES = [
  "core.sshcommand",
  "core.gitproxy",
  "core.askpass",
  "core.attributesfile",
  // A clone with its own credential helper stops being fetched by the daemon (owner decision R8 #2).
  "credential.*",
  "remote.*.uploadpack",
  "remote.*.receivepack",
  "protocol.allow",
  "protocol.*.allow",
  "url.*.insteadof",
  "include.*",
  "includeif.*",
  "merge.*.driver",
  "filter.*",
] as const;

const FAMILY_PATTERNS = REFUSED_FAMILIES.map(
  (family) => [family, new RegExp(`^${family.replaceAll(".", String.raw`\.`).replaceAll("*", ".+")}$`, "u")] as const,
);

/** The first refused family among config names (any case: git lowercases all but subsections); null when none. */
export function refusedFamily(names: readonly string[]): string | null {
  for (const name of names) {
    const lower = name.toLowerCase();
    const hit = FAMILY_PATTERNS.find(([, pattern]) => pattern.test(lower));
    if (hit !== undefined) return hit[0];
  }
  return null;
}

const ATTRIBUTES_REFUSAL = "merge= in info/attributes";

/**
 * What makes a repo's own config unsafe for the calls the daemon runs there unprompted, or null. One
 * `git config --list` (includes followed, scope shown) and a read of `info/attributes`, which a session can also
 * write and where a `merge=` line names a driver for `merge-tree`. Fails closed: config git cannot list, or
 * attributes that exist but cannot be read, refuse.
 */
export async function repoConfigRefusal(repoPath: string): Promise<string | null> {
  const listed = await hardenedGit(repoPath, ["config", "--list", "--show-scope", "--name-only", "-z"]);
  if (listed.exitCode !== 0) return "unreadable config";
  // `-z` with `--show-scope`: scope and name alternate, each NUL-terminated.
  const fields = listed.stdout.split("\0");
  const names: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === "local" || fields[i] === "worktree") names.push(fields[i + 1] ?? "");
  }
  const family = refusedFamily(names);
  if (family !== null) return family;
  const commonDir = await resolveCommonDir(repoPath);
  if (commonDir === null) return null;
  let attributes: string;
  try {
    attributes = await readFile(join(commonDir, "info", "attributes"), "utf8");
  } catch (err) {
    const code = err instanceof Error && "code" in err ? err.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? null : ATTRIBUTES_REFUSAL;
  }
  const namesDriver = attributes
    .split("\n")
    .some((line) => !line.trimStart().startsWith("#") && /(?:^|\s)merge=/u.test(line));
  return namesDriver ? ATTRIBUTES_REFUSAL : null;
}

/** A network call `networkGit` did not make; `family` is safe to log. */
export interface Refused {
  readonly refused: string;
}

export function refusalDetail(refused: Refused): string {
  return `refused: repo-local ${refused.refused}`;
}

/**
 * Every git call that goes to the network goes through here, so all of them get one environment: refused when
 * `repoConfigRefusal` says so, `hardenedGit`'s overrides and group kill, `GCM_INTERACTIVE=never` (Git Credential
 * Manager ignores `GIT_TERMINAL_PROMPT` and may raise a GUI on WSL/Windows) unless the user set their own, and
 * `sshBatchEnv`'s BatchMode. `env` is the caller's, layered under those.
 */
export async function networkGit(
  repoPath: string,
  args: readonly string[],
  timeoutMs: number,
  env: Readonly<Record<string, string | undefined>> = {},
  terminal?: TerminalProbe,
): Promise<ExecResult | Refused> {
  const refused = await repoConfigRefusal(repoPath);
  if (refused !== null) return { refused };
  const gcm = process.env["GCM_INTERACTIVE"] === undefined ? { GCM_INTERACTIVE: "never" } : {};
  const callerEnv = { ...gcm, ...env };
  const ssh = await sshBatchEnv(repoPath, callerEnv, terminal);
  return hardenedGit(repoPath, args, timeoutMs, undefined, { ...callerEnv, ...ssh });
}
