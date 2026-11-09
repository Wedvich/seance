import {
  APP_ID,
  CAPABILITIES,
  appRelayUrl,
  importPsk,
  parseQueueReply,
  RelayClient,
  SCHEDULER_ID,
  seal,
  toBase64,
  type Envelope,
  type MachineInfo,
  type MachineStatus,
  type OpName,
  type Plain,
  type QueueResponse,
  type RegistryView,
} from "@seance/shared";
import { IDLE_MS } from "../src/app-relay.ts";
import type { LocalOps } from "../src/handlers.ts";
import { createLeader, type Leader, type QueueStore, type Task } from "../src/leader.ts";
import type { VersionFloor } from "../src/version-floor.ts";
import { AsyncQueue, startTestRelay, type TestRelay } from "./harness.ts";

/**
 * One scheduler term over the harness relay and a store the test holds, with
 * an app's requests answered in line — for the suites added after
 * leader.test.ts, which keep their own copies of its helpers.
 */

const TOKEN = "term-fixture-bearer";

export const key: CryptoKey = await importPsk(toBase64(new Uint8Array(32).fill(5)));

export const noLocalOps: LocalOps = {
  sessions: () => Promise.reject(new Error("unexpected local sessions")),
  spawn: () => Promise.reject(new Error("unexpected local spawn")),
  despawn: () => Promise.reject(new Error("unexpected local despawn")),
};

export function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    spec: { repo: "github.com/acme/app", mode: "worktree" },
    state: "queued",
    createdAt: Date.now(),
    ...fields,
  };
}

/** A machine the scheduler can route `github.com/acme/app` to, each blob sealed by the machine it describes. */
export async function routableEntry(deviceId: string): Promise<RegistryView> {
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

export interface Run {
  readonly relay: TestRelay;
  readonly leader: Leader;
  /** An app's request to the term, answered with its payload. */
  readonly ask: (op: OpName, payload?: unknown) => Promise<unknown>;
  readonly queue: () => Promise<QueueResponse>;
  /** Leads under `term`, waits for its takeover, then pushes one routable machine, `b`. */
  readonly lead: (term: number) => Promise<void>;
}

/** A leader ticking every 50ms on `store`, floored when `floor` is given; stopped, with its relay, after `body`. */
export async function withLeader(
  store: QueueStore,
  floor: VersionFloor | undefined,
  body: (run: Run) => Promise<void>,
): Promise<void> {
  const relay = startTestRelay(TOKEN);
  const replies = new AsyncQueue<Plain>("replies");
  const leader = createLeader({
    selfDeviceId: "self",
    pushSubject: "https://relay.test",
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
