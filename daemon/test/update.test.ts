import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_ID,
  MACHINES_ID,
  importPsk,
  open,
  parseMachineStatus,
  seal,
  toBase64,
  type MachineInfo,
  type MachineStatus,
  type UpdateAvailable,
} from "@seance/shared";
import type { Config } from "../src/config.ts";
import { exec } from "../src/exec.ts";
import { endedTasksFor, startDaemon, type DaemonHandle, type SelfUpdateOpts } from "../src/run.ts";
import { launchLedgerPath } from "../src/launch-ledger.ts";
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

async function startTestDaemon(
  relay: TestRelay,
  name: string,
  selfUpdate: SelfUpdateOpts,
  telemetryIntervalMs?: number,
): Promise<TestDaemon> {
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
    home: join(base, name, "home"),
    pingIntervalMs: 60_000,
    pongTimeoutMs: 1_000,
    baseBackoffMs: 20,
    ...(telemetryIntervalMs === undefined ? {} : { telemetryIntervalMs }),
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

/** The next status the daemon sends that `wanted` accepts, skipping the ones before it. */
async function statusWhere(relay: TestRelay, wanted: (status: MachineStatus) => boolean): Promise<MachineStatus> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each status is read in turn
    const plain = await open(appKey, await relay.statuses.next(Math.max(1, deadline - Date.now())));
    const status = parseMachineStatus(plain.payload);
    if (status !== null && wanted(status)) return status;
  }
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
      // The real relay drops a msg from a socket that has not registered yet;
      // this double doesn't, so the order on the wire is asserted instead.
      // Signing the register is slower than sealing the announce, so an
      // announce fired on `open` overtook it and reached no machine.
      expect(relay.registerConnections).toEqual([1]);
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

  test("an announce sent behind a refused register goes out again on the redial", async () => {
    const relay = startTestRelay(TOKEN);
    relay.refuseNextRegisters = 1;
    const { checkout } = await makePair("announce-refused");
    process.env["SEANCE_STATE_DIR"] = join(base, "announce-refused", "state");
    await saveState({ deviceId: crypto.randomUUID(), repos: [], scannedAt: null, lastRunSha: "0".repeat(40) });

    const { daemon } = await startTestDaemon(relay, "announce-refused", { root: checkout });
    try {
      // The refused socket's copy may or may not reach this double before its
      // close; the real relay drops it either way. What counts is a copy
      // behind the register that was admitted.
      let env = await relay.messages.next(3_000);
      if (relay.registerConnections.length < 2) env = await relay.messages.next(3_000);
      expect(relay.registerConnections).toEqual([1, 2]);
      expect((await open(appKey, env)).op).toBe("update-available");
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

  // The DI wiring (`run.ts` hands the updater a `quiesce` over its own `EndedTasks`) is what keeps a
  // restart from cutting off a spawn: `daemon/src/update.test.ts` proves the parts, this proves the join.
  test("an ok update holds its restart until a task launch in flight on this daemon has settled", async () => {
    const relay = startTestRelay(TOKEN);
    const { upstream, checkout } = await makePair("quiesce");
    // A short beat, so the test reads a status inside the hold without waiting out the relay's floor.
    const { daemon, calls } = await startTestDaemon(relay, "quiesce", { root: checkout }, 200);
    try {
      const { deviceId } = await relay.registers.next();
      await daemon.updater?.settled();
      const ended = await endedTasksFor(launchLedgerPath());
      const settle = await ended.launch("held-task");
      const target = await runGit(upstream, ["commit", "-q", "--allow-empty", "-m", "next"]).then(() =>
        runGit(upstream, ["rev-parse", "HEAD"]),
      );

      await sendBroadcast(relay, deviceId, { sha: target, commitTs: Date.now() });

      // The ok is reported before the wait, so the pipeline has reached it once the register carries it.
      const register = await relay.registers.next(3_000);
      expect(((await open(appKey, register.info)).payload as MachineInfo).lastUpdate?.outcome).toBe("ok");
      expect(calls.install).toBe(1);
      await Bun.sleep(100); // a non-event can't be polled
      expect(calls.restart).toBe(0);

      // The held gate is what the leader routes around: a status says so while it waits.
      expect((await statusWhere(relay, (s) => s.drn === true)).drn).toBe(true);

      // Never launched, so nothing touches tmux: the launch is over, which is all the drain waits for.
      await settle(false);
      await pollUntil(() => calls.restart > 0, "the restart once the launch settled");
      expect(calls.restart).toBe(1);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("a restart that throws reopens the gate, and the next status stops saying it is held", async () => {
    const relay = startTestRelay(TOKEN);
    const { upstream, checkout } = await makePair("reopen");
    const held = Promise.withResolvers<void>();
    let restarts = 0;
    const { daemon } = await startTestDaemon(
      relay,
      "reopen",
      {
        root: checkout,
        effects: {
          install: async () => ({ ok: true }),
          restart: async () => {
            restarts += 1;
            await held.promise;
            throw new Error("systemctl said no");
          },
        },
      },
      200,
    );
    try {
      const { deviceId } = await relay.registers.next();
      await daemon.updater?.settled();
      const target = await runGit(upstream, ["commit", "-q", "--allow-empty", "-m", "next"]).then(() =>
        runGit(upstream, ["rev-parse", "HEAD"]),
      );

      await sendBroadcast(relay, deviceId, { sha: target, commitTs: Date.now() });

      await statusWhere(relay, (s) => s.drn === true);
      expect(restarts).toBe(1);
      held.resolve();
      expect(await statusWhere(relay, (s) => s.drn !== true)).not.toHaveProperty("drn");
      expect((await endedTasksFor(launchLedgerPath())).draining).toBe(false);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("the first `current` replaces a stale skip once, and later ones report nothing", async () => {
    const relay = startTestRelay(TOKEN);
    const { checkout } = await makePair("stale");
    const head = await runGit(checkout, ["rev-parse", "HEAD"]);
    process.env["SEANCE_STATE_DIR"] = join(base, "stale", "state");
    await saveState({
      deviceId: crypto.randomUUID(),
      repos: [],
      scannedAt: null,
      lastRunSha: head,
      lastUpdate: {
        at: Date.now() - 3_600_000,
        outcome: "skipped_dirty",
        detail: "working tree has uncommitted changes",
      },
    });

    const { daemon } = await startTestDaemon(relay, "stale", { root: checkout });
    try {
      const first = await relay.registers.next(3_000);
      expect(((await open(appKey, first.info)).payload as MachineInfo).lastUpdate?.outcome).toBe("skipped_dirty");

      const cleared = await relay.registers.next(3_000);
      expect(((await open(appKey, cleared.info)).payload as MachineInfo).lastUpdate?.outcome).toBe("current");

      // A second check, again current: the steady state must not report.
      await daemon.updater?.settled();
      await sendBroadcast(relay, first.deviceId, { sha: "f".repeat(40), commitTs: Date.now() });
      await Bun.sleep(300);
      await daemon.updater?.settled();
      await expect(relay.registers.next(300)).rejects.toThrow();
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
      // Drain the register-time check while the fixture is still current, so
      // being behind afterwards can only be noticed by a check the broadcast
      // would have to trigger — which is exactly what must not happen.
      await daemon.updater?.settled();
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
