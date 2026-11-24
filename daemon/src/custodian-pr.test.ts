import { describe, expect, test } from "bun:test";
import { createPrReader, PR_CACHE_MAX, PR_CACHE_TTL_MS } from "./custodian-pr.ts";
import type { GhAnswer } from "./gh.ts";

const URL_1 = "https://github.com/Owner/repo/pull/12";

const run = (name: string, status: string, conclusion: unknown): unknown => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
});

const pullRequest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: "APPROVED",
  autoMergeRequest: { enabledAt: "2026-11-14T00:00:00Z" },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: "PENDING",
            contexts: {
              nodes: [
                run("build", "COMPLETED", "SUCCESS"),
                run("lint", "IN_PROGRESS", null),
                { __typename: "StatusContext", context: "ci/legacy", state: "FAILURE" },
              ],
            },
          },
        },
      },
    ],
  },
  ...over,
});

const ok = (pr: unknown): GhAnswer => ({
  kind: "ok",
  body: { data: { repository: { pullRequest: pr } } },
  data: { repository: { pullRequest: pr } },
});

interface Rig {
  readonly read: ReturnType<typeof createPrReader>;
  readonly asked: { query: string; variables: readonly string[] }[];
  readonly clock: { now: number };
  answer: GhAnswer;
}

function rig(): Rig {
  const asked: Rig["asked"] = [];
  const clock = { now: 1_000_000 };
  const r: Rig = {
    asked,
    clock,
    answer: ok(pullRequest()),
    read: createPrReader({
      now: () => clock.now,
      ask: (_opts, query, variables) => {
        asked.push({ query, variables });
        return Promise.resolve(r.answer);
      },
    }),
  };
  return r;
}

describe("createPrReader", () => {
  test("asks one constant query with owner, name and number as variables, and maps the answer", async () => {
    const r = rig();
    const view = await r.read(URL_1);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]?.variables).toEqual(["-f", "o=Owner", "-f", "r=repo", "-F", "n=12"]);
    // The URL's text never reaches the query.
    expect(r.asked[0]?.query).not.toContain("Owner");
    expect(r.asked[0]?.query).not.toContain("repo/pull");
    expect(view).toEqual({
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      reviewDecision: "APPROVED",
      autoMerge: true,
      checks: {
        state: "PENDING",
        contexts: [
          { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "lint", status: "IN_PROGRESS", conclusion: null },
          { name: "ci/legacy", status: null, conclusion: "FAILURE" },
        ],
      },
      readAt: r.clock.now,
    });
  });

  test("no auto-merge request and no checks configured are an empty answer, not an error", async () => {
    const r = rig();
    r.answer = ok(
      pullRequest({
        autoMergeRequest: null,
        reviewDecision: null,
        commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
      }),
    );
    expect(await r.read(URL_1)).toMatchObject({
      autoMerge: false,
      reviewDecision: null,
      checks: { state: null, contexts: [] },
    });
  });

  test("a URL that is not a GitHub PR is unreadable and asks nothing", async () => {
    const r = rig();
    for (const url of ["https://example.com/o/r/pull/1", "https://github.com/o/r/pull/1/files", "not a url"]) {
      expect(await r.read(url)).toBe("unreadable");
    }
    expect(r.asked).toEqual([]);
  });

  test("a failed, signed-out or missing gh, and a PR the token cannot see, are unreadable", async () => {
    for (const answer of [
      { kind: "failed" },
      { kind: "unauthenticated" },
      { kind: "missing" },
      ok(null),
    ] as const satisfies readonly GhAnswer[]) {
      const r = rig();
      r.answer = answer;
      expect(await r.read(URL_1)).toBe("unreadable");
    }
  });

  test("an answer of another shape is unreadable, never half a view", async () => {
    for (const pr of [
      pullRequest({ state: 5 }),
      pullRequest({ isDraft: "no" }),
      pullRequest({ mergeable: 1 }),
      pullRequest({ commits: "x" }),
      pullRequest({
        commits: {
          nodes: [
            { commit: { statusCheckRollup: { state: "PENDING", contexts: { nodes: [{ __typename: "Other" }] } } } },
          ],
        },
      }),
      pullRequest({
        commits: {
          nodes: [{ commit: { statusCheckRollup: { state: "PENDING", contexts: { nodes: [run("a", "x", 3)] } } } }],
        },
      }),
    ]) {
      const r = rig();
      r.answer = ok(pr);
      expect(await r.read(URL_1)).toBe("unreadable");
    }
  });

  test("a closed PR with a failed check keeps the PR's state apart from the checks'", async () => {
    // The round's red-CI case keys on the PR's own `state`: a closed PR's failed checks never earn a nudge.
    const r = rig();
    r.answer = ok(pullRequest({ state: "CLOSED" }));
    const view = await r.read(URL_1);
    expect(view).toMatchObject({ state: "CLOSED", checks: { state: "PENDING" } });
    expect(view === "unreadable" ? [] : view.checks.contexts).toContainEqual({
      name: "ci/legacy",
      status: null,
      conclusion: "FAILURE",
    });
  });

  test("an answer is cached for the TTL and read again after it", async () => {
    const r = rig();
    const first = await r.read(URL_1);
    r.clock.now += PR_CACHE_TTL_MS - 1;
    expect(await r.read(URL_1)).toBe(first);
    expect(r.asked).toHaveLength(1);
    r.clock.now += 1;
    r.answer = ok(pullRequest({ state: "MERGED" }));
    expect(await r.read(URL_1)).toMatchObject({ state: "MERGED" });
    expect(r.asked).toHaveLength(2);
  });

  test("an unreadable answer is not cached", async () => {
    const r = rig();
    r.answer = { kind: "failed" };
    expect(await r.read(URL_1)).toBe("unreadable");
    r.answer = ok(pullRequest());
    expect(await r.read(URL_1)).toMatchObject({ state: "OPEN" });
    expect(r.asked).toHaveLength(2);
  });

  test("the cache holds PR_CACHE_MAX entries and drops the oldest", async () => {
    const r = rig();
    const url = (n: number): string => `https://github.com/o/r/pull/${n}`;
    for (let n = 1; n <= PR_CACHE_MAX + 1; n += 1) await r.read(url(n));
    expect(r.asked).toHaveLength(PR_CACHE_MAX + 1);
    // The newest is still cached, the first was evicted.
    await r.read(url(PR_CACHE_MAX + 1));
    expect(r.asked).toHaveLength(PR_CACHE_MAX + 1);
    await r.read(url(1));
    expect(r.asked).toHaveLength(PR_CACHE_MAX + 2);
  });
});
