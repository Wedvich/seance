import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_ID,
  CAPABILITIES,
  ENVELOPE_MAX_CT_LENGTH,
  appRelayUrl,
  importPsk,
  isRecord,
  MAX_PAUSE_HOLDS,
  MAX_TASKS,
  ROUTING_ID_MAX_LENGTH,
  open,
  parseQueueChanged,
  parseQueueReply,
  QUEUE_MAX_TASKS,
  QUEUE_PROMPT_PREVIEW,
  QUOTA_KEY,
  RelayClient,
  REPLAY_WINDOW_MS,
  PUSH_MAX_SUBSCRIPTIONS,
  RequestFailure,
  SCHEDULER_ID,
  seal,
  sealFleetQuotaRecord,
  taskKey,
  toBase64,
  type Candidate,
  type Decision,
  type Envelope,
  type MachineInfo,
  type MachineStatus,
  type OpName,
  type PauseHold,
  type Plain,
  type QueueResponse,
  type UnreadableTaskRef,
  type WebPushSubscription,
  type RegistryView,
  type SessionsResponse,
} from "@seance/shared";
import { IDLE_MS } from "../src/app-relay.ts";
import { createBackend } from "../src/backend-default.ts";
import type { Config } from "../src/config.ts";
import type { LocalOps } from "../src/handlers.ts";
import { boundedQueue } from "../src/leader-requests.ts";
import { createLeader, MemoryQueueStore, type Leader, type QueueStore, type Task } from "../src/leader.ts";
import type { PrPollerOpts } from "../src/pr-status.ts";
import type { Fetch } from "../src/seams.ts";
import type { SettingsRead, SettingsStore, SettingsWrite } from "../src/settings-store.ts";
import { generateVapidKeys } from "../src/web-push.ts";
import { startDaemon } from "../src/run.ts";
import {
  captureLog,
  makeClaudeStub,
  makeGhStub,
  makeGitFixture,
  pollUntil,
  usePrivateTmux,
  type GhStub,
  type PrivateTmux,
} from "./fixtures.ts";
import { AsyncQueue, nextRequest, queuedRequests, startTestRelay, type TestRelay } from "./harness.ts";
import { startPushEndpoint } from "./push-endpoint.ts";

