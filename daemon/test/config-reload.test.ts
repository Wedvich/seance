import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { importPsk, open, toBase64, type MachineInfo } from "@seance/shared";
import { pskFingerprint } from "../src/config-checks.ts";
import { conversationsPath } from "../src/paths.ts";
import { subscriptionsFor } from "../src/run-capabilities.ts";
import { saveState, type State } from "../src/state.ts";
import { startSupervisor, type SupervisorHandle } from "../src/supervise.ts";
import {
  awaitWatcherLive,
  captureLog,
  makeConfigTrigger,
  makeGitFixture,
  usePrivateTmux,
  type ConfigTrigger,
  type GitFixture,
  type PrivateTmux,
} from "./fixtures.ts";
import { startTestRelay, type TestRelay } from "./harness.ts";
import { tmux } from "../src/tmux.ts";

const PSK = toBase64(new Uint8Array(32).fill(5));
const TOKEN = "reload-bearer";
/** Long enough to coalesce a save burst, short enough that tests wait on the daemon, not the timer. */
const DEBOUNCE_MS = 30;

let base: string;
let privateTmux: PrivateTmux | undefined;
let fixture: GitFixture;
let appKey: CryptoKey;
let supervisor: SupervisorHandle | null = null;
let trigger: ConfigTrigger | null = null;
let relay: TestRelay | null = null;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-reload-"));
  process.env["SEANCE_STATE_DIR"] = join(base, "state");
  // every daemon start publishes the machine tag to tmux; keep it off the real server
  privateTmux = usePrivateTmux(base, "reload");
  fixture = await makeGitFixture(base);
  appKey = await importPsk(PSK);
});

afterAll(async () => {
  await privateTmux?.dispose();
  delete process.env["SEANCE_STATE_DIR"];
  await rm(base, { recursive: true, force: true });
});

afterEach(async () => {
  await supervisor?.stop();
  supervisor = null;
  trigger = null;
  relay?.stop();
  relay = null;
});

