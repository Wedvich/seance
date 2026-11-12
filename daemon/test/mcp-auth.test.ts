import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { CAPABILITIES, type RequestOp, type Task } from "@seance/shared";
import { LazyRelay } from "../src/app-relay.ts";
import { relayFleet } from "../src/fleet.ts";
import { buildMcpServer, type LocalMachine } from "../src/mcp.ts";
import { fakeRelay, machine } from "./fake-app-relay.ts";

/**
 * What the MCP tools say about a login (`list_machines`' per-exclave `auth`) and about a task the leader
 * holds no slot for (`get_queue`'s `away` and `idle`), over the direct path; mcp-broker.test.ts holds the
 * broker's output to the direct one.
 */

const exclave = (id: string, accountId: string | null) => ({
  id,
  accountId,
  extraUsageEnabled: null,
  authOk: accountId !== null,
  skills: [],
});

const nowS = Math.floor(Date.now() / 1000);
const BOX = machine({
  deviceId: "device-2",
  name: "Linux Box",
  capabilities: [CAPABILITIES.authHealth],
  exclaves: [
    exclave("default", "org-a:one"),
    exclave("work", "org-a:two"),
    exclave("soon", "org-a:three"),
    exclave("fresh", "org-a:four"),
    exclave("out", null),
  ],
  status: { at: nowS, scan: 1, ax: [0], ae: [[2, nowS + 2 * 24 * 3600]], au: [3] },
});
const OLDER = machine({
  deviceId: "device-3",
  name: "Older",
  exclaves: [exclave("default", "org-a:five")],
  status: { at: nowS, scan: 1, ax: [0] },
});
const ASLEEP = machine({ deviceId: "device-4", name: "Sleeper", connected: false });

const target = { deviceId: "device-4", exclave: "default", clone: "/r/seance" };
const task = (id: string, state: Task["state"], extra: Partial<Task> = {}): Task => ({
  id,
  spec: { repo: "github.com/m/seance", mode: "worktree" },
  state,
  createdAt: 4_000,
  ...extra,
});
const TASKS: Task[] = [
  task("away-running", "running", { assignment: target }),
  task("away-ready", "ready"),
  task("away-lost", "lost", { assignment: target }),
  task("here-idle", "running", { assignment: { ...target, deviceId: "device-2" } }),
  task("here-busy", "running", { assignment: { ...target, deviceId: "device-2" } }),
];

function respond(op: RequestOp): unknown {
  if (op === "queue") return { tasks: TASKS, at: 6_000, idle: [{ taskId: "here-idle", since: 5_000 }] };
  return {};
}

const local: LocalMachine = {
  deviceId: "device-1",
  name: "MacBook Pro",
  platform: "darwin",
  repos: () => Promise.resolve([]),
  request: <T>(): Promise<T> => Promise.resolve({} as T),
  reachable: () => Promise.resolve(true),
};

async function call(name: string): Promise<string> {
  const relay = new LazyRelay({
    create: () => {
      const fake = fakeRelay([machine(), BOX, OLDER, ASLEEP], respond);
      fake.setState({ scheduler: { kind: "ready", deviceId: BOX.deviceId, term: 1 } });
      return fake;
    },
  });
  const client = new Client(
    { name: "test", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serveStdio(() => buildMcpServer(relayFleet(relay), local, () => {}), { transport: serverTransport });
  await client.connect(clientTransport);
  const result = await client.callTool({ name, arguments: {} });
  const content = result.content as { text: string }[];
  expect(result.isError).not.toBe(true);
  return content.map((entry) => entry.text).join("\n");
}

describe("list_machines: a login", () => {
  test("each signed-in exclave says expired, expiring (with when), ok or unknown; an older daemon's say unknown", async () => {
    const listed = JSON.parse(await call("list_machines")) as {
      name: string;
      exclaves?: { id: string; auth?: string; loginExpiresAt?: string }[];
    }[];
    const box = listed.find((entry) => entry.name === BOX.name);
    expect(box?.exclaves?.map((e) => [e.id, e.auth])).toEqual([
      ["default", "expired"],
      ["work", "ok"],
      ["soon", "expiring"],
      ["fresh", "unknown"],
      ["out", undefined],
    ]);
    const soon = box?.exclaves?.find((e) => e.id === "soon");
    expect(Date.parse(soon?.loginExpiresAt ?? "")).toBe((nowS + 2 * 24 * 3600) * 1000);
    expect(box?.exclaves?.filter((e) => e.loginExpiresAt !== undefined)).toHaveLength(1);

    // No capability: "not listed" means nothing, so a lapse in its status is not claimed.
    const older = listed.find((entry) => entry.name === OLDER.name);
    expect(older?.exclaves?.map((e) => e.auth)).toEqual(["unknown"]);
  });
});

describe("get_queue: away and idle", () => {
  test("a task in flight on a machine that is not connected is away, one the leader released is idle, and the rest are neither", async () => {
    const queue = JSON.parse(await call("get_queue")) as { tasks: { id: string; away?: true; idle?: true }[] };
    const marks = Object.fromEntries(queue.tasks.map((t) => [t.id, [t.away, t.idle]]));
    expect(marks).toEqual({
      "away-running": [true, undefined],
      "away-ready": [undefined, undefined],
      // `lost` already says so: the leader released it, and it is not "away".
      "away-lost": [undefined, undefined],
      "here-idle": [undefined, true],
      "here-busy": [undefined, undefined],
    });
  });
});
