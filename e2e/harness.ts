import {
  DAEMON_ROLES,
  importPsk,
  parseStoreReply,
  STORE_TIMEOUT_MS,
  toBase64,
  type RelayToDaemonFrame,
} from "@seance/shared";
import type { Subprocess } from "bun";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createBackend } from "../daemon/src/backend-default.ts";
import type { Config } from "../daemon/src/config.ts";
import { DEFAULT_EXCLAVE } from "../daemon/src/exclaves.ts";
import type { QueueStore, Task } from "../daemon/src/leader.ts";
import { createQueueStore, type StoreLeg } from "../daemon/src/queue-store.ts";
import { startDaemon, type DaemonHandle } from "../daemon/src/run.ts";
import { identityOfState, loadOrInitState, readState } from "../daemon/src/state.ts";
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
import {
  adoptIdentity,
  connectApp,
  connectDaemon,
  register,
  startRelay,
  type Client,
  type TestRelay,
} from "../relay/test/harness.ts";

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

export interface SecondDaemonOpts {
  readonly name: string;
  readonly exclaves?: readonly ExclaveFixture[];
  /**
   * Extra environment for the daemon process, spread last: its claude stub
   * (`SEANCE_CLAUDE_BIN`), or `SEANCE_E2E_SPAWN_WAIT_MS` for its spawn registration budget.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Runs with its state dir (created) before the process boots: pre-seeded state, a launch ledger say. */
  readonly beforeBoot?: (stateDir: string) => Promise<void>;
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
   * The relay's queue, read through the daemon's own adapter on its current
   * term: the real store, so it survives `restartDaemon` as the next term's
   * to take over. Reads only matter to a test; writes go through `seedTask`.
   */
  readonly queue: () => QueueStore;
  /**
   * Put a task into the relay's queue as a leader would have left it. The relay
   * takes a task's create only from an app, and nudges the leader about it, so
   * the daemon is stopped first: a stand-in signing with its identity takes a
   * term, the create goes in on an app socket and the rest through the
   * stand-in. The daemon is left stopped — call `restartDaemon` afterwards, and
   * the next term takes the task over.
   */
  readonly seedTask: (task: Task) => Promise<void>;
  /**
   * Restart with identical opts — same state dir, so the same deviceId. `spawnWaitMs`
   * overrides the default budget for the new daemon; pass nothing to get it back.
   * `quiet` pushes out the leader's tick and the daemon's status beat, so the only
   * thing that can wake the leader after boot is a `store-changed` (a failed takeover
   * still retries at once, which is not a wake-up); the next
   * restart without it puts the stack's cadence back.
   */
  readonly restartDaemon: (opts?: { readonly spawnWaitMs?: number; readonly quiet?: boolean }) => Promise<void>;
  /**
   * Boot machine B: same config as the suite's daemon bar `name` and tmux
   * session, its own state dir — so its own deviceId — and its own home. A
   * separate process, because `stateDir()` comes from the environment and two
   * daemons in one process would share a deviceId and an op socket. Resolves
   * once B has minted its identity; dispose stops any still running.
   */
  readonly startSecondDaemon: (opts: SecondDaemonOpts) => Promise<SecondDaemon>;
  readonly dispose: () => Promise<void>;
}

export interface StackOptions {
  /** Second daemons, by `startSecondDaemon` name, that the relay may nominate. */
  readonly secondLeaders?: readonly string[];
  /** Further ids for SCHEDULER_LEADERS — one minted by `newDeviceId`, say. */
  readonly leaders?: readonly string[];
}

/** A second daemon's directory, from its name: where its state is pre-seeded and where it later boots. */
function secondDir(base: string, name: string): string {
  return join(base, `second-${name.toLowerCase()}`);
}

/**
 * The deviceId a daemon on this state dir will register as, minted now by the
 * daemon's own first-start path rather than when it boots: the relay's
 * SCHEDULER_LEADERS is fixed at boot, as a deploy fixes it, and the daemon
 * then loads this state as its own.
 */
async function mintDeviceId(stateDir: string): Promise<string> {
  return (await loadOrInitState(join(stateDir, "state.json"))).deviceId;
}

/** A raw relay socket as the queue adapter's leg: one store request, its reply correlated on `re`. */
function storeLeg(client: Client): StoreLeg {
  return {
    store: async (frame) => {
      client.send(frame);
      return parseStoreReply(await client.waitForRe<{ re: string }>(frame.id, STORE_TIMEOUT_MS));
    },
  };
}

/**
 * Env seams must be set before this runs: SEANCE_STATE_DIR (one per suite —
 * one stable deviceId), SEANCE_TMUX_SOCKET (`usePrivateTmux`, whose server
 * outlives dispose), SEANCE_CLAUDE_BIN. The caller owns
 * them because they are process-global and the daemon suite plays the same
 * game in its own files. `exclaves` populate the daemon's fixture home. The
 * suite's own daemon is always on the relay's SCHEDULER_LEADERS; `stackOpts` adds others.
 */
