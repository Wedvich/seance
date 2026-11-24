import type { PrHeadReading } from "@seance/scheduler";
import {
  isBranchName,
  isRecord,
  parseGithubPr,
  PR_FAILING_LIMITS,
  PR_MERGE_STATES,
  quote,
  type GithubPr,
  type GithubRun,
  type PrChecks,
  type PrMergeState,
  type PrState,
  type PrStatus,
  type Task,
  TASK_PHASES,
  taskPrs,
  wantsPrReading,
  runUrlOf,
  WATCH_CONCLUSIONS,
  WATCH_FAILING_MAX,
  type WatchConclusion,
  type WatchFailing,
  type WatchSuspendReason,
} from "@seance/shared";
import { askGithub, type GhAnswer, type GhFailure } from "./gh.ts";
import type { PollerWatches, PrReading, RunReading, WatchedPr, WatchedRun } from "./watch-registry.ts";

/**
 * Live PR status from the scheduler leader (DESIGN.md, "PR status"): one
 * batched GraphQL read per poll, through the operator's own `gh`, of every PR
 * (`taskPrs`) of every task `wantsPrReading` names. Runs only on the leader (`leader.ts` starts it
 * after takeover and stops it with the term) and is never reachable from
 * `seance mcp`, whose stdout is its JSON-RPC channel — hence `log` is passed
 * in, and this module imports no `log.ts`.
 *
 * The merge read is one query and the blocked-state read (head, required checks, merge state,
 * whether something will merge it) is a second, so that its cost and its failures never reach the
 * merge read: the wide selection measured several times slower per PR, and merged into the merge
 * query a slow or failing one would fail the chunk and back the poller off, stopping merge
 * detection fleet-wide.
 *
 * What it reads are a task's PR URLs, which a session reported; owner, repo and
 * number reach `gh` only as GraphQL variables in an argv array, never in the
 * query text, which is built from alias indices alone.
 */

export interface PrPollerOpts {
  /** The `gh` binary, resolved per poll from `SEANCE_GH_BIN` (tests) then the PATH. */
  readonly gh?: string;
  readonly intervalMs?: number;
  /** The ceiling of the backoff after a failing poll. */
  readonly maxBackoffMs?: number;
  /** One `gh` run, killed with its group past it. */
  readonly timeoutMs?: number;
  /**
   * The GraphQL budget's reset (unix ms) from this machine's own rate reader (`github-rate.ts`), or null: where a
   * `limited` poll looks when no in-query `resetAt` of this term is still ahead.
   */
  readonly graphqlReset?: () => number | null;
  /** In [0, 1): the share of `LIMIT_JITTER_MS` added to a wait for the reset. `Math.random` unless a test pins it. */
  readonly random?: () => number;
}

export interface PrPollerDeps extends PrPollerOpts {
  /**
   * The leader's watch registry (docs/gh-watch.md; DESIGN.md, "PR status"): what it wants read beside the tasks' PRs,
   * and where each poll's readings go. Unset, a poll reads and writes exactly what it did before watches existed.
   */
  readonly watches?: PollerWatches;
  readonly tasks: () => readonly Task[];
  readonly onStatus: (taskId: string, prUrl: string, status: PrStatus) => Promise<void>;
  readonly now: () => number;
  readonly log: { info(line: string): void; warn(line: string): void };
}

export const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Well under GraphQL's node limit; one chunk is one request against the rate limit. */
const CHUNK = 50;
/**
 * The blocked-state selection measured 3-8 s on a 50-PR chunk against 1-2 s for the merge query, and
 * GitHub cuts a query off at about 10 s, so these run 10 at a time.
 */
const BLOCKED_CHUNK = 10;
/** Run aliases per query: 50 cost one point (docs/gh-watch.md S1). */
const RUN_CHUNK = 50;
/**
 * Under this many GraphQL points remaining, with the reset still ahead, a poll reads tasks' PRs only: the budget is the
 * token's, and a task's merge must never wait on a watch (docs/gh-watch.md W8).
 */
const WATCH_RESERVE_POINTS = 500;

type Failure = GhFailure;

/** What a failing class tells the operator; never `gh`'s own words, which can carry a token's tail or a URL. */
const REMEDY: Record<Failure, string> = {
  missing: "gh is not on this leader's PATH — install it, then restart seanced",
  unauthenticated: "gh is not logged in on this leader — run gh auth login",
  limited: "GitHub's rate limit for this leader's gh user is spent",
  failed: "gh did not answer usably",
};

/**
 * Selected beside every poll query's aliases, so each answer says what the budget holds and what the query cost.
 * Constant text: the queries stay built from alias indices alone.
 */
const RATE_LIMIT_SELECTION = "rateLimit{ cost remaining resetAt }";

/** Added to a wait for a reset, so the poll does not land on the reset's first second (the budget may not be renewed yet). */
export const LIMIT_JITTER_MS = 60_000;

/** GraphQL's window is an hour: a reset further out than this is no reading of it. */
const MAX_RESET_AHEAD_MS = 61 * 60_000;

/** The GraphQL budget as the last good answer's `rateLimit` gave it; `resetAt` in unix ms. */
export interface GraphqlBudget {
  readonly remaining: number;
  readonly resetAt: number;
}

function budgetOf(data: Record<string, unknown>): GraphqlBudget | null {
  const rateLimit = data["rateLimit"];
  if (!isRecord(rateLimit)) return null;
  const { remaining, resetAt } = rateLimit;
  if (typeof remaining !== "number" || !Number.isSafeInteger(remaining) || remaining < 0) return null;
  if (typeof resetAt !== "string") return null;
  const at = Date.parse(resetAt);
  return Number.isFinite(at) ? { remaining, resetAt: at } : null;
}

/**
 * The wait before the poll after a `limited` one: until `resetAt` plus up to `LIMIT_JITTER_MS`, or null (the
 * ladder) when no reset is known, it has passed, or it lies past one GraphQL window.
 */
export function limitedDelay(resetAt: number | null, now: number, random: number): number | null {
  if (resetAt === null) return null;
  const ahead = resetAt - now;
  if (!(ahead > 0) || ahead > MAX_RESET_AHEAD_MS) return null;
  const share = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1) : 0;
  return ahead + Math.floor(share * (LIMIT_JITTER_MS - 1));
}

interface Target {
  readonly pr: GithubPr;
  /** Every task read on this PR, each with the URL it holds: `prChange` compares them verbatim. */
  readonly tasks: {
    readonly id: string;
    readonly prUrl: string;
    readonly finished: boolean;
    /** Primary PR of an `awaiting-merge` task not under `until: "reported"`: the only one `taskPrBlock` can name. */
    readonly wide: boolean;
  }[];
  /** The registry's key for this PR when a watch holds it: its reading goes there as well as to its tasks. */
  readonly watchKey?: string;
  /** Under the reserve: the watch takes this PR's merge reading (a task reads it anyway) and asks nothing more. */
  readonly watchMergeOnly?: true;
}

type WideFields = Pick<PrStatus, "head" | "required" | "failing" | "merge" | "armed" | "reviewRequested">;

/**
 * A PR as the forge describes it, before it becomes a `PrStatus`. `none` is a
 * PR it gave nothing for: `error` is the GraphQL error type to log (not found,
 * forbidden), null for one it answered with a state this build does not know.
 */
