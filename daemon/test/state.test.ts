import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoEntry } from "@seance/shared";
import { loadOrInitState, saveState, writeRuntime, type State } from "../src/state.ts";

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

describe("state writes", () => {
  test("a concurrent reader never sees a partial state file", async () => {
    const dir = await mkdtemp(join(base, "concurrent-"));
    const path = join(dir, "state.json");
    const deviceId = crypto.randomUUID();
    const big = repos(RACY_REPO_COUNT);
    await saveState({ deviceId, repos: big, scannedAt: 0 }, path);

    // A truncated read is indistinguishable from corruption, so `loadOrInitState`
    // mints a *new* deviceId and the machine re-registers as a stranger. Alternating
    // sizes keeps every write a real rewrite rather than an identical overwrite.
    const reads: Promise<State>[] = [];
    for (let round = 0; round < 60; round++) {
      const write = saveState({ deviceId, repos: round % 2 === 0 ? [] : big, scannedAt: round }, path);
      for (let i = 0; i < 8; i++) reads.push(loadOrInitState(path));
      await write;
    }

    for (const state of await Promise.all(reads)) {
      expect(state.deviceId).toBe(deviceId);
    }
    expect((await loadOrInitState(path)).deviceId).toBe(deviceId);
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
