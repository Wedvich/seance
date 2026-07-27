import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { livePid, pidAlive, writeRuntime } from "./state.ts";

describe("pidAlive", () => {
  test("true for this process, false for a pid that cannot exist", () => {
    expect(pidAlive(process.pid)).toBe(true);
    // Above any real pid on macOS/Linux, so nothing can answer for it.
    expect(pidAlive(0x7fff_fffe)).toBe(false);
  });
});

describe("livePid", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "seance-state-"));
    path = join(dir, "runtime.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("null when no daemon has ever run", async () => {
    expect(await livePid(path)).toBeNull();
  });

  test("returns the pid while it is alive", async () => {
    await writeRuntime({ pid: process.pid, startedAt: Date.now(), connected: true, connectedSince: Date.now() }, path);
    expect(await livePid(path)).toBe(process.pid);
  });

  test("null for a stale runtime file — a killed daemon must not look like an owner", async () => {
    await writeRuntime({ pid: 0x7fff_fffe, startedAt: Date.now(), connected: true, connectedSince: null }, path);
    expect(await livePid(path)).toBeNull();
  });

  test("null when the file is corrupt", async () => {
    await Bun.write(path, "{ not json");
    expect(await livePid(path)).toBeNull();
  });
});
