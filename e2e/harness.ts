import { importPsk, toBase64 } from "@seance/shared";
import { join } from "node:path";
import { createBackend } from "../daemon/src/backend-default.ts";
import type { Config } from "../daemon/src/config.ts";
import { startDaemon, type DaemonHandle } from "../daemon/src/run.ts";
import { tmux } from "../daemon/src/tmux.ts";
import { makeClaudeStub, makeGitFixture, type ClaudeStub, type GitFixture } from "../daemon/test/fixtures.ts";
import { DEFAULT_FORM, type PendingSpawn, type PersistedForm } from "../pwa/src/state.ts";
import { RelayClient, type RelayState } from "@seance/shared";
import { Store } from "../pwa/src/store.ts";
import type { AppState } from "../pwa/src/view.ts";
import { startRelay, type TestRelay } from "../relay/test/harness.ts";

/**
 * Assembles the whole stack, all real: the daemon from daemon/src, the Worker +
 * Durable Object under workerd (via the relay harness — its memoized bundle is
 * the only legal way to get one, since Bun.build runs once per process), and
 * the app's RelayClient + Store. The only fakes anywhere are the claude binary
 * and the browser globals below.
 */

// Store touches exactly these two browser globals (visibilitychange in
// attach(), history for layer symmetry). Tests read verdicts from getState()
// and never dismiss layers, so no-ops suffice; globals.d.ts carries the types.
Object.defineProperty(globalThis, "document", {
  value: { visibilityState: "visible", addEventListener(): void {}, removeEventListener(): void {} },
  configurable: true,
});
Object.defineProperty(globalThis, "history", {
  value: { pushState(): void {}, replaceState(): void {}, back(): void {} },
  configurable: true,
});

export const TOKEN = "e2e-bearer";
export const PSK = toBase64(new Uint8Array(32).fill(5));
export const TMUX_SESSION = "e2e";

export function wsUrl(relay: TestRelay, path: string): string {
  const url = new URL(path, relay.url);
  url.protocol = "ws:";
  return url.href;
}