async function writeConfig(path: string, name: string, relayUrl: string, machineTag?: string): Promise<void> {
  const config = {
    name,
    relayUrl,
    bearerToken: TOKEN,
    psk: PSK,
    repoRoots: [fixture.root],
    tmuxSession: "main",
    ...(machineTag !== undefined ? { machineTag } : {}),
  };
  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** What every editor and most tools actually do on save: write beside, then rename over. */
async function writeConfigAtomically(path: string, name: string, relayUrl: string): Promise<void> {
  const temp = `${path}.tmp`;
  await writeConfig(temp, name, relayUrl);
  await rename(temp, path);
}

/**
 * Registers arrive for rescans too, so wait for the one carrying the expected
 * name — and, when asked, the repo with it. A daemon registers its *cached*
 * repo set immediately and only re-registers once the background scan has
 * landed and been saved, so the first frame under a fresh state dir names no
 * repos at all.
 */
async function registerAs(testRelay: TestRelay, name: string, repo?: string): Promise<MachineInfo> {
  for (let i = 0; i < 6; i++) {
    const frame = await testRelay.registers.next(5_000);
    const plain = await open(appKey, frame.info);
    const info = plain.payload as MachineInfo;
    if (info.name !== name) continue;
    if (repo === undefined || info.repos.some((r) => r.name === repo)) return info;
  }
  throw new Error(`no register frame named ${name}`);
}

const RUN_OPTS = { pingIntervalMs: 60_000, pongTimeoutMs: 1_000, baseBackoffMs: 20 } as const;

/** Reloads arrive through the injected trigger, so nothing below depends on fs.watch firing. */
async function startSupervised(path: string): Promise<SupervisorHandle> {
  trigger = makeConfigTrigger();
  const handle = await startSupervisor({ configPath: path, watch: trigger.watch, ...RUN_OPTS });
  supervisor = handle;
  return handle;
}

/** For the one test that is about the watcher itself: the real one, and the barrier it needs. */
async function startWatched(path: string): Promise<SupervisorHandle> {
  const handle = await startSupervisor({ configPath: path, debounceMs: DEBOUNCE_MS, ...RUN_OPTS });
  supervisor = handle;
  // It edits within milliseconds of this returning, which is the one window
  // where the watch can silently miss a write.
  await awaitWatcherLive(dirname(path));
  return handle;
}

/**
 * Delivers one config change and resolves once the supervisor has finished
 * reacting to it — `current()` awaits the reload chain the trigger just
 * extended, which is what leaves these tests with no timing in them.
 */
async function reload(): Promise<void> {
  trigger!.fire();
  await supervisor!.current();
}

/** What a hand-run `claude` in a new tmux window inherits, for the tmux-rename mod. */
async function tagInTmux(): Promise<string> {
  return (await tmux(["show-environment", "-g", "SEANCE_MACHINE_TAG"])).stdout.trim();
}

/** One config file per test: the watcher is per-directory, so shared dirs cross-talk. */
async function configFile(): Promise<string> {
  return join(await mkdtemp(join(base, "cfg-")), "config.json");
}

describe("config hot reload", () => {
  test("an edited config re-registers without restarting the process", async () => {
    relay = startTestRelay(TOKEN);
    const path = await configFile();
    await writeConfig(path, "BeforeEdit", relay.url);

    await startSupervised(path);
    // The scan has to have committed before the edit. A register naming the repo
    // proves only that, not its save; the reload's stop drains the save, so the
    // reloaded daemon reads the repo from the state file the first one wrote.
    await registerAs(relay, "BeforeEdit", "myrepo");

    const pid = process.pid;
    await writeConfig(path, "AfterEdit", relay.url);
    await reload();

    const info = await registerAs(relay, "AfterEdit");
    expect(info.repos.some((r) => r.name === "myrepo")).toBe(true);
    expect(process.pid).toBe(pid);
  });

  test("a reload starts its daemon only once the outgoing one's state save has landed", async () => {
    const live = startTestRelay(TOKEN);
    relay = live;
    const path = await configFile();
    await writeConfig(path, "BeforeEdit", live.url);
    // Holds the boot scan's save, the first one carrying the repo, as a slow disk would.
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    const writeState = async (state: State): Promise<void> => {
      if (!held && state.repos.some((r) => r.name === "myrepo")) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      await saveState(state);
    };

    const lines = await captureLog(async () => {
      trigger = makeConfigTrigger();
      supervisor = await startSupervisor({ configPath: path, watch: trigger.watch, writeState, ...RUN_OPTS });
      await entered.promise;
      await writeConfig(path, "AfterEdit", live.url);
      trigger.fire();
      // Room for a reload that does not wait to start its daemon on the unsaved file.
      await Bun.sleep(100); // a non-event can't be polled
      release.resolve();
      await supervisor.current();
    });

    const starts = lines.filter((line) => line.includes("seanced starting"));
    expect(starts).toHaveLength(2);
    expect(starts[1]).toContain(", 1 cached repos,");
    const info = await registerAs(live, "AfterEdit");
    expect(info.repos.some((r) => r.name === "myrepo")).toBe(true);
    // The hold took effect: the save was in flight when the reload fired.
    expect(held).toBe(true);
  });

  test("every start, the first and each reload's, logs the key's fingerprint and where it came from", async () => {
    // On a credential-delivered box nothing outside the unit can read the key,
    // so this line is the only place its fingerprint can come from — and doctor
    // points there for it.
    const live = startTestRelay(TOKEN);
    relay = live;
    const path = await configFile();
    await writeConfig(path, "Fingerprinted", live.url);
    const lines = await captureLog(async () => {
      await startSupervised(path);
      await registerAs(live, "Fingerprinted");
      await writeConfig(path, "Refingerprinted", live.url);
      await reload();
    });
    const expected = `psk ${await pskFingerprint(PSK)} (config)`;
    const starts = lines.filter((line) => line.includes("seanced starting"));
    expect(starts).toHaveLength(2);
    for (const line of starts) expect(line).toContain(expected);
    expect(lines.join("\n")).not.toContain(PSK);
  });

  test("the machine tag reaches tmux's global environment, and follows an edit", async () => {
    relay = startTestRelay(TOKEN);
    const path = await configFile();
    await writeConfig(path, "Tagged", relay.url, "WSL Box");

    await startSupervised(path);
    expect(await tagInTmux()).toBe("SEANCE_MACHINE_TAG=wsl-box");

    await writeConfig(path, "Tagged", relay.url);
    await reload();
    expect(await tagInTmux()).toBe("SEANCE_MACHINE_TAG=");
  });

  test("a config replaced by rename is still watched on the next save", async () => {
    relay = startTestRelay(TOKEN);
    const path = await configFile();
    await writeConfig(path, "First", relay.url);

    await startWatched(path);
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
    await reload();
    expect(relay.connectionCount()).toBe(connectionsBefore);
    expect((await supervisor!.current()).client.connected).toBe(true);

    // An unrunnable but parseable config is refused the same way.
    await Bun.write(path, `${JSON.stringify({ ...validShape(relay.url), relayUrl: "http://nope" }, null, 2)}\n`);
    await reload();
    expect(relay.connectionCount()).toBe(connectionsBefore);
    expect((await supervisor!.current()).client.connected).toBe(true);

    await writeConfig(path, "Fixed", relay.url);
    await reload();
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
    await reload();

    expect(relay.connectionCount()).toBe(connectionsBefore);
  });

  test("a label written just before a reload survives it: one conversations file, one store", async () => {
    relay = startTestRelay(TOKEN);
    const path = await configFile();
    await writeConfig(path, "Labelled", relay.url);
    await startSupervised(path);
    await registerAs(relay, "Labelled");

    const file = conversationsPath();
    const store = subscriptionsFor(file);
    const first = "0f3c9a8e-1b2d-4c5e-8f70-123456789abc";
    const second = "1f3c9a8e-1b2d-4c5e-8f70-123456789abc";
    // Not awaited: its write is still on the store's chain when the reload stops this daemon and starts the next.
    const written = store.setLabel(first, "before the reload");
    await writeConfig(path, "Relabelled", relay.url);
    await reload();
    await written;

    // The reloaded daemon's session events took the same store, so its writes carry the label made before.
    expect(subscriptionsFor(file)).toBe(store);
    await store.setLabel(second, "after the reload");
    await store.flushed();
    const onDisk: unknown = JSON.parse(await readFile(file, "utf8"));
    expect(onDisk).toMatchObject({
      conversations: {
        [first]: { ownerLabel: { value: "before the reload" } },
        [second]: { ownerLabel: { value: "after the reload" } },
      },
    });
  });

  test("stop() stops watching", async () => {
    relay = startTestRelay(TOKEN);
    const path = await configFile();
    await writeConfig(path, "Stopping", relay.url);

    const handle = await startSupervised(path);
    await registerAs(relay, "Stopping");

    await handle.stop();
    supervisor = null;

    // With the seam this is the whole claim: the supervisor released the
    // watcher, so no later edit can reach it. Writing one and failing to
    // observe a reconnect would only prove the sleep was long enough.
    expect(trigger!.watching()).toBe(false);
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
