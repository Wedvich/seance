import {
  isPrReadable,
  isRecord,
  PR_FAILING_LIMITS,
  PR_MERGE_STATES,
  quote,
  type PrChecks,
  type PrMergeState,
  type PrState,
  type PrStatus,
  type Task,
  taskPrs,
  wantsPrReading,
} from "@seance/shared";
import { exec } from "./exec.ts";

/**
 * Live PR status from the scheduler leader (DESIGN.md, "PR status"): one
 * batched GraphQL read per poll, through the operator's own `gh`, of every PR
 * (`taskPrs`) of every task `wantsPrReading` names. Runs only on the leader (`leader.ts` starts it
 * after takeover and stops it with the term) and is never reachable from
 * `seanced mcp`, whose stdout is its JSON-RPC channel — hence `log` is passed
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
/**
 * The blocked-state selection measured 3-8 s on a 50-PR chunk against 1-2 s for the merge query, and
 * GitHub cuts a query off at about 10 s, so these run 10 at a time.
 */
const BLOCKED_CHUNK = 10;
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
  readonly tasks: {
    readonly id: string;
    readonly prUrl: string;
    readonly finished: boolean;
    /** Primary PR of an `awaiting-merge` task not under `until: "reported"`: the only one `taskPrBlock` can name. */
    readonly wide: boolean;
  }[];
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
  return `query(${vars}){ ${reads} }`;
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
  return `query(${vars}){ ${reads} }`;
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
        `b${i}: repository(owner:$o${i},name:$r${i}){ pullRequest(number:$n${i}){ mergeStateStatus isInMergeQueue autoMergeRequest{ enabledAt } reviewRequests{ totalCount } commits(last:1){ nodes{ commit{ oid statusCheckRollup{ contexts(first:50){ nodes{ __typename ... on CheckRun{ name status conclusion isRequired(pullRequestNumber:$n${i}) } ... on StatusContext{ context state isRequired(pullRequestNumber:$n${i}) } } } } } } } } }`,
    )
    .join(" ");
  return `query(${vars}){ ${reads} }`;
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
  switch (node["conclusion"]) {
    case "SUCCESS":
    case "NEUTRAL":
    case "SKIPPED":
      return { checks: "passing", name: node["name"] };
    case "FAILURE":
    case "TIMED_OUT":
    case "CANCELLED":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return { checks: "failing", name: node["name"] };
    default:
      return { checks: "pending", name: node["name"] };
  }
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
  for (const node of nodes) {
    if (!isRecord(node) || node["isRequired"] !== true) continue;
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

/** A chunk whose open PRs still owe their blocked-state read, with the merge readings and time they were written at. */
interface Owing {
  readonly chunk: readonly Target[];
  readonly reads: readonly Read[];
  readonly wide: readonly Wide[];
  readonly at: number;
}

type Chunk =
  | { readonly kind: Failure }
  | { readonly kind: "ok"; readonly reads: readonly Read[]; readonly wide: readonly Wide[] };

type Answer =
  | { readonly kind: Failure }
  | { readonly kind: "ok"; readonly body: Record<string, unknown>; readonly data: Record<string, unknown> };

/**
 * One `gh` GraphQL run. A PR the forge does not answer for (not found, no
 * access) makes `gh` exit 1 with the full JSON on stdout and `null` at its
 * alias, so a non-zero exit is not a failure by itself — only exit 4, a
 * timeout, or stdout that is no GraphQL answer is.
 */
async function ask(deps: PrPollerDeps, query: string, variables: readonly string[]): Promise<Answer> {
  const gh = deps.gh ?? process.env["SEANCE_GH_BIN"] ?? "gh";
  let result;
  try {
    result = await exec([gh, "api", "--hostname", "github.com", "graphql", "-f", `query=${query}`, ...variables], {
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
  return { kind: "ok", body, data };
}

/**
 * The alias indices of `landings` whose merge commit the default branch
 * contains (`BEHIND` or `IDENTICAL`: the commit is an ancestor of its tip, or
 * is it). A stack merged in cascade lands on the default while each PR's
 * `baseRefName` still names its parent's branch for good, so base names alone
 * would hold such a task in `awaiting-merge` until it expires. Anything else —
 * a failed run, an unanswered alias, `DIVERGED` — keeps the merge stacked.
 */
async function landedOnDefault(deps: PrPollerDeps, landings: readonly Landing[]): Promise<ReadonlySet<number>> {
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
 * can say so once; an alias a good run answers `null` adds nothing for its PR, silently.
 */
async function readBlocked(
  deps: PrPollerDeps,
  wide: readonly Wide[],
  onFailure: () => void,
): Promise<ReadonlyMap<number, WideFields>> {
  const fields = new Map<number, WideFields>();
  for (let from = 0; from < wide.length; from += BLOCKED_CHUNK) {
    const run = wide.slice(from, from + BLOCKED_CHUNK);
    // oxlint-disable-next-line no-await-in-loop -- runs go one after another, never overlapping
    const answer = await ask(deps, blockedQueryText(run), blockedVariables(run));
    if (answer.kind !== "ok") {
      onFailure();
      continue;
    }
    for (const { index } of run) {
      const repository = answer.data[`b${index}`];
      const pullRequest = isRecord(repository) ? repository["pullRequest"] : null;
      if (isRecord(pullRequest)) fields.set(index, wideOf(pullRequest));
    }
  }
  return fields;
}

/**
 * One `gh` run over `prs`, and a second over its stacked merges (`landedOnDefault`) when there are any.
 * The blocked-state read (`readBlocked`) is the caller's, after every chunk's merge reading is written:
 * its latency must not hold a merge back. `wide` names the open PRs of `wideIndices` that await it.
 */
async function readChunk(
  deps: PrPollerDeps,
  prs: readonly GithubPr[],
  wideIndices: ReadonlySet<number>,
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
  reads.forEach((read, i) => {
    const pr = prs[i];
    if (pr !== undefined && wideIndices.has(i) && read.kind === "status" && read.state === "open") {
      wide.push({ index: i, pr });
    }
  });
  const landed = await landedOnDefault(deps, landings);
  return {
    kind: "ok",
    reads: reads.map((read, i) => {
      if (read.kind !== "status" || !landed.has(i)) return read;
      const { stacked: _stacked, ...rest } = read;
      return rest;
    }),
    wide,
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
    const finished = !isPrReadable(task.state);
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
  let blockedFailed = false;

  /** Once a term, and without a URL: a repo whose blocked read always times out would otherwise warn every poll. */
  const blockedFailure = (): void => {
    if (blockedFailed) return;
    blockedFailed = true;
    deps.log.warn("pr-status: the blocked-state read did not answer; blocked reasons are unavailable until it does");
  };

  const enter = (next: "ok" | Failure): void => {
    if (next === state) return;
    state = next;
    if (next === "ok") deps.log.info("pr-status: gh answers again — PR status resumed");
    else deps.log.warn(`pr-status: ${REMEDY[next]}; PR status paused (${next})`);
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
    { chunk, reads, wide, at }: Owing,
    fields: ReadonlyMap<number, WideFields> | undefined,
  ): Promise<void>[] =>
    wide.flatMap(({ index }) => {
      const target = chunk[index];
      const read = reads[index];
      return target === undefined || read === undefined ? [] : write(target, read, at, fields?.get(index));
    });

  /**
   * The class the poll ended in, or null when there was nothing to poll. Open PRs owed a blocked-state read are
   * pushed on `owing`: it runs once every chunk's merge reading is written, so a slow or stalled one delays only
   * the chip fields it adds, never a merge (or the dependents it releases).
   */
  async function readAll(wanted: readonly Target[], owing: Owing[]): Promise<"ok" | Failure | null> {
    // A finished task's read is spent only once every chunk answered: its PRs may sit in several.
    const spent = new Set<string>();
    for (let from = 0; from < wanted.length; from += CHUNK) {
      const chunk = wanted.slice(from, from + CHUNK);
      // oxlint-disable-next-line no-await-in-loop -- chunks run one after another, never overlapping
      const answer = await readChunk(
        deps,
        chunk.map((target) => target.pr),
        new Set(chunk.flatMap((target, i) => (target.tasks.some((task) => task.wide) ? [i] : []))),
      );
      if (stopped) return null;
      if (answer.kind !== "ok") return answer.kind;
      const at = deps.now();
      const waiting = new Set(answer.wide.map(({ index }) => index));
      if (waiting.size > 0) owing.push({ chunk, reads: answer.reads, wide: answer.wide, at });
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
    }
    for (const id of spent) readThisTerm.add(id);
    for (let next = owing[0]; next !== undefined; next = owing[0]) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      const fields = await readBlocked(deps, next.wide, blockedFailure);
      if (stopped) return null;
      // Off `owing` before its write: `poll`'s flush must not retry a rejected one, which could overwrite a
      // sibling that landed with its fields.
      owing.shift();
      // oxlint-disable-next-line no-await-in-loop -- as above
      await Promise.all(owed(next, fields));
      if (stopped) return null;
    }
    return "ok";
  }

  /** The class the poll ended in, or null when there was nothing to poll. */
  async function poll(): Promise<"ok" | Failure | null> {
    const wanted = targets(deps.tasks(), unreadable, readThisTerm);
    if (wanted.length === 0) return null;
    const owing: Owing[] = [];
    try {
      return await readAll(wanted, owing);
    } finally {
      // A later chunk's failure or a rejected write must not take an earlier chunk's open readings with it: they go
      // out as the base reading, as before blocked state existed, and the blocked fields wait for the next poll.
      if (!stopped) await Promise.allSettled(owing.flatMap((entry) => owed(entry, undefined)));
    }
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
