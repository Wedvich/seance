import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quote, type PrStatus } from "@seance/shared";
import type { Task } from "../src/leader.ts";
import { parseGithubPr, startPrPoller, type PrPollerOpts } from "../src/pr-status.ts";
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
} | null;

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
              commits: {
                nodes: [{ commit: { statusCheckRollup: fake.rollup === undefined ? null : { state: fake.rollup } } }],
              },
            },
    };
  });
  return JSON.stringify({ data });
}

interface Seen {
  readonly id: string;
  readonly url: string;
  readonly status: PrStatus;
}

function start(tasks: readonly Task[], opts: PrPollerOpts = {}) {
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
  test("a URL that is not a GitHub PR, one too big for GraphQL's Int, a finished task already read and a task with no PR never reach gh", async () => {
    await gh.setReply(reply({ state: "OPEN" }), 0);
    const { seen } = start([
      pr(1, { id: "gitlab", prUrl: "https://gitlab.com/octo-org/widgets/pull/1" }),
      pr(1, { id: "files", prUrl: `${prUrl(1)}/files` }),
      pr(1, { id: "big", prUrl: prUrl(99_999_999_999) }),
      pr(1, { id: "done", state: "done", pr: { state: "open", at: 1 } }),
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

  test("with nothing to poll gh never runs", async () => {
    const { seen } = start([
      pr(1, { prUrl: "https://gitlab.com/octo-org/widgets/pull/1" }),
      pr(2, { state: "cancelled", pr: { state: "closed", at: 1 } }),
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
