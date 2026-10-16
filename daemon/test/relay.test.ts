import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_ID,
  generateIdentitySeed,
  identityFromSeed,
  importPsk,
  METRIC_NAMES,
  open,
  parseMachineStatus,
  parseMetricsReply,
  parseSessionEvent,
  SCHEDULER_ID,
  seal,
  STATUS_MAX_CT_LENGTH,
  toBase64,
  verifyRegister,
  type Envelope,
  type MachineInfo,
  type Plain,
  type RescanResponse,
  type SessionsResponse,
  type SpawnResponse,
} from "@seance/shared";
import { createBackend } from "../src/backend-default.ts";
import type { Config } from "../src/config.ts";
import { MetricsStore, type Sample } from "../src/metrics-store.ts";
import { RelayClient } from "../src/relay-client.ts";
import { startDaemon, type DaemonHandle } from "../src/run.ts";
import { tmux } from "../src/tmux.ts";
import {
  makeClaudeStub,
  makeClone,
  makeGitFixture,
  pollUntil,
  usePrivateTmux,
  type GitFixture,
  type PrivateTmux,
} from "./fixtures.ts";
import { startTestRelay, type TestRelay } from "./harness.ts";

const PSK = toBase64(new Uint8Array(32).fill(3));
const TOKEN = "test-bearer";
let base: string;
let privateTmux: PrivateTmux | undefined;
let fixture: GitFixture;
let appKey: CryptoKey;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-relay-"));
  process.env["SEANCE_STATE_DIR"] = join(base, "state");
  privateTmux = usePrivateTmux(base, "relay");
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "claude-config");
  fixture = await makeGitFixture(base);
  const stub = await makeClaudeStub(base);
  process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
  appKey = await importPsk(PSK);
});

