import { userInfo } from "node:os";
import { DEFAULT_EXCLAVE, type Exclave, type ExclaveScan } from "./exclaves.ts";
import { exec } from "./exec.ts";
import { log } from "./log.ts";
import { cachedQuotaReader } from "./telemetry-collectors.ts";

/**
 * The `/usage` refresh (DESIGN.md, Daemon, "Usage refresh"; docs/scheduler.md
 * M4): `claude --safe-mode --output-format json -p /usage` with an exclave's
 * config dir makes Claude Code rewrite its own `cachedUsageUtilization`, which
 * the `cache` collector already reads. The daemon holds no token, calls no
 * endpoint and never refreshes a login — Claude Code does all three under its
 * own rules. A run is a whole Claude Code process (~350 MiB, 5–8 s) even when
 * Claude Code answers it from the cache, so the daemon spawns only for a
 * reading older than `staleAfter`, one run at a time per process.
 */

/** `quota.staleAfter`: the age past which an exclave's cached reading is refreshed. */
export const STALE_AFTER_MS = 10 * 60_000;

/**
 * Claude Code's own debounce: `/usage` answers from the cache while
 * `fetchedAtMs` is younger than this, so a run inside it would cost a process
 * and move nothing. `staleAfter` is never set below it.
 */
export const DEBOUNCE_MS = 60_000;

/** How often the timer asks every exclave whether it is stale — a stat each, the parse memoized. */
export const CHECK_INTERVAL_MS = 60_000;

/** A run takes 5–8 s; past this it is wedged, and holding the one slot would stop every exclave's refresh. */
export const REFRESH_TIMEOUT_MS = 60_000;

/**
 * Fixed argv: nothing here comes from a frame, a request or a file. `--safe-mode`
 * always — smaller and faster, and no user hook, plugin or mod runs, so the
 * session-events mod never reports from a process that is not a session.
 */
export const USAGE_ARGS = ["--safe-mode", "--output-format", "json", "-p", "/usage"] as const;

export interface UsageRefreshOpts {
  /** Floored at `DEBOUNCE_MS`. */
  readonly staleAfterMs?: number;
  readonly checkIntervalMs?: number;
  readonly timeoutMs?: number;
  /** Defaults as `spawn.ts` resolves claude: `SEANCE_CLAUDE_BIN`, else the bare name through PATH. */
  readonly claudeBin?: string;
  /**
   * Judges `fetchedAtMs`, which Claude Code stamps with the wall clock — so
   * `Date.now`, never the daemon's injected clock (DESIGN.md, Daemon, "Seams").
   */
  readonly now?: () => number;
}

export interface UsageRefreshDeps extends UsageRefreshOpts {
  /** The last scan: which exclaves exist, where their caches are, and whether each is signed in. */
  readonly scan: () => ExclaveScan;
  /** The daemon's home, the one `scanExclaves` read: `HOME` for the run, and its cwd. */
  readonly home: string;
}

export interface UsageRefresh {
  /** Activity in an exclave (a session event): refresh it if, and only if, its reading is stale. */
  readonly poke: (exclave: string) => void;
  /** Checks every exclave now, then every `checkIntervalMs`. */
  readonly start: () => void;
  /** Stops the timer and drops what is queued; a run in flight ends at its own exit or timeout. */
  readonly stop: () => void;
  /** Resolves once nothing is queued or running; for tests and shutdown. */
  readonly idle: () => Promise<void>;
}

/**
 * The run's whole environment, never the daemon's: `HOME`, `PATH`, `USER`,
 * `LOGNAME`, and `CLAUDE_CONFIG_DIR` for a named exclave (`default` is the
 * config reached without it). Without `USER`/`LOGNAME` Claude Code's macOS
 * keychain lookup fails silently and `/usage` prints the `/cost` view instead,
 * so both come from the passwd entry of the uid the daemon runs as rather than
 * from an environment a launchd plist need not carry. A service-delivered
 * credential (`CREDENTIALS_DIRECTORY`) cannot reach it: nothing is inherited.
 */
export function usageEnv(exclave: Exclave, home: string): Readonly<Record<string, string>> {
  const user = loginName();
  const path = process.env["PATH"];
  return {
    HOME: home,
    ...(path === undefined ? {} : { PATH: path }),
    ...(user === null ? {} : { USER: user, LOGNAME: user }),
    ...(exclave.id === DEFAULT_EXCLAVE ? {} : { CLAUDE_CONFIG_DIR: exclave.configDir }),
  };
}

function loginName(): string | null {
  try {
    return userInfo().username;
  } catch {
    // No passwd entry for this uid (a bare container): the environment is all there is.
    return process.env["USER"] ?? process.env["LOGNAME"] ?? null;
  }
}

