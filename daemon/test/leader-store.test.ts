import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_ID,
  appRelayUrl,
  importPsk,
  open,
  openTaskRecord,
  RelayClient,
  SCHEDULER_ID,
  seal,
  sealTaskRecord,
  toBase64,
  type OpName,
  type Plain,
  type StoreRequestFrame,
} from "@seance/shared";
import { IDLE_MS } from "../src/app-relay.ts";
import { createBackend } from "../src/backend-default.ts";
import type { Config } from "../src/config.ts";
import type { LocalOps } from "../src/handlers.ts";
import {
  createLeader,
  MemoryQueueStore,
  StoreRevoked,
  type Leader,
  type QueueStore,
  type StoreEntry,
  type Task,
} from "../src/leader.ts";
import { startDaemon } from "../src/run.ts";
import { captureLog, makeClaudeStub, makeGitFixture, pollUntil, usePrivateTmux, type PrivateTmux } from "./fixtures.ts";
import { nextRequest, startTestRelay, type TestRelay } from "./harness.ts";

// The leader's term lifecycle on the store seam (scheduler M3 item 3): what a
// `store-changed` does, what ends a term, and what reaches the library. A new
// file beside leader.test.ts, which item 5 also edits.

const PSK = toBase64(new Uint8Array(32).fill(5));
const TOKEN = "leader-store-bearer";
let base: string;
let key: CryptoKey;
let privateTmux: PrivateTmux | undefined;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-leader-store-"));
  process.env["SEANCE_STATE_DIR"] = join(base, "state");
  privateTmux = usePrivateTmux(base, "leader-store");
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

function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    spec: { repo: "github.com/acme/app", mode: "worktree" },
    state: "queued",
    createdAt: Date.now(),
    ...fields,
  };
}

const target = { exclave: "default", clone: "app" } as const;
const placedOnB = { deviceId: "b", ...target, window: "w1", pane: "%3" };

const noLocalOps: LocalOps = {
  sessions: () => Promise.reject(new Error("unexpected local sessions")),
  spawn: () => Promise.reject(new Error("unexpected local spawn")),
  despawn: () => Promise.reject(new Error("unexpected local despawn")),
};

/**
 * A leader over the real shared client and the harness, as leader.test.ts
 * builds one, on a store the test holds. The tick is pushed out so a task that
 * moves did so because it was told to, not because a timer came round.
 */
function leaderOver(relay: TestRelay, store: QueueStore, local: LocalOps = noLocalOps, tickIntervalMs = 3_600_000) {
  let resigned = 0;
  const replies: { readonly to: string; readonly response: Plain }[] = [];
  const leader: Leader = createLeader({
    selfDeviceId: "self",
    pushSubject: "https://relay.test",
    local,
    store,
    reply: (to, response) => {
      replies.push({ to, response });
      return Promise.resolve(true);
    },
    resign: () => {
      resigned += 1;
    },
    tickIntervalMs,
    createRelay: (term, onEvent) =>
      new RelayClient({
        url: appRelayUrl(relay.url),
        token: TOKEN,
        key,
        scheduler: { term, onEvent },
        pingIntervalMs: 4 * IDLE_MS,
        log: () => {},
        createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
      }),
  });
  return { leader, replies, resigned: () => resigned };
}

async function withLeader(
  body: (t: {
    relay: TestRelay;
    leader: Leader;
    replies: readonly { readonly to: string; readonly response: Plain }[];
    resigned: () => number;
  }) => Promise<void>,
  store: QueueStore = new MemoryQueueStore(),
  local: LocalOps = noLocalOps,
  tickIntervalMs?: number,
): Promise<void> {
  const relay = startTestRelay(TOKEN);
  const { leader, replies, resigned } = leaderOver(relay, store, local, tickIntervalMs);
  try {
    await body({ relay, leader, replies, resigned });
  } finally {
    leader.stop();
    relay.stop();
  }
}

const stateOf = async (store: QueueStore, id: string): Promise<string | undefined> =>
  (await store.get(id))?.body?.state;

/** An event or request as another daemon seals it to the scheduler. */
const sealedTo = (op: OpName, payload: unknown, from: string) =>
  seal(key, { to: SCHEDULER_ID, from }, { id: crypto.randomUUID(), ts: Date.now(), op, payload });