type Read =
  | {
      readonly kind: "status";
      readonly state: PrState;
      readonly checks?: PrChecks;
      readonly stacked?: true;
    }
  | { readonly kind: "none"; readonly error: string | null };

function queryText(count: number): string {
  const indices = Array.from({ length: count }, (_, i) => i);
  const vars = indices.map((i) => `$o${i}:String!,$r${i}:String!,$n${i}:Int!`).join(",");
  const reads = indices
    .map(
      (i) =>
        `p${i}: repository(owner:$o${i},name:$r${i}){ defaultBranchRef{ name } pullRequest(number:$n${i}){ state isDraft merged baseRefName mergeCommit{ oid } commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } } } }`,
    )
    .join(" ");
  return `query(${vars}){ ${reads} ${RATE_LIMIT_SELECTION} }`;
}

/** Strings through `-f`: `-F` reads `@file` and coerces types, so only the regex-checked number goes through it. */
function prVariables(prs: readonly GithubPr[]): string[] {
  return prs.flatMap((pr, i) => ["-f", `o${i}=${pr.owner}`, "-f", `r${i}=${pr.repo}`, "-F", `n${i}=${pr.number}`]);
}

/** A stacked merge to check: its alias index in the chunk, kept so `c<i>` answers for `p<i>`. */
interface Landing {
  readonly index: number;
  readonly pr: GithubPr;
  readonly oid: string;
}

function landedQueryText(landings: readonly Landing[]): string {
  const vars = landings.map(({ index: i }) => `$o${i}:String!,$r${i}:String!,$h${i}:String!`).join(",");
  const reads = landings
    .map(
      ({ index: i }) =>
        `c${i}: repository(owner:$o${i},name:$r${i}){ defaultBranchRef{ compare(headRef:$h${i}){ status } } }`,
    )
    .join(" ");
  return `query(${vars}){ ${reads} ${RATE_LIMIT_SELECTION} }`;
}

function landedVariables(landings: readonly Landing[]): string[] {
  return landings.flatMap(({ index: i, pr, oid }) => [
    "-f",
    `o${i}=${pr.owner}`,
    "-f",
    `r${i}=${pr.repo}`,
    "-f",
    `h${i}=${oid}`,
  ]);
}

/** A blocked-state read to make: its alias index in the chunk, kept so `b<i>` answers for `p<i>`. */
interface Wide {
  readonly index: number;
  readonly pr: GithubPr;
}

function blockedQueryText(wide: readonly Wide[]): string {
  const vars = wide.map(({ index: i }) => `$o${i}:String!,$r${i}:String!,$n${i}:Int!`).join(",");
  const reads = wide
    .map(
      ({ index: i }) =>
        `b${i}: repository(owner:$o${i},name:$r${i}){ pullRequest(number:$n${i}){ mergeStateStatus mergeable headRefOid isInMergeQueue autoMergeRequest{ enabledAt } reviewRequests{ totalCount } commits(last:1){ nodes{ commit{ oid statusCheckRollup{ contexts(first:50){ totalCount nodes{ __typename ... on CheckRun{ databaseId name status conclusion detailsUrl checkSuite{ databaseId } isRequired(pullRequestNumber:$n${i}) } ... on StatusContext{ context state isRequired(pullRequestNumber:$n${i}) } } } } } } } } }`,
    )
    .join(" ");
  return `query(${vars}){ ${reads} ${RATE_LIMIT_SELECTION} }`;
}

function blockedVariables(wide: readonly Wide[]): string[] {
  return wide.flatMap(({ index: i, pr }) => [
    "-f",
    `o${i}=${pr.owner}`,
    "-f",
    `r${i}=${pr.repo}`,
    "-F",
    `n${i}=${pr.number}`,
  ]);
}

/** A failing rollup's second look (`f<i>` for `p<i>`): each context's outcome, and whether a CheckRun ran a step. */
function rejudgeQueryText(failed: readonly Wide[]): string {
  const vars = failed.map(({ index: i }) => `$o${i}:String!,$r${i}:String!,$n${i}:Int!`).join(",");
  const reads = failed
    .map(
      ({ index: i }) =>
        `f${i}: repository(owner:$o${i},name:$r${i}){ pullRequest(number:$n${i}){ commits(last:1){ nodes{ commit{ statusCheckRollup{ state contexts(first:50){ totalCount nodes{ __typename ... on CheckRun{ databaseId name status conclusion steps(first:1){ totalCount } } ... on StatusContext{ context state } } } } } } } } }`,
    )
    .join(" ");
  return `query(${vars}){ ${reads} ${RATE_LIMIT_SELECTION} }`;
}

/** A watched run's read: `w<i>` is alias `i`, its URL a `URI!` variable, never in the query text. */
function runQueryText(count: number): string {
  const indices = Array.from({ length: count }, (_, i) => i);
  const vars = indices.map((i) => `$u${i}:URI!`).join(",");
  const reads = indices
    .map(
      (i) =>
        `w${i}: resource(url:$u${i}){ ... on WorkflowRun{ databaseId runAttempt checkSuite{ status conclusion checkRuns(first:20, filterBy:{checkType: LATEST}){ nodes{ __typename name conclusion databaseId detailsUrl } } } } }`,
    )
    .join(" ");
  return `query(${vars}){ ${reads} ${RATE_LIMIT_SELECTION} }`;
}

/** `-f` always: `-F` reads `@file`. The URL is rebuilt from the parsed id, never the session's string. */
function runVariables(runs: readonly WatchedRun[]): string[] {
  return runs.flatMap(({ run }, i) => ["-f", `u${i}=${runUrlOf(run)}`]);
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

function commitOf(pullRequest: Record<string, unknown>): Record<string, unknown> | undefined {
  const commits = pullRequest["commits"];
  if (!isRecord(commits) || !Array.isArray(commits["nodes"])) return undefined;
  const node: unknown = commits["nodes"][0];
  return isRecord(node) && isRecord(node["commit"]) ? node["commit"] : undefined;
}

function headOf(pullRequest: Record<string, unknown>): string | undefined {
  const commit = commitOf(pullRequest);
  const oid = commit === undefined ? undefined : commit["oid"];
  return typeof oid === "string" && COMMIT_OID.test(oid) ? oid : undefined;
}

// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/gu;

/** A name a repo owns, as it may enter a sealed record and a session prompt: no control characters, bounded. */
function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replaceAll(CONTROL_CHARACTERS, "").trim();
  // Cut on code points, then re-check the unit count the parser bounds: a cut between a surrogate pair would leave half of one.
  let name = "";
  for (const point of clean) {
    if (name.length + point.length > PR_FAILING_LIMITS.length) break;
    name += point;
  }
  name = name.trim();
  return name === "" ? undefined : name;
}

/** How one required context stands, and the name to give when it failed. */
function contextOf(node: Record<string, unknown>): { readonly checks: PrChecks; readonly name: unknown } {
  if (node["__typename"] === "StatusContext") {
    return { checks: checksOf(node["state"]) ?? "pending", name: node["context"] };
  }
  if (node["status"] !== "COMPLETED") return { checks: "pending", name: node["name"] };
  return { checks: conclusionOf(node["conclusion"]), name: node["name"] };
}

