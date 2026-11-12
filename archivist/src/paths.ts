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

/**
 * The same two for a named home, for `install --system`: as root, the XDG
 * lookups above answer for root. A unit's `User=` gets that user's `HOME` and no
 * XDG variables, so these are the paths the service resolves too.
 */
export function archivistConfigPathFor(home: string): string {
  return join(home, ".config", NAME, "config.json");
}

export function archivistStateDirFor(home: string): string {
  return join(home, ".local", "state", NAME);
}

/** What the running archivist writes to ask for an update check; the update unit's `.path` watches it. */
export function updateRequestPathIn(stateDirectory: string): string {
  return join(stateDirectory, "update-requested");
}

/**
 * The sha the running service was last started on, as `update` recorded it: the
 * service cannot read its own HEAD without running git, which it never does.
 */
export function servedShaPathIn(stateDirectory: string): string {
  return join(stateDirectory, "served-sha");
}

/** Held while an `update` runs, so a hand one and the update unit's never overlap. */
export function updateLockPathIn(stateDirectory: string): string {
  return join(stateDirectory, "update.lock");
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
