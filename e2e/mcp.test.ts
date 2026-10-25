import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { RelayClient, type SessionEntry, type SpawnResponse } from "@seance/shared";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { LazyRelay } from "../daemon/src/app-relay.ts";
import { brokerFleet, relayFleet, selectFleet } from "../daemon/src/fleet.ts";
import { buildMcpServer, localMachine, type LocalMachine } from "../daemon/src/mcp.ts";
import { tmux } from "../daemon/src/tmux.ts";
import { pollUntil } from "../daemon/test/fixtures.ts";
import { killWindow, listRegisteredWindows, listWindows, TOKEN, wsUrl, type Stack } from "./harness.ts";
import { startSuite, type Suite } from "./suite.ts";

let suite: Suite | undefined;
let stack: Stack;

beforeAll(async () => {
  suite = await startSuite("e2e-mcp");
  ({ stack } = suite);
});

afterAll(async () => {
  // startSuite failing in beforeAll leaves suite unset, having torn down what it started.
  await suite?.dispose();
});

describe("mcp ↔ relay ↔ daemon", () => {
  test("the MCP tools list, queue a pinned task, see and despawn its session — over the real relay", async () => {
    const lazy = new LazyRelay({
      create: () =>
        new RelayClient({
          url: wsUrl(stack.relay, "/app"),
          token: TOKEN,
          key: stack.appKey,
          createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
        }),
    });
    // Pinned so this test also proves the 2026-07-28 era is served; that takes
    // the serveStdio entry (with an injected transport) — a bare
    // server.connect() only speaks the 2025 era.
    const client = new Client(
      { name: "e2e", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serveStdio(() => buildMcpServer(relayFleet(lazy)), { transport: serverTransport });
    await client.connect(clientTransport);

    const text = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { text: string }[];
      return content.map((entry) => entry.text).join("\n");
    };

    let window: string | null = null;
    try {
      // The daemon registers before its scan finishes, so poll the tool until
      // the machine's repo list carries the fixture — same race Store.spawn ducks.
      await pollUntil(async () => (await text("list_machines", {})).includes("myrepo"), "repo visible over MCP");

      // The leader must be up for the task to run; the pin needs the machine's exclaves, which land
      // with its first status, so ask until the answer is a queued task.
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      let spawned = "";
      await pollUntil(
        async () => {
          spawned = await text("spawn_session", { machine: "TestMac", repo: "myrepo", prompt: "haunt the relay" });
          return spawned.startsWith("task ");
        },
        "the pinned spawn to queue",
        20_000,
      );
      const id = /^task (\S+): queued/u.exec(spawned)?.[1];
      if (id === undefined) throw new Error(`no task id in: ${spawned}`);
      await pollUntil(
        async () => (await stack.queue().get(id))?.body?.state === "running",
        "the pinned task to run",
        20_000,
      );
      const running = (await stack.queue().get(id))?.body;
      expect(running?.spec.pin).toEqual({ deviceId: stack.deviceId });
      expect(running?.spec.client).toBe("mcp");
      window = running?.assignment?.window ?? null;
      if (window === null) throw new Error("no window on the running task");
      expect(await listWindows()).toContain(window);

      const sessions: readonly SessionEntry[] = JSON.parse(await text("get_sessions", { machine: "TestMac" }));
      const listed = sessions.find((entry) => entry.window === window);
      expect(listed?.id).toMatch(/^%\d+$/u);

      // Forced: the stub claude takes no keys, so the graceful path would only
      // spend its grace before the same kill — that path is daemon/test's.
      const despawned = await text("despawn_session", { machine: "TestMac", id: listed?.id, force: true });
      expect(despawned).toBe(`killed ${window} on TestMac`);
      expect(await listWindows()).not.toContain(window);
      window = null;
    } finally {
      if (window !== null) await killWindow(window);
      await client.close();
      lazy.stop();
    }
  });

  test("with the relay unreachable, the local sessions still answer over the local socket, and a spawn is refused rather than run directly", async () => {
    expect(stack.daemon.localSocket).not.toBeNull();

    // The daemon registers before its scan finishes; the local path reads the
    // same set from state.json, so wait for it to land there. `repos()` is read
    // per call, so one `localMachine` sees the scan land without being rebuilt.
    let local: LocalMachine | null = null;
    await pollUntil(async () => {
      local ??= await localMachine(stack.config);
      return local !== null && (await local.repos()).some((repo) => repo.name === "myrepo");
    }, "the fixture repo in state.json");
    if (local === null) throw new Error("no local machine");

    // The proof that no relay is involved: creating the client throws, so any
    // code path that reaches for the relay fails the test loudly. This is also
    // the credential-delivered box, where the PSK cannot be resolved at all.
    const dead = new LazyRelay({
      create: () => {
        throw new Error("the relay must not be touched by a local op");
      },
    });
    const client = new Client(
      { name: "e2e-local", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serveStdio(() => buildMcpServer(relayFleet(dead), local), { transport: serverTransport });
    await client.connect(clientTransport);

    const text = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { text: string }[];
      return content.map((entry) => entry.text).join("\n");
    };

    const windowsBefore = await listWindows();
    try {
      const sessions = JSON.parse(await text("get_sessions", { machine: "TestMac" })) as SessionEntry[];
      expect(Array.isArray(sessions)).toBe(true);

      // A spawn always queues, so it needs the fleet — here it has none, and nothing runs directly.
      const refused = await client.callTool({
        name: "spawn_session",
        arguments: { machine: "TestMac", repo: "myrepo", prompt: "skip the relay" },
      });
      expect(refused.isError).toBe(true);
      expect(await listWindows()).toEqual(windowsBefore);

      // And the fleet view still needs the relay, so it degrades to this box.
      const listed = JSON.parse(await text("list_machines", {})) as {
        machines: { name: string; local: boolean }[];
      };
      expect(listed.machines).toEqual([expect.objectContaining({ name: "TestMac", local: true })]);
    } finally {
      await client.close();
      dead.stop();
    }
  });
});

describe("keyless mcp ↔ local daemon's broker ↔ relay ↔ remote daemon", () => {
  test("a process with no PSK lists, sees and despawns on another machine, and queues a pinned spawn, through its own daemon", async () => {
    // Machine B: a second real daemon, its own deviceId, on the same relay and tmux server.
    // Signed in, so the scheduler can place a pinned task on it.
    const account = { organizationUuid: "e2e-org-r", accountUuid: "remote", emailAddress: "remote@e2e.test" };
    const remote = await stack.startSecondDaemon({
      name: "RemoteBox",
      exclaves: [{ id: "default", observedAtMs: Date.now() - 10 * 60_000, fiveHourPct: 20, account }],
    });
    const remoteLog = remote.log;

    // Machine A is this suite's daemon; the MCP server below is the keyless
    // process beside it. `key` answering null is the credential-delivered
    // box: nothing this process can read holds the PSK, so the only way out
    // is A's op socket. `direct` throws, so a stray direct dial fails loudly.
    let local: LocalMachine | null = null;
    await pollUntil(async () => {
      local ??= await localMachine(stack.config);
      return local !== null;
    }, "this machine's state.json");
    const fleet = selectFleet({
      key: () => Promise.resolve(null),
      direct: () => {
        throw new Error("a keyless process must never dial the relay itself");
      },
      broker: brokerFleet(),
    });
    const client = new Client(
      { name: "e2e-keyless", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serveStdio(() => buildMcpServer(fleet, local), { transport: serverTransport });
    await client.connect(clientTransport);
    const call = async (
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<{ text: string; error: boolean }> => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { text: string }[];
      return { text: content.map((entry) => entry.text).join("\n"), error: result.isError === true };
    };

    // A's audit lines land on its stdout, which in-process is console.log.
    const audit = spyOn(console, "log");
    let window: string | null = null;
    try {
      type Listed = { name: string; local: boolean; connected: boolean; repos: string[] }[];
      let listed: Listed = [];
      await pollUntil(
        async () => {
          const { text, error } = await call("list_machines");
          if (error || !text.startsWith("[")) return false;
          listed = JSON.parse(text) as Listed;
          return listed.some(
            (entry) => entry.name === "RemoteBox" && entry.connected && entry.repos.includes("myrepo"),
          );
        },
        "the remote machine in the brokered registry",
        20_000,
      );
      // The whole fleet, not just this box — A as `local`, B beside it.
      expect(listed.find((entry) => entry.name === "TestMac")?.local).toBe(true);
      expect(listed.find((entry) => entry.name === "RemoteBox")?.local).toBe(false);

      const before = await call("get_sessions", { machine: "RemoteBox" });
      expect(before.error).toBe(false);
      expect(Array.isArray(JSON.parse(before.text))).toBe(true);

      // Stands in for a `seanced mcp` that predates spawns-as-tasks: the broker's `request` action still
      // carries `spawn`, which is what keeps such a process working until its Claude session restarts.
      const lease = await brokerFleet().open();
      try {
        const spawned = await lease.request<SpawnResponse>(remote.deviceId, "spawn", {
          repo: "myrepo",
          mode: "here",
          prompt: "broker the fleet",
          client: "mcp",
        });
        expect("ok" in spawned && spawned.ok).toBe(true);
      } finally {
        lease.release();
      }
      window = "broker-the-fleet";
      await pollUntil(
        async () => (await listRegisteredWindows()).includes("broker-the-fleet"),
        "B's window to register",
      );

      const sessions = JSON.parse((await call("get_sessions", { machine: "RemoteBox" })).text) as SessionEntry[];
      const id = sessions.find((entry) => entry.window === window)?.id;
      expect(id).toMatch(/^%\d+$/u);

      const despawned = await call("despawn_session", { machine: "RemoteBox", id, force: true });
      expect(despawned.text).toBe(`killed ${window} on RemoteBox`);
      window = null;

      // A recorded what it forwarded, as its own origin, without the prompt;
      // B recorded the spawn as an ordinary relayed one from the mcp client.
      const aLog = audit.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(aLog).toContain('audit broker origin=local-broker action=request op="spawn"');
      expect(aLog).toContain('client="mcp"');
      expect(aLog).not.toContain("broker the fleet");
      await pollUntil(
        async () => (await Bun.file(remoteLog).text()).includes('audit despawn origin=relay client="mcp"'),
        "B's audit trail",
      );
      const bLog = await Bun.file(remoteLog).text();
      expect(bLog).toContain('audit spawn origin=relay client="mcp" repo="myrepo"');
      expect(bLog).not.toContain("broker the fleet");

      // The current MCP's spawn is a task the broker enqueues, pinned to B: the leader (A) places it there.
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      let queued = { text: "", error: true };
      await pollUntil(
        async () => {
          queued = await call("spawn_session", {
            machine: "RemoteBox",
            repo: "myrepo",
            prompt: "pinned through broker",
          });
          return !queued.error;
        },
        "the keyless pinned spawn to queue",
        20_000,
      );
      const taskId = /^task (\S+): queued/u.exec(queued.text)?.[1];
      if (taskId === undefined) throw new Error(`no task id in: ${queued.text}`);
      await pollUntil(
        async () => (await stack.queue().get(taskId))?.body?.state === "running",
        "the pinned task to run on the remote machine",
        30_000,
      );
      const placed = (await stack.queue().get(taskId))?.body;
      expect(placed?.spec.pin?.deviceId).toBe(remote.deviceId);
      expect(placed?.spec.client).toBe("mcp");
      expect(placed?.assignment?.deviceId).toBe(remote.deviceId);
      const pinnedWindow = placed?.assignment?.window;
      if (pinnedWindow !== undefined) await tmux(["kill-window", "-t", `${remote.tmuxSession}:${pinnedWindow}`]);

      // A stops mid-session: the error says so, and once it is back the same
      // MCP server recovers on its own — nothing here cached the broken path.
      stack.daemon.stop();
      const down = await call("get_sessions", { machine: "RemoteBox" });
      expect(down.error).toBe(true);
      expect(down.text).toContain("is seanced running?");
      await stack.restartDaemon();
      await pollUntil(
        async () => !(await call("get_sessions", { machine: "RemoteBox" })).error,
        "the brokered fleet after the daemon restarted",
        20_000,
      );
    } finally {
      audit.mockRestore();
      if (window !== null) await tmux(["kill-window", "-t", `${remote.tmuxSession}:${window}`]);
      await client.close();
      fleet.stop();
      await remote.stop();
    }
  }, 90_000);
});
