import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { importPsk, open, parseMachineStatus, toBase64, type MachineStatus } from "@seance/shared";
import { createBackend } from "../src/backend-default.ts";
import type { Config } from "../src/config.ts";
import { scanExclaves, type ExclaveScan } from "../src/exclaves.ts";
import { exec } from "../src/exec.ts";
import { startDaemon } from "../src/run.ts";
import { createUsageRefresh, USAGE_ARGS, type UsageRefresh, type UsageRefreshOpts } from "../src/usage-refresh.ts";
import {
  captureLog,
  makeGitFixture,
  pollUntil,
  usePrivateTmux,
  type GitFixture,
  type PrivateTmux,
} from "./fixtures.ts";
import { startTestRelay } from "./harness.ts";

const WARM_FLAG = "--stub-warm";
const MIN = 60_000;

/**
 * Stands in for `claude -p /usage`: records each run's argv, env and pid, then
 * does what `control.json` says for its exclave — `write` stamps the cache at
 * the control clock as Claude Code would, `leave` exits 0 with the cache
 * untouched, `fail` exits 1, `slow` writes after a beat, `hang` never exits.
 * Bun by shebang, not a bash wrapper: bash adds `PWD`, `SHLVL` and `_`, and the
 * env this records is the assertion.
 */
const STUB = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
if (process.argv[2] === "${WARM_FLAG}") process.exit(0);
const dir = import.meta.dir;
const configDir = process.env.CLAUDE_CONFIG_DIR;
const exclave = configDir === undefined ? "default" : basename(configDir).replace(/^\\.claude-/, "");
const control = JSON.parse(readFileSync(join(dir, "control.json"), "utf8"));
const mode = control.modes[exclave] ?? "write";
const record = (phase) =>
  appendFileSync(
    join(dir, "runs.jsonl"),
    JSON.stringify({ phase, exclave, pid: process.pid, at: performance.timeOrigin + performance.now(), argv: process.argv.slice(2), env: { ...process.env }, cwd: process.cwd() }) + "\\n",
  );
