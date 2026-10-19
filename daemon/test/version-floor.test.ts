import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_ID,
  CAPABILITIES,
  appRelayUrl,
  importPsk,
  open,
  parseQueueReply,
  RelayClient,
  SCHEDULER_ID,
  seal,
  taskKey,
  toBase64,
  type Envelope,
  type MachineInfo,
  type MachineStatus,
  type OpName,
  type PauseHold,
  type Plain,
  type QueueResponse,
  type RegistryView,
} from "@seance/shared";
import { IDLE_MS } from "../src/app-relay.ts";
import type { LocalOps } from "../src/handlers.ts";
import { createLeader, MemoryQueueStore, type Leader, type QueueStore, type Task } from "../src/leader.ts";
import { VersionFloor } from "../src/version-floor.ts";
import { pollUntil } from "./fixtures.ts";
import { AsyncQueue, nextRequest, queuedRequests, startTestRelay, type TestRelay } from "./harness.ts";

// S1 of the M3 review: a relay that answers reads with an authentic old record
// at its own old version. Version binding cannot see it; the leader's version
// floor must, on a refresh, on a new term in the same process and after a restart.

const PSK = toBase64(new Uint8Array(32).fill(5));
const TOKEN = "version-floor-bearer";
let base: string;
let key: CryptoKey;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-version-floor-"));
  key = await importPsk(PSK);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const noLocalOps: LocalOps = {
  sessions: () => Promise.reject(new Error("unexpected local sessions")),
  spawn: () => Promise.reject(new Error("unexpected local spawn")),
  despawn: () => Promise.reject(new Error("unexpected local despawn")),
};

function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    spec: { repo: "github.com/acme/app", mode: "worktree" },
    state: "queued",
    createdAt: Date.now(),
    ...fields,
  };
}

/** Every read and write goes to `rolled` once set: the history a compromised relay serves instead of the real one. */
class RelayStore implements QueueStore {
  rolled: QueueStore | null = null;
  constructor(readonly real: MemoryQueueStore) {}
  get #now(): QueueStore {
    return this.rolled ?? this.real;
  }
  list: QueueStore["list"] = () => this.#now.list();
  get: QueueStore["get"] = (id) => this.#now.get(id);
  put: QueueStore["put"] = (id, at, body) => this.#now.put(id, at, body);
  delete: QueueStore["delete"] = (id, at) => this.#now.delete(id, at);
  getPause: QueueStore["getPause"] = () => this.#now.getPause();
  putPause: QueueStore["putPause"] = (at, holds) => this.#now.putPause(at, holds);
}