export async function startStack(
  base: string,
  exclaves: readonly ExclaveFixture[] = [],
  stackOpts: StackOptions = {},
): Promise<Stack> {
  const fixture = await makeGitFixture(base);
  const stub = await makeClaudeStub(base);
  const home = await makeHome(join(base, "home"), exclaves);
  process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
  const stateDir = process.env["SEANCE_STATE_DIR"];
  if (stateDir === undefined) throw new Error("startStack requires SEANCE_STATE_DIR to be set first");

  const leaders = await Promise.all([
    mintDeviceId(stateDir),
    ...(stackOpts.secondLeaders ?? []).map((name) => mintDeviceId(join(secondDir(base, name), "state"))),
  ]);
  const relay = await startRelay(TOKEN, { leaders: [...leaders, ...(stackOpts.leaders ?? [])] });
  // A later step failing must not strand the relay: its workerd outlives the process otherwise (CLAUDE.md, Testing).
  const failed = async (error: unknown): Promise<never> => {
    await relay.dispose();
    throw error;
  };
  const appKey = await importPsk(PSK).catch(failed);

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

  const QUIET_MS = 3_600_000;
  const startTestDaemon = (spawnWaitMs = DEFAULT_SPAWN_WAIT_MS, quiet = false): Promise<DaemonHandle> =>
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
      // A failed takeover still retries promptly: only the regular tick waits the hour.
      ...(quiet ? { telemetryIntervalMs: QUIET_MS, leader: { tickIntervalMs: QUIET_MS, takeoverRetryMs: 200 } } : {}),
    });

  let daemon = await startTestDaemon().catch(failed);
  const state = await readState(join(stateDir, "state.json")).catch(async (error: unknown) => {
    daemon.stop();
    return failed(error);
  });
  if (state === null) {
    daemon.stop();
    return failed(new Error("the daemon's state.json is missing or unreadable"));
  }
  const { deviceId } = state;

  const secondProcs = new Set<Subprocess>();
  const startSecondDaemon = async (opts: SecondDaemonOpts): Promise<SecondDaemon> => {
    const dir = secondDir(base, opts.name);
    const secondState = join(dir, "state");
    const configDir = join(dir, "config");
    const tmuxSession = `${TMUX_SESSION}-${opts.name.toLowerCase()}`;
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), JSON.stringify({ ...config, name: opts.name, tmuxSession }));
    const secondHome = await makeHome(join(dir, "home"), opts.exclaves ?? []);
    const log = join(dir, "daemon.log");
    if (opts.beforeBoot !== undefined) {
      await mkdir(secondState, { recursive: true });
      await opts.beforeBoot(secondState);
    }
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "remote-daemon.ts"), secondHome], {
      env: { ...process.env, SEANCE_STATE_DIR: secondState, SEANCE_CONFIG_DIR: configDir, ...opts.env },
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
        async () => (await readState(statePath).catch(() => null)) !== null,
        `${opts.name}'s state.json`,
        10_000,
      );
    } catch (error) {
      await stop();
      throw error;
    }
    const secondParsed = await readState(statePath);
    if (secondParsed === null) {
      await stop();
      throw new Error(`${opts.name}'s state.json vanished after it parsed`);
    }
    return { deviceId: secondParsed.deviceId, log, tmuxSession, stateDir: secondState, stop };
  };

  const stack: Stack = {
    relay,
    config,
    fixture,
    stub,
    appKey,
    deviceId,
    daemon,
    queue: (): QueueStore =>
      createQueueStore({ leg: daemon.client, key: appKey, term: daemon.leader.term() ?? 0, now: Date.now }),
    seedTask: async (task: Task): Promise<void> => {
      // Only an app creates a task, and an app's create nudges the leader, which would act on version 1
      // before version 2 lands. So the daemon goes, and a stand-in signing as it holds a term of its own:
      // it ignores the nudge, writes the rest, and leaves the record for the restarted daemon's takeover.
      daemon.stop();
      adoptIdentity(await identityOfState(await loadOrInitState(join(stateDir, "state.json"))));
      const standIn = await connectDaemon(relay);
      const app = await connectApp(relay);
      try {
        standIn.send(await register(deviceId, { roles: [DAEMON_ROLES.scheduler] }));
        const { term } = await standIn.waitFor<Extract<RelayToDaemonFrame, { t: "lead" }>>("lead", 10_000);
        const queueOn = (client: Client): QueueStore =>
          createQueueStore({ leg: storeLeg(client), key: appKey, term, now: Date.now });
        // Version 1 must be `queued`: the adapter refuses any other first write.
        const created = await queueOn(app).put(task.id, 0, {
          id: task.id,
          spec: task.spec,
          state: "queued",
          createdAt: task.createdAt,
        });
        if (!created.ok) throw new Error(`seeding ${task.id}: ${created.code}`);
        if (task.state === "queued") return;
        const advanced = await queueOn(standIn).put(task.id, 1, task);
        if (!advanced.ok) throw new Error(`seeding ${task.id}: ${advanced.code}`);
      } finally {
        app.close();
        standIn.close();
      }
    },
    restartDaemon: async (opts: { readonly spawnWaitMs?: number; readonly quiet?: boolean } = {}): Promise<void> => {
      // A failed test's finally can land here with the old daemon still live;
      // an orphan would share the state dir, deviceId and tmux for the rest
      // of the process. stop() is idempotent, so always stop before starting.
      daemon.stop();
      daemon = await startTestDaemon(opts.spawnWaitMs, opts.quiet);
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
