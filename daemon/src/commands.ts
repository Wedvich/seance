// Import-free on purpose: `main.ts` imports it statically, and `session-event` runs several times a turn in every
// Claude session on the machine (see main.ts's header).

/** The CLI's name on PATH. The daemon it runs (the service, its log and socket) is still `seanced`. */
export const CLI_NAME = "seance";

/** The CLI's name before the rename: `link` replaces a link under it, and the custodian fence denies it too. */
export const LEGACY_CLI_NAME = "seanced";

/**
 * Every command `seance` answers. The custodian fence's deny list is generated from this table (`custodian-fence.ts`:
 * every command but `custodian`), so a new command is denied to the round by default, and `main.ts`'s dispatch table
 * and `COMMAND_SPECS` are typed against it so none of them can drift.
 */
export const COMMANDS = [
  "init",
  "psk-import",
  "install",
  "uninstall",
  "link",
  "unlink",
  "restart",
  "update",
  "doctor",
  "status",
  "scan",
  "sessions",
  "spawn",
  "continue",
  "start",
  "close",
  "open",
  "pass",
  "amend",
  "despawn",
  "reap",
  "mcp",
  "mod",
  "adapter",
  "session-event",
  "inbox",
  "custodian",
  "raycast",
  "completion",
  "help",
] as const;

export type CommandName = (typeof COMMANDS)[number];

/**
 * `seance custodian <verb>`'s owner verbs: typed at this machine's shell, never a frame, a local-socket op or an app
 * op. `main.ts` dispatches them to `custodian-owner-cli.ts`, outside the round's verbs' import closure
 * (`custodian-cli.ts`), and the fence denies them to the round from this table.
 */
export const CUSTODIAN_OWNER_VERBS = ["status", "log", "round", "pause", "resume"] as const;

export interface FlagSpec {
  readonly flag: `-${string}`;
  readonly alias?: `-${string}`;
  /** The value's placeholder in help; absent for a switch. */
  readonly value?: string;
  /** The only values the parser takes, offered as completions. */
  readonly choices?: readonly string[];
  readonly repeatable?: true;
  readonly help: string;
}

/** What a command's first positional argument completes to: `repo` from this machine's last scan. */
export type ArgKind = "repo" | "command" | "dir";

export interface VerbSpec {
  readonly summary: string;
  readonly flags?: readonly FlagSpec[];
  /** A verb only another program calls (the round's): listed in help, never offered as a completion. */
  readonly internal?: true;
}

/** `close` and `open`'s account form: the account's hold at the leader (DESIGN.md, "Closing an account"). */
const ACCOUNT_FLAG: FlagSpec = {
  flag: "--account",
  value: "<account>",
  help: "an account (alias, email or id) instead of a machine",
};

export interface CommandSpec {
  /** One line: help's first line for the command and its completion description. */
  readonly summary: string;
  /** What follows `seance <command>` in its usage line, when it takes anything. */
  readonly usage?: string;
  /** Further help lines. */
  readonly details?: readonly string[];
  readonly flags?: readonly FlagSpec[];
  readonly verbs?: Readonly<Record<string, VerbSpec>>;
  readonly arg?: ArgKind;
  /** A command only another program calls (a mod's, the round's): listed in help, never offered as a completion. */
  readonly internal?: true;
}

const RELAY_NOTE = "needs the relay, and a PSK this shell or its daemon holds";

const SCOPE_FLAGS: readonly FlagSpec[] = [
  {
    flag: "--system",
    help: "the root-owned systemd unit that gets the TPM-sealed PSK delivered to it, needs sudo (docs/psk.md)",
  },
  { flag: "--user", value: "name", help: "with --system: the user the unit runs as" },
  { flag: "--state-dir", value: "path", help: "with --system: that user's state dir" },
  { flag: "--path", value: "dirs", help: "with --system: the PATH the unit records" },
];

const INSTALL_VERBS = (what: string): Readonly<Record<string, VerbSpec>> => ({
  install: { summary: `install ${what}` },
  uninstall: { summary: `uninstall ${what}` },
});

/**
 * Help and completion are both generated from this table (`USAGE`, `commandHelp`, and `completion.ts`), and the
 * parsers' usage errors take their line from `usageLine`. `commands.test.ts` holds every flag a parser in `cli.ts`
 * names to an entry here, and every choice list to the constant the parser checks against.
 */
