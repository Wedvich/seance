#!/usr/bin/env bun
import { startArchivist } from "./run.ts";
import { statusLines } from "./status.ts";

const USAGE = `usage: seance-archivist <command>

  run      hold the archivist's seat on the relay (as its systemd unit runs it)
  status   config, state dir, device id, key fingerprint and liveness
  help     this text

The PSK comes only from the unit's systemd credential (docs/psk.md); see docs/archivist.md.`;

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (rest.length > 0) {
    console.error(USAGE);
    return 2;
  }
  switch (command) {
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
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(USAGE);
      return 2;
  }
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