describe("store-changed", () => {
  test("a nudge refreshes that task and ticks, with no timer firing", async () => {
    const store = new MemoryQueueStore();
    await withLeader(async ({ leader }) => {
      leader.lead(1);
      await leader.settled();
      // An app's create: the leader's own socket never wrote it, so only the nudge can tell it.
      await store.put("x", 0, task("x"));
      leader.onStoreChanged("task:x", 1);
      await pollUntil(async () => (await stateOf(store, "x")) === "ready", "the nudged task to be admitted");
    }, store);
  });

  test("a nudge during takeover is buffered and applied once takeover ends", async () => {
    class Gated extends MemoryQueueStore {
      readonly gate = Promise.withResolvers<void>();
      listed = false;
      // The snapshot is read before the gate, so a create after it is one takeover's list cannot hold.
      override async list(): Promise<readonly StoreEntry[]> {
        const snapshot = await super.list();
        this.listed = true;
        await this.gate.promise;
        return snapshot;
      }
    }
    const store = new Gated();
    await withLeader(async ({ leader }) => {
      leader.lead(1);
      await pollUntil(() => store.listed, "takeover to read the store");
      await store.put("x", 0, task("x"));
      leader.onStoreChanged("task:x", 1);
      store.gate.resolve();
      await leader.settled();
      await pollUntil(async () => (await stateOf(store, "x")) === "ready", "the buffered nudge to be applied");
    }, store);
  });

  test("keys outside task:, and a nudge with no term, read nothing", async () => {
    class Counting extends MemoryQueueStore {
      gets = 0;
      override async get(id: string): Promise<StoreEntry | null> {
        this.gets += 1;
        return super.get(id);
      }
    }
    const store = new Counting();
    await withLeader(async ({ leader }) => {
      leader.onStoreChanged("task:x", 1);
      leader.lead(1);
      await leader.settled();
      leader.onStoreChanged("queue:pause", 1);
      leader.onStoreChanged("account:abc", 1);
      leader.follow("test");
      leader.onStoreChanged("task:x", 1);
      // A non-event cannot be polled for.
      await Bun.sleep(50);
      expect(store.gets).toBe(0);
    }, store);
  });

  test("a refresh that fails is retried by the next tick, which then admits the task", async () => {
    class FlakyGet extends MemoryQueueStore {
      failures = 1;
      override async get(id: string): Promise<StoreEntry | null> {
        if (id === "x" && this.failures > 0) {
          this.failures -= 1;
          throw new Error("store-get: timed out");
        }
        return super.get(id);
      }
    }
    const store = new FlakyGet();
    await withLeader(async ({ leader }) => {
      leader.lead(1);
      await leader.settled();
      await store.put("x", 0, task("x"));
      leader.onStoreChanged("task:x", 1);
      await pollUntil(() => store.failures === 0, "the first refresh to fail");
      expect(await stateOf(store, "x")).toBe("queued");
      // The failed refresh puts x back a microtask after the get rejects, so a tick sent at once may
      // run before it: any later tick retries it, and none else moves x.
      await pollUntil(async () => {
        leader.onStoreChanged("task:other", 1);
        return (await stateOf(store, "x")) === "ready";
      }, "a later tick to retry the failed refresh and admit it");
    }, store);
  });

  // Q5 of the M3 review: no second store-changed comes for a create from a phone whose clock runs fast.
  test("a create stamped ahead of the leader's clock is read again on the timer, and admitted once it binds", async () => {
    const store = new MemoryQueueStore();
    // Read as the adapter reads a record whose `createdAt` is past the leader's clock plus the replay window.
    store.plant("x", "created_ahead");
    await withLeader(
      async ({ leader }) => {
        leader.lead(1);
        await leader.settled();
        // The leader's clock passes the stamp: the same record now binds, and nothing nudges the leader.
        await store.put("x", 1, task("x"));
        await pollUntil(async () => (await stateOf(store, "x")) === "ready", "the timer to re-read and admit x");
        expect(leader.term()).toBe(1);
      },
      store,
      noLocalOps,
      50,
    );
  });
});

