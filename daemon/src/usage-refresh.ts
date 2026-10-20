import { userInfo } from "node:os";
import { DEFAULT_EXCLAVE, type Exclave, type ExclaveScan } from "./exclaves.ts";
import { exec } from "./exec.ts";
import { log } from "./log.ts";
import { cachedStampReader } from "./telemetry-collectors.ts";

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

/** A run that ignores the timeout's SIGTERM gets SIGKILL this long after it. */
export const KILL_AFTER_MS = 5_000;

/** Past timeout plus kill grace plus this, the run is abandoned even if its pipes never close (a detached grandchild). */
const HARD_DEADLINE_SLACK_MS = 1_000;

/** Longest stretch of a failed run's output a warn carries. */
const EXCERPT_CHARS = 200;

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
  /** Grace between the timeout's SIGTERM and SIGKILL. */
  readonly killAfterMs?: number;
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
  /**
   * Stops the timer, drops what is queued and kills a run in flight: it is in
   * its own process group, so a restart would otherwise orphan it and the new
   * daemon's first check would start a second one for the same exclave.
   */
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

/**
 * Per cache file and process-wide like `lane`: a config reload's new instance
 * must not retry a failing exclave inside its backoff, nor warn again.
 */
const backoff = new Map<string, Backoff>();

/** One line, bounded: the run's own words on why it failed, and nothing else it printed. */
function excerptOf(result: { readonly stdout: string; readonly stderr: string }): string {
  let text = result.stderr;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed === "object" && parsed !== null && "result" in parsed && typeof parsed.result === "string") {
      text = parsed.result;
    }
  } catch {
    // not JSON: stderr it is
  }
  const line = text.replaceAll(/\s+/gu, " ").trim();
  return line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS)}…` : line;
}

type Outcome =
  | { readonly kind: "ran"; readonly exitCode: number; readonly timedOut: boolean; readonly excerpt: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "abandoned" };

export function createUsageRefresh(deps: UsageRefreshDeps): UsageRefresh {
  const now = deps.now ?? Date.now;
  const staleAfterMs = Math.max(deps.staleAfterMs ?? STALE_AFTER_MS, DEBOUNCE_MS);
  const timeoutMs = deps.timeoutMs ?? REFRESH_TIMEOUT_MS;
  const claudeBin = deps.claudeBin ?? process.env["SEANCE_CLAUDE_BIN"] ?? "claude";
  const killAfterMs = deps.killAfterMs ?? KILL_AFTER_MS;
  const readStamp = cachedStampReader();
  let running: number | null = null;
  const queued: string[] = [];
  let draining: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const find = (id: string): Exclave | null => {
    const scan = deps.scan();
    const x = scan.exclaves.findIndex((exclave) => exclave.id === id);
    const exclave = scan.exclaves[x];
    // Signed out, a run could only fail: there is no account to read usage for.
    return exclave === undefined || scan.info[x]?.authOk !== true ? null : exclave;
  };

  /** The reading's stamp in seconds, or null when the cache holds none. */
  const readingAt = (exclave: Exclave): Promise<number | null> => readStamp(exclave.configFile, now());

  /** The run, or `abandoned` once it outlives even the kill grace — whatever its pipes are still doing. */
  const run = (exclave: Exclave): Promise<Outcome> => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const abandoned = new Promise<Outcome>((resolve) => {
      deadline = setTimeout(() => resolve({ kind: "abandoned" }), timeoutMs + killAfterMs + HARD_DEADLINE_SLACK_MS);
    });
    const ran = exec([claudeBin, ...USAGE_ARGS], {
      cwd: deps.home,
      env: usageEnv(exclave, deps.home),
      bareEnv: true,
      killGroup: true,
      killAfterMs,
      timeoutMs,
      onSpawn: (pid) => {
        running = pid;
      },
    }).then(
      (result): Outcome => ({
        kind: "ran",
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        excerpt: excerptOf(result),
      }),
      (err: unknown): Outcome => ({ kind: "error", message: String(err) }),
    );
    return Promise.race([ran, abandoned]).finally(() => {
      clearTimeout(deadline);
      running = null;
    });
  };

  const attempt = async (id: string): Promise<void> => {
    if (stopped) return;
    const exclave = find(id);
    if (exclave === null) return;
    const startedAt = now();
    const key = exclave.configFile;
    if ((backoff.get(key)?.retryAt ?? 0) > startedAt) return;
    // `fetchedAtMs` is the debounce marker; there is no second one of ours.
    const before = await readingAt(exclave);
    if (stopped || (before !== null && startedAt - before * 1000 <= staleAfterMs)) return;
    const outcome = await run(exclave);
    if (stopped) return;
    const after = await readingAt(exclave);
    // The cache is the result, not stdout: whatever the run printed, a cache that
    // did not move means nothing was refreshed.
    if (after !== null && (before === null || after > before)) {
      if (backoff.get(key)?.warned === true) log.info(`usage refresh: ${id} refreshed again`);
      backoff.delete(key);
      return;
    }
    const detail =
      outcome.kind === "ran" && outcome.excerpt !== "" && outcome.exitCode !== 0 ? `: ${outcome.excerpt}` : "";
    const why =
      outcome.kind === "error"
        ? `could not run ${claudeBin}: ${outcome.message}`
        : outcome.kind === "abandoned"
          ? `abandoned after ${(timeoutMs + killAfterMs) / 1000}s, still running`
          : outcome.timedOut
            ? `timed out after ${timeoutMs / 1000}s`
            : outcome.exitCode === 0
              ? "the cache did not move"
              : `exit ${outcome.exitCode}, the cache did not move${detail}`;
    if (backoff.get(key)?.warned !== true) {
      log.warn(`usage refresh: ${id} failed (${why}) — retrying every ${Math.round(staleAfterMs / 60_000)} min`);
    }
    backoff.set(key, { retryAt: now() + staleAfterMs, warned: true });
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
      if (running === null) return;
      try {
        process.kill(-running, "SIGKILL");
      } catch {
        // group already gone
      }
    },
    idle: async (): Promise<void> => {
      // oxlint-disable-next-line no-await-in-loop -- a drain begun while waiting is waited for too
      for (let pending = draining; pending !== null; pending = draining) await pending;
    },
  };
}
