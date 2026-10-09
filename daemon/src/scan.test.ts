import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
import { addWorktree, makeClone } from "../test/fixtures.ts";
import { readDefaultBranch, repoSetsEqual, scanRepos } from "./scan.ts";

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "seance-scan-"));
  cleanups.push(dir);
  return dir;
}

async function makeRepo(root: string, rel: string, defaultBranch?: string): Promise<string> {
  const repo = join(root, rel);
  await mkdir(join(repo, ".git"), { recursive: true });
  if (defaultBranch !== undefined) {
    const originDir = join(repo, ".git", "refs", "remotes", "origin");
    await mkdir(originDir, { recursive: true });
    await writeFile(join(originDir, "HEAD"), `ref: refs/remotes/origin/${defaultBranch}\n`);
  }
  // scan stores canonical paths (tmpdir is symlinked on macOS)
  return realpath(repo);
}

describe("scanRepos", () => {
  test("finds repos at depth 1 and 2, skips deeper and non-repos", async () => {
    const root = await makeRoot();
    await makeRepo(root, "alpha", "main");
    await makeRepo(root, "org/beta", "master");
    await makeRepo(root, "org/nested/gamma"); // depth 3 — out
    await mkdir(join(root, "not-a-repo"), { recursive: true });

    const repos = await scanRepos([root]);
    expect(repos.map((r) => r.name)).toEqual(["alpha", "beta"]);
    expect(repos[0]?.defaultBranch).toBe("main");
    expect(repos[1]?.defaultBranch).toBe("master");
  });

  test("a root that is itself a repo registers as one, and isn't descended into", async () => {
    const parent = await makeRoot();
    const root = await makeRepo(parent, "dotfiles", "main");
    await makeRepo(parent, "dotfiles/submodule", "main"); // depth 1 under the root — not descended into

    const repos = await scanRepos([root]);
    expect(repos).toEqual([{ name: "dotfiles", path: root, defaultBranch: "main" }]);
  });

  test("skips hidden directories", async () => {
    const root = await makeRoot();
    await makeRepo(root, ".hidden/repo", "main");
    expect(await scanRepos([root])).toEqual([]);
  });

  test("defaultBranch is null when origin/HEAD is absent", async () => {
    const root = await makeRoot();
    await makeRepo(root, "no-head");
    const repos = await scanRepos([root]);
    expect(repos[0]?.defaultBranch).toBeNull();
  });

  test("disambiguates colliding basenames with the parent dir", async () => {
    const root = await makeRoot();
    await makeRepo(root, "work/api", "main");
    await makeRepo(root, "personal/api", "main");
    const repos = await scanRepos([root]);
    expect(repos.map((r) => r.name).toSorted()).toEqual(["personal/api", "work/api"]);
  });

  test("falls back to full paths when even parent/base collides", async () => {
    const rootA = await makeRoot();
    const rootB = await makeRoot();
    const a = await makeRepo(rootA, "work/api", "main");
    const b = await makeRepo(rootB, "work/api", "main");
    const repos = await scanRepos([rootA, rootB]);
    expect(repos.map((r) => r.name).toSorted()).toEqual([a, b].toSorted());
  });

  test("carries cached defaultBranch forward without re-reading", async () => {
    const root = await makeRoot();
    const path = await makeRepo(root, "cached"); // no origin/HEAD on disk
    const previous = [{ name: "cached", path, defaultBranch: "main" }];
    const repos = await scanRepos([root], previous);
    expect(repos[0]?.defaultBranch).toBe("main");
  });

  test("re-reads when the cached value is null", async () => {
    const root = await makeRoot();
    const path = await makeRepo(root, "latecomer", "main");
    const previous = [{ name: "latecomer", path, defaultBranch: null }];
    const repos = await scanRepos([root], previous);
    expect(repos[0]?.defaultBranch).toBe("main");
  });

  test("registers main clones only — never a linked worktree, in either layout", async () => {
    const root = await makeRoot();
    const web = await makeClone(root, "web");
    const utils = await makeClone(root, "org/utils");
    await addWorktree(web, join(root, "web-pr633")); // sibling at depth 1
    await addWorktree(utils, join(root, "org", "utils-pen-2524")); // sibling at depth 2
    await addWorktree(web, join(web, ".claude", "worktrees", "fix")); // nested

    const repos = await scanRepos([root]);
    expect(repos.map((r) => [r.name, r.path])).toEqual([
      ["utils", utils],
      ["web", web],
    ]);
  });

  test("a root that is itself a linked worktree registers nothing, not even its main clone", async () => {
    const parent = await makeRoot();
    const web = await makeClone(parent, "web");
    const worktree = join(parent, "web-pr633");
    await addWorktree(web, worktree);
    expect(await scanRepos([worktree])).toEqual([]);
  });

  // Broken `.git`s still stop the walk: descending would surface what is nested
  // inside as repos of their own.
  test("a broken checkout registers nothing and isn't descended into", async () => {
    const root = await makeRoot();
    const garbled = join(root, "garbled");
    await mkdir(garbled);
    await writeFile(join(garbled, ".git"), "not a pointer\n");
    await makeRepo(garbled, "vendored", "main");
    const web = await makeClone(root, "web");
    await addWorktree(web, join(root, "web-pr633"));
    await rm(web, { recursive: true, force: true }); // main clone deleted, sibling worktree left behind
    expect(await scanRepos([root])).toEqual([]);
  });

  // A same-basename worktree used to join the collision group (as `wt/utils`);
  // with it gone the two clones must still be told apart by their parents.
  test("colliding basenames stay disambiguated with worktrees out of the set", async () => {
    const root = await makeRoot();
    const a = await makeClone(root, "appfarm/utils");
    const b = await makeClone(root, "pengefix/utils");
    await addWorktree(b, join(root, "wt", "utils"));
    await addWorktree(b, join(root, "pengefix", "utils-pr1"));
    const repos = await scanRepos([root]);
    expect(repos.map((r) => [r.name, r.path])).toEqual([
      ["appfarm/utils", a],
      ["pengefix/utils", b],
    ]);
  });

  test("missing root scans to empty, not an error", async () => {
    expect(await scanRepos(["/nonexistent/seance-test-root"])).toEqual([]);
  });
});

describe("readDefaultBranch", () => {
  test("resolves through a gitdir pointer file (linked worktree)", async () => {
    const root = await makeRoot();
    const mainRepo = await makeRepo(root, "primary", "main");
    const linked = join(root, "linked");
    await mkdir(linked, { recursive: true });
    await writeFile(join(linked, ".git"), `gitdir: ${join(mainRepo, ".git")}\n`);
    expect(await readDefaultBranch(linked)).toBe("main");
  });
});

describe("repoSetsEqual", () => {
  test("equal and unequal sets", () => {
    const a = [{ name: "x", path: "/x", defaultBranch: "main" }];
    expect(repoSetsEqual(a, [...a])).toBe(true);
    expect(repoSetsEqual(a, [])).toBe(false);
    expect(repoSetsEqual(a, [{ ...a[0]!, defaultBranch: null }])).toBe(false);
  });
});