record("start");
if (mode === "hang") await Bun.sleep(600_000);
if (mode === "slow") await Bun.sleep(150);
if (mode === "fail") process.exit(1);
if (mode === "write" || mode === "slow") {
  const file = join(configDir ?? process.env.HOME, ".claude.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.cachedUsageUtilization = { fetchedAtMs: control.clock, utilization: { five_hour: { utilization: 33 } } };
  writeFileSync(file, JSON.stringify(config));
}
record("end");
`;

interface Run {
  readonly phase: "start" | "end";
  readonly exclave: string;
  readonly pid: number;
  readonly at: number;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

type Mode = "write" | "leave" | "fail" | "slow" | "hang";

let base: string;
let stubDir: string;
let stub: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-usage-refresh-"));
  stubDir = join(base, "stub");
  await mkdir(stubDir);
  stub = join(stubDir, "claude");
  await writeFile(stub, STUB);
  await chmod(stub, 0o755);
  // The first exec of a new file pays macOS's scan; pay it here, outside every timed window.
  await exec([stub, WARM_FLAG]);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

let home: string;
let clock: number;
let instances: UsageRefresh[];

const account = { oauthAccount: { organizationUuid: "org", accountUuid: "acct" } };

beforeEach(async () => {
  home = await mkdtemp(join(base, "home-"));
  clock = 1_800_000_000_000;
  instances = [];
  await writeFile(join(home, ".exclaves"), "work\noff\n");
  await mkdir(join(home, "work"));
  await mkdir(join(home, "off"));
  await mkdir(join(home, ".claude-work"));
  await mkdir(join(home, ".claude-off"));
  await writeFile(join(home, ".claude.json"), JSON.stringify(account));
  await writeFile(join(home, ".claude-work", ".claude.json"), JSON.stringify(account));
  await rm(join(stubDir, "runs.jsonl"), { force: true });
  await control({});
});

afterEach(async () => {
  for (const instance of instances) instance.stop();
  await Promise.all(instances.map((instance) => instance.idle()));
});

async function control(modes: Readonly<Record<string, Mode>>): Promise<void> {
  await writeFile(join(stubDir, "control.json"), JSON.stringify({ modes, clock }));
}

/** Stamps an exclave's cache `ageMs` before the test clock. */
async function cacheAged(exclave: "default" | "work" | "off", ageMs: number): Promise<void> {
  const file = exclave === "default" ? join(home, ".claude.json") : join(home, `.claude-${exclave}`, ".claude.json");
  const signedIn = exclave !== "off";
  await writeFile(
    file,
    JSON.stringify({
      ...(signedIn ? account : {}),
      cachedUsageUtilization: { fetchedAtMs: clock - ageMs, utilization: { five_hour: { utilization: 10 } } },
    }),
  );
}

async function runs(): Promise<readonly Run[]> {
  const text = await readFile(join(stubDir, "runs.jsonl"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Run);
}

async function started(): Promise<readonly Run[]> {
  return (await runs()).filter((run) => run.phase === "start");
}

async function refresher(opts: UsageRefreshOpts = {}): Promise<UsageRefresh> {
  const scan: ExclaveScan = await scanExclaves(home);
  const instance = createUsageRefresh({ scan: () => scan, home, claudeBin: stub, now: () => clock, ...opts });
  instances.push(instance);
  return instance;
}

describe("the /usage refresh", () => {
  test("refreshes a stale exclave once, with fixed argv and a built env, and leaves a fresh one", async () => {
    await cacheAged("default", 11 * MIN);
    await cacheAged("work", 11 * MIN);
    const usage = await refresher();

    usage.poke("default");
    usage.poke("work");
    await usage.idle();

    const first = await started();
    expect(first.map((run) => run.exclave)).toEqual(["default", "work"]);
    const user = userInfo().username;
    for (const run of first) {
      expect(run.argv).toEqual([...USAGE_ARGS]);
      expect(run.cwd).toBe(home);
    }
    const path = process.env["PATH"] ?? "";
    expect(first[0]?.env).toEqual({ HOME: home, PATH: path, USER: user, LOGNAME: user });
    expect(first[1]?.env).toEqual({
      HOME: home,
      PATH: path,
      USER: user,
      LOGNAME: user,
      CLAUDE_CONFIG_DIR: join(home, ".claude-work"),
    });

    // The runs stamped both caches at the clock: fresh now, so a poke spawns nothing.
    usage.poke("default");
    usage.poke("work");
    await usage.idle();
    expect(await started()).toHaveLength(2);
  });

  test("a reading inside staleAfter, a signed-out exclave and an unknown one never run", async () => {
    await cacheAged("default", 9 * MIN);
    await cacheAged("off", 60 * MIN);
    const usage = await refresher();

    usage.poke("default");
    usage.poke("off");
    usage.poke("nope");
    await usage.idle();

    expect(await started()).toEqual([]);
  });

  test("an exclave with no cached reading yet is stale", async () => {
    const usage = await refresher();

    usage.poke("work");
    await usage.idle();

    expect((await started()).map((run) => run.exclave)).toEqual(["work"]);
  });

  test("staleAfter is floored at Claude Code's 60 s debounce", async () => {
    await cacheAged("default", 30_000);
    await cacheAged("work", 61_000);
    const usage = await refresher({ staleAfterMs: 1_000 });

    usage.poke("default");
    usage.poke("work");
    await usage.idle();

    expect((await started()).map((run) => run.exclave)).toEqual(["work"]);
  });

  test("a failing refresh warns once per streak, backs off for staleAfter, and says when it recovers", async () => {
    await cacheAged("default", 11 * MIN);
    await cacheAged("work", 11 * MIN);
    await control({ default: "fail", work: "leave" });

    const lines = await captureLog(async () => {
      const usage = await refresher();
      usage.poke("default");
      usage.poke("work");
      await usage.idle();
      expect(await started()).toHaveLength(2);

      // Backed off: a poke inside staleAfter of the failure spawns nothing.
      clock += 9 * MIN;
      usage.poke("default");
      usage.poke("work");
      await usage.idle();
      expect(await started()).toHaveLength(2);

      // Past it, each retries; still failing, neither warns again.
      clock += 2 * MIN;
      await control({ default: "fail", work: "leave" });
      usage.poke("default");
      usage.poke("work");
      await usage.idle();
      expect(await started()).toHaveLength(4);

      clock += 11 * MIN;
      await control({});
      usage.poke("default");
      await usage.idle();
      expect(await started()).toHaveLength(5);
    });

    const said = lines.filter((line) => line.includes("usage refresh"));
    expect(said).toHaveLength(3);
    expect(said[0]).toContain("default failed (exit 1, the cache did not move)");
    expect(said[1]).toContain("work failed (the cache did not move)");
    expect(said[2]).toContain("default refreshed again");
  });

  test("the timer checks every exclave, and stop ends it", async () => {
    await cacheAged("default", 0);
    await cacheAged("work", 11 * MIN);
    const usage = await refresher({ checkIntervalMs: 50 });

    usage.start();
    await pollUntil(async () => (await started()).length === 1, "the first check's run");
    await cacheAged("default", 11 * MIN);
    await pollUntil(async () => (await started()).length === 2, "a timer check's run");
    expect((await started()).map((run) => run.exclave)).toEqual(["work", "default"]);

    usage.stop();
    await usage.idle();
    await cacheAged("work", 11 * MIN);
    await Bun.sleep(200);
    expect(await started()).toHaveLength(2);
  });

  test("runs never overlap, across exclaves or across two instances in one process", async () => {
    await cacheAged("default", 11 * MIN);
    await cacheAged("work", 11 * MIN);
    await control({ default: "slow", work: "slow" });
    // A config reload's second daemon, its own instance, sharing the process.
    const [a, b] = [await refresher(), await refresher()];

    a.poke("default");
    b.poke("work");
    await Promise.all([a.idle(), b.idle()]);

    const all = await runs();
    expect(all.map((run) => `${run.phase}:${run.exclave}`)).toEqual([
      "start:default",
      "end:default",
      "start:work",
      "end:work",
    ]);
  });

  test("a run past the timeout is killed and does not hold the slot", async () => {
    await cacheAged("default", 11 * MIN);
    await cacheAged("work", 11 * MIN);
    await control({ default: "hang" });
    const usage = await refresher({ timeoutMs: 300 });

    const lines = await captureLog(async () => {
      usage.poke("default");
      usage.poke("work");
      await usage.idle();
    });

    const [hung, next] = await started();
    expect(next?.exclave).toBe("work");
    expect(alive(hung?.pid ?? 0)).toBe(false);
    expect(lines.join("\n")).toContain("default failed (timed out after 0.3s)");
  });
});

describe("the daemon", () => {
  const PSK = toBase64(new Uint8Array(32).fill(4));
  const TOKEN = "test-bearer";
  let privateTmux: PrivateTmux | undefined;
  let fixture: GitFixture;
  let appKey: CryptoKey;

  beforeAll(async () => {
    process.env["SEANCE_STATE_DIR"] = join(base, "state");
    // The daemon's own CLAUDE_CONFIG_DIR, which a `default` run must not inherit.
    process.env["CLAUDE_CONFIG_DIR"] = join(base, "ambient-claude");
    privateTmux = usePrivateTmux(base, "usage-refresh");
    fixture = await makeGitFixture(base);
    appKey = await importPsk(PSK);
  });

  afterAll(async () => {
    await privateTmux?.dispose();
    delete process.env["SEANCE_STATE_DIR"];
    delete process.env["CLAUDE_CONFIG_DIR"];
  });

  test("refreshes a stale exclave at start, and the next status carries the refreshed reading", async () => {
    clock = Date.now();
    await cacheAged("default", 11 * MIN);
    await cacheAged("work", 0);
    await control({});
    const relay = startTestRelay(TOKEN);
    const config: Config = {
      name: "UsageMac",
      relayUrl: relay.url,
      bearerToken: TOKEN,
      psk: PSK,
      repoRoots: [fixture.root],
      tmuxSession: "main",
    };
    let daemon: { stop(): void } | undefined;
    try {
      daemon = await startDaemon({
        config,
        backend: createBackend(config, { home }),
        home,
        pingIntervalMs: 60_000,
        pongTimeoutMs: 1_000,
        baseBackoffMs: 20,
        telemetryIntervalMs: 100,
        usageRefresh: { claudeBin: stub },
      });

      let status: MachineStatus | null = null;
      const deadline = Date.now() + 10_000;
      while (status?.quota?.find((q) => q.x === 0)?.h !== 33) {
        if (Date.now() > deadline) throw new Error(`no refreshed reading; last status ${JSON.stringify(status)}`);
        // oxlint-disable-next-line no-await-in-loop -- statuses arrive in order
        status = parseMachineStatus((await open(appKey, await relay.statuses.next(5_000))).payload);
      }

      const first = await started();
      expect(first.map((run) => run.exclave)).toEqual(["default"]);
      expect(first[0]?.env["CLAUDE_CONFIG_DIR"]).toBeUndefined();
    } finally {
      daemon?.stop();
      relay.stop();
    }
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
