import { homedir } from "node:os";
import { join } from "node:path";

// SEANCE_* overrides exist for tests; XDG vars keep macOS and WSL identical.

/** `name` under the XDG config home: the daemon's `seance`, the archivist's `seance-archivist`. */
export function xdgConfigDir(name: string): string {
  return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), name);
}

/** `name` under the XDG state home, as `xdgConfigDir`. */
export function xdgStateDir(name: string): string {
  return join(process.env["XDG_STATE_HOME"] ?? defaultStateHome(homedir()), name);
}

export function configDir(): string {
  return process.env["SEANCE_CONFIG_DIR"] ?? xdgConfigDir("seance");
}

export function stateDir(): string {
  return process.env["SEANCE_STATE_DIR"] ?? xdgStateDir("seance");
}

/**
 * The layout `stateDir()` resolves to, for a home directory that isn't this
 * process's own. `install --system` runs as root and records the *target user's*
 * paths in the unit; the XDG vars in root's environment are the wrong answer,
 * and so is `homedir()`. Kept here so the layout is stated once.
 */
export function stateDirFor(home: string): string {
  return join(defaultStateHome(home), "seance");
}

function defaultStateHome(home: string): string {
  return join(home, ".local", "state");
}

/** Same for the config dir: what the daemon will read once it runs as the target user. */
export function configDirFor(home: string): string {
  return join(home, ".config", "seance");
}

/**
 * The per-state-dir file names, taking the directory rather than resolving it.
 * `install --system` needs them for a directory that isn't this process's, and
 * the plain accessors below are the same functions applied to `stateDir()`.
 */
export function logPathIn(stateDirectory: string): string {
  return join(stateDirectory, "seanced.log");
}

export function pskBlobPathIn(stateDirectory: string): string {
  return join(stateDirectory, "psk.cred");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function statePath(): string {
  return join(stateDir(), "state.json");
}

export function runtimePath(): string {
  return join(stateDir(), "runtime.json");
}

/** Reap's own record of when it last pruned each clone (`PruneLog` in `reap-git.ts`). */
export function pruneLogPath(): string {
  return join(stateDir(), "reap-fetch.json");
}

/** The worktrees reap's last acting run kept, and why (`ReapRefusals`). */
export function reapRefusalsPath(): string {
  return join(stateDir(), "reap-refusals.json");
}

export function logPath(): string {
  return logPathIn(stateDir());
}

/**
 * Holds the local op socket, and exists to be 0700. That mode is the access
 * control, not the socket's own: `Bun.listen({ unix })` creates the socket 0755,
 * there is a window between bind and chmod, and socket-mode enforcement on
 * connect(2) is inconsistent across BSD-derived kernels. Directory traversal is
 * what gates connect everywhere, so the directory is the thing to get right.
 * Separate from `stateDir()` because that one is 0755 and holds files whose own
 * modes already answer for them.
 */
export function runDir(): string {
  return join(stateDir(), "run");
}

/** The custodian seat's own files (docs/custodian.md): the notes, and the default exclave's round dir. */
export function custodianDir(): string {
  return join(stateDir(), "custodian");
}

export function custodianRoundsPath(): string {
  return join(custodianDir(), "rounds.jsonl");
}

export function custodianNotesPath(): string {
  return join(custodianDir(), "notes.md");
}

/**
 * The owner's pause (`custodian-control.ts`): written by `seanced custodian pause|resume`, read by the seat. Under
 * `stateDir()`, which a round's sandbox cannot write.
 */
export function custodianStatePath(): string {
  return join(custodianDir(), "state.json");
}

/**
 * The daemon's open custodian flags (`custodian-flags.ts`), its own file beside the owner's `state.json` so the CLI
 * stays that file's only writer. Nudge and interrupt counts join it at item 8.
 */
export function custodianSessionsPath(): string {
  return join(custodianDir(), "sessions.json");
}

/** `seanced custodian round` writes it, the seat reads and drops it. */
export function custodianRoundRequestPath(): string {
  return join(custodianDir(), "round-request");
}

/** The seat's own view of itself, written by the seat and read by `seanced custodian status` and `round`. */
export function custodianSeatViewPath(): string {
  return join(custodianDir(), "seat.json");
}

export function socketPath(): string {
  return join(runDir(), "seanced.sock");
}

export function expandTilde(p: string): string {
  return p.replace(/^~(?=\/|$)/u, homedir());
}

/** Inverse of `expandTilde`, for display only. */
export function tildify(path: string, home: string = homedir()): string {
  // $HOME is taken verbatim, so `/home/m/` would otherwise match nothing.
  const base = home.replace(/\/+$/u, "");
  if (base === "") return path;
  return path === base || path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}