/** How a finished CheckRun's conclusion counts: one classification for a task's rollup, a watch's checks and a run's jobs. */
function conclusionOf(conclusion: unknown): PrChecks {
  switch (conclusion) {
    case "SUCCESS":
    case "NEUTRAL":
    case "SKIPPED":
      return "passing";
    case "FAILURE":
    case "TIMED_OUT":
    case "CANCELLED":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return "failing";
    default:
      return "pending";
  }
}

/** A CheckRun cancelled before it ran a step: on GitHub Actions, a job no runner took before its timeout. */
function neverRan(node: Record<string, unknown>): boolean {
  if (node["__typename"] !== "CheckRun" || node["status"] !== "COMPLETED" || node["conclusion"] !== "CANCELLED") {
    return false;
  }
  const steps = node["steps"];
  return isRecord(steps) && steps["totalCount"] === 0;
}

/**
 * A `FAILURE` rollup judged again over the newest run of each name: `unrun` when only runs that never ran failed and
 * nothing is pending, `pending` when they failed and something still runs, `passing` when only superseded runs
 * failed. `failing` when a context failed, and whenever the read cannot show otherwise: no `FAILURE` rollup any more
 * (a new head between the two queries), no contexts, or more than the 50 read.
 */
function rejudgedFailure(rollup: unknown): PrChecks {
  if (!isRecord(rollup) || rollup["state"] !== "FAILURE") return "failing";
  const contexts = rollup["contexts"];
  const nodes = isRecord(contexts) ? contexts["nodes"] : undefined;
  if (!isRecord(contexts) || !Array.isArray(nodes)) return "failing";
  const total = contexts["totalCount"];
  if (typeof total !== "number" || total > nodes.length) return "failing";
  const latest = latestRuns(nodes, nameKey);
  if (latest.length === 0) return "failing";
  let pending = false;
  let unrun = false;
  for (const node of latest) {
    if (neverRan(node)) {
      unrun = true;
      continue;
    }
    const { checks } = contextOf(node);
    if (checks === "failing") return "failing";
    if (checks === "pending") pending = true;
  }
  if (pending) return "pending";
  return unrun ? "unrun" : "passing";
}

/**
 * The contexts with every CheckRun but the newest of its name dropped. A head can carry several runs
 * of one check: a re-run, or a run its concurrency group cancelled when a second event on the same
 * commit started another. GitHub's merge gate judges the newest alone, so a superseded `CANCELLED`
 * must not read as a failing required check. Check run ids only grow; a run without one ranks below
 * any with one, and later in the list above earlier, so the order stays total. A StatusContext is
 * already one per context. Each name keeps its first run's place: the failing names' cap cuts from
 * the end, and a re-run must not reorder what it cuts.
 */
function latestRuns(
  nodes: readonly unknown[],
  keyOf: (node: Record<string, unknown>) => string,
): Record<string, unknown>[] {
  const latest = new Map<string, { readonly id: number; readonly node: Record<string, unknown> }>();
  for (const node of nodes) {
    if (!isRecord(node) || node["__typename"] !== "CheckRun" || typeof node["name"] !== "string") continue;
    const raw = node["databaseId"];
    const id = typeof raw === "number" ? raw : -1;
    const key = keyOf(node);
    const seen = latest.get(key);
    // An equal id ties to the later run, which is always this one.
    if (seen === undefined || id >= seen.id) latest.set(key, { id, node });
  }
  const placed = new Set<string>();
  return nodes.flatMap((node): Record<string, unknown>[] => {
    if (!isRecord(node)) return [];
    if (node["__typename"] !== "CheckRun" || typeof node["name"] !== "string") return [node];
    const key = keyOf(node);
    const winner = latest.get(key);
    if (winner === undefined || placed.has(key)) return [];
    placed.add(key);
    return [winner.node];
  });
}

/** A task's rollup dedupes by name alone, as GitHub's merge gate does. */
const nameKey = (node: Record<string, unknown>): string => String(node["name"]);

/**
 * A watch's judgement dedupes per (check suite, name): two workflows with a job of one name are two contexts, so a
 * failure in one is never hidden by a success in the other. `?` stands for a suite the read did not name.
 */
function suiteNameKey(node: Record<string, unknown>): string {
  const suite = node["checkSuite"];
  const id = isRecord(suite) ? suite["databaseId"] : undefined;
  return `${typeof id === "number" ? id : "?"}:${String(node["name"])}`;
}

/**
 * The rollup of the head's required contexts alone (an optional check failing blocks nothing), and
 * the names of the failing ones. Undefined when none is required, or the shape is not the one asked
 * for: a repo with no required check never reads as blocked on one.
 */
function requiredOf(
  pullRequest: Record<string, unknown>,
): { readonly required: PrChecks; readonly failing: readonly string[] } | undefined {
  const commit = commitOf(pullRequest);
  const rollup = commit === undefined ? undefined : commit["statusCheckRollup"];
  const contexts = isRecord(rollup) ? rollup["contexts"] : undefined;
  const nodes = isRecord(contexts) ? contexts["nodes"] : undefined;
  if (!Array.isArray(nodes)) return undefined;
  let any = false;
  let failing = false;
  let pending = false;
  const names = new Set<string>();
  for (const node of latestRuns(nodes, nameKey)) {
    if (node["isRequired"] !== true) continue;
    any = true;
    const { checks, name } = contextOf(node);
    if (checks === "pending") pending = true;
    if (checks !== "failing") continue;
    failing = true;
    const clean = cleanName(name);
    if (clean !== undefined) names.add(clean);
  }
  if (!any) return undefined;
  return {
    required: failing ? "failing" : pending ? "pending" : "passing",
    failing: [...names].slice(0, PR_FAILING_LIMITS.names),
  };
}

function mergeOf(pullRequest: Record<string, unknown>): PrMergeState | undefined {
  const status = pullRequest["mergeStateStatus"];
  if (typeof status !== "string") return undefined;
  const lower = status.toLowerCase();
  return PR_MERGE_STATES.find((m) => m === lower);
}

/** Something will merge it: auto-merge is enabled, or it is in the merge queue. */
function armedOf(pullRequest: Record<string, unknown>): boolean {
  return isRecord(pullRequest["autoMergeRequest"]) || pullRequest["isInMergeQueue"] === true;
}

function reviewRequestedOf(pullRequest: Record<string, unknown>): boolean {
  const requests = pullRequest["reviewRequests"];
  const count = isRecord(requests) ? requests["totalCount"] : undefined;
  return typeof count === "number" && count > 0;
}

function wideOf(pullRequest: Record<string, unknown>): WideFields {
  const head = headOf(pullRequest);
  const required = requiredOf(pullRequest);
  const merge = mergeOf(pullRequest);
  return {
    ...(head === undefined ? {} : { head }),
    ...(required === undefined ? {} : { required: required.required }),
    // Only a failing rollup names anything; the parser refuses names beside any other.
    ...(required?.required === "failing" && required.failing.length > 0 ? { failing: required.failing } : {}),
    ...(merge === undefined ? {} : { merge }),
    ...(armedOf(pullRequest) ? { armed: true as const } : {}),
    ...(reviewRequestedOf(pullRequest) ? { reviewRequested: true as const } : {}),
  };
}