describe("store-changed while takeover's buffered nudges are refreshing", () => {
  test("a nudge that arrives between the term running and its buffered refresh finishing is applied, not lost", async () => {
    class Gated extends MemoryQueueStore {
      readonly listGate = Promise.withResolvers<void>();
      readonly getGate = Promise.withResolvers<void>();
      listed = false;
      xGetHeld = false;
      override async list(): Promise<readonly StoreEntry[]> {
        const snapshot = await super.list();
        this.listed = true;
        await this.listGate.promise;
        return snapshot;
      }
      // Only x's refresh is held: it is the buffered nudge takeover applies once `running` is set.
      override async get(id: string): Promise<StoreEntry | null> {
        if (id === "x") {
          this.xGetHeld = true;
          await this.getGate.promise;
        }
        return super.get(id);
      }
    }
    const store = new Gated();
    await withLeader(async ({ leader }) => {
      leader.lead(1);
      await pollUntil(() => store.listed, "takeover to read the store");
      await store.put("x", 0, task("x"));
      leader.onStoreChanged("task:x", 1);
      store.listGate.resolve();
      await pollUntil(() => store.xGetHeld, "the buffered refresh to be in flight");
      await store.put("y", 0, task("y"));
      leader.onStoreChanged("task:y", 1);
      await pollUntil(async () => (await stateOf(store, "y")) === "ready", "the mid-refresh nudge to be admitted");
      store.getGate.resolve();
      await pollUntil(async () => (await stateOf(store, "x")) === "ready", "the buffered nudge to be admitted");
    }, store);
  });
});

/** Writes go through until `armed`, then every one meets the relay's `not_leader`. */
class Revocable extends MemoryQueueStore {
  armed = false;
  override put(id: string, version: number, body: Task): ReturnType<MemoryQueueStore["put"]> {
    if (this.armed) return Promise.reject(new StoreRevoked("the relay refused store-put as not_leader"));
    return super.put(id, version, body);
  }
}

describe("a revoked term, from the paths that write on an event", () => {
  const running = (): Task => task("t", { state: "running", assignment: placedOnB });
  const branchState = {
    taskId: "t",
    repo: "github.com/acme/app",
    branch: "worktree-x",
    pushed: true,
    merged: false,
    at: 1,
  };

  // The task arrives by a nudge, whose refresh is async: each test re-sends its event until the
  // library holds the task and writes, which is the revoked write that ends the term.
  async function armed(store: Revocable, leader: Leader): Promise<void> {
    leader.lead(1);
    await leader.settled();
    await store.put("t", 0, running());
    leader.onStoreChanged("task:t", 1);
    store.armed = true;
  }

  test("onSession", async () => {
    const store = new Revocable();
    await withLeader(async ({ leader, resigned }) => {
      await armed(store, leader);
      await pollUntil(async () => {
        await leader.onSession("t", "ended", { deviceId: "b", pane: "%3" });
        return leader.term() === null;
      }, "the revoked session write to end the term");
      expect(resigned()).toBe(0);
    }, store);
  });

  test("onBranchState", async () => {
    const store = new Revocable();
    await withLeader(async ({ leader, resigned }) => {
      await armed(store, leader);
      await pollUntil(() => {
        leader.onBranchState(branchState, "b");
        return leader.term() === null;
      }, "the revoked branch-state write to end the term");
      expect(resigned()).toBe(0);
    }, store);
  });

  test("an app's request is answered not_leader, not internal_error", async () => {
    // Seeded at version 0 before the term, so only the request's own update (version 1) is revoked.
    class RevokedUpdate extends MemoryQueueStore {
      override put(id: string, version: number, body: Task): ReturnType<MemoryQueueStore["put"]> {
        if (version !== 0) return Promise.reject(new StoreRevoked("the relay refused store-put as not_leader"));
        return super.put(id, version, body);
      }
    }
    const store = new RevokedUpdate();
    // `ready` with no machine to take it: a queued task would be admitted on takeover's first tick, and that write is the revoked one.
    await store.put("t", 0, task("t", { state: "ready" }));
    await withLeader(async ({ leader, replies, resigned }) => {
      leader.lead(1);
      await leader.settled();
      leader.deliver(await sealedTo("cancel", { taskId: "t" }, APP_ID));
      await pollUntil(() => leader.term() === null, "the revoked request to end the term");
      await pollUntil(() => replies.length === 1, "the app to be answered");
      expect(replies[0]?.response.payload).toMatchObject({ ok: false, code: "not_leader" });
      expect(resigned()).toBe(0);
    }, store);
  });
});

