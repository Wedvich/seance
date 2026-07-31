import {
  loadConfig,
  loadPsk,
  pskFingerprint,
  runnableProblems,
  watchConfigFile,
  type Config,
  type ResolvedPsk,
} from "./config.ts";
import { log } from "./log.ts";
import { configPath } from "./paths.ts";
import { startDaemon, type DaemonHandle, type RunOpts } from "./run.ts";

export interface SuperviseOpts extends Omit<RunOpts, "config"> {
  readonly configPath?: string;
  readonly debounceMs?: number;
  /** Defaults to `startDaemon`; tests wrap it to inject startup failures. */
  readonly startDaemon?: (opts: RunOpts) => Promise<DaemonHandle>;
  /** Defaults to `watchConfigFile`; tests substitute a trigger they drive directly. */
  readonly watch?: typeof watchConfigFile;
}

export interface SupervisorHandle {
  /**
   * The running daemon, awaiting any reload in flight — a different object
   * after each one. Resolving mid-swap would hand back the stopped outgoing
   * handle, hence the promise.
   */
  readonly current: () => Promise<DaemonHandle>;
  readonly stop: () => void;
}

/** A validated config and the psk it was validated against, kept together so neither is re-derived. */
interface Runnable {
  readonly config: Config;
  readonly resolved: ResolvedPsk;
}

/**
 * Validated exactly as `startDaemon` would, but *before* the running daemon is
 * touched: a hand edit that breaks the config must not take the machine
 * offline until it is fixed. The resolved psk rides along so the swap and its
 * log line reuse it instead of reading the platform store twice more.
 */
async function loadRunnable(path: string): Promise<Runnable | null> {
  let config: Config;
  try {
    config = await loadConfig(path);
  } catch (err) {
    log.error(`config reload: ${err instanceof Error ? err.message : String(err)} — keeping the running config`);
    return null;
  }
  const resolved = await loadPsk(config);
  const problems = runnableProblems(config, resolved?.psk ?? null);
  // `resolved === null` is already in `problems`; naming it here narrows the type.
  if (problems.length > 0 || resolved === null) {
    for (const problem of problems) log.error(`config reload: ${problem}`);
    log.error("config reload: keeping the running config");
    return null;
  }
  return { config, resolved };
}

/** What a swap actually did. Only `swapped` is worth announcing; the other two log their own reason. */
type SwapResult = "swapped" | "rolled-back" | "down";

/**
 * Runs the daemon under a config-file watcher. Every field is read once, at
 * `startDaemon` time — key import, backend, handler, relay client — so a change
 * swaps the whole handle rather than threading per-field reload through each.
 * Cost is one relay reconnect, which a changed relayUrl/bearerToken/psk forces
 * anyway; tmux sessions live outside the process and are untouched.
 */
export async function startSupervisor(opts: SuperviseOpts = {}): Promise<SupervisorHandle> {
  const {
    configPath: path = configPath(),
    debounceMs,
    startDaemon: start = startDaemon,
    watch = watchConfigFile,
    ...runOpts
  } = opts;

  // Null only when nothing holds a psk, which `start` then refuses on its own.
  const startWith = (cfg: Config, psk: ResolvedPsk | null): Promise<DaemonHandle> =>
    start({ config: cfg, ...(psk !== null ? { resolvedPsk: psk } : {}), ...runOpts });

  let config = await loadConfig(path);
  let resolved = await loadPsk(config);
  let daemon = await startWith(config, resolved);
  let reloading: Promise<void> = Promise.resolve();
  let stopped = false;
  // False only after a rollback failed, i.e. nothing is running. The deep-equal
  // guard below has to know: reverting a bad edit rewrites the bytes we already
  // hold, and that is exactly the edit that has to be allowed to restart.
  let live = true;

  const swap = async (next: Runnable): Promise<SwapResult> => {
    daemon.stop();
    try {
      daemon = await startWith(next.config, next.resolved);
      config = next.config;
      resolved = next.resolved;
      live = true;
      return "swapped";
    } catch (err) {
      // Validation passed, so this is something the new config can't be blamed
      // for on its own (an unreadable state dir, say). Get back to a running
      // daemon on the old config; the watcher stays armed either way. The psk
      // is the one that daemon imported, not a fresh read of a store that may
      // be half-rotated.
      log.error(`config reload failed: ${err instanceof Error ? err.message : String(err)} — rolling back`);
      try {
        daemon = await startWith(config, resolved);
        live = true;
        return "rolled-back";
      } catch (rollbackErr) {
        log.error(
          `rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)} — ` +
            "daemon is down until the config changes again",
        );
        live = false;
        return "down";
      }
    }
  };

  const reload = async (): Promise<void> => {
    if (stopped) return;
    const next = await loadRunnable(path);
    if (next === null) return;
    // Tools rewrite identical bytes routinely; only a real change is worth a
    // reconnect — unless nothing is running, when any edit is a chance to recover.
    if (live && Bun.deepEquals(next.config, config)) return;
    log.info(`config changed at ${path} — reloading`);
    const result = await swap(next);
    // stop() can land while the swap is in flight; don't leave the new handle running.
    if (stopped) {
      daemon.stop();
      return;
    }
    if (result !== "swapped") return;
    // Which key we came up with, so a half-rotated PSK reads as a mismatch in
    // the log instead of a silent stream of undecryptable frames.
    log.info(`reloaded as "${config.name}" — psk ${await pskFingerprint(next.resolved.psk)} (${next.resolved.source})`);
  };

  // Nothing ever awaits the chain, so a rejection in it goes unhandled — which
  // under Bun's default takes the process down. `reload` reaches the platform
  // psk store, and `Bun.spawn` throws synchronously on ENOENT/EAGAIN.
  const safeReload = async (): Promise<void> => {
    try {
      await reload();
    } catch (err) {
      log.error(
        `config reload failed: ${err instanceof Error ? err.message : String(err)} — keeping the running config`,
      );
    }
  };

  // Serialized: a burst of saves must not run two swaps against one handle.
  // Both arms on purpose — a one-arm `.then` would leave a rejected link
  // poisoning every later reload, and `.finally` would re-raise it at each one.
  const unwatch = watch(
    () => {
      reloading = reloading.then(safeReload, safeReload);
    },
    path,
    debounceMs,
  );

  return {
    current: (): Promise<DaemonHandle> => reloading.then(() => daemon),
    stop: (): void => {
      stopped = true;
      unwatch();
      daemon.stop();
    },
  };
}
