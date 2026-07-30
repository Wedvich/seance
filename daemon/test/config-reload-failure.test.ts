import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPsk, open, toBase64, type MachineInfo } from "@seance/shared";
import { watchConfigFile } from "../src/config.ts";
import { startDaemon, type DaemonHandle, type RunOpts } from "../src/run.ts";
import { startSupervisor, type SuperviseOpts, type SupervisorHandle } from "../src/supervise.ts";
import { makeGitFixture, type GitFixture } from "./fixtures.ts";
import { startTestRelay, type TestRelay } from "./harness.ts";

/**
 * What the supervisor does when a *swap* fails, which is separate from the
 * bad-edit paths in config-reload.test.ts: there the new config is rejected
 * before anything is stopped, here it passes validation and `startDaemon`
 * throws anyway (an unreadable state dir, say), which is what can leave the
 * machine with nothing running.
 */

const PSK = toBase64(new Uint8Array(32).fill(7));
const TOKEN = "reload-failure-bearer";
const DEBOUNCE_MS = 30;

let base: string;
let fixture: GitFixture;
let appKey: CryptoKey;
let supervisor: SupervisorHandle | null = null;
let relay: TestRelay | null = null;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-reload-fail-"));
  process.env["SEANCE_STATE_DIR"] = join(base, "state");
  fixture = await makeGitFixture(base);
  appKey = await importPsk(PSK);
});

afterAll(async () => {
  delete process.env["SEANCE_STATE_DIR"];
  await rm(base, { recursive: true, force: true });
});

afterEach(() => {
  supervisor?.stop();
  supervisor = null;
  relay?.stop();
  relay = null;
});

