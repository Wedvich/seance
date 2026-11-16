import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  availabilityChange,
  closedOf,
  custodianSeatOf,
  drainingOf,
  livePid,
  loadOrInitState,
  pidAlive,
  readState,
  saveState,
  withoutClosed,
  writeRuntime,
  type State,
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

  test("drainAt survives a restart; absent reads as draining from `at`, null as soft", async () => {
    const fresh = await loadOrInitState(path);
    await saveState({ ...fresh, closed: { at: 100, drainAt: 200 } }, path);
    expect(drainingOf(await loadOrInitState(path))).toEqual({ cl: 100, drainAt: 200 });
    await saveState({ ...fresh, closed: { at: 100, drainAt: null } }, path);
    const soft = await loadOrInitState(path);
    expect(closedOf(soft)).toBe(100);
    expect(drainingOf(soft)).toBeNull();
    await saveState({ ...fresh, closed: { at: 100 } }, path);
    expect(drainingOf(await loadOrInitState(path))).toEqual({ cl: 100, drainAt: 100 });
    expect(drainingOf(fresh)).toBeNull();
  });

  test("a drainAt it cannot read loads as closed, not draining, with one warning; a wholly unreadable closed still drains", async () => {
    const fresh = await loadOrInitState(path);
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      for (const drainAt of ["x", -1, 0, true]) {
        await Bun.write(path, JSON.stringify({ ...fresh, closed: { at: 100, drainAt } }));
        warn.mockClear();
        const loaded = await loadOrInitState(path);
        expect(closedOf(loaded)).toBe(100);
        expect(drainingOf(loaded)).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
      }
      await Bun.write(path, JSON.stringify({ ...fresh, closed: { at: "x", drainAt: 5 } }));
      const damaged = await loadOrInitState(path);
      expect(drainingOf(damaged)?.cl ?? null).toBe(closedOf(damaged));
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

describe("availabilityChange", () => {
  const base: State = { deviceId: "d", repos: [], scannedAt: null };
  const soft: State = { ...base, closed: { at: 100, drainAt: null } };
  const draining: State = { ...base, closed: { at: 100, drainAt: 100 } };

  test("a close while open sets drainAt once: now for a drain or now, null for a soft close", () => {
    expect(availabilityChange(base, false, "soft", 5)).toEqual({
      next: { ...base, closed: { at: 5, drainAt: null } },
      outcome: "closed",
    });
    for (const mode of ["drain", "now"] as const) {
      expect(availabilityChange(base, false, mode, 5)).toEqual({
        next: { ...base, closed: { at: 5, drainAt: 5 } },
        outcome: "closed",
      });
    }
  });

  test("a drain request on a soft close starts the drain and keeps `at`; a soft one changes nothing", () => {
    for (const mode of ["drain", "now"] as const) {
      expect(availabilityChange(soft, false, mode, 500)).toEqual({
        next: { ...base, closed: { at: 100, drainAt: 500 } },
        outcome: "drain_started",
      });
    }
    expect(availabilityChange(soft, false, "soft", 500)).toEqual({ next: soft, outcome: "unchanged" });
  });

  test("a draining close changes nothing, whatever the mode", () => {
    for (const mode of ["soft", "drain", "now"] as const) {
      expect(availabilityChange(draining, false, mode, 500)).toEqual({ next: draining, outcome: "unchanged" });
    }
  });

  test("a reopen clears both fields; reopening an open box changes nothing", () => {
    for (const closed of [soft, draining]) {
      const { next, outcome } = availabilityChange(closed, true, "soft", 9);
      expect(outcome).toBe("reopened");
      expect(next.closed).toBeUndefined();
    }
    expect(availabilityChange(base, true, "drain", 9)).toEqual({ next: base, outcome: "unchanged" });
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

describe("custodianSeatOf", () => {
  const base = { deviceId: "d", repos: [], scannedAt: null };
  const round = { pane: "%3", startedAt: 5, tmpDir: "/tmp/seance-cu-abc123", exclave: "work" };
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "seance-state-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Through the file, as a daemon reads it: the field arrives as whatever JSON the disk held. */
  const seatOf = async (custodian: unknown): Promise<ReturnType<typeof custodianSeatOf>> => {
    const path = join(dir, "state.json");
    await writeFile(path, JSON.stringify({ ...base, ...(custodian === undefined ? {} : { custodian }) }));
    const state = await readState(path);
    if (state === null) throw new Error("state did not parse");
    return custodianSeatOf(state);
  };

  test("reads a whole record, with the pane still null before the window exists", async () => {
    expect(await seatOf({ lastEndedAt: 9, round })).toEqual({ lastEndedAt: 9, round });
    expect(await seatOf({ round: { ...round, pane: null } })).toEqual({ round: { ...round, pane: null } });
    expect((await seatOf({ round: { ...round, exclave: "default" } })).round?.exclave).toBe("default");
  });

  test("a round's done mark is kept only as the boolean true", async () => {
    expect(await seatOf({ round: { ...round, done: true } })).toEqual({ round: { ...round, done: true } });
    for (const done of [false, "true", 1, null, {}]) {
      expect(await seatOf({ round: { ...round, done } })).toEqual({ round });
    }
  });

  test("anything unreadable reads as none, field by field", async () => {
    expect(await seatOf(undefined)).toEqual({});
    expect(await seatOf("x")).toEqual({});
    expect(await seatOf(null)).toEqual({});
    expect(await seatOf({ lastEndedAt: "9", round })).toEqual({ round });
    expect(await seatOf({ lastEndedAt: -1 })).toEqual({});
  });

  test("the socket dir is kept only in its own mkdtemp shape, and alone: a bad one drops nothing else", async () => {
    const socketDir = "/tmp/seance-cu-s-aB3dE9";
    expect(await seatOf({ lastEndedAt: 9, socketDir, round })).toEqual({ lastEndedAt: 9, socketDir, round });
    expect(await seatOf({ socketDir })).toEqual({ socketDir });
    for (const bad of [
      "/tmp/seance-cu-abc123",
      "/tmp/seance-cu-s-0123456789ab",
      "/tmp/seance-cu-s-aB3dE9/../x",
      "/private/tmp/seance-cu-s-aB3dE9",
      "/tmp/seance-cu-s-aB3dE9/c.sock",
      7,
      null,
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one file, rewritten per case
      expect(await seatOf({ lastEndedAt: 9, socketDir: bad, round })).toEqual({ lastEndedAt: 9, round });
    }
  });

  test("a round with a bad pane, tmp dir, exclave or time is dropped whole and keeps the end time", async () => {
    for (const bad of [
      { ...round, pane: "3" },
      { ...round, pane: "%3; rm" },
      { ...round, tmpDir: "/tmp/seance-cu-abc123/../x" },
      { ...round, tmpDir: "/home/m" },
      { ...round, tmpDir: "/tmp/claude-501" },
      { ...round, exclave: "../x" },
      { ...round, exclave: "Work" },
      { ...round, startedAt: "5" },
      { ...round, startedAt: -5 },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one file, rewritten per case
      expect(await seatOf({ lastEndedAt: 9, round: bad })).toEqual({ lastEndedAt: 9 });
    }
  });
});
