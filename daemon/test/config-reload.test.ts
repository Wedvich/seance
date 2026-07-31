import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { importPsk, open, toBase64, type MachineInfo } from "@seance/shared";
import { startSupervisor, type SupervisorHandle } from "../src/supervise.ts";
import { awaitWatcherLive, makeGitFixture, type GitFixture } from "./fixtures.ts";
import { startTestRelay, type TestRelay } from "./harness.ts";

const PSK = toBase64(new Uint8Array(32).fill(5));
const TOKEN = "reload-bearer";
/** Long enough to coalesce a save burst, short enough that tests wait on the daemon, not the timer. */
const DEBOUNCE_MS = 30;

let base: string;
let fixture: GitFixture;
let appKey: CryptoKey;
let supervisor: SupervisorHandle | null = null;
let relay: TestRelay | null = null;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-reload-"));
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

/** What every editor and most tools actually do on save: write beside, then rename over. */
async function writeConfigAtomically(path: string, name: string, relayUrl: string): Promise<void> {
  const temp = `${path}.tmp`;
  await writeConfig(temp, name, relayUrl);
  await rename(temp, path);
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

async function startSupervised(path: string): Promise<SupervisorHandle> {
  const handle = await startSupervisor({
    configPath: path,
    debounceMs: DEBOUNCE_MS,
    pingIntervalMs: 60_000,
    pongTimeoutMs: 1_000,
    baseBackoffMs: 20,
  });
  supervisor = handle;
  // Every test below edits within milliseconds of this returning, which is the
  // one window where the watch can silently miss a write.
  await awaitWatcherLive(dirname(path));
  return handle;
}

/** One config file per test: the watcher is per-directory, so shared dirs cross-talk. */
async function configFile(): Promise<string> {
  return join(await mkdtemp(join(base, "cfg-")), "config.json");
}

/** Long enough for a debounced reload to have happened if it were going to. */
async function settle(): Promise<void> {
  await Bun.sleep(DEBOUNCE_MS + 250);
}

describe("config hot reload", () => {
  test("an edited config re-registers without restarting the process", async () => {
    relay = startTestRelay(TOKEN);
    const path = await configFile();
    await writeConfig(path, "BeforeEdit", relay.url);

    await startSupervised(path);
    await registerAs(relay, "BeforeEdit");

    const pid = process.pid;
    await writeConfig(path, "AfterEdit", relay.url);

    const info = await registerAs(relay, "AfterEdit");
    expect(info.repos.some((r) => r.name === "myrepo")).toBe(true);
    expect(process.pid).toBe(pid);
  });

  test("a config replaced by rename is still watched on the next save", async () => {
    relay = startTestRelay(TOKEN);
    const path = await configFile();
    await writeConfig(path, "First", relay.url);

    await startSupervised(path);
    await registerAs(relay, "First");

    // Guards two ways this breaks: a file-level watch dies on the first rename,
    // and a name-filtered directory watch never sees it at all (the event
    // carries the temp file's name). The second save is what proves it.
    await writeConfigAtomically(path, "Second", relay.url);
    await registerAs(relay, "Second");

    await writeConfigAtomically(path, "Third", relay.url);
    await registerAs(relay, "Third");
  });

  test("a broken edit keeps the running config and reloads once it is fixed", async () => {
    relay = startTestRelay(TOKEN);
    const path = await configFile();
    await writeConfig(path, "Healthy", relay.url);

    await startSupervised(path);
    await registerAs(relay, "Healthy");
    const connectionsBefore = relay.connectionCount();

    await Bun.write(path, "{ this is not json");
    await settle();
    expect(relay.connectionCount()).toBe(connectionsBefore);
    expect((await supervisor!.current()).client.connected).toBe(true);

    // An unrunnable but parseable config is refused the same way.
    await Bun.write(path, `${JSON.stringify({ ...validShape(relay.url), relayUrl: "http://nope" }, null, 2)}\n`);
    await settle();
    expect(relay.connectionCount()).toBe(connectionsBefore);
    expect((await supervisor!.current()).client.connected).toBe(true);

    await writeConfig(path, "Fixed", relay.url);
    await registerAs(relay, "Fixed");
  });

  test("a rewrite with identical contents does not reconnect", async () => {
    relay = startTestRelay(TOKEN);
    const path = await configFile();
    await writeConfig(path, "Unchanged", relay.url);

    await startSupervised(path);
    await registerAs(relay, "Unchanged");
    const connectionsBefore = relay.connectionCount();

    await writeConfig(path, "Unchanged", relay.url);
    await settle();

    expect(relay.connectionCount()).toBe(connectionsBefore);
  });

  test("stop() stops watching", async () => {
    relay = startTestRelay(TOKEN);
    const path = await configFile();
    await writeConfig(path, "Stopping", relay.url);

    const handle = await startSupervised(path);
    await registerAs(relay, "Stopping");

    handle.stop();
    supervisor = null;
    const connectionsBefore = relay.connectionCount();

    await writeConfig(path, "AfterStop", relay.url);
    await settle();

    expect(relay.connectionCount()).toBe(connectionsBefore);
  });
});

function validShape(relayUrl: string): Record<string, unknown> {
  return {
    name: "Broken",
    relayUrl,
    bearerToken: TOKEN,
    psk: PSK,
    repoRoots: [fixture.root],
    tmuxSession: "main",
  };
}
