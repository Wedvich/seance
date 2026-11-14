import { isRecord } from "@seance/shared";
import type { PrCheckView, PrView } from "./custodian-frame.ts";
import { askGithub } from "./gh.ts";
import { parseGithubPr } from "./pr-status.ts";

/**
 * The daemon's side of the round's `pr` verb (docs/custodian.md item 4b; DESIGN.md, "The custodian's seat"): one
 * read of a PR through the daemon's own `gh` (`askGithub`), because the round has no network and no `gh` credential.
 * The query is constant and owner, name and number go in as variables. Nothing here logs: the URL names a repo, and
 * `gh`'s stderr can carry a token's tail. What it returns is state and check results, never a title, body or comment.
 */

const PR_QUERY =
  "query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){ state isDraft mergeable reviewDecision autoMergeRequest{ enabledAt } commits(last:1){ nodes{ commit{ statusCheckRollup{ state contexts(first:50){ nodes{ __typename ... on CheckRun{ name status conclusion } ... on StatusContext{ context state } } } } } } } } } }";

const READ_TIMEOUT_MS = 15_000;
export const PR_CACHE_TTL_MS = 60_000;
export const PR_CACHE_MAX = 64;

const nullableString = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === "string" ? value : undefined;

function contextOf(node: unknown): PrCheckView | null {
  if (!isRecord(node)) return null;
  if (node["__typename"] === "CheckRun") {
    const { name } = node;
    const status = nullableString(node["status"]);
    const conclusion = nullableString(node["conclusion"]);
    return typeof name === "string" && status !== undefined && conclusion !== undefined
      ? { name, status, conclusion }
      : null;
  }
  // A commit status has no run state: its own state is the conclusion.
  const { context, state } = node;
  return node["__typename"] === "StatusContext" && typeof context === "string" && typeof state === "string"
    ? { name: context, status: null, conclusion: state }
    : null;
}

/** The rollup of the PR's last commit; no commit or no rollup (no checks configured) is an empty one. */
function checksOf(pullRequest: Record<string, unknown>): PrView["checks"] | null {
  const commits = pullRequest["commits"];
  const nodes = isRecord(commits) ? commits["nodes"] : undefined;
  if (!Array.isArray(nodes)) return null;
  const commit = isRecord(nodes[0]) ? nodes[0]["commit"] : undefined;
  const rollup = isRecord(commit) ? commit["statusCheckRollup"] : undefined;
  if (rollup === null || rollup === undefined) return { state: null, contexts: [] };
  if (!isRecord(rollup)) return null;
  const state = nullableString(rollup["state"]);
  const contexts = rollup["contexts"];
  const list = isRecord(contexts) ? contexts["nodes"] : undefined;
  if (state === undefined || !Array.isArray(list)) return null;
  const views: PrCheckView[] = [];
  for (const node of list) {
    const view = contextOf(node);
    if (view === null) return null;
    views.push(view);
  }
  return { state, contexts: views };
}

/** Null for anything not the shape asked for: a PR the token cannot see answers `null` at the alias. */
function viewOf(data: Record<string, unknown>, readAt: number): PrView | null {
  const repository = data["repository"];
  const pullRequest = isRecord(repository) ? repository["pullRequest"] : undefined;
  if (!isRecord(pullRequest)) return null;
  const { state, isDraft } = pullRequest;
  const mergeable = nullableString(pullRequest["mergeable"]);
  const reviewDecision = nullableString(pullRequest["reviewDecision"]);
  const checks = checksOf(pullRequest);
  if (
    typeof state !== "string" ||
    typeof isDraft !== "boolean" ||
    mergeable === undefined ||
    reviewDecision === undefined ||
    checks === null
  ) {
    return null;
  }
  return {
    state,
    isDraft,
    mergeable,
    reviewDecision,
    autoMerge: isRecord(pullRequest["autoMergeRequest"]),
    checks,
    readAt,
  };
}

export interface PrReaderDeps {
  /** The `gh` boundary; `askGithub` unless a test passes its own. */
  readonly ask?: typeof askGithub;
  readonly now: () => number;
  readonly ttlMs?: number;
}

/**
 * A reader of one PR by URL, cached per URL for `ttlMs` (a round asks about the same PR several times and `gh` is a
 * network call), at most `PR_CACHE_MAX` entries, the oldest dropped. `"unreadable"` is never cached.
 */
export function createPrReader(deps: PrReaderDeps): (url: string) => Promise<PrView | "unreadable"> {
  const ask = deps.ask ?? askGithub;
  const ttlMs = deps.ttlMs ?? PR_CACHE_TTL_MS;
  const cache = new Map<string, { readonly at: number; readonly view: PrView }>();
  return async (url) => {
    const pr = parseGithubPr(url);
    if (pr === null) return "unreadable";
    const cached = cache.get(url);
    if (cached !== undefined && deps.now() - cached.at < ttlMs) return cached.view;
    const answer = await ask({ timeoutMs: READ_TIMEOUT_MS }, PR_QUERY, [
      "-f",
      `o=${pr.owner}`,
      "-f",
      `r=${pr.repo}`,
      "-F",
      `n=${pr.number}`,
    ]);
    if (answer.kind !== "ok") return "unreadable";
    const at = deps.now();
    const view = viewOf(answer.data, at);
    if (view === null) return "unreadable";
    cache.delete(url);
    cache.set(url, { at, view });
    const oldest = cache.keys().next();
    if (cache.size > PR_CACHE_MAX && !oldest.done) cache.delete(oldest.value);
    return view;
  };
}
