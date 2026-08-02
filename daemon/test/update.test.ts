import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_ID,
  MACHINES_ID,
  importPsk,
  open,
  seal,
  toBase64,
  type MachineInfo,
  type UpdateAvailable,
} from "@seance/shared";
import type { Config } from "../src/config.ts";
import { exec } from "../src/exec.ts";
import { startDaemon, type DaemonHandle, type SelfUpdateOpts } from "../src/run.ts";
import { saveState } from "../src/state.ts";
import type { SessionBackend } from "../src/backend.ts";
import { pollUntil } from "./fixtures.ts";
import { startTestRelay, type TestRelay } from "./harness.ts";

const PSK = toBase64(new Uint8Array(32).fill(7));
const TOKEN = "test-bearer";
let base: string;
let appKey: CryptoKey;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-update-int-"));
  appKey = await importPsk(PSK);
});

afterAll(async () => {
  delete process.env["SEANCE_STATE_DIR"];
  await rm(base, { recursive: true, force: true });
});

const GIT_ID = ["-c", "user.email=t@t", "-c", "user.name=t"];

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await exec(["git", "-C", cwd, ...GIT_ID, ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function makePair(name: string): Promise<{ upstream: string; checkout: string }> {
  const upstream = join(base, name, "upstream");
  await exec(["git", "init", "-q", "-b", "main", upstream]);
  await runGit(upstream, ["commit", "-q", "--allow-empty", "-m", "one"]);
  const checkout = join(base, name, "checkout");
  await exec(["git", "clone", "-q", upstream, checkout]);
  return { upstream, checkout };
}

/** The backend is never exercised here — these tests never spawn. */
const inertBackend: SessionBackend = {
  spawn: () => Promise.reject(new Error("no spawns in update tests")),
  sessions: () => Promise.resolve([]),
  doctor: () => Promise.resolve([]),
};

interface TestDaemon {
  readonly daemon: DaemonHandle;
  readonly calls: { install: number; restart: number };
}

async function startTestDaemon(relay: TestRelay, name: string, selfUpdate: SelfUpdateOpts): Promise<TestDaemon> {
  // Fresh state dir per test: announce compares against the previous run's
  // sha, so sharing state across fixtures would cross-talk.
  process.env["SEANCE_STATE_DIR"] = join(base, name, "state");
  const roots = join(base, name, "roots");
  await mkdir(roots, { recursive: true });
  const config: Config = {
    name: "UpdateBox",
    relayUrl: relay.url,
    bearerToken: TOKEN,
    psk: PSK,
    repoRoots: [roots],
    tmuxSession: "main",
  };
  const calls = { install: 0, restart: 0 };
  const daemon = await startDaemon({
    config,
    backend: inertBackend,
    pingIntervalMs: 60_000,
    pongTimeoutMs: 1_000,
    baseBackoffMs: 20,
    selfUpdate: {
      debounceMs: 0,
      effects: {
        install: async () => {
          calls.install += 1;
          return { ok: true };
        },
        restart: async () => {
          calls.restart += 1;
        },
      },
      ...selfUpdate,
    },
  });
  return { daemon, calls };
}

async function sendBroadcast(relay: TestRelay, deviceId: string, payload: unknown): Promise<void> {
  const env = await seal(
    appKey,
    { to: MACHINES_ID, from: "another-machine" },
    {
      id: crypto.randomUUID(),
      ts: Date.now(),
      op: "update-available",
      payload,
    },
  );
  relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env }));
}

describe("self-update over the relay", () => {
  test("announces once to `machines` when the sha changed since the last run", async () => {
    const relay = startTestRelay(TOKEN);
    const { checkout } = await makePair("announce");
    // Seed a previous run under a different sha — the announce comparator.
    process.env["SEANCE_STATE_DIR"] = join(base, "announce", "state");
    await saveState({ deviceId: crypto.randomUUID(), repos: [], scannedAt: null, lastRunSha: "0".repeat(40) });

    const { daemon } = await startTestDaemon(relay, "announce", { root: checkout });
    try {
      const env = await relay.messages.next(3_000);
      expect(env.to).toBe(MACHINES_ID);
      const plain = await open(appKey, env);
      expect(plain.op).toBe("update-available");
      const notice = plain.payload as UpdateAvailable;
      expect(notice.sha).toBe(await runGit(checkout, ["rev-parse", "HEAD"]));
      expect(notice.commitTs).toBeGreaterThan(0);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("a fleet announce fast-forwards the checkout and re-registers with the ok", async () => {
    const relay = startTestRelay(TOKEN);
    const { upstream, checkout } = await makePair("apply");
    const { daemon, calls } = await startTestDaemon(relay, "apply", { root: checkout });
    try {
      const { deviceId } = await relay.registers.next();
      const target = await runGit(upstream, ["commit", "-q", "--allow-empty", "-m", "next"]).then(() =>
        runGit(upstream, ["rev-parse", "HEAD"]),
      );

      await sendBroadcast(relay, deviceId, { sha: target, commitTs: Date.now() });

      await pollUntil(() => calls.restart > 0, "the update pipeline to restart the daemon");
      expect(await runGit(checkout, ["rev-parse", "HEAD"])).toBe(target);
      expect(calls.install).toBe(1);

      // The report re-registers, and the fresh blob carries the outcome.
      const register = await relay.registers.next(3_000);
      const info = (await open(appKey, register.info)).payload as MachineInfo;
      expect(info.lastUpdate?.outcome).toBe("ok");
      expect(info.source?.sha).toBeDefined();
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("an announce carrying the sha we already run is the wave stopping", async () => {
    const relay = startTestRelay(TOKEN);
    const { upstream, checkout } = await makePair("own-sha");
    const { daemon, calls } = await startTestDaemon(relay, "own-sha", { root: checkout });
    try {
      const { deviceId } = await relay.registers.next();
      // Let the register-time check finish while the fixture is still current,
      // so being behind afterwards can only be seen by a check the broadcast
      // would have to trigger — which is exactly what must not happen.
      await Bun.sleep(500);
      await runGit(upstream, ["commit", "-q", "--allow-empty", "-m", "next"]);
      const ownSha = await runGit(checkout, ["rev-parse", "HEAD"]);

      await sendBroadcast(relay, deviceId, { sha: ownSha, commitTs: Date.now() });

      await Bun.sleep(300);
      expect(calls.install).toBe(0);
      expect(calls.restart).toBe(0);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("a group-addressed spawn is dropped at the transport, unanswered", async () => {
    const relay = startTestRelay(TOKEN);
    const { checkout } = await makePair("refuse");
    const { daemon } = await startTestDaemon(relay, "refuse", { root: checkout });
    try {
      const { deviceId } = await relay.registers.next();
      const env = await seal(
        appKey,
        { to: MACHINES_ID, from: APP_ID },
        {
          id: crypto.randomUUID(),
          ts: Date.now(),
          op: "spawn",
          payload: { repo: "anything", mode: "here" },
        },
      );
      relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env }));

      await Bun.sleep(300);
      expect(relay.messages.size).toBe(0);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });
});
