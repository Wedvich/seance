import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGithubPr, parseWatchSet, quote, type PrStatus, type WatchEvent } from "@seance/shared";
import type { Task } from "../src/leader.ts";
import { LIMIT_JITTER_MS, limitedDelay, readPrHead, startPrPoller, type PrPollerOpts } from "../src/pr-status.ts";
import { createWatchRegistry, type PollerWatches } from "../src/watch-registry.ts";
import { makeGhStub, pollUntil, type GhRun, type GhStub } from "./fixtures.ts";

let base: string;
let stub: GhStub;
let gh: GhRun;
const stops: (() => void)[] = [];

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-pr-status-"));
  stub = await makeGhStub(base);
});

beforeEach(async () => {
  gh = await stub.fresh();
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

// Names that cannot appear in the query text by accident ("app" could).
const prUrl = (n: number): string => `https://github.com/octo-org/widgets/pull/${n}`;

function pr(n: number, fields: Partial<Task> = {}): Task {
  return {
    id: `t${n}`,
    spec: { repo: "github.com/octo-org/widgets", mode: "worktree" },
    state: "running",
    createdAt: 0,
    prUrl: prUrl(n),
    ...fields,
  };
}

type Fake = {
  readonly state: string;
  readonly isDraft?: boolean;
  readonly rollup?: string;
  /** The PR's base; the repo's default branch is `main` unless `defaultBranch` says otherwise. */
  readonly base?: string;
  readonly defaultBranch?: string | null;
  readonly mergeOid?: string;
  /** The default branch compared to `mergeOid`: answered at `c<i>` when set. */
  readonly landed?: string | null;
  /** Any of these answers the blocked-state read at `b<i>`; `blocked: null` answers it with a null alias. */
  readonly oid?: string;
  readonly contexts?: readonly unknown[];
  readonly mergeStateStatus?: string;
  /** What a watch reads of the head (`headRefOid`, `mergeable`) and of a long check list (`totalCount`). */
  readonly headRefOid?: string;
  readonly mergeable?: string;
  readonly totalCount?: number;
  readonly autoMerge?: boolean;
  readonly inMergeQueue?: boolean;
  readonly reviewRequests?: number;
  readonly blocked?: null;
} | null;

const HEAD = "0123456789abcdef0123456789abcdef01234567";

/** A required (or not) CheckRun as the blocked read returns it. */
function run(
  name: string,
  conclusion: string | null,
  required = true,
  status = "COMPLETED",
  databaseId?: number,
  suite?: number,
  detailsUrl?: string,
): unknown {
  return {
    __typename: "CheckRun",
    databaseId,
    name,
    status,
    conclusion,
    isRequired: required,
    ...(suite === undefined ? {} : { checkSuite: { databaseId: suite } }),
    ...(detailsUrl === undefined ? {} : { detailsUrl }),
  };
}

function statusContext(context: string, state: string, required = true): unknown {
  return { __typename: "StatusContext", context, state, isRequired: required };
}

function wideOf(fake: Exclude<Fake, null>): boolean {
  return (
    fake.oid !== undefined ||
    fake.contexts !== undefined ||
    fake.mergeStateStatus !== undefined ||
    fake.headRefOid !== undefined ||
    fake.mergeable !== undefined ||
    fake.totalCount !== undefined ||
    fake.autoMerge !== undefined ||
    fake.inMergeQueue !== undefined ||
    fake.reviewRequests !== undefined ||
    fake.blocked === null
  );
}

/** gh's GraphQL answer: alias `p<i>` per PR, `null` for one the forge gives nothing for. */
function reply(...prs: readonly Fake[]): string {
  const data: Record<string, unknown> = {};
  prs.forEach((fake, i) => {
    data[`p${i}`] = {
      defaultBranchRef: fake?.defaultBranch === null ? null : { name: fake?.defaultBranch ?? "main" },
      pullRequest:
        fake === null
          ? null
          : {
              state: fake.state,
              isDraft: fake.isDraft ?? false,
              merged: fake.state === "MERGED",
              baseRefName: fake.base ?? "main",
              mergeCommit: fake.mergeOid === undefined ? null : { oid: fake.mergeOid },
              commits: {
                nodes: [{ commit: { statusCheckRollup: fake.rollup === undefined ? null : { state: fake.rollup } } }],
              },
            },
    };
    // One body answers both runs: the stub replies the same to each, and each run reads its own aliases.
    if (fake?.landed !== undefined) {
      data[`c${i}`] = fake.landed === null ? null : { defaultBranchRef: { compare: { status: fake.landed } } };
    }
    if (fake !== null && wideOf(fake)) {
      data[`b${i}`] =
        fake.blocked === null
          ? null
          : {
              pullRequest: {
                mergeStateStatus: fake.mergeStateStatus ?? "CLEAN",
                mergeable: fake.mergeable,
                headRefOid: fake.headRefOid,
                isInMergeQueue: fake.inMergeQueue ?? false,
                autoMergeRequest: fake.autoMerge === true ? { enabledAt: "2026-11-12T00:00:00Z" } : null,
                reviewRequests: { totalCount: fake.reviewRequests ?? 0 },
                commits: {
                  nodes: [
                    {
                      commit: {
                        oid: fake.oid ?? HEAD,
                        statusCheckRollup:
                          fake.contexts === undefined
                            ? null
                            : { contexts: { totalCount: fake.totalCount, nodes: fake.contexts } },
                      },
                    },
                  ],
                },
              },
            };
    }
  });
  return JSON.stringify({ data });
}

interface Seen {
  readonly id: string;
  readonly url: string;
  readonly status: PrStatus;
}

/** `rejects` names the tasks whose write the caller's `onStatus` refuses. */
function start(
  tasks: readonly Task[],
  opts: PrPollerOpts & { readonly now?: () => number; readonly watches?: PollerWatches } = {},
  rejects: ReadonlySet<string> = new Set(),
) {
  const logs = { info: [] as string[], warn: [] as string[] };
  const seen: Seen[] = [];
  const poller = startPrPoller({
    gh: stub.path,
    intervalMs: 20,
    maxBackoffMs: 60_000,
    timeoutMs: 10_000,
    ...opts,
    tasks: () => tasks,
    onStatus: (id, url, status) => {
      if (rejects.has(id)) return Promise.reject(new Error("store refused"));
      seen.push({ id, url, status });
      return Promise.resolve();
    },
    now: opts.now ?? (() => 1234),
    log: { info: (line) => logs.info.push(line), warn: (line) => logs.warn.push(line) },
  });
  stops.push(poller.stop);
  return { ...poller, logs, seen };
}

describe("parseGithubPr", () => {
  test("takes the PR page of a github.com repo and nothing else", () => {
    expect(parseGithubPr("https://github.com/octo-org/widgets/pull/42")).toEqual({
      owner: "octo-org",
      repo: "widgets",
      number: 42,
    });
    expect(parseGithubPr("https://github.com/a/b.c_d/pull/2147483647")?.number).toBe(2_147_483_647);
    for (const bad of [
      "https://gitlab.com/a/b/pull/1",
      "https://github.com/a/b/pull/1/files",
      "https://github.com/a/b/pull/0",
      "https://github.com/a/b/pull/01",
      "https://github.com/a/b/pull/2147483648",
      "https://github.com/a/b/pull/99999999999",
      "https://github.com/a/b/issues/1",
      "http://github.com/a/b/pull/1",
      "https://github.com/a/b/pull/1?x=1",
      "https://github.com/-/b/pull/1 ",
    ]) {
      expect(parseGithubPr(bad)).toBeNull();
    }
  });
});

describe("the poller's read", () => {
  test("a merged and an open PR map; owner, repo and number reach gh only as variables", async () => {
    await gh.setReply(reply({ state: "MERGED" }, { state: "OPEN" }), 0);
    const { seen } = start([pr(4242), pr(7, { id: "other" })]);
    await pollUntil(() => seen.length >= 2, "both readings");
    expect(seen.slice(0, 2)).toEqual([
      { id: "t4242", url: prUrl(4242), status: { state: "merged", at: 1234 } },
      { id: "other", url: prUrl(7), status: { state: "open", at: 1234 } },
    ]);
    const argv = await gh.argv();
    expect(argv.slice(0, 4)).toEqual(["api", "--hostname", "github.com", "graphql"]);
    const pairs = argv.slice(4);
    const query = pairs.find((arg) => arg.startsWith("query="));
    expect(query).toContain("baseRefName");
    expect(query).toContain("defaultBranchRef");
    expect(pairs).toContain("o0=octo-org");
    expect(pairs).toContain("r0=widgets");
    expect(pairs).toContain("n0=4242");
    expect(pairs).toContain("n1=7");
    const flag = (value: string): string | undefined => pairs[pairs.indexOf(value) - 1];
    expect(flag("o0=octo-org")).toBe("-f");
    expect(flag("r0=widgets")).toBe("-f");
    expect(flag("n0=4242")).toBe("-F");
    for (const value of ["octo-org", "widgets", "4242"]) expect(query).not.toContain(value);
  });

  test("a draft is a draft, a closed PR is closed, and each check rollup maps; none is no checks", async () => {
    await gh.setReply(
      reply(
        { state: "OPEN", isDraft: true },
        { state: "CLOSED" },
        { state: "OPEN", rollup: "FAILURE" },
        { state: "OPEN", rollup: "ERROR" },
        { state: "OPEN", rollup: "PENDING" },
        { state: "OPEN", rollup: "EXPECTED" },
        { state: "OPEN", rollup: "SUCCESS" },
        { state: "OPEN", rollup: "SOMETHING_NEW" },
      ),
      0,
    );
    const tasks = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => pr(n));
    const { seen, stop } = start(tasks);
    await pollUntil(() => seen.length >= 8, "eight readings");
    stop();
    expect(seen.slice(0, 8).map((s) => [s.status.state, s.status.checks])).toEqual([
      ["draft", undefined],
      ["closed", undefined],
      ["open", "failing"],
      ["open", "failing"],
      ["open", "pending"],
      ["open", "pending"],
      ["open", "passing"],
      ["open", undefined],
    ]);
    expect(seen[0]?.status).not.toHaveProperty("checks");
  });

  test("an answer with one PR the forge gives nothing for (exit 1, JSON on stdout) reports the good one and warns once with the error's type", async () => {
    const body = JSON.parse(reply({ state: "OPEN" }, null));
    body.errors = [
      {
        type: "NOT_FOUND",
        path: ["p1", "pullRequest"],
        message: "Could not resolve to a PullRequest with the number of 8. secret-detail",
      },
    ];
    await gh.setReply(JSON.stringify(body), 1);
    const { seen, logs } = start([pr(7), pr(8)]);
    await pollUntil(() => seen.length >= 2, "two polls of the good PR");
    expect(new Set(seen.map((s) => s.id))).toEqual(new Set(["t7"]));
    expect(logs.warn).toHaveLength(1);
    expect(logs.warn[0]).toContain(quote(prUrl(8)));
    expect(logs.warn[0]).toContain("NOT_FOUND");
    expect(logs.warn.join("\n")).not.toContain("secret-detail");
    expect(logs.info).toEqual([]);
  });

  test("two tasks on one PR are one alias and two writes", async () => {
    await gh.setReply(reply({ state: "MERGED" }), 0);
    const { seen } = start([pr(5, { id: "a" }), pr(5, { id: "b", state: "needs-input" })]);
    await pollUntil(() => seen.length >= 2, "both writes");
    expect(seen.slice(0, 2).map((s) => s.id)).toEqual(["a", "b"]);
    const argv = await gh.argv();
    expect(argv.filter((arg) => arg.startsWith("n"))).toEqual(["n0=5"]);
  });

  test("every PR a task reported is read, newest first, in the one run; one held by prUrl alone is read too", async () => {
    await gh.setReply(reply({ state: "CLOSED" }, { state: "MERGED" }, { state: "OPEN" }), 0);
    const several = pr(4, { id: "several", prs: [{ url: prUrl(3) }, { url: prUrl(4) }] });
    const { seen } = start([several, pr(9, { id: "older" })]);
    await pollUntil(() => seen.length >= 3, "three readings");
    expect(seen.slice(0, 3)).toEqual([
      { id: "several", url: prUrl(4), status: { state: "closed", at: 1234 } },
      { id: "several", url: prUrl(3), status: { state: "merged", at: 1234 } },
      { id: "older", url: prUrl(9), status: { state: "open", at: 1234 } },
    ]);
    const argv = await gh.argv();
    expect(argv.filter((arg) => /^n\d=/u.test(arg))).toEqual(["n0=4", "n1=3", "n2=9"]);
  });

  test("a finished task's PRs are all read in its one read this term", async () => {
    await gh.setReply(reply({ state: "CLOSED" }, { state: "OPEN" }), 0);
    const { seen } = start([pr(2, { id: "done", state: "done", prs: [{ url: prUrl(1) }, { url: prUrl(2) }] })]);
    await pollUntil(() => seen.length >= 2, "both readings");
    // A non-event cannot be polled for: several intervals, and still the one run.
    await Bun.sleep(200);
    expect(await gh.calls()).toBe(1);
    expect(seen.map((s) => s.url)).toEqual([prUrl(2), prUrl(1)]);
  });

  test("GH_PROMPT_DISABLED=1 reaches the child", async () => {
    await gh.setReply(reply({ state: "OPEN" }), 0);
    const { seen, stop } = start([pr(3)]);
    await pollUntil(() => seen.length > 0, "a reading");
    stop();
    expect(await Bun.file(gh.promptFile).text()).toBe("1");
  });
});

describe("what the poller reads of a merge", () => {
  test("a merge into a branch other than the default is `stacked`; so is one whose default branch is unknown; a merge into the default and a non-merged PR are not", async () => {
    await gh.setReply(
      reply(
        { state: "MERGED", base: "feature/parent" },
        { state: "MERGED", base: "trunk", defaultBranch: "trunk" },
        { state: "MERGED", defaultBranch: null },
        { state: "OPEN", base: "feature/parent" },
      ),
      0,
    );
    const { seen, stop } = start([1, 2, 3, 4].map((n) => pr(n)));
    await pollUntil(() => seen.length >= 4, "four readings");
    stop();
    expect(seen.slice(0, 4).map((s) => s.status)).toEqual([
      { state: "merged", stacked: true, at: 1234 },
      { state: "merged", at: 1234 },
      { state: "merged", stacked: true, at: 1234 },
      { state: "open", at: 1234 },
    ]);
  });

  test("a stacked merge whose merge commit the default branch holds is not `stacked`: a stack merged in cascade lands", async () => {
    const oid = "e4e539377223b245bf1ad0d97de4e726ee65bd37";
    await gh.setReply(
      reply(
        { state: "OPEN" },
        { state: "MERGED", base: "parent", mergeOid: oid, landed: "IDENTICAL" },
        { state: "MERGED", base: "parent", mergeOid: oid, landed: "BEHIND" },
        { state: "MERGED", base: "parent", mergeOid: oid, landed: "DIVERGED" },
        { state: "MERGED", base: "parent", mergeOid: oid, landed: null },
        { state: "MERGED", base: "parent" },
        { state: "MERGED", base: "parent", mergeOid: "not-an-oid", landed: "IDENTICAL" },
      ),
      0,
    );
    const { seen, stop } = start(
      [1, 2, 3, 4, 5, 6, 7].map((n) => pr(n)),
      { intervalMs: 60_000 },
    );
    await pollUntil(() => seen.length >= 7, "seven readings");
    stop();
    expect(seen.map((s) => s.status)).toEqual([
      { state: "open", at: 1234 },
      { state: "merged", at: 1234 },
      { state: "merged", at: 1234 },
      { state: "merged", stacked: true, at: 1234 },
      { state: "merged", stacked: true, at: 1234 },
      { state: "merged", stacked: true, at: 1234 },
      { state: "merged", stacked: true, at: 1234 },
    ]);
    const runs = await gh.argvs();
    expect(runs).toHaveLength(2);
    const second = runs[1]?.slice(4) ?? [];
    const query = second.find((arg) => arg.startsWith("query=")) ?? "";
    // Only merges with a well-formed oid are asked about, keyed by their first run's alias.
    for (const i of [1, 2, 3, 4]) expect(second).toContain(`h${i}=${oid}`);
    expect(second.join(" ")).not.toContain("h5=");
    expect(second.join(" ")).not.toContain("not-an-oid");
    expect(second[second.indexOf(`h1=${oid}`) - 1]).toBe("-f");
    for (const value of ["octo-org", "widgets", oid]) expect(query).not.toContain(value);
  });

  test("when the second run fails, a stacked merge stays `stacked` and the poll is not a failure", async () => {
    const oid = "a".repeat(40);
    // Exit 0 but no `c1`: what a failed second run leaves, as far as the merge is concerned.
    await gh.setReply(reply({ state: "OPEN" }, { state: "MERGED", base: "parent", mergeOid: oid }), 0);
    const { seen, logs, stop } = start([pr(1), pr(2)], { intervalMs: 60_000 });
    await pollUntil(() => seen.length >= 2, "two readings");
    stop();
    expect(seen[1]?.status).toEqual({ state: "merged", stacked: true, at: 1234 });
    expect(logs.warn).toEqual([]);
  });

  test("a non-stacked answer never takes a second run", async () => {
    await gh.setReply(reply({ state: "MERGED", mergeOid: "b".repeat(40) }, { state: "OPEN" }), 0);
    const { seen, stop } = start([pr(1), pr(2)], { intervalMs: 60_000 });
    await pollUntil(() => seen.length >= 2, "two readings");
    stop();
    expect(await gh.argvs()).toHaveLength(1);
  });
});

describe("chunking", () => {
  test("more than 50 PRs take one gh run per 50, and each run's aliases map back to its own PRs", async () => {
    // Alias p0 is merged in every run, so a mix-up of indices across chunks shows as the wrong task.
    await gh.setReply(reply({ state: "MERGED" }, ...Array.from({ length: 49 }, () => ({ state: "OPEN" }))), 0);
    const tasks = Array.from({ length: 60 }, (_, i) => pr(i + 1));
    const { seen, stop } = start(tasks, { intervalMs: 60_000 });
    await pollUntil(() => seen.length >= 60, "all sixty readings");
    stop();
    const runs = await gh.argvs();
    expect(runs).toHaveLength(2);
    const [first, second] = runs.map((argv) => argv.slice(4));
    expect(first).toContain("n0=1");
    expect(first).toContain("n49=50");
    expect(first).not.toContain("n50=51");
    expect(second).toContain("n0=51");
    expect(second).toContain("n9=60");
    expect(second).not.toContain("n10=61");
    expect(seen.filter((s) => s.status.state === "merged").map((s) => s.id)).toEqual(["t1", "t51"]);
    expect(seen).toHaveLength(60);
  });
});

describe("what is never read", () => {
  test("a URL that is not a GitHub PR, one too big for GraphQL's Int, a finished task read as merged and a task with no PR never reach gh", async () => {
    await gh.setReply(reply({ state: "OPEN" }), 0);
    const { seen } = start([
      pr(1, { id: "gitlab", prUrl: "https://gitlab.com/octo-org/widgets/pull/1" }),
      pr(1, { id: "files", prUrl: `${prUrl(1)}/files` }),
      pr(1, { id: "big", prUrl: prUrl(99_999_999_999) }),
      pr(1, { id: "done", state: "done", pr: { state: "merged", at: 1 } }),
      pr(1, { id: "bare", prUrl: undefined }),
      pr(6, { id: "good" }),
    ]);
    await pollUntil(() => seen.length > 0, "the one good reading");
    expect(new Set(seen.map((s) => s.id))).toEqual(new Set(["good"]));
    const argv = await gh.argv();
    expect(argv.join(" ")).not.toMatch(/gitlab|files|99999999999|n1=/u);
    expect(argv).toContain("n0=6");
  });

  test("a finished task with no reading is read; once the forge refuses its PR, it is not read again", async () => {
    await gh.setReply(reply({ state: "MERGED" }), 0);
    const read = start([pr(3, { id: "done", state: "done" })]);
    await pollUntil(() => read.seen.length > 0, "the finished task's reading");
    expect(read.seen[0]).toMatchObject({ id: "done", status: { state: "merged" } });
    read.stop();

    gh = await stub.fresh();
    await gh.setReply(reply(null), 1);
    const refused = start([pr(4, { id: "gone", state: "failed" })]);
    await pollUntil(async () => (await gh.calls()) >= 1, "the one read");
    // A non-event cannot be polled for: several intervals, and still the one run.
    await Bun.sleep(200);
    expect(await gh.calls()).toBe(1);
    expect(refused.logs.warn).toHaveLength(1);
  });

  test("a finished task holding a non-merged reading is read once per term: again by the next poller, not every poll", async () => {
    await gh.setReply(reply({ state: "MERGED" }, { state: "OPEN" }), 0);
    const tasks = [
      pr(1, { id: "stale", state: "done", pr: { state: "open", checks: "pending", at: 1 } }),
      pr(2, { id: "open", state: "failed", pr: { state: "open", at: 1 } }),
    ];
    const first = start(tasks);
    await pollUntil(() => first.seen.length >= 2, "the term's one reading of each");
    expect(first.seen.find((s) => s.id === "stale")?.status.state).toBe("merged");
    // A non-event cannot be polled for: several intervals, and still the one run.
    await Bun.sleep(200);
    expect(await gh.calls()).toBe(1);
    expect(first.seen).toHaveLength(2);
    first.stop();

    const next = start(tasks);
    await pollUntil(() => next.seen.length >= 2, "the next term's reading");
    expect(next.seen.map((s) => s.id).toSorted()).toEqual(["open", "stale"]);
  });

  test("a finished task whose PR answers with a state the poller cannot read is still read once per term", async () => {
    await gh.setReply(reply({ state: "SOMETHING_NEW" }), 0);
    const { seen, logs } = start([pr(1, { id: "odd", state: "done", pr: { state: "open", at: 1 } })]);
    await pollUntil(async () => (await gh.calls()) >= 1, "the one read");
    // A non-event cannot be polled for: several intervals, and still the one run.
    await Bun.sleep(200);
    expect(await gh.calls()).toBe(1);
    expect(seen).toHaveLength(0);
    expect(logs.warn).toHaveLength(0);
  });

  test("a task read while running still takes its finished read once it finishes", async () => {
    await gh.setReply(reply({ state: "OPEN" }), 0);
    const tasks = [pr(1, { id: "t" })];
    const { seen } = start(tasks);
    await pollUntil(() => seen.length > 0, "the running read");
    tasks[0] = pr(1, { id: "t", state: "done" });
    const before = seen.length;
    await pollUntil(() => seen.length > before, "a read after it finished");
    // That read may be one in flight at the switch, aimed at the running task; settling waits out the finished read after it.
    const calls = await gh.settledCalls();
    expect(seen.at(-1)?.id).toBe("t");
    // A non-event cannot be polled for: several intervals, and no more reads.
    await Bun.sleep(200);
    expect(await gh.calls()).toBe(calls);
  });

  test("with nothing to poll gh never runs", async () => {
    const { seen } = start([
      pr(1, { prUrl: "https://gitlab.com/octo-org/widgets/pull/1" }),
      pr(2, { state: "cancelled", pr: { state: "merged", at: 1 } }),
      pr(3, { state: "queued" }),
      pr(4, { state: "blocked" }),
      pr(5, { state: "reserved" }),
    ]);
    // A non-event cannot be polled for: several intervals, and still no run.
    await Bun.sleep(200);
    expect(await gh.calls()).toBe(0);
    expect(seen).toEqual([]);
  });

  test("stop ends the polling, and nothing is read after it", async () => {
    await gh.setReply(reply({ state: "OPEN" }), 0);
    const { seen, stop } = start([pr(9)]);
    await pollUntil(() => seen.length >= 2, "two polls");
    stop();
    // A child spawned just before stop() may still be starting: count once it has.
    const calls = await gh.settledCalls();
    const written = seen.length;
    await Bun.sleep(150);
    expect(await gh.calls()).toBe(calls);
    expect(seen).toHaveLength(written);
  });
});

describe("when gh does not answer", () => {
  test("garbage on stdout is `failed`: one warning however many polls, and the delay doubles", async () => {
    await gh.setReply("this is not json", 0);
    const { logs, seen } = start([pr(1)], { intervalMs: 40 });
    await pollUntil(async () => (await gh.calls()) >= 2, "two failing polls");
    await Bun.sleep(400);
    // Polls at 0, 80, 240, 560 ms: an unbacked-off 40ms cadence would make about ten.
    expect(await gh.calls()).toBeLessThan(6);
    expect(logs.warn).toHaveLength(1);
    expect(logs.warn[0]).toContain("failed");
    expect(logs.warn[0]).not.toContain("this is not json");
    expect(seen).toEqual([]);
  });

  test("exit 4 is `unauthenticated`: one warning naming the remedy; the first good poll after it says so once", async () => {
    await gh.setReply("", 4);
    const { logs, seen } = start([pr(2)]);
    await pollUntil(() => logs.warn.length === 1, "the warning");
    expect(logs.warn[0]).toContain("gh auth login");
    await Bun.sleep(150);
    expect(logs.warn).toHaveLength(1);
    expect(seen).toEqual([]);

    await gh.setReply(reply({ state: "OPEN" }), 0);
    await pollUntil(() => seen.length > 0, "recovery");
    expect(logs.info).toHaveLength(1);
    expect(logs.warn).toHaveLength(1);
  });

  test("a revoked or expired token (exit 1, GitHub's refusal and no data) is `unauthenticated`, and its body is never logged", async () => {
    for (const body of [
      '{"message":"Bad credentials","documentation_url":"https://docs.github.com/graphql","status":"401"}',
      '{"message":"token ghp_secret rejected","status":401}',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one poller at a time over the shared stub
      await gh.setReply(body, 1);
      const { logs, seen, stop } = start([pr(2)]);
      // oxlint-disable-next-line no-await-in-loop -- as above
      await pollUntil(() => logs.warn.length === 1, "the warning");
      // oxlint-disable-next-line no-await-in-loop -- as above
      await Bun.sleep(100);
      stop();
      expect(logs.warn).toHaveLength(1);
      expect(logs.warn[0]).toContain("gh auth login");
      expect(logs.warn.join("\n")).not.toMatch(/Bad credentials|ghp_secret/u);
      expect(seen).toEqual([]);
    }
  });

  test("a refusal that is neither is `failed`, not a login problem", async () => {
    await gh.setReply('{"message":"Server Error","status":"500"}', 1);
    const { logs } = start([pr(2)]);
    await pollUntil(() => logs.warn.length === 1, "the warning");
    expect(logs.warn[0]).toContain("failed");
    expect(logs.warn[0]).not.toContain("gh auth login");
  });

  test("a gh that outlasts timeoutMs is `failed`: killed, one warning, nothing written", async () => {
    await gh.setReply(reply({ state: "OPEN" }), 0, 30);
    const { logs, seen } = start([pr(5)], { timeoutMs: 150 });
    await pollUntil(() => logs.warn.length === 1, "the timeout warning");
    // It was the wait that failed it, not an answer.
    expect(await gh.delayed()).toBeGreaterThan(0);
    expect(logs.warn[0]).toContain("failed");
    await Bun.sleep(100);
    expect(logs.warn).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  test("a gh that does not exist is `missing`: one warning, no throw", async () => {
    const { logs, seen } = start([pr(3)], { gh: join(base, "no-such-gh") });
    await pollUntil(() => logs.warn.length === 1, "the warning");
    await Bun.sleep(150);
    expect(logs.warn).toHaveLength(1);
    expect(logs.warn[0]).toContain("missing");
    expect(seen).toEqual([]);
  });

  test("an empty answer is `failed` too", async () => {
    // A timeout reads the same: no stdout that is a GraphQL answer.
    await gh.setReply("", 0);
    const { logs } = start([pr(4)]);
    await pollUntil(() => logs.warn.length === 1, "the warning");
    expect(logs.warn[0]).toContain("failed");
  });
});

describe("when GitHub's budget is spent", () => {
  // S3's two shapes, from gh's source and GitHub's docs: the primary GraphQL limit is HTTP 200 with
  // `errors[].type` RATE_LIMITED; the secondary a 403 (or 429) whose message says so. gh exits 1 on both.
  const PRIMARY = JSON.stringify({
    errors: [
      { type: "RATE_LIMITED", code: "graphql_rate_limit", message: "API rate limit already exceeded for user ID 77." },
    ],
  });
  const SECONDARY = JSON.stringify({
    message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again. ID F00D.",
    documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
    status: "403",
  });
  const SELECTION = "rateLimit{ cost remaining resetAt }";
  const withBudget = (body: string, resetAt: number, remaining = 4000): string => {
    const parsed = JSON.parse(body);
    parsed.data.rateLimit = { cost: 1, remaining, resetAt: new Date(resetAt).toISOString() };
    return JSON.stringify(parsed);
  };

  test("either shape is `limited`: one warning naming the reset, never gh's words, and no poll before the reset", async () => {
    for (const body of [PRIMARY, SECONDARY]) {
      const now = Date.now();
      const reset = now + 3_600_000;
      // oxlint-disable-next-line no-await-in-loop -- one poller at a time over the shared stub
      await gh.setReply(body, 1);
      const { logs, seen, stop } = start([pr(1)], { now: () => now, graphqlReset: () => reset, random: () => 0 });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await pollUntil(() => logs.warn.length === 1, "the warning");
      // A non-event: an unlimited poller at 20 ms would have run several times by now.
      // oxlint-disable-next-line no-await-in-loop -- as above
      await Bun.sleep(200);
      stop();
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect(await gh.calls()).toBe(1);
      expect(logs.warn).toHaveLength(1);
      expect(logs.warn[0]).toContain("(limited)");
      expect(logs.warn[0]).toContain(`until ${new Date(reset).toISOString()}`);
      expect(logs.warn[0]).not.toMatch(/user ID|secondary|F00D/u);
      expect(seen).toEqual([]);
      // oxlint-disable-next-line no-await-in-loop -- a fresh run dir for the next shape
      gh = await stub.fresh();
    }
  });

  test("with no reset known, or one already past, it backs off on the ladder and says no time", async () => {
    for (const reset of [null, 1000]) {
      const current = gh;
      // oxlint-disable-next-line no-await-in-loop -- one poller at a time over the shared stub
      await current.setReply(PRIMARY, 1);
      const { logs, stop } = start([pr(1)], { intervalMs: 10, graphqlReset: () => reset });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await pollUntil(async () => (await current.calls()) >= 2, "a second poll on the ladder");
      stop();
      expect(logs.warn).toHaveLength(1);
      expect(logs.warn[0]).toContain("(limited)");
      expect(logs.warn[0]).not.toContain("until");
      // oxlint-disable-next-line no-await-in-loop -- a fresh run dir for the next case
      gh = await stub.fresh();
    }
  });

  test("other refusals with no data are not `limited`: a NOT_FOUND body is `failed`", async () => {
    await gh.setReply(
      JSON.stringify({ errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] }),
      1,
    );
    const { logs } = start([pr(1)]);
    await pollUntil(() => logs.warn.length === 1, "the warning");
    expect(logs.warn[0]).toContain("(failed)");
  });

  test("the in-query resetAt sets the wait, ahead of the rate reader's; the first good poll after it says so once", async () => {
    const begun = Date.now();
    const reset = begun + 400;
    await gh.setReply(withBudget(reply({ state: "OPEN" }), reset), 0);
    await gh.setCallReply(2, PRIMARY, 1);
    // A clock that stands still: the reset stays 400 ms ahead however long a stub exec takes; the wait itself is real.
    const { logs } = start([pr(1)], {
      now: () => begun,
      random: () => 0,
      // Later than the in-query reset: were it read, the third poll would not come within the wait below.
      graphqlReset: () => begun + 3_600_000,
    });
    await pollUntil(() => logs.warn.length === 1, "the warning");
    expect(logs.warn[0]).toContain(`until ${new Date(reset).toISOString()}`);
    await pollUntil(() => logs.info.length === 1, "the resumption");
    expect(await gh.calls()).toBeGreaterThanOrEqual(3);
    expect(logs.info[0]).toContain("resumed");
    expect(logs.warn).toHaveLength(1);
  });

  test("a limited blocked-state run ends the poll limited: the merge readings land, no blocked warning, nothing more asked", async () => {
    const now = Date.now();
    await gh.setReply(reply({ state: "OPEN", oid: HEAD }, { state: "MERGED" }), 0);
    await gh.setBlockedReply(PRIMARY, 1);
    const tasks = [pr(1, { state: "awaiting-merge" }), pr(2, { state: "awaiting-merge" })];
    const { logs, seen } = start(tasks, { now: () => now, graphqlReset: () => now + 3_600_000, random: () => 0 });
    await pollUntil(() => logs.warn.length === 1 && seen.length === 2, "the warning and both readings");
    // A non-event: no third run comes before the reset.
    await Bun.sleep(150);
    expect(await gh.calls()).toBe(2);
    expect(logs.warn).toHaveLength(1);
    expect(logs.warn[0]).toContain("(limited)");
    expect(seen.map((s) => [s.id, s.status.state])).toEqual([
      ["t2", "merged"],
      ["t1", "open"],
    ]);
  });

  test("a reset beyond the window waits for the window's end rather than the ladder (a clock running behind GitHub's)", async () => {
    await gh.setReply(PRIMARY, 1);
    const { logs } = start([pr(1)], { now: () => 1234, graphqlReset: () => 1234 + 2 * 3_600_000, random: () => 0 });
    await pollUntil(() => logs.warn.length === 1, "the warning");
    expect(logs.warn[0]).toContain(`until ${new Date(1234 + 61 * 60_000).toISOString()}`);
    await Bun.sleep(100);
    expect(await gh.calls()).toBe(1);
  });

  test("a limit seen before a rejected write still ends the poll limited", async () => {
    const now = Date.now();
    await gh.setReply(reply({ state: "OPEN", oid: HEAD }), 0);
    await gh.setBlockedReply(PRIMARY, 1);
    const { logs } = start(
      [pr(1, { state: "awaiting-merge" })],
      { now: () => now, graphqlReset: () => now + 3_600_000, random: () => 0 },
      new Set(["t1"]),
    );
    await pollUntil(() => logs.warn.length === 1, "the warning");
    await Bun.sleep(150);
    expect(logs.warn[0]).toContain("(limited)");
    expect(await gh.calls()).toBe(2);
  });

  test("a limited landed check ends the poll limited: nothing more is asked before the reset", async () => {
    const now = Date.now();
    await gh.setReply(reply({ state: "MERGED", base: "feature", mergeOid: HEAD, landed: "BEHIND" }), 0);
    await gh.setCallReply(2, PRIMARY, 1);
    const { logs } = start([pr(1, { state: "awaiting-merge" })], {
      now: () => now,
      graphqlReset: () => now + 3_600_000,
      random: () => 0,
    });
    await pollUntil(() => logs.warn.length === 1, "the warning");
    await Bun.sleep(150);
    expect(logs.warn[0]).toContain("(limited)");
    expect(await gh.calls()).toBe(2);
  });

  test("a revoked token whose body also mentions the limit stays `unauthenticated`", async () => {
    await gh.setReply('{"message":"API rate limit exceeded for user ID 1","status":"401"}', 1);
    const { logs } = start([pr(1)]);
    await pollUntil(() => logs.warn.length === 1, "the warning");
    expect(logs.warn[0]).toContain("gh auth login");
  });

  test("the limit by wording alone, by `errors[].message`, or typed beside data, is `limited`; an unrelated error is not", async () => {
    const bodies = [
      JSON.stringify({ errors: [{ message: "You have exceeded a secondary rate limit." }] }),
      JSON.stringify({ message: "You have been rate limited. Try later." }),
      JSON.stringify({ message: "You have triggered an abuse detection mechanism. Please wait." }),
      JSON.stringify({ data: { p0: null, rateLimit: null }, errors: [{ type: "RATE_LIMITED", message: "slow down" }] }),
    ];
    for (const body of bodies) {
      const current = gh;
      // oxlint-disable-next-line no-await-in-loop -- one poller at a time over the shared stub
      await current.setReply(body, 1);
      const { logs, stop } = start([pr(1)], { intervalMs: 10_000 });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await pollUntil(() => logs.warn.length === 1, "the warning");
      stop();
      expect(logs.warn[0]).toContain("(limited)");
      expect(logs.warn[0]).not.toContain("not readable");
      // oxlint-disable-next-line no-await-in-loop -- a fresh run dir for the next body
      gh = await stub.fresh();
    }
    await gh.setReply(JSON.stringify({ errors: [{ message: "Something went wrong while executing your query." }] }), 1);
    const { logs } = start([pr(1)], { intervalMs: 10_000 });
    await pollUntil(() => logs.warn.length === 1, "the warning");
    expect(logs.warn[0]).toContain("(failed)");
  });

  test("limited, failed, then ok: one warning per class and one resumption", async () => {
    await gh.setReply(reply({ state: "OPEN" }), 0);
    await gh.setCallReply(1, PRIMARY, 1);
    await gh.setCallReply(2, "not json", 0);
    const { logs, seen } = start([pr(1)], { intervalMs: 10 });
    await pollUntil(() => seen.length > 0, "the first good reading");
    expect(logs.warn).toHaveLength(2);
    expect(logs.warn[0]).toContain("(limited)");
    expect(logs.warn[1]).toContain("(failed)");
    expect(logs.info).toHaveLength(1);
  });

  test("a limited stay that gains a known reset warns again, naming it", async () => {
    await gh.setReply(PRIMARY, 1);
    let reset: number | null = null;
    const { logs } = start([pr(1)], { intervalMs: 200, now: () => 1234, graphqlReset: () => reset, random: () => 0 });
    await pollUntil(() => logs.warn.length === 1, "the first warning");
    expect(logs.warn[0]).not.toContain("until");
    reset = 1234 + 300;
    await pollUntil(() => logs.warn.length === 2, "the warning with a time");
    expect(logs.warn[1]).toContain(`until ${new Date(reset).toISOString()}`);
  });

  test("a rateLimit that is no budget is not kept: the rate reader's reset sets the wait", async () => {
    for (const remaining of [1.5, -1, "x"]) {
      const parsed = JSON.parse(reply({ state: "OPEN" }));
      parsed.data.rateLimit = { cost: 1, remaining, resetAt: new Date(1234 + 500).toISOString() };
      const current = gh;
      // oxlint-disable-next-line no-await-in-loop -- one poller at a time over the shared stub
      await current.setReply(JSON.stringify(parsed), 0);
      // oxlint-disable-next-line no-await-in-loop -- as above
      await current.setCallReply(2, PRIMARY, 1);
      const { logs, stop } = start([pr(1)], { now: () => 1234, graphqlReset: () => 1234 + 1000, random: () => 0 });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await pollUntil(() => logs.warn.length === 1, "the warning");
      stop();
      expect(logs.warn[0]).toContain(`until ${new Date(1234 + 1000).toISOString()}`);
      // oxlint-disable-next-line no-await-in-loop -- a fresh run dir for the next case
      gh = await stub.fresh();
    }
  });

  test("every query the poller sends selects the rate limit, as constant text", async () => {
    await gh.setReply(
      reply({ state: "OPEN", oid: HEAD }, { state: "MERGED", base: "feature", mergeOid: HEAD, landed: "BEHIND" }),
      0,
    );
    const tasks = [pr(1, { state: "awaiting-merge" }), pr(2, { state: "awaiting-merge" })];
    const { seen, stop } = start(tasks, { intervalMs: 60_000 });
    await pollUntil(() => seen.length === 2, "both readings");
    stop();
    const queries = (await gh.argvs()).map((argv) => argv.find((arg) => arg.startsWith("query=")) ?? "");
    expect(queries).toHaveLength(3);
    for (const query of queries) expect(query.endsWith(` ${SELECTION} }`)).toBe(true);
  });

  test("limitedDelay waits until the reset plus under a minute's jitter, and gives no wait it cannot ground", () => {
    expect(limitedDelay(10_000, 4_000, 0)).toBe(6_000);
    expect(limitedDelay(10_000, 4_000, 0.999_999)).toBeLessThan(6_000 + LIMIT_JITTER_MS);
    expect(limitedDelay(10_000, 4_000, 7)).toBeLessThan(6_000 + LIMIT_JITTER_MS);
    expect(limitedDelay(10_000, 4_000, -1)).toBe(6_000);
    expect(limitedDelay(null, 4_000, 0)).toBeNull();
    expect(limitedDelay(4_000, 4_000, 0)).toBeNull();
    expect(limitedDelay(4_000 + 61 * 60_000 + 1, 4_000, 0)).toBeNull();
    expect(limitedDelay(4_000 + 61 * 60_000, 4_000, 0)).toBe(61 * 60_000);
  });
});

describe("the blocked-state read", () => {
  const waiting = (n: number, fields: Partial<Task> = {}): Task => pr(n, { state: "awaiting-merge", ...fields });
  const read = async (
    fake: Omit<Exclude<Fake, null>, "state">,
    task: Task = waiting(1),
  ): Promise<PrStatus | undefined> => {
    await gh.setReply(reply({ state: "OPEN", ...fake }), 0);
    const { seen, stop } = start([task], { intervalMs: 60_000 });
    await pollUntil(() => seen.length > 0, "a reading");
    stop();
    return seen[0]?.status;
  };

  test("(a) required CheckRuns roll up to failing and name only the required failing ones", async () => {
    const status = await read({
      oid: HEAD,
      contexts: [
        run("test (ubuntu-latest)", "FAILURE"),
        run("test (macos-latest)", "SUCCESS"),
        run("deploy-preview", "FAILURE", false),
      ],
    });
    expect(status).toEqual({
      state: "open",
      head: HEAD,
      required: "failing",
      failing: ["test (ubuntu-latest)"],
      merge: "clean",
      at: 1234,
    });
  });

  test("(b) a required StatusContext in ERROR fails; FAILURE too", async () => {
    const status = await read({
      contexts: [statusContext("ci/legacy", "ERROR"), statusContext("ci/other", "SUCCESS")],
    });
    expect(status?.required).toBe("failing");
    expect(status?.failing).toEqual(["ci/legacy"]);
  });

  test("(c) in progress and STALE read as pending; SKIPPED and NEUTRAL as passing", async () => {
    expect((await read({ contexts: [run("a", null, true, "IN_PROGRESS"), run("b", "SUCCESS")] }))?.required).toBe(
      "pending",
    );
    gh = await stub.fresh();
    expect((await read({ contexts: [run("a", "STALE"), run("b", "SUCCESS")] }))?.required).toBe("pending");
    gh = await stub.fresh();
    expect((await read({ contexts: [run("a", "SKIPPED"), run("b", "NEUTRAL")] }))?.required).toBe("passing");
    gh = await stub.fresh();
    expect((await read({ contexts: [statusContext("a", "PENDING"), statusContext("b", "SUCCESS")] }))?.required).toBe(
      "pending",
    );
  });

  test("(c) only the newest run of a check counts: a superseded CANCELLED neither fails nor names", async () => {
    // As GitHub answered for a head whose first CI run its concurrency group cancelled.
    const superseded = await read({
      contexts: [
        run("checks", "SUCCESS", true, "COMPLETED", 20),
        run("checks", "CANCELLED", true, "COMPLETED", 10),
        run("test (ubuntu-latest)", "CANCELLED", true, "COMPLETED", 11),
        run("test (ubuntu-latest)", "SUCCESS", true, "COMPLETED", 21),
      ],
    });
    expect(superseded?.required).toBe("passing");
    expect(superseded?.failing).toBeUndefined();
    gh = await stub.fresh();
    const rerun = await read({
      contexts: [run("checks", "FAILURE", true, "COMPLETED", 20), run("checks", "SUCCESS", true, "COMPLETED", 10)],
    });
    expect(rerun?.failing).toEqual(["checks"]);
    gh = await stub.fresh();
    // Without ids, the later in the list is the newer.
    expect((await read({ contexts: [run("checks", "CANCELLED"), run("checks", "SUCCESS")] }))?.required).toBe(
      "passing",
    );
  });

  test("(d) no required context gives no `required` and no `failing`", async () => {
    const status = await read({ contexts: [run("a", "FAILURE", false)] });
    expect(status).toEqual({ state: "open", head: HEAD, merge: "clean", at: 1234 });
    gh = await stub.fresh();
    expect(await read({ oid: HEAD })).toEqual({ state: "open", head: HEAD, merge: "clean", at: 1234 });
  });

  test("(e) names: seven keep five, a long one is cut, control characters go, a blank one is dropped, and a repeat counts once", async () => {
    const status = await read({
      contexts: [
        ...Array.from({ length: 7 }, (_, i) => run(`check ${i}`, "FAILURE")),
        run("x".repeat(300), "FAILURE"),
        run("bad\u0007na\u001Bme\u0085", "FAILURE"),
        run("   ", "FAILURE"),
        run("check 0", "FAILURE"),
      ],
    });
    expect(status?.failing).toEqual(["check 0", "check 1", "check 2", "check 3", "check 4"]);
    gh = await stub.fresh();
    const cut = await read({
      contexts: [run("x".repeat(300), "FAILURE"), run("bad\u0007na\u001Bme\u0085", "FAILURE"), run("   ", "FAILURE")],
    });
    expect(cut?.failing).toEqual(["x".repeat(100), "badname"]);
  });

  test("(e) a name cut inside an astral character drops the whole character, never half of it", async () => {
    const status = await read({ contexts: [run(`${"x".repeat(99)}\u{1F680}tail`, "FAILURE")] });
    expect(status?.failing).toEqual(["x".repeat(99)]);
  });

  test("(f) mergeStateStatus is lowercased; a value this build does not know is left out", async () => {
    expect((await read({ mergeStateStatus: "DIRTY" }))?.merge).toBe("dirty");
    gh = await stub.fresh();
    expect((await read({ mergeStateStatus: "HAS_HOOKS" }))?.merge).toBe("has_hooks");
    gh = await stub.fresh();
    expect(await read({ mergeStateStatus: "DRAFT" })).not.toHaveProperty("merge");
  });

  test("(g) an armed auto-merge, or a place in the merge queue, is `armed`", async () => {
    expect((await read({ autoMerge: true }))?.armed).toBe(true);
    gh = await stub.fresh();
    expect((await read({ inMergeQueue: true }))?.armed).toBe(true);
    gh = await stub.fresh();
    expect(await read({ autoMerge: false })).not.toHaveProperty("armed");
  });

  test("(h) a requested review is `reviewRequested`", async () => {
    expect((await read({ reviewRequests: 2 }))?.reviewRequested).toBe(true);
    gh = await stub.fresh();
    expect(await read({ reviewRequests: 0 })).not.toHaveProperty("reviewRequested");
  });

  test("(i) a merged or draft PR carries none of it and takes one run only", async () => {
    await gh.setReply(reply({ state: "MERGED", oid: HEAD }, { state: "OPEN", isDraft: true, oid: HEAD }), 0);
    const { seen, stop } = start([waiting(1), waiting(2)], { intervalMs: 60_000 });
    await pollUntil(() => seen.length >= 2, "both readings");
    stop();
    expect(seen.map((s) => s.status)).toEqual([
      { state: "merged", at: 1234 },
      { state: "draft", at: 1234 },
    ]);
    expect(await gh.argvs()).toHaveLength(1);
  });

  test("(j) a running task and an until-reported awaiting-merge task get none, and make no blocked run; a task sharing the PR with a running one gets them", async () => {
    await gh.setReply(reply({ state: "OPEN", oid: HEAD, mergeStateStatus: "DIRTY" }, { state: "OPEN", oid: HEAD }), 0);
    const first = start(
      [
        pr(1, { id: "running" }),
        pr(2, { id: "reported", state: "awaiting-merge", spec: { repo: "r", mode: "worktree", until: "reported" } }),
      ],
      { intervalMs: 60_000 },
    );
    await pollUntil(() => first.seen.length >= 2, "both readings");
    first.stop();
    expect(first.seen.map((s) => s.status)).toEqual([
      { state: "open", at: 1234 },
      { state: "open", at: 1234 },
    ]);
    expect(await gh.argvs()).toHaveLength(1);

    gh = await stub.fresh();
    await gh.setReply(reply({ state: "OPEN", oid: HEAD, mergeStateStatus: "DIRTY" }), 0);
    const shared = start([pr(1, { id: "running" }), waiting(1, { id: "waiting" })], { intervalMs: 60_000 });
    await pollUntil(() => shared.seen.length >= 2, "both readings");
    shared.stop();
    expect(shared.seen.find((s) => s.id === "running")?.status).toEqual({ state: "open", at: 1234 });
    expect(shared.seen.find((s) => s.id === "waiting")?.status).toMatchObject({ head: HEAD, merge: "dirty" });
  });

  test("(j) only the primary PR of a task is read for its blocked state", async () => {
    await gh.setReply(reply({ state: "OPEN", oid: HEAD }, { state: "OPEN", oid: HEAD }), 0);
    const { seen, stop } = start([waiting(2, { prs: [{ url: prUrl(1) }, { url: prUrl(2) }] })], {
      intervalMs: 60_000,
    });
    await pollUntil(() => seen.length >= 2, "both readings");
    stop();
    expect(seen.find((s) => s.url === prUrl(2))?.status).toMatchObject({ head: HEAD });
    expect(seen.find((s) => s.url === prUrl(1))?.status).toEqual({ state: "open", at: 1234 });
  });

  test("(k) the merge query is untouched, and the blocked one is a second run whose values are variables", async () => {
    await gh.setReply(reply({ state: "OPEN", oid: HEAD }), 0);
    const { seen, stop } = start([waiting(4242)], { intervalMs: 60_000 });
    await pollUntil(() => seen.length > 0, "a reading");
    stop();
    const [first, second] = (await gh.argvs()).map((argv) => argv.slice(4));
    const queryOf = (argv: readonly string[] | undefined): string =>
      argv?.find((arg) => arg.startsWith("query=")) ?? "";
    expect(queryOf(first)).not.toContain("isRequired");
    expect(queryOf(first)).not.toContain("b0:");
    expect(queryOf(second)).toContain("isRequired(pullRequestNumber:$n0)");
    expect(queryOf(second)).toContain("b0:");
    for (const argv of [first, second]) {
      expect(argv).toContain("o0=octo-org");
      expect(argv).toContain("n0=4242");
      expect(argv?.[(argv?.indexOf("n0=4242") ?? 0) - 1]).toBe("-F");
      for (const value of ["octo-org", "widgets", "4242"]) expect(queryOf(argv)).not.toContain(value);
    }
  });

  test("(l) a null blocked alias with its error still delivers the merge reading, warns nothing, and does not back off", async () => {
    const body = JSON.parse(reply({ state: "OPEN", blocked: null }, { state: "MERGED" }));
    body.errors = [{ type: "TIMEOUT", path: ["b0"], message: "slow" }];
    await gh.setReply(JSON.stringify(body), 1);
    const { seen, logs } = start([waiting(1), waiting(2)]);
    // Several polls at the plain interval: a backoff would double it each time.
    await pollUntil(() => seen.filter((s) => s.id === "t1").length >= 4, "four polls");
    expect(seen.find((s) => s.id === "t1")).toEqual({ id: "t1", url: prUrl(1), status: { state: "open", at: 1234 } });
    expect(seen.find((s) => s.id === "t2")).toEqual({ id: "t2", url: prUrl(2), status: { state: "merged", at: 1234 } });
    expect(logs.warn).toEqual([]);
    expect(logs.info).toEqual([]);
  });

  const blockedRunFails = async (stdout: string, code: number): Promise<void> => {
    await gh.setReply(reply({ state: "OPEN", oid: HEAD }, { state: "MERGED" }), 0);
    await gh.setBlockedReply(stdout, code);
    const { seen, logs } = start([waiting(1), waiting(2)]);
    await pollUntil(() => seen.filter((s) => s.id === "t1").length >= 3, "three polls");
    // The merge is written ahead of the open PR, whose blocked read it does not wait on.
    expect(seen.slice(0, 2).map((s) => [s.id, s.status])).toEqual([
      ["t2", { state: "merged", at: 1234 }],
      ["t1", { state: "open", at: 1234 }],
    ]);
    expect(seen.every((s) => s.status.head === undefined)).toBe(true);
    // A poll that ended in a failure class would warn `PR status paused` and back the next one off.
    expect(logs.warn).toHaveLength(1);
    expect(logs.warn[0]).toContain("blocked-state read");
    expect(logs.info).toEqual([]);
  };

  test("(n) a blocked run that prints garbage still delivers the merge reading, warns once however many polls, and is no failure of the poll", async () => {
    await blockedRunFails("not json", 0);
  });

  test("(n) a blocked run GitHub refuses (exit 1, errors and no data) does the same", async () => {
    await blockedRunFails(JSON.stringify({ errors: [{ type: "TIMEOUT", message: "slow" }] }), 1);
  });

  test("(o) a slow blocked read holds back only its own fields: a merge is written before it answers", async () => {
    await gh.setReply(reply({ state: "OPEN", oid: HEAD }, { state: "MERGED" }), 0);
    await gh.setBlockedReply(reply({ state: "OPEN", oid: HEAD }), 0, 1);
    const { seen, stop } = start([waiting(1), waiting(2)], { intervalMs: 60_000 });
    await pollUntil(() => seen.length > 0, "the first reading");
    expect(seen.map((s) => s.id)).toEqual(["t2"]);
    await pollUntil(() => seen.length >= 2, "the blocked reading", 5_000);
    stop();
    expect(seen[1]).toMatchObject({ id: "t1", status: { state: "open", head: HEAD } });
  });

  // Fifty-one targets are two merge chunks; the first holds the awaiting-merge task `t1`.
  const twoChunks = async (): Promise<Task[]> => {
    await gh.setReply(reply({ state: "OPEN", oid: HEAD }, ...Array.from({ length: 49 }, () => ({ state: "OPEN" }))), 0);
    return [waiting(1), ...Array.from({ length: 50 }, (_, i) => pr(i + 2))];
  };

  test("(p) a later chunk that fails still lets an earlier chunk's open PRs be written, without blocked fields", async () => {
    const tasks = await twoChunks();
    await gh.setCallReply(2, "not json", 0);
    const { seen, logs, stop } = start(tasks, { intervalMs: 60_000 });
    await pollUntil(() => logs.warn.length > 0, "the failed poll");
    stop();
    expect(logs.warn[0]).toContain("PR status paused (failed)");
    expect(seen).toHaveLength(50);
    expect(seen.find((s) => s.id === "t1")).toEqual({ id: "t1", url: prUrl(1), status: { state: "open", at: 1234 } });
    // The blocked run waits for a poll whose chunks all answered.
    expect(await gh.argvs()).toHaveLength(2);
  });

  test("(q) a rejected write in a later chunk still lets an earlier chunk's open PRs be written", async () => {
    const tasks = await twoChunks();
    const { seen, logs, stop } = start(tasks, { intervalMs: 60_000 }, new Set(["t51"]));
    await pollUntil(() => seen.some((s) => s.id === "t1"), "the open reading");
    stop();
    expect(seen.find((s) => s.id === "t1")?.status).toEqual({ state: "open", at: 1234 });
    expect(await gh.argvs()).toHaveLength(2);
    // The caller reports a rejected write; it says nothing of gh.
    expect(logs.warn).toEqual([]);
  });

  test("(m) twelve awaiting-merge open PRs take one merge run and two blocked runs", async () => {
    await gh.setReply(reply(...Array.from({ length: 12 }, () => ({ state: "OPEN", oid: HEAD }))), 0);
    const tasks = Array.from({ length: 12 }, (_, i) => waiting(i + 1));
    const { seen, stop } = start(tasks, { intervalMs: 60_000 });
    await pollUntil(() => seen.length >= 12, "twelve readings");
    stop();
    const runs = await gh.argvs();
    expect(runs).toHaveLength(3);
    // Each run keeps the chunk's own indices, so `b<i>` answers for `p<i>`.
    expect(runs[1]).toContain("n0=1");
    expect(runs[1]).toContain("n9=10");
    expect(runs[1]).not.toContain("n10=11");
    expect(runs[2]).toContain("n10=11");
    expect(runs[2]).toContain("n11=12");
    expect(seen.every((s) => s.status.head === HEAD)).toBe(true);
  });
});

describe("a successor waiting for its predecessor", () => {
  const successor = (n: number): Task =>
    pr(n, {
      id: "t-next",
      state: "blocked",
      spec: {
        repo: "github.com/octo-org/widgets",
        mode: "worktree",
        succeeds: {
          task: "t-old",
          account: "org:a",
          at: { deviceId: "dev-a", exclave: "default", clone: "w" },
          trigger: "manual",
        },
      },
    });

  test("its PR is read every poll, not once a term as a finished task's is", async () => {
    await gh.setReply(reply({ state: "OPEN" }), 0);
    const { seen } = start([successor(9)]);
    await pollUntil(() => seen.length >= 3, "three consecutive readings");
    expect(new Set(seen.map((s) => s.id))).toEqual(new Set(["t-next"]));
  });

  test("a plain blocked task with a PR is not read", async () => {
    await gh.setReply(reply({ state: "OPEN" }), 0);
    const plain = pr(9, { id: "t-plain", state: "blocked" });
    const { seen } = start([plain]);
    // A non-event cannot be polled for.
    await Bun.sleep(150);
    expect(seen).toEqual([]);
    expect(await gh.calls()).toBe(0);
  });
});

describe("readPrHead", () => {
  const head = (fields: Record<string, unknown>): string =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: { headRefName: "feature/x", isCrossRepository: false, state: "OPEN", isDraft: false, ...fields },
        },
      },
    });

  test("the head, whether it is a fork's, and the state; owner, repo and number reach gh as variables", async () => {
    await gh.setReply(head({}), 0);
    expect(await readPrHead(prUrl(42), { gh: stub.path })).toEqual({
      kind: "read",
      head: "feature/x",
      crossRepository: false,
      state: "open",
    });
    const argv = await gh.argv();
    expect(argv).toContain("o=octo-org");
    expect(argv).toContain("r=widgets");
    expect(argv).toContain("n=42");
    expect(argv.find((a) => a.startsWith("query="))).not.toContain("octo-org");
    await gh.setReply(head({ isCrossRepository: true, isDraft: true }), 0);
    expect(await readPrHead(prUrl(42), { gh: stub.path })).toMatchObject({ crossRepository: true, state: "draft" });
    await gh.setReply(head({ state: "MERGED" }), 0);
    expect(await readPrHead(prUrl(42), { gh: stub.path })).toMatchObject({ state: "merged" });
  });

  test("a URL that is not a pull request of this forge is skipped without asking gh", async () => {
    expect(await readPrHead("https://example.com/a/b/pull/1", { gh: stub.path })).toEqual({ kind: "skipped" });
    expect(await gh.calls()).toBe(0);
  });

  test("a head the repo would take as an option, a missing PR, an unknown state and a gh that fails are unreadable", async () => {
    for (const body of [
      head({ headRefName: "-oops" }),
      head({ headRefName: 7 }),
      head({ state: "SOMETHING_NEW" }),
      head({ isCrossRepository: "no" }),
      JSON.stringify({ data: { repository: { pullRequest: null } } }),
      "garbage",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one stub reply at a time
      await gh.setReply(body, 0);
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect(await readPrHead(prUrl(1), { gh: stub.path })).toEqual({ kind: "unreadable" });
    }
    await gh.setReply("{}", 4);
    expect(await readPrHead(prUrl(1), { gh: stub.path })).toEqual({ kind: "unreadable" });
    expect(await readPrHead(prUrl(1), { gh: join(base, "no-such-gh") })).toEqual({ kind: "unreadable" });
  });
});

