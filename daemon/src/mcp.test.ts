import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  QUEUE_MAX_TASKS,
  RequestFailure,
  SCHEDULER_ID,
  TASK_FAILURE_LIMITS,
  TASK_REQUEST_LIMITS,
  taskFailureText,
  type Decision,
  type Machine,
  type RepoEntry,
  type RequestOp,
  type SpawnRequest,
  type Task,
  type TaskRequest,
} from "@seance/shared";
import { fakeRelay, machine, type FakeRelay } from "../test/fake-app-relay.ts";
import { LazyRelay } from "./app-relay.ts";
import { BrokerError } from "./broker-client.ts";
import { relayFleet, selectFleet, type Fleet } from "./fleet.ts";
import { LocalUnavailable } from "./local-client.ts";
import {
  buildMcpServer,
  decisionText,
  isLocalRef,
  resolveOrigin,
  type McpServerOpts,
  mcpBunPath,
  mcpScriptCheck,
  mcpScriptPath,
  resolveMachine,
  type LocalMachine,
} from "./mcp.ts";

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
async function connectedClient(
  relay: LazyRelay | Fleet,
  local: LocalMachine | null = null,
  opts: McpServerOpts = {},
): Promise<Client> {
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
  serveStdio(() => buildMcpServer(fleet, local, opts), { transport: serverTransport });
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

describe("mcpScriptPath", () => {
  test("reads the script out of the Args: line, without the subcommand", () => {
    expect(mcpScriptPath("  Command: /opt/homebrew/bin/bun\n  Args: /repos/seance/daemon/src/main.ts mcp\n")).toBe(
      "/repos/seance/daemon/src/main.ts",
    );
    expect(mcpScriptPath("  Args: /My Repos/seance/daemon/src/main.ts mcp\n")).toBe(
      "/My Repos/seance/daemon/src/main.ts",
    );
  });

  test("output without an Args line ending in mcp is null, not a finding", () => {
    expect(mcpScriptPath("seance:\n  Type: http\n")).toBeNull();
    expect(mcpScriptPath("  Args: /repos/seance/daemon/src/main.ts serve\n")).toBeNull();
  });
});

describe("mcpScriptCheck", () => {
  let base = "";
  afterAll(async () => {
    if (base !== "") await rm(base, { recursive: true, force: true });
  });

  /** A checkout's main.ts, realpath'd as `resolvedMain()` returns it, plus a symlink to the checkout. */
  const checkout = async (): Promise<{ readonly main: string; readonly linked: string }> => {
    base = await realpath(await mkdtemp(join(tmpdir(), "seance-mcp-script-")));
    const src = join(base, "seance", "daemon", "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "main.ts"), "");
    await symlink(join(base, "seance"), join(base, "linked"));
    return { main: join(src, "main.ts"), linked: join(base, "linked", "daemon", "src", "main.ts") };
  };

  test("an entry running this checkout is fine, even through a symlinked path", async () => {
    const { main, linked } = await checkout();
    expect(await mcpScriptCheck(main, "default", main)).toBeNull();
    expect(await mcpScriptCheck(linked, "default", main)).toBeNull();
  });

  test("an entry running another clone warns, naming the exclave, both paths and the remedy", async () => {
    const { main } = await checkout();
    const other = "/Users/someone/pengefix2/seance/daemon/src/main.ts";
    const check = await mcpScriptCheck(other, "pengefix2", main);
    expect(check?.level).toBe("warn");
    expect(check?.message).toContain("(pengefix2)");
    expect(check?.message).toContain(other);
    expect(check?.message).toContain(main);
    expect(check?.message).toContain("`seanced mcp install` repoints it");
  });

  test("no parsable script is no finding", async () => {
    expect(await mcpScriptCheck(null, "default", "/x/daemon/src/main.ts")).toBeNull();
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

  test("a handler that failed, or a reply too large to send, reads as an error, not an empty session list", async () => {
    // `ErrorResponse` is what a throwing handler answers with, and what the
    // transport sends in place of an oversized reply; neither client treats it
    // as a failure, so an unchecked reply renders as `undefined`.
    const failures = [
      { ok: false, code: "internal_error", message: "tmux is not installed" },
      { ok: false, code: "too_large", message: "reply would seal to 70000 chars, over 65536" },
    ];
    for (const failure of failures) {
      for (const via of ["local", "relay"] as const) {
        const local = via === "local" ? fakeLocal(() => failure) : null;
        const lazy = new LazyRelay({ create: () => fakeRelay([machine()], () => failure) });
        const client = await connectedClient(lazy, local);
        const result = await client.callTool({ name: "get_sessions", arguments: { machine: "MacBook Pro" } });
        expect(result.isError).toBe(true);
        expect(toolText(result)).toBe(`get_sessions failed (${failure.code}): ${failure.message}`);
        lazy.stop();
      }
    }
  });

  test("a spawn answered too_large may have run, and says to look before retrying", async () => {
    const failure = { ok: false, code: "too_large", message: "reply would seal to 70000 chars, over 65536" };
    const lazy = new LazyRelay({ create: () => fakeRelay([machine()]) });
    const client = await connectedClient(
      lazy,
      fakeLocal(() => failure),
    );
    const result = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "MacBook Pro", repo: "seance" },
    });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("check get_sessions");
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

const ORIGIN = "github.com/m/seance";
const LEADING = { kind: "ready", deviceId: "device-1", term: 3 } as const;
/** Short enough that a test following a task never waits on the clock. */
const FAST: McpServerOpts = { autoFollow: { intervalMs: 1, polls: 5 } };

function autoMachines(): Machine[] {
  return [
    machine({
      deviceId: "device-1",
      name: "MacBook Pro",
      repos: [{ name: "seance", path: "/repos/seance", defaultBranch: "main", origin: ORIGIN }],
    }),
    machine({
      deviceId: "device-2",
      name: "Linux Box",
      repos: [{ name: "seance", path: "/src/seance", defaultBranch: "main", origin: ORIGIN }],
    }),
  ];
}

const decision: Decision = {
  at: 5_000,
  chosen: { deviceId: "device-2", exclave: "work", clone: "seance" },
  candidates: [
    {
      deviceId: "device-2",
      machine: "Linux Box",
      exclave: "work",
      clone: "seance",
      rejected: [],
      score: {
        components: { accountPressure: 0.1, machinePressure: 0.2, dependencyDistance: 0, queuePressure: 0 },
        sticky: 0,
        total: 0.3,
      },
    },
    { deviceId: "device-1", machine: "MacBook Pro", exclave: "default", rejected: [{ code: "auth_missing" }] },
  ],
};

function task(overrides: Partial<Task> = {}): Task {
  return { id: "t-1", spec: { repo: ORIGIN, mode: "worktree" }, state: "ready", createdAt: 4_000, ...overrides };
}

describe("decisionText", () => {
  test("a record the leader cut says how many candidates it left out, after the ones it kept", () => {
    expect(decisionText({ ...decision, candidates: decision.candidates.slice(0, 1), trimmed: 3 })).toBe(
      "chose Linux Box/work (lowest score, 0.30); 3 more candidates not shown",
    );
    expect(decisionText({ ...decision, trimmed: 1 })).toBe(
      "chose Linux Box/work (lowest score, 0.30); MacBook Pro/default: not signed in; 1 more candidate not shown",
    );
    expect(decisionText({ at: 5_000, chosen: null, candidates: [], trimmed: 4 })).toBe(
      "no candidate can take it now; 4 more candidates not shown",
    );
  });
});

const running = task({
  state: "running",
  decision,
  assignment: { deviceId: "device-2", exclave: "work", clone: "seance", window: "fix-it" },
});

/**
 * A relay with a verified leader: `submit` answers from `onSubmit`, and each
 * `queue` from `queues` in turn, the last one repeating.
 */
function leaderRelay(
  onSubmit: () => unknown,
  queues: readonly unknown[] = [],
  machines: readonly Machine[] = autoMachines(),
): ReturnType<typeof fakeRelay> {
  let polled = 0;
  const fake = fakeRelay(machines, (op) => {
    if (op === "submit") return onSubmit();
    if (op === "queue") return queues[Math.min(polled++, queues.length - 1)] ?? { tasks: [], at: 6_000 };
    return new Error(`unexpected ${op}`);
  });
  fake.setState({ scheduler: LEADING });
  return fake;
}

async function callAuto(
  fake: ReturnType<typeof fakeRelay>,
  args: Record<string, unknown> = {},
): Promise<{ text: string; error: boolean }> {
  const lazy = new LazyRelay({ create: () => fake });
  const client = await connectedClient(lazy, null, FAST);
  try {
    const result = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "auto", repo: "seance", prompt: "fix it", ...args },
    });
    return { text: toolText(result), error: result.isError === true };
  } finally {
    lazy.stop();
  }
}

describe("resolveOrigin", () => {
  test("an origin passes as itself, and a clone name maps to the one origin behind it", () => {
    expect(resolveOrigin(autoMachines(), ORIGIN)).toEqual({ origin: ORIGIN });
    expect(resolveOrigin(autoMachines(), "seance")).toEqual({ origin: ORIGIN });
  });

  test("a clone name behind two origins is ambiguous, and the error names each with its machines", () => {
    const machines = [
      ...autoMachines(),
      machine({
        deviceId: "device-3",
        name: "Work",
        repos: [{ name: "seance", path: "/w/seance", defaultBranch: "main", origin: "github.com/fork/seance" }],
      }),
    ];
    const resolved = resolveOrigin(machines, "seance");
    if (!("error" in resolved)) throw new Error("expected an error");
    expect(resolved.error).toContain('"seance" names clones of more than one repo');
    expect(resolved.error).toContain(`${ORIGIN} (on MacBook Pro, Linux Box)`);
    expect(resolved.error).toContain("github.com/fork/seance (on Work)");
  });

  test("an unknown name lists the known origins, and says when an older daemon has a clone by that name", () => {
    const machines = [
      ...autoMachines(),
      machine({ deviceId: "device-3", name: "Old", repos: [{ name: "legacy", path: "/l", defaultBranch: "main" }] }),
    ];
    expect(resolveOrigin(machines, "nope")).toEqual({
      error: `no repo "nope" for auto — known origins: ${ORIGIN}`,
    });
    const legacy = resolveOrigin(machines, "legacy");
    if (!("error" in legacy)) throw new Error("expected an error");
    expect(legacy.error).toContain("Old has a clone by that name, but its daemon reports no origin");
  });
});

describe("spawn_session on auto", () => {
  test("submits the origin to the scheduler, follows it to its machine, and reports where and why", async () => {
    const fake = leaderRelay(
      () => ({ task: task() }),
      [
        { tasks: [task({ decision })], at: 6_000 },
        { tasks: [running], at: 7_000 },
      ],
    );
    const stdout = spyOn(console, "log");
    try {
      const { text, error } = await callAuto(fake, { title: "Fix it", mode: "here", model: "", plan: true });
      expect(error).toBe(false);
      expect(text).toContain("task t-1: running on Linux Box (exclave work, clone seance, window fix-it)");
      expect(text).toContain("decision: chose Linux Box/work (lowest score, 0.30); MacBook Pro/default: not signed in");
      expect(text).toContain("get_sessions on Linux Box lists it with taskId t-1");
      // Nothing reachable from `seanced mcp` writes to stdout: it is the JSON-RPC channel.
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
    const [submit, ...polls] = fake.requests;
    expect(submit?.deviceId).toBe(SCHEDULER_ID);
    expect(submit?.op).toBe("submit");
    // A TaskRequest carries no `client` — the leader stamps its own dispatch — and an empty model means default.
    expect(submit?.payload).toEqual({
      repo: ORIGIN,
      mode: "here",
      prompt: "fix it",
      title: "Fix it",
      plan: true,
    } satisfies TaskRequest);
    expect(polls.map((r) => r.op)).toEqual(["queue", "queue"]);
    // The scheduler places it; this process never spawned on a machine itself.
    expect(fake.requests.some((r) => r.op === "spawn")).toBe(false);
  });

  test("a task no machine can take yet answers at once, saying it waits in the relay's queue", async () => {
    const waiting = task({ decision: { at: 5_000, chosen: null, candidates: decision.candidates.slice(1) } });
    const fake = leaderRelay(() => ({ task: task() }), [{ tasks: [waiting], at: 6_000 }]);
    const { text, error } = await callAuto(fake);
    expect(error).toBe(false);
    expect(text).toContain(
      "task t-1: ready\ndecision: no candidate can take it now; MacBook Pro/default: not signed in",
    );
    expect(text).toContain("it waits in the relay's queue for capacity, and survives a leader change");
    expect(fake.requests.filter((r) => r.op === "queue")).toHaveLength(1);
  });

  test("a task that leaves the queue before it is placed names a mixed-fleet leader, not a cancel or a prune", async () => {
    const fake = leaderRelay(() => ({ task: task() }), [{ tasks: [], at: 6_000 }]);
    const { text, error } = await callAuto(fake);
    expect(error).toBe(true);
    expect(text).toContain("left the queue before it was placed");
    expect(text).toContain("a leader still running an older seanced took over");
    // A cancelled task stays visible and only a finished one is pruned, so neither can be the cause.
    expect(text).not.toMatch(/cancelled|pruned/u);
  });

  test("a task pushed out of a full queue view is not reported as dropped", async () => {
    const newer = Array.from({ length: QUEUE_MAX_TASKS }, (_, i) => task({ id: `n-${i}`, createdAt: 9_000 + i }));
    const fake = leaderRelay(() => ({ task: task() }), [{ tasks: newer, at: 6_000 }]);
    const { text, error } = await callAuto(fake);
    expect(error).toBe(false);
    expect(text).not.toContain("left the queue");
    expect(text).toContain("pushed it out of the queue's view");
  });

  test("a task whose session already ended is not sent to get_sessions", async () => {
    const fake = leaderRelay(() => ({ task: { ...running, state: "done" } }));
    const { text } = await callAuto(fake);
    expect(text).toContain("Its session on Linux Box has already ended.");
    expect(text).not.toContain("get_sessions on Linux Box lists it");
  });

  test("a spawn the target refused reads as an error, with its code", async () => {
    const failed = task({ state: "failed", decision, failure: { code: "repo_not_found", message: "no such repo" } });
    const fake = leaderRelay(() => ({ task: task() }), [{ tasks: [failed], at: 6_000 }]);
    const { text, error } = await callAuto(fake);
    expect(error).toBe(true);
    expect(text).toContain("failure (repo_not_found): no such repo");
  });

  test("a failure the scheduler set leads with its shared wording and keeps the specifics", async () => {
    const failure = { code: "dependency_cycle", message: "its dependencies loop: t-1 → t-2 → t-1" };
    const failed = task({ state: "failed", decision, failure });
    const fake = leaderRelay(() => ({ task: task() }), [{ tasks: [failed], at: 6_000 }]);
    const { text, error } = await callAuto(fake);
    expect(error).toBe(true);
    expect(text).toContain(`failure (dependency_cycle): ${taskFailureText("dependency_cycle")} (${failure.message})`);
  });

  test("a prompt over the scheduler's bound is refused here, before anything dials the relay", async () => {
    const fake = leaderRelay(() => ({ task: task() }));
    const prompt = "x".repeat(TASK_REQUEST_LIMITS.prompt + 1);
    const { text, error } = await callAuto(fake, { prompt });
    expect(error).toBe(true);
    expect(text).toBe(
      `auto refused: the prompt is ${prompt.length} characters; auto takes at most ${TASK_REQUEST_LIMITS.prompt} — shorten it (the session can gather the rest with tools), or name a machine`,
    );
    expect(fake.started).toBe(0);
  });

  test("an ambiguous repo is refused with the candidates, and nothing is submitted", async () => {
    const machines = [
      ...autoMachines(),
      machine({
        deviceId: "device-3",
        name: "Work",
        repos: [{ name: "seance", path: "/w", defaultBranch: "main", origin: "github.com/fork/seance" }],
      }),
    ];
    const fake = leaderRelay(() => ({ task: task() }), [], machines);
    const { text, error } = await callAuto(fake);
    expect(error).toBe(true);
    expect(text).toContain("pass the origin instead");
    expect(fake.requests).toEqual([]);
  });

  test("no leader and an unverified leader are worded as unavailable, and nothing is sent", async () => {
    for (const scheduler of [{ kind: "none" }, { kind: "unverified", deviceId: "device-9", term: 2 }] as const) {
      const fake = leaderRelay(() => ({ task: task() }));
      fake.setState({ scheduler });
      // oxlint-disable-next-line no-await-in-loop -- one fake each
      const { text, error } = await callAuto(fake);
      expect(error).toBe(true);
      expect(text).toStartWith("auto unavailable: ");
      expect(text).toContain("name a machine instead");
      expect(fake.requests).toEqual([]);
    }
  });

  test("the leader's refusals are worded; a transport code shows the leader's message, never 'may have queued'", async () => {
    const cases = [
      [{ ok: false, code: "not_ready", message: "taking over" }, "still taking over", "auto failed (not_ready): "],
      [
        { ok: false, code: "queue_full", message: "64" },
        "as many unfinished tasks as it will take",
        "auto failed (queue_full): ",
      ],
      // The leader's transport refused the reply to a submit that had stored its task.
      [
        { ok: false, code: "too_large", message: "big" },
        "the task was queued, but the leader's answer was too large to send — check get_queue",
        "auto: ",
      ],
      [
        { ok: false, code: "internal_error", message: "Error: task t9 was not stored (store_full)" },
        "Error: task t9 was not stored (store_full) — the leader's message says whether the task was stored — if it does not, check get_queue",
        "auto failed (internal_error): ",
      ],
      [
        { ok: false, code: "internal_error", message: "Error: task t9 may have been stored: the store went away" },
        "Error: task t9 may have been stored: the store went away",
        "auto failed (internal_error): ",
      ],
    ] as const;
    for (const [reply, wording, start] of cases) {
      const fake = leaderRelay(() => reply);
      // oxlint-disable-next-line no-await-in-loop -- one fake each
      const { text, error } = await callAuto(fake);
      expect(error).toBe(true);
      expect(text).toStartWith(start);
      expect(text).toContain(wording);
      expect(text).not.toContain("may have queued");
    }
  });

  test("a leader's long, multi-line message is cut to one bounded line", async () => {
    const message = `Error: first line\n${"x".repeat(2000)}\r\n\tat stack frame\u2028end`;
    const { text, error } = await callAuto(leaderRelay(() => ({ ok: false, code: "internal_error", message })));
    expect(error).toBe(true);
    expect(text).not.toMatch(/[\n\r\t\u2028]/u);
    expect(text).toContain("Error: first line xxx");
    expect(text).not.toContain("x".repeat(TASK_FAILURE_LIMITS.message + 1));
    expect(text).not.toContain("stack frame");
  });

  test("a lost reply may have queued: it says to look before retrying, and never submits twice", async () => {
    const fake = leaderRelay(() => new RequestFailure("timeout", "no reply within 10000ms"));
    const { text, error } = await callAuto(fake);
    expect(error).toBe(true);
    expect(text).toBe(
      "auto: no answer from the scheduler (no reply within 10000ms) — the task may have queued anyway — check get_queue and get_sessions before retrying",
    );
    expect(fake.requests.filter((r) => r.op === "submit")).toHaveLength(1);
  });

  test("a socket closing after the send may have queued; one closed before it never left", async () => {
    const dropped = await callAuto(leaderRelay(() => new RequestFailure("dropped", "the relay socket closed")));
    expect(dropped.text).toContain(
      "auto: no answer from the scheduler (the relay socket closed) — the task may have queued",
    );
    const unsent = await callAuto(leaderRelay(() => new RequestFailure("disconnected", "no socket to the relay")));
    expect(unsent.text).toBe("auto failed: lost the relay connection before the request went out");
  });

  test("through the broker auto is refused outright — nothing goes to the broker or any machine", async () => {
    const sent: string[] = [];
    const fleet = selectFleet({
      key: () => Promise.resolve(null),
      direct: () => {
        throw new Error("no key, so no direct path");
      },
      broker: {
        open: () =>
          Promise.resolve({
            machines: autoMachines(),
            request: <T>(deviceId: string, op: string): Promise<T> => {
              sent.push(`${op}@${deviceId}`);
              return Promise.reject(new Error("must not be sent"));
            },
            scheduler: null,
            release: () => {},
          }),
        stop: () => {},
      },
    });
    const client = await connectedClient(fleet, fakeLocal(), FAST);
    const spawned = await client.callTool({ name: "spawn_session", arguments: { machine: "auto", repo: "seance" } });
    expect(spawned.isError).toBe(true);
    expect(toolText(spawned)).toBe(
      "auto needs this machine's own key; unavailable through the broker — name a machine instead (list_machines)",
    );
    const queue = await client.callTool({ name: "get_queue", arguments: {} });
    expect(queue.isError).toBe(true);
    expect(toolText(queue)).toBe("get_queue needs this machine's own key; unavailable through the broker");
    expect(sent).toEqual([]);
  });

  test("auto beats a local machine named auto, which stays reachable by deviceId", async () => {
    const local = fakeLocal(() => ({ ok: true, window: "w", path: "/repos/seance", sessions: [] }), { name: "Auto" });
    const fake = leaderRelay(() => ({ task: running }));
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy, local, FAST);
    const placed = await client.callTool({ name: "spawn_session", arguments: { machine: "AUTO", repo: "seance" } });
    expect(toolText(placed)).toContain("task t-1: running on Linux Box");
    expect(local.requests).toEqual([]);
    const direct = await client.callTool({ name: "spawn_session", arguments: { machine: "device-1", repo: "seance" } });
    expect(toolText(direct)).toContain("spawned window w on Auto");
    lazy.stop();
  });
});

describe("get_queue", () => {
  test("lists the leader's tasks with state, placement and the decision's one line", async () => {
    const fake = leaderRelay(
      () => new Error("no submit here"),
      [{ tasks: [running, task({ id: "t-2", spec: { repo: ORIGIN, mode: "worktree", prompt: "next" } })], at: 6_000 }],
    );
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const result = await client.callTool({ name: "get_queue", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(toolText(result))).toEqual({
      at: new Date(6_000).toISOString(),
      tasks: [
        {
          id: "t-1",
          state: "running",
          repo: ORIGIN,
          createdAt: new Date(4_000).toISOString(),
          placement: { machine: "Linux Box", deviceId: "device-2", exclave: "work", clone: "seance", window: "fix-it" },
          decision: "chose Linux Box/work (lowest score, 0.30); MacBook Pro/default: not signed in",
        },
        { id: "t-2", state: "ready", repo: ORIGIN, prompt: "next", createdAt: new Date(4_000).toISOString() },
      ],
    });
    expect(fake.requests.map((r) => `${r.op}@${r.deviceId}`)).toEqual([`queue@${SCHEDULER_ID}`]);
    lazy.stop();
  });

  test("a failed task's line words a scheduler code and keeps a daemon refusal's own message", async () => {
    const failed = (id: string, code: string, message: string) =>
      task({ id, state: "failed", failure: { code, message } });
    const fake = leaderRelay(
      () => new Error("no submit here"),
      [
        {
          tasks: [
            failed("t-1", "dispatch_unconfirmed", "the launch ledger no longer reaches back to its reservation"),
            failed("t-2", "repo_not_found", "no such repo"),
          ],
          at: 6_000,
        },
      ],
    );
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const result = await client.callTool({ name: "get_queue", arguments: {} });
    const { tasks } = JSON.parse(toolText(result));
    expect(tasks.map((t: { failure: string }) => t.failure)).toEqual([
      `dispatch_unconfirmed: ${taskFailureText("dispatch_unconfirmed")} (the launch ledger no longer reaches back to its reservation)`,
      "repo_not_found: no such repo",
    ]);
    lazy.stop();
  });

  test("with no leader it says so, and a refusal is worded", async () => {
    const none = fakeRelay(autoMachines());
    const lazy = new LazyRelay({ create: () => none });
    const client = await connectedClient(lazy);
    const result = await client.callTool({ name: "get_queue", arguments: {} });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toStartWith("get_queue unavailable: no scheduler is leading");
    lazy.stop();

    const busy = leaderRelay(() => ({}), [{ ok: false, code: "not_ready", message: "loading" }]);
    const lazyBusy = new LazyRelay({ create: () => busy });
    const busyClient = await connectedClient(lazyBusy);
    const refused = await busyClient.callTool({ name: "get_queue", arguments: {} });
    expect(toolText(refused)).toContain("get_queue failed (not_ready): the scheduler is still taking over");
    lazyBusy.stop();
  });

  test("both scheduler tools tell the agent the queue survives a leader change but is not a backlog", async () => {
    const lazy = new LazyRelay({ create: () => fakeRelay([]) });
    const client = await connectedClient(lazy);
    const { tools } = await client.listTools();
    for (const name of ["spawn_session", "get_queue"]) {
      const description = tools.find((tool) => tool.name === name)?.description ?? "";
      expect(description).toContain("is held by the relay");
      expect(description).toContain("survives a change of leader (every relay deploy and daemon self-update)");
      expect(description).toContain("Do not use auto as a backlog");
    }
    expect(tools.find((tool) => tool.name === "get_queue")?.annotations?.readOnlyHint).toBe(true);
    lazy.stop();
  });
});

describe("cancel_task", () => {
  async function callCancel(answer: () => unknown): Promise<{ text: string; error: boolean; fake: FakeRelay }> {
    const fake = fakeRelay(autoMachines(), (op) => (op === "cancel" ? answer() : new Error(`unexpected ${op}`)));
    fake.setState({ scheduler: LEADING });
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    try {
      const result = await client.callTool({ name: "cancel_task", arguments: { taskId: "t-1" } });
      return { text: toolText(result), error: result.isError === true, fake };
    } finally {
      lazy.stop();
    }
  }

  test("sends the task id to the scheduler and reports the task as it now stands", async () => {
    const { text, error, fake } = await callCancel(() => ({ task: { ...running, state: "cancelled" } }));
    expect(error).toBe(false);
    expect(text).toBe("task t-1: cancelled on Linux Box");
    expect(fake.requests).toEqual([{ deviceId: SCHEDULER_ID, op: "cancel", payload: { taskId: "t-1" } }]);
  });

  test("a lost task cancelled with its machine away says its session may still be running there", async () => {
    const lost = { ...running, state: "cancelled", leftRunning: true } satisfies Task;
    const { text } = await callCancel(() => ({ task: lost }));
    expect(text).toContain("nothing was stopped there — its session may still be running");
  });

  test("a task that finished first is said to have, and refusals and lost answers are worded", async () => {
    expect((await callCancel(() => ({ task: { ...running, state: "done" } }))).text).toContain(
      "It had already finished (done) before the cancel landed.",
    );
    const refused = await callCancel(() => ({ ok: false, code: "dispatching", message: "in flight" }));
    expect(refused).toMatchObject({
      error: true,
      text: expect.stringContaining("cancel_task failed (dispatching): the task is starting"),
    });
    const lost = await callCancel(() => new RequestFailure("timeout", "no reply within 10000ms"));
    expect(lost.text).toBe(
      "cancel_task: no answer from the scheduler (no reply within 10000ms) — the cancel may have landed anyway — check get_queue",
    );
    const dropped = await callCancel(() => new RequestFailure("dropped", "the relay socket closed"));
    expect(dropped.text).toContain("the cancel may have landed anyway — check get_queue");
  });

  test("a transport code shows the leader's message on one line, never 'may have landed'", async () => {
    const unrecorded = "its session may already have ended, but the cancel was not recorded";
    const crashed = await callCancel(() => ({ ok: false, code: "internal_error", message: unrecorded }));
    expect(crashed.error).toBe(true);
    expect(crashed.text).toStartWith("cancel_task failed (internal_error): ");
    expect(crashed.text).toContain(`${unrecorded} — the leader's message says whether the cancel landed`);
    const message = `Error: first line\n${"x".repeat(2000)}\r\n\tat stack frame\u2028end`;
    const long = await callCancel(() => ({ ok: false, code: "internal_error", message }));
    expect(long.text).not.toMatch(/[\n\r\t\u2028]/u);
    expect(long.text).toContain("Error: first line xxx");
    expect(long.text).not.toContain("x".repeat(TASK_FAILURE_LIMITS.message + 1));
    // Only a successful reply is swapped for `too_large`, so the cancel ran.
    const big = await callCancel(() => ({ ok: false, code: "too_large", message: "big" }));
    expect(big.error).toBe(true);
    expect(big.text).toContain("the leader took the cancel");
    for (const { text } of [crashed, long, big]) expect(text).not.toContain("may have landed");
  });
});

describe("spawn_session on auto, when following fails", () => {
  test("polls the leader refuses every time leave the task as submitted, and say no read came back", async () => {
    const fake = leaderRelay(() => ({ task: task() }), [{ ok: false, code: "not_ready", message: "loading" }]);
    const { text, error } = await callAuto(fake);
    expect(error).toBe(false);
    expect(text).toContain("task t-1: ready");
    expect(text).toContain("the scheduler never answered a follow-up read");
    expect(fake.requests.filter((r) => r.op === "queue")).toHaveLength(FAST.autoFollow?.polls ?? 0);
    expect(fake.requests.filter((r) => r.op === "submit")).toHaveLength(1);
  });
});
