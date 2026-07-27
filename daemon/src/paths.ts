import { homedir } from "node:os";
import { join } from "node:path";

// SEANCE_* overrides exist for tests; XDG vars keep macOS and WSL identical.

export function configDir(): string {
  return (
    process.env["SEANCE_CONFIG_DIR"] ??
    join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "seance")
  );
}

export function stateDir(): string {
  return (
    process.env["SEANCE_STATE_DIR"] ??
    join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "seance")
  );
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
  return join(stateDir(), "seanced.log");
}

export function expandTilde(p: string): string {
  return p.replace(/^~(?=\/|$)/, homedir());
}
