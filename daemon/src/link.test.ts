import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  bunDriftCheck,
  bunPathFor,
  cliOnPathCheck,
  createLink,
  findExisting,
  rankLinkDirs,
  removeLinks,
} from "./link.ts";

describe("bunPathFor", () => {
  test("PATH's bun wins; execPath is only the fallback for a PATH without one", () => {
    expect(bunPathFor("/opt/homebrew/bin/bun")).toBe("/opt/homebrew/bin/bun");
    expect(bunPathFor(null)).toBe(process.execPath);
  });
});

describe("bunDriftCheck", () => {
  const shim = "/opt/homebrew/bin/bun";
  const keg = "/opt/homebrew/Cellar/bun/1.3.14/bin/bun";

  test("a recorded path that's gone is a fail — the service can't start at all", () => {
    const check = bunDriftCheck(keg, shim, false);
    expect(check.level).toBe("fail");
    expect(check.message).toContain("no longer exists");
  });

  test("live but stale is a warn: it still runs, until the next upgrade removes it", () => {
    const check = bunDriftCheck(keg, shim, true);
    expect(check.level).toBe("warn");
    expect(check.message).toContain(shim);
  });

  test("recorded path matching PATH's bun is ok", () => {
    expect(bunDriftCheck(shim, shim, true).level).toBe("ok");
  });

  test("what/remedy name the record being checked — the MCP entry's fix is mcp install, not install", () => {
    const check = bunDriftCheck(keg, shim, false, "MCP entry", "seanced mcp install");
    expect(check.message).toContain("MCP entry records bun");
    expect(check.message).toContain("`seanced mcp install`");
  });
});

describe("cliOnPathCheck", () => {
  const main = "/repo/daemon/src/main.ts";

  test("not on PATH is a warn carrying both remedies, never a fail", () => {
    const check = cliOnPathCheck(null, null, main);
    expect(check.level).toBe("warn");
    expect(check.message).toContain(`bun ${main} link`);
    expect(check.message).toContain(`alias seanced='bun ${main}'`);
  });

  test("resolving to this checkout is ok", () => {
    expect(cliOnPathCheck("/home/u/.local/bin/seanced", main, main)).toEqual({
      level: "ok",
      message: "seanced on PATH at /home/u/.local/bin/seanced",
    });
  });

  test("resolving to another checkout warns with both paths and the repoint remedy", () => {
    const check = cliOnPathCheck("/home/u/.local/bin/seanced", "/old-clone/daemon/src/main.ts", main);
    expect(check.level).toBe("warn");
    expect(check.message).toContain("/old-clone/daemon/src/main.ts");
    expect(check.message).toContain(`bun ${main} link`);
  });
});

describe("rankLinkDirs", () => {
  const home = "/home/u";

  test("~/.local/bin first, then ~/bin, then other home dirs, then the rest — PATH order within a rank", () => {
    const pathEnv = ["/usr/bin", "/opt/tools", `${home}/stuff/bin`, `${home}/bin`, `${home}/.local/bin`].join(
      delimiter,
    );
    expect(rankLinkDirs(pathEnv, home)).toEqual([
      `${home}/.local/bin`,
      `${home}/bin`,
      `${home}/stuff/bin`,
      "/usr/bin",
      "/opt/tools",
    ]);
  });

  test("dedupes and drops empty segments", () => {
    expect(rankLinkDirs(`/usr/bin${delimiter}${delimiter}/usr/bin`, home)).toEqual(["/usr/bin"]);
  });
});

// Real fs, real symlinks: the failure modes worth pinning (broken links, real
// files squatting on the name) are all in fs behavior, not in logic a stub
// would exercise.
describe("createLink / removeLinks", () => {
  let root: string;
  let binDir: string;
  let otherDir: string;
  let main: string;
  let pathEnv: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "seance-link-"));
    binDir = join(root, ".local", "bin");
    otherDir = join(root, "other-bin");
    await mkdir(binDir, { recursive: true });
    await mkdir(otherDir, { recursive: true });
    main = join(root, "checkout", "daemon", "src", "main.ts");
    await mkdir(join(root, "checkout", "daemon", "src"), { recursive: true });
    await writeFile(main, "#!/usr/bin/env bun\n");
    pathEnv = [otherDir, binDir].join(delimiter);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("creates in the preferred writable dir and is idempotent", async () => {
    expect(await createLink(pathEnv, root, main)).toEqual({ status: "created", file: join(binDir, "seanced") });
    expect(await readlink(join(binDir, "seanced"))).toBe(main);
    expect(await createLink(pathEnv, root, main)).toEqual({ status: "already", file: join(binDir, "seanced") });
  });

  test("repoints a link into another checkout, in place", async () => {
    const stale = join(root, "old-clone", "daemon", "src", "main.ts");
    await symlink(stale, join(otherDir, "seanced"));
    expect(await createLink(pathEnv, root, main)).toEqual({
      status: "repointed",
      file: join(otherDir, "seanced"),
      previous: stale,
    });
    expect(await readlink(join(otherDir, "seanced"))).toBe(main);
  });

  test("refuses to touch a real file squatting on the name", async () => {
    await writeFile(join(otherDir, "seanced"), "#!/bin/sh\n");
    expect(createLink(pathEnv, root, main)).rejects.toThrow("not touching it");
  });

  test("explicit dir overrides the ranking", async () => {
    expect(await createLink(pathEnv, root, main, otherDir)).toEqual({
      status: "created",
      file: join(otherDir, "seanced"),
    });
  });

  test("removeLinks takes this checkout's links — broken ones included — and keeps a stranger's", async () => {
    await symlink(main, join(binDir, "seanced"));
    const foreign = join(root, "old-clone", "daemon", "src", "main.ts");
    await symlink(foreign, join(otherDir, "seanced"));
    const first = await removeLinks(pathEnv, main);
    expect(first.removed).toEqual([join(binDir, "seanced")]);
    expect(first.kept).toEqual([{ file: join(otherDir, "seanced"), target: foreign }]);

    // Broken: same raw target, but the checkout file is gone — realpath fails.
    await rm(main);
    await symlink(main, join(binDir, "seanced"));
    const second = await removeLinks(pathEnv, main);
    expect(second.removed).toEqual([join(binDir, "seanced")]);
  });

  test("findExisting lstats, so a broken link is still visible", async () => {
    await symlink(join(root, "nowhere"), join(binDir, "seanced"));
    expect(await findExisting(pathEnv)).toEqual([{ file: join(binDir, "seanced"), target: join(root, "nowhere") }]);
  });
});
