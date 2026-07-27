import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PHONE_ID,
  importPsk,
  open,
  seal,
  toBase64,
  type MachineInfo,
  type Plain,
  type RescanResponse,
  type SessionsResponse,
  type SpawnResponse,
} from "@seance/shared";
import type { Config } from "../src/config.ts";
import { startDaemon, type DaemonHandle } from "../src/run.ts";
import { tmux } from "../src/tmux.ts";
import { makeClaudeStub, makeGitFixture, type GitFixture } from "./fixtures.ts";
import { startTestRelay, type TestRelay } from "./harness.ts";

const PSK = toBase64(new Uint8Array(32).fill(3));
const TOKEN = "test-bearer";
let base: string;
let fixture: GitFixture;
let phoneKey: CryptoKey;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-relay-"));
  process.env["SEANCE_STATE_DIR"] = join(base, "state");
  process.env["SEANCE_TMUX_SOCKET"] = `seance-relay-test-${process.pid}`;
  fixture = await makeGitFixture(base);
  const stub = await makeClaudeStub(base);
  process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
  phoneKey = await importPsk(PSK);
});

afterAll(async () => {
  await tmux(["kill-server"]);
  delete process.env["SEANCE_STATE_DIR"];
  delete process.env["SEANCE_TMUX_SOCKET"];
  delete process.env["SEANCE_CLAUDE_BIN"];
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

async function startTestDaemon(relayUrl: string, overrides: Record<string, number> = {}): Promise<DaemonHandle> {
  return startDaemon({
    config: makeConfig(relayUrl),
    pingIntervalMs: 60_000,
    pongTimeoutMs: 1_000,
    baseBackoffMs: 20,
    spawnWaitMs: 700,
    ...overrides,
  });
}

/** Waits for a register whose decrypted repo list includes `repoName`. */
async function registerWithRepo(relay: TestRelay, repoName: string): Promise<{ deviceId: string; info: MachineInfo }> {
  for (let i = 0; i < 5; i++) {
    const frame = await relay.registers.next();
    const plain = await open(phoneKey, frame.info);
    const info = plain.payload as MachineInfo;
    if (info.repos.some((r) => r.name === repoName)) {
      return { deviceId: frame.deviceId, info };
    }
  }
  throw new Error(`no register with repo ${repoName}`);
}

async function phoneRequest(
  relay: TestRelay,
  deviceId: string,
  op: Plain["op"],
  payload: unknown,
  tsOffset = 0,
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const env = await seal(
    phoneKey,
    { to: deviceId, from: PHONE_ID },
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

async function phoneReceive(relay: TestRelay, timeoutMs = 3_000): Promise<Plain> {
  const env = await relay.messages.next(timeoutMs);
  expect(env.to).toBe(PHONE_ID);
  return open(phoneKey, env);
}

describe("daemon ↔ relay integration", () => {
  test("registers with a decryptable machine-info blob", async () => {
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      const { deviceId, info } = await registerWithRepo(relay, "myrepo");
      expect(deviceId).toMatch(/^[0-9a-f-]{36}$/u);
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
      await Bun.sleep(200);
      expect(relay.registers.size).toBe(0);
      expect(relay.rejectedCount()).toBeGreaterThan(0);
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
      const { id } = await phoneRequest(relay, deviceId, "sessions", {});
      const response = await phoneReceive(relay);
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
    const daemon = await startTestDaemon(relay.url);
    try {
      const { deviceId } = await registerWithRepo(relay, "myrepo");
      await phoneRequest(relay, deviceId, "spawn", {
        repo: "myrepo",
        mode: "here",
        title: "From Phone",
        prompt: "do the thing",
      });
      const response = await phoneReceive(relay, 5_000);
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
      await phoneRequest(relay, deviceId, "spawn", { mode: "worktree" });
      const response = await phoneReceive(relay);
      const payload = response.payload as SpawnResponse;
      expect(payload.ok).toBe(false);
      if (!payload.ok) expect(payload.code).toBe("internal_error");
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
      const { id } = await phoneRequest(relay, deviceId, "rescan", {});
      const response = await phoneReceive(relay);
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

  test("replayed envelope is dropped", async () => {
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      const { deviceId } = await registerWithRepo(relay, "myrepo");
      const id = crypto.randomUUID();
      const env = await seal(
        phoneKey,
        { to: deviceId, from: PHONE_ID },
        {
          id,
          ts: Date.now(),
          op: "sessions",
          payload: {},
        },
      );
      relay.sendToDaemon(env);
      await phoneReceive(relay);
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
      await phoneRequest(relay, deviceId, "sessions", {}, -120_000);
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
        phoneKey,
        { to: "some-other-device", from: PHONE_ID },
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
