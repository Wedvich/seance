#!/usr/bin/env bun
import { parseCommand, UsageError, type Command } from "./args.ts";
import { startArchivist } from "./run.ts";
import { statusLines } from "./status.ts";

const USAGE = `usage: seance-archivist <command>

  run                  hold the archivist's seat on the relay (as its systemd unit runs it)
  status               config, state dir, device id, key fingerprint and liveness
  install --system --user <name> [--path <PATH>]
                       as root: write and start seance-archivist.service and its update units
  uninstall --system   as root: stop and remove them, leaving the state dir
  update               fetch, fast-forward this checkout, bun install, restart the service
  help                 this text

The PSK comes only from the unit's systemd credential (docs/psk.md); see DESIGN.md, "Archivist".`;

/**
 * install, uninstall and update are loaded by `import()` in their own branches,
 * never statically: they run git and systemctl through the daemon's exec path,
 * which the `run` process — the one holding the key — must never load
 * (archivist/test/layering.test.ts).
 */
async function dispatch(command: Command): Promise<number> {
  switch (command.kind) {
    case "run": {
      const archivist = await startArchivist();
      await new Promise<void>((resolve) => {
        process.once("SIGTERM", resolve);
        process.once("SIGINT", resolve);
      });
      archivist.stop();
      return 0;
    }
    case "status":
      for (const line of await statusLines()) console.log(line);
      return 0;
    case "help":
      console.log(USAGE);
      return 0;
    case "install": {
      const { installArchivistSystem } = await import("./install.ts");
      const notes = await installArchivistSystem(command);
      console.log("installed and started seance-archivist.service and seance-archivist-update.path");
      for (const note of notes) console.log(`note: ${note}`);
      return 0;
    }
    case "uninstall": {
      const { uninstallArchivistSystem } = await import("./install.ts");
      const notes = await uninstallArchivistSystem();
      console.log("stopped and removed the archivist's units");
      for (const note of notes) console.log(`note: ${note}`);
      return 0;
    }
    case "update": {
      const { updateArchivist } = await import("./self-update.ts");
      const result = await updateArchivist(command);
      if (result === null) {
        // The running update repeats for a request made since it began, so the unit has nothing to add.
        console.error("another update is running (update.lock in the state dir)");
        return command.requested ? 0 : 1;
      }
      const detail = result.detail === undefined ? "" : ` — ${result.detail}`;
      if (result.outcome === "ok") console.log(`updated${detail}; restarted`);
      else if (result.outcome === "current") console.log("already current — nothing to do");
      else {
        console.error(`update ${result.outcome}${detail}`);
        return 1;
      }
      return 0;
    }
  }
}

async function main(argv: readonly string[]): Promise<number> {
  let command: Command;
  try {
    command = parseCommand(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  return dispatch(command);
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