describe("a revoked cancel", () => {
  test("after its despawn ran is internal_error naming the ended session, not not_leader, and still ends the term", async () => {
    const store = new Revocable();
    await store.put("t", 0, task("t", { state: "running", assignment: { ...placedOnB, deviceId: "self" } }));
    const despawned: unknown[] = [];
    const local: LocalOps = {
      ...noLocalOps,
      // Takeover reconciles the running task against its machine's sessions: this one is alive.
      sessions: () =>
        Promise.resolve({
          sessions: [{ id: "%3", window: "w1", repo: "app", path: "/wt/t", taskId: "t" }],
          at: Date.now(),
        }),
      despawn: (request) => {
        despawned.push(request);
        return Promise.resolve({ ok: true, window: "w1", outcome: "exited", sessions: [] });
      },
    };
    await withLeader(
      async ({ leader, replies, resigned }) => {
        leader.lead(1);
        await leader.settled();
        store.armed = true;
        leader.deliver(await sealedTo("cancel", { taskId: "t" }, APP_ID));
        await pollUntil(() => replies.length === 1, "the app to be answered");
        expect(despawned).toMatchObject([{ id: "%3" }]);
        expect(replies[0]?.response.payload).toMatchObject({ ok: false, code: "internal_error" });
        expect(JSON.stringify(replies[0]?.response.payload)).toContain("already have ended");
        await pollUntil(() => leader.term() === null, "the revoked write to end the term");
        expect(resigned()).toBe(0);
      },
      store,
      local,
    );
  });
});

describe("a revoked term", () => {
  test("a write the relay refuses as not_leader ends the term without resigning", async () => {
    const store = new MemoryQueueStore();
    await store.put("x", 0, task("x"));
    await withLeader(async ({ leader, resigned }) => {
      // Admission is the first write the term makes.
      store.failNext({ code: "revoked" });
      leader.lead(1);
      await pollUntil(() => leader.term() === null, "the revoked term to end itself");
      expect(resigned()).toBe(0);
    }, store);
  });

  test("a takeover whose list is revoked ends the term instead of returning silently", async () => {
    class Revoked extends MemoryQueueStore {
      override list(): Promise<readonly StoreEntry[]> {
        return Promise.reject(new StoreRevoked("the relay refused store-list as not_leader"));
      }
    }
    await withLeader(async ({ leader, resigned }) => {
      leader.lead(1);
      await pollUntil(() => leader.term() === null, "the revoked takeover to end the term");
      expect(resigned()).toBe(0);
    }, new Revoked());
  });

  // Q9 of the M3 review: `end` wakes a retry wait that does not exist yet, so one armed after it is never woken.
  test("a takeover that fails after its term ended neither says it retries nor arms a retry", async () => {
    class Stalled extends MemoryQueueStore {
      readonly listing = Promise.withResolvers<void>();
      readonly gate = Promise.withResolvers<never>();
      override list(): Promise<readonly StoreEntry[]> {
        this.listing.resolve();
        return this.gate.promise;
      }
    }
    const store = new Stalled();
    const lines = await captureLog(async () => {
      await withLeader(
        async ({ leader }) => {
          leader.lead(1);
          await store.listing.promise;
          leader.follow("the relay moved the role elsewhere");
          store.gate.reject(new Error("store-list: timed out"));
          // A non-event: nothing to poll for but a line that must not come.
          await Bun.sleep(100);
        },
        store,
        noLocalOps,
      );
    });
    expect(lines.filter((line) => line.includes("retrying"))).toEqual([]);
  });
});

const branch = (taskId: string, fields: object = {}): object => ({
  taskId,
  repo: "github.com/acme/app",
  branch: "worktree-x",
  pushed: true,
  merged: false,
  at: Date.now(),
  ...fields,
});

