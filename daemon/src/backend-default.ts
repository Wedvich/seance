import type { SessionBackend } from "./backend.ts";
import type { Check } from "./check.ts";
import type { Config } from "./config.ts";
import { despawnSession } from "./despawn.ts";
import { listClaudeSessions, listStuckWindows } from "./sessions.ts";
import { captureWindow, publishMachineTag, republishMachineTag, spawnSession } from "./spawn.ts";
import { tmux } from "./tmux.ts";

/**
 * How often the machine tag is re-set on the tmux server. A restarted server
 * starts with an empty global environment and tmux has no server-start hook
 * the daemon could listen on, so this bounds how long hand-run sessions on a
 * fresh server launch untagged — the tmux-rename mod reads the server's value
 * at rename time, so even those pick it up afterwards. One tmux exec a minute.
 */
const REPUBLISH_TAG_MS = 60_000;

/**
 * The shipped backend: one claude window per session in a tmux session group.
 * This file is the swap point — a fork rewrites `createBackend` here (and drops
 * spawn/sessions/tmux/trust) without touching run, handlers or the CLI. It is
 * also the only place that reads `config.tmuxSession`, `config.machineTag` and
 * the pane-death budget, all of which used to thread through the frontend.
 */
export function createBackend(
  config: Config,
  opts: { readonly waitMs?: number; readonly republishTagMs?: number } = {},
): SessionBackend {
  let republish: ReturnType<typeof setInterval> | null = null;
  return {
    spawn: (request, repos) =>
      spawnSession(request, repos, { ...opts, tmuxSession: config.tmuxSession, machineTag: config.machineTag }),
    sessions: (repos) => listClaudeSessions(repos),
    despawn: (id, { force }) => despawnSession(id, { force }),
    doctor: tmuxChecks,
    capture: (handle) => captureWindow(handle, { history: false }),
    start: async () => {
      // Armed before the first publish, so one that throws is still repaired.
      republish ??= setInterval(
        () => void republishMachineTag(config.machineTag),
        opts.republishTagMs ?? REPUBLISH_TAG_MS,
      );
      await publishMachineTag(config.tmuxSession, config.machineTag);
    },
    stop: () => {
      if (republish !== null) clearInterval(republish);
      republish = null;
    },
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

  // Detection is two tmux format features (`#{==:}` for the title, `#{m:}`
  // for our windows) that an old tmux renders literally rather than failing:
  // the session list reads empty and every spawn acks pending. Probing the
  // formats beats parsing `tmux -V` ("3.3a", "next-3.5"). display-message
  // needs a server; without one there is nothing to misreport yet.
  if (sessions.exitCode === 0) {
    const probe = await tmux(["display-message", "-p", "#{==:a,a}#{m:*a*,a}"]);
    if (probe.stdout.trim() !== "11") {
      checks.push({
        level: "fail",
        message: "tmux too old for session detection (needs 3.1+): sessions list empty, every spawn reports pending",
      });
    }
  }

  // Warn, not fail: the sessions are recoverable by hand, and doctor exits
  // nonzero on fail — a machine with one stuck window is still serving.
  const stuck = await listStuckWindows();
  if (stuck.length > 0) {
    checks.push({
      level: "warn",
      message:
        `${stuck.length} started session(s) never registered — likely waiting on a startup prompt: ` +
        `${stuck.join(", ")}. Attach with \`tmux attach\` and answer it.`,
    });
  }
  return checks;
}
