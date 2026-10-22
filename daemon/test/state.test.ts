import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentitySeed, identityFromSeed, toBase64, type RepoEntry } from "@seance/shared";
import {
  loadOrInitState,
  readRuntime,
  readState,
  saveState,
  writeRuntime,
  type Runtime,
  type State,
} from "../src/state.ts";

let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-state-"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

function repos(count: number): RepoEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `repo-${i}`,
    path: `/home/nobody/repos/repo-${i}`,
    defaultBranch: "main",
  }));
}

/**
 * Half a megabyte of repos, because a truncating write only splits into
 * separate syscalls above roughly that size — at a realistic 200 repos an
 * in-place `Bun.write` lands atomically often enough that the old code passes.
 * The window is narrower in the field than this test makes it look; what it is
 * not is closed, and the payoff for landing in it is a re-minted deviceId.
 */
const RACY_REPO_COUNT = 5_000;

/** A seed and the deviceId it derives, so a state built here survives a reload unchanged. */
async function freshIdentity(): Promise<{ deviceId: string; identitySeed: string }> {
  const seed = generateIdentitySeed();
  return { deviceId: (await identityFromSeed(seed)).deviceId, identitySeed: toBase64(seed) };
}

describe("state writes", () => {
  test("a concurrent reader never sees a partial state file", async () => {
    const dir = await mkdtemp(join(base, "concurrent-"));
    const path = join(dir, "state.json");
    const { deviceId, identitySeed } = await freshIdentity();
    const big = repos(RACY_REPO_COUNT);
    await saveState({ deviceId, identitySeed, repos: big, scannedAt: 0 }, path);

    // A truncated read is indistinguishable from corruption, so `loadOrInitState`
    // mints a *new* deviceId and the machine re-registers as a stranger. Alternating
    // sizes keeps every write a real rewrite rather than an identical overwrite.
    const reads: Promise<State>[] = [];
    for (let round = 0; round < 60; round++) {
      const write = saveState({ deviceId, identitySeed, repos: round % 2 === 0 ? [] : big, scannedAt: round }, path);
      for (let i = 0; i < 8; i++) reads.push(loadOrInitState(path));
      await write;
    }

    for (const state of await Promise.all(reads)) {
      expect(state.deviceId).toBe(deviceId);
    }
    expect((await loadOrInitState(path)).deviceId).toBe(deviceId);
  });

  test("a concurrent reader always finds the running daemon's pid", async () => {
    const dir = await mkdtemp(join(base, "runtime-"));
    const path = join(dir, "runtime.json");
    // The two shapes the daemon alternates between on every drop and reconnect.
    const down = { pid: process.pid, startedAt: 1, connected: false, connectedSince: null, sha: null };
    const up = { pid: process.pid, startedAt: 1, connected: true, connectedSince: 2, sha: "f".repeat(40) };
    await writeRuntime(down, path);

    // A lost read is `livePid` saying no daemon runs, which is the go-ahead for
    // a CLI to rewrite the cache the daemon owns. Small as the file is, an
    // in-place write truncates first.
    const reads: Promise<Runtime | null>[] = [];
    for (let round = 0; round < 200; round++) {
      const write = writeRuntime(round % 2 === 0 ? up : down, path);
      for (let i = 0; i < 8; i++) reads.push(readRuntime(path));
      await write;
    }

    const lost = (await Promise.all(reads)).filter((runtime) => runtime?.pid !== process.pid);
    expect(lost).toEqual([]);
  });

  test("overlapping writers leave no temp files behind", async () => {
    const dir = await mkdtemp(join(base, "temps-"));
    const path = join(dir, "runtime.json");
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        writeRuntime({ pid: process.pid, startedAt: i, connected: i % 2 === 0, connectedSince: null }, path),
      ),
    );
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("readState", () => {
  test("returns null for a missing file instead of minting a deviceId", async () => {
    const path = join(base, "never-run", "state.json");
    expect(await readState(path)).toBeNull();
    // The probe must leave no trace: `seance mcp` asks this on every tool call,
    // and a box that has never run the daemon must not acquire an identity from
    // being asked whether it has one.
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("returns null for an unusable file, where loadOrInitState would reinitialize", async () => {
    const path = join(base, "corrupt", "state.json");
    await Bun.write(path, "{ not json");
    expect(await readState(path)).toBeNull();
    // Still untouched — only loadOrInitState replaces it.
    expect(await Bun.file(path).text()).toBe("{ not json");

    const initialized = await loadOrInitState(path);
    expect(initialized.deviceId).not.toBe("");
    expect((await readState(path))?.deviceId).toBe(initialized.deviceId);
  });

  test("reads back what the daemon saved", async () => {
    const path = join(base, "live", "state.json");
    const state: State = { deviceId: "device-x", repos: repos(3), scannedAt: 42 };
    await saveState(state, path);
    expect(await readState(path)).toEqual(state);
  });
});
