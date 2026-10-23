import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformFsmonitor, type FsmonitorSeams } from "../src/fsmonitor.ts";
import { pollUntil } from "./fixtures.ts";

/**
 * The real `ps` + `lsof` listing, against a stand-in rather than git's daemon,
 * which Linux git doesn't ship: a script named `git`, run as
 * `git fsmonitor--daemon run`, holding a directory open on fd 4 as the real
 * one holds its worktree root. Where lsof is missing nothing can be mapped,
 * which the product treats as "leave it alone"; this checks the mapping itself.
 */
const seams: FsmonitorSeams | null = platformFsmonitor();

describe.skipIf(seams === null || Bun.which("lsof") === null)("fsmonitor listing (real ps and lsof)", () => {
  let base: string;
  let root: string;
  let standIn: ReturnType<typeof Bun.spawn> | undefined;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "seance-fsmonitor-listing-"));
    root = join(base, "watched");
    await mkdir(root);
    await mkdir(join(base, "bin"));
    const script = join(base, "bin", "git");
    await writeFile(script, '#!/bin/sh\nexec 4<"$STANDIN_ROOT"\nwhile :; do sleep 1; done\n');
    await chmod(script, 0o755);
    standIn = Bun.spawn([script, "fsmonitor--daemon", "run", "--detach", "--ipc-threads=8"], {
      env: { ...process.env, STANDIN_ROOT: root },
      stdout: "ignore",
      stderr: "ignore",
    });
  });

  afterAll(async () => {
    standIn?.kill("SIGKILL");
    await rm(base, { recursive: true, force: true });
  });

  test("finds the stand-in by its command, maps it by fd 4, and signals it", async () => {
    const pid = standIn?.pid ?? -1;
    const real = await realpath(root);
    let found: { pid: number; rssKb: number; worktree: string | null } | undefined;
    await pollUntil(async () => {
      found = (await seams?.list())?.find((daemon) => daemon.pid === pid);
      return found?.worktree !== undefined && found.worktree !== null;
    }, "the stand-in listed with its fd 4");
    expect(found?.worktree === null ? null : await realpath(found?.worktree ?? "")).toBe(real);
    expect(found?.rssKb).toBeGreaterThan(0);

    expect(seams?.signal(pid)).toBe(true);
    expect(await standIn?.exited).not.toBe(0);
    expect(seams?.signal(pid)).toBe(false);
  });
});
