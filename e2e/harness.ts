import { importPsk, toBase64 } from "@seance/shared";
import type { Subprocess } from "bun";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createBackend } from "../daemon/src/backend-default.ts";
import type { Config } from "../daemon/src/config.ts";
import { DEFAULT_EXCLAVE } from "../daemon/src/exclaves.ts";
import { MemoryQueueStore } from "../daemon/src/leader.ts";
import { startDaemon, type DaemonHandle } from "../daemon/src/run.ts";
import { PANE_TITLED, tmux } from "../daemon/src/tmux.ts";
import {
  makeClaudeStub,
  makeGitFixture,
  pollUntil,
  type ClaudeStub,
  type GitFixture,
} from "../daemon/test/fixtures.ts";
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
  value: { state: null, pushState(): void {}, replaceState(): void {}, back(): void {}, go(): void {} },
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

/** The account every fixture exclave signs into, so each machine's view of it folds into one account card. */
export const E2E_ACCOUNT = { organizationUuid: "e2e-org", accountUuid: "e2e-account" };
export const E2E_ACCOUNT_ID = `${E2E_ACCOUNT.organizationUuid}:${E2E_ACCOUNT.accountUuid}`;

export interface ExclaveFixture {
  /** `default` is `~/.claude.json`; any other name is listed in `~/.exclaves`. */
  readonly id: string;
  /** The cached reading's `fetchedAtMs` — its observed-at, which decides the newest observer. */
  readonly observedAtMs: number;
  readonly fiveHourPct: number;
}

/**
 * A home of the daemon's own, so its exclaves are the fixture's and never the
 * developer's `~/.exclaves` and `~/.claude.json`. Each exclave is signed into
 * `E2E_ACCOUNT` with one cached quota reading, in the shape Claude Code leaves.
 * An unlisted `default` is signed out.
 */