describe("branch state and PR", () => {
  const running = (id: string): Task => task(id, { state: "running", assignment: placedOnB });
  const url = "https://github.com/acme/app/pull/7";

  // The running task arrives by a nudge, not at takeover (which would ask machine b for its sessions). The put is
  // already visible, so a test polls the effect it wants, re-sending until the refresh has landed.
  async function adopt(store: MemoryQueueStore, leader: Leader, id: string): Promise<void> {
    leader.lead(1);
    await leader.settled();
    await store.put(id, 0, running(id));
    leader.onStoreChanged(`task:${id}`, 1);
    await pollUntil(async () => (await stateOf(store, id)) === "running", "the running task to be held");
  }

  test("a relayed branch-state records the branch, and a merge of a pushed branch makes the task done", async () => {
    const store = new MemoryQueueStore();
    await withLeader(async ({ leader }) => {
      await adopt(store, leader, "t");
      // Refresh is async behind the nudge: poll the library's own view through its effect.
      await pollUntil(async () => {
        leader.deliver(await sealedTo("branch-state", branch("t"), "b"));
        return (await store.get("t"))?.body?.branch === "worktree-x";
      }, "the branch-state to be recorded");
      expect((await store.get("t"))?.body).toMatchObject({ branch: "worktree-x", pushed: true, state: "running" });
      leader.deliver(await sealedTo("branch-state", branch("t", { merged: true }), "b"));
      await pollUntil(async () => (await stateOf(store, "t")) === "done", "the merge to finish the task");
    }, store);
  });

  test("an in-process branch-state does the same, and is dropped outside a running term", async () => {
    const store = new MemoryQueueStore();
    await withLeader(async ({ leader }) => {
      const state = {
        taskId: "t",
        repo: "github.com/acme/app",
        branch: "worktree-x",
        pushed: true,
        merged: false,
        at: 1,
      };
      // No term: nothing to feed.
      leader.onBranchState(state, "b");
      await adopt(store, leader, "t");
      await pollUntil(async () => {
        leader.onBranchState(state, "b");
        return (await store.get("t"))?.body?.pushed === true;
      }, "the in-process branch-state to be recorded");
      leader.onBranchState({ ...state, merged: true }, "b");
      await pollUntil(async () => (await stateOf(store, "t")) === "done", "the merge to finish the task");
    }, store);
  });

  test("a relayed session end with an https PR makes the task awaiting-merge", async () => {
    const store = new MemoryQueueStore();
    await withLeader(async ({ leader }) => {
      await adopt(store, leader, "t");
      const ended = { session: "%3", taskId: "t", exclave: "default", state: "ended", at: Date.now(), prUrl: url };
      await pollUntil(async () => {
        leader.deliver(await sealedTo("session-event", ended, "b"));
        return (await stateOf(store, "t")) === "awaiting-merge";
      }, "the ended session to wait for its merge");
      expect((await store.get("t"))?.body?.prUrl).toBe(url);
    }, store);
  });

  test("an in-process session end carries the PR the same way", async () => {
    const store = new MemoryQueueStore();
    await withLeader(async ({ leader }) => {
      await adopt(store, leader, "t");
      await pollUntil(async () => {
        await leader.onSession("t", "ended", { deviceId: "b", pane: "%3" }, url);
        return (await stateOf(store, "t")) === "awaiting-merge";
      }, "the ended session to wait for its merge");
      expect((await store.get("t"))?.body?.prUrl).toBe(url);
    }, store);
  });
});

