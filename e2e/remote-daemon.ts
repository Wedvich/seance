import { createBackend } from "../daemon/src/backend-default.ts";
import { loadConfig } from "../daemon/src/config.ts";
import { startDaemon } from "../daemon/src/run.ts";

/**
 * A second, real daemon for the two-machine e2e flows, booted by
 * `stack.startSecondDaemon`: a separate process because `stateDir()` is read
 * from the environment, and two daemons in one process would share a
 * state.json, a deviceId and an op socket. Config and state come from
 * SEANCE_CONFIG_DIR / SEANCE_STATE_DIR, the fixture home (exclaves and their
 * config dirs) from the one argument; tmux and the claude stub are the suite's
 * own, inherited through the environment.
 *
 * Not `seanced run`: that wires self-update when supervised, and a test must
 * not reach for git remotes.
 */
const home = process.argv[2];
if (home === undefined) throw new Error("remote-daemon.ts takes the fixture home as its argument");

const config = await loadConfig();
const daemon = await startDaemon({
  config,
  backend: createBackend(config, { waitMs: 1_500 }),
  home,
  pingIntervalMs: 60_000,
  pongTimeoutMs: 1_000,
  baseBackoffMs: 20,
});

const stop = (): void => {
  daemon.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
// The parent dying without signalling must not leave this daemon behind.
process.stdin.on("close", stop);
process.stdin.on("end", stop);
process.stdin.resume();
