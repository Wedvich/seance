import { join } from "node:path";
import { xdgConfigDir, xdgStateDir } from "../../daemon/src/paths.ts";

/**
 * Its own directories, never the daemon's `seance` ones: on a shared box the
 * archivist runs as a Unix user of its own (docs/archivist.md, A27a), and even
 * as the same user it must not read or mint the daemon's identity.
 */
const NAME = "seance-archivist";

export function archivistConfigPath(): string {
  return join(xdgConfigDir(NAME), "config.json");
}

export function archivistStateDir(): string {
  return xdgStateDir(NAME);
}

/** The per-state-dir files, taking the directory so tests and `status` can name one that isn't the default. */
export function statePathIn(stateDirectory: string): string {
  return join(stateDirectory, "state.json");
}

export function runtimePathIn(stateDirectory: string): string {
  return join(stateDirectory, "runtime.json");
}

export function archivePathIn(stateDirectory: string): string {
  return join(stateDirectory, "archive.sqlite");
}

export function metricsPathIn(stateDirectory: string): string {
  return join(stateDirectory, "metrics.sqlite");
}