export const COMMAND_SPECS: Readonly<Record<CommandName, CommandSpec>> = {
  init: { summary: "write config skeleton + generate deviceId (never the PSK)" },
  "psk-import": {
    summary: "store the PSK in the platform store (prompts, or reads a pipe; never argv)",
    details: ["macOS login keychain, WSL DPAPI blob, or Linux TPM-sealed blob"],
  },
  install: {
    summary: "install and start the service",
    usage: '[--system [--user <name>] [--state-dir <path>] [--path "$PATH"]]',
    details: ["macOS launchd plist; Linux/WSL systemd user unit + linger, plus a logon pin task on WSL"],
    flags: SCOPE_FLAGS,
  },
  uninstall: {
    summary: "stop the service and remove it, plus any symlink from link",
    usage: "[--system]",
    flags: SCOPE_FLAGS,
  },
  link: {
    summary: "put seance on PATH — a symlink to this file, so it tracks git pull",
    usage: "[dir]",
    details: ["also removes this checkout's link under the CLI's old name, seanced"],
    arg: "dir",
  },
  unlink: { summary: "remove the PATH symlink (only ones pointing at this checkout)" },
  restart: { summary: "restart the service (after git pull)" },
  update: {
    summary: "what a fleet update announce does, by hand: fast-forward the daemon's own checkout, bun install, restart",
    details: [
      "refuses a dirty, re-branched or diverged checkout; restarts a daemon still on an older sha even when current",
    ],
  },
  doctor: { summary: "preflight checks: config, binaries, roots, relay, service" },
  status: { summary: "service / socket / scan status" },
  scan: { summary: "discover repos now; caches for the next start unless a daemon is running" },
  sessions: { summary: "list running claude tmux windows, each with the id despawn takes" },
  spawn: {
    summary: "queue a session for the scheduler",
    usage:
      "[--now | [--start | --at <HH:MM|ISO> | --in <duration>] [--machine <name|here>] [--account <alias|email|id>] " +
      "[--not <machine|here>]... [--requires <trait>]... [--ref <source:id> [--ref-url <url>]]] [--autonomy <steer|checkpoint|auto>] <repo> [--here] [-t <title>] [[-p] <task>]",
    details: [RELAY_NOTE],
    arg: "repo",
    flags: [
      { flag: "--here", help: "run in the clone itself, not a fresh worktree" },
      { flag: "-t", value: "title", help: "the task's title" },
      { flag: "-p", value: "task", repeatable: true, help: "the prompt (bare words after the repo join it too)" },
      { flag: "--machine", value: "name|here", help: "pin it to a machine" },
      { flag: "--account", value: "alias|email|id", help: "pin it to an account" },
      { flag: "--not", value: "machine|here", repeatable: true, help: "keep it off a machine" },
      {
        flag: "--requires",
        value: "trait",
        repeatable: true,
        help: "only place it where every named trait is declared (traits in config.json; list_machines shows them)",
      },
      {
        flag: "--ref",
        value: "source:id",
        help: "what the task is for, e.g. linear:ENG-123 or github:owner/repo#12: shown in the app and by get_queue, read by nothing",
      },
      { flag: "--ref-url", value: "url", help: "the ref's https: URL, shown beside it; only with --ref" },
      {
        flag: "--start",
        help: "once the scheduler admits it, start it past the concurrency limit and a paused queue (as seance start)",
      },
      {
        flag: "--at",
        value: "HH:MM|ISO",
        help: "not before: the next HH:MM on this machine's clock, or a date-time (YYYY-MM-DDTHH:MM, local unless it ends in Z or an offset); never with --in, --start or --now",
      },
      {
        flag: "--in",
        value: "duration",
        help: "not before: from now, e.g. 90m, 2h or 1d2h; never with --at, --start or --now",
      },
      {
        flag: "--autonomy",
        value: "level",
        choices: ["steer", "checkpoint", "auto"],
        help: "how much the session decides on its own (default checkpoint; steer is plan mode)",
      },
      {
        flag: "--now",
        help: "spawn on this machine right away instead: no relay, key, leader or daemon needed; takes no pin flags, --requires, --ref, --start, --at or --in",
      },
    ],
  },
  continue: {
    summary:
      "resume a failed or cancelled task's, or a blocked awaiting-merge task's, session in its worktree, as a new queued task",
    usage: "<task-id> [-p|--prompt <note>] [--at <HH:MM|ISO> | --in <duration>]",
    details: [RELAY_NOTE],
    flags: [
      { flag: "-p", alias: "--prompt", value: "note", help: "a note to add" },
      { flag: "--at", value: "HH:MM|ISO", help: "not before: as spawn's --at; never with --in" },
      { flag: "--in", value: "duration", help: "not before: as spawn's --in; never with --at" },
    ],
  },
  start: {
    summary: "start a queued task now, past the concurrency limit and a paused queue (the app's Start now)",
    usage: "<task-id>",
    details: [RELAY_NOTE],
  },
  close: {
    summary: "close a machine, or with --account an account, to new scheduled work (default: this machine)",
    usage: "[<machine>] [--drain] [--now] [--wait] | --account <account>",
    details: [
      "where it and the leader support a soft close its running tasks finish where they are; --drain (or a plain close",
      "elsewhere) asks its sessions to pass themselves and has a leader that supports it pass what is left to other",
      "machines after 10 minutes; --drain or --now on a soft-closed machine starts its drain",
      "--account <alias|email|id> closes that account on every machine instead: nothing new is placed on it, its",
      "running sessions keep going and a task pinned to it waits; it takes no other word or flag",
      "over the relay, so needs a PSK this shell can read — a keyless box uses the PWA",
    ],
    flags: [
      ACCOUNT_FLAG,
      { flag: "--drain", help: "pass its running tasks on, not only close it" },
      { flag: "--now", help: "implies --drain, and interrupts its sessions at once instead of after 5 minutes" },
      { flag: "--wait", help: "block until the machine is empty; exit 2 when only work that can't move is left" },
    ],
  },
  open: {
    summary: "reopen a closed machine, or with --account a closed account",
    usage: "[<machine>] | --account <account>",
    flags: [ACCOUNT_FLAG],
  },
  pass: {
    summary: "pass a running task to a successor (the app's Pass to successor)",
    usage: "<task-id>",
    details: ["pushes its branch, ends its session, queues the task that carries on", RELAY_NOTE],
  },
  amend: {
    summary: "change a task still waiting in the queue",
    usage:
      "<task-id> [text…] [--replace] [--title <title>] [--model <model>] [--effort <effort>] " +
      "[--at <HH:MM|ISO> | --in <duration> | --not-before none]",
    details: ["the text is appended to its prompt", RELAY_NOTE],
    flags: [
      { flag: "--replace", help: "make the text the prompt" },
      { flag: "--title", value: "title", help: "set its title (empty clears it)" },
      { flag: "--model", value: "model", help: "set its model (default: the default)" },
      {
        flag: "--effort",
        value: "effort",
        choices: ["low", "medium", "high", "xhigh", "max", "default"],
        help: "set its effort",
      },
      { flag: "--at", value: "HH:MM|ISO", help: "set or move the time before which it will not start" },
      { flag: "--in", value: "duration", help: "as --at, from now (e.g. 2h)" },
      { flag: "--not-before", value: "none", choices: ["none"], help: "clear the not-before time" },
    ],
  },
  despawn: {
    summary: "end a session — asks claude to exit (keeping its worktree), kills the pane after ~5s",
    usage: "<session id, e.g. %12> [--force]",
    flags: [{ flag: "--force", help: "kill the pane at once" }],
  },
  reap: {
    summary: "clean up after sessions: merged, clean, idle worktrees, merged branches, dead windows",
    usage: "[--dry-run] [--min-age-days <n>]",
    flags: [
      { flag: "--dry-run", help: "say what would go, remove nothing" },
      { flag: "--min-age-days", value: "n", help: "only worktrees idle at least this long" },
    ],
  },
  mcp: {
    summary: "serve MCP over stdio for a local Claude Code",
    usage: "[install | uninstall]",
    details: ["mcp install / mcp uninstall wire it into Claude's config"],
    verbs: INSTALL_VERBS("the MCP server in Claude's config"),
  },
  mod: {
    summary: "install this checkout's Claude Code mods (claude-mods/) and séance's settings hooks into Claude",
    usage: "install | uninstall",
    verbs: INSTALL_VERBS("this checkout's Claude Code mods"),
  },
  adapter: {
    summary: "run a tool's adapter on this machine: add, remove, restart, status",
    usage: "add <dir> [--kinds <kinds>] [--repo <repo>]... | remove <name> | restart [<name>] | status",
    details: [
      "add reads <dir>/seance-adapter.json and writes adapters.<name> into config.json, ending that name's subscriptions",
      "an adapter runs as you, with everything you can reach: install only code you trust as you would an MCP server",
    ],
    verbs: {
      add: {
        summary: "add, or re-add, the adapter checked out in <dir>; `seance restart` starts it",
        flags: [
          {
            flag: "--kinds",
            value: "kinds",
            help: "what it may deliver (default note,question, or what it had; request is opt-in)",
          },
          {
            flag: "--repo",
            value: "repo",
            repeatable: true,
            help: "only sessions in this scanned repo (default all, or what it had)",
          },
        ],
      },
      remove: { summary: "remove <name> from config.json and end its subscriptions; `seance restart` stops it" },
      restart: { summary: "restart one adapter, or every one, in the running daemon; lifts the failed hold" },
      status: { summary: "each adapter's state, protocol, counts and last exit" },
    },
  },
  "session-event": {
    summary:
      "read one event as JSON on stdin and hand it to the local daemon (the session-events mod's call, or with --hook Claude's settings hooks'; silent)",
    internal: true,
  },
  inbox: {
    summary:
      "hold this session's inbox listener open on the local daemon and print each message as a JSON line (the inbox mod's child; silent)",
    internal: true,
  },
  custodian: {
    summary: "the custodian: the owner's verbs, and the round's (docs/custodian.md)",
    usage: "status | log | round | pause [--for <n>m|h|d] | resume",
    details: ["the owner's verbs are this shell's only; the round's are served only on the round's own socket"],
    verbs: {
      status: { summary: "the seat's state, its last round and the pause" },
      log: { summary: "the round log" },
      round: { summary: "ask the seat for a round now" },
      pause: {
        summary: "pause the seat's rounds",
        flags: [{ flag: "--for", value: "<n>m|h|d", help: "for this long, from 1m to 30d (default: until resume)" }],
      },
      resume: { summary: "lift the pause" },
      sessions: { summary: "the round's: this machine's sessions as JSON", internal: true },
      close: { summary: "the round's: close <pane>", internal: true },
      capture: { summary: "the round's: capture <pane>", internal: true },
      pr: { summary: "the round's: pr <pane>", internal: true },
      flag: { summary: "the round's: flag <pane> <reason> [note]", internal: true },
      nudge: { summary: "the round's: nudge <pane> (text on stdin)", internal: true },
      interrupt: { summary: "the round's: interrupt <pane>", internal: true },
      notes: {
        summary: "the round's notes on stdin; --clear (the owner's) drops them",
        flags: [{ flag: "--clear", help: "drop the round's notes" }],
      },
      done: { summary: "the round's: done (summary on stdin)", internal: true },
    },
  },
  raycast: {
    summary: "build this checkout's Raycast extension and import it (macOS)",
    usage: "install | uninstall",
    verbs: INSTALL_VERBS("this checkout's Raycast extension"),
  },
  completion: {
    summary: "print the zsh completion script",
    usage: "zsh",
    details: [
      `in ~/.zshrc, after compinit: eval "$(${CLI_NAME} completion zsh)" — generated from the same table as this help`,
    ],
    verbs: {
      zsh: { summary: "the zsh completion script" },
      repos: { summary: "this machine's scanned repo names, one per line (the script's call)", internal: true },
    },
  },
  help: { summary: "this text, or one command's", usage: "[command]", arg: "command" },
};

