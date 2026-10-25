import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { RequestOp, Task } from "@seance/shared";
import { LazyRelay } from "../src/app-relay.ts";
import { createBroker, type Broker } from "../src/broker.ts";
import { brokerFleet, relayFleet, selectFleet, type Fleet } from "../src/fleet.ts";
import { startLocalSocket, type LocalSocketHandle } from "../src/local-socket.ts";
import { buildMcpServer, type LocalMachine } from "../src/mcp.ts";
import type { AuditSink } from "../src/audit.ts";
import { fakeRelay, machine, type FakeRelay } from "./fake-app-relay.ts";

/**
 * The MCP tools over both fleet transports, side by side: the direct path
 * (this process holds the key) and the broker (it holds none and asks the
 * daemon over the real op socket). Same calls, same relay double underneath —
 * the outputs and the requests the target sees must not tell them apart, a spawn's
 * enqueue, `get_queue` and `cancel_task` included.
 */

const LOCAL = machine();
// A build and an update report, so the parity check covers the broker carrying them.
const ORIGIN = "github.com/m/seance";
const TASK_ID = "11111111-2222-4333-8444-555555555555";
const QUEUED: Task = { id: TASK_ID, spec: { repo: ORIGIN, mode: "worktree" }, state: "ready", createdAt: 4_000 };
// An exclave, capabilities, a status and an origin on its repo: what `auto` places by and `list_machines` shows.
const REMOTE = machine({
  deviceId: "device-2",
  name: "Linux Box",
  repos: [{ name: "seance", path: "/repos/seance", defaultBranch: "main", origin: ORIGIN, exclave: "work" }],
  exclaves: [
    { id: "work", accountId: "org-a:me", email: "me@x.no", extraUsageEnabled: null, authOk: true, skills: [] },
  ],
  capabilities: ["taskId", "reportedDone", "pinAccount"],
  status: { at: 5, scan: 1_000 },
  source: { sha: "c".repeat(40), commitTs: 1_700_000_000_000, branch: null },
  lastUpdate: { at: 1_700_000_100_000, outcome: "fetch_failed" },
});
const ASLEEP = machine({ deviceId: "device-3", name: "Sleeper", connected: false });

function respond(op: RequestOp): unknown {
  if (op === "queue") return { tasks: [QUEUED], at: 6_000 };
  if (op === "cancel") return { task: { ...QUEUED, state: "cancelled" } };
  if (op === "sessions")
    return { sessions: [{ id: "%3", window: "task", repo: "seance", path: "/repos/seance" }], at: 5 };
  return { ok: true, window: "task", outcome: "exited", sessions: [] };
}

let base: string;
let socket: LocalSocketHandle;
let broker: Broker;
const relays: FakeRelay[] = [];
const localCalls: RequestOp[] = [];

const local: LocalMachine = {
  deviceId: LOCAL.deviceId,
  name: LOCAL.name,
  platform: "darwin",
  repos: () => Promise.resolve(LOCAL.repos),
  request: <T>(op: RequestOp): Promise<T> => {
    localCalls.push(op);
    // The test names T; this stands in for the op socket's wire.
    const reply =
      op === "sessions" ? { sessions: [{ id: "%1", window: "here", repo: "seance", path: "/p" }], at: 1 } : {};
    return Promise.resolve(reply as T);
  },
  reachable: () => Promise.resolve(true),
};

function relayDouble(leader = false, into: FakeRelay[] = relays): LazyRelay {
  return new LazyRelay({
    create: () => {
      const fake = fakeRelay([LOCAL, REMOTE, ASLEEP], respond);
      if (leader) fake.setState({ scheduler: { kind: "ready", deviceId: REMOTE.deviceId, term: 1 } });
      into.push(fake);
      return fake;
    },
  });
}

/** `audit` stands in for the log an `auto` enqueue would otherwise append to: never the developer's own. */
async function connect(
  fleet: Fleet,
  audit: AuditSink = () => {},
): Promise<(name: string, args?: Record<string, unknown>) => Promise<string>> {
  const client = new Client(
    { name: "test", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serveStdio(() => buildMcpServer(fleet, local, audit), { transport: serverTransport });
  await client.connect(clientTransport);
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { text: string }[];
    return `${result.isError === true ? "ERROR " : ""}${content.map((entry) => entry.text).join("\n")}`;
  };
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-mcpb-"));
  broker = createBroker({ selfDeviceId: LOCAL.deviceId, relay: relayDouble(), auditSink: () => {} });
  socket = await startLocalSocket({
    path: join(base, "seanced.sock"),
    handle: () => Promise.reject(new Error("no Plain op belongs on this socket in these tests")),
    broker: broker.handle,
  });
});

