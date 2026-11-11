import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec.ts";
import { checkoutRoot, describeCheckout, readSource, servingRoot } from "./selfsource.ts";

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeCheckout(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "seance-selfsource-"));
  cleanups.push(dir);
  const env = ["-c", "user.email=t@t", "-c", "user.name=t"];
  await exec(["git", "init", "-q", "-b", "main", dir]);
  await exec(["git", "-C", dir, ...env, "commit", "-q", "--allow-empty", "-m", "one"]);
  return dir;
}

describe("readSource", () => {
  test("reports sha, branch and commit time for a checkout", async () => {
    const dir = await makeCheckout();
    const source = await readSource(dir);
    expect(source?.sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(source?.branch).toBe("main");
    // %ct is seconds; the wire carries ms like every other timestamp.
    expect(source?.commitTs).toBeGreaterThan(Date.now() - 60_000);
    expect(source?.commitTs).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  test("branch is null on detached HEAD", async () => {
    const dir = await makeCheckout();
    await exec(["git", "-C", dir, "checkout", "-q", "--detach"]);
    const source = await readSource(dir);
    expect(source?.sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(source?.branch).toBeNull();
  });

  test("null outside a git checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seance-selfsource-"));
    cleanups.push(dir);
    expect(await readSource(dir)).toBeNull();
  });

  test("null for a repo with no commits yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seance-selfsource-"));
    cleanups.push(dir);
    await exec(["git", "init", "-q", dir]);
    expect(await readSource(dir)).toBeNull();
  });

  test("the daemon's own checkout resolves", async () => {
    // This repo is a checkout, so the default root must answer.
    const source = await readSource(checkoutRoot());
    expect(source?.sha).toMatch(/^[0-9a-f]{40}$/u);
  });
});

const SHA = "ca651d97c793b0d1f2e3a4b5c6d7e8f901234567";

describe("describeCheckout", () => {
  test("names the clone it runs from, home-relative, so two clones on one box tell apart", () => {
    const source = { sha: SHA, commitTs: 0, branch: "main" };
    expect(describeCheckout(source, "/Users/martin/repos/seance/", "/Users/martin")).toBe(
      "ca651d97c793 on main (~/repos/seance)",
    );
    expect(describeCheckout(source, "/Users/martin/pengefix2/seance", "/Users/martin")).toBe(
      "ca651d97c793 on main (~/pengefix2/seance)",
    );
  });

  test("a root outside home stays absolute; a home-prefixed sibling is not home", () => {
    const source = { sha: SHA, commitTs: 0, branch: null };
    expect(describeCheckout(source, "/opt/seance/", "/home/m")).toBe("ca651d97c793 (detached) (/opt/seance)");
    expect(describeCheckout(source, "/home/max/seance", "/home/m")).toBe("ca651d97c793 (detached) (/home/max/seance)");
  });

  test("defaults to this checkout's own root, the one readSource reads", async () => {
    const source = await readSource();
    expect(source).not.toBeNull();
    if (source === null) return;
    const shown = /\((\/.+)\)$/u.exec(describeCheckout(source, undefined, "/nonexistent-home"))?.[1];
    // checkoutRoot() keeps the URL's trailing slash; the line drops it.
    expect(`${shown}/`).toBe(checkoutRoot());
  });

  test("a $HOME with a trailing slash still shortens to ~", () => {
    const source = { sha: SHA, commitTs: 0, branch: "main" };
    expect(describeCheckout(source, "/home/m/repos/seance", "/home/m/")).toBe("ca651d97c793 on main (~/repos/seance)");
  });
});

describe("servingRoot", () => {
  const runtime = { pid: 1, startedAt: 0, connected: true, connectedSince: 0, sha: SHA };

  test("a live daemon's recorded root wins, trailing slash dropped", () => {
    expect(servingRoot({ ...runtime, root: "/Users/martin/repos/seance/" }, true)).toBe("/Users/martin/repos/seance");
  });

  test("nothing to say for a dead daemon, an older one with no root, or a root that isn't an absolute path", () => {
    expect(servingRoot(null, true)).toBeNull();
    expect(servingRoot({ ...runtime, root: "/Users/martin/repos/seance" }, false)).toBeNull();
    expect(servingRoot(runtime, true)).toBeNull();
    expect(servingRoot({ ...runtime, root: "repos/seance" }, true)).toBeNull();
    // runtime.json is parsed, not validated field by field.
    expect(
      servingRoot(JSON.parse('{"pid":1,"startedAt":0,"connected":true,"connectedSince":0,"root":42}'), true),
    ).toBeNull();
  });
});
