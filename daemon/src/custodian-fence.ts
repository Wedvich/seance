import { COMMANDS, CUSTODIAN_OWNER_VERBS } from "./commands.ts";

/**
 * The custodian round's shell fence, generated (docs/custodian.md, "The fence"; DESIGN.md, "The custodian's seat").
 * Pure: no I/O. The fence is for a cheap model's mistakes, never a boundary (C21) — a `bash -c` around a denied
 * command gets through — so the intended bound under injection is C19: every change goes through a verb the daemon
 * checks. It holds only once the round cannot reach the tmux socket and the daemon's plain ops (item 4b; rounds are
 * held until then).
 */

/** Commands a round never needs: each is denied whole, as `Bash(<c>)` and `Bash(<c> *)`. */
const PLAIN_DENIED = [
  "rm",
  "rmdir",
  "kill",
  "pkill",
  "killall",
  // Mistake guards like `kill` (C21): a round restarting the daemon through the user's service manager, or reaching
  // the sockets `allowAllUnixSockets` leaves open on Linux, is a plausible cheap-model slip.
  "systemctl",
  "launchctl",
  "docker",
  "podman",
  "ssh",
] as const;

/** `git` subcommands of C20; each comes in four forms (a global option such as `-C` is not unwrapped). */
const GIT_DENIED = [
  "worktree remove",
  "branch -d",
  "branch -D",
  "branch --delete",
  "push",
  "reset",
  "clean",
  "checkout",
  "switch",
  "stash",
] as const;

/**
 * `tmux` subcommands that type, kill, or run a shell. The tmux server runs outside the sandbox and the round's shell
 * can reach its socket, so a command that runs a shell there escapes C20's write fence. The spec's tested list is
 * `send-keys`, `send`, `paste-buffer`, `pasteb`, `kill-*`, `respawn-*`; the rest are additions (DESIGN.md): shell
 * runners, option setters that could set `@seance-task` or `@seance-custodian`, buffer feeders for a paste, and the
 * aliases the spec's list missed. `capture-pane`, `list-*` and `display-message` stay free.
 */
const TMUX_DENIED = [
  "send-keys",
  "send",
  "send-prefix",
  "paste-buffer",
  "pasteb",
  "kill-*",
  "killp",
  "killw",
  "respawn-*",
  "respawnp",
  "respawnw",
  "run-shell",
  "run",
  "new-window",
  "neww",
  "split-window",
  "splitw",
  "new-session",
  "new",
  "if-shell",
  "if",
  "pipe-pane",
  "pipep",
  "display-popup",
  "popup",
  "source-file",
  "source",
  "set-hook",
  "command-prompt",
  "confirm-before",
  "confirm",
  "set-option",
  "set",
  "set-window-option",
  "setw",
  "load-buffer",
  "loadb",
  "set-buffer",
  "setb",
  "unlink-window",
  "unlinkw",
  // State other readers trust (a pane's title and options, a window's identity, the server's environment, which every
  // session started later inherits) or commands that run later.
  "set-environment",
  "setenv",
  "bind-key",
  "bind",
  "display-menu",
  "menu",
  "select-pane",
  "selectp",
  "rename-window",
  "renamew",
  "rename-session",
  "rename",
  "swap-pane",
  "swapp",
  "swap-window",
  "swapw",
  "move-window",
  "movew",
  "move-pane",
  "movep",
  "link-window",
  "linkw",
  "join-pane",
  "joinp",
  "break-pane",
  "breakp",
  "switch-client",
  "switchc",
  "detach-client",
  "detach",
  // The server writes the buffer as the user, outside the sandbox (`capture-pane -b x` fills one); `-C` on attach reads
  // commands from stdin, past every entry here; the lock family runs `lock-command`; the modes make the drain ask's
  // `send-keys -l` land as mode keys and `capture-pane` hash another screen; `server-access` edits the server's ACL.
  "save-buffer",
  "saveb",
  "attach-session",
  "attach",
  "lock-server",
  "lock",
  "lock-session",
  "locks",
  "lock-client",
  "lockc",
  "copy-mode",
  "clock-mode",
  "server-access",
] as const;

