import type { SessionBackend } from "./backend.ts";
import type { Check } from "./check.ts";
import type { Config } from "./config.ts";
import { listClaudeSessions } from "./sessions.ts";
import { spawnSession } from "./spawn.ts";
import { tmux } from "./tmux.ts";

/**
 * The shipped backend: one claude window per session in a tmux session group.
 * This file is the swap point — a fork rewrites `createBackend` here (and drops
 * spawn/sessions/tmux/trust) without touching run, handlers or the CLI. It is
 * also the only place that reads `config.tmuxSession` and the pane-death
 * budget, both of which used to thread through the frontend.
 */
export function createBackend(config: Config, opts: { readonly waitMs?: number } = {}): SessionBackend {
  return {
    spawn: (request, repos) => spawnSession(request, repos, config.tmuxSession, opts),
    sessions: (repos) => listClaudeSessions(repos),
    doctor: tmuxChecks,
  };
}

/** `git` is absent on purpose: it belongs to repo scanning, which is frontend-side. */
async function tmuxChecks(): Promise<readonly Check[]> {
  const tmuxBin = Bun.which("tmux");
  const claudeBin = Bun.which("claude");
  const checks: Check[] = [
    tmuxBin === null ? { level: "fail", message: "tmux not on PATH" } : { level: "ok", message: `tmux at ${tmuxBin}` },
    claudeBin === null
      ? { level: "fail", message: "claude not on PATH" }
      : { level: "ok", message: `claude at ${claudeBin}` },
  ];
  // Spawning a binary that isn't there throws instead of reporting nonzero,
  // which would abort doctor before it printed the failure above.
  if (tmuxBin === null) return checks;

  const sessions = await tmux(["list-sessions", "-F", "#{session_name}"]);
  checks.push(
    sessions.exitCode === 0
      ? { level: "ok", message: `tmux server running (sessions: ${sessions.stdout.trim().split("\n").join(", ")})` }
      : { level: "warn", message: "no tmux server — fine; spawn creates the session detached" },
  );
  return checks;
}
