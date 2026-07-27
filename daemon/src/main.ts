#!/usr/bin/env bun
import {
  cmdDoctor,
  cmdInit,
  cmdInstall,
  cmdPskImport,
  cmdRestart,
  cmdScan,
  cmdSessions,
  cmdSpawn,
  cmdStatus,
  cmdUninstall,
} from "./cli.ts";
import { log } from "./log.ts";
import { startPowerLoop } from "./power.ts";
import { startDaemon } from "./run.ts";

const USAGE = `seanced — séance daemon

usage: seanced [command]

  (none)      run the daemon in the foreground (launchd supervises)
  init        write config skeleton + generate deviceId (never the PSK)
  psk-import  store the PSK in the macOS login keychain (prompts, or reads a pipe; never argv)
  install     write launchd plist and start the agent (macOS)
  uninstall   stop the agent and remove the plist
  restart     kickstart the agent (after git pull)
  doctor      preflight checks: config, binaries, roots, relay, service
  status      service / socket / scan status
  scan        discover repos now and persist the cache
  sessions    list running claude tmux windows
  spawn       spawn locally: seanced spawn <repo> [--here] [-t <title>] [[-p] <task>]
  help        this text
`;

async function runForeground(): Promise<void> {
  const daemon = await startDaemon();
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

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case undefined:
      await runForeground();
      break;
    case "init":
      await cmdInit();
      break;
    case "psk-import":
      await cmdPskImport();
      break;
    case "install":
      await cmdInstall();
      break;
    case "uninstall":
      await cmdUninstall();
      break;
    case "restart":
      await cmdRestart();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "status":
      await cmdStatus();
      break;
    case "scan":
      await cmdScan();
      break;
    case "sessions":
      await cmdSessions();
      break;
    case "spawn":
      await cmdSpawn(rest);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      break;
    default:
      console.error(`unknown command "${command}"\n`);
      console.log(USAGE);
      process.exit(1);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
