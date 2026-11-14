#!/usr/bin/env bun
// `session-event`'s is the one static import: it runs two or three times a turn
// in every Claude session on the machine (the session-events mod, in every
// exclave), and a static `cli.ts` would load the MCP SDK and zod into each of
// those runs — 47 ms against 11. `inbox` is the second: the inbox mod starts one per session and it lives for the
// session's life, so loading the MCP SDK and zod into every session's listener would be pure cost. `custodian` is the
// third: the round runs its verbs many times a turn. Every other command imports what it needs once picked.
import { CUSTODIAN_OWNER_VERBS, USAGE, type CommandName } from "./commands.ts";
import { cmdCustodian } from "./custodian-cli.ts";
import { cmdInbox } from "./inbox-cli.ts";
import { cmdSessionEvent } from "./session-event-cli.ts";

async function runForeground(): Promise<void> {
  const [
    { log },
    { startPowerLoop },
    { startedBySupervisor },
    { startSupervisor },
    { drainTaskLaunches },
    { SHUTDOWN_DRAIN_MS },
    { createShutdown },
  ] = await Promise.all([
    import("./log.ts"),
    import("./power.ts"),
    import("./service.ts"),
    import("./supervise.ts"),
    import("./run.ts"),
    import("./drain-limits.ts"),
    import("./shutdown.ts"),
  ]);
  // Self-update only under the supervisor that can actually relaunch us.
  const supervised = startedBySupervisor();
  if (!supervised) log.info("not started by a service manager — self-update is off for this run");
  const daemon = await startSupervisor({
    authHealth: {},
    custodian: {},
    usageRefresh: {},
    ...(supervised ? { selfUpdate: {} } : {}),
  });
  const stopPower = startPowerLoop();
  const shutdown = createShutdown({
    info: (message) => log.info(message),
    stopPower,
    drain: () => drainTaskLaunches(SHUTDOWN_DRAIN_MS),
    stop: () => daemon.stop(),
    exit: (code) => process.exit(code),
  });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  await new Promise(() => {}); // run until signalled
}

type Cli = typeof import("./cli.ts");

/** Typed against `COMMANDS`: a command with no entry here, or one that is not a command, does not compile. */
const RUN: Record<
  Exclude<CommandName, "session-event" | "inbox" | "custodian" | "help">,
  (cli: Cli, rest: readonly string[]) => Promise<void>
> = {
  init: (cli) => cli.cmdInit(),
  "psk-import": (cli) => cli.cmdPskImport(),
  install: (cli, rest) => cli.cmdInstall(rest),
  uninstall: (cli, rest) => cli.cmdUninstall(rest),
  link: (cli, rest) => cli.cmdLink(rest),
  unlink: (cli) => cli.cmdUnlink(),
  restart: (cli) => cli.cmdRestart(),
  update: (cli, rest) => cli.cmdUpdate(rest),
  doctor: (cli) => cli.cmdDoctor(),
  status: (cli) => cli.cmdStatus(),
  scan: (cli) => cli.cmdScan(),
  sessions: (cli) => cli.cmdSessions(),
  spawn: (cli, rest) => cli.cmdSpawn(rest),
  continue: (cli, rest) => cli.cmdContinue(rest),
  start: (cli, rest) => cli.cmdStart(rest),
  close: (cli, rest) => cli.cmdClose(rest),
  open: (cli, rest) => cli.cmdOpen(rest),
  pass: (cli, rest) => cli.cmdPass(rest),
  amend: (cli, rest) => cli.cmdAmend(rest),
  despawn: (cli, rest) => cli.cmdDespawn(rest),
  reap: (cli, rest) => cli.cmdReap(rest),
  mcp: (cli, rest) => cli.cmdMcp(rest),
  mod: (cli, rest) => cli.cmdMod(rest),
  raycast: (cli, rest) => cli.cmdRaycast(rest),
};

function isRunnable(command: string): command is keyof typeof RUN {
  return Object.keys(RUN).includes(command);
}

async function runCommand(command: string, rest: readonly string[]): Promise<void> {
  if (!isRunnable(command)) {
    console.error(`unknown command "${command}"\n`);
    console.log(USAGE);
    process.exit(1);
  }
  await RUN[command](await import("./cli.ts"), rest);
}

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case "session-event":
      await cmdSessionEvent();
      break;
    case "inbox":
      await cmdInbox();
      break;
    case "custodian":
      // The owner's verbs are loaded on demand: they log and audit, which the round's verbs (statically imported,
      // their stdout the round's data channel) must never reach.
      if (CUSTODIAN_OWNER_VERBS.some((verb) => verb === rest[0])) {
        await (await import("./custodian-owner-cli.ts")).cmdCustodianOwner(rest);
        break;
      }
      await cmdCustodian(rest);
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
