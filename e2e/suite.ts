import type { RelayToAppFrame, RegistryView, SchedulerLeader } from "@seance/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Renamed: the react-hooks lint reads any `use*` call in an async function as a misplaced React hook.
import { usePrivateTmux as privateTmuxFor } from "../daemon/test/fixtures.ts";
import { newDeviceId, type TestRelay } from "../relay/test/harness.ts";
import type { AppState } from "../pwa/src/view.ts";
import { startStack, TOKEN, wsUrl, type Stack } from "./harness.ts";

/**
 * The one suite where all three components are real: seanced from daemon/src,
 * the Worker + Durable Object under workerd, and the app's RelayClient + Store.
 * Every pairwise seam has its own suite; what lives here is the composition —
 * the flows a user actually performs, end to end. One file per area, each
 * booting its own stack through `startSuite`, so a new area is a new file.
 */

/**
 * Sleeping around every boot: bun runs every e2e file in one process, and
 * booting workerd within ~100 ms of a dispose breaks its stdio (CLAUDE.md,
 * Testing). Both sides, so either file order is covered.
 */
const SETTLE_MS = 500;

export interface Suite {
  readonly base: string;
  readonly stack: Stack;
  /** A listed machine's seed, copied out without the PSK: the reader check's case once the allowlist holds. */
  readonly stolenSeedId: string;
  readonly dispose: () => Promise<void>;
}

/**
 * One area file's stack, booted identically for every file so no file depends
 * on another's setup. `label` names its private tmux server: one per file, so
 * no socket path is reused within the process.
 */
export async function startSuite(label: string): Promise<Suite> {
  const base = await mkdtemp(join(tmpdir(), "seance-e2e-"));
  process.env["SEANCE_STATE_DIR"] = join(base, "state");
  const privateTmux = privateTmuxFor(base, label);
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "claude-config");
  const dispose = async (stack: Stack | undefined): Promise<void> => {
    try {
      try {
        await stack?.dispose();
        await Bun.sleep(SETTLE_MS);
      } finally {
        // A relay teardown error must not leave the server (and its claude stub) running.
        await privateTmux.dispose();
      }
    } finally {
      // Nor the env and the temp dir: the next file's stack would inherit both.
      delete process.env["SEANCE_STATE_DIR"];
      delete process.env["SEANCE_CLAUDE_BIN"];
      delete process.env["CLAUDE_CONFIG_DIR"];
      await rm(base, { recursive: true, force: true });
    }
  };
  try {
    const stolenSeedId = await newDeviceId();
    await Bun.sleep(SETTLE_MS);
    // Observed well before any second machine's reading, so that one is the newest.
    const stack = await startStack(base, [{ id: "default", observedAtMs: Date.now() - 10 * 60_000, fiveHourPct: 20 }], {
      secondLeaders: ["LeaderBox"],
      leaders: [stolenSeedId],
    });
    return { base, stack, stolenSeedId, dispose: () => dispose(stack) };
  } catch (error) {
    // No afterAll can reach a suite that never returned: tear down what did start.
    await dispose(undefined);
    throw error;
  }
}

/**
 * The latest registry push as a bearer-token holder reads it, off a bare app
 * socket: the raw leader record (with its proof) and entries the app's
 * RelayClient only shows once they open.
 */
export function watchLeader(relay: TestRelay): {
  readonly current: () => SchedulerLeader | null;
  readonly connected: (deviceId: string) => boolean;
  readonly entry: (deviceId: string) => RegistryView | undefined;
  readonly close: () => void;
} {
  const url = new URL(wsUrl(relay, "/app"));
  url.searchParams.set("t", TOKEN);
  const ws = new WebSocket(url.href, { perMessageDeflate: false });
  let latest: Extract<RelayToAppFrame, { t: "registry" }> | null = null;
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string" || event.data === "pong") return;
    const frame = JSON.parse(event.data) as RelayToAppFrame;
    if (frame.t === "registry") latest = frame;
  });
  return {
    current: () => latest?.scheduler ?? null,
    connected: (deviceId) => latest?.entries.some((entry) => entry.deviceId === deviceId && entry.connected) === true,
    entry: (deviceId) => latest?.entries.find((entry) => entry.deviceId === deviceId),
    close: () => ws.close(),
  };
}

/** The origin key the fixture clone is listed under, once a machine has listed its repos. */
export function fixtureOrigin(state: AppState): string | null {
  return state.relay.machines.flatMap((m) => m.repos).find((repo) => repo.origin !== undefined)?.origin ?? null;
}

/** Single-quoted for `sh -c`, as `spawn.ts` quotes its one shell string. */
export function q(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
