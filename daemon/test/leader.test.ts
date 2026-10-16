import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_ID,
  appRelayUrl,
  importPsk,
  MAX_ACTIVE_TASKS,
  open,
  parseQueueReply,
  parseSubmitReply,
  QUEUE_PROMPT_PREVIEW,
  RelayClient,
  REPLAY_WINDOW_MS,
  RequestFailure,
  SCHEDULER_ID,
  seal,
  toBase64,
  type Envelope,
  type OpName,
  type Plain,
  type QueueResponse,
  type SessionsResponse,
  type SubmitResponse,
} from "@seance/shared";
import { IDLE_MS } from "../src/app-relay.ts";
import { createBackend } from "../src/backend-default.ts";
import type { Config } from "../src/config.ts";
import type { LocalOps } from "../src/handlers.ts";
import { createLeader, MemoryQueueStore, type Leader, type QueueStore, type Task } from "../src/leader.ts";
import { startDaemon } from "../src/run.ts";
import { captureLog, makeClaudeStub, makeGitFixture, pollUntil, usePrivateTmux, type PrivateTmux } from "./fixtures.ts";
import { AsyncQueue, startTestRelay, type TestRelay } from "./harness.ts";

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
  const replies = new AsyncQueue<{ readonly to: string; readonly response: Plain }>("replies");
  let resigned = 0;
  const leader: Leader = createLeader({
    selfDeviceId: "self",
    local: noLocalOps,
    store,
    reply: (to, response) => {
      replies.push({ to, response });
      return Promise.resolve(true);
    },
    resign: () => {
      resigned += 1;
    },
    ...(tickIntervalMs === undefined ? {} : { tickIntervalMs }),
    createRelay: (term, onEvent) => {
      const leg = new RelayClient({
        url: appRelayUrl(relay.url),
        token: TOKEN,
        key,
        scheduler: { term, onEvent },
        pingIntervalMs: 4 * IDLE_MS,
        log: () => {},
        createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
      });
      legs.push(leg);
      return leg;
    },
  });
  return { leader, legs, replies, resigned: () => resigned };
}

/** Read as the app reads one, so a reply only the leader's own types accept fails here. */
function queueReply(payload: unknown): QueueResponse {
  const reply = parseQueueReply(payload);
  if (reply === null || "ok" in reply) throw new Error(`not a queue reply: ${JSON.stringify(payload)}`);
  return reply;
}

function submitReply(payload: unknown): SubmitResponse {
  const reply = parseSubmitReply(payload);
  if (reply === null || "ok" in reply) throw new Error(`not a submit reply: ${JSON.stringify(payload)}`);
  return reply;
}

/** An app's request to the scheduler, sealed as the PWA's client seals one. */
function appRequest(op: OpName, payload: unknown = {}, from = APP_ID): Promise<Envelope> {
  return seal(key, { to: SCHEDULER_ID, from }, { id: crypto.randomUUID(), ts: Date.now(), op, payload });
}