describe("watched targets", () => {
  const BOOT = "00000000-0000-4000-8000-000000009000";
  const wid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const runUrl = (id: number): string => `https://github.com/octo-org/widgets/actions/runs/${id}`;
  const JOB = "https://github.com/octo-org/widgets/actions/runs/77/job/88";

  interface Entry {
    readonly id: number;
    readonly url: string;
    readonly kind?: "pr" | "run";
    readonly head?: string;
  }

  /** A real registry with a recording send; its set is accepted at `at`, and its watches are unread-suspended after `2 * intervalMs`. */
  function watching(entries: readonly Entry[], intervalMs = 60_000, at = 0) {
    const sent: { readonly events: readonly WatchEvent[] }[] = [];
    const registry = createWatchRegistry({
      send: (_to, request) => {
        sent.push(request);
        return Promise.resolve({ ok: true, delivered: request.events.map((e) => e.id) });
      },
      canReceive: () => true,
      intervalMs,
      log: { info: () => undefined, warn: () => undefined },
    });
    const set = parseWatchSet({
      gen: { boot: BOOT, n: 1 },
      watches: entries.map((e) => ({
        id: wid(e.id),
        kind: e.kind ?? "pr",
        url: e.url,
        seen: [],
        ...(e.head === undefined ? {} : { head: e.head }),
      })),
    });
    if (set === null) throw new Error("test set did not parse");
    registry.accept("dev", set, at);
    const events = (): WatchEvent[] => sent.flatMap((request) => request.events);
    return { registry, events };
  }

  const checksOn = (contexts: readonly unknown[], totalCount = contexts.length): Exclude<Fake, null> => ({
    state: "OPEN",
    oid: HEAD,
    headRefOid: HEAD,
    contexts,
    totalCount,
  });

  test("an open PR only a watch holds is read, and its passing checks reach the registry as one event", async () => {
    await gh.setReply(reply(checksOn([run("build", "SUCCESS", true, "COMPLETED", 1, 10)])), 0);
    const { registry, events } = watching([{ id: 1, url: prUrl(5) }]);
    const { seen, logs } = start([], { watches: registry });
    await pollUntil(() => events().length > 0, "the checks event");
    expect(events()[0]).toEqual({
      id: wid(1),
      key: `checks:${HEAD}:pass`,
      event: { kind: "checks", outcome: "pass", head: HEAD },
    });
    const argv = await gh.argv();
    expect(argv).toContain("n0=5");
    expect(argv.join(" ")).not.toContain(wid(1));
    expect(seen).toEqual([]);
    expect(logs.info).toEqual([]);
    expect(logs.warn).toEqual([]);
  });

  test("every failing context counts, required or not, and a failure names its job only in the watched repo", async () => {
    await gh.setReply(
      reply(
        checksOn([
          run("lint", "FAILURE", false, "COMPLETED", 2, 10, JOB),
          run(
            "deploy",
            "TIMED_OUT",
            false,
            "COMPLETED",
            3,
            10,
            "https://github.com/other/widgets/actions/runs/1/job/2",
          ),
          run("build", "SUCCESS", true, "COMPLETED", 4, 10),
        ]),
      ),
      0,
    );
    const { registry, events } = watching([{ id: 1, url: prUrl(5) }]);
    start([], { watches: registry });
    await pollUntil(() => events().length > 0, "the fail event");
    expect(events()[0]?.event).toEqual({
      kind: "checks",
      outcome: "fail",
      head: HEAD,
      failing: [{ name: "lint", job: { run: "77", job: "88" } }, { name: "deploy" }],
    });
  });

  test("the same check name in two suites is two contexts: one suite's success never hides the other's failure", async () => {
    await gh.setReply(
      reply(
        checksOn([run("test", "SUCCESS", true, "COMPLETED", 5, 10), run("test", "FAILURE", true, "COMPLETED", 6, 11)]),
      ),
      0,
    );
    const { registry, events } = watching([{ id: 1, url: prUrl(5) }]);
    start([], { watches: registry });
    await pollUntil(() => events().length > 0, "the fail event");
    expect(events()[0]?.event).toMatchObject({
      kind: "checks",
      outcome: "fail",
      failing: [{ name: "test", required: true }],
    });
  });

  test("pending contexts and a truncated list are no reading: nothing is sent until the head's checks are complete", async () => {
    await gh.setReply(reply(checksOn([run("build", null, true, "IN_PROGRESS", 1, 10)])), 0);
    const { registry, events } = watching([{ id: 1, url: prUrl(5) }]);
    start([], { watches: registry });
    await pollUntil(async () => (await gh.calls()) >= 4, "two polls");
    expect(events()).toEqual([]);

    await gh.setReply(reply(checksOn([run("build", "SUCCESS", true, "COMPLETED", 1, 10)], 80)), 0);
    const before = await gh.calls();
    await pollUntil(async () => (await gh.calls()) >= before + 4, "two polls of a truncated list");
    expect(events()).toEqual([]);

    await gh.setReply(reply(checksOn([run("build", "SUCCESS", true, "COMPLETED", 1, 10)])), 0);
    await pollUntil(() => events().length > 0, "the pass once the list is complete");
    expect(events()[0]?.event).toMatchObject({ kind: "checks", outcome: "pass" });
  });

  test("rollup of another commit than the head says nothing of it", async () => {
    await gh.setReply(
      reply({ ...checksOn([run("build", "SUCCESS", true, "COMPLETED", 1, 10)]), oid: "f".repeat(40) }),
      0,
    );
    const { registry, events } = watching([{ id: 1, url: prUrl(5) }]);
    start([], { watches: registry });
    await pollUntil(async () => (await gh.calls()) >= 4, "two polls");
    expect(events()).toEqual([]);
  });

  test("a conflict is an event of its own, from mergeStateStatus or mergeable", async () => {
    await gh.setReply(reply({ state: "OPEN", oid: HEAD, headRefOid: HEAD, mergeable: "CONFLICTING" }), 0);
    const { registry, events } = watching([{ id: 1, url: prUrl(5) }]);
    start([], { watches: registry });
    await pollUntil(() => events().length > 0, "the conflict event");
    expect(events()[0]?.event).toEqual({ kind: "conflict", head: HEAD });
  });

  test("a draft PR is read wide for a watch, so its checks are seen", async () => {
    await gh.setReply(reply({ ...checksOn([run("build", "SUCCESS", true, "COMPLETED", 1, 10)]), isDraft: true }), 0);
    const { registry, events } = watching([{ id: 1, url: prUrl(5) }]);
    start([], { watches: registry });
    await pollUntil(() => events().length > 0, "the draft's checks event");
    expect(events()[0]?.event).toMatchObject({ kind: "checks", outcome: "pass" });
  });

  test("merged and closed PRs end as their own events", async () => {
    await gh.setReply(reply({ state: "MERGED" }, { state: "CLOSED" }), 0);
    // One slice answers p0 and p1 from one body.
    const { registry, events } = watching([
      { id: 1, url: prUrl(5) },
      { id: 2, url: prUrl(6) },
    ]);
    start([], { watches: registry });
    await pollUntil(() => events().length >= 2, "both events");
    expect(events().map((e) => [e.id, e.event.kind])).toEqual([
      [wid(1), "merged"],
      [wid(2), "closed"],
    ]);
  });

  test("a PR the forge answers null for is unreadable only from its second poll", async () => {
    await gh.setReply(reply(null), 0);
    const { registry, events } = watching([{ id: 1, url: prUrl(5) }]);
    start([], { watches: registry });
    await pollUntil(() => events().length > 0, "the unreadable event");
    // The first null went unsent: the event came on a later poll.
    expect(await gh.calls()).toBeGreaterThanOrEqual(2);
    expect(events()[0]?.event).toEqual({ kind: "unreadable" });
  });

  test("a PR a task also holds is read once, in the task's chunk, and the task's status is what it was without the watch", async () => {
    const body = reply({
      state: "OPEN",
      oid: HEAD,
      headRefOid: HEAD,
      contexts: [run("build", "SUCCESS", true, "COMPLETED", 1, 10)],
      totalCount: 1,
    });
    const task = pr(5, { state: "awaiting-merge" });

    await gh.setReply(body, 0);
    const alone = start([task]);
    await pollUntil(() => alone.seen.length > 0, "the task's own reading");
    alone.stop();

    gh = await stub.fresh();
    await gh.setReply(body, 0);
    const { registry, events } = watching([{ id: 1, url: prUrl(5) }]);
    const both = start([task], { watches: registry });
    await pollUntil(() => events().length > 0 && both.seen.length > 0, "both readings");
    expect(both.seen[0]?.status).toEqual(alone.seen[0]?.status);
    expect(events()[0]?.event).toMatchObject({ kind: "checks", outcome: "pass" });
    // One merge read and one blocked read for the one PR: the watch asked for nothing of its own.
    expect((await gh.argvs()).slice(0, 2).every((argv) => argv.includes("n0=5") && !argv.includes("n1=5"))).toBe(true);
  });

  test("a task's draft PR stays unread by the blocked query when only a watch would want it", async () => {
    await gh.setReply(reply({ ...checksOn([run("build", "SUCCESS", true, "COMPLETED", 1, 10)]), isDraft: true }), 0);
    const { seen } = start([pr(5, { state: "awaiting-merge" })]);
    await pollUntil(() => seen.length > 0, "the task's reading");
    expect(seen[0]?.status).toEqual({ state: "draft", at: 1234 });
  });

  test("watch-only PRs are read after every task read, and a watch's failed read changes no task's reading or the poller's class", async () => {
    // Calls 1 and 2 are the task's merge and blocked reads; 3 is the watch-only PR's merge read, which fails.
    await gh.setReply(
      reply({ state: "OPEN", oid: HEAD, contexts: [run("build", "SUCCESS", true, "COMPLETED", 1)] }),
      0,
    );
    // The watch-only read fails in each of the first three polls (calls 3, 6 and 9).
    for (const call of [3, 6, 9]) await gh.setCallReply(call, "{}", 1);
    const { registry } = watching([{ id: 1, url: prUrl(6) }]);
    const { seen, logs } = start([pr(5, { state: "awaiting-merge" })], { watches: registry });
    // The fourth poll starts only after the third's failure was handled (a class entered would have warned by then).
    await pollUntil(async () => (await gh.calls()) >= 10, "the fourth poll");
    expect(seen[0]).toMatchObject({ id: "t5", url: prUrl(5), status: { state: "open", required: "passing" } });
    const argvs = await gh.argvs();
    expect(argvs[0]).toContain("n0=5");
    expect(argvs[1]).toContain("n0=5");
    expect(argvs[2]).toContain("n0=6");
    expect(logs.warn).toEqual([]);
  });

  test("a watch's failed blocked read on a PR of a task that needs none is no task-facing warning", async () => {
    await gh.setReply(reply({ state: "OPEN", oid: HEAD }), 0);
    await gh.setBlockedReply("not json", 0);
    const { registry } = watching([{ id: 1, url: prUrl(5) }]);
    const reported = pr(5, { state: "awaiting-merge", spec: { repo: "r", mode: "worktree", until: "reported" } });
    const { logs } = start([reported], { watches: registry });
    // Each poll is a merge read and the watch's blocked read: the third starts after the first two failed and were handled.
    await pollUntil(async () => (await gh.calls()) >= 5, "the third poll");
    expect(logs.warn).toEqual([]);
  });

  test("under the reserve a watch on a PR a task reads still hears it merge, and asks for nothing more", async () => {
    const reset = Date.now() + 600_000;
    const low = (state: string): string => {
      const body = JSON.parse(reply({ state }));
      body.data.rateLimit = { cost: 1, remaining: 100, resetAt: new Date(reset).toISOString() };
      return JSON.stringify(body);
    };
    await gh.setReply(low("OPEN"), 0);
    const { registry, events } = watching([{ id: 1, url: prUrl(5) }], 3_600_000, Date.now());
    const { logs } = start([pr(5)], { watches: registry, now: () => Date.now() });
    await pollUntil(() => logs.warn.length === 1, "the reserve warning");
    await gh.setReply(low("MERGED"), 0);
    await pollUntil(() => events().some((e) => e.event.kind === "merged"), "the merge told under the reserve");
    expect(logs.warn).toHaveLength(1);
    expect(logs.info.some((line) => line.includes("recovered"))).toBe(false);
  });

  test("the poller's clock says whether a poll is in flight, so a slow poll suspends nothing", async () => {
    await gh.setReply(reply({ state: "OPEN" }), 0, 1);
    const target = parseGithubPr(prUrl(5));
    if (target === null) throw new Error("test PR did not parse");
    const ticks: (boolean | undefined)[] = [];
    const watches: PollerWatches = {
      wanted: () => ({ prs: [{ key: "pr:octo-org/widgets#5", pr: target }], runs: [] }),
      read: () => undefined,
      tick: (_now, _reason, _resetAt, polling) => void ticks.push(polling),
    };
    start([], { watches });
    await pollUntil(() => ticks.length >= 3, "ticks during the first poll");
    expect(ticks.every((polling) => polling === true)).toBe(true);
  });

  test("a watched run's attempt and conclusion are an event, and a failing one names its jobs", async () => {
    await gh.setReply(
      JSON.stringify({
        data: {
          w0: {
            databaseId: 99,
            runAttempt: 2,
            checkSuite: {
              status: "COMPLETED",
              conclusion: "FAILURE",
              checkRuns: {
                nodes: [
                  { __typename: "CheckRun", name: "unit", conclusion: "FAILURE", databaseId: 3, detailsUrl: JOB },
                  { __typename: "CheckRun", name: "lint", conclusion: "SUCCESS", databaseId: 4 },
                ],
              },
            },
          },
        },
      }),
      0,
    );
    const { registry, events } = watching([{ id: 1, kind: "run", url: runUrl(99) }]);
    start([], { watches: registry });
    await pollUntil(() => events().length > 0, "the completed event");
    expect(events()[0]?.event).toEqual({
      kind: "completed",
      attempt: 2,
      conclusion: "failure",
      failing: [{ name: "unit", job: { run: "77", job: "88" } }],
    });
    const argv = await gh.argv();
    expect(argv).toContain(`u0=${runUrl(99)}`);
    expect(argv.find((a) => a.startsWith("query="))).not.toContain("99");
  });

  test("a run still going is not an event", async () => {
    await gh.setReply(
      JSON.stringify({
        data: { w0: { databaseId: 99, runAttempt: 1, checkSuite: { status: "IN_PROGRESS", conclusion: null } } },
      }),
      0,
    );
    const { registry, events } = watching([{ id: 1, kind: "run", url: runUrl(99) }]);
    start([], { watches: registry });
    await pollUntil(async () => (await gh.calls()) >= 2, "two polls");
    expect(events()).toEqual([]);
  });

  test("a run read is no poll failure: a failing run query leaves the tasks' reads, class and logs alone", async () => {
    await gh.setReply(reply({ state: "OPEN" }), 0);
    // The run read is the second call of each of the first three polls.
    for (const call of [2, 4, 6]) await gh.setCallReply(call, "{}", 1);
    const { registry } = watching([{ id: 1, kind: "run", url: runUrl(99) }]);
    const { seen, logs } = start([pr(5)], { watches: registry });
    // The fourth poll starts only after the third's failure was handled.
    await pollUntil(async () => (await gh.calls()) >= 7, "the fourth poll");
    expect(seen[0]).toMatchObject({ id: "t5", status: { state: "open" } });
    expect(logs.warn).toEqual([]);
  });

  test("a GitHub budget under the reserve reads tasks only, says so once without a URL, and reads watches again past it", async () => {
    const reset = Date.now() + 600_000;
    const low = JSON.parse(reply({ state: "OPEN" }));
    low.data.rateLimit = { cost: 1, remaining: 100, resetAt: new Date(reset).toISOString() };
    await gh.setReply(JSON.stringify(low), 0);
    // A set lives 15 minutes and a watch unread for two intervals is suspended: neither may end the test early.
    const { registry, events } = watching([{ id: 1, url: prUrl(6) }], 3_600_000, Date.now());
    let now = Date.now();
    const { logs, seen } = start([pr(5)], { watches: registry, now: () => now });
    await pollUntil(() => logs.warn.length === 1, "the reserve warning");
    expect(logs.warn[0]).toContain("(reserve)");
    expect(logs.warn[0]).not.toContain(prUrl(6));
    // The budget is unknown until the first answer, so the first poll read the watch too; a non-event cannot be polled
    // for, so give the later polls time to (wrongly) name it again.
    const named = async (n: number): Promise<number> =>
      (await gh.argvs()).filter((argv) => argv.includes(`n0=${n}`)).length;
    const watchReads = await named(6);
    const taskReads = await named(5);
    await pollUntil(async () => (await named(5)) > taskReads, "a later task read under the reserve");
    // A negative: the sleep gives a (wrong) watch read of that poll time to land.
    await Bun.sleep(150);
    expect(await named(6)).toBe(watchReads);
    expect(logs.warn).toHaveLength(1);
    expect(seen.length).toBeGreaterThan(0);

    const calls = await gh.calls();
    now = reset + 1;
    await gh.setReply(reply({ state: "MERGED" }), 0);
    await pollUntil(() => events().length > 0, "the watch read after the reset");
    expect(await gh.calls()).toBeGreaterThan(calls);
    expect(logs.info.some((line) => line.includes("recovered"))).toBe(true);
  });

  test("a watch unread for two intervals is suspended `failed`, from the poller's own clock", async () => {
    await gh.setReply("{}", 1);
    const { registry, events } = watching([{ id: 1, url: prUrl(5) }], 50, Date.now());
    const { logs } = start([], { watches: registry, now: () => Date.now() });
    await pollUntil(() => events().length > 0, "the suspension");
    expect(events()[0]?.event).toMatchObject({ kind: "suspended", reason: "failed" });
    expect(JSON.stringify(logs)).not.toContain(prUrl(5));
  });

  test("a spent budget parks the poll chain, and the clock still suspends the watch `limited` with the reset", async () => {
    const reset = Date.now() + 3_600_000;
    await gh.setReply(
      JSON.stringify({
        errors: [
          {
            type: "RATE_LIMITED",
            code: "graphql_rate_limit",
            message: "API rate limit already exceeded for user ID 77.",
          },
        ],
      }),
      1,
    );
    const { registry, events } = watching([{ id: 1, url: prUrl(5) }], 50, Date.now());
    start([], { watches: registry, now: () => Date.now(), graphqlReset: () => reset, random: () => 0 });
    await pollUntil(() => events().length > 0, "the suspension");
    expect(events()[0]?.event).toMatchObject({ kind: "suspended", reason: "limited", resetAt: reset });
    // The chain is parked until the reset: one run of gh, however long the clock ran.
    expect(await gh.calls()).toBe(1);
  });

  test("with no registry a poll reads exactly what it did before: no watch query, no clock", async () => {
    await gh.setReply(reply({ state: "OPEN" }), 0);
    const { seen } = start([pr(5)]);
    await pollUntil(() => seen.length > 0, "the task's reading");
    for (const argv of await gh.argvs()) expect(argv.find((a) => a.startsWith("query="))).not.toContain("resource(");
  });
});