/**
 * `gh` verbs that write, each as a whole word anywhere after `gh` (`fourForms`). The spec's list is the first eleven;
 * the rest write to GitHub over the allowed network too. A whole word, not a prefix: `closed`, `mergeable`,
 * `reviewDecision`, `comments` and `additions` are the reads a round makes (`--state closed`, `--json mergeable`),
 * and a word that merely starts with a verb must not be refused.
 */
const GH_WRITE_VERBS = [
  "create",
  "delete",
  "edit",
  "merge",
  "comment",
  "close",
  "reopen",
  "review",
  "ready",
  "cancel",
  "rerun",
  "update-branch",
  "delete-asset",
  "revert",
  "lock",
  "unlock",
  "pin",
  "unpin",
  "transfer",
  "develop",
  "archive",
  "unarchive",
  "rename",
  "sync",
  "set-default",
  "fork",
  "add",
  "upload",
  "set",
  "clone",
  "link",
  "unlink",
  "copy",
  "item-add",
  "item-create",
  "item-edit",
  "item-delete",
  "item-archive",
  "field-create",
  "field-delete",
  "mark-template",
] as const;

/** `gh` commands denied whole: nothing a round reads lives there. */
const GH_WHOLE_DENIED = [
  "workflow",
  "auth",
  "secret",
  "variable",
  "extension",
  "codespace",
  "ssh-key",
  "gpg-key",
] as const;

/** `gh api` flags that write. A round reads through `gh pr view --json`, `gh run view` and plain `gh api <path>`. */
const GH_API_WRITE_FLAGS = ["-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"] as const;

function fourForms(program: string, subcommand: string): readonly string[] {
  return [
    `Bash(${program} ${subcommand})`,
    `Bash(${program} ${subcommand} *)`,
    `Bash(${program} * ${subcommand})`,
    `Bash(${program} * ${subcommand} *)`,
  ];
}

/**
 * The deny list. The `seanced` entries come from the CLI's own command table (`commands.ts`), every command but
 * `custodian`, so a command added later is denied by default; `custodian-fence.test.ts` asserts the coverage.
 * Deny beats allow, so `Bash(seanced *)` would refuse `seanced custodian` too; the owner's verbs
 * (`CUSTODIAN_OWNER_VERBS`) and `notes --clear` are denied under it by generated entries, since the allow covers
 * `seanced custodian *`.
 *
 * A mistake guard for a cheap model, never a boundary. The round's sandboxed Bash cannot write `stateDir()`, but until
 * docs/custodian.md item 4b the round still reaches the tmux socket, so `tmux run-shell "seanced custodian pause"` runs
 * outside the sandbox; and every task session runs as the same uid and can write `custodian/state.json` and
 * `round-request` directly, without the CLI's audit line. The boundary for those files is the owner's uid; the audit
 * covers the CLI only, and the seat's request spacing bounds what a looping writer can cost.
 */
export const DENY: readonly string[] = [
  ...PLAIN_DENIED.flatMap((command) => [`Bash(${command})`, `Bash(${command} *)`]),
  ...GIT_DENIED.flatMap((subcommand) => fourForms("git", subcommand)),
  ...TMUX_DENIED.flatMap((subcommand) => fourForms("tmux", subcommand)),
  ...GH_WRITE_VERBS.flatMap((verb) => fourForms("gh", verb)),
  ...GH_WHOLE_DENIED.flatMap((command) => [`Bash(gh ${command})`, `Bash(gh ${command} *)`]),
  // `*` matches no empty gap (verified on Linux), so the flag directly after `api` needs its own entry.
  ...GH_API_WRITE_FLAGS.flatMap((flag) => [`Bash(gh api * ${flag}*)`, `Bash(gh api ${flag}*)`]),
  "Bash(seanced)",
  ...COMMANDS.filter((name) => name !== "custodian").map((name) => `Bash(seanced ${name}*)`),
  ...CUSTODIAN_OWNER_VERBS.flatMap((verb) => [`Bash(seanced custodian ${verb})`, `Bash(seanced custodian ${verb} *)`]),
  "Bash(seanced custodian notes --clear)",
  "Bash(seanced custodian notes --clear *)",
];

