import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Machine, RelayState, RequestOp, SpawnRequest } from "@seance/shared";
import { pollUntil } from "../test/fixtures.ts";
import { LocalUnavailable } from "./local-client.ts";
import {
  buildMcpServer,
  isLocalRef,
  LazyRelay,
  mcpBunPath,
  resolveMachine,
  type AppRelay,
  type LocalMachine,
} from "./mcp.ts";

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
    skewed: 0,
    settling: false,
    registrySettled: status === "open",
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

interface FakeLocal extends LocalMachine {
  requests: { op: RequestOp; payload: unknown }[];
}

function fakeLocal(
  respond: (op: RequestOp, payload: unknown) => unknown = () => ({}),
  overrides: Partial<LocalMachine> = {},
): FakeLocal {
  const requests: { op: RequestOp; payload: unknown }[] = [];
  return {
    deviceId: "device-1",
    name: "MacBook Pro",
    platform: "darwin",
    repos: [{ name: "seance", path: "/repos/seance", defaultBranch: "main" }],
    requests,
    request: <T>(op: RequestOp, payload: unknown): Promise<T> => {
      requests.push({ op, payload });
      return Promise.resolve(respond(op, payload) as T);
    },
    ...overrides,
  };
}

async function connectedClient(relay: LazyRelay, local: LocalMachine | null = null): Promise<Client> {
  // Pinned, not auto: a fallback to the 2025 era would pass silently, and the
  // point of pinning is that these tests prove the modern era is served. That
  // requires serving through the same entry the daemon uses — serveStdio with
  // an injected transport — because a bare server.connect() is 2025-era only.
  const client = new Client(
    { name: "test", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serveStdio(() => buildMcpServer(relay, local), { transport: serverTransport });
  await client.connect(clientTransport);
  return client;
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text: string }[];
  return content.map((entry) => entry.text).join("\n");
}

describe("mcpBunPath", () => {
  test("reads the Command: line out of `claude mcp get` output", () => {
    const output = [
      "seance:",
      "  Scope: User config (available in all your projects)",
      "  Status: ✔ Connected",
      "  Type: stdio",
      "  Command: /opt/homebrew/bin/bun",
      "  Args: /repos/seance/daemon/src/main.ts mcp",
      "",
      "To remove this server, run: claude mcp remove seance -s user",
    ].join("\n");
    expect(mcpBunPath(output)).toBe("/opt/homebrew/bin/bun");
  });

  test("output without a Command line is null, not a finding", () => {
    expect(mcpBunPath("seance:\n  Type: http\n")).toBeNull();
    expect(mcpBunPath("")).toBeNull();
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
    });
    await lazy.acquire();
    lazy.release();
    await pollUntil(() => fakes[0]?.stopped === true, "the idle timer to stop the client");
    await lazy.acquire();
    expect(fakes).toHaveLength(2);
    lazy.stop();
  });

  test("a rejected token surfaces as an error instead of a silent retry loop", async () => {
    const lazy = new LazyRelay({ create: () => fakeRelay([], () => ({}), "rejected") });
    await expect(lazy.acquire()).rejects.toThrow("bearer token");
  });

  test("a relay that never answers fails the call instead of riding the backoff forever", async () => {
    const lazy = new LazyRelay({
      create: () => fakeRelay([], () => ({}), "connecting"),
      connectTimeoutMs: 30,
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
    });
    const pending = lazy.acquire();
    lazy.stop();
    fake?.setState({ status: "open", registrySettled: true });
    await expect(pending).rejects.toThrow("stopped");
    expect(fake?.stopped).toBe(true);
  });
});

