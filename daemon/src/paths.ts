import { homedir } from "node:os";
import { join } from "node:path";

// SEANCE_* overrides exist for tests; XDG vars keep macOS and WSL identical.

export function configDir(): string {
  return (
    process.env["SEANCE_CONFIG_DIR"] ?? join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "seance")
  );
}

export function stateDir(): string {
  return (
    process.env["SEANCE_STATE_DIR"] ?? join(process.env["XDG_STATE_HOME"] ?? defaultStateHome(homedir()), "seance")
  );
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

export function socketPath(): string {
  return join(runDir(), "seanced.sock");
}

export function expandTilde(p: string): string {
  return p.replace(/^~(?=\/|$)/u, homedir());
}