afterAll(async () => {
  await privateTmux?.dispose();
  delete process.env["SEANCE_STATE_DIR"];
  delete process.env["SEANCE_CLAUDE_BIN"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  await rm(base, { recursive: true, force: true });
});

function makeConfig(relayUrl: string): Config {
  return {
    name: "TestMac",
    relayUrl,
    bearerToken: TOKEN,
    psk: PSK,
    repoRoots: [fixture.root],
    tmuxSession: "main",
  };
}

async function startTestDaemon(
  relayUrl: string,
  overrides: {
    readonly spawnWaitMs?: number;
    readonly pingIntervalMs?: number;
    readonly pongTimeoutMs?: number;
    readonly maxBackoffMs?: number;
    readonly home?: string;
    readonly extraRoots?: readonly string[];
  } = {},
): Promise<DaemonHandle> {
  const { spawnWaitMs = 700, extraRoots = [], ...rest } = overrides;
  const config = { ...makeConfig(relayUrl), repoRoots: [fixture.root, ...extraRoots] };
  return startDaemon({
    config,
    backend: createBackend(config, { home: rest.home ?? join(base, "home"), waitMs: spawnWaitMs }),
    pingIntervalMs: 60_000,
    pongTimeoutMs: 1_000,
    baseBackoffMs: 20,
    ...rest,
  });
}

/** Waits for a register whose decrypted repo list includes `repoName`. */
async function registerWithRepo(relay: TestRelay, repoName: string): Promise<{ deviceId: string; info: MachineInfo }> {
  for (let i = 0; i < 5; i++) {
    const frame = await relay.registers.next();
    // The fake relay accepts anything; the real one would refuse an unsigned
    // or mis-signed register, so every one the daemon sends has to verify.
    const claim = { deviceId: frame.deviceId, publicKey: frame.key, ts: frame.ts, sig: frame.sig, roles: frame.roles };
    expect(await verifyRegister(claim, Date.now())).toBe("ok");
    const plain = await open(appKey, frame.info);
    const info = plain.payload as MachineInfo;
    if (info.repos.some((r) => r.name === repoName)) {
      return { deviceId: frame.deviceId, info };
    }
  }
  throw new Error(`no register with repo ${repoName}`);
}

async function appRequest(
  relay: TestRelay,
  deviceId: string,
  op: Plain["op"],
  payload: unknown,
  tsOffset = 0,
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const env = await seal(
    appKey,
    { to: deviceId, from: APP_ID },
    {
      id,
      ts: Date.now() + tsOffset,
      op,
      payload,
    },
  );
  relay.sendToDaemon(env);
  return { id };
}

async function appReceive(relay: TestRelay, timeoutMs = 3_000): Promise<Plain> {
  const env = await relay.messages.next(timeoutMs);
  expect(env.to).toBe(APP_ID);
  return open(appKey, env);
}

describe("daemon ↔ relay integration", () => {
  test("registers with a decryptable machine-info blob", async () => {
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      const { deviceId, info } = await registerWithRepo(relay, "myrepo");
      expect(deviceId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(info.name).toBe("TestMac");
      expect(info.platform).toBe(process.platform);
      expect(info.repos[0]?.defaultBranch).toBe("main");
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("wrong bearer token never registers", async () => {
    const relay = startTestRelay("a-different-token");
    const daemon = await startTestDaemon(relay.url);
    try {
      await pollUntil(() => relay.rejectedCount() > 0, "the relay to reject the bad token");
      // Stable once rejected: there is no accepted socket left to register over.
      expect(relay.registers.size).toBe(0);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("sessions op round-trips end-to-end encrypted", async () => {
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      const { deviceId } = await registerWithRepo(relay, "myrepo");
      const { id } = await appRequest(relay, deviceId, "sessions", {});
      const response = await appReceive(relay);
      expect(response.op).toBe("sessions");
      expect(response.re).toBe(id);
      expect(Array.isArray((response.payload as SessionsResponse).sessions)).toBe(true);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("spawn op spawns into tmux and embeds the refreshed session list", async () => {
    const relay = startTestRelay(TOKEN);
    // The embedded list is one snapshot taken when the registration wait ends, so
    // nothing here can poll for the stub's title. The wait ends the moment the
    // pane is titled, so a wide budget costs a passing run nothing; it only has to
    // outlast the stub's own 300ms delay plus startup on a loaded machine.
    const daemon = await startTestDaemon(relay.url, { spawnWaitMs: 2_500 });
    try {
      const { deviceId } = await registerWithRepo(relay, "myrepo");
      await appRequest(relay, deviceId, "spawn", {
        repo: "myrepo",
        mode: "here",
        title: "From Phone",
        prompt: "do the thing",
      });
      const response = await appReceive(relay, 8_000);
      const payload = response.payload as SpawnResponse;
      expect(payload.ok).toBe(true);
      if (payload.ok) {
        expect(payload.window).toBe("From Phone");
        expect(payload.sessions.some((s) => s.window === "From Phone")).toBe(true);
      }
      await tmux(["kill-window", "-t", "main:From Phone"]);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("malformed spawn payload returns internal_error, not a crash", async () => {
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      const { deviceId } = await registerWithRepo(relay, "myrepo");
      await appRequest(relay, deviceId, "spawn", { mode: "worktree" });
      const response = await appReceive(relay);
      const payload = response.payload as SpawnResponse;
      expect(payload.ok).toBe(false);
      if (!payload.ok) expect(payload.code).toBe("internal_error");
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  // What the role does is leader.test.ts's; here, only that taking it up and
  // putting it down never cost the daemon's own socket what it already serves.
  test("lead and follow from the relay are logged, and the socket keeps serving", async () => {
    const relay = startTestRelay(TOKEN);
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]): void => {
      lines.push(args.map(String).join(" "));
    };
    const daemon = await startTestDaemon(relay.url);
    try {
      const { deviceId } = await registerWithRepo(relay, "myrepo");
      relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "lead", term: 7 }));
      relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "follow" }));

      await appRequest(relay, deviceId, "sessions", {});
      const response = await appReceive(relay);
      expect((response.payload as SessionsResponse).sessions).toBeDefined();
      expect(lines.some((line) => line.includes("relay says lead term=7"))).toBe(true);
      expect(lines.some((line) => line.includes("relay says follow"))).toBe(true);
    } finally {
      console.log = realLog;
      daemon.stop();
      relay.stop();
    }
  });

  // `typeof null === "object"`, so a null envelope used to clear the frame guard and
  // throw on the first dereference — inside a voided promise, so it took the op down
  // with no log line and nothing to answer the app with.
  test("a null envelope is dropped, and the socket keeps serving", async () => {
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      const { deviceId } = await registerWithRepo(relay, "myrepo");
      relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env: null }));

      await appRequest(relay, deviceId, "sessions", {});
      const response = await appReceive(relay);
      expect((response.payload as SessionsResponse).sessions).toBeDefined();
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("rescan finds a new clone and re-registers", async () => {
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      const { deviceId } = await registerWithRepo(relay, "myrepo");
      await mkdir(join(fixture.root, "newrepo", ".git"), { recursive: true });
      const { id } = await appRequest(relay, deviceId, "rescan", {});
      const response = await appReceive(relay);
      expect(response.re).toBe(id);
      const payload = response.payload as RescanResponse;
      expect(payload.repos.map((r) => r.name)).toContain("newrepo");
      // set changed → an unprompted re-register carries the new list
      await registerWithRepo(relay, "newrepo");
    } finally {
      daemon.stop();
      relay.stop();
      await rm(join(fixture.root, "newrepo"), { recursive: true, force: true });
    }
  });

  test("a status follows every register, sealed to the app and stamped with the registered scan", async () => {
    // A state dir of its own. The shared one caches what earlier tests scanned,
    // so the boot register would already carry myrepo, and when the boot rescan
    // finds the set changed (`newrepo` is gone) its re-register restamps every
    // status still in flight: the boot stamp this test matched never goes out,
    // and the next beat is 30s off.
    process.env["SEANCE_STATE_DIR"] = await mkdtemp(join(base, "state-"));
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      const { deviceId, info } = await registerWithRepo(relay, "myrepo");
      // The boot register (no repos, stamp 0) has its own status ahead of
      // this one; each names the blob it was sent after.
      for (let i = 0; ; i++) {
        const env = await relay.statuses.next();
        expect(env.to).toBe(APP_ID);
        expect(env.from).toBe(deviceId);
        expect(env.ct.length).toBeLessThanOrEqual(STATUS_MAX_CT_LENGTH);
        const plain = await open(appKey, env);
        expect(plain.op).toBe("status");
        const status = parseMachineStatus(plain.payload);
        if (status === null) throw new Error("status did not parse");
        if (status.scan !== info.scannedAt) {
          if (i < 4) continue;
          throw new Error(`no status for scan ${info.scannedAt}`);
        }
        expect(status.at * 1000).toBeGreaterThan(Date.now() - 60_000);
        expect(status.sess).toHaveLength(info.exclaves?.length ?? 0);
        break;
      }
    } finally {
      daemon.stop();
      relay.stop();
      process.env["SEANCE_STATE_DIR"] = join(base, "state");
    }
  });

  // The real relay lets one status through per interval, so the first one a
  // daemon sends is the one an app sees for the next 30s. A restart boots from
  // cached state, whose register carries a real stamp at once; the tick the
  // boot began before that register committed must not go out first stamped 0.
  test("a restarted daemon's first status carries its boot register's stamp", async () => {
    process.env["SEANCE_STATE_DIR"] = await mkdtemp(join(base, "state-"));
    const first = startTestRelay(TOKEN);
    let daemon = await startTestDaemon(first.url);
    try {
      await registerWithRepo(first, "myrepo");
      daemon.stop();
      first.stop();

      const relay = startTestRelay(TOKEN);
      try {
        daemon = await startTestDaemon(relay.url);
        const { info } = await registerWithRepo(relay, "myrepo");
        expect(info.scannedAt).toBeGreaterThan(0);
        const status = parseMachineStatus((await open(appKey, await relay.statuses.next())).payload);
        expect(status?.scan).toBe(info.scannedAt);
      } finally {
        relay.stop();
      }
    } finally {
      daemon.stop();
      first.stop();
      process.env["SEANCE_STATE_DIR"] = join(base, "state");
    }
  });

  // The boot rescan's re-register can leave while a status is being sealed,
  // and a status landing behind it is the one the relay keeps. So the check
  // has to run after the seal, in the turn that sends — the timing CI hit.
  test("sendStatus asks whether a status is still current after sealing it", async () => {
    const relay = startTestRelay(TOKEN);
    const identity = await identityFromSeed(generateIdentitySeed());
    const client = new RelayClient({
      url: relay.url,
      bearerToken: TOKEN,
      identity,
      key: appKey,
      buildInfo: () =>
        seal(
          appKey,
          { to: APP_ID, from: identity.deviceId },
          { id: crypto.randomUUID(), ts: Date.now(), op: "machine-info", payload: {} },
        ),
      handle: () => Promise.resolve(null),
    });
    client.start();
    try {
      await relay.registers.next();
      let current = true;
      const stale = client.sendStatus({ at: 1, scan: 1 }, () => current);
      current = false; // a register left while the seal was awaited
      expect(await stale).toBe(false);
      expect(await client.sendStatus({ at: 2, scan: 2 })).toBe(true);
      // The first in the queue is the second sent: the stale one never left.
      expect(parseMachineStatus((await open(appKey, await relay.statuses.next())).payload)?.scan).toBe(2);
    } finally {
      client.stop();
      relay.stop();
    }
  });

  test("a session event leaves sealed to the scheduler as `session-event`, from this machine", async () => {
    const relay = startTestRelay(TOKEN);
    const identity = await identityFromSeed(generateIdentitySeed());
    // The relay routes `to: "scheduler"` to the leader; here that is this daemon, so the leg's hand-off sees it.
    const routed: Envelope[] = [];
    const client = new RelayClient({
      url: relay.url,
      bearerToken: TOKEN,
      identity,
      key: appKey,
      buildInfo: () =>
        seal(
          appKey,
          { to: APP_ID, from: identity.deviceId },
          { id: crypto.randomUUID(), ts: Date.now(), op: "machine-info", payload: {} },
        ),
      handle: () => Promise.resolve(null),
      onScheduler: (env) => routed.push(env) > 0,
    });
    client.start();
    try {
      await relay.registers.next();
      relay.lead(identity.deviceId, 1);
      const event = { session: "%3", taskId: "t1", exclave: "default", state: "ended" as const, at: 5 };
      expect(await client.sendToScheduler(event)).toBe(true);
      await pollUntil(() => routed.length === 1, "the event to come back routed to the leader");
      const [env] = routed;
      if (env === undefined) throw new Error("nothing routed");
      expect({ to: env.to, from: env.from }).toEqual({ to: SCHEDULER_ID, from: identity.deviceId });
      const plain = await open(appKey, env);
      expect(plain.op).toBe("session-event");
      expect(parseSessionEvent(plain.payload)).toEqual(event);
    } finally {
      client.stop();
      relay.stop();
    }
  });

  test("the blob advertises metrics, and the op answers from what the telemetry tick stored", async () => {
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      const { deviceId, info } = await registerWithRepo(relay, "myrepo");
      expect(info.capabilities).toEqual(["metrics", "taskId"]);
      // A status leaves only after its tick wrote the store, so one in hand
      // means there is history to ask for.
      await relay.statuses.next();
      const now = Math.floor(Date.now() / 1000);
      const { id } = await appRequest(relay, deviceId, "metrics", {
        from: now - 300,
        to: now + 30,
        step: 30,
        names: [METRIC_NAMES.sess],
      });
      const response = await appReceive(relay);
      expect(response.re).toBe(id);
      const reply = parseMetricsReply(response.payload);
      if (reply === null || !("series" in reply)) throw new Error(`no history: ${JSON.stringify(response.payload)}`);
      expect(reply.series.length).toBeGreaterThan(0);
      for (const series of reply.series) expect(series.metric).toBe(METRIC_NAMES.sess);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  // A store seeded past what one envelope carries: the relay would drop the
  // reply unseen, so the app has to get a code it can act on instead. Own
  // state dir, so the junk series stay out of every other test's store.
  test("a reply that would seal past the relay's bound arrives as too_large", async () => {
    const shared = process.env["SEANCE_STATE_DIR"];
    process.env["SEANCE_STATE_DIR"] = join(base, "state-oversized");
    const now = Math.floor(Date.now() / 1000);
    const from = now - 719 * 30;
    const samples: Sample[] = [];
    for (let i = 0; i < 40; i++) {
      for (let t = from; t <= now; t += 30) samples.push({ metric: `m${i}`, labels: {}, ts: t, value: 12.3 });
    }
    const store = await MetricsStore.open();
    store.write(samples, now);
    store.close();

    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      const { deviceId } = await registerWithRepo(relay, "myrepo");
      const { id } = await appRequest(relay, deviceId, "metrics", { from, to: now, step: 30 });
      const response = await appReceive(relay);
      expect(response.re).toBe(id);
      expect(response.op).toBe("metrics");
      expect(parseMetricsReply(response.payload)).toMatchObject({ ok: false, code: "too_large" });

      // The remedy the code points at: the same range, narrowed by name, fits.
      const narrowed = await appRequest(relay, deviceId, "metrics", { from, to: now, step: 30, names: ["m0", "m1"] });
      const fits = await appReceive(relay);
      expect(fits.re).toBe(narrowed.id);
      const reply = parseMetricsReply(fits.payload);
      expect(reply !== null && "series" in reply && reply.series).toHaveLength(2);
    } finally {
      daemon.stop();
      relay.stop();
      process.env["SEANCE_STATE_DIR"] = shared;
    }
  });

  test("the daemon opens its metrics store owner-only in the state dir", async () => {
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      await relay.registers.next();
      const file = join(base, "state", "metrics.sqlite");
      await pollUntil(async () => (await stat(file).catch(() => null)) !== null, "metrics.sqlite to exist");
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("the blob carries exclaves, tags each clone, and a sign-in re-registers", async () => {
    const home = join(base, "home");
    await mkdir(join(home, "work"), { recursive: true });
    await writeFile(join(home, ".exclaves"), "work\nnot valid\n");
    const clone = await makeClone(join(home, "work"), "inside");
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url, { home, extraRoots: [join(home, "work")] });
    try {
      const { deviceId, info } = await registerWithRepo(relay, "inside");
      expect(info.exclaves?.map((e) => [e.id, e.authOk])).toEqual([
        ["default", false],
        ["work", false],
      ]);
      const byName = new Map(info.repos.map((r) => [r.name, r]));
      expect(byName.get("myrepo")?.exclave).toBe("default");
      expect(byName.get("inside")).toMatchObject({ path: clone, exclave: "work", origin: "inside" });

      // Same clones, one account signed in: the blob is how apps learn it.
      await mkdir(join(home, ".claude-work"), { recursive: true });
      await writeFile(
        join(home, ".claude-work", ".claude.json"),
        JSON.stringify({ oauthAccount: { organizationUuid: "o", accountUuid: "a", hasExtraUsageEnabled: false } }),
      );
      await appRequest(relay, deviceId, "rescan", {});
      await appReceive(relay);
      const again = await registerWithRepo(relay, "inside");
      expect(again.info.exclaves?.[1]).toEqual({
        id: "work",
        accountId: "o:a",
        extraUsageEnabled: false,
        authOk: true,
        skills: [],
      });
    } finally {
      daemon.stop();
      relay.stop();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("replayed envelope is dropped", async () => {
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      const { deviceId } = await registerWithRepo(relay, "myrepo");
      const id = crypto.randomUUID();
      const env = await seal(
        appKey,
        { to: deviceId, from: APP_ID },
        {
          id,
          ts: Date.now(),
          op: "sessions",
          payload: {},
        },
      );
      relay.sendToDaemon(env);
      await appReceive(relay);
      relay.sendToDaemon(env); // byte-identical replay
      await Bun.sleep(200);
      expect(relay.messages.size).toBe(0);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("stale timestamp is dropped", async () => {
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      const { deviceId } = await registerWithRepo(relay, "myrepo");
      await appRequest(relay, deviceId, "sessions", {}, -120_000);
      await Bun.sleep(200);
      expect(relay.messages.size).toBe(0);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("re-addressed envelope fails AAD and is dropped", async () => {
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      const { deviceId } = await registerWithRepo(relay, "myrepo");
      const env = await seal(
        appKey,
        { to: "some-other-device", from: APP_ID },
        {
          id: crypto.randomUUID(),
          ts: Date.now(),
          op: "sessions",
          payload: {},
        },
      );
      // a compromised relay rewrites the routing to reach this daemon
      relay.sendToDaemon({ ...env, to: deviceId });
      await Bun.sleep(200);
      expect(relay.messages.size).toBe(0);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("reconnects and re-registers after the relay restarts", async () => {
    const relay1 = startTestRelay(TOKEN);
    const port = relay1.port;
    const daemon = await startTestDaemon(relay1.url);
    try {
      await registerWithRepo(relay1, "myrepo");
      relay1.stop();
      const relay2 = startTestRelay(TOKEN, port);
      try {
        await registerWithRepo(relay2, "myrepo");
      } finally {
        relay2.stop();
      }
    } finally {
      daemon.stop();
    }
  });

  // The relay answers a register it cannot verify by closing the socket, so
  // from here it looks like a connect that succeeded and then dropped. Treating that as success would reset backoff and turn the refusal
  // into a redial every base interval; the refusal is spelled out in the log
  // and the backoff keeps growing until the relay lets the daemon in.
  test("a refused register keeps backing off instead of redialing at the base rate", async () => {
    const relay = startTestRelay(TOKEN);
    relay.refuseRegisters = true;
    const lines: string[] = [];
    const realWarn = console.log;
    console.log = (...args: unknown[]): void => {
      lines.push(args.map(String).join(" "));
    };
    const daemon = await startTestDaemon(relay.url, { maxBackoffMs: 400 });
    try {
      await relay.registers.next();
      await Bun.sleep(1_000);
      // Backoff grows 20→40→…→400ms (full jitter) from the first refusal on: on
      // the order of ten attempts in a second. A reset on every `open` gives ~50.
      expect(relay.connectionCount()).toBeLessThanOrEqual(25);
      expect(lines.some((line) => line.includes('relay socket closed code=1000 reason="register unverified"'))).toBe(
        true,
      );
    } finally {
      console.log = realWarn;
      daemon.stop();
      relay.stop();
    }
  });

  // A v2 register is what lets this daemon lead, but a relay a deploy behind
  // verifies only v1 and refuses it. Alternating on refusal lets such a daemon
  // in, roleless, without giving up the role for good.
  test("a register signs its roles, and each refusal flips the next between v2 and v1", async () => {
    const relay = startTestRelay(TOKEN);
    relay.refuseRegisters = true;
    const daemon = await startTestDaemon(relay.url, { maxBackoffMs: 50 });
    try {
      const seen: (readonly string[] | undefined)[] = [];
      for (let i = 0; i < 3; i++) {
        // oxlint-disable-next-line no-await-in-loop -- registers arrive one per redial, in order
        const frame = await relay.registers.next();
        const claim = { deviceId: frame.deviceId, publicKey: frame.key, ts: frame.ts, sig: frame.sig };
        // oxlint-disable-next-line no-await-in-loop -- each frame is checked as it arrives
        expect(await verifyRegister({ ...claim, roles: frame.roles }, Date.now())).toBe("ok");
        seen.push(frame.roles);
      }
      expect(seen).toEqual([["scheduler"], undefined, ["scheduler"]]);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  // Admitted v1 by a relay a deploy behind, a daemon must try v2 again once that
  // socket goes for any other reason — or the role stays lost after the relay
  // catches up, until the daemon restarts.
  test("a drop that was not a refusal signs the next register v2 again", async () => {
    const relay = startTestRelay(TOKEN);
    // Counted, not flipped from here: the redial can beat the test's own await.
    relay.refuseNextRegisters = 1;
    const daemon = await startTestDaemon(relay.url, { maxBackoffMs: 50, pingIntervalMs: 50, pongTimeoutMs: 50 });
    try {
      expect((await relay.registers.next()).roles).toEqual(["scheduler"]);
      expect((await relay.registers.next()).roles).toBeUndefined();
      const admitted = relay.registerConnections[1];
      // A missed pong closes the socket from the daemon's side: a drop with no refusal.
      relay.autoPong = false;
      // Past any re-register the admitted socket sent (a repo scan landing), to the redial's.
      let after = await relay.registers.next();
      for (let i = 2; relay.registerConnections[i] === admitted; i++) {
        // oxlint-disable-next-line no-await-in-loop -- registers arrive in order
        after = await relay.registers.next();
      }
      relay.autoPong = true;
      expect(after.roles).toEqual(["scheduler"]);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  // A socket that never opens drops through `error`, not `close`, and the error
  // event is the only one whose reason survives — so the log has to carry it.
  test("a connection that fails says why", async () => {
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]): void => {
      lines.push(args.map(String).join(" "));
    };
    // Port 1 on loopback: nothing listens, so the dial is refused outright.
    const daemon = await startTestDaemon("ws://127.0.0.1:1", { maxBackoffMs: 50 });
    try {
      await pollUntil(() => lines.some((line) => line.includes("relay socket errored")), "an errored drop");
      const line = lines.find((l) => l.includes("relay socket errored"));
      expect(line).toContain("reason=");
      expect(line).toContain("Failed to connect");
    } finally {
      console.log = realLog;
      daemon.stop();
    }
  });

  test("missed pong closes the socket and the daemon redials", async () => {
    const relay = startTestRelay(TOKEN);
    relay.autoPong = false;
    const daemon = await startTestDaemon(relay.url, { pingIntervalMs: 50, pongTimeoutMs: 50 });
    try {
      await registerWithRepo(relay, "myrepo");
      // no pongs → deadline fires → close → backoff → new connection registers again
      await relay.registers.next(3_000);
      expect(relay.connectionCount()).toBeGreaterThanOrEqual(2);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });
});
