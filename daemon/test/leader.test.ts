import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appRelayUrl,
  importPsk,
  open,
  RelayClient,
  RequestFailure,
  SCHEDULER_ID,
  seal,
  toBase64,
  type SessionsResponse,
} from "@seance/shared";
import { IDLE_MS } from "../src/app-relay.ts";
import { createBackend } from "../src/backend-default.ts";
import type { Config } from "../src/config.ts";
import type { LocalOps } from "../src/handlers.ts";
import { createLeader, MemoryQueueStore, type Leader, type QueueStore, type Task } from "../src/leader.ts";
import { startDaemon } from "../src/run.ts";
import { captureLog, makeClaudeStub, makeGitFixture, pollUntil, usePrivateTmux, type PrivateTmux } from "./fixtures.ts";
import { startTestRelay, type TestRelay } from "./harness.ts";

const PSK = toBase64(new Uint8Array(32).fill(5));
const TOKEN = "leader-bearer";
let base: string;
let key: CryptoKey;
let privateTmux: PrivateTmux | undefined;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-leader-"));
  process.env["SEANCE_STATE_DIR"] = join(base, "state");
  privateTmux = usePrivateTmux(base, "leader");
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "claude-config");
  process.env["SEANCE_CLAUDE_BIN"] = (await makeClaudeStub(base)).ok;
  key = await importPsk(PSK);
});