/** What a watch reads of an open or draft PR: never a task's `PrStatus`, which `wideOf` alone builds. */
interface WatchPr {
  readonly head?: string;
  readonly conflict: boolean;
  readonly checks?: "pass" | "fail";
  readonly failing: readonly WatchFailing[];
}

const JOB_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/actions\/runs\/([1-9][0-9]{0,19})\/job\/([1-9][0-9]{0,19})$/u;

/**
 * The job a check run's `detailsUrl` names, only in the watched repo (compared case-insensitively) and rebuilt from the
 * two id strings by whoever sends it: a repo's own URL never reaches a session as it was written.
 */
function jobOf(detailsUrl: unknown, owner: string, repo: string): WatchFailing["job"] | undefined {
  if (typeof detailsUrl !== "string") return undefined;
  const match = JOB_URL.exec(detailsUrl);
  if (match === null) return undefined;
  const [, urlOwner, urlRepo, run, job] = match;
  if (run === undefined || job === undefined) return undefined;
  if (urlOwner?.toLowerCase() !== owner.toLowerCase() || urlRepo?.toLowerCase() !== repo.toLowerCase()) {
    return undefined;
  }
  return { run, job };
}

function failingOf(
  node: Record<string, unknown>,
  owner: string,
  repo: string,
  name: unknown,
): WatchFailing | undefined {
  const clean = cleanName(name);
  if (clean === undefined) return undefined;
  const job = node["__typename"] === "CheckRun" ? jobOf(node["detailsUrl"], owner, repo) : undefined;
  return {
    name: clean,
    ...(node["isRequired"] === true ? { required: true as const } : {}),
    ...(job === undefined ? {} : { job }),
  };
}

/**
 * A watched PR's head, conflict and checks (docs/gh-watch.md W4, S2). The head is `headRefOid`. The checks are judged
 * over every context of the last commit, required or not, deduped per (check suite, name), and only when that
 * commit is the head: a rollup of another commit says nothing of this one. `fail` is any failing context. `pass` is a
 * non-empty list that is all passing, none pending (a CheckRun not completed, `STALE`, an unknown conclusion, a
 * pending or expected status) and not truncated (`totalCount` within the nodes read). Anything else is no reading.
 */
