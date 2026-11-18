import type { GithubBudget, GithubRate } from "@seance/shared";
import { readGithubUserId, readRateLimit, type RateBudget } from "./gh.ts";

/**
 * The daemon's own `gh`'s GitHub API budget (DESIGN.md, "GitHub rate limits"): `GET /rate_limit` on a timer, kept in
 * memory for the status's `gh`, and nothing else. Every session on every machine signed in as one GitHub user spends
 * one 5,000-an-hour REST budget (and one 5,000-point GraphQL one), so this is what lets the leader warn before it is
 * gone. Nothing here logs: a failed read is no reading, never a line (a machine with no `gh` would repeat it forever).
 */

/** Between reads while both budgets have at least half left. The read is free (GitHub counts no `rate_limit` call); this bounds process spawns. */
export const GITHUB_RATE_INTERVAL_MS = 5 * 60_000;

/**
 * Between reads once either budget is under `GITHUB_RATE_LOW_SHARE`. On 2026-11-17 the fleet spent a full REST
 * budget in 18 minutes (~280 requests a minute): from half left that is ~9 minutes, so a minute's pace crosses the
 * leader's 20% line with ~3 minutes to spare, where five could step past it. Every machine signed in as the user
 * reads the same budget on its own phase, which only tightens the fleet's effective pace.
 */
export const GITHUB_RATE_LOW_INTERVAL_MS = 60_000;

/** The share of a budget left below which reads come at `GITHUB_RATE_LOW_INTERVAL_MS`. */
export const GITHUB_RATE_LOW_SHARE = 0.5;

/**
 * How long a user id is kept before it is read again. `GET /user` costs one REST request, so it is not read every
 * time; re-read daily, and at once after `gh` reports no login, so a re-login as another user is caught.
 */
export const GITHUB_USER_TTL_MS = 24 * 3_600_000;

const READ_TIMEOUT_MS = 15_000;

export interface GithubRateOpts {
  /** The `gh` binary; `SEANCE_GH_BIN` then the PATH when absent. */
  readonly gh?: string;
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly lowIntervalMs?: number;
}

export interface GithubRateReader {
  /** The status's `gh`, or null: no `gh`, no login, a failed last read, or both budgets past their reset. */
  readonly view: () => GithubRate | null;
  /** One read now; resolves when it settled. Tests, and the first read at start. */
  readonly readNow: () => Promise<void>;
  readonly stop: () => void;
}

const budget = (b: RateBudget): GithubBudget => [b.limit, b.remaining, b.reset];

function isLow(b: RateBudget): boolean {
  return b.remaining < b.limit * GITHUB_RATE_LOW_SHARE;
}

export function startGithubRate(opts: GithubRateOpts = {}): GithubRateReader {
  const now = opts.now ?? Date.now;
  const ghOpts = { ...(opts.gh === undefined ? {} : { gh: opts.gh }), timeoutMs: READ_TIMEOUT_MS };
  let reading: { readonly core: RateBudget; readonly graphql: RateBudget } | null = null;
  let user: { readonly id: number; readonly at: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const read = async (): Promise<void> => {
    const answer = await readRateLimit(ghOpts);
    if (answer.kind !== "ok") {
      reading = null;
      if (answer.kind !== "failed") user = null;
      return;
    }
    reading = { core: answer.core, graphql: answer.graphql };
    if (user !== null && now() - user.at < GITHUB_USER_TTL_MS) return;
    const id = await readGithubUserId(ghOpts);
    // A failed id read keeps an id still in hand; the next read tries again.
    if (id.kind === "ok") user = { id: id.id, at: now() };
    else if (id.kind !== "failed") user = null;
  };

  const schedule = (): void => {
    if (stopped) return;
    const low = reading !== null && (isLow(reading.core) || isLow(reading.graphql));
    const delay = low
      ? (opts.lowIntervalMs ?? GITHUB_RATE_LOW_INTERVAL_MS)
      : (opts.intervalMs ?? GITHUB_RATE_INTERVAL_MS);
    timer = setTimeout(() => {
      timer = null;
      void readNow();
    }, delay);
  };

  const readNow = (): Promise<void> => {
    if (inFlight !== null) return inFlight;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    inFlight = read()
      .catch(() => {
        reading = null;
      })
      .finally(() => {
        inFlight = null;
        schedule();
      });
    return inFlight;
  };

  return {
    view: () => {
      if (reading === null) return null;
      // A budget past its reset says nothing about the window now running.
      const nowS = now() / 1000;
      const c = reading.core.reset > nowS ? budget(reading.core) : null;
      const g = reading.graphql.reset > nowS ? budget(reading.graphql) : null;
      if (c === null && g === null) return null;
      return {
        ...(user === null ? {} : { u: user.id }),
        ...(c === null ? {} : { c }),
        ...(g === null ? {} : { g }),
      };
    },
    readNow,
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
