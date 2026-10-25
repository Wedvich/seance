import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "bun:test";
import { REPO_MAX_SKILLS } from "@seance/shared";
import { addWorktree, makeClone, makeGitFixture, makeSeparateGitDirClone } from "../test/fixtures.ts";
import { exec } from "./exec.ts";
import { normalizeOrigin, originQuery, readDefaultBranch, readOriginUrl, repoSetsEqual, scanRepos } from "./scan.ts";

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
    expect(repos).toEqual([{ name: "dotfiles", path: root, defaultBranch: "main", origin: "dotfiles" }]);
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

  describe("project skills", () => {
    /** A fixture clone whose `origin/main` is advanced by committing in the clone and moving the ref, as a fetch would. */
    async function skillClone(): Promise<{
      readonly root: string;
      readonly repo: string;
      readonly commit: (files: Readonly<Record<string, string | null>>) => Promise<void>;
      readonly publish: () => Promise<void>;
    }> {
      const base = await makeRoot();
      const { root, repoPath: repo } = await makeGitFixture(base);
      const run = async (...args: string[]): Promise<void> => {
        const result = await exec(["git", ...args], { cwd: repo });
        if (result.exitCode !== 0) throw new Error(result.stderr);
      };
      const commit = async (files: Readonly<Record<string, string | null>>): Promise<void> => {
        for (const [rel, content] of Object.entries(files)) {
          if (content === null) {
            await rm(join(repo, rel), { recursive: true, force: true });
            continue;
          }
          await mkdir(dirname(join(repo, rel)), { recursive: true });
          await writeFile(join(repo, rel), content);
        }
        await run("add", "-A");
        await run("commit", "-q", "-m", "skills");
      };
      const publish = (): Promise<void> => run("update-ref", "refs/remotes/origin/main", "HEAD");
      return { root, repo, commit, publish };
    }
    const skill = (name: string): Record<string, string> => ({ [`.claude/skills/${name}/SKILL.md`]: "" });

    test("read from origin/<default>: sorted, and a new or removed skill changes the set", async () => {
      const { root, commit, publish } = await skillClone();
      await commit({ ...skill("ship"), ...skill("deploy"), ".claude/skills/stray/notes.md": "" });
      await publish();
      const first = await scanRepos([root]);
      expect(first[0]?.skills).toEqual(["deploy", "ship"]);

      await commit(skill("plan"));
      await publish();
      const second = await scanRepos([root], first);
      expect(second[0]?.skills).toEqual(["deploy", "plan", "ship"]);
      expect(repoSetsEqual(first, second)).toBe(false);

      await commit({ ".claude/skills/plan": null });
      await publish();
      const third = await scanRepos([root], second);
      expect(third[0]?.skills).toEqual(["deploy", "ship"]);
      expect(repoSetsEqual(second, third)).toBe(false);
    });

    test("a clone whose origin default branch has no skills has no skills property", async () => {
      const { root } = await skillClone();
      const [entry] = await scanRepos([root]);
      expect(entry).not.toHaveProperty("skills");
    });

    test("a skill only on a feature branch, committed past origin, or uncommitted is not advertised", async () => {
      const { root, repo, commit } = await skillClone();
      await commit(skill("local-only")); // main moved past origin/main, not published
      const checkout = await exec(["git", "checkout", "-q", "-b", "feature"], { cwd: repo });
      expect(checkout.exitCode).toBe(0);
      await commit(skill("on-feature"));
      await mkdir(join(repo, ".claude", "skills", "dirty"), { recursive: true });
      await writeFile(join(repo, ".claude", "skills", "dirty", "SKILL.md"), "");
      const [entry] = await scanRepos([root]);
      expect(entry).not.toHaveProperty("skills");
    });

    test("names failing isSkillName are dropped beside a good one, not the whole list", async () => {
      const { root, commit, publish } = await skillClone();
      await commit({ ...skill("good"), ...skill("has space"), ...skill("x".repeat(70)), ...skill(".hidden") });
      await publish();
      const [entry] = await scanRepos([root]);
      expect(entry?.skills).toEqual(["good"]);
    });

    test("a symlinked SKILL.md is skipped, and an unresolvable origin ref reads as no skills", async () => {
      const { root, repo, commit, publish } = await skillClone();
      await mkdir(join(repo, ".claude", "skills", "linked"), { recursive: true });
      await symlink("../../../README.md", join(repo, ".claude", "skills", "linked", "SKILL.md"));
      await commit(skill("real"));
      await publish();
      const [entry] = await scanRepos([root]);
      expect(entry?.skills).toEqual(["real"]);

      const bare = await makeRoot();
      await makeRepo(bare, "alpha", "main"); // a `.git` dir holding no repo: ls-tree fails
      expect((await scanRepos([bare]))[0]).not.toHaveProperty("skills");
    });

    test("a skill dir with many files does not drop skills sorted after it", async () => {
      const { root, commit, publish } = await skillClone();
      const bulk = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`.claude/skills/aaa/refs/f${i}.md`, ""]));
      await commit({ ...skill("aaa"), ...bulk, ...skill("ship") });
      await publish();
      const [entry] = await scanRepos([root]);
      expect(entry?.skills).toEqual(["aaa", "ship"]);
    });

    test("a name with pathspec-looking characters is matched literally", async () => {
      const { root, commit, publish } = await skillClone();
      await commit({ ...skill("a:b"), ...skill("x[1]"), ...skill(":(glob)y"), ...skill("xa") });
      await publish();
      const [entry] = await scanRepos([root]);
      expect(entry?.skills).toEqual([":(glob)y", "a:b", "x[1]", "xa"]);
    });

    test("past REPO_MAX_SKILLS the first by sort order are kept, never sent whole", async () => {
      const { root, commit, publish } = await skillClone();
      const names = Array.from({ length: REPO_MAX_SKILLS + 2 }, (_, i) => `s${String(i).padStart(2, "0")}`);
      await commit(Object.assign({}, ...names.map(skill)));
      await publish();
      const [entry] = await scanRepos([root]);
      expect(entry?.skills).toEqual(names.slice(0, REPO_MAX_SKILLS));
    });
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

