import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  closedOf,
  livePid,
  loadOrInitState,
  pidAlive,
  readState,
  saveState,
  withoutClosed,
  writeRuntime,
} from "./state.ts";
import { log } from "./log.ts";

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

describe("closed", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "seance-state-"));
    path = join(dir, "state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("survives a restart until someone reopens it", async () => {
    const fresh = await loadOrInitState(path);
    expect(closedOf(fresh)).toBeNull();
    await saveState({ ...fresh, closed: { at: 1_763_000_000_000 } }, path);
    const reloaded = await loadOrInitState(path);
    expect(closedOf(reloaded)).toBe(1_763_000_000_000);
    expect(closedOf(await loadOrInitState(path))).toBe(1_763_000_000_000);
    await saveState(withoutClosed(reloaded), path);
    expect(closedOf(await loadOrInitState(path))).toBeNull();
  });

  test("a closed field it cannot read loads as closed now, with a warning: a damaged close must not reopen the box", async () => {
    const fresh = await loadOrInitState(path);
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      for (const closed of [{ at: "x" }, { at: -1 }, "yes", null, {}]) {
        await Bun.write(path, JSON.stringify({ ...fresh, closed }));
        warn.mockClear();
        const before = Date.now();
        const loaded = await loadOrInitState(path);
        expect(closedOf(loaded) ?? 0).toBeGreaterThanOrEqual(before);
        expect(warn).toHaveBeenCalledTimes(1);
      }
    } finally {
      warn.mockRestore();
    }
  });

  test("readState returns the raw field and never logs", async () => {
    const fresh = await loadOrInitState(path);
    await Bun.write(path, JSON.stringify({ ...fresh, closed: { at: "x" } }));
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      expect(JSON.stringify((await readState(path))?.closed)).toBe('{"at":"x"}');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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
