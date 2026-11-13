import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/exec.ts";
import { githubRepoOf, nothingLost, type GithubRepo, type NothingLostInput } from "../src/reap-git.ts";
import { addWorktree, makeGhStub, makeGitFixture, type GhRun, type GhStub, type GitFixture } from "./fixtures.ts";

const GIT_ID = ["-c", "user.email=test@seance.local", "-c", "user.name=Seance Test"];
// Names that cannot appear in the query text by accident.
const GITHUB: GithubRepo = { owner: "octo-org", name: "widgets" };

let base: string;
let stub: GhStub;
let gh: GhRun;
let fixtures = 0;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-nothing-lost-"));
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  stub = await makeGhStub(base);
});

beforeEach(async () => {
  gh = await stub.fresh();
});

afterAll(async () => {
  delete process.env["GIT_CONFIG_GLOBAL"];
  delete process.env["GIT_CONFIG_NOSYSTEM"];
  await rm(base, { recursive: true, force: true });
});

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const result = await exec(["git", ...GIT_ID, ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function commit(cwd: string, file: string, text = `${file}\n`): Promise<string> {
  await writeFile(join(cwd, file), text);
  await git(cwd, "add", file);
  await git(cwd, "commit", "-q", "-m", `edit ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

interface Setup {
  readonly fixture: GitFixture;
  readonly worktree: string;
  readonly branch: string;
}

async function setup(name: string): Promise<Setup> {
  fixtures += 1;
  const fixture = await makeGitFixture(join(base, `f${fixtures}`));
  const worktree = join(fixture.repoPath, ".claude", "worktrees", name);
  await addWorktree(fixture.repoPath, worktree);
  return { fixture, worktree, branch: `wt-${name}` };
}

/** A throwaway clone of origin, as another machine or GitHub's own merge would push from. */
async function server(fixture: GitFixture): Promise<string> {
  fixtures += 1;
  const path = join(base, `server-${fixtures}`);
  await git(base, "clone", "-q", fixture.barePath, path);
  return path;
}

function input(s: Setup, tip: string, overrides: Partial<NothingLostInput> = {}): NothingLostInput {
  return {
    repoPath: s.fixture.repoPath,
    worktree: s.worktree,
    tip,
    branch: s.branch,
    github: GITHUB,
    fetch: true,
    gh: stub.path,
    ...overrides,
  };
}

interface FakePr {
  readonly number: number;
  readonly oid: string;
  readonly cross?: boolean;
}

function merged(prs: readonly FakePr[], totalCount = prs.length): string {
  const nodes = prs.map((pr) => ({ number: pr.number, headRefOid: pr.oid, isCrossRepository: pr.cross ?? false }));
  return JSON.stringify({ data: { repository: { pullRequests: { totalCount, nodes } } } });
}

describe("nothingLost (real git, stub gh)", () => {
  test("a pushed tip level with its branch on origin is safe without asking GitHub", async () => {
    const s = await setup("level");
    const tip = await commit(s.worktree, "work.txt");
    await git(s.worktree, "push", "-q", "-u", "origin", s.branch);
    // Ignored files don't make a tree dirty.
    await appendFile(join(s.fixture.repoPath, ".git", "info", "exclude"), ".env\n");
    await writeFile(join(s.worktree, ".env"), "SECRET=1\n");

    expect(await nothingLost(input(s, tip))).toEqual({ kind: "safe", how: "origin" });
    expect(await gh.calls()).toBe(0);
  });

  test("a tip origin has moved past is safe once the newer tip is fetched; a dry run cannot fetch it", async () => {
    const s = await setup("behind");
    const tip = await commit(s.worktree, "work.txt");
    await git(s.worktree, "push", "-q", "-u", "origin", s.branch);
    const other = await server(s.fixture);
    await git(other, "switch", "-q", s.branch);
    await commit(other, "more.txt");
    await git(other, "push", "-q", "origin", s.branch);
    await gh.setReply(merged([]), 0);

    expect(await nothingLost(input(s, tip, { fetch: false }))).toEqual({ kind: "unknown", why: "fetch-skipped" });
    expect(await nothingLost(input(s, tip))).toEqual({ kind: "safe", how: "origin" });
  });

  test("squash-merged, its branch deleted, main edited the same lines since: a merged PR whose head is the tip passes", async () => {
    const s = await setup("sq");
    const tip = await commit(s.worktree, "README.md", "# squashed change\n");
    await git(s.worktree, "push", "-q", "-u", "origin", s.branch);
    const merger = await server(s.fixture);
    await git(merger, "merge", "--squash", `origin/${s.branch}`);
    await git(merger, "commit", "-q", "-m", "squash (#7)");
    await git(merger, "push", "-q", "origin", "main", `:${s.branch}`);
    await commit(merger, "README.md", "# edited again\n");
    await git(merger, "push", "-q", "origin", "main");
    await gh.setReply(merged([{ number: 7, oid: tip }]), 0);

    expect(await nothingLost(input(s, tip))).toEqual({ kind: "safe", how: "pr" });
    const argv = await gh.argv();
    expect(argv).toEqual(expect.arrayContaining(["-f", "o=octo-org", "-f", "r=widgets", "-f", `h=${s.branch}`]));
    const query = argv.find((word) => word.startsWith("query=")) ?? "";
    for (const value of ["octo-org", "widgets", s.branch]) expect(query).not.toContain(value);
  });

  test("a merged PR whose head is past the tip passes once that head is fetched from refs/pull/<n>/head", async () => {
    const s = await setup("ahead");
    const tip = await commit(s.worktree, "work.txt");
    await git(s.worktree, "push", "-q", "-u", "origin", s.branch);
    const other = await server(s.fixture);
    await git(other, "switch", "-q", s.branch);
    const head = await commit(other, "review-fix.txt");
    await git(other, "push", "-q", "origin", `${s.branch}:refs/pull/3/head`, `:${s.branch}`);
    await gh.setReply(merged([{ number: 3, oid: head }]), 0);

    expect(await nothingLost(input(s, tip))).toEqual({ kind: "safe", how: "pr" });
  });

  test("a dirty tree fails, tracked change or untracked file alike", async () => {
    const s = await setup("dirty");
    const tip = await commit(s.worktree, "work.txt");
    await git(s.worktree, "push", "-q", "-u", "origin", s.branch);

    await writeFile(join(s.worktree, "notes.txt"), "untracked\n");
    expect(await nothingLost(input(s, tip))).toEqual({ kind: "fails", why: "dirty", changes: 1 });
    await rm(join(s.worktree, "notes.txt"));
    await writeFile(join(s.worktree, "work.txt"), "changed\n");
    expect(await nothingLost(input(s, tip, { merged: "ancestor" }))).toEqual({
      kind: "fails",
      why: "dirty",
      changes: 1,
    });
  });

  test("commits past origin's branch with no merged PR holding them fail unpushed; a fork's PR is not this branch", async () => {
    const s = await setup("unpushed");
    await commit(s.worktree, "pushed.txt");
    await git(s.worktree, "push", "-q", "-u", "origin", s.branch);
    const tip = await commit(s.worktree, "local-only.txt");
    await gh.setReply(merged([{ number: 9, oid: tip, cross: true }]), 0);

    expect(await nothingLost(input(s, tip))).toEqual({ kind: "fails", why: "unpushed" });
  });

  test("a never-pushed branch with no merged PR fails unpushed; a detached tip has nothing to bind to", async () => {
    const s = await setup("local");
    const tip = await commit(s.worktree, "local.txt");
    await gh.setReply(merged([]), 0);

    expect(await nothingLost(input(s, tip))).toEqual({ kind: "fails", why: "unpushed" });
    expect(await nothingLost(input(s, tip, { branch: null }))).toEqual({ kind: "fails", why: "unpushed" });
  });

  test("an origin that can't be reached is unknown, never a failure", async () => {
    const s = await setup("offline");
    const tip = await commit(s.worktree, "work.txt");
    await git(s.fixture.repoPath, "remote", "set-url", "origin", join(base, "no-such-origin.git"));
    await gh.setReply(merged([]), 0);

    expect(await nothingLost(input(s, tip))).toEqual({ kind: "unknown", why: "remote" });
  });

  test("gh failing, unauthenticated, partial or with merged PRs it didn't list is unknown", async () => {
    const s = await setup("forge");
    const tip = await commit(s.worktree, "work.txt");

    await gh.setReply("not json", 1);
    expect(await nothingLost(input(s, tip))).toEqual({ kind: "unknown", why: "forge" });
    await gh.setReply("", 4);
    expect(await nothingLost(input(s, tip))).toEqual({ kind: "unknown", why: "forge" });
    await gh.setReply(merged([], 25), 0);
    expect(await nothingLost(input(s, tip))).toEqual({ kind: "unknown", why: "forge" });
    // Errors beside data: the empty `nodes` is not a complete negative.
    await gh.setReply(
      JSON.stringify({
        data: { repository: { pullRequests: { totalCount: 0, nodes: [] } } },
        errors: [{ message: "timeout on a sub-field" }],
      }),
      0,
    );
    expect(await nothingLost(input(s, tip))).toEqual({ kind: "unknown", why: "forge" });
    await gh.setReply(JSON.stringify({ data: { repository: null } }), 1);
    expect(await nothingLost(input(s, tip))).toEqual({ kind: "unknown", why: "forge" });
    expect(await nothingLost(input(s, tip, { gh: join(base, "no-such-gh") }))).toEqual({
      kind: "unknown",
      why: "forge",
    });
  });

  test("a non-GitHub origin has no PR to ask: what it lacks fails unpushed, what it can't answer is unknown", async () => {
    const s = await setup("gitlab");
    const tip = await commit(s.worktree, "work.txt");
    await gh.setReply(merged([]), 0);

    expect(await nothingLost(input(s, tip, { github: null }))).toEqual({ kind: "fails", why: "unpushed" });
    await git(s.fixture.repoPath, "remote", "set-url", "origin", join(base, "no-such-origin.git"));
    expect(await nothingLost(input(s, tip, { github: null }))).toEqual({ kind: "unknown", why: "remote" });
    expect(await gh.calls()).toBe(0);
  });

  test("remote: false skips origin and GitHub for an unmerged tip but still fails a dirty tree", async () => {
    const s = await setup("down");
    const tip = await commit(s.worktree, "work.txt");
    await git(s.worktree, "push", "-q", "-u", "origin", s.branch);

    expect(await nothingLost(input(s, tip, { remote: false }))).toEqual({ kind: "unknown", why: "remote" });
    expect(await nothingLost(input(s, tip, { remote: false, merged: "ancestor" }))).toEqual({
      kind: "safe",
      how: "ancestor",
    });
    await writeFile(join(s.worktree, "notes.txt"), "untracked\n");
    expect(await nothingLost(input(s, tip, { remote: false }))).toEqual({ kind: "fails", why: "dirty", changes: 1 });
    expect(await gh.calls()).toBe(0);
  });

  test("a merged PR whose refs/pull/<n>/head can't be fetched is unknown, never a failure; a dry run says it skipped the fetch", async () => {
    const s = await setup("nopull");
    const tip = await commit(s.worktree, "work.txt");
    await gh.setReply(merged([{ number: 5, oid: "1".repeat(40) }]), 0);

    expect(await nothingLost(input(s, tip))).toEqual({ kind: "unknown", why: "remote" });
    expect(await nothingLost(input(s, tip, { fetch: false }))).toEqual({ kind: "unknown", why: "fetch-skipped" });
  });

  test("only the exact refs/heads/<branch> on origin counts, not a ref that merely ends in it", async () => {
    const s = await setup("exact");
    const tip = await commit(s.worktree, "work.txt");
    await git(s.worktree, "push", "-q", "origin", `${tip}:refs/heads/x/refs/heads/${s.branch}`);
    await gh.setReply(merged([]), 0);

    expect(await nothingLost(input(s, tip))).toEqual({ kind: "fails", why: "unpushed" });
  });

  test("more than one page of merged PRs: a matching head among those read still passes", async () => {
    const s = await setup("paged");
    const tip = await commit(s.worktree, "work.txt");
    await gh.setReply(merged([{ number: 11, oid: tip }], 25), 0);

    expect(await nothingLost(input(s, tip))).toEqual({ kind: "safe", how: "pr" });
  });
});

describe("githubRepoOf", () => {
  test("binds only github.com/<owner>/<name>", () => {
    expect(githubRepoOf("github.com/octo-org/widgets")).toEqual({ owner: "octo-org", name: "widgets" });
    expect(githubRepoOf("github.com/octo-org/widgets.js")).toEqual({ owner: "octo-org", name: "widgets.js" });
    for (const key of [
      null,
      "gitlab.com/a/b",
      "github.com/a",
      "github.com/a/b/c",
      "github.com:22/a/b",
      "x/github.com/a/b",
    ]) {
      expect(githubRepoOf(key)).toBeNull();
    }
  });
});
