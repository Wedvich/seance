import { loadConfig, loadPsk, pskFingerprint, runnableProblems, watchConfigFile, type Config } from "./config.ts";
import { log } from "./log.ts";
import { configPath } from "./paths.ts";
import { startDaemon, type DaemonHandle, type RunOpts } from "./run.ts";

export interface SuperviseOpts extends Omit<RunOpts, "config"> {
  readonly configPath?: string;
  readonly debounceMs?: number;
}

export interface SupervisorHandle {
  /** The daemon currently running; a different object after each reload. */
  readonly current: () => DaemonHandle;
  readonly stop: () => void;
}

/**
 * Validated exactly as `startDaemon` would, but *before* the running daemon is
 * touched: a hand edit that breaks the config must not take the machine
 * offline until it is fixed.
 */
async function loadRunnable(path: string): Promise<Config | null> {
  let config: Config;
  try {
    config = await loadConfig(path);
  } catch (err) {
    log.error(`config reload: ${err instanceof Error ? err.message : String(err)} — keeping the running config`);
    return null;
  }
  const resolved = await loadPsk(config);
  const problems = runnableProblems(config, resolved?.psk ?? null);
  if (problems.length > 0) {
    for (const problem of problems) log.error(`config reload: ${problem}`);
    log.error("config reload: keeping the running config");
    return null;
  }
  return config;
}

/**
 * Runs the daemon under a config-file watcher. Every field is read once, at
 * `startDaemon` time — key import, backend, handler, relay client — so a change
 * swaps the whole handle rather than threading per-field reload through each.
 * Cost is one relay reconnect, which a changed relayUrl/bearerToken/psk forces
 * anyway; tmux sessions live outside the process and are untouched.
 */
export async function startSupervisor(opts: SuperviseOpts = {}): Promise<SupervisorHandle> {
  const { configPath: path = configPath(), debounceMs, ...runOpts } = opts;
  let config = await loadConfig(path);
  let daemon = await startDaemon({ config, ...runOpts });
  let reloading: Promise<void> = Promise.resolve();
  let stopped = false;

  const swap = async (next: Config): Promise<void> => {
    daemon.stop();
    try {
      daemon = await startDaemon({ config: next, ...runOpts });
      config = next;
    } catch (err) {
      // Validation passed, so this is something the new config can't be blamed
      // for on its own (an unreadable state dir, say). Get back to a running
      // daemon on the old config; the watcher stays armed either way.
      log.error(`config reload failed: ${err instanceof Error ? err.message : String(err)} — rolling back`);
      try {
        daemon = await startDaemon({ config, ...runOpts });
      } catch (rollbackErr) {
        log.error(
          `rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)} — ` +
            "daemon is down until the config changes again",
        );
      }
    }
  };

  const reload = async (): Promise<void> => {
    if (stopped) return;
    const next = await loadRunnable(path);
    if (next === null) return;
    // Tools rewrite identical bytes routinely; only a real change is worth a reconnect.
    if (Bun.deepEquals(next, config)) return;
    log.info(`config changed at ${path} — reloading`);
    await swap(next);
    // stop() can land while the swap is in flight; don't leave the new handle running.
    if (stopped) {
      daemon.stop();
      return;
    }
    // Which key we came up with, so a half-rotated PSK reads as a mismatch in
    // the log instead of a silent stream of undecryptable frames.
    const resolved = await loadPsk(config);
    if (resolved !== null) {
      log.info(`reloaded as "${config.name}" — psk ${await pskFingerprint(resolved.psk)} (${resolved.source})`);
    }
  };

  // Serialized: a burst of saves must not run two swaps against one handle.
  const unwatch = watchConfigFile(
    () => {
      reloading = reloading.then(reload, reload);
    },
    path,
    debounceMs,
  );

  return {
    current: (): DaemonHandle => daemon,
    stop: (): void => {
      stopped = true;
      unwatch();
      daemon.stop();
    },
  };
}
