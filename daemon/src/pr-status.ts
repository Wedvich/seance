import {
  isPrReadable,
  isRecord,
  quote,
  type PrChecks,
  type PrState,
  type PrStatus,
  type Task,
  wantsPrReading,
} from "@seance/shared";
import { exec } from "./exec.ts";

/**
 * Live PR status from the scheduler leader (DESIGN.md, "PR status"): one
 * batched GraphQL read per poll, through the operator's own `gh`, of the PR of
 * every task `wantsPrReading` names. Runs only on the leader (`leader.ts` starts it
 * after takeover and stops it with the term) and is never reachable from
 * `seanced mcp`, whose stdout is its JSON-RPC channel — hence `log` is passed
 * in, and this module imports no `log.ts`.
 *
 * What it reads is a task's `prUrl`, which a session reported; owner, repo and
 * number reach `gh` only as GraphQL variables in an argv array, never in the
 * query text, which is built from alias indices alone.
 */

export interface GithubPr {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]{0,9})$/u;

/** GraphQL's `Int`: one variable past it fails the whole batch. */
const MAX_PR_NUMBER = 2_147_483_647;

/** The one URL shape read: anything else (another forge, `/files`, a fork's host) is skipped silently. */
export function parseGithubPr(url: string): GithubPr | null {
  const match = PR_URL.exec(url);
  if (match === null) return null;
  const [, owner, repo, digits] = match;
  const number = Number(digits);
  if (owner === undefined || repo === undefined || number > MAX_PR_NUMBER) return null;
  return { owner, repo, number };
}

export interface PrPollerOpts {
  /** The `gh` binary, resolved per poll from `SEANCE_GH_BIN` (tests) then the PATH. */
  readonly gh?: string;
  readonly intervalMs?: number;
  /** The ceiling of the backoff after a failing poll. */
  readonly maxBackoffMs?: number;
  /** One `gh` run, killed with its group past it. */
  readonly timeoutMs?: number;
}

export interface PrPollerDeps extends PrPollerOpts {
  readonly tasks: () => readonly Task[];
  readonly onStatus: (taskId: string, prUrl: string, status: PrStatus) => Promise<void>;
  readonly now: () => number;
  readonly log: { info(line: string): void; warn(line: string): void };
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Well under GraphQL's node limit; one chunk is one request against the rate limit. */
const CHUNK = 50;
const MAX_OUTPUT_BYTES = 1 << 20;
/** `gh`'s exit code for a missing or rejected credential. */
const EXIT_AUTH = 4;

type Failure = "missing" | "unauthenticated" | "failed";

/** What a failing class tells the operator; never `gh`'s own words, which can carry a token's tail or a URL. */
const REMEDY: Record<Failure, string> = {
  missing: "gh is not on this leader's PATH — install it, then restart seanced",
  unauthenticated: "gh is not logged in on this leader — run gh auth login",
  failed: "gh did not answer usably",
};

interface Target {
  readonly pr: GithubPr;
  /** Every task read on this PR, each with the URL it holds: `prChange` compares them verbatim. */
  readonly tasks: { readonly id: string; readonly prUrl: string; readonly finished: boolean }[];
}

/**
 * A PR as the forge describes it, before it becomes a `PrStatus`. `none` is a
 * PR it gave nothing for: `error` is the GraphQL error type to log (not found,
 * forbidden), null for one it answered with a state this build does not know.
 */
type Read =
  | { readonly kind: "status"; readonly state: PrState; readonly checks?: PrChecks; readonly stacked?: true }
  | { readonly kind: "none"; readonly error: string | null };

function queryText(count: number): string {
  const indices = Array.from({ length: count }, (_, i) => i);
  const vars = indices.map((i) => `$o${i}:String!,$r${i}:String!,$n${i}:Int!`).join(",");
  const reads = indices
    .map(
      (i) =>
        `p${i}: repository(owner:$o${i},name:$r${i}){ defaultBranchRef{ name } pullRequest(number:$n${i}){ state isDraft merged baseRefName commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } } } }`,
    )
    .join(" ");
  return `query(${vars}){ ${reads} }`;
}

/** Strings through `-f`: `-F` reads `@file` and coerces types, so only the regex-checked number goes through it. */
function argvFor(gh: string, prs: readonly GithubPr[]): string[] {
  const variables = prs.flatMap((pr, i) => [
    "-f",
    `o${i}=${pr.owner}`,
    "-f",
    `r${i}=${pr.repo}`,
    "-F",
    `n${i}=${pr.number}`,
  ]);
  return [gh, "api", "--hostname", "github.com", "graphql", "-f", `query=${queryText(prs.length)}`, ...variables];
}

function checksOf(rollup: unknown): PrChecks | undefined {
  switch (rollup) {
    case "SUCCESS":
      return "passing";
    case "FAILURE":
    case "ERROR":
      return "failing";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return undefined;
  }
}

function rollupOf(pullRequest: Record<string, unknown>): unknown {
  const commits = pullRequest["commits"];
  if (!isRecord(commits) || !Array.isArray(commits["nodes"])) return undefined;
  const node: unknown = commits["nodes"][0];
  if (!isRecord(node) || !isRecord(node["commit"])) return undefined;
  const rollup = node["commit"]["statusCheckRollup"];
  return isRecord(rollup) ? rollup["state"] : undefined;
}

function stateOf(pullRequest: Record<string, unknown>): PrState | null {
  switch (pullRequest["state"]) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    case "OPEN":
      return pullRequest["isDraft"] === true ? "draft" : "open";
    default:
      return null;
  }
}