/** `usage: seance <command> …`, the line a parser's usage error and help both print. */
export function usageLine(name: CommandName): string {
  const { usage } = COMMAND_SPECS[name];
  return `usage: ${CLI_NAME} ${name}${usage === undefined ? "" : ` ${usage}`}`;
}

const NAME_WIDTH = 15;
const INDENT = " ".repeat(NAME_WIDTH);

function flagLabel(spec: FlagSpec): string {
  const names = spec.alias === undefined ? spec.flag : `${spec.flag}|${spec.alias}`;
  const value = spec.choices === undefined ? spec.value : spec.choices.join("|");
  return value === undefined ? names : `${names} <${value}>`;
}

/** One command's help block: summary, usage line, details, flags and verbs. */
export function commandHelp(name: CommandName): string {
  const spec = COMMAND_SPECS[name];
  const lines = [`  ${name.padEnd(NAME_WIDTH - 3)} ${spec.summary}`];
  if (spec.usage !== undefined) lines.push(`${INDENT}${usageLine(name).slice("usage: ".length)}`);
  for (const detail of spec.details ?? []) lines.push(`${INDENT}${detail}`);
  for (const flag of spec.flags ?? []) lines.push(`${INDENT}${flagLabel(flag)}: ${flag.help}`);
  for (const [verb, verbSpec] of Object.entries(spec.verbs ?? {})) {
    const flags = (verbSpec.flags ?? []).map((flag) => ` [${flagLabel(flag)}]`).join("");
    lines.push(`${INDENT}${verb}${flags}: ${verbSpec.summary}`);
  }
  return lines.join("\n");
}

export const USAGE = `${CLI_NAME} — séance's CLI (the daemon it runs is seanced)

usage: ${CLI_NAME} [command]

  ${"(none)".padEnd(NAME_WIDTH - 3)} run the daemon (seanced) in the foreground (launchd/systemd supervises)
${COMMANDS.map(commandHelp).join("\n")}
`;

export function isCommandName(name: string): name is CommandName {
  return COMMANDS.some((command) => command === name);
}
