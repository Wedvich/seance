import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { RepoEntry, RequestOp, SpawnRequest } from "@seance/shared";
import { fakeRelay, machine } from "../test/fake-app-relay.ts";
import { LazyRelay } from "./app-relay.ts";
import { BrokerError } from "./broker-client.ts";
import { relayFleet, selectFleet, type Fleet } from "./fleet.ts";
import { LocalUnavailable } from "./local-client.ts";
import { buildMcpServer, isLocalRef, mcpBunPath, resolveMachine, type LocalMachine } from "./mcp.ts";

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
    repos: () => Promise.resolve([{ name: "seance", path: "/repos/seance", defaultBranch: "main" }]),
    requests,
    request: <T>(op: RequestOp, payload: unknown): Promise<T> => {
      requests.push({ op, payload });
      return Promise.resolve(respond(op, payload) as T);
    },
    reachable: () => Promise.resolve(true),
    ...overrides,
  };
}

/** A bare `LazyRelay` is the direct transport, which is what most of these tests drive. */
async function connectedClient(relay: LazyRelay | Fleet, local: LocalMachine | null = null): Promise<Client> {
  const fleet = relay instanceof LazyRelay ? relayFleet(relay) : relay;
  // Pinned, not auto: a fallback to the 2025 era would pass silently, and the
  // point of pinning is that these tests prove the modern era is served. That
  // requires serving through the same entry the daemon uses — serveStdio with
  // an injected transport — because a bare server.connect() is 2025-era only.
  const client = new Client(
    { name: "test", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serveStdio(() => buildMcpServer(fleet, local), { transport: serverTransport });
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
      throw new LocalUnavailable("no daemon listening at /run/seanced.sock (ENOENT)");
    });
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy, local);

    const result = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "MacBook Pro", repo: "seance" },
    });
    expect(result.isError).toBe(true);
    // The remediation is attached here, not baked into the thrown message, so it
    // reads the same for a socket that closed mid-request as for one never there.
    expect(toolText(result)).toContain("no daemon listening at /run/seanced.sock (ENOENT)");
    expect(toolText(result)).toContain("is seanced running? try `seanced status`");
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

  test("a repo cloned after the MCP server started is spawnable without a restart", async () => {
    // `seanced mcp` outlives many rescans, so the repo set is read per call. A
    // snapshot taken at startup rejects this spawn with no way to recover short
    // of restarting the process — `rescan` is deliberately not a local op.
    let repos: RepoEntry[] = [{ name: "seance", path: "/repos/seance", defaultBranch: "main" }];
    const local = fakeLocal(() => ({ ok: true, window: "w", path: "/repos/fresh", sessions: [] }), {
      repos: () => Promise.resolve(repos),
    });
    const lazy = new LazyRelay({ create: () => fakeRelay([machine()]) });
    const client = await connectedClient(lazy, local);

    const before = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "MacBook Pro", repo: "fresh" },
    });
    expect(before.isError).toBe(true);
    expect(local.requests).toHaveLength(0);

    repos = [...repos, { name: "fresh", path: "/repos/fresh", defaultBranch: "main" }];
    const after = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "MacBook Pro", repo: "fresh" },
    });
    expect(after.isError).toBeFalsy();
    expect(local.requests).toHaveLength(1);
    lazy.stop();
  });

  test("an empty repo set defers to the daemon rather than denying every spawn", async () => {
    // What a process started before the daemon's first scan landed sees. Denying
    // on it would reject every local repo until the MCP server was restarted.
    const local = fakeLocal(() => ({ ok: true, window: "w", path: "/repos/seance", sessions: [] }), {
      repos: () => Promise.resolve([]),
    });
    const lazy = new LazyRelay({ create: () => fakeRelay([machine()]) });
    const client = await connectedClient(lazy, local);

    const result = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "MacBook Pro", repo: "seance" },
    });
    expect(result.isError).toBeFalsy();
    expect(local.requests).toHaveLength(1);
    lazy.stop();
  });

  test("a handler that failed reads as an error, not an empty session list", async () => {
    // `ErrorResponse` is what a throwing handler answers with; neither client
    // treats it as a failure, so an unchecked reply renders as `undefined`.
    const failure = { ok: false, code: "internal_error", message: "tmux is not installed" };
    for (const via of ["local", "relay"] as const) {
      const local = via === "local" ? fakeLocal(() => failure) : null;
      const lazy = new LazyRelay({ create: () => fakeRelay([machine()], () => failure) });
      const client = await connectedClient(lazy, local);
      const result = await client.callTool({ name: "get_sessions", arguments: { machine: "MacBook Pro" } });
      expect(result.isError).toBe(true);
      expect(toolText(result)).toContain("tmux is not installed");
      lazy.stop();
    }
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
    const listed = JSON.parse(toolText(result)) as {
      machines: { name: string; local: boolean; connected: boolean }[];
      note: string;
    };
    expect(listed.machines).toEqual([expect.objectContaining({ local: true, connected: true })]);
    expect(listed.note).toContain("only local spawns will work");
    lazy.stop();
  });

  test("relay and daemon both down on the direct path: this machine is listed, but not as spawnable", async () => {
    const lazy = new LazyRelay({ create: () => fakeRelay([], () => ({}), "rejected") });
    const client = await connectedClient(lazy, fakeLocal(undefined, { reachable: () => Promise.resolve(false) }));
    const listed = JSON.parse(toolText(await client.callTool({ name: "list_machines", arguments: {} }))) as {
      machines: { local: boolean; connected: boolean }[];
      note: string;
    };
    expect(listed.machines).toEqual([expect.objectContaining({ local: true, connected: false })]);
    expect(listed.note).toContain("relay is unreachable");
    expect(listed.note).toContain("nothing will spawn until seanced is running");
    expect(listed.note).not.toContain("only local spawns will work");
    lazy.stop();
  });

  test("no PSK and no daemon: every op fails, and nothing claims local ones still work", async () => {
    // A credential-delivered box whose daemon is down. The broker and the local
    // op path share one socket, so neither answers — and the advice must not send
    // the model off to spawn locally, which fails for the same reason.
    const local = fakeLocal(undefined, {
      request: () => Promise.reject(new LocalUnavailable("no daemon listening at /run/s.sock (ENOENT)")),
      reachable: () => Promise.resolve(false),
    });
    let lookups = 0;
    const fleet = selectFleet({
      key: () => {
        lookups += 1;
        return Promise.resolve(null);
      },
      direct: () => {
        throw new Error("no key, so no direct path");
      },
      broker: {
        open: () =>
          Promise.reject(new BrokerError("daemon_unreachable", "no daemon listening at /run/s.sock (ENOENT)")),
        stop: () => {},
      },
    });
    const client = await connectedClient(fleet, local);

    const localResult = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "MacBook Pro", repo: "seance" },
    });
    expect(localResult.isError).toBe(true);
    expect(toolText(localResult)).toContain("is seanced running?");
    // Local work never even asks for a key.
    expect(lookups).toBe(0);

    const remoteResult = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "Linux Box", repo: "seance" },
    });
    expect(remoteResult.isError).toBe(true);
    expect(toolText(remoteResult)).toContain("no PSK");
    expect(toolText(remoteResult)).toContain("is seanced running?");
    expect(toolText(remoteResult)).toContain("fail too");
    expect(toolText(remoteResult)).not.toContain("needs neither");

    const listed = JSON.parse(toolText(await client.callTool({ name: "list_machines", arguments: {} }))) as {
      machines: { local: boolean; connected: boolean }[];
      note: string;
    };
    expect(listed.machines).toEqual([expect.objectContaining({ local: true, connected: false })]);
    expect(listed.note).toContain("no daemon listening");
    expect(listed.note).toContain("fail too");
    expect(listed.note).not.toContain("only local spawns will work");
    // The advice already names the fix; the note must not say it twice.
    expect(listed.note.split("seanced status").length).toBe(2);
  });

  test("list_machines takes the broker's word on the local daemon rather than probing it again", async () => {
    // The daemon answered the broker moments ago on the socket local ops use; a
    // second probe racing a restart must not contradict that in the same answer.
    let probes = 0;
    const local = fakeLocal(undefined, {
      reachable: () => {
        probes += 1;
        return Promise.resolve(false);
      },
    });
    const fleet = selectFleet({
      key: () => Promise.resolve(null),
      direct: () => {
        throw new Error("no key, so no direct path");
      },
      broker: {
        open: () => Promise.reject(new BrokerError("relay_unavailable", "relay said no")),
        stop: () => {},
      },
    });
    const client = await connectedClient(fleet, local);
    const listed = JSON.parse(toolText(await client.callTool({ name: "list_machines", arguments: {} }))) as {
      machines: { local: boolean; connected: boolean }[];
      note: string;
    };
    expect(listed.machines).toEqual([expect.objectContaining({ local: true, connected: true })]);
    expect(listed.note).toContain("needs neither");
    expect(probes).toBe(0);
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

describe("despawn_session", () => {
  test("reaches a remote machine through the relay, tagged as the mcp client, and reports the outcome", async () => {
    const fake = fakeRelay([machine()], () => ({ ok: true, window: "task", outcome: "exited", sessions: [] }));
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const result = await client.callTool({ name: "despawn_session", arguments: { machine: "MacBook Pro", id: "%12" } });
    expect(result.isError).toBeFalsy();
    expect(toolText(result)).toBe("exited task on MacBook Pro");
    expect(fake.requests[0]?.op).toBe("despawn");
    // Nobody asked for force, so it must not ride along.
    expect(fake.requests[0]?.payload).toEqual({ id: "%12", client: "mcp" });
    lazy.stop();
  });

  test("a self-targeted despawn goes to the daemon on this box and never dials the relay", async () => {
    const fake = fakeRelay([machine()]);
    const local = fakeLocal(() => ({ ok: true, window: "task", outcome: "killed", sessions: [] }));
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy, local);
    const result = await client.callTool({
      name: "despawn_session",
      arguments: { machine: "MacBook Pro", id: "%12", force: true },
    });
    expect(toolText(result)).toBe("killed task on MacBook Pro");
    expect(local.requests).toEqual([{ op: "despawn", payload: { id: "%12", client: "mcp", force: true } }]);
    expect(fake.requests).toHaveLength(0);
    lazy.stop();
  });

  test("a structured failure surfaces its code, so the model knows to fetch a fresh id", async () => {
    const local = fakeLocal(() => ({ ok: false, code: "session_not_found", message: "no session in pane %12" }));
    const lazy = new LazyRelay({ create: () => fakeRelay([machine()]) });
    const client = await connectedClient(lazy, local);
    const result = await client.callTool({ name: "despawn_session", arguments: { machine: "MacBook Pro", id: "%12" } });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("despawn failed (session_not_found)");
    lazy.stop();
  });
});