/**
 * `MERGED` means merged into the PR's base, which for a stacked PR is its
 * parent's branch, not the default. Anything short of both names matching is
 * not on the default branch as far as can be told: settling on a guess would
 * release dependents on nothing.
 */
function mergedIntoDefault(repository: Record<string, unknown>, pullRequest: Record<string, unknown>): boolean {
  const base = pullRequest["baseRefName"];
  const ref = repository["defaultBranchRef"];
  return typeof base === "string" && isRecord(ref) && ref["name"] === base;
}

/** A body with no `data` that is GitHub refusing the token: a revoked or expired one exits 1, not 4. */
function isBadCredentials(body: Record<string, unknown>): boolean {
  return body["message"] === "Bad credentials" || body["status"] === "401" || body["status"] === 401;
}

/** The GraphQL error `type` for alias `p<index>`, when it is the plain upper-case word GitHub sends. */
function errorType(errors: unknown, index: number): string {
  if (!Array.isArray(errors)) return "UNKNOWN";
  for (const error of errors) {
    if (!isRecord(error) || !Array.isArray(error["path"]) || error["path"][0] !== `p${index}`) continue;
    const { type } = error;
    if (typeof type === "string" && /^[A-Z_]{1,40}$/u.test(type)) return type;
  }
  return "UNKNOWN";
}

type Chunk = { readonly kind: Failure } | { readonly kind: "ok"; readonly reads: readonly Read[] };

/**
 * One `gh` run over `prs`. A PR the forge does not answer for (not found, no
 * access) makes `gh` exit 1 with the full JSON on stdout and `null` at its
 * alias, so a non-zero exit is not a failure by itself — only exit 4, a
 * timeout, or stdout that is no GraphQL answer is.
 */
