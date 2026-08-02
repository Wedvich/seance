import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec.ts";
import { checkoutRoot, readSource } from "./selfsource.ts";

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