const PSK = toBase64(new Uint8Array(32).fill(5));
const TOKEN = "leader-bearer";
let base: string;
let key: CryptoKey;
let privateTmux: PrivateTmux | undefined;
let ghStub: GhStub;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-leader-"));
  process.env["SEANCE_STATE_DIR"] = join(base, "state");
  privateTmux = usePrivateTmux(base, "leader");
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "claude-config");
  process.env["SEANCE_CLAUDE_BIN"] = (await makeClaudeStub(base)).ok;
  ghStub = await makeGhStub(base);
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
function leaderOver(
  relay: TestRelay,
  store: QueueStore = new MemoryQueueStore(),
  tickIntervalMs?: number,
  prStatus?: PrPollerOpts,
  settings?: SettingsStore,
  httpFetch?: Fetch,
  storeTimeoutMs?: number,
) {
  const legs: RelayClient[] = [];
  const replies = new AsyncQueue<{ readonly to: string; readonly response: Plain }>("replies");
  let resigned = 0;
  const leader: Leader = createLeader({
    selfDeviceId: "self",
    pushSubject: "https://relay.test",
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
    ...(prStatus === undefined ? {} : { prStatus }),
    ...(settings === undefined ? {} : { settings }),
    ...(httpFetch === undefined ? {} : { httpFetch }),
    createRelay: (term, onEvent) => {
      const leg = new RelayClient({
        url: appRelayUrl(relay.url),
        token: TOKEN,
        key,
        scheduler: { term, onEvent },
        pingIntervalMs: 4 * IDLE_MS,
        ...(storeTimeoutMs === undefined ? {} : { storeTimeoutMs }),
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

/** An app's create plus the relay's `store-changed`: the record lands at version 0, then the leader is told. */
async function enqueueQueued(store: QueueStore, leader: Leader, id: string, fields: Partial<Task> = {}): Promise<void> {
  await store.put(id, 0, task(id, { state: "queued", ...fields }));
  leader.onStoreChanged(taskKey(id), 1);
}

/**
 * A registry entry the scheduler can route to: connected, signed in, a clone of
 * `github.com/acme/app`, a fresh status with headroom — each blob sealed by
 * the machine it describes, as the leg's client requires.
 */
async function routableEntry(deviceId: string, observed = true): Promise<RegistryView> {
  const info: MachineInfo = {
    name: deviceId,
    platform: "linux",
    repos: [
      {
        name: "app",
        path: `/r/${deviceId}/app`,
        defaultBranch: "main",
        exclave: "default",
        origin: "github.com/acme/app",
      },
    ],
    scannedAt: 1,
    exclaves: [{ id: "default", accountId: `org:${deviceId}`, extraUsageEnabled: false, authOk: true, skills: [] }],
    capabilities: [CAPABILITIES.metrics, CAPABILITIES.taskId],
  };
  const nowS = Math.floor(Date.now() / 1000);
  const status: MachineStatus = {
    at: nowS,
    scan: 1,
    cpu: 10,
    mem: 10,
    free: 50_000,
    ...(observed ? { quota: [{ x: 0, h: 10, d: 10, s: "session", at: nowS - 60 }] } : {}),
  };
  const sealed = (op: OpName, payload: unknown): Promise<Envelope> =>
    seal(key, { to: APP_ID, from: deviceId }, { id: crypto.randomUUID(), ts: Date.now(), op, payload });
  return {
    deviceId,
    info: await sealed("machine-info", info),
    lastSeen: Date.now(),
    connected: true,
    status: await sealed("status", status),
  };
}

/** An app's request to the scheduler, sealed as the PWA's client seals one. */
function appRequest(op: OpName, payload: unknown = {}, from = APP_ID): Promise<Envelope> {
  return seal(key, { to: SCHEDULER_ID, from }, { id: crypto.randomUUID(), ts: Date.now(), op, payload });
}

/**
 * A routing record over `machines` × `exclaves`, shaped as the router writes one:
 * a 43-character deviceId per machine, raw score components at full float
 * precision, a quota basis on every candidate, and every third one rejected.
 */
function fleetDecision(machines: number, exclaves: number, seed: number): Decision {
  const candidates: Candidate[] = [];
  for (let m = 0; m < machines; m += 1) {
    const deviceId = `${"d".repeat(40)}-${m}${seed % 10}`;
    for (let x = 0; x < exclaves; x += 1) {
      const quota = { observedAt: 1_760_000_000 + seed, observer: deviceId, source: "session" } as const;
      const common = { deviceId, machine: `machine-${m}`, exclave: `exclave-${x}`, clone: "app", quota };
      const f = (k: number): number => (seed + m * 7 + x * 13 + k) / 97;
      candidates.push(
        (m + x) % 3 === 2
          ? { ...common, rejected: [{ code: "quota_over_line", window: "five_hour", projectedPct: f(1) * 100 }] }
          : {
              ...common,
              rejected: [],
              score: {
                components: {
                  accountPressure: f(1),
                  machinePressure: f(2),
                  dependencyDistance: 0,
                  queuePressure: f(3),
                },
                sticky: 0,
                total: f(4),
              },
            },
      );
    }
  }
  const [first] = candidates;
  return {
    at: 1_760_000_000_000 + seed,
    chosen: first === undefined ? null : { deviceId: first.deviceId, exclave: "exclave-0", clone: "app" },
    candidates,
  };
}

/** Sealed as the daemon's transport seals an answer, whose bound is on `ct`. */
async function sealedLength(response: Plain): Promise<number> {
  return (await seal(key, { to: APP_ID, from: "self" }, response)).ct.length;
}

/** The next `queue-changed` the leader sent apps, opened as an app opens one; requests to machines are skipped. */
async function nextNudge(relay: TestRelay, timeoutMs = 3_000): Promise<{ change: unknown; term: number | undefined }> {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- frames arrive one at a time
    const frame = await relay.appFrames.next(timeoutMs);
    if (frame.env.to !== APP_ID) continue;
    // oxlint-disable-next-line no-await-in-loop -- as above
    const plain = await open(key, frame.env);
    expect(frame.env.from).toBe(SCHEDULER_ID);
    expect(plain.op).toBe("queue-changed");
    return { change: plain.payload, term: frame.term };
  }
}

describe("queue-changed", () => {
  test("takeover ends with one whole-queue nudge on the term's leg; a created task is then named, writes within a window coalesce, a pause is whole again", async () => {
    const relay = startTestRelay(TOKEN);
    relay.schedulerTerm = 1;
    const store = new MemoryQueueStore();
    const { leader, replies } = leaderOver(relay, store);
    try {
      leader.lead(1);
      await leader.settled();
      const takeover = await nextNudge(relay);
      expect(takeover.term).toBe(1);
      expect(takeover.change).toEqual({ at: expect.any(Number) });

      // An app's create: no leader write covers it, so the `store-changed` refresh names it. The admission
      // writes that follow land inside the same 500ms window, so they add no second nudge.
      await enqueueQueued(store, leader, "n1");
      await enqueueQueued(store, leader, "n2");
      const named = await nextNudge(relay);
      expect(parseQueueChanged(named.change)?.tasks?.toSorted()).toEqual(["n1", "n2"]);

      const pause = await appRequest("pause", { until: "resume" });
      leader.deliver(pause);
      await replies.next();
      const held = await nextNudge(relay);
      // The hold changes what every task shows: no ids, so apps re-fetch the whole queue.
      expect(held.change).toEqual({ at: expect.any(Number) });

      // Nothing else was sent: one nudge per window, however many writes.
      await Bun.sleep(700);
      expect(relay.appFrames.size).toBe(0);
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("nothing is sent once the term ended, even for a write still waiting in its window", async () => {
    const relay = startTestRelay(TOKEN);
    relay.schedulerTerm = 1;
    const store = new MemoryQueueStore();
    const { leader } = leaderOver(relay, store);
    try {
      leader.lead(1);
      await leader.settled();
      await nextNudge(relay);
      await enqueueQueued(store, leader, "late");
      // The refresh noted it (the window is armed) before the tick that admits it, so an admitted task proves a timer is pending.
      await pollUntil(async () => (await store.get("late"))?.body?.state !== "queued", "the refresh and tick");
      leader.follow("test");
      // Past the 500ms window the timer would have fired in.
      await Bun.sleep(700);
      expect(relay.appFrames.size).toBe(0);
    } finally {
      leader.stop();
      relay.stop();
    }
  });
});

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
      expect((await store.list()).map((t) => t.body?.state)).toEqual(["ready", "ready"]);
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("queue answers only the tasks named, and a malformed filter is invalid_request, never the whole queue", async () => {
    const relay = startTestRelay(TOKEN);
    const store = new MemoryQueueStore();
    for (const [i, id] of ["a", "b", "c"].entries()) {
      // oxlint-disable-next-line no-await-in-loop -- seeded before the term, in order
      await store.put(id, 0, task(id, { createdAt: i + 1 }));
    }
    const { leader, replies } = leaderOver(relay, store);
    try {
      leader.lead(1);
      await leader.settled();
      leader.deliver(await appRequest("queue", { tasks: ["b", "nobody"] }));
      expect(queueReply((await replies.next()).response.payload).tasks.map((t) => t.id)).toEqual(["b"]);
      leader.deliver(await appRequest("queue", { tasks: [] }));
      expect(queueReply((await replies.next()).response.payload).tasks).toEqual([]);
      leader.deliver(await appRequest("queue", {}));
      expect(queueReply((await replies.next()).response.payload).tasks.map((t) => t.id)).toEqual(["c", "b", "a"]);
      for (const malformed of [{ tasks: "b" }, { tasks: [1] }, { tasks: ["has:colon"] }, "b"]) {
        leader.deliver(await appRequest("queue", malformed));
        // oxlint-disable-next-line no-await-in-loop -- each refusal answers its own request
        expect((await replies.next()).response.payload).toMatchObject({ ok: false, code: "invalid_request" });
      }
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("the whole queue keeps what still needs someone: an escalated and an awaiting-merge task outlast newer finished ones", () => {
    const tasks = [
      task("merge", { state: "awaiting-merge", createdAt: 1 }),
      task("stuck", { state: "needs-input", createdAt: 2, escalated: true, needsInputSince: 2 }),
      ...Array.from({ length: QUEUE_MAX_TASKS + 5 }, (_, i) => task(`f${i}`, { state: "done", createdAt: 100 + i })),
    ];
    const view = boundedQueue(tasks, () => undefined, 0);
    expect(view.tasks).toHaveLength(QUEUE_MAX_TASKS);
    expect(view.tasks.slice(0, 2).map((t) => t.id)).toEqual(["stuck", "merge"]);
    // Finished ones fill the rest, newest first.
    expect(view.tasks[2]?.id).toBe(`f${QUEUE_MAX_TASKS + 4}`);
    expect(view.tasks.slice(2).every((t) => t.state === "done")).toBe(true);
    // A filtered ask is exactly the named ids that exist, whatever their rank.
    const named = tasks.filter((t) => t.id === "f0" || t.id === "merge");
    expect(boundedQueue(named, () => undefined, 0).tasks.map((t) => t.id)).toEqual(["merge", "f0"]);
  });

  test("cancel and mark-done audit the request id with the task id, so an app's request joins the task's record", async () => {
    const relay = startTestRelay(TOKEN);
    const store = new MemoryQueueStore();
    await store.put(
      "c1",
      0,
      task("c1", { state: "queued", spec: { repo: "github.com/acme/app", mode: "worktree", prompt: "secret" } }),
    );
    await store.put("m1", 0, task("m1", { state: "queued" }));
    const { leader, replies } = leaderOver(relay, store);
    const ids: Record<string, string> = {};
    const ask = async (name: string, op: OpName, payload: unknown): Promise<unknown> => {
      const request = await appRequest(op, payload);
      ids[name] = (await open(key, request)).id;
      leader.deliver(request);
      return (await replies.next()).response.payload;
    };
    const lines = await captureLog(async () => {
      try {
        leader.lead(1);
        await leader.settled();
        expect(await ask("cancel", "cancel", { taskId: "c1" })).toMatchObject({
          task: { id: "c1", state: "cancelled" },
        });
        expect(await ask("cancel2", "cancel", { taskId: "c1" })).toMatchObject({ ok: false, code: "finished" });
        expect(await ask("done", "mark-done", { taskId: "m1" })).toMatchObject({
          task: { id: "m1", state: "done", doneBy: "manual" },
        });
        expect(await ask("done2", "mark-done", { taskId: "m1" })).toMatchObject({ ok: false, code: "finished" });
        expect(await ask("nobody", "mark-done", { taskId: "nobody" })).toMatchObject({
          ok: false,
          code: "task_not_found",
        });
        expect(await ask("malformed", "mark-done", { id: "m1" })).toMatchObject({ ok: false, code: "invalid_request" });
      } finally {
        leader.stop();
        relay.stop();
      }
    });
    const audits = lines.filter((line) => line.includes("audit queue"));
    expect(audits).toContainEqual(expect.stringContaining(`op=cancel id="${ids["cancel"]}" task="c1" ok`));
    expect(audits).toContainEqual(expect.stringContaining(`task="c1" refused code=finished`));
    expect(audits).toContainEqual(expect.stringContaining(`op=mark-done id="${ids["done"]}" task="m1" ok`));
    expect(audits).toContainEqual(
      expect.stringContaining(`op=mark-done id="${ids["done2"]}" task="m1" refused code=finished`),
    );
    expect(audits).toContainEqual(
      expect.stringContaining(`op=mark-done id="${ids["nobody"]}" task="nobody" refused code=not_found`),
    );
    // The prompt is the spawn line's to fingerprint, never this one's to carry.
    expect(lines.some((line) => line.includes("secret"))).toBe(false);
  });

  test("an op this leader does not know, from an app, is refused invalid_request instead of left to time out", async () => {
    const relay = startTestRelay(TOKEN);
    const { leader, replies } = leaderOver(relay);
    try {
      leader.lead(1);
      await leader.settled();
      // An op no leader handles; an older PWA's `submit` reads the same way.
      const old = await appRequest("metrics", {});
      leader.deliver(old);
      const answer = await replies.next();
      expect(answer.to).toBe(APP_ID);
      expect(answer.response).toMatchObject({ re: (await open(key, old)).id, op: "metrics" });
      expect(answer.response.payload).toMatchObject({
        ok: false,
        code: "invalid_request",
        message: expect.stringContaining("does not handle"),
      });
      // Acted on nothing: no task exists.
      leader.deliver(await appRequest("queue"));
      expect(queueReply((await replies.next()).response.payload).tasks).toEqual([]);
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("an app cancels a running task on another machine: despawned there as the scheduler, then cancelled in the queue", async () => {
    const relay = startTestRelay(TOKEN);
    relay.schedulerTerm = 1;
    const store = new MemoryQueueStore();
    const assignment = { deviceId: "b", ...target, window: "w9", pane: "%9" };
    await store.put("run-b", 0, task("run-b", { state: "running", assignment }));
    const { leader, replies } = leaderOver(relay, store);
    /** Answers the leg's next request as `b` would, after checking what it asked. */
    const answerAsB = async (op: OpName, payload: unknown): Promise<Plain> => {
      const asked = await nextRequest(relay, 5_000);
      expect(asked.env).toMatchObject({ to: "b", from: SCHEDULER_ID });
      const request = await open(key, asked.env);
      expect(request.op).toBe(op);
      const env = await seal(
        key,
        { to: SCHEDULER_ID, from: "b" },
        { id: crypto.randomUUID(), ts: Date.now(), op, re: request.id, payload },
      );
      relay.sendToApps({ t: "msg", env });
      return request;
    };
    try {
      leader.lead(1);
      const session = { id: "%9", window: "w9", repo: "app", path: "/wt/run-b", taskId: "run-b" };
      await answerAsB("sessions", { sessions: [session], at: Date.now() } satisfies SessionsResponse);
      await leader.settled();
      expect((await store.get("run-b"))?.body?.state).toBe("running");

      leader.deliver(await appRequest("cancel", { taskId: "run-b" }));
      // `client: scheduler` from `SCHEDULER_ID` is what `b` audits as `origin=relay client=scheduler`.
      const despawn = await answerAsB("despawn", { ok: true, window: "w9", outcome: "exited", sessions: [] });
      expect(despawn.payload).toEqual({ id: "%9", client: "scheduler" });
      expect((await replies.next()).response.payload).toMatchObject({ task: { id: "run-b", state: "cancelled" } });

      leader.deliver(await appRequest("queue"));
      expect(queueReply((await replies.next()).response.payload).tasks).toMatchObject([
        { id: "run-b", state: "cancelled" },
      ]);

      for (const [payload, code] of [
        [{ taskId: "nobody" }, "task_not_found"],
        [{ id: "run-b" }, "invalid_request"],
      ] as const) {
        leader.deliver(await appRequest("cancel", payload));
        // oxlint-disable-next-line no-await-in-loop -- each refusal answers its own request
        expect((await replies.next()).response.payload).toMatchObject({ ok: false, code });
      }
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("a spawn the relay could not deliver is routed afresh at once, never held as lost", async () => {
    const relay = startTestRelay(TOKEN);
    relay.schedulerTerm = 1;
    const store = new MemoryQueueStore();
    const { leader } = leaderOver(relay, store, 50);
    try {
      leader.lead(1);
      await leader.settled();
      relay.setRegistry([await routableEntry("b"), await routableEntry("c")]);
      await enqueueQueued(store, leader, "sub", { spec: { repo: "github.com/acme/app", mode: "worktree" } });

      const first = await nextRequest(relay, 5_000);
      expect((await open(key, first.env)).op).toBe("spawn");
      // The machine's socket went away before the spawn reached it.
      relay.sendToApps({ t: "undeliverable", to: first.env.to, iv: first.env.iv, code: "offline" });
      const second = await nextRequest(relay, 5_000);
      const request = await open(key, second.env);
      expect(request.op).toBe("spawn");
      expect(request.payload).toMatchObject({ taskId: "sub" });
      expect(second.env.to).not.toBe(first.env.to);
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  // S5 of the M3 review: an enqueue is a store write the relay answers, so admission is the leader's only line of it.
  test("admitting an app's create is audited once, with its client and createdAt, never its prompt", async () => {
    const relay = startTestRelay(TOKEN);
    relay.schedulerTerm = 1;
    const store = new MemoryQueueStore();
    const { leader, replies } = leaderOver(relay, store, 50);
    const createdAt = Date.now();
    const lines = await captureLog(async () => {
      try {
        leader.lead(1);
        await leader.settled();
        await enqueueQueued(store, leader, "from-phone", {
          createdAt,
          spec: { repo: "github.com/acme/app", mode: "worktree", prompt: "the secret plan", client: "pwa" },
        });
        await pollUntil(async () => (await store.get("from-phone"))?.body?.state === "ready", "the create's admission");
        // Later writes to it are no admission: cancelled here, it was written a second time.
        leader.deliver(await appRequest("cancel", { taskId: "from-phone" }));
        expect((await replies.next()).response.payload).toMatchObject({ task: { state: "cancelled" } });
      } finally {
        leader.stop();
        relay.stop();
      }
    });
    const admits = lines.filter((line) => line.includes("op=admit"));
    expect(admits).toEqual([
      expect.stringContaining(
        `audit queue origin=leader op=admit task="from-phone" client="pwa" createdAt=${createdAt} state=ready`,
      ),
    ]);
    expect(lines.join("\n")).not.toContain("the secret plan");
  });

  test("pause holds dispatch and queue shows the hold; resume places the task; each is audited, refusals too", async () => {
    const relay = startTestRelay(TOKEN);
    relay.schedulerTerm = 1;
    const store = new MemoryQueueStore();
    const { leader, replies } = leaderOver(relay, store, 50);
    const ids: Record<string, string> = {};
    /** Delivers an app request and answers with its payload, keeping its id for the audit lines. */
    const ask = async (name: string, op: OpName, payload: unknown): Promise<unknown> => {
      const request = await appRequest(op, payload);
      ids[name] = (await open(key, request)).id;
      leader.deliver(request);
      return (await replies.next()).response.payload;
    };
    const lines = await captureLog(async () => {
      try {
        leader.lead(1);
        await leader.settled();
        relay.setRegistry([await routableEntry("b")]);

        expect(await ask("pause", "pause", { until: "resume" })).toEqual({
          holds: [{ until: "resume", at: expect.any(Number) }],
        });
        expect(await ask("unknown", "pause", { until: "reset", account: "org:nobody" })).toMatchObject({
          ok: false,
          code: "reset_unknown",
        });
        // A reset with no account is no account's reset: malformed.
        expect(await ask("malformed", "pause", { until: "reset" })).toMatchObject({
          ok: false,
          code: "invalid_request",
        });
        expect(await ask("mark", "mark-done", { taskId: "x" })).toMatchObject({ ok: false, code: "task_not_found" });

        await enqueueQueued(store, leader, "held", { spec: { repo: "github.com/acme/app", mode: "worktree" } });
        const queued = { id: "held" };
        // Ticks every 50ms: a hold that leaked would have dispatched by now.
        await Bun.sleep(300);
        expect(await queuedRequests(relay)).toEqual([]);
        const shown = queueReply(await ask("queue", "queue", {}));
        expect(shown.holds).toEqual([{ until: "resume", at: expect.any(Number) }]);
        expect(shown.tasks).toMatchObject([{ id: queued.id, state: "ready" }]);
        expect(shown.tasks[0]?.decision?.candidates[0]?.rejected).toContainEqual({
          code: "paused",
          until: "resume",
          scope: "queue",
        });
        expect((await store.getPause())?.holds).toHaveLength(1);

        expect(await ask("resume", "resume", {})).toEqual({ holds: [] });
        const spawn = await nextRequest(relay, 5_000);
        expect(spawn.env.to).toBe("b");
        expect((await open(key, spawn.env)).op).toBe("spawn");
      } finally {
        leader.stop();
        relay.stop();
      }
    });
    const audits = lines.filter((line) => line.includes("audit queue"));
    expect(audits).toContainEqual(expect.stringContaining(`op=pause id="${ids["pause"]}" ok`));
    expect(audits).toContainEqual(
      expect.stringContaining(`op=pause id="${ids["unknown"]}" account="org:nobody" refused code=reset_unknown`),
    );
    expect(audits).toContainEqual(expect.stringContaining(`op=resume id="${ids["resume"]}" ok`));
  });

  test("a pause past the hold limit is invalid_request, and a revoked store is not_leader and ends the term", async () => {
    const relay = startTestRelay(TOKEN);
    relay.schedulerTerm = 1;
    const store = new MemoryQueueStore();
    const accounts = Array.from({ length: MAX_PAUSE_HOLDS - 1 }, (_, i) => ({
      account: `org:${i}`,
      until: "resume" as const,
      at: 1,
    }));
    await store.putPause(0, accounts);
    const { leader, replies } = leaderOver(relay, store, 50);
    const ids: Record<string, string> = {};
    const ask = async (name: string, op: OpName, payload: unknown): Promise<unknown> => {
      const request = await appRequest(op, payload);
      ids[name] = (await open(key, request)).id;
      leader.deliver(request);
      return (await replies.next()).response.payload;
    };
    const lines = await captureLog(async () => {
      try {
        leader.lead(1);
        await leader.settled();
        expect(await ask("full", "pause", { until: "resume", account: "org:extra" })).toMatchObject({
          ok: false,
          code: "invalid_request",
        });
        store.failNext({ code: "revoked" });
        expect(await ask("revoked", "pause", { until: "resume" })).toMatchObject({
          ok: false,
          code: "not_leader",
        });
        expect(leader.term()).toBeNull();
      } finally {
        leader.stop();
        relay.stop();
      }
    });
    const audits = lines.filter((line) => line.includes("audit queue"));
    expect(audits).toContainEqual(
      expect.stringContaining(`op=pause id="${ids["full"]}" account="org:extra" refused code=full`),
    );
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
      getPause: () => inner.getPause(),
      putPause: (version, holds) => inner.putPause(version, holds),
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

  test("on a 3×3 fleet, twenty finished tasks still seal under the envelope bound, the oldest cut to their winner", async () => {
    const relay = startTestRelay(TOKEN);
    const store = new MemoryQueueStore();
    const finished = ["done", "failed", "cancelled"] as const;
    const stored: Task[] = [];
    for (let i = 0; i < QUEUE_MAX_TASKS; i += 1) {
      const decision = fleetDecision(3, 3, i);
      const state = finished[i % finished.length] ?? "done";
      stored.push(task(`t${i}`, { createdAt: i + 1, state, decision }));
      // oxlint-disable-next-line no-await-in-loop -- the store is filled before the term starts
      await store.put(`t${i}`, 0, stored[i] ?? task(`t${i}`, {}));
    }
    const { leader, replies } = leaderOver(relay, store);
    try {
      // Every record whole, as the leader used to answer: what this test exists to keep out.
      const whole: Plain = {
        id: crypto.randomUUID(),
        ts: 0,
        op: "queue",
        re: crypto.randomUUID(),
        payload: { tasks: stored, at: 0 },
      };
      expect(await sealedLength(whole)).toBeGreaterThan(ENVELOPE_MAX_CT_LENGTH);

      leader.lead(1);
      await leader.settled();
      leader.deliver(await appRequest("queue"));
      const { response } = await replies.next();
      expect(await sealedLength(response)).toBeLessThanOrEqual(ENVELOPE_MAX_CT_LENGTH);
      const { tasks } = queueReply(response.payload);
      expect(tasks).toHaveLength(QUEUE_MAX_TASKS);
      const sizes = tasks.map((t) => t.decision?.candidates.length);
      // Newest first: whole records while the budget lasts, then the winner alone — never the other way round.
      expect(sizes[0]).toBe(9);
      expect(sizes.at(-1)).toBe(1);
      // A cut record says so, and by how much; a whole one carries no count.
      expect(tasks.map((t) => t.decision?.trimmed ?? 0)).toEqual(sizes.map((n = 0) => 9 - n));
      expect(sizes).toEqual(sizes.toSorted((a = 0, b = 0) => b - a));
      for (const t of tasks) expect(t.decision?.chosen).toEqual(stored.find((s) => s.id === t.id)?.decision?.chosen);
    } finally {
      leader.stop();
      relay.stop();
    }
  });
});

/** `boundedQueue` over the decisions the tasks carry, as the transport would send it. */
function boundedReply(
  tasks: readonly Task[],
  holds: readonly PauseHold[] = [],
  unreadable: readonly UnreadableTaskRef[] = [],
): Plain {
  const payload = boundedQueue(tasks, (id) => tasks.find((t) => t.id === id)?.decision, 0, holds, unreadable);
  return { id: crypto.randomUUID(), ts: 0, op: "queue", re: crypto.randomUUID(), payload };
}

describe("boundedQueue", () => {
  test("a ready or reserved task keeps its whole record ahead of newer finished ones; nothing invents a decision", async () => {
    const unplaced = { ...fleetDecision(3, 3, 1), chosen: null };
    const tasks = [
      task("waiting", { createdAt: 1, decision: unplaced }),
      task("going", { createdAt: 2, state: "reserved", decision: fleetDecision(3, 3, 2) }),
      task("bare", { createdAt: 3, state: "done" }),
      ...Array.from({ length: QUEUE_MAX_TASKS - 3 }, (_, i) =>
        task(`done${i}`, { createdAt: 10 + i, state: "done", decision: fleetDecision(3, 3, 10 + i) }),
      ),
    ];
    const answered = boundedReply(tasks);
    expect(await sealedLength(answered)).toBeLessThanOrEqual(ENVELOPE_MAX_CT_LENGTH);
    const byId = new Map(queueReply(answered.payload).tasks.map((t) => [t.id, t]));
    expect(byId.get("waiting")?.decision).toEqual(unplaced);
    expect(byId.get("going")?.decision).not.toHaveProperty("trimmed");
    expect(byId.get("going")?.decision?.candidates).toHaveLength(9);
    expect(byId.get("bare")).not.toHaveProperty("decision");
    expect(byId.get("done0")?.decision).toMatchObject({ candidates: [expect.anything()], trimmed: 8 });
  });

  test("past the budget even a live record is cut, and one with no winner keeps its verdict with no candidates", async () => {
    const tasks = Array.from({ length: QUEUE_MAX_TASKS }, (_, i) =>
      task(`r${i}`, {
        createdAt: i,
        // Odd ones as the scheduler stores a record it had to cut already.
        decision: { ...fleetDecision(10, 5, i), ...(i % 2 === 0 ? { chosen: null } : { trimmed: 3 }) },
      }),
    );
    const answered = boundedReply(tasks);
    expect(await sealedLength(answered)).toBeLessThanOrEqual(ENVELOPE_MAX_CT_LENGTH);
    const { tasks: queued } = queueReply(answered.payload);
    expect(queued.find((t) => t.id === "r0")?.decision).toMatchObject({ chosen: null, candidates: [], trimmed: 50 });
    // The leader's own cut adds to the count, never replaces it.
    expect(queued.find((t) => t.id === "r1")?.decision).toMatchObject({ candidates: [expect.anything()], trimmed: 52 });
    // Newest first, so the newest live record is the one kept whole.
    expect(queued[0]?.decision?.candidates).toHaveLength(50);
  });

  test("tasks whose every field is near its cap still fit: the oldest finished ones are left out, never a live one", async () => {
    const capped = { deviceId: "d".repeat(43), exclave: "e".repeat(64), clone: "c".repeat(512) };
    const full = (i: number, state: Task["state"]): Task =>
      task(`f${i}`, {
        createdAt: i,
        state,
        // Four UTF-8 bytes per two UTF-16 units: the preview cut counts units, the budget bytes.
        spec: { repo: "r".repeat(512), mode: "worktree", title: "t".repeat(200), prompt: "😀".repeat(200) },
        assignment: { ...capped, window: "w".repeat(256) },
        failure: { code: "launch_error", message: "m".repeat(512) },
        decision: { ...fleetDecision(3, 3, i), chosen: capped },
      });
    // The two oldest are the live ones: age alone would drop them first.
    const tasks = [
      full(0, "ready"),
      full(1, "reserved"),
      ...Array.from({ length: QUEUE_MAX_TASKS - 2 }, (_, i) => full(i + 2, "failed")),
    ];
    // Every hold the record may carry, each at its bounds: the budget is what is left after them.
    const holds = Array.from({ length: MAX_PAUSE_HOLDS }, (_, i) => ({
      account: `${i}`.padStart(128, "a"),
      until: "reset" as const,
      at: Number.MAX_SAFE_INTEGER,
      resumeAt: Number.MAX_SAFE_INTEGER,
    }));
    // And every unreadable record the store can hold, each at its bounds: a person discards from this list.
    const unreadable = Array.from({ length: MAX_TASKS }, (_, i) => ({
      taskId: `${i}`.padStart(ROUTING_ID_MAX_LENGTH, "u"),
      version: Number.MAX_SAFE_INTEGER,
      reason: "version_regressed",
    }));
    const answered = boundedReply(tasks, holds, unreadable);
    expect(await sealedLength(answered)).toBeLessThanOrEqual(ENVELOPE_MAX_CT_LENGTH);
    expect(queueReply(answered.payload).holds).toHaveLength(MAX_PAUSE_HOLDS);
    expect(queueReply(answered.payload).unreadable).toEqual(unreadable);
    const ids = queueReply(answered.payload).tasks.map((t) => t.id);
    expect(ids.length).toBeLessThan(QUEUE_MAX_TASKS);
    expect(ids).toContain("f0");
    expect(ids).toContain("f1");
    // The unfinished first, then the finished newest first, the gap at their old end.
    expect(ids.slice(0, 3)).toEqual(["f1", "f0", `f${QUEUE_MAX_TASKS - 1}`]);
    expect(ids).not.toContain("f2");
  });
});

describe("leader settings", () => {
  /** A settings store in memory; `fail` reads reject before any answer. */
  const memorySettings = (fail = 0) => {
    const calls = { gets: 0, puts: [] as number[] };
    let held: SettingsRead = null;
    let failing = fail;
    const store: SettingsStore = {
      get: async () => {
        calls.gets += 1;
        if (failing > 0) {
          failing -= 1;
          throw new Error("store-get: the reply was unreadable");
        }
        return held;
      },
      put: async (at, record) => {
        calls.puts.push(at);
        held = { version: at + 1, record: { ...record, version: at + 1 } };
        return { ok: true, version: at + 1 };
      },
    };
    return { store, calls };
  };

  test("a term creates the record once it has a registry, beside takeover and not ahead of it", async () => {
    const relay = startTestRelay(TOKEN);
    const settings = memorySettings();
    const { leader } = leaderOver(relay, new MemoryQueueStore(), undefined, undefined, settings.store);
    try {
      leader.lead(1);
      await leader.settled();
      await pollUntil(() => settings.calls.puts.length === 1, "the settings create");
      expect(settings.calls.puts).toEqual([0]);
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("a read that is never answered does not hold up takeover, is retried on the tick, and warns once", async () => {
    const relay = startTestRelay(TOKEN);
    const settings = memorySettings(2);
    const { leader } = leaderOver(relay, new MemoryQueueStore(), 40, undefined, settings.store);
    const lines = await captureLog(async () => {
      try {
        leader.lead(1);
        // Takeover settles while the first read has already failed.
        await leader.settled();
        await pollUntil(() => settings.calls.puts.length === 1, "the retried read to create the record", 5_000);
        expect(settings.calls.gets).toBe(3);
      } finally {
        leader.stop();
        relay.stop();
      }
    });
    expect(lines.filter((line) => line.includes("could not load its settings"))).toHaveLength(1);
    expect(lines.some((line) => line.includes("took over"))).toBe(true);
  });

  test("a read still pending does not hold up takeover; the create follows once it is answered", async () => {
    const relay = startTestRelay(TOKEN);
    const settings = memorySettings();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending: SettingsStore = {
      get: async () => {
        await gate;
        return settings.store.get();
      },
      put: settings.store.put,
    };
    const { leader } = leaderOver(relay, new MemoryQueueStore(), undefined, undefined, pending);
    const lines = await captureLog(async () => {
      try {
        leader.lead(1);
        // `settled` ends with takeover's log line, and it must resolve while the read is unanswered.
        await leader.settled();
        expect(settings.calls.puts).toEqual([]);
        release();
        await pollUntil(() => settings.calls.puts.length === 1, "the settings create after the answer", 5_000);
      } finally {
        release();
        leader.stop();
        relay.stop();
      }
    });
    expect(lines.some((line) => line.includes("took over"))).toBe(true);
    expect(settings.calls.puts).toEqual([0]);
  });

  test("a record it cannot read is never written over: one warning, no create, and the queue runs", async () => {
    const relay = startTestRelay(TOKEN);
    const settings = memorySettings();
    const unreadable: SettingsStore = {
      get: () => Promise.resolve({ version: 3, reason: "unopenable" }),
      put: settings.store.put,
    };
    const { leader } = leaderOver(relay, new MemoryQueueStore(), 40, undefined, unreadable);
    const lines = await captureLog(async () => {
      try {
        leader.lead(1);
        await leader.settled();
        await pollUntil(() => leader.term() === 1, "the term");
        // Several ticks pass: a retry that wrote would show.
        await Bun.sleep(200);
      } finally {
        leader.stop();
        relay.stop();
      }
    });
    expect(settings.calls.puts).toEqual([]);
    expect(lines.filter((line) => line.includes("settings unavailable (unopenable)"))).toHaveLength(1);
  });
});

describe("leader push", () => {
  const sub = (id: string, host = "fcm.googleapis.com"): WebPushSubscription => ({
    endpoint: `https://${host}/fcm/send/${id}`,
    // RFC 8291 Appendix A's user agent: a real P-256 point, so a send can encrypt to it.
    keys: {
      p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    },
  });

  /** A settings store in memory with the relay's version rule, starting from `held`. */
  const heldSettings = async (subscriptions?: readonly WebPushSubscription[]) => {
    let held: SettingsRead = {
      version: 1,
      record: {
        version: 1,
        vapid: await generateVapidKeys(),
        ...(subscriptions === undefined ? {} : { subscriptions }),
      },
    };
    const puts: number[] = [];
    const store: SettingsStore = {
      get: async () => held,
      put: async (at, record) => {
        puts.push(at);
        if (held === null || held.version !== at) return { ok: false, code: "version_conflict" };
        held = { version: at + 1, record: { ...record, version: at + 1 } };
        return { ok: true, version: at + 1 };
      },
    };
    return { store, puts, subscriptions: () => held?.record?.subscriptions };
  };

  /** Runs one request through a leading term and returns the app's answer. */
  const subscribe = async (
    leader: Leader,
    replies: AsyncQueue<{ readonly to: string; readonly response: Plain }>,
    payload: unknown,
  ): Promise<unknown> => {
    leader.deliver(await appRequest("push-subscribe", payload));
    return (await replies.next()).response.payload;
  };

  test("push-subscribe adds a subscription, answers its endpoint, and audits the request id only", async () => {
    const relay = startTestRelay(TOKEN);
    const settings = await heldSettings();
    const { leader, replies } = leaderOver(relay, new MemoryQueueStore(), undefined, undefined, settings.store);
    const fresh = sub("one");
    const lines = await captureLog(async () => {
      try {
        leader.lead(1);
        await leader.settled();
        await pollUntil(() => leader.term() === 1, "the term");
        // Settings load beside takeover: a request before it is `not_ready`, so wait for the first answer that is not.
        await pollUntil(async () => {
          const answer = await subscribe(leader, replies, fresh);
          return !(isRecord(answer) && answer["code"] === "not_ready");
        }, "the settings to load");
        expect(settings.subscriptions()).toEqual([fresh]);
      } finally {
        leader.stop();
        relay.stop();
      }
    });
    const audit = lines.filter((line) => line.includes("op=push-subscribe"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatch(/audit queue origin=relay op=push-subscribe id="?[\w-]+"? ok$/u);
    expect(lines.some((line) => line.includes("fcm.googleapis.com") || line.includes(fresh.keys.auth))).toBe(false);
  });

  test("the same subscription again answers its endpoint and writes nothing; new keys for it replace the old", async () => {
    const relay = startTestRelay(TOKEN);
    const settings = await heldSettings();
    const { leader, replies } = leaderOver(relay, new MemoryQueueStore(), undefined, undefined, settings.store);
    try {
      leader.lead(1);
      await leader.settled();
      await pollUntil(() => leader.term() === 1, "the term");
      const one = sub("one");
      await pollUntil(async () => {
        const answer = await subscribe(leader, replies, one);
        return isRecord(answer) && answer["endpoint"] === one.endpoint;
      }, "the first subscribe to land");
      const puts = settings.puts.length;
      expect(await subscribe(leader, replies, one)).toEqual({ endpoint: one.endpoint });
      expect(settings.puts).toHaveLength(puts);

      const rekeyed = { ...one, keys: { ...one.keys, auth: Buffer.alloc(16, 3).toString("base64url") } };
      expect(await subscribe(leader, replies, rekeyed)).toEqual({ endpoint: one.endpoint });
      expect(settings.subscriptions()).toEqual([rekeyed]);
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("the seventeenth distinct endpoint is subscriptions_full, and one already held still answers", async () => {
    const relay = startTestRelay(TOKEN);
    const held = Array.from({ length: PUSH_MAX_SUBSCRIPTIONS }, (_, i) => sub(`held-${i}`));
    const settings = await heldSettings(held);
    const { leader, replies } = leaderOver(relay, new MemoryQueueStore(), undefined, undefined, settings.store);
    try {
      leader.lead(1);
      await leader.settled();
      await pollUntil(async () => {
        const answer = await subscribe(leader, replies, sub("extra"));
        return !(isRecord(answer) && answer["code"] === "not_ready");
      }, "the settings to load");
      expect(await subscribe(leader, replies, sub("extra"))).toMatchObject({ ok: false, code: "subscriptions_full" });
      expect(await subscribe(leader, replies, held[3])).toEqual({ endpoint: held[3]?.endpoint });
      expect(settings.puts).toEqual([]);
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("a malformed request, a host off the allowlist and a daemon's request are not subscriptions", async () => {
    const relay = startTestRelay(TOKEN);
    const settings = await heldSettings();
    const { leader, replies } = leaderOver(relay, new MemoryQueueStore(), undefined, undefined, settings.store);
    try {
      leader.lead(1);
      await leader.settled();
      for (const bad of [
        sub("x", "example.com"),
        { endpoint: sub("x").endpoint },
        "https://fcm.googleapis.com/x",
        null,
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- each refusal answers its own request
        expect(await subscribe(leader, replies, bad)).toMatchObject({ ok: false, code: "invalid_request" });
      }
      leader.deliver(await appRequest("push-subscribe", sub("x"), "remote"));
      await Bun.sleep(100);
      expect(replies.size).toBe(0);
      expect(settings.puts).toEqual([]);
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("a refused push-subscribe is audited under the code its reply carries", async () => {
    const lost = async (code: "version_conflict" | "store_full"): Promise<SettingsWrite> => ({ ok: false, code });
    const cases: readonly { readonly code: string; readonly wrap: (base: SettingsStore) => SettingsStore }[] = [
      { code: "internal_error", wrap: (base) => ({ ...base, put: () => lost("store_full") }) },
      { code: "conflict", wrap: (base) => ({ ...base, put: () => lost("version_conflict") }) },
      {
        // A conflict whose re-read finds the record gone: the holder gives up on it.
        code: "settings_unavailable",
        wrap: (base) => {
          let reads = 0;
          return {
            put: () => lost("version_conflict"),
            get: () => (reads++ === 0 ? base.get() : Promise.resolve(null)),
          };
        },
      },
    ];
    for (const { code, wrap } of cases) {
      const relay = startTestRelay(TOKEN);
      // oxlint-disable-next-line no-await-in-loop -- one term per case
      const settings = await heldSettings();
      const { leader, replies } = leaderOver(relay, new MemoryQueueStore(), undefined, undefined, wrap(settings.store));
      // oxlint-disable-next-line no-await-in-loop -- one term per case
      const lines = await captureLog(async () => {
        try {
          leader.lead(1);
          await leader.settled();
          await pollUntil(async () => {
            const answer = await subscribe(leader, replies, sub("x"));
            return isRecord(answer) && answer["code"] === code;
          }, `the ${code} answer`);
        } finally {
          leader.stop();
          relay.stop();
        }
      });
      const audit = lines.filter((line) => line.includes("op=push-subscribe"));
      expect(audit.length).toBeGreaterThan(0);
      for (const line of audit) expect(line).toEndWith(`refused code=${code}`);
    }
  });

  test("a term whose settings are unreadable answers settings_unavailable, and one that has not loaded answers not_ready", async () => {
    const relay = startTestRelay(TOKEN);
    const unreadable: SettingsStore = {
      get: () => Promise.resolve({ version: 3, reason: "unopenable" }),
      put: () => Promise.reject(new Error("must not write")),
    };
    const { leader, replies } = leaderOver(relay, new MemoryQueueStore(), undefined, undefined, unreadable);
    try {
      leader.lead(1);
      await leader.settled();
      await pollUntil(async () => {
        const answer = await subscribe(leader, replies, sub("x"));
        return isRecord(answer) && answer["code"] === "settings_unavailable";
      }, "the term to give up on its settings");
    } finally {
      leader.stop();
      relay.stop();
    }
    const slowRelay = startTestRelay(TOKEN);
    const slow = leaderOver(
      slowRelay,
      new MemoryQueueStore(),
      undefined,
      undefined,
      // Never answers: the holder stays pending, as the term does until its first read lands.
      {
        get: () => Promise.withResolvers<SettingsRead>().promise,
        put: () => Promise.reject(new Error("must not write")),
      },
    );
    try {
      slow.leader.lead(1);
      await slow.leader.settled();
      expect(await subscribe(slow.leader, slow.replies, sub("x"))).toMatchObject({ ok: false, code: "not_ready" });
    } finally {
      slow.leader.stop();
      slowRelay.stop();
    }
  });

  test("an alert raised while the settings are still being read is pushed once they load, not lost", async () => {
    const relay = startTestRelay(TOKEN);
    const push = startPushEndpoint();
    const settings = await heldSettings([sub("live")]);
    const gate = Promise.withResolvers<void>();
    const slow: SettingsStore = {
      get: async () => {
        await gate.promise;
        return settings.store.get();
      },
      put: settings.store.put,
    };
    const store = new MemoryQueueStore();
    await store.put("stuck", 0, task("stuck", { state: "needs-input", needsInputSince: 1 }));
    const { leader } = leaderOver(relay, store, 40, undefined, slow, (input, init) =>
      fetch(push.endpoint(new URL(String(input)).pathname.split("/").at(-1)), init),
    );
    try {
      leader.lead(1);
      await leader.settled();
      // The alert is raised once the escalation lands; nothing can be sent yet, and nothing is.
      await pollUntil(async () => (await store.list()).some((t) => t.body?.escalated === true), "the escalation");
      expect(push.requests()).toEqual([]);
      gate.resolve();
      await push.waitForRequests(1);
    } finally {
      gate.resolve();
      leader.stop();
      relay.stop();
      await push.stop();
    }
  });

  test("a term that ends while its settings are still being read pushes nothing once they land", async () => {
    const relay = startTestRelay(TOKEN);
    const push = startPushEndpoint();
    const settings = await heldSettings([sub("live")]);
    const gate = Promise.withResolvers<void>();
    const slow: SettingsStore = {
      get: async () => {
        await gate.promise;
        return settings.store.get();
      },
      put: settings.store.put,
    };
    const store = new MemoryQueueStore();
    await store.put("stuck", 0, task("stuck", { state: "needs-input", needsInputSince: 1 }));
    const { leader } = leaderOver(relay, store, 40, undefined, slow, (input, init) =>
      fetch(push.endpoint(new URL(String(input)).pathname.split("/").at(-1)), init),
    );
    try {
      leader.lead(1);
      await leader.settled();
      await pollUntil(async () => (await store.list()).some((t) => t.body?.escalated === true), "the escalation");
      leader.follow("the relay nominated another daemon");
      gate.resolve();
      // A non-event cannot be polled: the parked alert would have been sent as the read landed.
      await Bun.sleep(150);
      expect(push.requests()).toEqual([]);
    } finally {
      gate.resolve();
      leader.stop();
      relay.stop();
      await push.stop();
    }
  });

  test("an alert is pushed to every subscription, beside its log line, and a pruned endpoint leaves the record", async () => {
    const relay = startTestRelay(TOKEN);
    const push = startPushEndpoint();
    const gone = startPushEndpoint();
    gone.respondWith(410);
    const live = sub("live");
    const settings = await heldSettings([sub("gone"), live]);
    // Stuck for hours under any threshold: the first pass escalates it.
    const store = new MemoryQueueStore();
    await store.put("stuck", 0, task("stuck", { state: "needs-input", needsInputSince: 1 }));
    const { leader } = leaderOver(relay, store, 40, undefined, settings.store, (input, init) => {
      const id = new URL(String(input)).pathname.split("/").at(-1) ?? "";
      return fetch((id === "gone" ? gone : push).endpoint(id), init);
    });
    const lines = await captureLog(async () => {
      try {
        leader.lead(1);
        await leader.settled();
        await push.waitForRequests(1);
        await gone.waitForRequests(1);
        await pollUntil(() => settings.subscriptions()?.length === 1, "the 410's prune");
      } finally {
        leader.stop();
        relay.stop();
        await push.stop();
        await gone.stop();
      }
    });
    expect(settings.subscriptions()).toEqual([live]);
    expect(push.requests().map((request) => request.path)).toEqual(["/push/live"]);
    expect(lines.some((line) => line.includes("needs input: task="))).toBe(true);
    expect(lines.some((line) => line.includes("pruned a subscription host=fcm.googleapis.com status=410"))).toBe(true);
    expect(lines.some((line) => line.includes("/fcm/send/") || line.includes("vapid t="))).toBe(false);
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
      const sent = await nextRequest(relay);
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
      const asked = await nextRequest(relay);
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
      getPause: () => inner.getPause(),
      putPause: (version, holds) => inner.putPause(version, holds),
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
        const asked = await nextRequest(relay, 5_000);
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
          remote: (await store.get("remote-task"))?.body?.state,
          self: (await store.get("self-task"))?.body?.state,
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
        const asked = await nextRequest(relay, 5_000);
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
      expect((await store.get("on-b"))?.body?.state).toBe("ready");
      expect((await store.get("on-c"))?.body).toMatchObject({
        state: "failed",
        failure: { code: "dispatch_unconfirmed" },
      });
      expect((await store.get("on-self"))?.body?.state).toBe("ready");
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
      const asked = await nextRequest(relay, 5_000);
      const request = await open(key, asked.env);
      const none: SessionsResponse = { sessions: [], at: Date.now() };
      const answer = await seal(
        key,
        { to: SCHEDULER_ID, from: "b" },
        { id: crypto.randomUUID(), ts: Date.now(), op: "sessions", re: request.id, payload: none },
      );
      relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env: answer }));
      await daemon.leader.settled();
      expect((await store.get("t-b"))?.body?.state).toBe("reserved");

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
      await pollUntil(async () => (await store.get("t-b"))?.body?.state !== "reserved", "the busy event to land");
      expect((await store.get("t-b"))?.body).toMatchObject({
        state: "running",
        assignment: { deviceId: "b", pane: "%3" },
      });

      relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env: await event("b", ended) }));
      await pollUntil(async () => (await store.get("t-b"))?.body?.state === "done", "the ended event to land");
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("a valid branch-state reaches the leader quietly; a malformed one and one from an app are dropped", async () => {
    const relay = startTestRelay(TOKEN);
    // `captureLog` hands its lines back only at the end; this one is readable while the test waits on a line.
    const seen: string[] = [];
    const droppedSoFar = (): number => seen.filter((line) => line.includes('dropped op="branch-state"')).length;
    const lines = await captureLog(async () => {
      const capture = console.log;
      console.log = (...args: unknown[]): void => {
        seen.push(args.map(String).join(" "));
        capture(...args);
      };
      const { daemon, deviceId } = await startLeaderDaemon(relay, new MemoryQueueStore());
      try {
        relay.lead(deviceId, 1);
        await daemon.leader.settled();
        const send = async (from: string, payload: unknown): Promise<void> => {
          const env = await seal(
            key,
            { to: SCHEDULER_ID, from },
            { id: crypto.randomUUID(), ts: Date.now(), op: "branch-state", payload },
          );
          relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env }));
        };
        const valid = { taskId: "t-1", repo: "example.test/org/r", branch: "worktree-x", pushed: true, merged: false };
        await send("b", { ...valid, at: Date.now() });
        await send("b", { ...valid, pushed: "yes", at: Date.now() });
        await send(APP_ID, { ...valid, at: Date.now() });
        // Handled in order: once the last drop is logged, the valid one ahead of it was handled too.
        await send("b", { ...valid, pushed: "sentinel", at: Date.now() });
        await pollUntil(() => droppedSoFar() >= 3, "the malformed, app and sentinel branch-states to drop");
      } finally {
        console.log = capture;
        daemon.stop();
        relay.stop();
      }
    });
    const dropped = lines.filter((line) => line.includes('dropped op="branch-state"'));
    expect(dropped).toHaveLength(3);
    expect(dropped.filter((line) => line.includes(`from="${APP_ID}"`))).toHaveLength(1);
    for (const line of dropped) expect(line).toContain("not a session event or branch state");
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

  // The relay picks which term an envelope reaches. A guard per term let it
  // redeliver an app's request to the next one inside the replay window, and act
  // on it once per term.
  test("one replay guard outlives terms: an app's cancel redelivered with no term, then to the next, acts once", async () => {
    const relay = startTestRelay(TOKEN);
    const store = new MemoryQueueStore();
    await store.put("q", 0, task("q", { state: "queued" }));
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]): void => void lines.push(args.map(String).join(" "));
    const { daemon, deviceId } = await startLeaderDaemon(relay, store);
    try {
      const audited = (): number =>
        lines.filter((l) => l.includes("audit queue") && l.includes("op=cancel") && l.includes(" ok")).length;
      const leading = async (term: number | null): Promise<void> => {
        await pollUntil(() => daemon.leader.term() === term, `term ${term ?? "none"}`);
        await daemon.leader.settled();
      };
      const cancel = await appRequest("cancel", { taskId: "q" });
      const redeliver = (): void => relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env: cancel }));
      const replays = (): number => lines.filter((l) => l.includes(cancel.iv) && l.includes("reason=replay")).length;

      relay.lead(deviceId, 1);
      await leading(1);
      redeliver();
      expect((await open(key, await relay.messages.next(5_000))).payload).toHaveProperty("task");
      expect(audited()).toBe(1);

      relay.follow(deviceId);
      await leading(null);
      // Not answered not_leader: the term that took it already answered.
      redeliver();
      await pollUntil(() => replays() === 1, "the follower dropping it as a replay");

      relay.lead(deviceId, 2);
      await leading(2);
      redeliver();
      await pollUntil(() => replays() === 2, "the next term dropping it as a replay");

      await Bun.sleep(100);
      expect(relay.messages.size).toBe(0);
      // One `op=cancel … ok` line in all, and no second one from the redeliveries.
      expect(audited()).toBe(1);
      expect(await store.list()).toHaveLength(1);
    } finally {
      console.log = realLog;
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

describe("PR status", () => {
  const PR_URL = "https://github.com/acme/app/pull/7";
  const answer = (state: string): string =>
    JSON.stringify({
      data: {
        p0: {
          defaultBranchRef: { name: "main" },
          pullRequest: {
            state,
            isDraft: false,
            merged: state === "MERGED",
            baseRefName: "main",
            commits: { nodes: [] },
          },
        },
      },
    });

  test("a term reads its tasks' PRs through gh and settles a merge; follow stops the poller, a new term starts it again", async () => {
    const relay = startTestRelay(TOKEN);
    relay.schedulerTerm = 1;
    const store = new MemoryQueueStore();
    await store.put("pr1", 0, task("pr1", { state: "awaiting-merge", prUrl: PR_URL, endedAt: Date.now() }));
    const gh = await ghStub.fresh();
    await gh.setReply(answer("OPEN"), 0);
    const { leader } = leaderOver(relay, store, undefined, { gh: ghStub.path, intervalMs: 50 });
    try {
      leader.lead(1);
      await pollUntil(async () => (await store.get("pr1"))?.body?.pr?.state === "open", "the open reading");
      expect((await store.get("pr1"))?.body?.state).toBe("awaiting-merge");

      leader.follow("test");
      // A child spawned just before the term ended is still starting: count once it has.
      const after = await gh.settledCalls();
      await Bun.sleep(300);
      expect(await gh.calls()).toBe(after);

      await gh.setReply(answer("MERGED"), 0);
      relay.schedulerTerm = 2;
      leader.lead(2);
      await pollUntil(async () => (await store.get("pr1"))?.body?.state === "done", "the merge settling it");
      expect((await store.get("pr1"))?.body).toMatchObject({ doneBy: "merged", pr: { state: "merged" } });
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("a poll still out when the term ends lands nowhere", async () => {
    const relay = startTestRelay(TOKEN);
    relay.schedulerTerm = 1;
    const store = new MemoryQueueStore();
    await store.put("pr1", 0, task("pr1", { state: "awaiting-merge", prUrl: PR_URL, endedAt: Date.now() }));
    const gh = await ghStub.fresh();
    await gh.setReply(answer("OPEN"), 0);
    const { leader } = leaderOver(relay, store, undefined, { gh: ghStub.path, intervalMs: 50 });
    try {
      leader.lead(1);
      await pollUntil(async () => (await store.get("pr1"))?.body?.pr?.state === "open", "the open reading");
      const written = (await store.get("pr1"))?.version;

      // The merge is on its way, held back inside gh: end the term while it is.
      await gh.setReply(answer("MERGED"), 0, 0.5);
      await pollUntil(async () => (await gh.delayed()) > 0, "a merged answer in flight");
      leader.follow("test");
      // A non-event: the answer lands after this and must change nothing.
      await Bun.sleep(900);
      const record = await store.get("pr1");
      expect(record?.version).toBe(written);
      expect(record?.body).toMatchObject({ state: "awaiting-merge", pr: { state: "open" } });
    } finally {
      leader.stop();
      relay.stop();
    }
  });
});

describe("fleet quota record", () => {
  /** `org:b`'s reading, seen by a machine the registry no longer lists. */
  async function plantQuota(relay: TestRelay, version: number, h: number): Promise<void> {
    const at = Math.floor(Date.now() / 1000) - 30;
    const accounts = [{ accountId: "org:b", observer: "gone", reading: { h, d: 10, s: "session", at } }] as const;
    relay.plantRecord(QUOTA_KEY, version, await sealFleetQuotaRecord(key, "gone", { version, accounts }));
  }

  test("takeover reads it first: an account only the record has seen is observed from the first pass", async () => {
    const relay = startTestRelay(TOKEN);
    relay.setRegistry([await routableEntry("b", false)]);
    await plantQuota(relay, 1, 20);
    const { leader, legs, replies } = leaderOver(relay);
    try {
      leader.lead(1);
      await leader.settled();
      expect(legs[0]?.getState().fleetQuota).toHaveLength(1);
      leader.deliver(await appRequest("route-preview", { repo: "github.com/acme/app", mode: "worktree" }));
      expect((await replies.next()).response.payload).toMatchObject({
        decision: { candidates: [{ deviceId: "b", quota: { observer: "gone" } }] },
      });

      // Another daemon's write: the relay nudges the leader, which re-reads on its leg.
      await plantQuota(relay, 2, 70);
      leader.onStoreChanged(QUOTA_KEY, 2);
      await pollUntil(() => legs[0]?.getState().fleetQuota[0]?.reading.h === 70, "the re-read record");
    } finally {
      leader.stop();
      relay.stop();
    }
  });

  test("a read that gets no answer still lets takeover finish, past the store timeout", async () => {
    const relay = startTestRelay(TOKEN);
    relay.setRegistry([await routableEntry("b", false)]);
    relay.holdStoreReplies = true;
    const { leader, legs } = leaderOver(relay, new MemoryQueueStore(), undefined, undefined, undefined, undefined, 100);
    try {
      leader.lead(1);
      await leader.settled();
      expect(legs[0]?.getState().fleetQuota).toEqual([]);
    } finally {
      leader.stop();
      relay.stop();
    }
  });
});