describe("leader in the daemon", () => {
  async function startLeaderDaemon(relay: TestRelay, store: QueueStore | undefined) {
    // A machine of its own each: the version floor is one per state dir per process, and these
    // tests reuse task ids at versions an earlier one already raised it past.
    process.env["SEANCE_STATE_DIR"] = await mkdtemp(join(base, "state-"));
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
      home: join(base, "home"),
      pingIntervalMs: 60_000,
      pongTimeoutMs: 300,
      baseBackoffMs: 20,
      leader: { ...(store === undefined ? {} : { store }), tickIntervalMs: 3_600_000 },
    });
    const { deviceId } = await relay.registers.next();
    return { daemon, deviceId };
  }

  test("a store-changed frame on the daemon's socket reaches the leader", async () => {
    const relay = startTestRelay(TOKEN);
    const store = new MemoryQueueStore();
    const { daemon, deviceId } = await startLeaderDaemon(relay, store);
    try {
      relay.lead(deviceId, 1);
      await daemon.leader.settled();
      await store.put("x", 0, task("x"));
      relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "store-changed", key: "task:x", version: 1 }));
      await pollUntil(async () => (await stateOf(store, "x")) === "ready", "the daemon to pass the nudge on");
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("with no store given the daemon leads on the relay's: an app's create is nudged, admitted and written back through the store leg", async () => {
    const relay = startTestRelay(TOKEN);
    const { daemon, deviceId } = await startLeaderDaemon(relay, undefined);
    try {
      relay.lead(deviceId, 1);
      await daemon.leader.settled();
      // The settings record is read and created beside takeover, so its frames and the takeover's
      // list arrive in no fixed order.
      await pollUntil(() => relay.storeRecords().has("settings:main"), "the settings record");
      const frames: StoreRequestFrame[] = [];
      while (relay.storeFrames.size > 0) frames.push(await relay.storeFrames.next());
      // Takeover listed `task:` over the leg, and the settings create went under the term the relay named.
      expect(frames.filter((frame) => frame.t === "store-list")).toMatchObject([{ prefix: "task:" }]);
      expect(frames.filter((frame) => frame.t === "store-put")).toMatchObject([
        { key: "settings:main", expect: 0, term: 1 },
      ]);
      const created = relay.appWrite("task:x", await sealTaskRecord(key, APP_ID, { version: 1, task: task("x") }));
      expect(created).toEqual({ ok: true, version: 1 });
      await pollUntil(() => relay.storeRecords().get("task:x")?.version === 2, "the leader to write the admit");
      const held = relay.storeRecords().get("task:x");
      if (held === undefined) throw new Error("no record");
      const opened = await openTaskRecord(key, { key: "task:x", version: held.version, env: held.env }, Date.now());
      expect(opened).toMatchObject({ version: 2, task: { id: "x", state: "ready" } });
      expect(held.env.from).toBe(SCHEDULER_ID);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  /** Takeover of one task running on `b`, whose `sessions` answer is `payload`. */
  async function takeOver(payload: object): Promise<Task | undefined> {
    const relay = startTestRelay(TOKEN);
    const store = new MemoryQueueStore();
    await store.put("p", 0, task("p", { state: "running", assignment: placedOnB }));
    const { daemon, deviceId } = await startLeaderDaemon(relay, store);
    try {
      relay.lead(deviceId, 4);
      const asked = await nextRequest(relay, 5_000);
      const request = await open(key, asked.env);
      expect(request.op).toBe("sessions");
      const reply = await seal(
        key,
        { to: SCHEDULER_ID, from: "b" },
        { id: crypto.randomUUID(), ts: Date.now(), op: "sessions", re: request.id, payload },
      );
      relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env: reply }));
      await daemon.leader.settled();
      return (await store.get("p"))?.body;
    } finally {
      daemon.stop();
      relay.stop();
    }
  }

  test("a sessions reply's progress reaches takeover: a gone session with a PR is awaiting-merge", async () => {
    const progress = [{ taskId: "p", prUrl: "https://github.com/acme/app/pull/9", branch: "x", pushed: true, at: 1 }];
    expect((await takeOver({ sessions: [], at: Date.now(), progress }))?.state).toBe("awaiting-merge");
  });

  test("a progress list that does not parse leaves the task unsettled rather than done", async () => {
    // A malformed entry makes the list one nobody can read: every task's progress is unknown.
    const progress = [{ taskId: 5 }];
    expect((await takeOver({ sessions: [], at: Date.now(), progress }))?.state).toBe("running");
  });

  test("with no progress at all, the same gone session is done", async () => {
    expect(await takeOver({ sessions: [], at: Date.now() })).toMatchObject({ state: "done", doneBy: "session" });
  });

  test("a branch that merged during the gap settles the gone session as done by merge", async () => {
    const progress = [
      { taskId: "p", prUrl: "https://github.com/acme/app/pull/9", branch: "x", pushed: true, merged: true, at: 1 },
    ];
    expect(await takeOver({ sessions: [], at: Date.now(), progress })).toMatchObject({
      state: "done",
      doneBy: "merged",
    });
  });
});
