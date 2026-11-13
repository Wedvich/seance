import { isRecord } from "@seance/shared";
import { exec } from "./exec.ts";

/**
 * The daemon's one way to read GitHub: the operator's own `gh`, a GraphQL query whose text is constant (or built from
 * alias indices alone) with every value passed as a variable in an argv array. Read-only, and nothing here logs:
 * `gh`'s stderr can carry a token's tail or a URL, and its stdout is the user's own data. Used by the leader's PR
 * poller and `readPrHead` (`pr-status.ts`) and by reap's nothing-lost rule (`reap-git.ts`).
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

/**
 * One `gh` GraphQL run. A node the forge does not answer for (not found, no
 * access) makes `gh` exit 1 with the full JSON on stdout and `null` at its
 * alias, so a non-zero exit is not a failure by itself — only exit 4, a
 * timeout, or stdout that is no GraphQL answer is.
 */
export async function askGithub(opts: GhOpts, query: string, variables: readonly string[]): Promise<GhAnswer> {
  const gh = opts.gh ?? process.env["SEANCE_GH_BIN"] ?? "gh";
  let result;
  try {
    result = await exec([gh, "api", "--hostname", "github.com", "graphql", "-f", `query=${query}`, ...variables], {
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
  let body: unknown;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return { kind: "failed" };
  }
  if (!isRecord(body)) return { kind: "failed" };
  const { data } = body;
  if (!isRecord(data)) return { kind: isBadCredentials(body) ? "unauthenticated" : "failed" };
  return { kind: "ok", body, data };
}
