import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { livePid, loadOrInitState, pidAlive, saveState, writeRuntime } from "./state.ts";

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

const modeOf = async (p: string): Promise<number> => (await stat(p)).mode & 0o777;

describe("file modes", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "seance-state-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("state.json is owner-only — it lists every repo path this machine scanned", async () => {
    const path = join(dir, "state.json");
    await loadOrInitState(path);
    expect(await modeOf(path)).toBe(0o600);
    await saveState({ deviceId: "d", repos: [], scannedAt: null }, path);
    expect(await modeOf(path)).toBe(0o600);
  });

  test("runtime.json is owner-only, and one left 0644 by an older daemon is tightened", async () => {
    const path = join(dir, "runtime.json");
    const runtime = { pid: process.pid, startedAt: Date.now(), connected: false, connectedSince: null };
    await writeRuntime(runtime, path);
    expect(await modeOf(path)).toBe(0o600);

    await writeFile(path, "{}");
    await chmod(path, 0o644);
    await writeRuntime(runtime, path);
    expect(await modeOf(path)).toBe(0o600);
  });
});