async function readChunk(deps: PrPollerDeps, prs: readonly GithubPr[]): Promise<Chunk> {
  const gh = deps.gh ?? process.env["SEANCE_GH_BIN"] ?? "gh";
  let result;
  try {
    result = await exec(argvFor(gh, prs), {
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
  const reads: Read[] = [];
  prs.forEach((_, i) => {
    const repository = data[`p${i}`];
    const pullRequest = isRecord(repository) ? repository["pullRequest"] : null;
    if (!isRecord(repository) || !isRecord(pullRequest)) {
      reads.push({ kind: "none", error: errorType(body["errors"], i) });
      return;
    }
    const state = stateOf(pullRequest);
    const checks = checksOf(rollupOf(pullRequest));
    const stacked = state === "merged" && !mergedIntoDefault(repository, pullRequest);
    reads.push(
      state === null
        ? { kind: "none", error: null }
        : {
            kind: "status",
            state,
            ...(checks === undefined ? {} : { checks }),
            ...(stacked ? { stacked: true } : {}),
          },
    );
  });
  return { kind: "ok", reads };
}

/**
 * A finished task is read once a term: `read` holds those already read, `unreadable` the PRs the
 * forge would not answer. Its chip is not worth a read a minute, and an abandoned open PR would
 * otherwise be read for as long as the store keeps the task.
 */
function targets(tasks: readonly Task[], unreadable: ReadonlySet<string>, read: ReadonlySet<string>): Target[] {
  const byKey = new Map<string, Target>();
  for (const task of tasks) {
    if (!wantsPrReading(task) || task.prUrl === undefined) continue;
    if (!isPrReadable(task.state) && (unreadable.has(task.prUrl) || read.has(task.id))) continue;
    const pr = parseGithubPr(task.prUrl);
    if (pr === null) continue;
    // GitHub names are case-insensitive: two spellings are one PR.
    const key = `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase();
    const known = byKey.get(key);
    const entry = { id: task.id, prUrl: task.prUrl, finished: !isPrReadable(task.state) };
    if (known === undefined) byKey.set(key, { pr, tasks: [entry] });
    else known.tasks.push(entry);
  }
  return [...byKey.values()];
}

/**
 * Polls on a timer chain — one poll at a time — starting now. A failing poll
 * (no `gh`, not logged in, a timeout, garbage) writes nothing, warns once on
 * entering that class, and backs the next poll off from `intervalMs` toward
 * `maxBackoffMs`; the first good poll after one says so once. `stop` also
 * drops an in-flight poll's results, so a term's end never writes after it.
 */
export function startPrPoller(deps: PrPollerDeps): { readonly stop: () => void } {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxBackoffMs = deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let state: "ok" | Failure = "ok";
  let failures = 0;
  const unreadable = new Set<string>();
  const readThisTerm = new Set<string>();

  const enter = (next: "ok" | Failure): void => {
    if (next === state) return;
    state = next;
    if (next === "ok") deps.log.info("pr-status: gh answers again — PR status resumed");
    else deps.log.warn(`pr-status: ${REMEDY[next]}; PR status paused (${next})`);
  };

  /** The class the poll ended in, or null when there was nothing to poll. */
  async function poll(): Promise<"ok" | Failure | null> {
    const wanted = targets(deps.tasks(), unreadable, readThisTerm);
    if (wanted.length === 0) return null;
    for (let from = 0; from < wanted.length; from += CHUNK) {
      const chunk = wanted.slice(from, from + CHUNK);
      // oxlint-disable-next-line no-await-in-loop -- chunks run one after another, never overlapping
      const answer = await readChunk(
        deps,
        chunk.map((target) => target.pr),
      );
      if (stopped) return null;
      if (answer.kind !== "ok") return answer.kind;
      const at = deps.now();
      const writes: Promise<void>[] = [];
      chunk.forEach((target, i) => {
        const read = answer.reads[i];
        if (read === undefined) return;
        if (read.kind === "none") {
          const url = target.tasks[0]?.prUrl;
          if (read.error !== null && url !== undefined && !unreadable.has(url)) {
            unreadable.add(url);
            deps.log.warn(`pr-status: ${quote(url)} is not readable (${read.error})`);
          }
          return;
        }
        const status: PrStatus = {
          state: read.state,
          ...(read.checks === undefined ? {} : { checks: read.checks }),
          ...(read.stacked === undefined ? {} : { stacked: read.stacked }),
          at,
        };
        for (const task of target.tasks) {
          // Only a task finished when targeted: one read while placed still owes its finished read.
          if (task.finished) readThisTerm.add(task.id);
          writes.push(deps.onStatus(task.id, task.prUrl, status));
        }
      });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await Promise.all(writes);
      if (stopped) return null;
    }
    return "ok";
  }

  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void run(), delay);
  };

  async function run(): Promise<void> {
    timer = null;
    let outcome: "ok" | Failure | null;
    try {
      outcome = await poll();
    } catch {
      // A rejected write is the caller's to report (`leader.ts` does), and says nothing of gh.
      outcome = null;
    }
    if (stopped) return;
    if (outcome === null) {
      schedule(intervalMs);
      return;
    }
    enter(outcome);
    failures = outcome === "ok" ? 0 : failures + 1;
    schedule(outcome === "ok" ? intervalMs : Math.min(intervalMs * 2 ** failures, maxBackoffMs));
  }

  void run();
  return {
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
