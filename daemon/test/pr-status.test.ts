import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quote, type PrStatus } from "@seance/shared";
import type { Task } from "../src/leader.ts";
import { parseGithubPr, readPrHead, startPrPoller, type PrPollerOpts } from "../src/pr-status.ts";
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
  readonly autoMerge?: boolean;
  readonly inMergeQueue?: boolean;
  readonly reviewRequests?: number;
  readonly blocked?: null;
} | null;

const HEAD = "0123456789abcdef0123456789abcdef01234567";

/** A required (or not) CheckRun as the blocked read returns it. */
function run(name: string, conclusion: string | null, required = true, status = "COMPLETED"): unknown {
  return { __typename: "CheckRun", name, status, conclusion, isRequired: required };
}

function statusContext(context: string, state: string, required = true): unknown {
  return { __typename: "StatusContext", context, state, isRequired: required };
}

function wideOf(fake: Exclude<Fake, null>): boolean {
  return (
    fake.oid !== undefined ||
    fake.contexts !== undefined ||
    fake.mergeStateStatus !== undefined ||
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
                isInMergeQueue: fake.inMergeQueue ?? false,
                autoMergeRequest: fake.autoMerge === true ? { enabledAt: "2026-11-12T00:00:00Z" } : null,
                reviewRequests: { totalCount: fake.reviewRequests ?? 0 },
                commits: {
                  nodes: [
                    {
                      commit: {
                        oid: fake.oid ?? HEAD,
                        statusCheckRollup: fake.contexts === undefined ? null : { contexts: { nodes: fake.contexts } },
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
function start(tasks: readonly Task[], opts: PrPollerOpts = {}, rejects: ReadonlySet<string> = new Set()) {
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
    now: () => 1234,
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
