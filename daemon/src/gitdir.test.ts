import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addWorktree, makeClone, makeSeparateGitDirClone } from "../test/fixtures.ts";
import { enclosingWorktreeCommonDir, inspectCheckout, resolveCommonDir } from "./gitdir.ts";

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

// Root reads through any mode, so an unreadable fixture can't be made there.
const AS_ROOT = process.getuid?.() === 0;

async function makeRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "seance-gitdir-")));
  cleanups.push(root);
  return root;
}

/** A main clone with a real linked worktree in each layout. */
async function makeLayout(): Promise<{
  readonly root: string;
  readonly main: string;
  readonly nested: string;
  readonly sibling: string;
}> {
  const root = await makeRoot();
  const main = await makeClone(root, "web");
  const nested = join(main, ".claude", "worktrees", "fix");
  const sibling = join(root, "web-pr633");
  await addWorktree(main, nested);
  await addWorktree(main, sibling);
  return { root, main, nested, sibling };
}

/** The worktree's private git dir, `<main>/.git/worktrees/<name>`, as its `.git` pointer names it. */
async function adminDirOf(worktree: string): Promise<string> {
  return (await Bun.file(join(worktree, ".git")).text()).replace(/^gitdir:\s*/u, "").trim();
}

describe("inspectCheckout", () => {
  test("a main clone, either worktree layout, and no checkout", async () => {
    const { main, nested, sibling } = await makeLayout();
    expect(await inspectCheckout(main)).toEqual({ kind: "main", commonDir: join(main, ".git") });
    expect((await inspectCheckout(nested)).kind).toBe("linked");
    expect((await inspectCheckout(sibling)).kind).toBe("linked");
    expect(await inspectCheckout(join(main, ".claude"))).toEqual({ kind: "none" });
  });

  // A submodule or `--separate-git-dir` clone has a pointer file too, but its
  // git dir is its own common dir — it is a repo, not a worktree of one.
  test("a pointer to a git dir without commondir is a main clone", async () => {
    const root = await makeRoot();
    const gitDir = join(root, "gitdirs", "web.git");
    const web = await makeSeparateGitDirClone(root, "web", gitDir);
    expect(await inspectCheckout(web)).toEqual({ kind: "main", commonDir: gitDir });
  });

  // Existence classifies; content only resolves. A fallback to "main" here
  // would register the checkout and expose it to spawn-by-name.
  test("a pointer that names nothing, or a git dir that is gone, is broken — never main", async () => {
    const { root, nested } = await makeLayout();
    const garbled = join(root, "garbled");
    await mkdir(garbled);
    await writeFile(join(garbled, ".git"), "not a pointer\n");
    await writeFile(join(await adminDirOf(nested), "commondir"), "");
    const orphaned = await makeLayout();
    await rm(orphaned.main, { recursive: true, force: true }); // main clone deleted under its sibling worktree
    for (const dir of [garbled, nested, orphaned.sibling]) {
      expect(await inspectCheckout(dir)).toEqual({ kind: "broken" });
    }
  });

  test.skipIf(AS_ROOT)("an unreadable commondir is unreadable — never main", async () => {
    const { sibling } = await makeLayout();
    const commondir = join(await adminDirOf(sibling), "commondir");
    await chmod(commondir, 0o000);
    try {
      expect(await inspectCheckout(sibling)).toEqual({ kind: "unreadable" });
    } finally {
      await chmod(commondir, 0o644);
    }
  });
});

describe("enclosingWorktreeCommonDir", () => {
  test("either worktree layout, from its root or any subdirectory, shares the main clone's common dir", async () => {
    const { main, nested, sibling } = await makeLayout();
    await mkdir(join(sibling, "src", "deep"), { recursive: true });
    const common = await resolveCommonDir(main);
    expect(common).toBe(join(main, ".git"));
    for (const path of [sibling, join(sibling, "src", "deep"), nested]) {
      expect(await enclosingWorktreeCommonDir(path)).toEqual({ commonDir: common, definitive: true });
    }
  });

  test("null, definitively, in a main clone and outside every checkout", async () => {
    const { root, main } = await makeLayout();
    for (const path of [main, join(main, ".claude"), root]) {
      expect(await enclosingWorktreeCommonDir(path)).toEqual({ commonDir: null, definitive: true });
    }
  });

  // The nearest `.git` there is the inner clone's; stopping at it would lose the worktree.
  test("walks past a clone nested inside a worktree to the worktree itself", async () => {
    const { main, sibling } = await makeLayout();
    await makeClone(sibling, join("vendor", "sub"));
    expect((await enclosingWorktreeCommonDir(join(sibling, "vendor", "sub"))).commonDir).toBe(
      await resolveCommonDir(main),
    );
  });

  // Its common dir isn't named `.git`, and nothing in it points back at the
  // main working tree — matching common dirs is what still pairs the two.
  test("a worktree of a --separate-git-dir clone shares that clone's common dir", async () => {
    const root = await makeRoot();
    const web = await makeSeparateGitDirClone(root, "web", join(root, "gitdirs", "web.git"));
    const sibling = join(root, "web-pr1");
    await addWorktree(web, sibling);
    const common = await resolveCommonDir(web);
    expect(common).toBe(join(root, "gitdirs", "web.git"));
    expect((await enclosingWorktreeCommonDir(sibling)).commonDir).toBe(common);
  });

  test("relative gitdir and commondir (worktree.useRelativePaths) resolve", async () => {
    const { root, main } = await makeLayout();
    const relative = join(root, "web-rel");
    await addWorktree(main, relative, "-c", "worktree.useRelativePaths=true");
    expect(await Bun.file(join(relative, ".git")).text()).toStartWith("gitdir: ../");
    expect((await enclosingWorktreeCommonDir(relative)).commonDir).toBe(join(main, ".git"));
  });

  // `commondir` is `../..` from the admin dir; resolved lexically from a symlink
  // to that dir it would climb out of the symlink's parent instead.
  test("a gitdir pointer through a symlinked admin dir resolves commondir physically", async () => {
    const { root, main, sibling } = await makeLayout();
    const alias = join(root, "aliases", "admin");
    await mkdir(dirname(alias), { recursive: true });
    await symlink(await adminDirOf(sibling), alias);
    await writeFile(join(sibling, ".git"), `gitdir: ${alias}\n`);
    expect((await enclosingWorktreeCommonDir(sibling)).commonDir).toBe(join(main, ".git"));
  });

  test.skipIf(AS_ROOT)("an unreadable commondir answers null, marked as not definitive", async () => {
    const { sibling } = await makeLayout();
    const commondir = join(await adminDirOf(sibling), "commondir");
    await chmod(commondir, 0o000);
    try {
      expect(await enclosingWorktreeCommonDir(sibling)).toEqual({ commonDir: null, definitive: false });
    } finally {
      await chmod(commondir, 0o644);
    }
  });
});