describe("mcp tools", () => {
  test("list_machines reports the registry with ISO times and repo names", async () => {
    const lazy = new LazyRelay({ create: () => fakeRelay([machine()]) });
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
        local: false,
      },
    ]);
    lazy.stop();
  });

  test("get_sessions resolves the machine by name and returns its sessions", async () => {
    const sessions = [{ window: "fix-bug", repo: "seance", path: "/repos/seance" }];
    const fake = fakeRelay([machine()], (op) => (op === "sessions" ? { sessions, at: 3_000 } : {}));
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const result = await client.callTool({ name: "get_sessions", arguments: { machine: "MacBook Pro" } });
    expect(JSON.parse(toolText(result))).toEqual(sessions);
    expect(fake.requests[0]?.deviceId).toBe("device-1");
    lazy.stop();
  });

  test("spawn_session tags the request as the mcp client and reports the window", async () => {
    const fake = fakeRelay([machine()], () => ({ ok: true, window: "task", path: "/repos/seance", sessions: [] }));
    const lazy = new LazyRelay({ create: () => fake });
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
    // Nobody asked for plan mode, so the field must not ride along and flip it on.
    expect(request.plan).toBeUndefined();
    lazy.stop();
  });

  test("spawn_session forwards plan mode when the caller asks for it", async () => {
    const fake = fakeRelay([machine()], () => ({ ok: true, window: "task", path: "/repos/seance", sessions: [] }));
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const result = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "MacBook Pro", repo: "seance", prompt: "plan the thing", plan: true },
    });
    expect(result.isError).toBeFalsy();
    const request = fake.requests[0]?.payload as SpawnRequest;
    expect(request.plan).toBe(true);
    lazy.stop();
  });

  test("spawn_session refuses an offline machine with its last-seen time", async () => {
    const fake = fakeRelay([machine({ connected: false })]);
    const lazy = new LazyRelay({ create: () => fake });
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
    const lazy = new LazyRelay({ create: () => fake });
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
    const lazy = new LazyRelay({ create: () => fake });
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

describe("isLocalRef", () => {
  const local = fakeLocal();

  test("matches this machine by name, case-insensitively, and by deviceId exactly", () => {
    expect(isLocalRef(local, "MacBook Pro")).toBe(true);
    expect(isLocalRef(local, "macbook pro")).toBe(true);
    expect(isLocalRef(local, "device-1")).toBe(true);
  });

  test("does not match another machine", () => {
    expect(isLocalRef(local, "Linux Box")).toBe(false);
    expect(isLocalRef(local, "device-2")).toBe(false);
  });
});

describe("the local short circuit", () => {
  test("a self-targeted spawn goes to the daemon on this box and never dials the relay", async () => {
    const fake = fakeRelay([machine()]);
    const local = fakeLocal(() => ({ ok: true, window: "task", path: "/repos/seance", sessions: [] }));
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy, local);

    const result = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "MacBook Pro", repo: "seance", prompt: "do it" },
    });

    expect(toolText(result)).toContain("spawned window task on MacBook Pro");
    expect(local.requests).toHaveLength(1);
    expect(local.requests[0]?.op).toBe("spawn");
    // Stamped for the audit trail on this path too — the daemon renders it as
    // `origin=local client="mcp"`.
    expect((local.requests[0]?.payload as SpawnRequest | undefined)?.client).toBe("mcp");
    // The relay was never touched: no request, and no socket dialed.
    expect(fake.requests).toHaveLength(0);
    lazy.stop();
  });

  test("a self-targeted get_sessions answers locally", async () => {
    const sessions = [{ window: "fix-bug", repo: "seance", path: "/repos/seance" }];
    const fake = fakeRelay([machine()]);
    const local = fakeLocal(() => ({ sessions, at: 3_000 }));
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy, local);

    const result = await client.callTool({ name: "get_sessions", arguments: { machine: "device-1" } });
    expect(JSON.parse(toolText(result))).toEqual(sessions);
    expect(local.requests[0]?.op).toBe("sessions");
    expect(fake.requests).toHaveLength(0);
    lazy.stop();
  });

  test("a remote target still goes through the relay", async () => {
    const remote = machine({ deviceId: "device-2", name: "Linux Box" });
    const fake = fakeRelay([machine(), remote], () => ({
      ok: true,
      window: "task",
      path: "/repos/seance",
      sessions: [],
    }));
    const local = fakeLocal();
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy, local);

    await client.callTool({ name: "spawn_session", arguments: { machine: "Linux Box", repo: "seance" } });
    expect(fake.requests[0]?.deviceId).toBe("device-2");
    expect(local.requests).toHaveLength(0);
    lazy.stop();
  });

  test("a remote machine sharing this one's name loses to local; its deviceId still reaches it", async () => {
    const twin = machine({ deviceId: "device-2", name: "MacBook Pro" });
    const fake = fakeRelay([machine(), twin], () => ({
      ok: true,
      window: "task",
      path: "/repos/seance",
      sessions: [],
    }));
    const local = fakeLocal(() => ({ ok: true, window: "task", path: "/repos/seance", sessions: [] }));
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy, local);

    // By name: local wins, where `resolveMachine` would have refused as ambiguous.
    await client.callTool({ name: "spawn_session", arguments: { machine: "MacBook Pro", repo: "seance" } });
    expect(local.requests).toHaveLength(1);
    expect(fake.requests).toHaveLength(0);

    // By deviceId: the escape hatch reaches the twin.
    await client.callTool({ name: "spawn_session", arguments: { machine: "device-2", repo: "seance" } });
    expect(local.requests).toHaveLength(1);
    expect(fake.requests[0]?.deviceId).toBe("device-2");
    lazy.stop();
  });

  test("no local daemon reports that, rather than silently paying a round trip", async () => {
    const fake = fakeRelay([machine()]);
    const local = fakeLocal(() => {
      throw new LocalUnavailable("no daemon listening at /run/seanced.sock — is seanced running?");
    });
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy, local);

    const result = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "MacBook Pro", repo: "seance" },
    });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("is seanced running");
    expect(fake.requests).toHaveLength(0);
    lazy.stop();
  });

  test("an unknown repo on the local machine answers with the candidates", async () => {
    const local = fakeLocal();
    const lazy = new LazyRelay({ create: () => fakeRelay([machine()]) });
    const client = await connectedClient(lazy, local);

    const result = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "MacBook Pro", repo: "nope" },
    });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("its repos: seance");
    expect(local.requests).toHaveLength(0);
    lazy.stop();
  });

  test("list_machines marks which entry is this box", async () => {
    const remote = machine({ deviceId: "device-2", name: "Linux Box" });
    const lazy = new LazyRelay({ create: () => fakeRelay([machine(), remote]) });
    const client = await connectedClient(lazy, fakeLocal());
    const listed = JSON.parse(toolText(await client.callTool({ name: "list_machines", arguments: {} }))) as {
      name: string;
      local: boolean;
    }[];
    expect(listed.map((entry) => [entry.name, entry.local])).toEqual([
      ["MacBook Pro", true],
      ["Linux Box", false],
    ]);
    lazy.stop();
  });

  test("an unreachable relay still lists this machine, so a keyless box is not blind", async () => {
    const lazy = new LazyRelay({ create: () => fakeRelay([], () => ({}), "rejected") });
    const client = await connectedClient(lazy, fakeLocal());
    const result = await client.callTool({ name: "list_machines", arguments: {} });
    const listed = JSON.parse(toolText(result)) as { machines: { name: string; local: boolean }[]; note: string };
    expect(listed.machines).toHaveLength(1);
    expect(listed.machines[0]?.local).toBe(true);
    expect(listed.note).toContain("only local spawns will work");
    lazy.stop();
  });

  test("no resolvable PSK still serves local ops; only a remote one pays the error", async () => {
    // What `runMcpServer` does on a box whose key is only ever delivered to the
    // daemon's systemd unit: creating the relay client is what throws, and it is
    // deferred to first remote use.
    const local = fakeLocal(() => ({ ok: true, window: "task", path: "/repos/seance", sessions: [] }));
    const lazy = new LazyRelay({
      create: () => {
        throw new Error("no PSK — fill the psk field in config.json or run `seanced psk-import`");
      },
    });
    const client = await connectedClient(lazy, local);

    const localResult = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "MacBook Pro", repo: "seance" },
    });
    expect(localResult.isError).toBeUndefined();
    expect(toolText(localResult)).toContain("spawned window task");

    const remoteResult = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "Linux Box", repo: "seance" },
    });
    expect(remoteResult.isError).toBe(true);
    expect(toolText(remoteResult)).toContain("no PSK");
    lazy.stop();
  });

  test("with no local machine at all, every target is remote", async () => {
    const fake = fakeRelay([machine()], () => ({ ok: true, window: "t", path: "/p", sessions: [] }));
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy, null);
    await client.callTool({ name: "spawn_session", arguments: { machine: "MacBook Pro", repo: "seance" } });
    expect(fake.requests[0]?.deviceId).toBe("device-1");
    lazy.stop();
  });
});