async function writeConfig(path: string, name: string, relayUrl: string): Promise<void> {
  const config = {
    name,
    relayUrl,
    bearerToken: TOKEN,
    psk: PSK,
    repoRoots: [fixture.root],
    tmuxSession: "main",
  };
  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** Registers arrive for rescans too, so wait for the one carrying the expected name. */
async function registerAs(testRelay: TestRelay, name: string): Promise<MachineInfo> {
  for (let i = 0; i < 6; i++) {
    const frame = await testRelay.registers.next(5_000);
    const plain = await open(appKey, frame.info);
    const info = plain.payload as MachineInfo;
    if (info.name === name) return info;
  }
  throw new Error(`no register frame named ${name}`);
}

async function startSupervised(path: string, extra: Partial<SuperviseOpts> = {}): Promise<SupervisorHandle> {
  const handle = await startSupervisor({
    configPath: path,
    debounceMs: DEBOUNCE_MS,
    pingIntervalMs: 60_000,
    pongTimeoutMs: 1_000,
    baseBackoffMs: 20,
    ...extra,
  });
  supervisor = handle;
  return handle;
}

/**
 * Wraps the *real* `startDaemon`, failing the starts a predicate picks out.
 * Predicate rather than a call count on purpose: one save can produce more than
 * one watcher event, and a retry is legitimate once nothing is running.
 */
function injectStart(shouldFail: (opts: RunOpts) => boolean): (opts: RunOpts) => Promise<DaemonHandle> {
  return async (opts: RunOpts): Promise<DaemonHandle> => {
    if (shouldFail(opts)) throw new Error("injected startDaemon failure");
    return startDaemon(opts);
  };
}

/** Captures both streams — `log.ts` splits `error` onto console.error. */
async function captureLog(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const capture = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  const realLog = console.log;
  const realError = console.error;
  console.log = capture;
  console.error = capture;
  try {
    await body();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return lines;
}

/** One config file per test: the watcher is per-directory, so shared dirs cross-talk. */
async function configFile(): Promise<string> {
  return join(await mkdtemp(join(base, "cfg-")), "config.json");
}

async function settle(): Promise<void> {
  await Bun.sleep(DEBOUNCE_MS + 250);
}

/**
 * A fresh connection is the only unambiguous evidence a daemon restarted here:
 * the register queue still holds the frames the *first* daemon sent, and these
 * tests reuse one config name across the failure and the recovery, so matching
 * on a name would pass on a stale frame.
 */
async function waitForConnections(testRelay: TestRelay, atLeast: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (testRelay.connectionCount() >= atLeast) return;
    await Bun.sleep(10);
  }
  throw new Error(`only ${testRelay.connectionCount()} connections, wanted ${atLeast}`);
}

describe("config reload failure paths", () => {
  test("reverting the config recovers a daemon left down by a failed rollback", async () => {
    const testRelay = startTestRelay(TOKEN);
    relay = testRelay;
    const path = await configFile();
    await writeConfig(path, "Healthy", testRelay.url);

    // Both the swap and its rollback fail while this is set, which is the state
    // the daemon can be left in: nothing running, last-good config still cached.
    let failing = false;
    await startSupervised(path, { startDaemon: injectStart(() => failing) });
    await registerAs(testRelay, "Healthy");
    const connectionsBefore = testRelay.connectionCount();

    failing = true;
    await writeConfig(path, "Doomed", testRelay.url);
    await settle();
    expect(testRelay.connectionCount()).toBe(connectionsBefore);

    // The obvious recovery: put back exactly the config that was working. It is
    // byte-identical to the one still cached, so the deep-equal guard has to
    // yield to the fact that nothing is running.
    failing = false;
    await writeConfig(path, "Healthy", testRelay.url);
    await waitForConnections(testRelay, connectionsBefore + 1);
    expect((await supervisor!.current()).client.connected).toBe(true);
  });

  test("a rolled-back swap does not log a reload", async () => {
    const testRelay = startTestRelay(TOKEN);
    relay = testRelay;
    const path = await configFile();
    await writeConfig(path, "Healthy", testRelay.url);

    await startSupervised(path, {
      startDaemon: injectStart((opts) => opts.config?.name === "Rejected"),
    });
    await registerAs(testRelay, "Healthy");
    const connectionsBefore = testRelay.connectionCount();

    const lines = await captureLog(async () => {
      await writeConfig(path, "Rejected", testRelay.url);
      await settle();
    });

    expect(lines.some((line) => line.includes("rolling back"))).toBe(true);
    // The old config is what came back up; saying "reloaded" would name a config
    // that was never adopted.
    expect(lines.some((line) => line.includes("reloaded as"))).toBe(false);
    // The rollback really did restart on the old config, rather than leaving nothing.
    await waitForConnections(testRelay, connectionsBefore + 1);
    expect((await supervisor!.current()).client.connected).toBe(true);
  });

  test("a reload that throws leaves the supervisor able to reload again", async () => {
    const testRelay = startTestRelay(TOKEN);
    relay = testRelay;
    const path = await configFile();
    await writeConfig(path, "First", testRelay.url);

    // `swap` stops the old daemon *before* its try block, so a throwing stop
    // escapes `reload` entirely. Nothing awaits the reload chain, so without a
    // guard this is an unhandled rejection — fatal under Bun's default — and a
    // chain that never runs another reload.
    let poisoned = false;
    const start = async (opts: RunOpts): Promise<DaemonHandle> => {
      const handle = await startDaemon(opts);
      return {
        client: handle.client,
        stop: (): void => {
          handle.stop();
          if (poisoned) throw new Error("injected stop failure");
        },
      };
    };

    await startSupervised(path, { startDaemon: start });
    await registerAs(testRelay, "First");

    poisoned = true;
    await writeConfig(path, "Poisoned", testRelay.url);
    await settle();

    poisoned = false;
    await writeConfig(path, "Recovered", testRelay.url);
    await registerAs(testRelay, "Recovered");
  });

  test("a watch that cannot be established is retried, not abandoned", async () => {
    // The `error` event that closes a live watcher (inotify limit, directory
    // replaced wholesale) has no portable trigger, so this covers the same
    // arm/retry/recover path from the other end: a directory that isn't there
    // yet. Either way the old code gave up for the life of the process, while
    // the README promises edits need no restart.
    const dir = join(base, `late-${crypto.randomUUID()}`);
    const path = join(dir, "config.json");
    let changes = 0;
    const lines = await captureLog(async () => {
      const unwatch = watchConfigFile(() => changes++, path, DEBOUNCE_MS, 20);
      try {
        await mkdir(dir, { recursive: true });
        await Bun.sleep(120);
        await Bun.write(path, "{}");
        await settle();
      } finally {
        unwatch();
      }
    });

    expect(changes).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes("config hot reload is off"))).toBe(true);
    expect(lines.some((line) => line.includes("for changes again"))).toBe(true);
  });
});
