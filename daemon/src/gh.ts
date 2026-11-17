import { isRecord } from "@seance/shared";
import { exec } from "./exec.ts";

/**
 * The daemon's one way to read GitHub: the operator's own `gh`, a GraphQL query whose text is constant (or built from
 * alias indices alone) with every value passed as a variable in an argv array. Read-only, and nothing here logs:
 * `gh`'s stderr can carry a token's tail or a URL, and its stdout is the user's own data. Used by the leader's PR
 * poller and `readPrHead` (`pr-status.ts`), by reap's nothing-lost rule (`reap-git.ts`) and by the custodian's `pr` verb.
 * Beside it, two constant REST reads for the daemon's own budget (`github-rate.ts`): `readRateLimit` and
 * `readGithubUserId`.
 */

const MAX_OUTPUT_BYTES = 1 << 20;
/** `gh`'s exit code for a missing or rejected credential. */
const EXIT_AUTH = 4;

export type GhFailure = "missing" | "unauthenticated" | "failed";

export type GhAnswer =
  | { readonly kind: GhFailure }
  | { readonly kind: "ok"; readonly body: Record<string, unknown>; readonly data: Record<string, unknown> };

export interface GhOpts {
  /** The `gh` binary; `SEANCE_GH_BIN` (tests) then the PATH when absent. */
  readonly gh?: string;
  /** One run, killed with its group past it. */
  readonly timeoutMs: number;
}

/** A body with no `data` that is GitHub refusing the token: a revoked or expired one exits 1, not 4. */
function isBadCredentials(body: Record<string, unknown>): boolean {
  return body["message"] === "Bad credentials" || body["status"] === "401" || body["status"] === 401;
}

type GhRun =
  | { readonly kind: GhFailure }
  | { readonly kind: "ran"; readonly exitCode: number; readonly stdout: string };

/** One `gh api` run against github.com, argv array, prompts and update checks off. Nothing here logs. */
async function runGh(opts: GhOpts, args: readonly string[]): Promise<GhRun> {
  const gh = opts.gh ?? process.env["SEANCE_GH_BIN"] ?? "gh";
  let result;
  try {
    result = await exec([gh, "api", "--hostname", "github.com", ...args], {
      timeoutMs: opts.timeoutMs,
      killGroup: true,
      killAfterMs: 5_000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
    });
  } catch (err) {
    return { kind: err instanceof Error && "code" in err && err.code === "ENOENT" ? "missing" : "failed" };
  }
  if (result.timedOut) return { kind: "failed" };
  if (result.exitCode === EXIT_AUTH) return { kind: "unauthenticated" };
  return { kind: "ran", exitCode: result.exitCode, stdout: result.stdout };
}

/**
 * One `gh` GraphQL run. A node the forge does not answer for (not found, no
 * access) makes `gh` exit 1 with the full JSON on stdout and `null` at its
 * alias, so a non-zero exit is not a failure by itself — only exit 4, a
 * timeout, or stdout that is no GraphQL answer is.
 */
export async function askGithub(opts: GhOpts, query: string, variables: readonly string[]): Promise<GhAnswer> {
  const run = await runGh(opts, ["graphql", "-f", `query=${query}`, ...variables]);
  if (run.kind !== "ran") return run;
  let body: unknown;
  try {
    body = JSON.parse(run.stdout);
  } catch {
    return { kind: "failed" };
  }
  if (!isRecord(body)) return { kind: "failed" };
  const { data } = body;
  if (!isRecord(data)) return { kind: isBadCredentials(body) ? "unauthenticated" : "failed" };
  return { kind: "ok", body, data };
}

/** A budget as `GET /rate_limit` reports it, checked down to its four counts. */
export interface RateBudget {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  /** Unix seconds. */
  readonly reset: number;
}

export type RateLimitAnswer =
  | { readonly kind: GhFailure }
  | { readonly kind: "ok"; readonly core: RateBudget; readonly graphql: RateBudget };

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function rateBudget(value: unknown): RateBudget | null {
  if (!isRecord(value)) return null;
  const { limit, used, remaining, reset } = value;
  if (!isCount(limit) || !isCount(used) || !isCount(remaining) || !isCount(reset)) return null;
  return limit > 0 && remaining <= limit && reset > 0 ? { limit, used, remaining, reset } : null;
}

/**
 * `GET /rate_limit`: the daemon's one REST read of GitHub's rate limits, a constant path and nothing else. GitHub
 * does not count it against any limit ("Rate limits for the REST API"). Only `resources.core` and
 * `resources.graphql` are kept, each checked to its four counts; anything else in the answer is dropped unread.
 */
export async function readRateLimit(opts: GhOpts): Promise<RateLimitAnswer> {
  const run = await runGh(opts, ["rate_limit"]);
  if (run.kind !== "ran") return run;
  if (run.exitCode !== 0) return { kind: "failed" };
  let body: unknown;
  try {
    body = JSON.parse(run.stdout);
  } catch {
    return { kind: "failed" };
  }
  if (!isRecord(body)) return { kind: "failed" };
  if (!isRecord(body["resources"])) return { kind: isBadCredentials(body) ? "unauthenticated" : "failed" };
  const core = rateBudget(body["resources"]["core"]);
  const graphql = rateBudget(body["resources"]["graphql"]);
  return core === null || graphql === null ? { kind: "failed" } : { kind: "ok", core, graphql };
}

export type UserIdAnswer = { readonly kind: GhFailure } | { readonly kind: "ok"; readonly id: number };

/**
 * `GET /user`'s numeric `id`, through `gh`'s own `--jq`, so the profile (name, email) never reaches this process.
 * Unlike `rate_limit` it costs one REST request, which is why its caller caches it.
 */
export async function readGithubUserId(opts: GhOpts): Promise<UserIdAnswer> {
  const run = await runGh(opts, ["user", "--jq", ".id"]);
  if (run.kind !== "ran") return run;
  const text = run.stdout.trim();
  if (run.exitCode !== 0 || !/^[1-9][0-9]{0,15}$/u.test(text)) return { kind: "failed" };
  const id = Number(text);
  return Number.isSafeInteger(id) ? { kind: "ok", id } : { kind: "failed" };
}
