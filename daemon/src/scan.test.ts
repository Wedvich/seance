import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
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