async function makeHome(dir: string, exclaves: readonly ExclaveFixture[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  const named = exclaves.filter((exclave) => exclave.id !== DEFAULT_EXCLAVE).map((exclave) => exclave.id);
  if (named.length > 0) await writeFile(join(dir, ".exclaves"), `${named.join("\n")}\n`);
  await Promise.all(
    exclaves.map(async (exclave) => {
      const file =
        exclave.id === DEFAULT_EXCLAVE ? join(dir, ".claude.json") : join(dir, `.claude-${exclave.id}`, ".claude.json");
      await mkdir(dirname(file), { recursive: true });
      // A reset hours out, so the reading is shown as reported rather than floored to 0.
      const resetsAt = new Date(exclave.observedAtMs + 5 * 3_600_000).toISOString();
      await writeFile(
        file,
        JSON.stringify({
          oauthAccount: E2E_ACCOUNT,
          cachedUsageUtilization: {
            fetchedAtMs: exclave.observedAtMs,
            utilization: { five_hour: { utilization: exclave.fiveHourPct, resets_at: resetsAt } },
          },
        }),
      );
    }),
  );
  return dir;
}

/** A second real daemon on the stack's relay and tmux server, in its own process (`remote-daemon.ts`). */
export interface SecondDaemon {
  readonly deviceId: string;
  /** Its stdout, where its audit lines land. */
  readonly log: string;
  /** Its windows' tmux session, beside the suite's own. */
  readonly tmuxSession: string;
  /** Its `SEANCE_STATE_DIR`: a process given it reaches this daemon's op socket. */
  readonly stateDir: string;
  readonly stop: () => Promise<void>;
}

export interface Stack {
  readonly relay: TestRelay;
  /** The daemon's own config — the local MCP path reads its `name` to recognise this box. */
  readonly config: Config;
  readonly fixture: GitFixture;
  readonly stub: ClaudeStub;
  readonly appKey: CryptoKey;
  readonly deviceId: string;
  daemon: DaemonHandle;
  /**
   * The queue the suite's daemon leads over, kept across `restartDaemon` as the
   * relay's store will be (M3): a task put here is the next term's to take over.
   */
  readonly leaderStore: MemoryQueueStore;
  /**
   * Restart with identical opts — same state dir, so the same deviceId. `spawnWaitMs`
   * overrides the default budget for the new daemon; pass nothing to get it back.
   */
  readonly restartDaemon: (opts?: { readonly spawnWaitMs?: number }) => Promise<void>;
  /**
   * Boot machine B: same config as the suite's daemon bar `name` and tmux
   * session, its own state dir — so its own deviceId — and its own home. A
   * separate process, because `stateDir()` comes from the environment and two
   * daemons in one process would share a deviceId and an op socket. Resolves
   * once B has minted its identity; dispose stops any still running.
   */
  readonly startSecondDaemon: (opts: {
    readonly name: string;
    readonly exclaves?: readonly ExclaveFixture[];
  }) => Promise<SecondDaemon>;
  readonly dispose: () => Promise<void>;
}

/**
 * Env seams must be set before this runs: SEANCE_STATE_DIR (one per suite —
 * one stable deviceId), SEANCE_TMUX_SOCKET (`usePrivateTmux`, whose server
 * outlives dispose), SEANCE_CLAUDE_BIN. The caller owns
 * them because they are process-global and the daemon suite plays the same
 * game in its own files. `exclaves` populate the daemon's fixture home.
 */
export async function startStack(base: string, exclaves: readonly ExclaveFixture[] = []): Promise<Stack> {
  const fixture = await makeGitFixture(base);
  const stub = await makeClaudeStub(base);
  const home = await makeHome(join(base, "home"), exclaves);
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
  // Neither outcome pays this in full — awaitRegistration resolves as soon as the pane
  // dies or the stub titles it — so the budget only bounds a stuck pane, and the one
  // test that asserts a death raises it via restartDaemon. Too low a budget there
  // reads a slow-starting corpse as alive-but-unregistered (an ok ack, pending) instead
  // of dead: the failing stub is bash + sleep 0.3, which the shards running
  // concurrently can stretch past a second.
  const DEFAULT_SPAWN_WAIT_MS = 1_500;
  const leaderStore = new MemoryQueueStore();

  const startTestDaemon = (spawnWaitMs = DEFAULT_SPAWN_WAIT_MS): Promise<DaemonHandle> =>
    startDaemon({
      config,
      // Stands for a credential-delivered box, the only kind that brokers: the
      // keyless-MCP flow needs it, and nothing else here depends on the source.
      resolvedPsk: { psk: PSK, source: "credential" },
      backend: createBackend(config, { home, waitMs: spawnWaitMs }),
      home,
      pingIntervalMs: 60_000,
      pongTimeoutMs: 1_000,
      baseBackoffMs: 20,
      leader: { store: leaderStore },
    });

  let daemon = await startTestDaemon();
  const stateDir = process.env["SEANCE_STATE_DIR"];
  if (stateDir === undefined) throw new Error("startStack requires SEANCE_STATE_DIR to be set first");
  const { deviceId } = (await Bun.file(join(stateDir, "state.json")).json()) as { deviceId: string };

  const secondProcs = new Set<Subprocess>();
  const startSecondDaemon = async (opts: {
    readonly name: string;
    readonly exclaves?: readonly ExclaveFixture[];
  }): Promise<SecondDaemon> => {
    const dir = join(base, `second-${opts.name.toLowerCase()}`);
    const secondState = join(dir, "state");
    const configDir = join(dir, "config");
    const tmuxSession = `${TMUX_SESSION}-${opts.name.toLowerCase()}`;
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), JSON.stringify({ ...config, name: opts.name, tmuxSession }));
    const secondHome = await makeHome(join(dir, "home"), opts.exclaves ?? []);
    const log = join(dir, "daemon.log");
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "remote-daemon.ts"), secondHome], {
      env: { ...process.env, SEANCE_STATE_DIR: secondState, SEANCE_CONFIG_DIR: configDir },
      stdin: "pipe",
      stdout: Bun.file(log),
      stderr: Bun.file(join(dir, "daemon.err")),
    });
    secondProcs.add(proc);
    const stop = async (): Promise<void> => {
      secondProcs.delete(proc);
      proc.kill();
      await proc.exited;
    };

    const statePath = join(secondState, "state.json");
    try {
      // Until it parses, not until it exists: the poll can land mid-write.
      await pollUntil(
        async () =>
          typeof (
            await Bun.file(statePath)
              .json()
              .catch(() => null)
          )?.deviceId === "string",
        `${opts.name}'s state.json`,
        10_000,
      );
    } catch (error) {
      await stop();
      throw error;
    }
    const { deviceId: secondId } = (await Bun.file(statePath).json()) as { deviceId: string };
    return { deviceId: secondId, log, tmuxSession, stateDir: secondState, stop };
  };

  const stack: Stack = {
    relay,
    config,
    fixture,
    stub,
    appKey,
    deviceId,
    daemon,
    leaderStore,
    restartDaemon: async (opts: { readonly spawnWaitMs?: number } = {}): Promise<void> => {
      // A failed test's finally can land here with the old daemon still live;
      // an orphan would share the state dir, deviceId and tmux for the rest
      // of the process. stop() is idempotent, so always stop before starting.
      daemon.stop();
      daemon = await startTestDaemon(opts.spawnWaitMs);
      stack.daemon = daemon;
    },
    startSecondDaemon,
    dispose: async (): Promise<void> => {
      daemon.stop();
      for (const proc of secondProcs) proc.kill();
      await Promise.all([...secondProcs].map((proc) => proc.exited));
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

/**
 * Windows whose pane the stub has titled — what the daemon's session list will
 * admit. A window exists from new-window time, a beat before the stub registers,
 * so a test that then asks the daemon for sessions has to wait for this instead.
 */
export async function listRegisteredWindows(): Promise<readonly string[]> {
  const result = await tmux(["list-panes", "-a", "-F", `${PANE_TITLED}|#{window_name}`]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("1|"))
    .map((line) => line.slice(2));
}

export async function killWindow(window: string): Promise<void> {
  await tmux(["kill-window", "-t", `${TMUX_SESSION}:${window}`]);
}