export interface FenceInput {
  readonly platform: "darwin" | "linux";
  /** The round's cwd: the one directory a sandboxed command may not write. */
  readonly roundDir: string;
  /**
   * The flags file (`custodian-flags.ts`): its notes quote untrusted pane text, which a later round must not read back
   * (the `sessions` reply leaves them out for the same reason). Denied to `Read` and to the sandbox; a mistake guard
   * like the rest, since until item 4b the round still reaches the tmux socket and every other file its uid can read.
   */
  readonly flagsPath: string;
  /** macOS only: the directories whose sockets the round may reach (tmux's, the daemon's run dir). */
  readonly socketDirs: readonly string[];
  /** Linux only: `/proc/sys` is read-only (a container), where `allowAllUnixSockets` needs the weaker nested mode. */
  readonly weakerNested: boolean;
}

export interface CustodianFence {
  readonly permissions: {
    readonly defaultMode: "dontAsk";
    readonly allow: readonly string[];
    readonly deny: readonly string[];
  };
  readonly sandbox: {
    readonly enabled: true;
    readonly failIfUnavailable: true;
    readonly allowUnsandboxedCommands: false;
    readonly autoAllowBashIfSandboxed: true;
    readonly enableWeakerNetworkIsolation: true;
    readonly enableWeakerNestedSandbox?: true;
    readonly filesystem: { readonly denyWrite: readonly string[]; readonly denyRead: readonly string[] };
    readonly network: {
      readonly allowedDomains: readonly string[];
      readonly allowUnixSockets?: readonly string[];
      readonly allowAllUnixSockets?: true;
    };
  };
}

/**
 * The `--settings` JSON. Unix sockets differ by platform: macOS lists directories; on Linux `allowUnixSockets` is
 * ignored (seccomp cannot filter by path) and tmux and the daemon's socket need `allowAllUnixSockets`, which drops
 * bubblewrap's `--disable-userns` and so fails where `/proc/sys` is read-only unless `enableWeakerNestedSandbox` is set.
 * `enableWeakerNetworkIsolation` is macOS's `trustd` key, left set on Linux as verified.
 */
export function custodianFence(input: FenceInput): CustodianFence {
  return {
    permissions: {
      defaultMode: "dontAsk",
      allow: ["Read", "Bash(seanced custodian *)"],
      // `//` is the permission syntax for an absolute path.
      deny: [...DENY, `Read(/${input.flagsPath})`],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      enableWeakerNetworkIsolation: true,
      ...(input.platform === "linux" && input.weakerNested ? { enableWeakerNestedSandbox: true as const } : {}),
      filesystem: { denyWrite: [input.roundDir], denyRead: [input.flagsPath] },
      network: {
        allowedDomains: ["github.com", "api.github.com", "*.githubusercontent.com"],
        ...(input.platform === "darwin"
          ? { allowUnixSockets: input.socketDirs }
          : { allowAllUnixSockets: true as const }),
      },
    },
  };
}

const PROC_SYS_PROBE = "/proc/sys/user/max_user_namespaces";

/**
 * Whether the mount holding `/proc/sys/user/max_user_namespaces` is read-only, from `/proc/self/mountinfo`'s text: the
 * mount whose mount point is the longest path prefix of it (the later line wins a tie), its per-mount options (field
 * 6) holding `ro`. That is the verified failure (an LXC container: `bwrap: cannot open
 * /proc/sys/user/max_user_namespaces: Read-only file system`). A write probe would be wrong: the file is root-owned
 * everywhere, and bubblewrap writes it inside its own user namespace.
 */
export function procSysReadOnly(mountinfo: string): boolean {
  let best: { readonly length: number; readonly options: readonly string[] } | null = null;
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    const mountPoint = fields[4];
    const options = fields[5];
    if (mountPoint === undefined || options === undefined || !mountPoint.startsWith("/")) continue;
    const covers = mountPoint === "/" || PROC_SYS_PROBE === mountPoint || PROC_SYS_PROBE.startsWith(`${mountPoint}/`);
    if (!covers || (best !== null && mountPoint.length < best.length)) continue;
    best = { length: mountPoint.length, options: options.split(",") };
  }
  return best?.options.includes("ro") === true;
}
