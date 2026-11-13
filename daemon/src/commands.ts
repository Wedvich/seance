// Import-free on purpose: `main.ts` imports it statically, and `session-event` runs several times a turn in every
// Claude session on the machine (see main.ts's header).

/**
 * Every command `seanced` answers. The custodian fence's deny list is generated from this table (`custodian-fence.ts`:
 * every command but `custodian`), so a new command is denied to the round by default, and `main.ts`'s dispatch table
 * is typed against it so the two cannot drift.
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
  "session-event",
  "inbox",
  "custodian",
  "raycast",
  "help",
] as const;

export type CommandName = (typeof COMMANDS)[number];

export const USAGE = `seanced — séance daemon

usage: seanced [command]

  (none)      run the daemon in the foreground (launchd/systemd supervises)
  init        write config skeleton + generate deviceId (never the PSK)
  psk-import  store the PSK in the platform store — macOS login keychain, WSL DPAPI blob, or Linux TPM-sealed blob (prompts, or reads a pipe; never argv)
  install     install and start the service (macOS launchd plist; Linux/WSL systemd user unit + linger, plus a logon pin task on WSL)
              --system: the root-owned systemd unit that gets the TPM-sealed PSK delivered to it, needs sudo (docs/psk.md)
  uninstall   stop the service and remove it, plus any symlink from link (--system for the system unit)
  link        put seanced on PATH — a symlink to this file, so it tracks git pull: seanced link [dir]
  unlink      remove the PATH symlink (only ones pointing at this checkout)
  restart     restart the service (after git pull)
  update      what a fleet update announce does, by hand: fast-forward the daemon's own checkout, bun install, restart
              (refuses a dirty, re-branched or diverged checkout; restarts a daemon still on an older sha even when current)
  doctor      preflight checks: config, binaries, roots, relay, service
  status      service / socket / scan status
  scan        discover repos now; caches for the next start unless a daemon is running
  sessions    list running claude tmux windows, each with the id despawn takes
  spawn       queue a session for the scheduler: seanced spawn <repo> [--here] [-t <title>] [[-p] <task>] (needs the relay, and a PSK this shell or its daemon holds)
              --machine <name|here> / --account <alias|email|id>: pin it; --not <machine|here>: keep it off (repeatable)
              --requires <trait>: (repeatable) only place it where every named trait is declared (traits in config.json; list_machines shows them)
              --start: once the scheduler admits it, start it past the concurrency cap (as seanced start)
              --autonomy <steer|checkpoint|auto>: how much the session decides on its own (default checkpoint; steer is plan mode)
              --now: spawn on this machine right away instead: no relay, key, leader or daemon needed; takes no pin flags, --requires or --start
  continue    resume a failed or cancelled task's, or a blocked awaiting-merge task's, session in its worktree, as a new queued task: seanced continue <task-id> [-p <note>] (needs the relay, and a PSK this shell or its daemon holds)
  start       start a queued task now, past the concurrency cap (the app's Start now): seanced start <task-id> (needs the relay, and a PSK this shell or its daemon holds)
  close       close a machine to new scheduled work; a leader that supports it passes its running tasks to other machines after 10 minutes (--wait blocks until the machine is empty; exit 2 when only work that can't move is left): seanced close [<machine>] [--now] [--wait] (--now interrupts its sessions at once instead of after 5 minutes; default: this one; over the relay, so needs a PSK this shell can read — a keyless box uses the PWA)
  open        reopen a closed machine: seanced open [<machine>]
  pass        pass a running task to a successor (the app's Pass to successor): pushes its branch, ends its session, queues the task that carries on: seanced pass <task-id> (needs the relay, and a PSK this shell or its daemon holds)
  amend       change a task still waiting in the queue: seanced amend <task-id> [text…] appends to its prompt; --replace makes the text the prompt; --title, --model, --effort set those (needs the relay, and a PSK this shell or its daemon holds)
  despawn     end a session: seanced despawn <id> [--force] — asks claude to exit (keeping its worktree), kills the pane after ~5s
  reap        clean up after sessions: merged, clean, idle worktrees, merged branches, dead windows — [--dry-run] [--min-age-days <n>]
  mcp         serve MCP over stdio for a local Claude Code; mcp install / mcp uninstall wire it into Claude's config
  mod         mod install / mod uninstall — install this checkout's Claude Code mods (claude-mods/) into Claude
  session-event  read one event as JSON on stdin and hand it to the local daemon (the session-events mod's call; silent)
  inbox       hold this session's inbox listener open on the local daemon and print each message as a JSON line (the inbox mod's child; silent)
  custodian   the custodian round's verbs (docs/custodian.md) — not built yet
  raycast     raycast install / raycast uninstall — build this checkout's Raycast extension and import it (macOS)
  help        this text
`;