export interface Stack {
  readonly relay: TestRelay;
  readonly fixture: GitFixture;
  readonly stub: ClaudeStub;
  readonly appKey: CryptoKey;
  readonly deviceId: string;
  daemon: DaemonHandle;
  /**
   * Restart with identical opts — same state dir, so the same deviceId. `spawnWaitMs`
   * overrides the default budget for the new daemon; pass nothing to get it back.
   */
  readonly restartDaemon: (opts?: { readonly spawnWaitMs?: number }) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

/**
 * Env seams must be set before this runs: SEANCE_STATE_DIR (one per suite —
 * one stable deviceId), SEANCE_TMUX_SOCKET, SEANCE_CLAUDE_BIN. The caller owns
 * them because they are process-global and the daemon suite plays the same
 * game in its own files.
 */
export async function startStack(base: string): Promise<Stack> {
  const fixture = await makeGitFixture(base);
  const stub = await makeClaudeStub(base);
  process.env["SEANCE_CLAUDE_BIN"] = stub.ok;

  const relay = await startRelay(TOKEN);
  const appKey = await importPsk(PSK);

  const config: Config = {
    name: "TestMac",
    relayUrl: wsUrl(relay, "/daemon"),
    bearerToken: TOKEN,
    psk: PSK,
    repoRoots: [fixture.root],
    tmuxSession: TMUX_SESSION,
  };
  // Only a *successful* spawn pays this in full — verifyPaneAlive resolves as soon as
  // a pane dies — so the default is tuned for the many spawns that work, and the one
  // test that asserts a death raises it via restartDaemon. Too low a budget there
  // reads a slow-starting corpse as a live session: the failing stub is bash + sleep
  // 0.3, which the shards running concurrently can stretch past a second.
  const DEFAULT_SPAWN_WAIT_MS = 1_500;

  const startTestDaemon = (spawnWaitMs = DEFAULT_SPAWN_WAIT_MS): Promise<DaemonHandle> =>
    startDaemon({
      config,
      backend: createBackend(config, { waitMs: spawnWaitMs }),
      pingIntervalMs: 60_000,
      pongTimeoutMs: 1_000,
      baseBackoffMs: 20,
    });

  let daemon = await startTestDaemon();
  const stateDir = process.env["SEANCE_STATE_DIR"];
  if (stateDir === undefined) throw new Error("startStack requires SEANCE_STATE_DIR to be set first");
  const { deviceId } = (await Bun.file(join(stateDir, "state.json")).json()) as { deviceId: string };

  const stack: Stack = {
    relay,
    fixture,
    stub,
    appKey,
    deviceId,
    daemon,
    restartDaemon: async (opts: { readonly spawnWaitMs?: number } = {}): Promise<void> => {
      // A failed test's finally can land here with the old daemon still live;
      // an orphan would share the state dir, deviceId and tmux for the rest
      // of the process. stop() is idempotent, so always stop before starting.
      daemon.stop();
      daemon = await startTestDaemon(opts.spawnWaitMs);
      stack.daemon = daemon;
    },
    dispose: async (): Promise<void> => {
      daemon.stop();
      await tmux(["kill-server"]);
      await relay.dispose();
    },
  };
  return stack;
}

/** Event-driven wait with a deadline whose failure message shows the last state. */
function waitOn<T>(
  subscribe: (listener: () => void) => () => void,
  read: () => T,
  predicate: (state: T) => boolean,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      if (!predicate(read())) return false;
      clearTimeout(timer);
      unsubscribe();
      resolve(read());
      return true;
    };
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`${label}: never satisfied; last state ${JSON.stringify(read())}`));
    }, 10_000);
    const unsubscribe = subscribe(() => void check());
    check();
  });
}

export interface AppHandle {
  readonly client: RelayClient;
  readonly store: Store;
  readonly waitForApp: (predicate: (state: AppState) => boolean, label: string) => Promise<AppState>;
  readonly waitForRelay: (predicate: (state: RelayState) => boolean, label: string) => Promise<RelayState>;
  readonly stop: () => void;
}

/**
 * A fresh app per test: the real transport (deflate suppressed — Bun's client
 * and workerd disagree about permessage-deflate, see pwa/test/client.test.ts)
 * under the real Store, timeouts tightened so a regression fails in seconds.
 */
export function startApp(
  stack: Stack,
  form: Partial<PersistedForm> = {},
  pending: PendingSpawn | null = null,
): AppHandle {
  const client = new RelayClient({
    url: `${wsUrl(stack.relay, "/app")}`,
    token: TOKEN,
    key: stack.appKey,
    timeouts: { sessions: 4_000, rescan: 5_000, spawn: 15_000 },
    createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
  });
  const store = new Store(client, { ...DEFAULT_FORM, ...form }, pending);
  const detach = store.attach();
  client.start();

  return {
    client,
    store,
    waitForApp: (predicate, label) => waitOn(store.subscribe, store.getState, predicate, label),
    waitForRelay: (predicate, label) => waitOn(client.subscribe, client.getState, predicate, label),
    stop: (): void => {
      detach();
      client.stop();
    },
  };
}

/** The machine as this suite's daemon, or null until its register decrypted. */
export function ownMachine(state: AppState, deviceId: string): AppState["relay"]["machines"][number] | null {
  return state.relay.machines.find((machine) => machine.deviceId === deviceId) ?? null;
}

export async function listWindows(): Promise<readonly string[]> {
  const result = await tmux(["list-windows", "-a", "-F", "#{window_name}"]);
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\n").filter((name) => name !== "");
}

export async function killWindow(window: string): Promise<void> {
  await tmux(["kill-window", "-t", `${TMUX_SESSION}:${window}`]);
}
