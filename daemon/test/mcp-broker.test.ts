import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { RequestFailure, type RequestOp } from "@seance/shared";
import { LazyRelay } from "../src/app-relay.ts";
import { createBroker, type Broker } from "../src/broker.ts";
import { brokerFleet, relayFleet, selectFleet, type Fleet } from "../src/fleet.ts";
import { startLocalSocket, type LocalSocketHandle } from "../src/local-socket.ts";
import { buildMcpServer, type LocalMachine } from "../src/mcp.ts";
import { fakeRelay, machine, type FakeRelay } from "./fake-app-relay.ts";

/**
 * The four MCP tools over both fleet transports, side by side: the direct path
 * (this process holds the key) and the broker (it holds none and asks the
 * daemon over the real op socket). Same calls, same relay double underneath —
 * the outputs and the requests the target sees must not tell them apart.
 */

const LOCAL = machine();
// A build and an update report, so the parity check covers the broker carrying them.
const REMOTE = machine({
  deviceId: "device-2",
  name: "Linux Box",
  source: { sha: "c".repeat(40), commitTs: 1_700_000_000_000, branch: null },
  lastUpdate: { at: 1_700_000_100_000, outcome: "fetch_failed" },
});
const ASLEEP = machine({ deviceId: "device-3", name: "Sleeper", connected: false });

let failNextSpawn = false;
function respond(op: RequestOp): unknown {
  if (op === "sessions")
    return { sessions: [{ id: "%3", window: "task", repo: "seance", path: "/repos/seance" }], at: 5 };
  if (op === "spawn" && failNextSpawn) {
    failNextSpawn = false;
    return new RequestFailure("timeout", "spawn timed out after 90000ms");
  }
  if (op === "spawn") return { ok: true, window: "task", path: "/repos/seance", sessions: [] };
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
    return Promise.resolve({ ok: true, window: "here", path: "/repos/seance", sessions: [] } as T);
  },
  reachable: () => Promise.resolve(true),
};

function relayDouble(leader = false): LazyRelay {
  return new LazyRelay({
    create: () => {
      const fake = fakeRelay([LOCAL, REMOTE, ASLEEP], respond);
      if (leader) fake.setState({ scheduler: { kind: "ready", deviceId: REMOTE.deviceId, term: 1 } });
      relays.push(fake);
      return fake;
    },
  });
}

async function connect(fleet: Fleet): Promise<(name: string, args?: Record<string, unknown>) => Promise<string>> {
  const client = new Client(
    { name: "test", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serveStdio(() => buildMcpServer(fleet, local), { transport: serverTransport });
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
      ["spawn_session", { machine: "Linux Box", repo: "seance", prompt: "fix it", plan: true }],
      ["despawn_session", { machine: "device-2", id: "%3", force: true }],
      ["spawn_session", { machine: "Sleeper", repo: "seance" }],
      ["spawn_session", { machine: "Linux Box", repo: "nope" }],
      ["get_sessions", { machine: "nowhere" }],
    ];
    for (const [name, args] of script) {
      // oxlint-disable-next-line no-await-in-loop -- one tool call per transport, compared pairwise
      const [a, b] = [await direct(name, args), await brokered(name, args)];
      expect(b).toBe(a);
    }
    // A timeout must read as "may have landed" on both paths, in the same words.
    failNextSpawn = true;
    const directTimeout = await direct("spawn_session", { machine: "Linux Box", repo: "seance" });
    failNextSpawn = true;
    const brokeredTimeout = await brokered("spawn_session", { machine: "Linux Box", repo: "seance" });
    expect(brokeredTimeout).toBe(directTimeout);
    expect(brokeredTimeout).toContain("may have landed anyway");

    // Two relay doubles, one per transport, created in call order (direct goes
    // first): the target saw the same requests, `client: "mcp"` included,
    // whichever process sealed them.
    const [directRelay, brokerRelay] = [relays[0], relays[1]];
    expect(brokerRelay?.requests).toEqual(directRelay?.requests ?? []);
    expect(directRelay?.requests.find((entry) => entry.op === "spawn")?.payload).toMatchObject({
      client: "mcp",
      plan: true,
    });
  });

  test("the broker never marks a scheduler leader, even when the relay behind it has a ready one", async () => {
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
      const brokered = await connect(
        selectFleet({
          key: () => Promise.resolve(null),
          direct: () => {
            throw new Error("this process has no key");
          },
          broker: brokerFleet({ path }),
        }),
      );
      const marked = JSON.parse(await direct("list_machines")) as { name: string; scheduler?: string }[];
      expect(marked.find((entry) => entry.name === REMOTE.name)?.scheduler).toBe("leader");
      const unmarked = JSON.parse(await brokered("list_machines")) as { scheduler?: string }[];
      expect(unmarked.some((entry) => "scheduler" in entry)).toBe(false);
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
        key: () => Promise.reject(new Error("a local spawn must not look for a key")),
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
    expect(await brokered("spawn_session", { machine: "MacBook Pro", repo: "seance" })).toContain(
      "spawned window here",
    );
    expect(localCalls).toEqual(["spawn"]);
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
      await brokered("spawn_session", { machine: "Linux Box", repo: "seance" });
      expect(write).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      log.mockRestore();
    }
  });
});