afterAll(async () => {
  socket.stop();
  broker.stop();
  await rm(base, { recursive: true, force: true });
});

function brokerOnly(path: string): Fleet {
  return selectFleet({
    key: () => Promise.resolve(null),
    direct: () => {
      throw new Error("this process has no key");
    },
    broker: brokerFleet({ path }),
  });
}

describe("the MCP tools, direct and brokered", () => {
  test("produce the same output and the same requests at the target", async () => {
    const path = socket.path;
    if (path === null) throw new Error("the op socket did not bind");
    const direct = await connect(relayFleet(relayDouble()));
    const brokered = await connect(
      selectFleet({
        key: () => Promise.resolve(null),
        direct: () => {
          throw new Error("this process has no key");
        },
        broker: brokerFleet({ path }),
      }),
    );

    const script: [string, Record<string, unknown>][] = [
      ["list_machines", {}],
      ["get_sessions", { machine: "Linux Box" }],
      ["despawn_session", { machine: "device-2", id: "%3", force: true }],
      // A spawn is a scheduler enqueue now; the refusal comes before anything is stored.
      ["spawn_session", { machine: "nowhere", repo: "seance" }],
      ["get_sessions", { machine: "nowhere" }],
    ];
    for (const [name, args] of script) {
      // oxlint-disable-next-line no-await-in-loop -- one tool call per transport, compared pairwise
      const [a, b] = [await direct(name, args), await brokered(name, args)];
      expect(b).toBe(a);
    }
    // Two relay doubles, one per transport, created in call order (direct goes
    // first): the target saw the same requests, `client: "mcp"` included,
    // whichever process sealed them.
    const [directRelay, brokerRelay] = [relays[0], relays[1]];
    expect(brokerRelay?.requests).toEqual(directRelay?.requests ?? []);
    // No spawn op reaches the target: the tools never spawn directly.
    expect(directRelay?.requests.some((entry) => entry.op === "spawn")).toBe(false);
  });

  test("the broker marks the same scheduler leader the direct path does, and shows the same exclaves", async () => {
    // Its own broker and socket: both relay doubles here nominate REMOTE with a verified proof.
    const leaderBroker = createBroker({ selfDeviceId: LOCAL.deviceId, relay: relayDouble(true), auditSink: () => {} });
    const leaderSocket = await startLocalSocket({
      path: join(base, "leader.sock"),
      handle: () => Promise.reject(new Error("no Plain op belongs on this socket in these tests")),
      broker: leaderBroker.handle,
    });
    try {
      const path = leaderSocket.path;
      if (path === null) throw new Error("the op socket did not bind");
      const direct = await connect(relayFleet(relayDouble(true)));
      const brokered = await connect(brokerOnly(path));
      const viaRelay = await direct("list_machines");
      const viaBroker = await brokered("list_machines");
      expect(viaBroker).toBe(viaRelay);
      const marked = JSON.parse(viaBroker) as { name: string; scheduler?: string; exclaves?: unknown[] }[];
      const remote = marked.find((entry) => entry.name === REMOTE.name);
      expect(remote?.scheduler).toBe("leader");
      expect(remote?.exclaves).toHaveLength(1);
    } finally {
      leaderSocket.stop();
      leaderBroker.stop();
    }
  });

  test("auto, queue_batch, get_queue and cancel_task: the same answers, the same stored tasks, the same audit — direct or brokered", async () => {
    const directRelays: FakeRelay[] = [];
    const brokerRelays: FakeRelay[] = [];
    const brokerLines: string[] = [];
    const leaderBroker = createBroker({
      selfDeviceId: LOCAL.deviceId,
      relay: relayDouble(true, brokerRelays),
      auditSink: (line) => void brokerLines.push(line),
    });
    const leaderSocket = await startLocalSocket({
      path: join(base, "auto.sock"),
      handle: () => Promise.reject(new Error("no Plain op belongs on this socket in these tests")),
      broker: leaderBroker.handle,
    });
    try {
      const path = leaderSocket.path;
      if (path === null) throw new Error("the op socket did not bind");
      const directAudit: string[] = [];
      const brokeredAudit: string[] = [];
      const direct = await connect(relayFleet(relayDouble(true, directRelays)), (line) => void directAudit.push(line));
      const brokered = await connect(brokerOnly(path), (line) => void brokeredAudit.push(line));

      const script: [string, Record<string, unknown>][] = [
        ["spawn_session", { machine: "auto", repo: "seance", prompt: "fix it", title: "Fix it" }],
        ["spawn_session", { machine: "auto", repo: "seance", prompt: "pinned", pin: { machine: "Linux Box" } }],
        ["spawn_session", { machine: "auto", repo: "seance", prompt: "pinned", pin: { account: "me@x.no" } }],
        ["spawn_session", { machine: "auto", repo: "seance", prompt: "avoiding", avoid: ["MacBook Pro"] }],
        ["spawn_session", { machine: "Linux Box", repo: "seance", prompt: "named", plan: true }],
        [
          "queue_batch",
          {
            strategy: "auto",
            tasks: [
              { repo: "seance", prompt: "a" },
              { repo: "seance", prompt: "b" },
            ],
          },
        ],
        ["get_queue", {}],
        ["cancel_task", { taskId: TASK_ID }],
      ];
      // Ids are minted per process and `createdAt` is each side's clock, so they are masked, not compared.
      const masked = (text: string): string =>
        text
          .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "<id>")
          .replaceAll(/createdAt=\d+/gu, "createdAt=<ms>");
      for (const [name, args] of script) {
        // oxlint-disable-next-line no-await-in-loop -- one tool call per transport, compared pairwise
        const [a, b] = [await direct(name, args), await brokered(name, args)];
        expect(masked(b)).toBe(masked(a));
        expect(a).not.toStartWith("ERROR");
      }
      // Task and batch ids are minted per process; the spec is what must match.
      const stored = (relay: FakeRelay | undefined): string[] =>
        (relay?.creates ?? []).map((created) => masked(JSON.stringify({ ...created, createdAt: 0 })));
      expect(stored(brokerRelays[0])).toEqual(stored(directRelays[0]));
      expect(stored(directRelays[0])).toHaveLength(7);
      expect(brokerRelays[0]?.requests.map((sent) => [sent.op, sent.payload])).toEqual(
        directRelays[0]?.requests.map((sent) => [sent.op, sent.payload]) ?? [],
      );
      // The surface's own line is the same on both; the daemon adds its own beside it.
      expect(brokeredAudit.map(masked)).toEqual(directAudit.map(masked));
      expect(brokeredAudit.every((line) => line.startsWith("audit enqueue origin=mcp client=mcp "))).toBe(true);
      expect(
        brokerLines.filter((line) => line.startsWith("audit enqueue origin=local-broker claimed_client=mcp ")),
      ).toHaveLength(7);
      expect([...brokerLines, ...brokeredAudit].join("\n")).not.toContain("fix it");
    } finally {
      leaderSocket.stop();
      leaderBroker.stop();
    }
  });

  test("a self-targeted call takes the local op path on both, with no relay and no broker", async () => {
    const path = socket.path;
    if (path === null) throw new Error("the op socket did not bind");
    let brokerOpened = 0;
    const brokered = await connect(
      selectFleet({
        key: () => Promise.reject(new Error("a local op must not look for a key")),
        direct: () => {
          throw new Error("unreachable");
        },
        broker: {
          open: () => {
            brokerOpened += 1;
            return brokerFleet({ path }).open();
          },
          stop: () => {},
        },
      }),
    );
    localCalls.length = 0;
    expect(await brokered("get_sessions", { machine: "MacBook Pro" })).toContain('"window": "here"');
    expect(localCalls).toEqual(["sessions"]);
    expect(brokerOpened).toBe(0);
  });

  test("the brokered path writes nothing to stdout, which is the MCP server's JSON-RPC channel", async () => {
    const path = socket.path;
    if (path === null) throw new Error("the op socket did not bind");
    const brokered = await connect(
      selectFleet({
        key: () => Promise.resolve(null),
        direct: () => brokerFleet({ path }),
        broker: brokerFleet({ path }),
      }),
    );
    const write = spyOn(process.stdout, "write");
    const log = spyOn(console, "log");
    try {
      await brokered("list_machines");
      await brokered("get_sessions", { machine: "Linux Box" });
      await brokered("despawn_session", { machine: "Linux Box", id: "%3" });
      await brokered("spawn_session", { machine: "auto", repo: "seance", prompt: "no stdout please" });
      await brokered("get_queue");
      expect(write).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      log.mockRestore();
    }
  });
});
