#!/usr/bin/env bun
// `session-event`'s is the one static import: it runs two or three times a turn
// in every Claude session on the machine (the session-events mod, in every
// exclave), and a static `cli.ts` would load the MCP SDK and zod into each of
// those runs — 47 ms against 11. Every other command imports what it needs once picked.
import { cmdSessionEvent } from "./session-event-cli.ts";

const USAGE = `seance — séance CLI; with no command it runs the daemon, seanced

usage: seance [command]

  (none)      run the daemon in the foreground (launchd/systemd supervises)
  init        write config skeleton + generate deviceId (never the PSK)
  psk-import  store the PSK in the platform store — macOS login keychain, WSL DPAPI blob, or Linux TPM-sealed blob (prompts, or reads a pipe; never argv)
  install     install and start the service (macOS launchd plist; Linux/WSL systemd user unit + linger, plus a logon pin task on WSL)
              --system: the root-owned systemd unit that gets the TPM-sealed PSK delivered to it, needs sudo (docs/psk.md)
  uninstall   stop the service and remove it, plus any symlink from link (--system for the system unit)
  link        put seance on PATH — a symlink to this file, so it tracks git pull: seance link [dir]
  unlink      remove the PATH symlink (only ones pointing at this checkout)
  restart     restart the service (after git pull)
  doctor      preflight checks: config, binaries, roots, relay, service
  status      service / socket / scan status
  scan        discover repos now; caches for the next start unless a daemon is running
  sessions    list running claude tmux windows, each with the id despawn takes
  spawn       spawn locally: seance spawn <repo> [--here] [-t <title>] [[-p] <task>]
  despawn     end a session: seance despawn <id> [--force] — asks claude to exit (keeping its worktree), kills the pane after ~5s
  reap        clean up after sessions: merged, clean, idle worktrees, merged branches, dead windows — [--dry-run] [--min-age-days <n>]
  mcp         serve MCP over stdio for a local Claude Code; mcp install / mcp uninstall wire it into Claude's config
  mod         mod install / mod uninstall — install this checkout's Claude Code mods (claude-mods/) into Claude
  session-event  read one event as JSON on stdin and hand it to the local daemon (the session-events mod's call; silent)
  raycast     raycast install / raycast uninstall — build this checkout's Raycast extension and import it (macOS)
  help        this text
`;

async function runForeground(): Promise<void> {
  const [{ log }, { startPowerLoop }, { startedBySupervisor }, { startSupervisor }] = await Promise.all([
    import("./log.ts"),
    import("./power.ts"),
    import("./service.ts"),
    import("./supervise.ts"),
  ]);
  // Self-update only under the supervisor that can actually relaunch us.
  const supervised = startedBySupervisor();
  if (!supervised) log.info("not started by a service manager — self-update is off for this run");
  const daemon = await startSupervisor({ usageRefresh: {}, ...(supervised ? { selfUpdate: {} } : {}) });
  const stopPower = startPowerLoop();
  const shutdown = (signal: string): void => {
    log.info(`${signal} — shutting down`);
    stopPower();
    daemon.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  await new Promise(() => {}); // run until signalled
}

async function runCommand(command: string, rest: readonly string[]): Promise<void> {
  const cli = await import("./cli.ts");
  switch (command) {
    case "init":
      await cli.cmdInit();
      break;
    case "psk-import":
      await cli.cmdPskImport();
      break;
    case "install":
      await cli.cmdInstall(rest);
      break;
    case "uninstall":
      await cli.cmdUninstall(rest);
      break;
    case "link":
      await cli.cmdLink(rest);
      break;
    case "unlink":
      await cli.cmdUnlink();
      break;
    case "restart":
      await cli.cmdRestart();
      break;
    case "doctor":
      await cli.cmdDoctor();
      break;
    case "status":
      await cli.cmdStatus();
      break;
    case "scan":
      await cli.cmdScan();
      break;
    case "sessions":
      await cli.cmdSessions();
      break;
    case "spawn":
      await cli.cmdSpawn(rest);
      break;
    case "despawn":
      await cli.cmdDespawn(rest);
      break;
    case "reap":
      await cli.cmdReap(rest);
      break;
    case "mcp":
      await cli.cmdMcp(rest);
      break;
    case "mod":
      await cli.cmdMod(rest);
      break;
    case "raycast":
      await cli.cmdRaycast(rest);
      break;
    default:
      console.error(`unknown command "${command}"\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case "session-event":
      await cmdSessionEvent();
      break;
    case undefined:
      await runForeground();
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      break;
    default:
      await runCommand(command, rest);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