describe("leader requests", () => {
  test("queue and route-preview are answered to the app; a malformed preview and a daemon's request are not acted on", async () => {
    const relay = startTestRelay(TOKEN);
    const store = new MemoryQueueStore();
    const long = "p".repeat(QUEUE_PROMPT_PREVIEW + 50);
    await store.put("old", 0, task("old", { createdAt: 1, spec: { repo: "github.com/acme/app", mode: "here" } }));
    await store.put("new", 0, task("new", { createdAt: 2, spec: { repo: "x", mode: "worktree", prompt: long } }));
    const { leader, replies } = leaderOver(relay, store);
    try {
      leader.lead(1);
      await leader.settled();

      const queue = await appRequest("queue");
      expect(leader.deliver(queue)).toBe(true);
      const queued = await replies.next();
      const asked = await open(key, queue);
      expect(queued.to).toBe(APP_ID);
      expect(queued.response).toMatchObject({ op: "queue", re: asked.id });
      const { tasks } = queueReply(queued.response.payload);
      // Newest first, and the prompt cut to its preview.
      expect(tasks.map((t) => t.id)).toEqual(["new", "old"]);
      expect(tasks[0]?.spec.prompt).toBe(long.slice(0, QUEUE_PROMPT_PREVIEW));

      leader.deliver(await appRequest("route-preview", { repo: "github.com/acme/app", mode: "worktree" }));
      // The harness's registry is empty: a decision with nobody to choose, and nothing reserved.
      expect((await replies.next()).response.payload).toMatchObject({ decision: { chosen: null, candidates: [] } });

      for (const malformed of [
        { repo: "", mode: "worktree" },
        { repo: "r", mode: "worktree", model: 7 },
      ]) {
        leader.deliver(await appRequest("route-preview", malformed));
        // oxlint-disable-next-line no-await-in-loop -- each refusal answers its own request
        expect((await replies.next()).response.payload).toMatchObject({ ok: false, code: "invalid_request" });
      }

      // Sealed by a daemon rather than an app: an event, never a request, so nothing answers it.
      leader.deliver(await appRequest("queue", {}, "remote"));
      await Bun.sleep(100);
      expect(replies.size).toBe(0);
      expect((await store.list()).map((t) => t.body.state)).toEqual(["ready", "ready"]);
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("submit queues a task under the scheduler's own id, which queue then shows with its decision; a full queue refuses", async () => {
    const relay = startTestRelay(TOKEN);
    const store = new MemoryQueueStore();
    const { leader, replies } = leaderOver(relay, store);
    try {
      leader.lead(1);
      await leader.settled();
      const request = { repo: "github.com/acme/app", mode: "worktree", prompt: "fix it", taskId: "mine" };
      leader.deliver(await appRequest("submit", request));
      const submitted = (await replies.next()).response.payload;
      // Checked raw: the app's parse rebuilds the spec, so it would hide a `taskId` the leader kept.
      expect(submitted).not.toHaveProperty(["task", "spec", "taskId"]);
      const { task: queuedTask } = submitReply(submitted);
      // The app's `taskId` is not a field a task takes: the scheduler mints its own.
      expect(queuedTask.id).not.toBe("mine");
      expect(queuedTask).toMatchObject({ state: "ready", spec: { repo: "github.com/acme/app", prompt: "fix it" } });
      expect((await store.get(queuedTask.id))?.body.id).toBe(queuedTask.id);

      leader.deliver(await appRequest("queue"));
      const queued = queueReply((await replies.next()).response.payload).tasks;
      // Placed on submit, so the decision is already there — with nobody in this registry to choose.
      expect(queued).toMatchObject([{ id: queuedTask.id, decision: { chosen: null } }]);

      leader.deliver(await appRequest("submit", { repo: "r" }));
      expect((await replies.next()).response.payload).toMatchObject({ ok: false, code: "invalid_request" });
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("past MAX_ACTIVE_TASKS unfinished tasks, submit is queue_full", async () => {
    const relay = startTestRelay(TOKEN);
    const store = new MemoryQueueStore();
    for (let i = 0; i < MAX_ACTIVE_TASKS; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the store is filled before the term starts
      await store.put(`t${i}`, 0, task(`t${i}`, {}));
    }
    const { leader, replies } = leaderOver(relay, store);
    try {
      leader.lead(1);
      await leader.settled();
      leader.deliver(await appRequest("submit", { repo: "r", mode: "here" }));
      expect((await replies.next()).response.payload).toMatchObject({ ok: false, code: "queue_full" });
      expect(await store.list()).toHaveLength(MAX_ACTIVE_TASKS);
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("a request during takeover is answered not_ready, and none at all while following", async () => {
    const relay = startTestRelay(TOKEN);
    const inner = new MemoryQueueStore();
    const gate = Promise.withResolvers<void>();
    // The store is the external boundary here (M3's is the relay's); a slow read holds takeover open.
    const slow: QueueStore = {
      list: async () => {
        await gate.promise;
        return inner.list();
      },
      get: (id) => inner.get(id),
      put: (id, version, body) => inner.put(id, version, body),
      delete: (id, version) => inner.delete(id, version),
    };
    const { leader, replies } = leaderOver(relay, slow);
    try {
      expect(leader.deliver(await appRequest("queue"))).toBe(false);
      leader.lead(1);
      expect(await relay.appEvents.next()).toBe("open");
      leader.deliver(await appRequest("queue"));
      expect((await replies.next()).response.payload).toMatchObject({ ok: false, code: "not_ready" });
      gate.resolve();
      await leader.settled();
      leader.deliver(await appRequest("queue"));
      expect((await replies.next()).response.payload).toMatchObject({ tasks: [] });
    } finally {
      leader.stop();
      relay.stop();
    }
  });
});

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

  test("a reply for no running term is not taken, and no leg is built for it", async () => {
    const relay = startTestRelay(TOKEN);
    const { leader, legs } = leaderOver(relay);
    try {
      const env = await seal(
        key,
        { to: SCHEDULER_ID, from: "remote" },
        { id: "r", ts: Date.now(), op: "sessions", payload: {} },
      );
      expect(leader.deliver(env)).toBe(false);
      expect(legs).toHaveLength(0);
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("a rejected leg ends the term and hands the role back; a follow, which the relay sent, does not", async () => {
    const relay = startTestRelay(TOKEN);
    const { leader, resigned } = leaderOver(relay);
    try {
      leader.lead(1);
      expect(await relay.appEvents.next()).toBe("open");
      leader.follow("test");
      expect(await relay.appEvents.next()).toBe("close");
      expect(resigned()).toBe(0);

      relay.rejectApps = true;
      leader.lead(2);
      await pollUntil(() => leader.term() === null, "the rejected term to end");
      expect(resigned()).toBe(1);
    } finally {
      leader.stop();
      relay.stop();
    }
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

  test("takeover settles a never-confirmed task on its machine's ledger — carried through the relay, and read locally", async () => {
    const relay = startTestRelay(TOKEN);
    const store = new MemoryQueueStore();
    const { daemon, deviceId } = await startLeaderDaemon(relay, store);
    try {
      const unconfirmed = (id: string, on: string, reservedAt: number): Promise<unknown> =>
        store.put(id, 0, task(id, { state: "lost", reservedAt, assignment: { deviceId: on, ...target } }));
      await unconfirmed("on-b", "b", Date.now());
      await unconfirmed("on-c", "c", Date.now());
      // Ahead of this daemon's own ledger by more than the skew: ready only if its `ledgerSince` arrives.
      await unconfirmed("on-self", deviceId, Date.now() + REPLAY_WINDOW_MS + 60_000);

      relay.lead(deviceId, 3);
      // `b` proves its ledger predates the reservation; `c` sends a stamp that is no number, which proves nothing.
      const proofs: Record<string, unknown> = { b: Date.now() - 3_600_000, c: "yesterday" };
      for (let i = 0; i < 2; i++) {
        // oxlint-disable-next-line no-await-in-loop -- one request per machine, answered as it comes
        const asked = await relay.appFrames.next(5_000);
        // oxlint-disable-next-line no-await-in-loop -- as above
        const request = await open(key, asked.env);
        const from = asked.env.to;
        const payload = { sessions: [], at: Date.now(), ledgerSince: proofs[from] };
        // oxlint-disable-next-line no-await-in-loop -- as above
        const reply = await seal(
          key,
          { to: SCHEDULER_ID, from },
          { id: crypto.randomUUID(), ts: Date.now(), op: "sessions", re: request.id, payload },
        );
        relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env: reply }));
      }
      await daemon.leader.settled();
      expect((await store.get("on-b"))?.body.state).toBe("ready");
      expect((await store.get("on-c"))?.body).toMatchObject({
        state: "failed",
        failure: { code: "dispatch_unconfirmed" },
      });
      expect((await store.get("on-self"))?.body.state).toBe("ready");
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("a session event another daemon sends the scheduler reaches the leader's state, from the machine it names", async () => {
    const relay = startTestRelay(TOKEN);
    const store = new MemoryQueueStore();
    const { daemon, deviceId } = await startLeaderDaemon(relay, store);
    try {
      // Mid-dispatch on `b`, its spawn reply lost: only the session's own event can say it ran.
      const reservation = { deviceId: "b", ...target, expiresAt: Date.now() + 60_000 };
      await store.put("t-b", 0, task("t-b", { state: "reserved", reservation }));

      relay.lead(deviceId, 2);
      const asked = await relay.appFrames.next(5_000);
      const request = await open(key, asked.env);
      const none: SessionsResponse = { sessions: [], at: Date.now() };
      const answer = await seal(
        key,
        { to: SCHEDULER_ID, from: "b" },
        { id: crypto.randomUUID(), ts: Date.now(), op: "sessions", re: request.id, payload: none },
      );
      relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env: answer }));
      await daemon.leader.settled();
      expect((await store.get("t-b"))?.body.state).toBe("reserved");

      const event = (from: string, payload: object) =>
        seal(
          key,
          { to: SCHEDULER_ID, from },
          { id: crypto.randomUUID(), ts: Date.now(), op: "session-event", payload },
        );
      const ended = { session: "%3", taskId: "t-b", exclave: "default", state: "ended", at: Date.now() };
      // From a machine the task was not placed on, and with a PR URL that is not https: neither moves it.
      for (const env of [await event("c", ended), await event("b", { ...ended, prUrl: "javascript:x" })]) {
        relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env }));
      }
      // Had either been taken, the task would already be done, and a later `busy` could not move it.
      relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env: await event("b", { ...ended, state: "busy" }) }));
      await pollUntil(async () => (await store.get("t-b"))?.body.state !== "reserved", "the busy event to land");
      expect((await store.get("t-b"))?.body).toMatchObject({
        state: "running",
        assignment: { deviceId: "b", pane: "%3" },
      });

      relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env: await event("b", ended) }));
      await pollUntil(async () => (await store.get("t-b"))?.body.state === "done", "the ended event to land");
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("with no term running, an app's scheduler request is answered not_leader from this machine", async () => {
    const relay = startTestRelay(TOKEN);
    const { daemon, deviceId } = await startLeaderDaemon(relay, new MemoryQueueStore());
    try {
      const request = await appRequest("route-preview", { repo: "r", mode: "worktree" });
      relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env: request }));
      const env = await relay.messages.next(5_000);
      expect({ to: env.to, from: env.from }).toEqual({ to: APP_ID, from: deviceId });
      const reply = await open(key, env);
      expect(reply.re).toBe((await open(key, request)).id);
      expect(reply.payload).toMatchObject({ ok: false, code: "not_leader" });

      // A daemon's event to a follower answers nothing.
      const event = await appRequest("session-event", {}, "remote");
      relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env: event }));
      await Bun.sleep(100);
      expect(relay.messages.size).toBe(0);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("a term ended by a rejected leg hands the role back on the same socket, and the next dial asks for it again", async () => {
    const relay = startTestRelay(TOKEN);
    const { daemon, deviceId } = await startLeaderDaemon(relay, new MemoryQueueStore(), { pingIntervalMs: 100 });
    try {
      // Registers in arrival order, each with the connection that sent it; a startup rescan may add its own.
      let seen = 1;
      const nextRegister = async () => {
        const frame = await relay.registers.next(5_000);
        seen += 1;
        return { frame, connection: relay.registerConnections[seen - 1] };
      };
      relay.rejectApps = true;
      relay.lead(deviceId, 1);
      let resigned = await nextRegister();
      // The startup rescan's re-register can land first (it does on macOS runners):
      // sent before the resign, on the same socket, it still asks for the role.
      while (resigned.frame.roles?.length !== 0) {
        expect(resigned.frame.roles).toEqual(["scheduler"]);
        expect(resigned.connection).toBe(1);
        // oxlint-disable-next-line no-await-in-loop -- registers arrive one at a time
        resigned = await nextRegister();
      }
      expect(resigned.frame.roles).toEqual([]);
      // The same connection: the relay moves only the socket a signed register arrives on.
      expect(resigned.connection).toBe(1);
      expect(daemon.leader.term()).toBeNull();

      relay.rejectApps = false;
      relay.autoPong = false;
      await pollUntil(() => relay.connectionCount() === 2, "the daemon redialling");
      relay.autoPong = true;
      let redialed = await nextRegister();
      while (redialed.connection === 1) {
        // A register left on the old socket after the resign (a rescan) still signs no roles.
        expect(redialed.frame.roles).toEqual([]);
        // oxlint-disable-next-line no-await-in-loop -- registers arrive one at a time
        redialed = await nextRegister();
      }
      expect(redialed.frame.roles).toEqual(["scheduler"]);
    } finally {
      daemon.stop();
      relay.stop();
    }
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