afterAll(async () => {
  await privateTmux?.dispose();
  delete process.env["SEANCE_STATE_DIR"];
  delete process.env["SEANCE_CLAUDE_BIN"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  await rm(base, { recursive: true, force: true });
});

function task(id: string, fields: Partial<Task>): Task {
  return {
    id,
    spec: { repo: "github.com/acme/app", mode: "worktree" },
    state: "ready",
    createdAt: Date.now(),
    ...fields,
  };
}

const target = { exclave: "default", clone: "app" } as const;

/** The leader-level tests make no call on this machine; one that did would be a routing bug. */
const noLocalOps: LocalOps = {
  sessions: () => Promise.reject(new Error("unexpected local sessions")),
  spawn: () => Promise.reject(new Error("unexpected local spawn")),
  despawn: () => Promise.reject(new Error("unexpected local despawn")),
};

/**
 * A leader over the real shared client and the harness, holding each term's
 * leg so a test can ask it directly. Its heartbeat is pushed past the window
 * the fake clock runs through: a ping whose pong cannot arrive inside one
 * synchronous advance would redial for a reason that is not the subject here.
 */
function leaderOver(relay: TestRelay, store: QueueStore = new MemoryQueueStore(), tickIntervalMs?: number) {
  const legs: RelayClient[] = [];
  const leader: Leader = createLeader({
    selfDeviceId: "self",
    local: noLocalOps,
    store,
    ...(tickIntervalMs === undefined ? {} : { tickIntervalMs }),
    createRelay: (term) => {
      const leg = new RelayClient({
        url: appRelayUrl(relay.url),
        token: TOKEN,
        key,
        scheduler: { term },
        pingIntervalMs: 4 * IDLE_MS,
        log: () => {},
        createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
      });
      legs.push(leg);
      return leg;
    },
  });
  return { leader, legs };
}

describe("leader lifecycle", () => {
  // Fake timers from before the leader exists, so every timer it or its leg
  // arms is one the clock below can fire and `getTimerCount` can see. Waits
  // are on socket events, never `Bun.sleep`, which the fake clock never wakes.
  test("the leg outlives LazyRelay's idle window with no calls, and nothing of it survives follow", async () => {
    const relay = startTestRelay(TOKEN);
    relay.schedulerTerm = 1;
    jest.useFakeTimers();
    const baseline = jest.getTimerCount();
    const { leader, legs } = leaderOver(relay);
    try {
      leader.lead(1);
      expect(await relay.appEvents.next()).toBe("open");
      await leader.settled();

      jest.advanceTimersByTime(IDLE_MS + 60_000);
      // Still the same socket, both ways: a request leaves under the term and its
      // refusal comes back. A leg the window had hung up would refuse to send at all.
      const leg = legs[0];
      if (leg === undefined) throw new Error("no leg was built");
      const asked = leg.request("ghost", "sessions", {});
      const sent = await relay.appFrames.next();
      expect(sent.term).toBe(1);
      expect(sent.env.from).toBe(SCHEDULER_ID);
      relay.sendToApps({ t: "undeliverable", to: "ghost", iv: sent.env.iv, code: "offline" });
      const refused = await asked.catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(RequestFailure);
      expect(refused).toMatchObject({ reason: "offline" });
      expect(relay.appConnectionCount()).toBe(1);
      expect(relay.openAppCount()).toBe(1);

      leader.follow("test");
      expect(await relay.appEvents.next()).toBe("close");
      expect(leader.term()).toBeNull();
      expect(jest.getTimerCount()).toBe(baseline);
    } finally {
      leader.stop();
      jest.useRealTimers();
      relay.stop();
    }
  });

  test("promote → demote → promote, and a new term over a live one, leak nothing", async () => {
    const relay = startTestRelay(TOKEN);
    jest.useFakeTimers();
    const baseline = jest.getTimerCount();
    const { leader } = leaderOver(relay);
    try {
      leader.lead(1);
      expect(await relay.appEvents.next()).toBe("open");
      await leader.settled();
      leader.follow("test");
      expect(await relay.appEvents.next()).toBe("close");
      expect(jest.getTimerCount()).toBe(baseline);

      leader.lead(2);
      expect(await relay.appEvents.next()).toBe("open");
      await leader.settled();
      leader.lead(2);
      // A repeat of the running term is no new term.
      expect(relay.appConnectionCount()).toBe(2);

      // The relay re-nominated this daemon on a new socket: the old term's leg goes, the new term's comes.
      leader.lead(3);
      const swap = [await relay.appEvents.next(), await relay.appEvents.next()];
      expect(swap.toSorted()).toEqual(["close", "open"]);
      await leader.settled();
      expect(leader.term()).toBe(3);
      expect(relay.openAppCount()).toBe(1);

      leader.stop();
      expect(await relay.appEvents.next()).toBe("close");
      expect(relay.openAppCount()).toBe(0);
      expect(relay.appConnectionCount()).toBe(3);
      expect(jest.getTimerCount()).toBe(baseline);
      // Stopped is final: a lead after it builds nothing.
      leader.lead(4);
      expect(leader.term()).toBeNull();
      expect(jest.getTimerCount()).toBe(baseline);
    } finally {
      leader.stop();
      jest.useRealTimers();
      relay.stop();
    }
  });

  test("a not_leader answer during takeover ends the term, and nothing is dispatched or written", async () => {
    const relay = startTestRelay(TOKEN);
    const store = new MemoryQueueStore();
    const now = Date.now();
    // Expired: were the term to survive, the release would write and the re-route dispatch.
    const reservation = { deviceId: "remote", ...target, expiresAt: now - 1 };
    await store.put("t1", 0, task("t1", { state: "reserved", reservation }));
    const { leader } = leaderOver(relay, store);
    try {
      // The relay moved on to term 2 while this daemon still holds term 1.
      relay.schedulerTerm = 2;
      leader.lead(1);
      const asked = await relay.appFrames.next();
      expect(asked.term).toBe(1);
      await pollUntil(() => relay.openAppCount() === 0, "the term's leg closing");
      expect(leader.term()).toBeNull();
      await leader.settled();
      expect(await store.get("t1")).toMatchObject({ version: 1, body: { state: "reserved" } });
      // Nothing after the refused sessions call: the term ended before it could act on it.
      await Bun.sleep(100);
      expect(relay.appFrames.size).toBe(0);
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("a takeover that fails is retried, not left holding the role with nothing running", async () => {
    const relay = startTestRelay(TOKEN);
    const inner = new MemoryQueueStore();
    let lists = 0;
    // The store is the external boundary here: M3's is the relay's, and a read can fail.
    const flaky: QueueStore = {
      list: async () => {
        lists += 1;
        if (lists === 1) throw new Error("store unavailable");
        return inner.list();
      },
      get: (id) => inner.get(id),
      put: (id, version, body) => inner.put(id, version, body),
      delete: (id, version) => inner.delete(id, version),
    };
    const { leader } = leaderOver(relay, flaky, 50);
    try {
      leader.lead(1);
      await pollUntil(() => lists >= 2, "a second takeover attempt");
      await leader.settled();
      expect(leader.term()).toBe(1);
      expect(relay.openAppCount()).toBe(1);
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("a reply for no running term is dropped, not handed to a leg", async () => {
    const lines = await captureLog(async () => {
      const relay = startTestRelay(TOKEN);
      const { leader } = leaderOver(relay);
      try {
        const env = await seal(
          key,
          { to: SCHEDULER_ID, from: "remote" },
          { id: "r", ts: Date.now(), op: "sessions", payload: {} },
        );
        leader.deliver(env);
      } finally {
        leader.stop();
        relay.stop();
      }
    });
    expect(lines.some((line) => line.includes("reason=not-leading"))).toBe(true);
  });
});

describe("leader in the daemon", () => {
  async function startLeaderDaemon(relay: TestRelay, store: QueueStore, overrides: { pingIntervalMs?: number } = {}) {
    const fixture = await makeGitFixture(await mkdtemp(join(base, "fixture-")));
    const config: Config = {
      name: "LeaderBox",
      relayUrl: relay.url,
      bearerToken: TOKEN,
      psk: PSK,
      repoRoots: [fixture.root],
      tmuxSession: "main",
    };
    const daemon = await startDaemon({
      config,
      backend: createBackend(config, { home: join(base, "home"), waitMs: 700 }),
      pingIntervalMs: overrides.pingIntervalMs ?? 60_000,
      pongTimeoutMs: 300,
      baseBackoffMs: 20,
      leader: { store },
    });
    const { deviceId } = await relay.registers.next();
    return { daemon, deviceId };
  }

  test("takeover reconciles against sessions — remote through the relay under the term, self locally — before follow ends it", async () => {
    const relay = startTestRelay(TOKEN);
    const store = new MemoryQueueStore();
    let ended: { remote: unknown; self: unknown } | undefined;
    const lines = await captureLog(async () => {
      const { daemon, deviceId } = await startLeaderDaemon(relay, store);
      try {
        const assigned = { ...target, window: "w1", pane: "%9" };
        await store.put(
          "remote-task",
          0,
          task("remote-task", { state: "running", assignment: { deviceId: "b", ...assigned } }),
        );
        await store.put("self-task", 0, task("self-task", { state: "running", assignment: { deviceId, ...assigned } }));

        relay.lead(deviceId, 4);
        const asked = await relay.appFrames.next(5_000);
        expect(asked.term).toBe(4);
        expect(asked.env).toMatchObject({ to: "b", from: SCHEDULER_ID });
        const request = await open(key, asked.env);
        expect(request.op).toBe("sessions");
        // Answered as `b` would: to the scheduler address, which the relay routes to the leader's daemon socket.
        const payload: SessionsResponse = { sessions: [], at: Date.now() };
        const reply = await seal(
          key,
          { to: SCHEDULER_ID, from: "b" },
          { id: crypto.randomUUID(), ts: Date.now(), op: "sessions", re: request.id, payload },
        );
        relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env: reply }));
        await daemon.leader.settled();
        ended = {
          remote: (await store.get("remote-task"))?.body.state,
          self: (await store.get("self-task"))?.body.state,
        };

        relay.follow(deviceId);
        await pollUntil(() => relay.openAppCount() === 0, "the leader's leg closing on follow");
        expect(daemon.leader.term()).toBeNull();
      } finally {
        daemon.stop();
        relay.stop();
      }
    });
    // Both sessions are gone, so both tasks ended while no leader was listening.
    expect(ended).toEqual({ remote: "done", self: "done" });
    expect(lines.some((line) => line.includes('audit request origin=leader op="sessions"'))).toBe(true);
  });

  test("the daemon's relay socket dropping ends the term", async () => {
    const relay = startTestRelay(TOKEN);
    const { daemon, deviceId } = await startLeaderDaemon(relay, new MemoryQueueStore(), { pingIntervalMs: 100 });
    try {
      relay.lead(deviceId, 1);
      await pollUntil(() => relay.openAppCount() === 1, "the leader's leg opening");
      await daemon.leader.settled();
      // A missed pong closes the daemon's socket; the leg goes with it.
      relay.autoPong = false;
      await pollUntil(() => relay.openAppCount() === 0, "the leader's leg closing on socket loss");
      expect(daemon.leader.term()).toBeNull();
    } finally {
      daemon.stop();
      relay.stop();
    }
  });
});