describe("origin", () => {
  test("normalizes https, ssh and scp-like URLs to one lowercase host/path key", () => {
    expect(normalizeOrigin("https://github.com/Wedvich/seance.git")).toBe("github.com/wedvich/seance");
    expect(normalizeOrigin("git@github.com:Wedvich/seance.git")).toBe("github.com/wedvich/seance");
    expect(normalizeOrigin("ssh://git@github.com/Wedvich/seance")).toBe("github.com/wedvich/seance");
    expect(normalizeOrigin("https://pengefix@dev.azure.com/pengefix/pengefix/_git/web/")).toBe(
      "dev.azure.com/pengefix/pengefix/_git/web",
    );
    expect(normalizeOrigin("host:~user/repo.git")).toBe("host/~user/repo");
  });

  test("a local or file remote, or nothing usable, is no remote", () => {
    expect(normalizeOrigin("/srv/mirrors/seance.git")).toBeNull();
    expect(normalizeOrigin("../sibling")).toBeNull();
    expect(normalizeOrigin("file:///srv/mirrors/seance.git")).toBeNull();
    // Windows paths, which the scp-style branch would read as host `c`.
    expect(normalizeOrigin("C:/src/seance")).toBeNull();
    expect(normalizeOrigin("c:\\src\\seance.git")).toBeNull();
    expect(normalizeOrigin("\\\\fileserver\\mirrors\\seance.git")).toBeNull();
    expect(normalizeOrigin("https://github.com")).toBeNull();
    expect(normalizeOrigin("")).toBeNull();
  });

  test("a typed origin keys like a scanned one, bare host/path included", () => {
    expect(originQuery("github.com/Wedvich/seance")).toEqual(["github.com/wedvich/seance"]);
    expect(originQuery(" github.com/Wedvich/seance.git/ ")).toEqual(["github.com/wedvich/seance"]);
    expect(originQuery("https://github.com/Wedvich/seance.git")).toContain("github.com/wedvich/seance");
    expect(originQuery("git@github.com:Wedvich/seance.git")).toContain("github.com/wedvich/seance");
    // A listed key with a port reads as itself, not as scp `host:path`.
    expect(normalizeOrigin("ssh://git@git.example:2222/team/repo.git")).toBe("git.example:2222/team/repo");
    expect(originQuery("git.example:2222/Team/repo")[0]).toBe("git.example:2222/team/repo");
    // A clone name is no origin; the caller matches it as a name instead.
    expect(originQuery("seance")).toEqual([]);
  });

  test("reads remote.origin.url from the common dir's config — first url, quoted or bare", async () => {
    const root = await makeRoot();
    const repo = await makeRepo(root, "r", "main");
    await writeFile(
      join(repo, ".git", "config"),
      [
        "[core]",
        "\tbare = false",
        '[remote "upstream"]',
        "\turl = https://example.com/other/repo.git",
        '[Remote "origin"] ; trailing',
        '\tURL = "https://github.com/Wedvich/seance.git" # quoted',
        "\turl = git@github.com:Wedvich/push-only.git",
        "\tfetch = +refs/heads/*:refs/remotes/origin/*",
        "",
      ].join("\n"),
    );
    expect(await readOriginUrl(join(repo, ".git"))).toBe("https://github.com/Wedvich/seance.git");
    expect((await scanRepos([root]))[0]?.origin).toBe("github.com/wedvich/seance");
  });

  test("a bare value ends at a comment marker; a remote-less repo keys by basename", async () => {
    const root = await makeRoot();
    const repo = await makeRepo(root, "keyed", "main");
    await writeFile(join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:o/r.git # mirror\n');
    const bare = await makeRepo(root, "no-remote");
    const repos = await scanRepos([root]);
    expect(repos.map((r) => [r.name, r.origin])).toEqual([
      ["keyed", "github.com/o/r"],
      ["no-remote", "no-remote"],
    ]);
    expect(await readOriginUrl(join(bare, ".git"))).toBeNull();
  });

  test("a separate-git-dir clone reads its config through the pointer", async () => {
    const root = await makeRoot();
    const gitDir = join(root, "gitdirs", "detached");
    const repo = await makeSeparateGitDirClone(root, "detached", gitDir);
    await writeFile(join(gitDir, "config"), '[remote "origin"]\n\turl = https://example.org/Org/Detached.git\n', {
      flag: "a",
    });
    expect((await scanRepos([root])).find((r) => r.path === repo)?.origin).toBe("example.org/org/detached");
  });
});
