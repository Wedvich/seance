import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Machine, RelayState, RequestOp, SpawnRequest } from "@seance/shared";
import { pollUntil } from "../test/fixtures.ts";
import { appRelayUrl, buildMcpServer, LazyRelay, resolveMachine, type AppRelay } from "./mcp.ts";

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    deviceId: "device-1",
    name: "MacBook Pro",
    platform: "darwin",
    repos: [{ name: "seance", path: "/repos/seance", defaultBranch: "main" }],
    scannedAt: 1_000,
    lastSeen: 2_000,
    connected: true,
    ...overrides,
  };
}

interface FakeRelay extends AppRelay {
  requests: { deviceId: string; op: RequestOp; payload: unknown }[];
  stopped: boolean;
  setState: (next: Partial<RelayState>) => void;
}

function fakeRelay(
  machines: readonly Machine[],
  respond: (op: RequestOp, payload: unknown) => unknown = () => ({}),
  status: RelayState["status"] = "open",
): FakeRelay {
  let state: RelayState = {
    status,
    rejection: status === "rejected" ? "unauthorized" : null,
    machines,
    registrySize: machines.length,
    hidden: [],
    ignored: 0,
    settling: false,
  };
  const listeners = new Set<() => void>();
  const fake: FakeRelay = {
    requests: [],
    stopped: false,
    setState: (next) => {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
    start: () => {},
    stop: () => {
      fake.stopped = true;
    },
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request: <T>(deviceId: string, op: RequestOp, payload: unknown): Promise<T> => {
      fake.requests.push({ deviceId, op, payload });
      const reply = respond(op, payload);
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve(reply as T);
    },
  };
  return fake;
}

async function connectedClient(relay: LazyRelay): Promise<Client> {
  // Pinned, not auto: a fallback to the 2025 era would pass silently, and the
  // point of pinning is that these tests prove the modern era is served. That
  // requires serving through the same entry the daemon uses — serveStdio with
  // an injected transport — because a bare server.connect() is 2025-era only.
  const client = new Client(
    { name: "test", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serveStdio(() => buildMcpServer(relay), { transport: serverTransport });
  await client.connect(clientTransport);
  return client;
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text: string }[];
  return content.map((entry) => entry.text).join("\n");
}

describe("appRelayUrl", () => {
  test("swaps the daemon path for the app path, keeping the rest of the URL", () => {
    expect(appRelayUrl("wss://relay.example.workers.dev/daemon")).toBe("wss://relay.example.workers.dev/app");
  });

  test("leaves a URL without the daemon suffix alone rather than guessing", () => {
    expect(appRelayUrl("wss://relay.example.dev/other")).toBe("wss://relay.example.dev/other");
  });
});

describe("resolveMachine", () => {
  const machines = [
    machine(),
    machine({ deviceId: "device-2", name: "homelab" }),
    machine({ deviceId: "device-3", name: "twin" }),
    machine({ deviceId: "device-4", name: "Twin" }),
  ];

  test("resolves a name case-insensitively", () => {
    const result = resolveMachine(machines, "macbook pro");
    expect("machine" in result && result.machine.deviceId).toBe("device-1");
  });

  test("a deviceId is an exact-match escape hatch", () => {
    const result = resolveMachine(machines, "device-2");
    expect("machine" in result && result.machine.name).toBe("homelab");
  });

  test("an ambiguous name lists the colliding deviceIds", () => {
    const result = resolveMachine(machines, "twin");
    expect("error" in result && result.error).toContain("device-3");
    expect("error" in result && result.error).toContain("device-4");
  });

  test("a miss lists the known machines so the caller can self-correct", () => {
    const result = resolveMachine(machines, "nope");
    expect("error" in result && result.error).toContain("homelab");
  });
});

describe("LazyRelay", () => {
  test("does not dial until the first acquire, and shares one client after", async () => {
    let created = 0;
    const lazy = new LazyRelay({
      create: () => {
        created += 1;
        return fakeRelay([machine()]);
      },
      settleMs: 10,
    });
    expect(created).toBe(0);
    const [a, b] = await Promise.all([lazy.acquire(), lazy.acquire()]);
    expect(created).toBe(1);
    expect(a).toBe(b);
    lazy.stop();
  });

  test("hangs up after the idle window and redials on the next call", async () => {
    const fakes: FakeRelay[] = [];
    const lazy = new LazyRelay({
      create: () => {
        const fake = fakeRelay([machine()]);
        fakes.push(fake);
        return fake;
      },
      idleMs: 20,
      settleMs: 10,
    });
    await lazy.acquire();
    lazy.release();
    await pollUntil(() => fakes[0]?.stopped === true, "the idle timer to stop the client");
    await lazy.acquire();
    expect(fakes).toHaveLength(2);
    lazy.stop();
  });

  test("a rejected token surfaces as an error instead of a silent retry loop", async () => {
    const lazy = new LazyRelay({ create: () => fakeRelay([], () => ({}), "rejected"), settleMs: 10 });
    await expect(lazy.acquire()).rejects.toThrow("bearer token");
  });

  test("a relay that never answers fails the call instead of riding the backoff forever", async () => {
    const lazy = new LazyRelay({
      create: () => fakeRelay([], () => ({}), "connecting"),
      connectTimeoutMs: 30,
      settleMs: 10,
    });
    await expect(lazy.acquire()).rejects.toThrow("did not answer");
  });

  test("stop() during a pending connect stops the dialing client instead of adopting it", async () => {
    let fake: FakeRelay | undefined;
    const lazy = new LazyRelay({
      create: () => {
        fake = fakeRelay([machine()], () => ({}), "connecting");
        return fake;
      },
      settleMs: 10,
    });
    const pending = lazy.acquire();
    lazy.stop();
    fake?.setState({ status: "open" });
    await expect(pending).rejects.toThrow("stopped");
    expect(fake?.stopped).toBe(true);
  });
});

describe("mcp tools", () => {
  test("list_machines reports the registry with ISO times and repo names", async () => {
    const lazy = new LazyRelay({ create: () => fakeRelay([machine()]), settleMs: 10 });
    const client = await connectedClient(lazy);
    const result = await client.callTool({ name: "list_machines", arguments: {} });
    const listed = JSON.parse(toolText(result)) as Record<string, unknown>[];
    expect(listed).toEqual([
      {
        name: "MacBook Pro",
        deviceId: "device-1",
        platform: "darwin",
        connected: true,
        lastSeen: new Date(2_000).toISOString(),
        repos: ["seance"],
      },
    ]);
    lazy.stop();
  });

  test("get_sessions resolves the machine by name and returns its sessions", async () => {
    const sessions = [{ window: "fix-bug", repo: "seance", path: "/repos/seance" }];
    const fake = fakeRelay([machine()], (op) => (op === "sessions" ? { sessions, at: 3_000 } : {}));
    const lazy = new LazyRelay({ create: () => fake, settleMs: 10 });
    const client = await connectedClient(lazy);
    const result = await client.callTool({ name: "get_sessions", arguments: { machine: "MacBook Pro" } });
    expect(JSON.parse(toolText(result))).toEqual(sessions);
    expect(fake.requests[0]?.deviceId).toBe("device-1");
    lazy.stop();
  });

  test("spawn_session tags the request as the mcp client and reports the window", async () => {
    const fake = fakeRelay([machine()], () => ({ ok: true, window: "task", path: "/repos/seance", sessions: [] }));
    const lazy = new LazyRelay({ create: () => fake, settleMs: 10 });
    const client = await connectedClient(lazy);
    const result = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "MacBook Pro", repo: "seance", prompt: "do the thing" },
    });
    expect(result.isError).toBeFalsy();
    expect(toolText(result)).toContain("spawned window task on MacBook Pro");
    const request = fake.requests[0]?.payload as SpawnRequest;
    expect(request.client).toBe("mcp");
    expect(request.mode).toBe("worktree");
    lazy.stop();
  });

  test("spawn_session refuses an offline machine with its last-seen time", async () => {
    const fake = fakeRelay([machine({ connected: false })]);
    const lazy = new LazyRelay({ create: () => fake, settleMs: 10 });
    const client = await connectedClient(lazy);
    const result = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "MacBook Pro", repo: "seance" },
    });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("not connected");
    expect(fake.requests).toHaveLength(0);
    lazy.stop();
  });

  test("spawn_session answers an unknown repo with the machine's repo list, without a round trip", async () => {
    const fake = fakeRelay([machine()]);
    const lazy = new LazyRelay({ create: () => fake, settleMs: 10 });
    const client = await connectedClient(lazy);
    const result = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "MacBook Pro", repo: "nope" },
    });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain('no repo named "nope"');
    expect(toolText(result)).toContain("seance");
    expect(fake.requests).toHaveLength(0);
    lazy.stop();
  });

  test("a structured spawn failure surfaces its code and message", async () => {
    const fake = fakeRelay([machine()], () => ({ ok: false, code: "claude_died", message: "pane died" }));
    const lazy = new LazyRelay({ create: () => fake, settleMs: 10 });
    const client = await connectedClient(lazy);
    const result = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "MacBook Pro", repo: "seance" },
    });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("claude_died");
    lazy.stop();
  });
});