/** A task that ran and finished at version 5, and the version-1 create a relay can put back: the same id, queued. */
async function finishedAtFive(
  id: string,
): Promise<{ readonly real: MemoryQueueStore; readonly rolled: MemoryQueueStore }> {
  const real = new MemoryQueueStore();
  await real.put(id, 0, task(id));
  for (const [version, state] of [
    [1, "ready"],
    [2, "reserved"],
    [3, "running"],
    [4, "done"],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- each put is the next version
    await real.put(id, version, task(id, { state }));
  }
  const rolled = new MemoryQueueStore();
  await rolled.put(id, 0, task(id));
  return { real, rolled };
}

async function routableEntry(deviceId: string): Promise<RegistryView> {
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
    quota: [{ x: 0, h: 10, d: 10, s: "session", at: nowS - 60 }],
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

interface Run {
  readonly relay: TestRelay;
  readonly leader: Leader;
  /** An app's request to the term, answered with its payload. */
  readonly ask: (op: OpName, payload?: unknown) => Promise<unknown>;
  readonly queue: () => Promise<QueueResponse>;
  /** Leads under `term` and waits for its takeover. */
  readonly lead: (term: number) => Promise<void>;
}

async function withLeader(
  store: QueueStore,
  floor: VersionFloor | undefined,
  body: (run: Run) => Promise<void>,
  relay: TestRelay = startTestRelay(TOKEN),
): Promise<void> {
  const replies = new AsyncQueue<Plain>("replies");
  const leader = createLeader({
    selfDeviceId: "self",
    local: noLocalOps,
    store,
    ...(floor === undefined ? {} : { floor }),
    reply: (_to, response) => {
      replies.push(response);
      return Promise.resolve(true);
    },
    resign: () => {},
    tickIntervalMs: 50,
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
  const ask = async (op: OpName, payload: unknown = {}): Promise<unknown> => {
    leader.deliver(
      await seal(key, { to: SCHEDULER_ID, from: APP_ID }, { id: crypto.randomUUID(), ts: Date.now(), op, payload }),
    );
    return (await replies.next()).payload;
  };
  const queue = async (): Promise<QueueResponse> => {
    const reply = parseQueueReply(await ask("queue"));
    if (reply === null || "ok" in reply) throw new Error("not a queue reply");
    return reply;
  };
  const lead = async (term: number): Promise<void> => {
    relay.schedulerTerm = term;
    leader.lead(term);
    await leader.settled();
    relay.setRegistry([await routableEntry("b")]);
  };
  try {
    await body({ relay, leader, ask, queue, lead });
  } finally {
    leader.stop();
    relay.stop();
  }
}

const regressed = (taskId: string, version: number) => ({ taskId, version, reason: "version_regressed" });

/** Nothing can be polled for a spawn that must not happen: the tick runs every 50ms, so this is several passes. */
async function noSpawn(relay: TestRelay): Promise<void> {
  await Bun.sleep(300);
  expect(await queuedRequests(relay)).toEqual([]);
}

describe("a relay serving version 1 of a task finished at version 5", () => {
  test("without a floor, the leader dispatches the finished task again — the attack the floor closes", async () => {
    const { real, rolled } = await finishedAtFive("t-1");
    const store = new RelayStore(real);
    await withLeader(store, undefined, async ({ relay, leader, lead }) => {
      await lead(1);
      store.rolled = rolled;
      leader.onStoreChanged(taskKey("t-1"), 1);
      const spawn = await nextRequest(relay, 5_000);
      expect((await open(key, spawn.env)).payload).toMatchObject({ taskId: "t-1" });
    });
  });

  test("on a refresh, it reads version_regressed and sends no spawn", async () => {
    const { real, rolled } = await finishedAtFive("t-1");
    const store = new RelayStore(real);
    await withLeader(store, VersionFloor.memory(), async ({ relay, leader, lead, queue }) => {
      await lead(1);
      store.rolled = rolled;
      leader.onStoreChanged(taskKey("t-1"), 1);
      await pollUntil(async () => (await queue()).unreadable?.length === 1, "the rolled-back task to read unreadable");
      expect((await queue()).unreadable).toEqual([regressed("t-1", 1)]);
      await noSpawn(relay);
    });
  });

  test("on a new term in the same process, the floor the last term raised still holds", async () => {
    const { real, rolled } = await finishedAtFive("t-1");
    const store = new RelayStore(real);
    await withLeader(store, VersionFloor.memory(), async ({ relay, lead, queue }) => {
      await lead(1);
      store.rolled = rolled;
      await lead(2);
      expect(await queue()).toMatchObject({ tasks: [], unreadable: [regressed("t-1", 1)] });
      await noSpawn(relay);
    });
  });

  test("after a restart, the floor is read back from disk", async () => {
    const path = join(base, "restart.json");
    const { real, rolled } = await finishedAtFive("t-1");
    await withLeader(real, await VersionFloor.open(path), async ({ lead }) => {
      await lead(1);
    });
    await withLeader(rolled, await VersionFloor.open(path), async ({ relay, lead, queue }) => {
      await lead(1);
      expect(await queue()).toMatchObject({ tasks: [], unreadable: [regressed("t-1", 1)] });
      await noSpawn(relay);
    });
  });
});

describe("a relay rolling the pause back", () => {
  const held: PauseHold = { until: "resume", at: 1 };

  test("a missing or older pause, once version 2 was seen, holds the whole queue until a resume", async () => {
    const real = new MemoryQueueStore();
    await real.putPause(0, []);
    await real.putPause(1, [held]);
    const missing = new MemoryQueueStore();
    await missing.put("p-missing", 0, task("p-missing"));
    const older = new MemoryQueueStore();
    await older.putPause(0, []);
    await older.put("p-older", 0, task("p-older"));
    const store = new RelayStore(real);
    await withLeader(store, VersionFloor.memory(), async ({ relay, lead, queue, ask }) => {
      await lead(1);
      for (const [term, rolled] of [
        [2, older],
        [3, missing],
      ] as const) {
        store.rolled = rolled;
        // oxlint-disable-next-line no-await-in-loop -- one term after the other
        await lead(term);
        // oxlint-disable-next-line no-await-in-loop
        expect((await queue()).holds).toEqual([{ until: "resume", at: expect.any(Number) }]);
        // oxlint-disable-next-line no-await-in-loop
        await noSpawn(relay);
      }
      // A person's resume is a write of the leader's own, which the relay cannot forge: it lets the queue go.
      expect(await ask("resume")).toEqual({ holds: [] });
      const spawn = await nextRequest(relay, 5_000);
      expect((await open(key, spawn.env)).payload).toMatchObject({ taskId: "p-missing" });
    });
  });
});

describe("a record that vanishes without the leader deleting it", () => {
  async function vanishing(floor: VersionFloor | undefined, check: (run: Run) => Promise<void>): Promise<void> {
    const store = new MemoryQueueStore();
    await store.put("t-1", 0, task("t-1"));
    await store.put("t-1", 1, task("t-1", { state: "done" }));
    await withLeader(store, floor, async (run) => {
      await run.lead(1);
      expect((await run.queue()).tasks.map((t) => t.id)).toEqual(["t-1"]);
      await store.delete("t-1", 2);
      run.leader.onStoreChanged(taskKey("t-1"), 0);
      await check(run);
    });
  }

  test("is kept as the leader held it, not read as gone", async () => {
    await vanishing(VersionFloor.memory(), async ({ queue }) => {
      await Bun.sleep(200);
      expect((await queue()).tasks.map((t) => t.id)).toEqual(["t-1"]);
    });
  });

  test("without a floor it is dropped", async () => {
    await vanishing(undefined, async ({ queue }) => {
      await pollUntil(async () => (await queue()).tasks.length === 0, "the vanished task to be dropped");
    });
  });
});
