import { homedir } from "node:os";
import { exec, type ExecResult } from "./exec.ts";

/** SEANCE_TMUX_SOCKET points tests at a private tmux server (`tmux -L`). */
export async function tmux(args: readonly string[]): Promise<ExecResult> {
  const socket = process.env["SEANCE_TMUX_SOCKET"];
  return exec(["tmux", ...(socket ? ["-L", socket] : []), ...args], { timeoutMs: 10_000 });
}

export class TmuxError extends Error {}

export async function tmuxOk(args: readonly string[]): Promise<string> {
  const result = await tmux(args);
  if (result.exitCode !== 0) {
    throw new TmuxError(`tmux ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

/**
 * Terminals auto-attach to a session *group* (zshrc creates `main`,
 * `main-1`, … sharing one window set), so any member is a valid target — a
 * window spawned into one appears in all. Cold boot with no server or no
 * matching session: create it detached; the next terminal attaches to it.
 */
export async function resolveTargetSession(group: string): Promise<string> {
  const result = await tmux(["list-sessions", "-F", "#{session_name}\t#{session_group}"]);
  if (result.exitCode === 0) {
    for (const line of result.stdout.split("\n")) {
      const [name, sessionGroup] = line.split("\t");
      if (name !== undefined && name !== "" && (name === group || sessionGroup === group)) {
        return name;
      }
    }
  }
  await tmuxOk(["new-session", "-d", "-s", group, "-c", homedir()]);
  return group;
}