/**
 * One run at a time in the whole process, not per instance: a config reload
 * starts a second daemon in process while the first one's run may still be
 * going, and an LXC cannot carry two of them for long.
 */
let lane: Promise<unknown> = Promise.resolve();

function inLane<T>(run: () => Promise<T>): Promise<T> {
  const next = lane.then(run);
  lane = next.catch(() => undefined);
  return next;
}

interface Backoff {
  /** No run before this, whatever pokes it: the last one failed. */
  readonly retryAt: number;
  /** Said once per failure streak; the next success says it recovered. */
  readonly warned: boolean;
}

export function createUsageRefresh(deps: UsageRefreshDeps): UsageRefresh {
  const now = deps.now ?? Date.now;
  const staleAfterMs = Math.max(deps.staleAfterMs ?? STALE_AFTER_MS, DEBOUNCE_MS);
  const timeoutMs = deps.timeoutMs ?? REFRESH_TIMEOUT_MS;
  const claudeBin = deps.claudeBin ?? process.env["SEANCE_CLAUDE_BIN"] ?? "claude";
  const readQuota = cachedQuotaReader();
  const backoff = new Map<string, Backoff>();
  const queued: string[] = [];
  let draining: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const find = (id: string): { readonly exclave: Exclave; readonly x: number } | null => {
    const scan = deps.scan();
    const x = scan.exclaves.findIndex((exclave) => exclave.id === id);
    const exclave = scan.exclaves[x];
    // Signed out, a run could only fail: there is no account to read usage for.
    return exclave === undefined || scan.info[x]?.authOk !== true ? null : { exclave, x };
  };

  /** The reading's stamp in seconds, or null when the cache holds none. */
  const readingAt = async (exclave: Exclave, x: number): Promise<number | null> =>
    (await readQuota(exclave.configFile, x, now()))?.at ?? null;

  const attempt = async (id: string): Promise<void> => {
    if (stopped) return;
    const found = find(id);
    if (found === null) return;
    const { exclave, x } = found;
    const startedAt = now();
    if ((backoff.get(id)?.retryAt ?? 0) > startedAt) return;
    // `fetchedAtMs` is the debounce marker; there is no second one of ours.
    const before = await readingAt(exclave, x);
    if (before !== null && startedAt - before * 1000 <= staleAfterMs) return;
    const result = await exec([claudeBin, ...USAGE_ARGS], {
      cwd: deps.home,
      env: usageEnv(exclave, deps.home),
      bareEnv: true,
      killGroup: true,
      timeoutMs,
    }).catch((err: unknown) => ({ spawnError: String(err) }));
    const after = await readingAt(exclave, x);
    // The cache is the result, not stdout: whatever the run printed, a cache that
    // did not move means nothing was refreshed.
    if (after !== null && (before === null || after > before)) {
      if (backoff.get(id)?.warned === true) log.info(`usage refresh: ${id} refreshed again`);
      backoff.delete(id);
      return;
    }
    const why =
      "spawnError" in result
        ? `could not run ${claudeBin}: ${result.spawnError}`
        : result.timedOut
          ? `timed out after ${timeoutMs / 1000}s`
          : result.exitCode === 0
            ? "the cache did not move"
            : `exit ${result.exitCode}, the cache did not move`;
    const warned = backoff.get(id)?.warned === true;
    if (!warned) {
      log.warn(`usage refresh: ${id} failed (${why}) — retrying every ${Math.round(staleAfterMs / 60_000)} min`);
    }
    backoff.set(id, { retryAt: now() + staleAfterMs, warned: true });
  };

  const drain = (): void => {
    if (draining !== null) return;
    draining = (async (): Promise<void> => {
      try {
        for (;;) {
          const id = queued.shift();
          if (id === undefined || stopped) return;
          // oxlint-disable-next-line no-await-in-loop -- one run at a time is the point
          await inLane(() => attempt(id)).catch((err: unknown) => log.warn(`usage refresh: ${id}: ${String(err)}`));
        }
      } finally {
        draining = null;
      }
    })();
  };

  const poke = (id: string): void => {
    if (stopped || queued.includes(id)) return;
    queued.push(id);
    drain();
  };

  const checkAll = (): void => {
    for (const exclave of deps.scan().exclaves) poke(exclave.id);
  };

  return {
    poke,
    start: (): void => {
      if (stopped || timer !== null) return;
      timer = setInterval(checkAll, deps.checkIntervalMs ?? CHECK_INTERVAL_MS);
      checkAll();
    },
    stop: (): void => {
      stopped = true;
      queued.length = 0;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    idle: async (): Promise<void> => {
      // oxlint-disable-next-line no-await-in-loop -- a drain begun while waiting is waited for too
      for (let pending = draining; pending !== null; pending = draining) await pending;
    },
  };
}
