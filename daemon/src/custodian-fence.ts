import { COMMANDS, CUSTODIAN_OWNER_VERBS } from "./commands.ts";

/**
 * The custodian round's settings, generated (docs/custodian.md, "The fence"; DESIGN.md, "The custodian's seat"). Pure:
 * no I/O. The deny list is for a cheap model's mistakes, never a boundary (C21) — a `bash -c` around a denied command
 * gets through. What bounds an injected round is the sandbox's masks (it reads nothing but its own directories and the
 * read-only toolchain, reaches no network and one acting socket, its own) plus the daemon's verbs behind that socket
 * (C19: every change goes through a verb the daemon checks).
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
  // The round has no tmux socket and no network, so neither can work; a read goes through `seanced custodian capture`
  // and `pr`. Denied whole so a cheap model does not spend its turns on them.
  "tmux",
  "gh",
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
 * A mistake guard for a cheap model, never a boundary. What keeps the owner's verbs from a round is its sandbox: it
 * neither reads nor writes `stateDir()` (bar its own round dir) and reaches no tmux socket, so a `bash -c` around them
 * finds no files to act on. Every task session runs as the same uid, though, and can write `custodian/state.json` and
 * `round-request` directly, without the CLI's audit line. The boundary for those files is the owner's uid; the audit
 * covers the CLI only, and the seat's request spacing bounds what a looping writer can cost.
 */
export const DENY: readonly string[] = [
  ...PLAIN_DENIED.flatMap((command) => [`Bash(${command})`, `Bash(${command} *)`]),
  ...GIT_DENIED.flatMap((subcommand) => fourForms("git", subcommand)),
  "Bash(seanced)",
  ...COMMANDS.filter((name) => name !== "custodian").map((name) => `Bash(seanced ${name}*)`),
  ...CUSTODIAN_OWNER_VERBS.flatMap((verb) => [`Bash(seanced custodian ${verb})`, `Bash(seanced custodian ${verb} *)`]),
  "Bash(seanced custodian notes --clear)",
  "Bash(seanced custodian notes --clear *)",
];

/** A path the Read tool is denied: a file, or a directory with everything under it. */
export interface ReadDeny {
  readonly path: string;
  readonly dir: boolean;
}

export interface FenceInput {
  readonly platform: "darwin" | "linux";
  /** The round's cwd: the one directory a sandboxed command may not write, and the one the Read tool may read. */
  readonly roundDir: string;
  /** The round's socket's directory: macOS lists it alone in `allowUnixSockets`. */
  readonly socketDir: string;
  /** Sandbox masks (`roundSandboxPaths`): what a sandboxed command cannot read, and what it re-reads inside them. */
  readonly denyRead: readonly string[];
  readonly allowRead: readonly string[];
  /** Secrets denied to the Read tool too, which runs outside the sandbox (`roundReadDenies`). */
  readonly readDenies: readonly ReadDeny[];
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
    readonly enableWeakerNestedSandbox?: true;
    readonly filesystem: {
      readonly denyWrite: readonly string[];
      readonly denyRead: readonly string[];
      readonly allowRead: readonly string[];
    };
    readonly network: {
      /** Present and empty: an absent key lifts the network restriction (and, on Linux, `--unshare-net`). */
      readonly allowedDomains: readonly [];
      readonly allowUnixSockets?: readonly string[];
      readonly allowAllUnixSockets?: true;
    };
  };
}

/**
 * Claude Code's path-rule form: `Read(//abs)` is an absolute path, and `Read(/abs)` with one slash silently matches
 * nothing, so every rule is built as `/` plus an absolute path.
 */
const readRule = (path: string, dir: boolean): string => `Read(/${path}${dir ? "/**" : ""})`;

/**
 * The `--settings` JSON. The round has no Read tool and `allow` names only the verbs (under `dontAsk` anything not
 * allowed is refused); `deny` still names the known secrets for the Read tool, which runs outside the sandbox, in case
 * Claude Code auto-allows a read or a later change brings the tool back. Unix sockets differ
 * by platform: macOS lists the round socket's directory alone, so no other path socket connects; on Linux
 * `allowUnixSockets` is ignored (seccomp cannot filter by path) and `allowAllUnixSockets` stays, because the masks
 * hide every path socket but the round's own — and it drops bubblewrap's `--disable-userns`, so it fails where
 * `/proc/sys` is read-only unless `enableWeakerNestedSandbox` is set. `allowedDomains: []` is no network at all.
 */
export function custodianFence(input: FenceInput): CustodianFence {
  return {
    permissions: {
      defaultMode: "dontAsk",
      allow: ["Bash(seanced custodian *)"],
      deny: [...DENY, ...input.readDenies.map((entry) => readRule(entry.path, entry.dir))],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      ...(input.platform === "linux" && input.weakerNested ? { enableWeakerNestedSandbox: true as const } : {}),
      filesystem: { denyWrite: [input.roundDir], denyRead: input.denyRead, allowRead: input.allowRead },
      network: {
        allowedDomains: [],
        ...(input.platform === "darwin"
          ? { allowUnixSockets: [input.socketDir] }
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