function watchPrOf(pullRequest: Record<string, unknown>, pr: GithubPr): WatchPr {
  const raw = pullRequest["headRefOid"];
  const head = typeof raw === "string" && COMMIT_OID.test(raw) ? raw : undefined;
  const conflict = pullRequest["mergeStateStatus"] === "DIRTY" || pullRequest["mergeable"] === "CONFLICTING";
  const base = { ...(head === undefined ? {} : { head }), conflict };
  const commit = commitOf(pullRequest);
  if (commit === undefined || head === undefined || commit["oid"] !== head) return { ...base, failing: [] };
  const rollup = commit["statusCheckRollup"];
  const contexts = isRecord(rollup) ? rollup["contexts"] : undefined;
  const nodes = isRecord(contexts) ? contexts["nodes"] : undefined;
  if (!isRecord(contexts) || !Array.isArray(nodes)) return { ...base, failing: [] };
  let anyFailing = false;
  let pending = false;
  const failing: WatchFailing[] = [];
  const latest = latestRuns(nodes, suiteNameKey);
  for (const node of latest) {
    const { checks, name } = contextOf(node);
    if (checks === "pending") pending = true;
    if (checks !== "failing") continue;
    anyFailing = true;
    const one = failingOf(node, pr.owner, pr.repo, name);
    if (one !== undefined && failing.length < WATCH_FAILING_MAX) failing.push(one);
  }
  if (anyFailing) return { ...base, checks: "fail", failing };
  const total = contexts["totalCount"];
  const complete = typeof total === "number" && total <= nodes.length;
  if (latest.length > 0 && !pending && complete) return { ...base, checks: "pass", failing: [] };
  return { ...base, failing: [] };
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
 * not on the default branch as far as this read can tell: settling on a guess
 * would release dependents on nothing. `landedOnDefault` asks again for those.
 */
function mergedIntoDefault(repository: Record<string, unknown>, pullRequest: Record<string, unknown>): boolean {
  const base = pullRequest["baseRefName"];
  const ref = repository["defaultBranchRef"];
  return typeof base === "string" && isRecord(ref) && ref["name"] === base;
}

const COMMIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

function mergeOidOf(pullRequest: Record<string, unknown>): string | null {
  const commit = pullRequest["mergeCommit"];
  const oid = isRecord(commit) ? commit["oid"] : undefined;
  return typeof oid === "string" && COMMIT_OID.test(oid) ? oid : null;
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

/** A chunk whose open PRs still owe their blocked-state read, with the merge readings and time they were written at. */
interface Owing {
  readonly chunk: readonly Target[];
  readonly reads: readonly Read[];
  readonly wide: readonly Wide[];
  /** The indices a task itself would have read wide: only these write the blocked fields to a task. */
  readonly taskWide: ReadonlySet<number>;
  /** The indices a watch holds: their blocked read also feeds the registry. */
  readonly watched: ReadonlySet<number>;
  readonly at: number;
}

type Chunk =
  | { readonly kind: Failure }
  | {
      readonly kind: "ok";
      readonly reads: readonly Read[];
      readonly wide: readonly Wide[];
      readonly taskWide: ReadonlySet<number>;
    };

/** The poller's own deps: `observe` sees every answer, for the budget and for a `limited` run. */
interface PollDeps extends PrPollerDeps {
  readonly observe: (answer: GhAnswer) => void;
}

/** `askGithub` (`gh.ts`) under the poller's default timeout, each answer shown to `observe` where given. */
async function ask(
  deps: Pick<PrPollerOpts, "gh" | "timeoutMs"> & { readonly observe?: (answer: GhAnswer) => void },
  query: string,
  variables: readonly string[],
): Promise<GhAnswer> {
  const gh = deps.gh === undefined ? {} : { gh: deps.gh };
  const answer = await askGithub({ ...gh, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS }, query, variables);
  deps.observe?.(answer);
  return answer;
}

/**
 * The alias indices of `landings` whose merge commit the default branch
 * contains (`BEHIND` or `IDENTICAL`: the commit is an ancestor of its tip, or
 * is it). A stack merged in cascade lands on the default while each PR's
 * `baseRefName` still names its parent's branch for good, so base names alone
 * would hold such a task in `awaiting-merge` until it expires. Anything else —
 * a failed run, an unanswered alias, `DIVERGED` — keeps the merge stacked.
 */
async function landedOnDefault(deps: PollDeps, landings: readonly Landing[]): Promise<ReadonlySet<number>> {
  const landed = new Set<number>();
  if (landings.length === 0) return landed;
  const answer = await ask(deps, landedQueryText(landings), landedVariables(landings));
  if (answer.kind !== "ok") return landed;
  for (const { index } of landings) {
    const repository = answer.data[`c${index}`];
    const ref = isRecord(repository) ? repository["defaultBranchRef"] : null;
    const compare = isRecord(ref) ? ref["compare"] : null;
    const status = isRecord(compare) ? compare["status"] : null;
    if (status === "BEHIND" || status === "IDENTICAL") landed.add(index);
  }
  return landed;
}

/**
 * The blocked-state fields of `wide`, by alias index, in runs of `BLOCKED_CHUNK`. Never a failure of
 * the poll: a run that fails adds nothing for the PRs it covered, and `onFailure` is told so the poller
 * can say so once; an alias a good run answers `null` adds nothing for its PR, silently. A `limited` run
 * stops the rest unasked (the poller ends the poll `limited` through `observe`) and is no `onFailure`.
 */
async function readBlocked(
  deps: PollDeps,
  wide: readonly Wide[],
  onFailure: (run: readonly Wide[]) => void,
  watched: ReadonlySet<number>,
): Promise<{ readonly fields: ReadonlyMap<number, WideFields>; readonly watch: ReadonlyMap<number, WatchPr> }> {
  const fields = new Map<number, WideFields>();
  const watch = new Map<number, WatchPr>();
  for (let from = 0; from < wide.length; from += BLOCKED_CHUNK) {
    const run = wide.slice(from, from + BLOCKED_CHUNK);
    // oxlint-disable-next-line no-await-in-loop -- runs go one after another, never overlapping
    const answer = await ask(deps, blockedQueryText(run), blockedVariables(run));
    if (answer.kind === "limited") break;
    if (answer.kind !== "ok") {
      onFailure(run);
      continue;
    }
    for (const { index, pr } of run) {
      const repository = answer.data[`b${index}`];
      const pullRequest = isRecord(repository) ? repository["pullRequest"] : null;
      if (!isRecord(pullRequest)) continue;
      fields.set(index, wideOf(pullRequest));
      if (watched.has(index)) watch.set(index, watchPrOf(pullRequest, pr));
    }
  }
  return { fields, watch };
}

/**
 * The alias indices of `failed` whose `FAILURE` rollup reads otherwise on a second look (`rejudgedFailure`), in runs
 * of `BLOCKED_CHUNK`, since it selects contexts as the blocked read does. Never a failure of the poll: a run that
 * fails, or is limited, leaves its PRs `failing`, as their rollup said.
 */
async function rejudgeFailures(deps: PollDeps, failed: readonly Wide[]): Promise<ReadonlyMap<number, PrChecks>> {
  const checks = new Map<number, PrChecks>();
  for (let from = 0; from < failed.length; from += BLOCKED_CHUNK) {
    const run = failed.slice(from, from + BLOCKED_CHUNK);
    // oxlint-disable-next-line no-await-in-loop -- runs go one after another, never overlapping
    const answer = await ask(deps, rejudgeQueryText(run), blockedVariables(run));
    if (answer.kind === "limited") break;
    if (answer.kind !== "ok") continue;
    for (const { index } of run) {
      const repository = answer.data[`f${index}`];
      const pullRequest = isRecord(repository) ? repository["pullRequest"] : null;
      const commit = isRecord(pullRequest) ? commitOf(pullRequest) : undefined;
      const judged = rejudgedFailure(commit === undefined ? undefined : commit["statusCheckRollup"]);
      if (judged !== "failing") checks.set(index, judged);
    }
  }
  return checks;
}

/**
 * One `gh` run over `prs`, and a second over its stacked merges (`landedOnDefault`) when there are any, beside a
 * third over its open or draft PRs whose rollup failed (`rejudgeFailures`).
 * The blocked-state read (`readBlocked`) is the caller's, after every chunk's merge reading is written:
 * its latency must not hold a merge back. `wide` names the open PRs of `wideIndices` that await it.
 */
async function readChunk(
  deps: PollDeps,
  prs: readonly GithubPr[],
  wideIndices: ReadonlySet<number>,
  watchedIndices: ReadonlySet<number>,
): Promise<Chunk> {
  const answer = await ask(deps, queryText(prs.length), prVariables(prs));
  if (answer.kind !== "ok") return answer;
  const { body, data } = answer;
  const reads: Read[] = [];
  const landings: Landing[] = [];
  prs.forEach((pr, i) => {
    const repository = data[`p${i}`];
    const pullRequest = isRecord(repository) ? repository["pullRequest"] : null;
    if (!isRecord(repository) || !isRecord(pullRequest)) {
      reads.push({ kind: "none", error: errorType(body["errors"], i) });
      return;
    }
    const state = stateOf(pullRequest);
    if (state === null) {
      reads.push({ kind: "none", error: null });
      return;
    }
    const checks = checksOf(rollupOf(pullRequest));
    const stacked = state === "merged" && !mergedIntoDefault(repository, pullRequest);
    const oid = stacked ? mergeOidOf(pullRequest) : null;
    if (oid !== null) landings.push({ index: i, pr, oid });
    reads.push({
      kind: "status",
      state,
      ...(checks === undefined ? {} : { checks }),
      ...(stacked ? { stacked: true } : {}),
    });
  });
  const wide: Wide[] = [];
  const taskWide = new Set<number>();
  reads.forEach((read, i) => {
    const pr = prs[i];
    if (pr === undefined || read.kind !== "status") return;
    const forTask = read.state === "open" && wideIndices.has(i);
    if (forTask) taskWide.add(i);
    // CI runs on a draft: a watch on one must see its checks. A task's draft stays unread, as before.
    const forWatch = (read.state === "open" || read.state === "draft") && watchedIndices.has(i);
    if (forTask || forWatch) wide.push({ index: i, pr });
  });
  const failed = reads.flatMap((read, i): Wide[] => {
    const pr = prs[i];
    if (pr === undefined || read.kind !== "status" || read.checks !== "failing") return [];
    return read.state === "open" || read.state === "draft" ? [{ index: i, pr }] : [];
  });
  const [landed, rejudged] = await Promise.all([landedOnDefault(deps, landings), rejudgeFailures(deps, failed)]);
  return {
    kind: "ok",
    reads: reads.map((read, i) => settled(read, rejudged.get(i), landed.has(i))),
    wide,
    taskWide,
  };
}

/** `read` with the second looks' answers: its checks as judged again, and no `stacked` once landed on the default. */
function settled(read: Read, checks: PrChecks | undefined, landed: boolean): Read {
  if (read.kind !== "status") return read;
  const { stacked, ...rest } = read;
  return {
    ...rest,
    ...(checks === undefined ? {} : { checks }),
    ...(stacked === undefined || landed ? {} : { stacked }),
  };
}

/**
 * A finished task is read once a term: `read` holds those already read, `unreadable` the PRs the
 * forge would not answer. Its chip is not worth a read a minute, and an abandoned open PR would
 * otherwise be read for as long as the store keeps the task.
 *
 * Every PR of a task is read, newest first: a newer one read closed moves the task to an older
 * (`prChange`), whose reading then lands in the same poll — the writes keep this order, and a
 * finished task gets no second poll this term. Two tasks sharing a PR can put an older one first;
 * the next poll catches it up.
 */
function targets(tasks: readonly Task[], unreadable: ReadonlySet<string>, read: ReadonlySet<string>): Target[] {
  const byKey = new Map<string, Target>();
  for (const task of tasks) {
    if (!wantsPrReading(task)) continue;
    // Not `!isPrReadable`: a successor waiting for its predecessor is neither, and is read every poll.
    const finished = TASK_PHASES[task.state] === "finished";
    if (finished && read.has(task.id)) continue;
    for (const { url } of taskPrs(task).toReversed()) {
      if (finished && unreadable.has(url)) continue;
      const pr = parseGithubPr(url);
      if (pr === null) continue;
      // GitHub names are case-insensitive: two spellings are one PR.
      const key = `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase();
      const known = byKey.get(key);
      const wide = url === task.prUrl && task.state === "awaiting-merge" && task.spec.until !== "reported";
      const entry = { id: task.id, prUrl: url, finished, wide };
      if (known === undefined) byKey.set(key, { pr, tasks: [entry] });
      else known.tasks.push(entry);
    }
  }
  return [...byKey.values()];
}

const prKeyOf = (pr: GithubPr): string => `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase();

/**
 * Splits the registry's wanted PRs over the tasks' targets: one a task holds is marked (`watchKey`) and stays in the
 * task chunks, sharing their aliases; the rest, in the registry's order, are watch-only, read after every task read so
 * a watch never delays or fails one. The task list's order and content are otherwise unchanged. `mergeOnly` (the
 * reserve) marks those PRs for their merge reading alone: the task chunk's own read, no blocked read for the watch.
 */
function withWatches(
  tasks: readonly Target[],
  watched: readonly WatchedPr[],
  mergeOnly: boolean,
): { readonly tasks: readonly Target[]; readonly watchOnly: readonly Target[] } {
  const keys = new Map(watched.map((w) => [prKeyOf(w.pr), w.key]));
  const held = new Set<string>();
  const marked = tasks.map((target): Target => {
    const key = prKeyOf(target.pr);
    held.add(key);
    const watchKey = keys.get(key);
    if (watchKey === undefined) return target;
    return { ...target, watchKey, ...(mergeOnly ? { watchMergeOnly: true as const } : {}) };
  });
  const watchOnly = watched
    .filter((w) => !held.has(prKeyOf(w.pr)))
    .map((w): Target => ({ pr: w.pr, tasks: [], watchKey: w.key }));
  return { tasks: marked, watchOnly };
}

/**
 * What a chunk's merge reads tell the registry of each watched PR. An open or draft PR is told nothing yet: its head
 * and checks come from the blocked read, and one whose blocked read fails is a PR not read (it goes unread, and the
 * registry suspends it), never a reading with nothing in it.
 */
function recordMerges(chunk: readonly Target[], reads: readonly Read[], readings: Map<string, PrReading>): void {
  chunk.forEach((target, i) => {
    const read = reads[i];
    if (target.watchKey === undefined || read === undefined) return;
    if (read.kind === "none") {
      if (read.error !== null) readings.set(target.watchKey, { kind: "unreadable" });
      return;
    }
    if (read.state === "merged") readings.set(target.watchKey, { kind: "merged", stacked: read.stacked === true });
    else if (read.state === "closed") readings.set(target.watchKey, { kind: "closed" });
  });
}

/** The registry's reading of an open or draft PR from its blocked read. */
function openReading(watch: WatchPr): PrReading {
  return {
    kind: "open",
    conflict: watch.conflict,
    failing: watch.failing,
    ...(watch.head === undefined ? {} : { head: watch.head }),
    ...(watch.checks === undefined ? {} : { checks: watch.checks }),
  };
}

function runReadingOf(resource: unknown, run: GithubRun): RunReading {
  if (!isRecord(resource) || typeof resource["databaseId"] !== "number") return { kind: "unreadable" };
  const suite = resource["checkSuite"];
  if (!isRecord(suite)) return { kind: "unreadable" };
  if (suite["status"] !== "COMPLETED") return { kind: "running" };
  const attempt = resource["runAttempt"];
  const lower = typeof suite["conclusion"] === "string" ? suite["conclusion"].toLowerCase() : "";
  const conclusion: WatchConclusion | undefined = WATCH_CONCLUSIONS.find((c) => c === lower);
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1 || conclusion === undefined) {
    return { kind: "running" };
  }
  const checkRuns = suite["checkRuns"];
  const nodes = isRecord(checkRuns) ? checkRuns["nodes"] : undefined;
  const failing: WatchFailing[] = [];
  if (Array.isArray(nodes)) {
    for (const node of latestRuns(nodes, nameKey)) {
      if (conclusionOf(node["conclusion"]) !== "failing" || failing.length >= WATCH_FAILING_MAX) continue;
      const one = failingOf(node, run.owner, run.repo, node["name"]);
      if (one !== undefined) failing.push(one);
    }
  }
  return { kind: "completed", attempt, conclusion, failing };
}

/**
 * The watched runs, `RUN_CHUNK` to a query. A `limited` answer stops the rest. Any other failed chunk leaves its runs
 * unread this poll and is no poll failure: a broken run read must not back off the tasks' PR reads, and the registry
 * suspends what stays unread. Logs nothing: a run's URL is a session's word.
 */
async function readRuns(
  deps: PollDeps,
  runs: readonly WatchedRun[],
  readings: Map<string, RunReading>,
): Promise<"ok" | "limited"> {
  for (let from = 0; from < runs.length; from += RUN_CHUNK) {
    const chunk = runs.slice(from, from + RUN_CHUNK);
    // oxlint-disable-next-line no-await-in-loop -- chunks go one after another, never overlapping
    const answer = await ask(deps, runQueryText(chunk.length), runVariables(chunk));
    if (answer.kind === "limited") return "limited";
    if (answer.kind !== "ok") continue;
    chunk.forEach(({ key, run }, i) => readings.set(key, runReadingOf(answer.data[`w${i}`], run)));
  }
  return "ok";
}

/**
 * Polls on a timer chain — one poll at a time — starting now. A failing poll
 * (no `gh`, not logged in, a timeout, garbage) writes nothing, warns once on
 * entering that class, and backs the next poll off from `intervalMs` toward
 * `maxBackoffMs`; the first good poll after one says so once. A `limited` poll
 * (GitHub's rate limit, in any of its runs) asks nothing more, keeps what it
 * wrote, and waits for the budget's reset (`limitedDelay`) instead, on the
 * ladder only when no reset is known. `stop` also drops an in-flight poll's
 * results, so a term's end never writes after it.
 */
export function startPrPoller(deps: PrPollerDeps): { readonly stop: () => void } {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxBackoffMs = deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const random = deps.random ?? Math.random;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** A poll is in flight: the clock suspends no watch meanwhile, since its end reads them. */
  let polling = false;
  let clock: ReturnType<typeof setInterval> | null = null;
  let state: "ok" | Failure = "ok";
  let failures = 0;
  const unreadable = new Set<string>();
  const readThisTerm = new Set<string>();
  let blockedFailed = false;
  // The newest in-query reading this term; docs/gh-watch.md W8's reserve for tasks reads `remaining`.
  let budget: GraphqlBudget | null = null;
  /** The reserve for tasks holds: watched targets are not read until the budget recovers. */
  let reserveHeld = false;
  // Set by any run of the poll in flight that GitHub refused for its rate limit.
  let limited = false;
  /** The current `limited` stay has warned with a reset time. */
  let parked = false;
  const pollDeps: PollDeps = {
    ...deps,
    observe: (answer) => {
      if (answer.kind === "limited") limited = true;
      if (answer.kind !== "ok") return;
      const reading = budgetOf(answer.data);
      if (reading !== null) budget = reading;
    },
  };

  /** Once a term, and without a URL: a repo whose blocked read always times out would otherwise warn every poll. */
  const blockedFailure = (): void => {
    if (blockedFailed) return;
    blockedFailed = true;
    deps.log.warn("pr-status: the blocked-state read did not answer; blocked reasons are unavailable until it does");
  };

  /**
   * The reset a `limited` poll waits for: this term's in-query `resetAt`, else the rate reader's, the first one
   * ahead and inside the window; failing that the window's end (a local clock behind GitHub's reads a fresh
   * window's reset as further off than it is, and the ladder would ask the empty budget again).
   */
  const resetAt = (now: number): number | null => {
    const ahead = [budget?.resetAt ?? null, deps.graphqlReset?.() ?? null].filter(
      (at): at is number => at !== null && at > now,
    );
    const cap = now + MAX_RESET_AHEAD_MS;
    const inside = ahead.find((at) => at <= cap);
    if (inside !== undefined) return inside;
    return ahead.length > 0 ? cap : null;
  };

  /** `wait` is the reset a `limited` class waits for, when one is known; never `gh`'s words. */
  const enter = (next: "ok" | Failure, wait: number | null): void => {
    const timed = next === "limited" && wait !== null;
    // A limited stay that first learns its reset says so, once: the owner is told the poller is now parked.
    if (next === state && !(timed && !parked)) return;
    state = next;
    parked = timed;
    if (next === "ok") deps.log.info("pr-status: gh answers again — PR status resumed");
    else if (timed) {
      deps.log.warn(`pr-status: ${REMEDY[next]}; PR status paused until ${new Date(wait).toISOString()} (${next})`);
    } else deps.log.warn(`pr-status: ${REMEDY[next]}; PR status paused (${next})`);
  };

  /** The writes for one PR's reading, one per task read on it; `fields` is its blocked state, where read. */
  const write = (target: Target, read: Read, at: number, fields: WideFields | undefined): Promise<void>[] => {
    if (read.kind !== "status") return [];
    const base: PrStatus = {
      state: read.state,
      ...(read.checks === undefined ? {} : { checks: read.checks }),
      ...(read.stacked === undefined ? {} : { stacked: read.stacked }),
      at,
    };
    const wide: PrStatus = fields === undefined ? base : { ...base, ...fields };
    return target.tasks.map((task) => deps.onStatus(task.id, task.prUrl, task.wide ? wide : base));
  };

  /** The writes for one owed chunk's open PRs; without `fields` they carry the base reading only. */
  const owed = (
    { chunk, reads, wide, taskWide, at }: Owing,
    fields: ReadonlyMap<number, WideFields> | undefined,
  ): Promise<void>[] =>
    wide.flatMap(({ index }) => {
      const target = chunk[index];
      const read = reads[index];
      if (target === undefined || read === undefined) return [];
      // A watch never changes a task's record: only an index the task itself would have read wide carries the fields.
      return write(target, read, at, taskWide.has(index) ? fields?.get(index) : undefined);
    });

  /**
   * The class the poll ended in, or null when there was nothing to poll. Open PRs owed a blocked-state read are
   * pushed on `owing`: it runs once every chunk's merge reading is written, so a slow or stalled one delays only
   * the chip fields it adds, never a merge (or the dependents it releases).
   */
  async function readAll(
    wanted: readonly Target[],
    owing: Owing[],
    prReadings: Map<string, PrReading>,
  ): Promise<"ok" | Failure | null> {
    // A finished task's read is spent only once every chunk answered: its PRs may sit in several.
    const spent = new Set<string>();
    for (let from = 0; from < wanted.length; from += CHUNK) {
      const chunk = wanted.slice(from, from + CHUNK);
      const watched = new Set(
        chunk.flatMap((target, i) => (target.watchKey === undefined || target.watchMergeOnly === true ? [] : [i])),
      );
      // oxlint-disable-next-line no-await-in-loop -- chunks run one after another, never overlapping
      const answer = await readChunk(
        pollDeps,
        chunk.map((target) => target.pr),
        new Set(chunk.flatMap((target, i) => (target.tasks.some((task) => task.wide) ? [i] : []))),
        watched,
      );
      if (stopped) return null;
      if (answer.kind !== "ok") return answer.kind;
      const at = deps.now();
      recordMerges(chunk, answer.reads, prReadings);
      const waiting = new Set(answer.wide.map(({ index }) => index));
      if (waiting.size > 0) {
        owing.push({ chunk, reads: answer.reads, wide: answer.wide, taskWide: answer.taskWide, watched, at });
      }
      const writes: Promise<void>[] = [];
      chunk.forEach((target, i) => {
        const read = answer.reads[i];
        if (read === undefined) return;
        // Any answer spends a finished task's read, an unusable one too: else it is asked every poll.
        // Only a task finished when targeted: one read while placed still owes its finished read.
        for (const task of target.tasks) if (task.finished) spent.add(task.id);
        if (read.kind === "none") {
          const url = target.tasks[0]?.prUrl;
          if (read.error !== null && url !== undefined && !unreadable.has(url)) {
            unreadable.add(url);
            deps.log.warn(`pr-status: ${quote(url)} is not readable (${read.error})`);
          }
          return;
        }
        if (!waiting.has(i)) writes.push(...write(target, read, at, undefined));
      });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await Promise.all(writes);
      if (stopped) return null;
      // A limited landed check: the chunk's merges are written, and nothing more is asked this poll.
      if (limited) return "limited";
    }
    for (const id of spent) readThisTerm.add(id);
    for (let next = owing[0]; next !== undefined; next = owing[0]) {
      // Only a run that held a PR a task needed wide is the task-facing warning's: a watch's read owes a task nothing.
      const needed = next.taskWide;
      // oxlint-disable-next-line no-await-in-loop -- as above
      const { fields, watch } = await readBlocked(
        pollDeps,
        next.wide,
        (failed) => {
          if (failed.some(({ index }) => needed.has(index))) blockedFailure();
        },
        next.watched,
      );
      if (stopped) return null;
      for (const [index, reading] of watch) {
        const key = next.chunk[index]?.watchKey;
        if (key !== undefined) prReadings.set(key, openReading(reading));
      }
      // Off `owing` before its write: `poll`'s flush must not retry a rejected one, which could overwrite a
      // sibling that landed with its fields.
      owing.shift();
      // oxlint-disable-next-line no-await-in-loop -- as above
      await Promise.all(owed(next, fields));
      if (stopped) return null;
      // The owed chunks after it go out with their base reading (`poll`'s flush).
      if (limited) return "limited";
    }
    return "ok";
  }

  /**
   * The PRs only a watch holds, after every task chunk and every task's blocked read. A failed slice (anything but
   * `limited`) is skipped: it calls no `enter` and no `blockedFailure`, owes nothing to a task and logs nothing, so no
   * class or backoff changes; the registry suspends those watches once they stay unread. `limited` is the token's
   * budget, so nothing more is asked this poll. Null when stopped.
   */
  async function readWatchOnly(
    watchOnly: readonly Target[],
    prReadings: Map<string, PrReading>,
  ): Promise<"ok" | "limited" | null> {
    for (let from = 0; from < watchOnly.length; from += CHUNK) {
      const slice = watchOnly.slice(from, from + CHUNK);
      const all = new Set(slice.map((_target, i) => i));
      // oxlint-disable-next-line no-await-in-loop -- slices go one after another, never overlapping
      const answer = await readChunk(
        pollDeps,
        slice.map((target) => target.pr),
        new Set(),
        all,
      );
      if (stopped) return null;
      if (answer.kind === "limited") return "limited";
      if (answer.kind !== "ok") continue;
      recordMerges(slice, answer.reads, prReadings);
      // oxlint-disable-next-line no-await-in-loop -- as above
      const { watch } = await readBlocked(pollDeps, answer.wide, () => undefined, all);
      if (stopped) return null;
      for (const [index, reading] of watch) {
        const key = slice[index]?.watchKey;
        if (key !== undefined) prReadings.set(key, openReading(reading));
      }
      if (limited) return "limited";
    }
    return "ok";
  }

  /** Logs the reserve once per stay, without a URL: the poller's class changes are the only thing a watch may log. */
  const noteReserve = (held: boolean): void => {
    if (deps.watches === undefined || held === reserveHeld) return;
    reserveHeld = held;
    if (held && budget !== null) {
      deps.log.warn(
        `pr-status: GitHub's GraphQL budget is under ${WATCH_RESERVE_POINTS} points; watched targets wait until ${new Date(budget.resetAt).toISOString()} (reserve)`,
      );
    } else if (!held) deps.log.info("pr-status: GitHub's budget recovered — watched targets resumed");
  };

  /** The class the poll ended in, or null when there was nothing to poll. */
  async function poll(): Promise<"ok" | Failure | null> {
    limited = false;
    const now = deps.now();
    const reserve =
      deps.watches !== undefined && budget !== null && budget.remaining < WATCH_RESERVE_POINTS && now < budget.resetAt;
    noteReserve(reserve);
    const wantedWatches = deps.watches?.wanted(now) ?? { prs: [], runs: [] };
    // Under the reserve a watch on a PR a task reads takes that merge reading, and nothing else is asked for it.
    const watched = reserve ? { prs: wantedWatches.prs, runs: [] } : wantedWatches;
    const { tasks: wanted, watchOnly: allWatchOnly } = withWatches(
      targets(deps.tasks(), unreadable, readThisTerm),
      watched.prs,
      reserve,
    );
    const watchOnly = reserve ? [] : allWatchOnly;
    if (wanted.length === 0 && watchOnly.length === 0 && watched.runs.length === 0) return null;
    const owing: Owing[] = [];
    const prReadings = new Map<string, PrReading>();
    const runReadings = new Map<string, RunReading>();
    try {
      const outcome = await readAll(wanted, owing, prReadings);
      if (outcome !== "ok") return outcome;
      if (watchOnly.length > 0) {
        const read = await readWatchOnly(watchOnly, prReadings);
        if (read === null) return null;
        if (read === "limited") return "limited";
      }
      if (watched.runs.length > 0) {
        const read = await readRuns(pollDeps, watched.runs, runReadings);
        if (stopped) return null;
        if (read === "limited" || limited) return "limited";
      }
      return "ok";
    } finally {
      // A later chunk's failure or a rejected write must not take an earlier chunk's open readings with it: they go
      // out as the base reading, as before blocked state existed, and the blocked fields wait for the next poll.
      if (!stopped) await Promise.allSettled(owing.flatMap((entry) => owed(entry, undefined)));
      // Whatever was read, a partial poll's included: a watch is judged on its own readings.
      if (!stopped) deps.watches?.read({ prs: prReadings, runs: runReadings }, deps.now());
    }
  }

  /** Why a watch unread for two intervals is suspended: the poller's class, else the reserve, else a read that failed. */
  const suspendReason = (): WatchSuspendReason => {
    if (state !== "ok") return state;
    return reserveHeld ? "reserve" : "failed";
  };

  const suspendReset = (): number | null => {
    if (state === "limited") return resetAt(deps.now());
    return state === "ok" && reserveHeld ? (budget?.resetAt ?? null) : null;
  };

  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void run(), delay);
  };

  async function run(): Promise<void> {
    timer = null;
    let outcome: "ok" | Failure | null;
    polling = true;
    try {
      outcome = await poll();
    } catch {
      // A rejected write is the caller's to report (`leader.ts` does), and says nothing of gh; a limit seen
      // before it is still one.
      outcome = limited ? "limited" : null;
    } finally {
      polling = false;
    }
    if (stopped) return;
    if (outcome === null) {
      schedule(intervalMs);
      return;
    }
    const now = deps.now();
    const reset = outcome === "limited" ? resetAt(now) : null;
    const wait = limitedDelay(reset, now, random());
    enter(outcome, wait === null ? null : reset);
    // A wait for a reset is no rung of the ladder: a failure after it starts from the bottom.
    failures = outcome === "ok" || wait !== null ? 0 : failures + 1;
    if (wait !== null) {
      schedule(wait);
      return;
    }
    schedule(outcome === "ok" ? intervalMs : Math.min(intervalMs * 2 ** failures, maxBackoffMs));
  }

  void run();
  // Its own clock: a `limited` wait parks the poll chain for up to an hour, and a suspension must still go out.
  if (deps.watches !== undefined) {
    clock = setInterval(() => deps.watches?.tick(deps.now(), suspendReason(), suspendReset(), polling), intervalMs);
  }
  return {
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (clock !== null) clearInterval(clock);
      clock = null;
    },
  };
}

/** A pass reads one PR's head once, at the moment it asks: bounded well under the scheduler's 15 s window. */
const PR_HEAD_TIMEOUT_MS = 15_000;

const PR_HEAD_QUERY =
  "query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){ headRefName isCrossRepository state isDraft } } }";

/**
 * The head branch of a task's PR, read by the leader's own `gh` for a pass (DESIGN.md, "Passing to a successor"):
 * the one value the daemon holding the task compares its branch against, so a session's reported URL never decides
 * where a push goes. Owner, repo and number reach `gh` as variables, as in the poll. Logs nothing: the head is the
 * user's own text, and the URL names a repo. `skipped` for a URL that is not a GitHub pull request.
 */
export async function readPrHead(prUrl: string, opts: PrPollerOpts = {}): Promise<PrHeadReading> {
  const pr = parseGithubPr(prUrl);
  if (pr === null) return { kind: "skipped" };
  // Never past the pass's budget, whatever timeout the poller was given.
  const timeoutMs = Math.min(opts.timeoutMs ?? PR_HEAD_TIMEOUT_MS, PR_HEAD_TIMEOUT_MS);
  const answer = await ask({ ...opts, timeoutMs }, PR_HEAD_QUERY, [
    "-f",
    `o=${pr.owner}`,
    "-f",
    `r=${pr.repo}`,
    "-F",
    `n=${pr.number}`,
  ]);
  if (answer.kind !== "ok") return { kind: "unreadable" };
  const repository = answer.data["repository"];
  const pullRequest = isRecord(repository) ? repository["pullRequest"] : undefined;
  if (!isRecord(pullRequest)) return { kind: "unreadable" };
  const { headRefName, isCrossRepository } = pullRequest;
  const state = stateOf(pullRequest);
  if (!isBranchName(headRefName) || typeof isCrossRepository !== "boolean" || state === null) {
    return { kind: "unreadable" };
  }
  return { kind: "read", head: headRefName, crossRepository: isCrossRepository, state };
}
