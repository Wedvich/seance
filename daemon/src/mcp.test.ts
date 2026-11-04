import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  CAPABILITIES,
  isRecord,
  QUEUE_MAX_TASKS,
  RequestFailure,
  SCHEDULER_ID,
  TASK_FAILURE_LIMITS,
  TASK_REQUEST_LIMITS,
  storeErrorText,
  taskFailureText,
  withReportInstruction,
  type AccountRecord,
  type Decision,
  type ExclaveInfo,
  type Machine,
  type RequestOp,
  type Task,
  type TaskSpec,
} from "@seance/shared";
import { startBrokerDouble } from "../test/broker-double.ts";
import { fakeRelay, machine, type FakeRelay } from "../test/fake-app-relay.ts";
import { pollUntil } from "../test/fixtures.ts";
import { LazyRelay } from "./app-relay.ts";
import type { AuditSink } from "./audit.ts";
import { BrokerError } from "./broker-client.ts";
import { brokerFail, brokerOk } from "./broker-protocol.ts";
import { resolveMachine, resolveOrigin, resolvePlacement, type PlacementInput } from "./auto.ts";
import { brokerFleet, relayFleet, SCHEDULER_NEEDS_NEWER_DAEMON, selectFleet, type Fleet } from "./fleet.ts";
import { LocalUnavailable } from "./local-client.ts";
import type { reportDone } from "./report-done.ts";
import {
  buildMcpServer,
  decisionText,
  isLocalRef,
  mcpBunPath,
  mcpScriptCheck,
  mcpScriptPath,
  ACCOUNT_LABEL_DEADLINE_MS,
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
  audit: AuditSink = () => {},
  report?: typeof reportDone,
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
  serveStdio(() => buildMcpServer(fleet, local, audit, report), { transport: serverTransport });
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
    const listed: Record<string, unknown>[] = JSON.parse(toolText(result));
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

  test("list_machines reports a slept machine's last status beat, not its days-old register, as lastSeen", async () => {
    const slept = machine({ connected: false, lastSeen: 2_000, status: { at: 90_000, scan: 1_000 } });
    const lazy = new LazyRelay({ create: () => fakeRelay([slept]) });
    const client = await connectedClient(lazy);
    const listed: Record<string, unknown>[] = JSON.parse(
      toolText(await client.callTool({ name: "list_machines", arguments: {} })),
    );
    expect(listed[0]?.["lastSeen"]).toBe(new Date(90_000_000).toISOString());
    lazy.stop();
  });

  test("list_machines lists each machine's exclaves with the account signed in there, and none for a machine that reports none", async () => {
    const signedOut: ExclaveInfo = { ...exclave("spare"), accountId: null };
    const machines = [
      machine({ exclaves: [exclave("default"), { ...exclave("work"), email: "me@pengefix.no" }, signedOut] }),
      machine({ deviceId: "device-2", name: "Old Box" }),
    ];
    const lazy = new LazyRelay({ create: () => fakeRelay(machines) });
    const client = await connectedClient(lazy);
    const [updated, old]: Record<string, unknown>[] = JSON.parse(
      toolText(await client.callTool({ name: "list_machines", arguments: {} })),
    );
    expect(updated?.exclaves).toEqual([
      { id: "default", accountId: "org:default", account: "acct default" },
      { id: "work", accountId: "org:work", email: "me@pengefix.no", account: "me@pengefix.no" },
      { id: "spare" },
    ]);
    expect(old).not.toHaveProperty("exclaves");
    lazy.stop();
  });

  test("list_machines names each account by its alias, from one listing across calls", async () => {
    const machines = [
      machine({ exclaves: [signedIn("default", PERSONAL)] }),
      machine({ deviceId: "device-2", name: "Linux Box", exclaves: [signedIn("work", EMPLOYER)] }),
    ];
    const fake = fakeRelay(machines);
    fake.accounts = [{ accountId: PERSONAL, alias: "personal", version: 1 }];
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    for (let call = 0; call < 2; call += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the second call is the point: it must not list again
      const listed: { exclaves: unknown[] }[] = JSON.parse(
        toolText(await client.callTool({ name: "list_machines", arguments: {} })),
      );
      expect(listed.map((entry) => entry.exclaves)).toEqual([
        [{ id: "default", accountId: PERSONAL, email: EMAIL, account: "personal", alias: "personal" }],
        // The unaliased twin keeps its org tag, as the PWA draws it.
        [{ id: "work", accountId: EMPLOYER, email: EMAIL, account: `${EMAIL} (org org-b)` }],
      ]);
    }
    expect(fake.accountLists).toBe(1);
    lazy.stop();
  });

  test("list_machines falls back to the email or short id when the aliases cannot be read, and never fails", async () => {
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    try {
      const cases: [string, FakeRelay["accounts"]][] = [
        ["refused", { ok: false, code: "rate_limited" }],
        ["unreadable", null],
        ["no account key", new RequestFailure("unsupported", "this install has no account key", "relay")],
        ["a bug", new Error("boom")],
      ];
      for (const [label, accounts] of cases) {
        const fake = fakeRelay([machine({ exclaves: [signedIn("default", PERSONAL), exclave("spare")] })]);
        fake.accounts = accounts;
        const lazy = new LazyRelay({ create: () => fake });
        // oxlint-disable-next-line no-await-in-loop -- one client per failure
        const result = await (await connectedClient(lazy)).callTool({ name: "list_machines", arguments: {} });
        expect(result.isError, label).toBeFalsy();
        const [listed]: { exclaves: unknown[] }[] = JSON.parse(toolText(result));
        expect(listed?.exclaves, label).toEqual([
          { id: "default", accountId: PERSONAL, email: EMAIL, account: EMAIL },
          { id: "spare", accountId: "org:spare", account: "acct spare" },
        ]);
        lazy.stop();
      }
      // Only the bug is worth a line, and it goes to stderr: stdout is the JSON-RPC channel.
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
    }
  });

  test("list_machines answers within the label deadline with email labels when the listing never answers", async () => {
    const fake = fakeRelay([machine({ exclaves: [signedIn("default", PERSONAL)] })]);
    fake.accounts = () => new Promise(() => {});
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const started = Date.now();
    const result = await client.callTool({ name: "list_machines", arguments: {} });
    expect(Date.now() - started).toBeLessThan(ACCOUNT_LABEL_DEADLINE_MS + 1_000);
    const [listed]: { exclaves: unknown[] }[] = JSON.parse(toolText(result));
    expect(listed?.exclaves).toEqual([{ id: "default", accountId: PERSONAL, email: EMAIL, account: EMAIL }]);
    lazy.stop();
  });

  test("concurrent list_machines calls share one listing, and the late answer reaches the next call", async () => {
    const fake = fakeRelay([machine({ exclaves: [signedIn("default", PERSONAL)] })]);
    let answer: (listing: Awaited<ReturnType<typeof fake.listAccounts>>) => void = () => {};
    fake.accounts = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const call = (): ReturnType<typeof client.callTool> => client.callTool({ name: "list_machines", arguments: {} });
    const both = Promise.all([call(), call()]);
    await pollUntil(() => fake.accountLists > 0, "the first listing to be sent");
    await both;
    expect(fake.accountLists).toBe(1);
    // Past the deadline the listing was still running: its answer fills the cache.
    answer({
      ok: true,
      accounts: [{ key: "account:x", record: { accountId: PERSONAL, alias: "personal", version: 1 } }],
      unreadable: [],
    });
    await pollUntil(async () => {
      const [listed]: { exclaves: { account: string }[] }[] = JSON.parse(toolText(await call()));
      return listed?.exclaves[0]?.account === "personal";
    }, "the late listing to name the account");
    expect(fake.accountLists).toBe(1);
    lazy.stop();
  });

  test("list_machines spends no listing when no machine reports an account", async () => {
    const fake = fakeRelay([machine({ exclaves: [{ ...exclave("spare"), accountId: null }] }), machine()]);
    fake.accounts = ALIASES;
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    await client.callTool({ name: "list_machines", arguments: {} });
    expect(fake.accountLists).toBe(0);
    lazy.stop();
  });

  test("through the broker, list_machines and get_queue label by email and never ask the daemon for accounts", async () => {
    const machines = [machine({ exclaves: [signedIn("default", PERSONAL)] })];
    const queue = {
      tasks: [
        task({ id: "t-1", state: "ready", spec: { repo: ORIGIN, mode: "worktree", pin: { account: PERSONAL } } }),
      ],
      at: 6_000,
    };
    // A daemon whose cache holds an alias: answering `accounts` would put it in the labels.
    const double = await startBrokerDouble((raw, id) => {
      if (!isRecord(raw)) return brokerFail(id, "invalid_request", "not a frame");
      if (raw["action"] === "fleet") {
        return brokerOk(id, { machines, scheduler: { kind: "ready", deviceId: "device-1", term: 1 } });
      }
      if (raw["schedulerOp"] === "queue") return brokerOk(id, queue);
      if (raw["schedulerOp"] === "accounts") return brokerOk(id, ALIASES);
      return brokerFail(id, "unsupported", "not in this double");
    });
    try {
      const fleet = selectFleet({
        key: () => Promise.resolve(null),
        direct: () => {
          throw new Error("no key, so no direct path");
        },
        broker: brokerFleet({ path: double.path }),
      });
      const client = await connectedClient(fleet, null);
      const [listed]: { exclaves: unknown[] }[] = JSON.parse(
        toolText(await client.callTool({ name: "list_machines", arguments: {} })),
      );
      expect(listed?.exclaves).toEqual([{ id: "default", accountId: PERSONAL, email: EMAIL, account: EMAIL }]);
      const parsed = JSON.parse(toolText(await client.callTool({ name: "get_queue", arguments: {} })));
      expect(parsed.tasks[0].pin).toEqual({ account: EMAIL, accountId: PERSONAL });
      expect(double.frames.some((frame) => isRecord(frame) && frame["schedulerOp"] === "accounts")).toBe(false);
    } finally {
      await double.stop();
    }
  });

  // A leader on an older build is what made the queue look wrong; this is how it shows.
  test("list_machines names each machine's build and marks the scheduler leader only once its proof verified", async () => {
    const source = { sha: "0123456789abcdef".repeat(2) + "01234567", commitTs: 1_700_000_000_000, branch: "main" };
    const lastUpdate = { at: 1_700_000_500_000, outcome: "skipped_dirty" as const, detail: "1 file" };
    const machines = [machine({ source, lastUpdate }), machine({ deviceId: "device-2", name: "Linux Box" })];
    const cases = [
      [{ kind: "ready", deviceId: "device-1", term: 3 }, ["leader", undefined]],
      [{ kind: "unverified", deviceId: "device-2", term: 4 }, [undefined, "unverified"]],
      [{ kind: "none" }, [undefined, undefined]],
    ] as const;
    for (const [scheduler, marks] of cases) {
      const fake = fakeRelay(machines);
      fake.setState({ scheduler });
      const lazy = new LazyRelay({ create: () => fake });
      // oxlint-disable-next-line no-await-in-loop -- one client per leader state
      const client = await connectedClient(lazy);
      // oxlint-disable-next-line no-await-in-loop -- one client per leader state
      const listed: Record<string, unknown>[] = JSON.parse(
        toolText(await client.callTool({ name: "list_machines", arguments: {} })),
      );
      expect(listed.map((entry) => entry["scheduler"])).toEqual([...marks]);
      expect(listed[0]?.["source"]).toEqual({
        sha: source.sha.slice(0, 12),
        committed: new Date(source.commitTs).toISOString(),
        branch: "main",
      });
      expect(listed[0]?.["lastUpdate"]).toEqual({
        at: new Date(lastUpdate.at).toISOString(),
        outcome: "skipped_dirty",
      });
      expect(listed[1]).not.toHaveProperty("source");
      expect(listed[1]).not.toHaveProperty("lastUpdate");
      lazy.stop();
    }
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
    const fake = fakeRelay([machine(), remote], () => ({ sessions: [], at: 1 }));
    const local = fakeLocal();
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy, local);

    await client.callTool({ name: "get_sessions", arguments: { machine: "Linux Box" } });
    expect(fake.requests[0]?.deviceId).toBe("device-2");
    expect(local.requests).toHaveLength(0);
    lazy.stop();
  });

  test("a remote machine sharing this one's name loses to local; its deviceId still reaches it", async () => {
    const twin = machine({ deviceId: "device-2", name: "MacBook Pro" });
    const fake = fakeRelay([machine(), twin], () => ({ sessions: [], at: 1 }));
    const local = fakeLocal(() => ({ sessions: [], at: 1 }));
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy, local);

    // By name: local wins, where `resolveMachine` would have refused as ambiguous.
    await client.callTool({ name: "get_sessions", arguments: { machine: "MacBook Pro" } });
    expect(local.requests).toHaveLength(1);
    expect(fake.requests).toHaveLength(0);

    // By deviceId: the escape hatch reaches the twin.
    await client.callTool({ name: "get_sessions", arguments: { machine: "device-2" } });
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

    const result = await client.callTool({ name: "get_sessions", arguments: { machine: "MacBook Pro" } });
    expect(result.isError).toBe(true);
    // The remediation is attached here, not baked into the thrown message, so it
    // reads the same for a socket that closed mid-request as for one never there.
    expect(toolText(result)).toContain("no daemon listening at /run/seanced.sock (ENOENT)");
    expect(toolText(result)).toContain("is seanced running? try `seanced status`");
    expect(fake.requests).toHaveLength(0);
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
    const listed: { machines: Record<string, unknown>[]; note: string } = JSON.parse(toolText(result));
    expect(listed.machines).toEqual([expect.objectContaining({ local: true, connected: true })]);
    expect(listed.machines[0]).not.toHaveProperty("exclaves");
    expect(listed.note).toContain("get_sessions and despawn_session still work here");
    expect(listed.note).toContain("without its exclaves");
    lazy.stop();
  });

  test("relay and daemon both down on the direct path: this machine is listed, but not as reachable", async () => {
    const lazy = new LazyRelay({ create: () => fakeRelay([], () => ({}), "rejected") });
    const client = await connectedClient(lazy, fakeLocal(undefined, { reachable: () => Promise.resolve(false) }));
    const listed = JSON.parse(toolText(await client.callTool({ name: "list_machines", arguments: {} }))) as {
      machines: { local: boolean; connected: boolean }[];
      note: string;
    };
    expect(listed.machines).toEqual([expect.objectContaining({ local: true, connected: false })]);
    expect(listed.note).toContain("relay is unreachable");
    expect(listed.note).toContain("no op on this machine works until seanced is running");
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

    const localResult = await client.callTool({ name: "get_sessions", arguments: { machine: "MacBook Pro" } });
    expect(localResult.isError).toBe(true);
    expect(toolText(localResult)).toContain("is seanced running?");
    // Local work never even asks for a key.
    expect(lookups).toBe(0);

    // A spawn always queues, so even for this machine it needs the fleet — and says why it has none.
    const localSpawn = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "MacBook Pro", repo: "seance" },
    });
    expect(localSpawn.isError).toBe(true);
    expect(toolText(localSpawn)).toContain("no PSK");
    expect(lookups).toBe(1);

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
    const fake = fakeRelay([machine()], () => ({ sessions: [], at: 1 }));
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy, null);
    await client.callTool({ name: "get_sessions", arguments: { machine: "MacBook Pro" } });
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

  test("a despawn on a disconnected machine is refused with when it was last heard from", async () => {
    const slept = machine({ connected: false, lastSeen: 2_000, status: { at: 90_000, scan: 1_000 } });
    const fake = fakeRelay([slept]);
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const result = await client.callTool({ name: "despawn_session", arguments: { machine: "MacBook Pro", id: "%12" } });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toBe(`MacBook Pro is not connected — last seen ${new Date(90_000_000).toISOString()}`);
    expect(fake.requests).toHaveLength(0);
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

/** A relay with a verified leader: each `queue` answers from `queues` in turn, the last one repeating. */
function leaderRelay(
  queues: readonly unknown[] = [],
  machines: readonly Machine[] = autoMachines(),
): ReturnType<typeof fakeRelay> {
  let polled = 0;
  const fake = fakeRelay(machines, (op) => {
    if (op === "queue") return queues[Math.min(polled++, queues.length - 1)] ?? { tasks: [], at: 6_000 };
    return new Error(`unexpected ${op}`);
  });
  fake.setState({ scheduler: LEADING });
  return fake;
}

async function callAuto(
  fake: ReturnType<typeof fakeRelay>,
  args: Record<string, unknown> = {},
): Promise<{ text: string; error: boolean; audited: readonly string[] }> {
  const lazy = new LazyRelay({ create: () => fake });
  const audited: string[] = [];
  const client = await connectedClient(lazy, null, (line) => {
    audited.push(line);
  });
  try {
    const result = await client.callTool({
      name: "spawn_session",
      arguments: { machine: "auto", repo: "seance", prompt: "fix it", ...args },
    });
    return { text: toolText(result), error: result.isError === true, audited };
  } finally {
    lazy.stop();
  }
}

describe("resolveOrigin", () => {
  test("an origin passes as itself, and a clone name maps to the one origin behind it", () => {
    expect(resolveOrigin(autoMachines(), ORIGIN)).toEqual({ origin: ORIGIN });
    expect(resolveOrigin(autoMachines(), "seance")).toEqual({ origin: ORIGIN });
  });

  test("an origin pasted in another case or as a remote URL finds the key; a clone name stays exact", () => {
    for (const pasted of ["github.com/M/Seance", "https://github.com/M/seance.git", "git@github.com:m/Seance.git"]) {
      expect(resolveOrigin(autoMachines(), pasted)).toEqual({ origin: ORIGIN });
    }
    const resolved = resolveOrigin(autoMachines(), "Seance");
    if (!("error" in resolved)) throw new Error("expected an error");
    expect(resolved.error).toContain('no repo "Seance" for the fleet');
  });

  test("a listed origin with a port resolves as listed, not as scp host:path", () => {
    const ported = "git.example:2222/team/repo";
    const machines = [
      machine({
        deviceId: "device-1",
        name: "MacBook Pro",
        repos: [{ name: "repo", path: "/repos/repo", defaultBranch: "main", origin: ported }],
      }),
    ];
    expect(resolveOrigin(machines, ported)).toEqual({ origin: ported });
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
      error: `no repo "nope" for the fleet — known origins: ${ORIGIN}`,
    });
    const legacy = resolveOrigin(machines, "legacy");
    if (!("error" in legacy)) throw new Error("expected an error");
    expect(legacy.error).toContain("Old has a clone by that name, but its daemon reports no origin");
  });
});

describe("spawn_session on auto", () => {
  test("stores a queued task for the origin through the relay and answers with its id; no scheduler request is made", async () => {
    const fake = leaderRelay();
    const stdout = spyOn(console, "log");
    try {
      const { text, error, audited } = await callAuto(fake, { title: "Fix it", mode: "here", model: "", plan: true });
      expect(error).toBe(false);
      expect(fake.creates).toHaveLength(1);
      const [created] = fake.creates;
      expect(text).toStartWith(`task ${created?.id}: queued`);
      // The box's own record of an enqueue no daemon saw; never the prompt.
      expect(audited).toEqual([
        `audit enqueue origin=mcp client=mcp task="${created?.id}" createdAt=${created?.createdAt} queued`,
      ]);
      expect(text).toContain("get_queue shows where it lands and why");
      expect(text).not.toContain("No scheduler is leading");
      // Nothing reachable from `seanced mcp` writes to stdout: it is the JSON-RPC channel.
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
    const [created] = fake.creates;
    expect(created?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(created?.state).toBe("queued");
    // The record names its client, for the leader's admit line; an empty model means default.
    expect(created?.spec).toEqual({
      repo: ORIGIN,
      mode: "here",
      prompt: "fix it",
      title: "Fix it",
      plan: true,
      client: "mcp",
    } satisfies TaskSpec);
    // The scheduler places it; this process neither asked it anything nor spawned on a machine itself.
    expect(fake.requests).toEqual([]);
  });

  test("a lost reply re-sends the same task, and a store that had it says so", async () => {
    const fake = leaderRelay();
    let tries = 0;
    fake.onCreate = () => {
      tries += 1;
      return tries === 1
        ? new RequestFailure("timeout", "no reply within 10000ms", "relay")
        : { ok: true, landedEarlier: true };
    };
    const { text, error } = await callAuto(fake);
    expect(error).toBe(false);
    expect(fake.creates).toHaveLength(2);
    expect(fake.creates[1]).toBe(fake.creates[0]);
    expect(text).toStartWith(`task ${fake.creates[0]?.id}: queued (an earlier try had already stored it)`);
  });

  test("three lost tries say the task may have queued, naming its id, and stop there", async () => {
    const fake = leaderRelay();
    fake.onCreate = () => new RequestFailure("dropped", "the relay socket closed", "relay");
    const { text, error, audited } = await callAuto(fake);
    expect(error).toBe(true);
    expect(fake.creates).toHaveLength(3);
    expect(new Set(fake.creates.map((t) => t.id)).size).toBe(1);
    expect(audited).toEqual([expect.stringMatching(/ task="[^"]+" createdAt=\d+ unanswered$/u)]);
    expect(text).toBe(
      `spawn: no answer from the relay after 3 tries — task ${fake.creates[0]?.id} may have queued; check get_queue before retrying`,
    );
  }, 10_000);

  test("three tries lost through the daemon's broker blame the daemon, not the relay", async () => {
    const fake = leaderRelay();
    fake.onCreate = () => new RequestFailure("dropped", "the daemon did not answer within 40000ms", "daemon");
    const { text, error } = await callAuto(fake);
    expect(error).toBe(true);
    expect(fake.creates).toHaveLength(3);
    expect(text).toBe(
      `spawn: no answer from this machine's daemon after 3 tries — task ${fake.creates[0]?.id} may have queued; check get_queue before retrying`,
    );
  }, 10_000);

  test("three tries that never left the process say it was not queued, not that it may have been", async () => {
    const fake = leaderRelay();
    fake.onCreate = () => new RequestFailure("disconnected", "the relay socket is not open", "relay");
    const { text, error, audited } = await callAuto(fake);
    expect(error).toBe(true);
    expect(fake.creates).toHaveLength(3);
    expect(text).toBe("spawn: not queued — the relay was unreachable after 3 tries; try again");
    // Nothing left this process, so nothing is recorded as enqueued.
    expect(audited).toEqual([]);
    expect(text).not.toContain("may have queued");
  }, 10_000);

  test("a store refusal is worded, and not retried", async () => {
    const fake = leaderRelay();
    fake.onCreate = () => ({ ok: false, code: "store_full" });
    const { text, error, audited } = await callAuto(fake);
    expect(error).toBe(true);
    expect(fake.creates).toHaveLength(1);
    expect(text).toBe(`spawn refused (store_full): ${storeErrorText("store_full")}`);
    expect(audited).toEqual([expect.stringMatching(/ refused code="store_full"$/u)]);
  });

  test("with no leader, or an unverified one, the task still queues and the answer says it waits for one", async () => {
    for (const scheduler of [{ kind: "none" }, { kind: "unverified", deviceId: "device-9", term: 2 }] as const) {
      const fake = leaderRelay();
      fake.setState({ scheduler });
      // oxlint-disable-next-line no-await-in-loop -- one fake each
      const { text, error } = await callAuto(fake);
      expect(error).toBe(false);
      expect(fake.creates).toHaveLength(1);
      expect(text).toContain(
        "No scheduler is leading right now (or its leader is unverified); the task waits in the relay's queue until one does.",
      );
      expect(fake.requests).toEqual([]);
    }
  });

  test("a prompt over the scheduler's bound is refused here, before anything dials the relay", async () => {
    const fake = leaderRelay();
    const prompt = "x".repeat(TASK_REQUEST_LIMITS.prompt + 1);
    const { text, error } = await callAuto(fake, { prompt });
    expect(error).toBe(true);
    expect(text).toBe(
      `spawn refused: the prompt is ${prompt.length} characters; a queued spawn takes at most ${TASK_REQUEST_LIMITS.prompt} — shorten it (the session can gather the rest with tools)`,
    );
    expect(fake.started).toBe(0);
    expect(fake.creates).toEqual([]);
  });

  test("an ambiguous repo is refused with the candidates, and nothing is stored", async () => {
    const machines = [
      ...autoMachines(),
      machine({
        deviceId: "device-3",
        name: "Work",
        repos: [{ name: "seance", path: "/w", defaultBranch: "main", origin: "github.com/fork/seance" }],
      }),
    ];
    const fake = leaderRelay([], machines);
    const { text, error } = await callAuto(fake);
    expect(error).toBe(true);
    expect(text).toContain("pass the origin instead");
    expect(fake.requests).toEqual([]);
    expect(fake.creates).toEqual([]);
  });

  test("through a daemon that predates brokered auto, the scheduler tools say to update it — and machines still list", async () => {
    // What a daemon from before the `fleet` action does: `unsupported`, then `machines` as ever.
    const double = await startBrokerDouble((raw, id) =>
      isRecord(raw) && raw["action"] === "machines"
        ? brokerOk(id, autoMachines())
        : brokerFail(id, "unsupported", "action is not brokered"),
    );
    try {
      const fleet = selectFleet({
        key: () => Promise.resolve(null),
        direct: () => {
          throw new Error("no key, so no direct path");
        },
        broker: brokerFleet({ path: double.path }),
      });
      const client = await connectedClient(fleet, fakeLocal());
      const tasks: Record<string, Record<string, unknown>> = {
        spawn_session: { machine: "auto", repo: "seance" },
        queue_batch: { tasks: [{ repo: "seance", prompt: "do it" }] },
        get_queue: {},
        cancel_task: { taskId: "t-1" },
        continue_task: { taskId: "t-1" },
      };
      for (const [name, args] of Object.entries(tasks)) {
        // oxlint-disable-next-line no-await-in-loop -- one tool at a time keeps the double's frame order readable
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        expect(toolText(result)).toContain(SCHEDULER_NEEDS_NEWER_DAEMON);
      }
      // No direct spawn remains to name as an alternative.
      expect(
        toolText(await client.callTool({ name: "spawn_session", arguments: { machine: "auto", repo: "seance" } })),
      ).not.toContain("name a machine");
      const listed = await client.callTool({ name: "list_machines", arguments: {} });
      expect(listed.isError).not.toBe(true);
      expect(toolText(listed)).toContain("Linux Box");
      // Nothing but the registry probes ever reached the daemon: no enqueue, no queue read, no request.
      const sent = double.frames.map((frame) => (isRecord(frame) ? frame["action"] : null));
      expect(sent.every((action) => action === "fleet" || action === "machines")).toBe(true);
    } finally {
      await double.stop();
    }
  });

  test("machine auto is no pin even when a machine is named Auto; its deviceId pins it, and neither touches the local daemon", async () => {
    const machines = autoMachines().map((m) =>
      m.deviceId === "device-1" ? machine({ ...m, name: "Auto", exclaves: [exclave("default")] }) : m,
    );
    const local = fakeLocal(() => ({}), { name: "Auto" });
    const fake = leaderRelay([], machines);
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy, local);
    const placed = await client.callTool({ name: "spawn_session", arguments: { machine: "AUTO", repo: "seance" } });
    expect(toolText(placed)).toContain(`task ${fake.creates[0]?.id}: queued`);
    expect(fake.creates[0]?.spec.pin).toBeUndefined();
    const pinned = await client.callTool({ name: "spawn_session", arguments: { machine: "device-1", repo: "seance" } });
    expect(toolText(pinned)).toContain(`task ${fake.creates[1]?.id}: queued`);
    expect(fake.creates[1]?.spec.pin).toEqual({ deviceId: "device-1" });
    expect(local.requests).toEqual([]);
    expect(fake.requests).toEqual([]);
    lazy.stop();
  });
});

/** The leader (device-1) advertises done reports, as a daemon of this build does. */
function reportingMachines(): Machine[] {
  const [leader, ...rest] = autoMachines();
  return [machine({ ...leader, capabilities: [CAPABILITIES.reportedDone] }), ...rest];
}

async function callTool(
  fake: ReturnType<typeof fakeRelay>,
  name: string,
  args: Record<string, unknown>,
  local: LocalMachine | null = null,
): Promise<{ text: string; error: boolean }> {
  const lazy = new LazyRelay({ create: () => fake });
  const client = await connectedClient(lazy, local);
  try {
    const result = await client.callTool({ name, arguments: args });
    return { text: toolText(result), error: result.isError === true };
  } finally {
    lazy.stop();
  }
}

const PRED = "3f1c2b7e-9d4a-4c1e-8a55-0b6f2d9e7a10";

describe("spawn_session on auto, authoring fields", () => {
  test("after, until and linear reach the stored record; reported appends the instruction to the prompt", async () => {
    const fake = leaderRelay([], reportingMachines());
    const { error } = await callAuto(fake, {
      after: [{ task: PRED }, { task: PRED, when: "done" }],
      until: "reported",
      linear: { issue: "ENG-123", url: "https://linear.app/pengefix/issue/ENG-123" },
    });
    expect(error).toBe(false);
    expect(fake.creates[0]?.spec).toEqual({
      repo: ORIGIN,
      mode: "worktree",
      prompt: withReportInstruction("fix it"),
      client: "mcp",
      deps: [
        { task: PRED, after: "opened" },
        { task: PRED, after: "done" },
      ],
      until: "reported",
      linear: { issue: "ENG-123", url: "https://linear.app/pengefix/issue/ENG-123" },
    } satisfies TaskSpec);
  });

  test("the default until is not written, and an empty linear url is left off", async () => {
    const fake = leaderRelay();
    const { error } = await callAuto(fake, { until: "merged", linear: { issue: "ENG-1", url: "" } });
    expect(error).toBe(false);
    expect(fake.creates[0]?.spec).toEqual({
      repo: ORIGIN,
      mode: "worktree",
      prompt: "fix it",
      client: "mcp",
      linear: { issue: "ENG-1" },
    } satisfies TaskSpec);
  });

  test("a Linear issue is trimmed as the PWA trims it, and a blank one is refused", async () => {
    const fake = leaderRelay();
    expect((await callAuto(fake, { linear: { issue: "  ENG-7 " } })).error).toBe(false);
    expect(fake.creates[0]?.spec.linear).toEqual({ issue: "ENG-7" });
    const blank = await callAuto(fake, { linear: { issue: "   " } });
    expect(blank.error).toBe(true);
    expect(blank.text).toContain("linear.issue is empty");
    expect(fake.creates).toHaveLength(1);
  });

  test("a bound the scheduler would null the task on is refused here, by name, before the relay is dialled", async () => {
    const fake = leaderRelay([], reportingMachines());
    const cases: [Record<string, unknown>, string][] = [
      [{ after: [{ task: "not an id" }] }, 'after: "not an id" is not a task id from get_queue'],
      [{ after: Array.from({ length: 17 }, () => ({ task: PRED })) }, "expected array to have <=16 items"],
      [{ linear: { issue: "" } }, "linear.issue is empty"],
      [{ linear: { issue: "E".repeat(65) } }, "linear.issue is 65 characters; at most 64"],
      [{ linear: { issue: "ENG-1", url: "http://linear.app/x" } }, "linear.url must be an https: URL"],
      [{ until: "reported", prompt: "" }, 'until "reported" needs a prompt'],
    ];
    for (const [extra, text] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one call each
      const answer = await callAuto(fake, extra);
      expect(answer.error).toBe(true);
      expect(answer.text).toContain(text);
    }
    expect(fake.started).toBe(0);
    expect(fake.creates).toEqual([]);
  });

  test("the appended instruction counts toward the prompt bound, and the refusal says so", async () => {
    const fake = leaderRelay([], reportingMachines());
    const prompt = "x".repeat(TASK_REQUEST_LIMITS.prompt - 5);
    const { text, error } = await callAuto(fake, { prompt, until: "reported" });
    expect(error).toBe(true);
    expect(text).toContain("a queued spawn takes at most");
    expect(text).toContain("the instruction to report is appended to the prompt and counts");
    expect(fake.creates).toEqual([]);
  });

  test("until reported and after done are written only to a leader that advertises them", async () => {
    for (const extra of [{ until: "reported" }, { after: [{ task: PRED, when: "done" }] }]) {
      const old = leaderRelay();
      // oxlint-disable-next-line no-await-in-loop -- one fake each
      const refused = await callAuto(old, extra);
      expect(refused.error).toBe(true);
      expect(refused.text).toContain("leader does not take until: reported / after: done yet");
      expect(old.creates).toEqual([]);

      const none = leaderRelay([], reportingMachines());
      none.setState({ scheduler: { kind: "none" } });
      // oxlint-disable-next-line no-await-in-loop -- one fake each
      const unknown = await callAuto(none, extra);
      expect(unknown.error).toBe(true);
      expect(unknown.text).toContain("no verified scheduler is leading");
      expect(none.creates).toEqual([]);

      const current = leaderRelay([], reportingMachines());
      // oxlint-disable-next-line no-await-in-loop -- one fake each
      expect((await callAuto(current, extra)).error).toBe(false);
      expect(current.creates).toHaveLength(1);
    }
    // Nothing the old leader cannot read: an ordinary dependency needs no capability.
    const old = leaderRelay();
    expect((await callAuto(old, { after: [{ task: PRED, when: "merged" }] })).error).toBe(false);
  });
});

const HQ = "github.com/pengefix/pengefix-hq";
const HQ2 = "github.com/pengefix2/pengefix-hq";

function exclave(id: string): ExclaveInfo {
  return { id, accountId: `org:${id}`, extraUsageEnabled: false, authOk: true, skills: [] };
}

/** One person in two orgs: the same email, two accounts — the case an email cannot pick between. */
const PERSONAL = "org-a:me";
const EMPLOYER = "org-b:me";
const EMAIL = "me@pengefix.no";

function signedIn(id: string, accountId: string): ExclaveInfo {
  return { ...exclave(id), accountId, email: EMAIL };
}

const ALIASES: readonly AccountRecord[] = [
  { accountId: PERSONAL, alias: "personal", version: 1 },
  { accountId: EMPLOYER, alias: "employer", version: 1 },
  // A record for an account no machine reports: aliasable, never pinnable.
  { accountId: "org-c:gone", alias: "old", version: 1 },
];

/**
 * Thad holds both orgs' clones, one per exclave and account; WSL and Mac each
 * call theirs plain `pengefix-hq` — for different repos, so the bare name is
 * ambiguous across the fleet though each machine's own list is not. Thad leads
 * where a test needs a leader that routes on accounts (`pinRelay`).
 */
function pinMachines(): Machine[] {
  return [
    machine({
      deviceId: "device-thad",
      name: "Thad",
      exclaves: [signedIn("default", PERSONAL), signedIn("work", EMPLOYER)],
      capabilities: [CAPABILITIES.pinAccount],
      repos: [
        { name: "pengefix/pengefix-hq", path: "/t/a", defaultBranch: "main", exclave: "default", origin: HQ },
        { name: "pengefix2/pengefix-hq", path: "/t/b", defaultBranch: "main", exclave: "work", origin: HQ2 },
      ],
    }),
    machine({
      deviceId: "device-wsl",
      name: "WSL",
      exclaves: [signedIn("default", PERSONAL)],
      repos: [{ name: "pengefix-hq", path: "/w", defaultBranch: "main", exclave: "default", origin: HQ }],
    }),
    machine({
      deviceId: "device-mac",
      name: "Mac",
      exclaves: [signedIn("default", EMPLOYER)],
      repos: [{ name: "pengefix-hq", path: "/m", defaultBranch: "main", exclave: "default", origin: HQ2 }],
    }),
  ];
}

/** A leader that routes on accounts, with the aliases listed. */
function pinRelay(): FakeRelay {
  const fake = leaderRelay([], pinMachines());
  fake.setState({ scheduler: { kind: "ready", deviceId: "device-thad", term: 3 } });
  fake.accounts = ALIASES;
  return fake;
}

/** The leader advertises done reports and routes on accounts, as a daemon of this build does. */
function reportingPinRelay(machines: readonly Machine[] = pinMachines()): FakeRelay {
  const withCaps = machines.map((m) =>
    m.deviceId === "device-thad"
      ? machine({ ...m, capabilities: [CAPABILITIES.pinAccount, CAPABILITIES.reportedDone] })
      : m,
  );
  const fake = leaderRelay([], withCaps);
  fake.setState({ scheduler: { kind: "ready", deviceId: "device-thad", term: 3 } });
  fake.accounts = ALIASES;
  return fake;
}

describe("spawn_session with a machine", () => {
  test("pins the task to the machine's deviceId, answers queued, and sends no spawn op", async () => {
    const fake = leaderRelay([], pinMachines());
    const { text, error } = await callAuto(fake, { machine: "wsl", repo: "pengefix-hq" });
    expect(error).toBe(false);
    expect(fake.creates[0]?.spec).toEqual({
      repo: HQ,
      mode: "worktree",
      prompt: "fix it",
      client: "mcp",
      pin: { deviceId: "device-wsl" },
    } satisfies TaskSpec);
    expect(text).toStartWith(`task ${fake.creates[0]?.id}: queued`);
    expect(text).not.toContain("spawned window");
    expect(fake.requests).toEqual([]);
  });

  test("after, until reported and linear reach the record beside a named machine", async () => {
    const fake = reportingPinRelay();
    const { error } = await callAuto(fake, {
      machine: "wsl",
      repo: "pengefix-hq",
      after: [{ task: PRED }],
      until: "reported",
      linear: { issue: "ENG-1" },
    });
    expect(error).toBe(false);
    expect(fake.creates[0]?.spec).toMatchObject({
      pin: { deviceId: "device-wsl" },
      until: "reported",
      deps: [{ task: PRED, after: "opened" }],
      linear: { issue: "ENG-1" },
    });
  });

  test("a pin to an offline machine queues, and the answer says the task waits for it", async () => {
    const machines = pinMachines().map((m) => (m.deviceId === "device-wsl" ? machine({ ...m, connected: false }) : m));
    const fake = leaderRelay([], machines);
    const { text, error } = await callAuto(fake, { machine: "wsl", repo: "pengefix-hq" });
    expect(error).toBe(false);
    expect(fake.creates).toHaveLength(1);
    expect(text).toContain("WSL is offline (last seen");
    expect(text).toContain("the task waits for it");
  });

  test("a local daemon named like the pinned machine is never asked to spawn", async () => {
    const local = fakeLocal(() => ({}), { deviceId: "device-wsl", name: "WSL" });
    const fake = leaderRelay([], pinMachines());
    const { error } = await callTool(fake, "spawn_session", { machine: "wsl", repo: "pengefix-hq" }, local);
    expect(error).toBe(false);
    expect(fake.creates).toHaveLength(1);
    expect(local.requests).toEqual([]);
    expect(fake.requests).toEqual([]);
  });
});

describe("resolvePlacement", () => {
  const listed = (records: readonly AccountRecord[] | null = ALIASES) => {
    const calls = { n: 0 };
    return {
      calls,
      accounts: async (): Promise<readonly AccountRecord[] | null> => {
        calls.n += 1;
        return records;
      },
    };
  };
  const placed = async (input: PlacementInput, records?: readonly AccountRecord[] | null) => {
    const resolved = await resolvePlacement(pinMachines(), listed(records).accounts, input);
    if ("error" in resolved) throw new Error(resolved.error);
    return resolved;
  };
  const refused = async (input: PlacementInput, records?: readonly AccountRecord[] | null): Promise<string> => {
    const resolved = await resolvePlacement(pinMachines(), listed(records).accounts, input);
    if (!("error" in resolved)) throw new Error("expected an error");
    return resolved.error;
  };

  test("a machine name resolves to its deviceId in any case, and the account cuts its clones to that account's", async () => {
    for (const ref of ["thad", "Thad", "device-thad"]) {
      // oxlint-disable-next-line no-await-in-loop -- one input each
      const resolved = await placed({ machine: ref, account: "employer" });
      expect(resolved.fields).toEqual({ pin: { deviceId: "device-thad", account: EMPLOYER } });
      expect(resolved.machines.map((m) => m.repos.map((r) => r.name))).toEqual([["pengefix2/pengefix-hq"]]);
      expect(resolved.scope).toBe(`a task pinned to Thad, account ${EMPLOYER}`);
    }
  });

  test("an offline pinned machine adds a waiting note, joined with the account line by a semicolon", async () => {
    const machines = pinMachines().map((m) => (m.deviceId === "device-thad" ? machine({ ...m, connected: false }) : m));
    const resolved = await resolvePlacement(machines, listed().accounts, { machine: "thad", account: "employer" });
    if ("error" in resolved) throw new Error(resolved.error);
    expect(resolved.echo).toBe(
      `Thad is offline (last seen ${new Date(2_000).toISOString()}); the task waits for it; pinned to account ${EMPLOYER} (${EMAIL})`,
    );
    expect(resolved.echo).not.toContain("\n");
    const online = await placed({ machine: "thad" });
    expect(online.echo).toBeNull();
  });

  test("an offline pinned machine's note dates it by its last status beat when that is newer than its register", async () => {
    const machines = pinMachines().map((m) =>
      m.deviceId === "device-thad" ? machine({ ...m, connected: false, status: { at: 90_000, scan: 1_000 } }) : m,
    );
    const resolved = await resolvePlacement(machines, listed().accounts, { machine: "thad" });
    if ("error" in resolved) throw new Error(resolved.error);
    expect(resolved.echo).toContain(`Thad is offline (last seen ${new Date(90_000_000).toISOString()})`);
  });

  test("an account by alias, by id, or by an email only it reports; the email never reaches the spec", async () => {
    for (const input of ["employer", "EMPLOYER", EMPLOYER]) {
      // oxlint-disable-next-line no-await-in-loop -- one input each
      const resolved = await placed({ account: input });
      expect(resolved.fields).toEqual({ pin: { account: EMPLOYER } });
      // Every machine, each cut to its clones where the account is signed in.
      expect(resolved.machines.flatMap((m) => m.repos.map((r) => r.path))).toEqual(["/t/b", "/m"]);
      expect(resolved.echo).toBe(`pinned to account ${EMPLOYER} (${EMAIL})`);
      expect(JSON.stringify(resolved.fields)).not.toContain(EMAIL);
    }
    const solo = [machine({ deviceId: "device-x", name: "X", exclaves: [{ ...exclave("default"), email: "x@a.no" }] })];
    const byEmail = await resolvePlacement(solo, listed().accounts, { account: "X@A.no" });
    expect(byEmail).toMatchObject({ fields: { pin: { account: "org:default" } } });
  });

  test("an email two orgs share is refused with each full accountId and where it is signed in", async () => {
    const error = await refused({ account: EMAIL });
    expect(error).toContain(`pin.account: "${EMAIL}" is the email of more than one account — give its id`);
    expect(error).toContain(`${PERSONAL} (alias "personal", ${EMAIL}, on Thad/default, WSL/default)`);
    expect(error).toContain(`${EMPLOYER} (alias "employer", ${EMAIL}, on Thad/work, Mac/default)`);
  });

  test("an unknown account lists the fleet's; one no machine reports, or not the pinned one, is refused", async () => {
    expect(await refused({ account: "nobody" })).toContain(
      `pin.account: no account "nobody" — the fleet's accounts: ${PERSONAL}`,
    );
    expect(await refused({ account: "old" })).toContain(
      'org-c:gone (alias "old", signed in nowhere), which no machine reports signed in',
    );
    expect(await refused({ machine: "WSL", account: "employer" })).toContain(
      `is signed in on no exclave of WSL (device-wsl)`,
    );
  });

  test("a failed listing says aliases are unavailable and asks for an email or id, which still resolve", async () => {
    const error = await refused({ account: "employer" }, null);
    expect(error).toContain("aliases unavailable: the account listing is unavailable right now");
    expect(error).toContain("give the account's email or id");
    expect(error).not.toContain("no account");
    expect((await placed({ account: EMPLOYER }, null)).fields).toEqual({ pin: { account: EMPLOYER } });
  });

  test("a stale record holding a live account's alias does not make it ambiguous", async () => {
    const records = [...ALIASES, { accountId: "org-c:gone", alias: "employer", version: 1 }];
    expect((await placed({ account: "employer" }, records)).fields).toEqual({ pin: { account: EMPLOYER } });
    // With no live match the alias still names an account signed in nowhere.
    expect(await refused({ account: "old" }, records)).toContain("which no machine reports signed in");
  });

  test("an alias equal to another account's id or email never redirects a pin that names it", async () => {
    const squatter = ALIASES.map((r) => (r.accountId === PERSONAL ? { ...r, alias: EMPLOYER.toUpperCase() } : r));
    for (const input of [EMPLOYER, EMPLOYER.toUpperCase()]) {
      // oxlint-disable-next-line no-await-in-loop -- one input each
      expect((await placed({ account: input }, squatter)).fields).toEqual({ pin: { account: EMPLOYER } });
    }
    const two = [
      machine({
        deviceId: "device-a",
        name: "A",
        exclaves: [{ ...exclave("default"), accountId: "org-a:x", email: "a@a.no" }],
      }),
      machine({
        deviceId: "device-b",
        name: "B",
        exclaves: [{ ...exclave("default"), accountId: "org-b:x", email: "b@b.no" }],
      }),
    ];
    const records = [{ accountId: "org-a:x", alias: "b@b.no", version: 1 }];
    expect(await resolvePlacement(two, listed(records).accounts, { account: "B@b.no" })).toMatchObject({
      fields: { pin: { account: "org-b:x" } },
    });
  });

  test("an account matches any email a machine reports for it", async () => {
    const mixed = [
      machine({ deviceId: "device-a", name: "A", exclaves: [{ ...exclave("default"), email: "first@a.no" }] }),
      machine({ deviceId: "device-b", name: "B", exclaves: [{ ...exclave("default"), email: "second@a.no" }] }),
    ];
    for (const email of ["first@a.no", "SECOND@a.no"]) {
      // oxlint-disable-next-line no-await-in-loop -- one input each
      const resolved = await resolvePlacement(mixed, listed().accounts, { account: email });
      expect(resolved).toMatchObject({ fields: { pin: { account: "org:default" } } });
    }
  });

  test("avoid covering every machine signed in to the pinned account is refused", async () => {
    const error = await refused({ account: "employer", avoid: ["Thad", "Mac"] });
    expect(error).toContain(`avoid covers every machine signed in to account ${EMPLOYER} (Thad, Mac)`);
    expect((await placed({ account: "employer", avoid: ["Thad"] })).fields).toEqual({
      pin: { account: EMPLOYER },
      avoid: ["device-thad"],
    });
  });

  test("avoid stores deviceIds once each; naming the pinned machine or an unknown one is refused, avoiding all others is not", async () => {
    const resolved = await placed({ avoid: ["wsl", "device-wsl", "Mac"] });
    expect(resolved.fields).toEqual({ avoid: ["device-wsl", "device-mac"] });
    // avoid narrows no repo scope: the task waits rather than reading a name elsewhere.
    expect(resolved.scope).toBe("the fleet");
    expect(await refused({ machine: "Thad", avoid: ["thad"] })).toContain(
      "avoid names Thad (device-thad), the machine the task is pinned to",
    );
    expect(await refused({ avoid: ["nope"] })).toContain('avoid: no machine named "nope"');
    expect((await placed({ machine: "Thad", avoid: ["WSL", "Mac"] })).fields).toEqual({
      pin: { deviceId: "device-thad" },
      avoid: ["device-wsl", "device-mac"],
    });
  });

  test("only an account pin lists accounts", async () => {
    const { calls, accounts } = listed();
    await resolvePlacement(pinMachines(), accounts, { machine: "Thad", avoid: ["WSL"] });
    await resolvePlacement(pinMachines(), accounts, {});
    expect(calls.n).toBe(0);
    await resolvePlacement(pinMachines(), accounts, { account: "personal" });
    expect(calls.n).toBe(1);
  });

  test("a machine reporting no exclaves, or an unknown or shared name, is refused", async () => {
    const old = [machine({ deviceId: "device-old", name: "Old" })];
    expect(await resolvePlacement(old, listed().accounts, { machine: "Old" })).toEqual({
      error:
        "pin.machine: Old (device-old) reports no exclaves, so the scheduler cannot place there — its daemon needs `seanced update`",
    });
    expect(await refused({ machine: "nope" })).toBe(
      'pin.machine: no machine named "nope" — known machines: Thad, WSL, Mac',
    );
    const twins = [...pinMachines(), machine({ deviceId: "device-wsl2", name: "wsl", exclaves: [exclave("default")] })];
    const shared = await resolvePlacement(twins, listed().accounts, { machine: "WSL" });
    expect(shared).toMatchObject({ error: expect.stringContaining("WSL (device-wsl), wsl (device-wsl2)") });
  });
});

describe("spawn_session on auto, pinned", () => {
  test("a machine name is stored as its deviceId, and a repo name is read as the pinned machine lists it", async () => {
    // Fleet-wide, `pengefix-hq` names two repos; on WSL it names one.
    const unpinned = await callAuto(leaderRelay([], pinMachines()), { repo: "pengefix-hq" });
    expect(unpinned.error).toBe(true);
    expect(unpinned.text).toContain('"pengefix-hq" names clones of more than one repo');

    // A machine pin needs no capability and spends no account listing.
    const fake = leaderRelay([], pinMachines());
    const { error } = await callAuto(fake, { repo: "pengefix-hq", pin: { machine: "wsl" } });
    expect(error).toBe(false);
    expect(fake.creates[0]?.spec).toEqual({
      repo: HQ,
      mode: "worktree",
      prompt: "fix it",
      client: "mcp",
      pin: { deviceId: "device-wsl" },
    } satisfies TaskSpec);

    const mac = await callAuto(fake, { repo: "pengefix-hq", pin: { machine: "device-mac" } });
    expect(mac.error).toBe(false);
    expect(fake.creates[1]?.spec).toMatchObject({ repo: HQ2, pin: { deviceId: "device-mac" } });
    expect(fake.accountLists).toBe(0);
  });

  test("an account pin stores only the accountId, narrows the names to its clones, and names the account in the answer", async () => {
    const fake = pinRelay();
    const work = await callAuto(fake, { repo: "pengefix2/pengefix-hq", pin: { machine: "Thad", account: "employer" } });
    expect(work.error).toBe(false);
    expect(work.text).toContain(`pinned to account ${EMPLOYER} (${EMAIL})`);
    expect(fake.creates[0]?.spec).toMatchObject({ repo: HQ2, pin: { deviceId: "device-thad", account: EMPLOYER } });
    expect(JSON.stringify(fake.creates[0])).not.toContain(EMAIL);
    expect(JSON.stringify(fake.creates[0])).not.toContain("employer");
    expect(work.audited.join("\n")).not.toContain(EMAIL);

    const elsewhere = await callAuto(fake, {
      repo: "pengefix2/pengefix-hq",
      pin: { machine: "Thad", account: "personal" },
    });
    expect(elsewhere.error).toBe(true);
    expect(elsewhere.text).toContain(
      `no repo "pengefix2/pengefix-hq" for a task pinned to Thad, account ${PERSONAL} — known origins: ${HQ}`,
    );

    const origin = await callAuto(fake, { repo: `https://${HQ}.git`, pin: { account: PERSONAL } });
    expect(origin.error).toBe(false);
    expect(fake.creates[1]?.spec).toMatchObject({ repo: HQ, pin: { account: PERSONAL } });
    expect(fake.creates).toHaveLength(2);
  });

  test("an unknown or ambiguous machine or account is refused with the choices, and nothing is stored", async () => {
    const fake = pinRelay();
    const cases: [Record<string, unknown>, string][] = [
      [{ machine: "nope" }, 'pin.machine: no machine named "nope"'],
      [{ account: EMAIL }, `${PERSONAL} (alias "personal"`],
      [{ machine: "WSL", account: "employer" }, "is signed in on no exclave of WSL (device-wsl)"],
      [{ account: "nobody" }, "the fleet's accounts:"],
    ];
    for (const [pin, text] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one call each
      const answer = await callAuto(fake, { repo: HQ, pin });
      expect(answer.error).toBe(true);
      expect(answer.text).toContain(text);
    }
    expect(fake.creates).toEqual([]);
  });

  test("a pin bypasses the label hold: a refused listing held for labels still resolves the alias at once", async () => {
    const fake = pinRelay();
    fake.accounts = { ok: false, code: "rate_limited" };
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    try {
      const listed = await client.callTool({ name: "list_machines", arguments: {} });
      expect(listed.isError).toBeFalsy();
      expect(fake.accountLists).toBe(1);
      fake.accounts = ALIASES;
      const result = await client.callTool({
        name: "spawn_session",
        arguments: { machine: "auto", repo: HQ, prompt: "fix it", pin: { account: "personal" } },
      });
      expect(result.isError).toBeFalsy();
      expect(fake.accountLists).toBe(2);
      expect(fake.creates[0]?.spec).toMatchObject({ pin: { account: PERSONAL } });
    } finally {
      lazy.stop();
    }
  });

  test("a refused account listing says aliases are unavailable, never that the account is unknown", async () => {
    const fake = pinRelay();
    fake.accounts = { ok: false, code: "rate_limited" };
    const alias = await callAuto(fake, { repo: HQ, pin: { account: "personal" } });
    expect(alias.error).toBe(true);
    expect(alias.text).toContain("aliases unavailable: the account listing is unavailable right now");
    expect(alias.text).toContain("give the account's email or id");
    const byId = await callAuto(fake, { repo: HQ, pin: { account: PERSONAL } });
    expect(byId.error).toBe(false);
    expect(fake.creates).toHaveLength(1);
  });

  test("pin.account and avoid are written only to a leader that advertises pinAccount", async () => {
    for (const extra of [{ pin: { account: "personal" } }, { avoid: ["WSL"] }]) {
      const old = leaderRelay([], pinMachines());
      old.accounts = ALIASES;
      // oxlint-disable-next-line no-await-in-loop -- one fake each
      const refused = await callAuto(old, { repo: HQ, ...extra });
      expect(refused.error).toBe(true);
      expect(refused.text).toContain("leader does not route on pin.account / avoid yet");
      expect(old.creates).toEqual([]);
      expect(old.accountLists).toBe(0);

      const none = pinRelay();
      none.setState({ scheduler: { kind: "none" } });
      // oxlint-disable-next-line no-await-in-loop -- one fake each
      const unknown = await callAuto(none, { repo: HQ, ...extra });
      expect(unknown.error).toBe(true);
      expect(unknown.text).toContain("no verified scheduler is leading");
      expect(none.creates).toEqual([]);

      const current = pinRelay();
      // oxlint-disable-next-line no-await-in-loop -- one fake each
      expect((await callAuto(current, { repo: HQ, ...extra })).error).toBe(false);
      expect(current.creates).toHaveLength(1);
    }
  });

  test("avoid is stored as deviceIds; naming the pinned machine is refused", async () => {
    const fake = pinRelay();
    const ok = await callAuto(fake, { repo: HQ, avoid: ["wsl", "device-mac"] });
    expect(ok.error).toBe(false);
    expect(fake.creates[0]?.spec).toMatchObject({ repo: HQ, avoid: ["device-wsl", "device-mac"] });
    expect(fake.creates[0]?.spec.pin).toBeUndefined();
    expect(fake.accountLists).toBe(0);
    const contradiction = await callAuto(fake, { repo: HQ, pin: { machine: "Thad" }, avoid: ["Thad"] });
    expect(contradiction.error).toBe(true);
    expect(contradiction.text).toContain("the machine the task is pinned to");
    expect(fake.creates).toHaveLength(1);
  });

  test("an empty pin, an empty machine or account, and too many avoided machines are refused before the relay is dialled", async () => {
    const fake = pinRelay();
    const cases: [Record<string, unknown>, string][] = [
      [{ pin: {} }, "pin names neither a machine nor an account"],
      [{ pin: { exclave: "work" } }, "exclave pins are gone — pin an account"],
      [{ pin: { account: "personal", exclave: "work" } }, "exclave pins are gone — pin an account"],
      [{ pin: { machine: "" } }, "pin.machine is empty"],
      [{ pin: { machine: "m".repeat(65) } }, "pin.machine is 65 characters; at most 64"],
      [{ pin: { account: " " } }, "pin.account is empty"],
      [{ avoid: [""] }, "avoid names an empty machine"],
      [{ avoid: ["a", "b", "c", "d", "e"] }, "avoid names 5 machines; a task avoids at most 4"],
    ];
    for (const [extra, text] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one call each
      const answer = await callAuto(fake, { repo: HQ, ...extra });
      expect(answer.error).toBe(true);
      expect(answer.text).toContain(`spawn refused: ${text}`);
    }
    // A top-level machine must not make an empty pin valid.
    const emptyBeside = await callAuto(fake, { machine: "wsl", repo: HQ, pin: {} });
    expect(emptyBeside.error).toBe(true);
    expect(emptyBeside.text).toContain("spawn refused: pin names neither a machine nor an account");
    expect(fake.started).toBe(0);
  });

  test("a machine beside pin.machine is refused as given twice; beside avoid or an account pin it queues", async () => {
    const both = pinRelay();
    const refused = await callAuto(both, { machine: "wsl", repo: "pengefix-hq", pin: { machine: "mac" } });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain("give the machine once");
    expect(both.started).toBe(0);
    expect(both.creates).toEqual([]);

    const avoided = await callAuto(pinRelay(), { machine: "wsl", repo: "pengefix-hq", avoid: ["mac"] });
    expect(avoided.error).toBe(false);
    const accounted = pinRelay();
    const withAccount = await callAuto(accounted, {
      machine: "Thad",
      repo: "pengefix2/pengefix-hq",
      pin: { account: "employer" },
    });
    expect(withAccount.error).toBe(false);
    expect(accounted.creates[0]?.spec.pin).toEqual({ deviceId: "device-thad", account: EMPLOYER });
  });

  test("placement errors name machine, not pin.machine, when the top-level field was given", async () => {
    const unknown = await callAuto(pinRelay(), { machine: "nope", repo: "pengefix-hq" });
    expect(unknown.error).toBe(true);
    expect(unknown.text).toStartWith("spawn refused: machine: ");
    const exclaveless = await callAuto(leaderRelay(), { machine: "device-1", repo: "seance" });
    expect(exclaveless.text).toStartWith("spawn refused: machine: MacBook Pro (device-1) reports no exclaves");
  });

  test("queue_batch places each member on its own, and one bad pin refuses the batch before the first create", async () => {
    const fake = pinRelay();
    const ok = await callTool(fake, "queue_batch", {
      tasks: [
        { repo: "pengefix-hq", prompt: "a", pin: { machine: "WSL" } },
        { repo: "pengefix2/pengefix-hq", prompt: "b", pin: { account: "employer" } },
        { repo: HQ, prompt: "c", avoid: ["Mac"] },
        { repo: HQ, prompt: "d", pin: { account: "personal" } },
      ],
    });
    expect(ok.error).toBe(false);
    expect(fake.creates.map((t) => [t.spec.repo, t.spec.pin, t.spec.avoid])).toEqual([
      [HQ, { deviceId: "device-wsl" }, undefined],
      [HQ2, { account: EMPLOYER }, undefined],
      [HQ, undefined, ["device-mac"]],
      [HQ, { account: PERSONAL }, undefined],
    ]);
    expect(ok.text).toContain(`task 2: pinned to account ${EMPLOYER} (${EMAIL})`);
    expect(ok.text).toContain(`task 4: pinned to account ${PERSONAL} (${EMAIL})`);
    // Two account members, one listing: the cache holds it for the batch.
    expect(fake.accountLists).toBe(1);

    for (const [pin, text] of [
      [{ machine: "nope" }, 'task 2: pin.machine: no machine named "nope"'],
      [{}, "task 2: pin names neither a machine nor an account"],
    ] as const) {
      const refused = pinRelay();
      // oxlint-disable-next-line no-await-in-loop -- one fake each
      const answer = await callTool(refused, "queue_batch", {
        tasks: [
          { repo: HQ, prompt: "a" },
          { repo: HQ, prompt: "b", pin },
        ],
      });
      expect(answer.error).toBe(true);
      expect(answer.text).toContain(`queue_batch refused: ${text}`);
      expect(refused.creates).toEqual([]);
    }
  });
});

describe("queue_batch", () => {
  const member = (extra: Record<string, unknown> = {}) => ({ repo: "seance", prompt: "do it", ...extra });

  test("queues the members in order under one batch, resolving refs to the ids it minted", async () => {
    const fake = leaderRelay([], reportingMachines());
    const { text, error } = await callTool(fake, "queue_batch", {
      tasks: [
        member({ ref: "schema", title: "Schema", linear: { issue: "ENG-1" } }),
        member({ ref: "api", after: [{ ref: "schema" }] }),
        member({ after: [{ ref: "api", when: "merged" }, { task: PRED }] }),
      ],
    });
    expect(error).toBe(false);
    const [first, second, third] = fake.creates;
    expect(fake.creates).toHaveLength(3);
    const batchId = first?.spec.batch?.id ?? "";
    expect(batchId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(fake.creates.map((t) => t.spec.batch)).toEqual([
      { id: batchId, index: 1 },
      { id: batchId, index: 2 },
      { id: batchId, index: 3 },
    ]);
    expect(first?.spec.deps).toBeUndefined();
    expect(first?.spec.linear).toEqual({ issue: "ENG-1" });
    expect(second?.spec.deps).toEqual([{ task: first?.id ?? "", after: "opened" }]);
    expect(third?.spec.deps).toEqual([
      { task: second?.id ?? "", after: "merged" },
      { task: PRED, after: "opened" },
    ]);
    expect(text).toContain(`batch ${batchId}: 3 tasks queued\n`);
    expect(text).toContain(`task 1 (schema): ${first?.id}`);
    expect(text).toContain(`task 3: ${third?.id}`);
    expect(fake.requests).toEqual([]);
  });

  test("a caller still sending an order or a limit is refused, not given a plain group; auto or none is fine", async () => {
    for (const extra of [
      { strategy: "sequential" },
      { strategy: "parallel", max: 2 },
      { strategy: "bogus" },
      { max: 1 },
    ]) {
      const fake = leaderRelay();
      const refused = await callTool(fake, "queue_batch", { ...extra, tasks: [member(), member()] });
      expect(refused.error).toBe(true);
      expect(refused.text).toContain("no longer orders or limits");
      expect(refused.text).toContain("after");
      expect(fake.creates).toEqual([]);
    }
    const fake = leaderRelay();
    const ok = await callTool(fake, "queue_batch", { strategy: "auto", tasks: [member(), member()] });
    expect(ok.error).toBe(false);
    for (const t of fake.creates) expect(t.spec.batch).not.toHaveProperty("strategy");
  });

  test("a bad ref, a task waiting on itself, or an ambiguous edge refuses the whole batch before anything is stored", async () => {
    const cases: [Record<string, unknown>[], string][] = [
      [
        [member({ after: [{ ref: "later" }] }), member({ ref: "later" })],
        'task 1: after ref "later" is not the ref of an earlier task',
      ],
      [[member({ ref: "me", after: [{ ref: "me" }] })], 'task 1: after ref "me" is not the ref of an earlier task'],
      [[member({ ref: "a" }), member({ ref: "a" })], 'task 2: ref "a" is empty or already used'],
      [[member({ ref: "" })], 'task 1: ref "" is empty or already used'],
      [[member({ after: [{}] })], "task 1: each after entry names exactly one of task and ref"],
      [
        [member({ ref: "a" }), member({ after: [{ ref: "a", task: PRED }] })],
        "task 2: each after entry names exactly one",
      ],
      [[member(), member({ until: "reported", prompt: "" })], 'task 2: until "reported" needs a prompt'],
      [[member(), member({ linear: { issue: "ENG-1", url: "http://x" } })], "task 2: linear.url must be an https: URL"],
    ];
    for (const [tasks, text] of cases) {
      const fake = leaderRelay([], reportingMachines());
      // oxlint-disable-next-line no-await-in-loop -- one fake each
      const answer = await callTool(fake, "queue_batch", { tasks });
      expect(answer.error).toBe(true);
      expect(answer.text).toContain(text);
      expect(fake.creates).toEqual([]);
      expect(fake.started).toBe(0);
    }
  });

  test("an unknown repo on any member refuses the batch before the first create", async () => {
    const fake = leaderRelay();
    const { text, error } = await callTool(fake, "queue_batch", {
      tasks: [member(), member({ repo: "nope" })],
    });
    expect(error).toBe(true);
    expect(text).toContain('task 2: no repo "nope" for the fleet');
    expect(fake.creates).toEqual([]);
  });

  test("a create that fails stops the batch and names the member, with the ids that had already queued", async () => {
    const fake = leaderRelay();
    fake.onCreate = () =>
      fake.creates.length === 2 ? { ok: false, code: "store_full" } : { ok: true, landedEarlier: false };
    const { text, error } = await callTool(fake, "queue_batch", {
      tasks: [member(), member(), member()],
    });
    expect(error).toBe(true);
    expect(fake.creates).toHaveLength(2);
    expect(text).toContain("queue_batch failed at task 2 of 3");
    expect(text).toContain(`already queued: ${fake.creates[0]?.id}`);
    expect(text).toContain(storeErrorText("store_full"));
  });

  test("a failed create keeps the account echoes of the members that had queued, and none for those that had not", async () => {
    const fake = pinRelay();
    fake.onCreate = () =>
      fake.creates.length === 2 ? { ok: false, code: "store_full" } : { ok: true, landedEarlier: false };
    const { text, error } = await callTool(fake, "queue_batch", {
      tasks: [
        { repo: HQ, prompt: "a", pin: { account: "personal" } },
        { repo: HQ, prompt: "b" },
        { repo: HQ, prompt: "c", pin: { account: "personal" } },
      ],
    });
    expect(error).toBe(true);
    expect(text).toContain("queue_batch failed at task 2 of 3");
    expect(text).toContain(`task 1: pinned to account ${PERSONAL} (${EMAIL})`);
    expect(text).not.toContain("task 3: pinned");
  });

  test("a failed auto create does not claim the task was pinned", async () => {
    const fake = pinRelay();
    fake.onCreate = () => ({ ok: false, code: "store_full" });
    const answer = await callAuto(fake, { repo: HQ, pin: { account: "personal" } });
    expect(answer.error).toBe(true);
    expect(answer.text).not.toContain("pinned to account");
  });

  test("reported tasks need a leader that advertises them, as spawn_session does", async () => {
    const old = leaderRelay();
    const { text, error } = await callTool(old, "queue_batch", {
      tasks: [member(), member({ until: "reported" })],
    });
    expect(error).toBe(true);
    expect(text).toContain("leader does not take until: reported / after: done yet");
    expect(old.creates).toEqual([]);

    const current = leaderRelay([], reportingMachines());
    const ok = await callTool(current, "queue_batch", {
      tasks: [member(), member({ until: "reported", after: [{ task: PRED, when: "done" }] })],
    });
    expect(ok.error).toBe(false);
    expect(current.creates[1]?.spec.prompt).toBe(withReportInstruction("do it"));
  });

  test("with no leader the batch still queues and says it waits", async () => {
    const fake = leaderRelay();
    fake.setState({ scheduler: { kind: "none" } });
    const { text, error } = await callTool(fake, "queue_batch", { tasks: [member()] });
    expect(error).toBe(false);
    expect(text).toContain("No scheduler is leading right now");
  });
});

describe("get_queue", () => {
  test("lists the leader's tasks with state, placement and the decision's one line", async () => {
    const fake = leaderRelay([
      { tasks: [running, task({ id: "t-2", spec: { repo: ORIGIN, mode: "worktree", prompt: "next" } })], at: 6_000 },
    ]);
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const result = await client.callTool({ name: "get_queue", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(toolText(result))).toEqual({
      at: new Date(6_000).toISOString(),
      holds: [],
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

  test("shows a task's pin and avoided machines, naming each machine where the fleet knows it and an account by email", async () => {
    const pinned = (id: string, pin: NonNullable<Task["spec"]["pin"]>, avoid?: readonly string[]) =>
      task({
        id,
        state: "ready",
        spec: { repo: ORIGIN, mode: "worktree", pin, ...(avoid === undefined ? {} : { avoid }) },
      });
    const [mac, linux] = autoMachines();
    const machines = [
      mac ?? machine(),
      machine({
        ...linux,
        exclaves: [{ ...exclave("work"), accountId: "org-b:acct-2", email: "me@pengefix.no" }],
      }),
    ];
    const fake = leaderRelay(
      [
        {
          tasks: [
            pinned("t-1", { deviceId: "device-2", account: "org-b:acct-2" }, ["device-1", "device-gone"]),
            pinned("t-2", { deviceId: "device-gone" }),
            pinned("t-3", { account: "org-z:0123456789ab" }),
            task({ id: "t-4", state: "ready" }),
            // Off the registry, but the decision's candidates still name it.
            {
              ...pinned("t-5", { deviceId: "device-lost" }),
              decision: {
                ...decision,
                candidates: [
                  {
                    deviceId: "device-lost",
                    machine: "Lost Box",
                    exclave: "default",
                    rejected: [{ code: "auth_missing" }],
                  },
                ],
              },
            },
          ],
          at: 6_000,
        },
      ],
      machines,
    );
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const { tasks } = JSON.parse(toolText(await client.callTool({ name: "get_queue", arguments: {} })));
    expect(tasks.map((t: { pin?: unknown }) => t.pin)).toEqual([
      { machine: "Linux Box", deviceId: "device-2", account: "me@pengefix.no", accountId: "org-b:acct-2" },
      { deviceId: "device-gone" },
      // No machine reports it and no record names it: a short id.
      { account: "acct 01234567", accountId: "org-z:0123456789ab" },
      undefined,
      { machine: "Lost Box", deviceId: "device-lost" },
    ]);
    expect(tasks[0].avoid).toEqual([{ machine: "MacBook Pro", deviceId: "device-1" }, { deviceId: "device-gone" }]);
    expect(tasks[1]).not.toHaveProperty("avoid");
    // Pins name accounts, so one listing; none is aliased here.
    expect(fake.accountLists).toBe(1);
    lazy.stop();
  });

  test("names a pinned or held account by its alias, and lists nothing for a queue that names no account", async () => {
    const machines = [machine({ exclaves: [signedIn("default", PERSONAL), signedIn("work", EMPLOYER)] })];
    const fake = leaderRelay(
      [
        {
          tasks: [
            task({ id: "t-1", state: "ready", spec: { repo: ORIGIN, mode: "worktree", pin: { account: PERSONAL } } }),
          ],
          holds: [{ account: EMPLOYER, until: "resume", at: 5_000 }],
          at: 6_000,
        },
      ],
      machines,
    );
    fake.accounts = [{ accountId: PERSONAL, alias: "personal", version: 1 }];
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const parsed = JSON.parse(toolText(await client.callTool({ name: "get_queue", arguments: {} })));
    expect(parsed.tasks[0].pin).toEqual({ account: "personal", accountId: PERSONAL });
    expect(parsed.holds[0]).toMatchObject({ account: `${EMAIL} (org org-b)`, accountId: EMPLOYER });
    expect(fake.accountLists).toBe(1);
    lazy.stop();

    // A fresh socket, and a queue naming no account: no listing at all.
    const bare = leaderRelay([{ tasks: [task({ id: "t-2", state: "ready" })], at: 7_000 }], machines);
    bare.accounts = ALIASES;
    const bareLazy = new LazyRelay({ create: () => bare });
    await (await connectedClient(bareLazy)).callTool({ name: "get_queue", arguments: {} });
    expect(bare.accountLists).toBe(0);
    bareLazy.stop();
  });

  test("a finished task has no prompt key, and its placement's window still names it", async () => {
    const finished = task({
      id: "t-9",
      state: "done",
      doneBy: "session",
      assignment: { deviceId: "device-2", exclave: "work", clone: "seance", window: "fix-the-flaky-test" },
    });
    const fake = leaderRelay([{ tasks: [finished], at: 6_000 }]);
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const result = await client.callTool({ name: "get_queue", arguments: {} });
    const [listed] = JSON.parse(toolText(result)).tasks;
    expect(listed).not.toHaveProperty("prompt");
    expect(listed.placement.window).toBe("fix-the-flaky-test");
    lazy.stop();
  });

  test("a failed task's line words a scheduler code and keeps a daemon refusal's own message", async () => {
    const failed = (id: string, code: string, message: string) =>
      task({ id, state: "failed", failure: { code, message } });
    const fake = leaderRelay([
      {
        tasks: [
          failed("t-1", "dispatch_unconfirmed", "the launch ledger no longer reaches back to its reservation"),
          failed("t-2", "repo_not_found", "no such repo"),
          // The leader's own record: its exit status rides beside the message, so the line words it.
          task({
            id: "t-3",
            state: "failed",
            failure: {
              code: "session_failed",
              message: "its session exited with status 137 and reported no pull request",
              exit: 137,
            },
          }),
          // A closed window says all its message does, so the line is the wording alone.
          task({
            id: "t-5",
            state: "failed",
            failure: {
              code: "session_closed",
              message: "its window was closed before its session ended and it reported no pull request",
            },
          }),
          // With the machine's OOM verdict beside it, the line says what the kernel counted.
          task({
            id: "t-4",
            state: "failed",
            failure: {
              code: "session_failed",
              message: "its session exited with status 137 and reported no pull request",
              exit: 137,
              oomKill: true,
            },
          }),
        ],
        at: 6_000,
      },
    ]);
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const result = await client.callTool({ name: "get_queue", arguments: {} });
    const { tasks } = JSON.parse(toolText(result));
    expect(tasks.map((t: { failure: string }) => t.failure)).toEqual([
      `dispatch_unconfirmed: ${taskFailureText("dispatch_unconfirmed")} (the launch ledger no longer reaches back to its reservation)`,
      "repo_not_found: no such repo",
      "session_failed: its session was killed (SIGKILL), possibly out of memory, and reported no pull request",
      "session_closed: its window was closed before its session ended and it reported no pull request",
      "session_failed: its session was killed (SIGKILL), out of memory (the kernel's OOM killer fired as it died), and reported no pull request",
    ]);
    lazy.stop();
  });

  test("shows what holds dispatch, and which tasks are escalated, waiting on someone, or marked done by hand", async () => {
    const [mac, linux] = autoMachines();
    // One person on two orgs: one email, one account half, so each label carries its org.
    const machines = [
      machine({ ...mac, exclaves: [{ ...exclave("default"), accountId: "org-c:acct-2", email: "me@pengefix.no" }] }),
      machine({ ...linux, exclaves: [{ ...exclave("work"), accountId: "org-b:acct-2", email: "me@pengefix.no" }] }),
    ];
    const fake = leaderRelay(
      [
        {
          tasks: [
            task({ id: "t-1", state: "needs-input", escalated: true, needsInputSince: 4_500 }),
            task({ id: "t-2", state: "done", doneBy: "manual" }),
            task({ id: "t-3", state: "done", doneBy: "session" }),
            task({
              id: "t-4",
              state: "ready",
              spec: { repo: ORIGIN, mode: "worktree", pin: { account: "org-c:acct-2" } },
            }),
          ],
          holds: [
            { until: "resume", at: 5_000 },
            { account: "org-b:acct-2", until: "reset", at: 5_500, resumeAt: 9_000 },
            { account: "org-z:0123456789ab", until: "resume", at: 5_600 },
            { account: "org-y:0123456789cd", until: "resume", at: 5_700 },
          ],
          at: 6_000,
        },
      ],
      machines,
    );
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const parsed = JSON.parse(toolText(await client.callTool({ name: "get_queue", arguments: {} })));
    expect(parsed.holds).toEqual([
      { until: "resume", since: new Date(5_000).toISOString() },
      {
        account: "me@pengefix.no (org org-b)",
        accountId: "org-b:acct-2",
        until: "reset",
        since: new Date(5_500).toISOString(),
        resumeAt: new Date(9_000).toISOString(),
      },
      // No machine reports either: short ids, tagged against each other.
      {
        account: "acct 01234567 (org org-z)",
        accountId: "org-z:0123456789ab",
        until: "resume",
        since: new Date(5_600).toISOString(),
      },
      {
        account: "acct 01234567 (org org-y)",
        accountId: "org-y:0123456789cd",
        until: "resume",
        since: new Date(5_700).toISOString(),
      },
    ]);
    const [stuck, manual, finished, pinned] = parsed.tasks;
    expect(stuck).toMatchObject({ escalated: true, needsInputSince: new Date(4_500).toISOString() });
    expect(manual.doneBy).toBe("manual");
    expect(finished.doneBy).toBe("session");
    expect(pinned.pin).toEqual({ account: "me@pengefix.no (org org-c)", accountId: "org-c:acct-2" });
    // One listing for every label in the call: the PWA shares that budget.
    expect(fake.accountLists).toBe(1);
    lazy.stop();
  });

  test("shows a task's dependencies, batch, reported settle and Linear link", async () => {
    const batch = { id: "b-1", index: 2 } as const;
    const fake = leaderRelay([
      {
        tasks: [
          task({
            id: "t-1",
            state: "blocked",
            spec: {
              repo: ORIGIN,
              mode: "worktree",
              until: "reported",
              batch,
              deps: [{ task: "t-0", after: "done" }],
              linear: { issue: "ENG-9" },
            },
          }),
          task({ id: "t-2", state: "running", merged: true }),
          task({ id: "t-3", state: "done", doneBy: "reported" }),
        ],
        at: 6_000,
      },
    ]);
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const { tasks } = JSON.parse(toolText(await client.callTool({ name: "get_queue", arguments: {} })));
    expect(tasks[0]).toMatchObject({
      until: "reported",
      after: [{ task: "t-0", when: "done" }],
      linear: { issue: "ENG-9" },
    });
    expect(tasks[0].batch).toEqual({ id: "b-1", index: 2 });
    expect(tasks[1].merged).toBe(true);
    expect(tasks[2].doneBy).toBe("reported");
    expect(tasks[2]).not.toHaveProperty("until");
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

    const busy = leaderRelay([{ ok: false, code: "not_ready", message: "loading" }]);
    const lazyBusy = new LazyRelay({ create: () => busy });
    const busyClient = await connectedClient(lazyBusy);
    const refused = await busyClient.callTool({ name: "get_queue", arguments: {} });
    expect(toolText(refused)).toContain("get_queue failed (not_ready): the scheduler is still taking over");
    lazyBusy.stop();
  });

  test("both scheduler tools tell the agent the queue survives a leader change", async () => {
    const lazy = new LazyRelay({ create: () => fakeRelay([]) });
    const client = await connectedClient(lazy);
    const { tools } = await client.listTools();
    for (const name of ["spawn_session", "get_queue"]) {
      const description = tools.find((tool) => tool.name === name)?.description ?? "";
      expect(description).toContain("is held by the relay");
      expect(description).toContain("survives leader changes (every relay deploy and daemon self-update)");
      expect(description).not.toContain("backlog");
    }
    expect(tools.find((tool) => tool.name === "get_queue")?.annotations?.readOnlyHint).toBe(true);
    lazy.stop();
  });
});

describe("report_task_done", () => {
  async function call(result: Awaited<ReturnType<typeof reportDone>>): Promise<{ text: string; error: boolean }> {
    const lazy = new LazyRelay({ create: () => fakeRelay([]) });
    const client = await connectedClient(
      lazy,
      null,
      () => {},
      () => Promise.resolve(result),
    );
    const reply = await client.callTool({ name: "report_task_done", arguments: {} });
    lazy.stop();
    return { text: toolText(reply), error: reply.isError === true };
  }

  test("is always offered, takes no input, and is not read-only", async () => {
    const lazy = new LazyRelay({ create: () => fakeRelay([]) });
    const client = await connectedClient(lazy);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "report_task_done");
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.description).toContain("only when the task's prompt asks you to");
    lazy.stop();
  });

  test("an accepted report is a plain answer; a refusal or a missing daemon is a tool error carrying the reason", async () => {
    expect(await call({ ok: true, text: "reported to the scheduler" })).toEqual({
      text: "reported to the scheduler",
      error: false,
    });
    expect(
      await call({ ok: false, text: "this session runs no scheduler task, so there is nothing to report" }),
    ).toEqual({
      text: "this session runs no scheduler task, so there is nothing to report",
      error: true,
    });
    expect((await call({ ok: false, text: "the local daemon is not running" })).error).toBe(true);
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
    expect(big.text).toContain("check get_queue");
    for (const { text } of [crashed, long, big]) expect(text).not.toContain("may have landed");
  });
});

describe("start_task", () => {
  /** The leader (device-1) advertising `runNow` unless held back. */
  function startingMachines(runNow = true): Machine[] {
    const [leader, box] = autoMachines();
    return [machine({ ...leader, ...(runNow ? { capabilities: [CAPABILITIES.runNow] } : {}) }), machine({ ...box })];
  }

  const reserved = task({
    state: "reserved",
    reservation: { deviceId: "device-2", exclave: "work", clone: "seance", expiresAt: 65_000 },
  });

  async function callStart(
    answer: () => unknown,
    machines: readonly Machine[] = startingMachines(),
  ): Promise<{ text: string; error: boolean; fake: FakeRelay }> {
    const fake = fakeRelay(machines, (op) => (op === "run-now" ? answer() : new Error(`unexpected ${op}`)));
    fake.setState({ scheduler: LEADING });
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    try {
      const result = await client.callTool({ name: "start_task", arguments: { taskId: "t-1" } });
      return { text: toolText(result), error: result.isError === true, fake };
    } finally {
      lazy.stop();
    }
  }

  test("sends run-now for the task and says where it is starting", async () => {
    const { text, error, fake } = await callStart(() => ({ task: reserved }));
    expect(error).toBe(false);
    expect(text).toBe("task t-1: started past the queue on Linux Box/work");
    expect(fake.requests).toEqual([{ deviceId: SCHEDULER_ID, op: "run-now", payload: { taskId: "t-1" } }]);
  });

  test("a leader without runNow, or none, is refused with nothing sent", async () => {
    const old = await callStart(() => ({ task: reserved }), startingMachines(false));
    expect(old).toMatchObject({ error: true, text: expect.stringContaining("its daemon needs `seanced update`") });
    expect(old.fake.requests).toEqual([]);
  });

  test("refusals are worded, and a lost answer may have started it", async () => {
    const waiting = await callStart(() => ({ ok: false, code: "not_waiting", message: "not ready" }));
    expect(waiting).toMatchObject({ error: true, text: expect.stringContaining("start_task refused (not_waiting)") });
    const stuck = await callStart(() => ({ ok: false, code: "unplaceable", message: "held" }));
    expect(stuck.text).toContain("something besides the concurrency cap");
    const lost = await callStart(() => new RequestFailure("timeout", "no reply within 10000ms"));
    expect(lost).toMatchObject({
      error: true,
      text: expect.stringContaining("the start may have landed anyway — check get_queue"),
    });
  });

  test("spawn_session start queues the task, reads it ready, then sends run-now for it", async () => {
    const fake = fakeRelay(startingMachines(), (op, payload) => {
      const created = fake.creates[0];
      if (created === undefined) return new Error("no create yet");
      if (op === "queue") return { tasks: [{ ...created, state: "ready" }], at: 6_000 };
      if (op === "run-now") {
        expect(payload).toEqual({ taskId: created.id });
        return { task: { ...reserved, id: created.id } };
      }
      return new Error(`unexpected ${op}`);
    });
    fake.setState({ scheduler: LEADING });
    const { text, error } = await callAuto(fake, { start: true });
    expect(error).toBe(false);
    const id = fake.creates[0]?.id;
    expect(text).toContain(`task ${id}: queued`);
    expect(text).toContain(`task ${id}: started past the queue on Linux Box/work`);
    expect(fake.requests.map((r) => r.op)).toEqual(["queue", "run-now"]);
  });

  test("spawn_session start with a leader that cannot start writes nothing", async () => {
    const fake = leaderRelay([], startingMachines(false));
    const { text, error } = await callAuto(fake, { start: true });
    expect(error).toBe(true);
    expect(text).toContain("spawn refused: start: the scheduler's leader cannot start a task past the queue yet");
    expect(fake.creates).toEqual([]);
  });
});

describe("continue_task", () => {
  const AT = { deviceId: "device-2", exclave: "work", clone: "seance" };
  const failedTask = task({
    id: "t-1",
    state: "failed",
    failure: { code: "session_failed", message: "the session ended with exit 137" },
    spec: { repo: ORIGIN, mode: "worktree", prompt: "fix it", title: "fix-it", model: "opus", effort: "high" },
    assignment: { ...AT, window: "fix-it" },
  });

  /** The leader (device-1) and the machine the task ran on (device-2), each advertising `continueTask` unless held back. */
  function continuingMachines(
    advertising: { readonly leader?: boolean; readonly box?: boolean; readonly cancelled?: boolean } = {},
  ): Machine[] {
    const [leader, box] = autoMachines();
    const advertise = (m: Machine | undefined, on: boolean | undefined, cancelled = false): Machine =>
      machine({
        ...m,
        ...(on === false
          ? {}
          : {
              capabilities: [
                CAPABILITIES.continueTask,
                CAPABILITIES.continueSession,
                ...(cancelled ? [CAPABILITIES.continueCancelled] : []),
              ],
            }),
      });
    return [advertise(leader, advertising.leader), advertise(box, advertising.box, advertising.cancelled)];
  }

  async function callContinue(
    queue: readonly Task[],
    machines: readonly Machine[] = continuingMachines(),
    args: Record<string, unknown> | undefined = undefined,
  ): Promise<{ text: string; error: boolean; fake: ReturnType<typeof fakeRelay>; audited: readonly string[] }> {
    const fake = leaderRelay([{ tasks: queue, at: 6_000 }], machines);
    const lazy = new LazyRelay({ create: () => fake });
    const audited: string[] = [];
    const client = await connectedClient(lazy, null, (line) => {
      audited.push(line);
    });
    try {
      const result = await client.callTool({ name: "continue_task", arguments: args ?? { taskId: "t-1" } });
      return { text: toolText(result), error: result.isError === true, fake, audited };
    } finally {
      lazy.stop();
    }
  }

  test("queues a task that continues the failed one, on exactly where it ran, with the shaping fields carried over", async () => {
    const { text, error, fake, audited } = await callContinue([failedTask], continuingMachines(), {
      taskId: "t-1",
      prompt: "  carry on with the tests  ",
    });
    expect(error).toBe(false);
    const created = fake.creates[0];
    expect(created?.spec).toEqual({
      repo: ORIGIN,
      mode: "continue",
      prompt: "carry on with the tests",
      title: "fix-it",
      model: "opus",
      effort: "high",
      continues: { task: "t-1", at: AT },
      client: "mcp",
    });
    expect(text).toStartWith("continuing task t-1\n");
    expect(text).toContain(`task ${created?.id}: queued`);
    expect(
      audited.some((line) => line.startsWith("audit enqueue origin=mcp") && line.includes('continues="t-1"')),
    ).toBe(true);
    // The leader is asked for the queue only: nothing is dispatched from here.
    expect(fake.requests.map((r) => r.op)).toEqual(["queue"]);
  });

  test("refuses, writing nothing, when the leader or the machine it ran on cannot continue yet", async () => {
    const old = await callContinue([failedTask], continuingMachines({ leader: false }));
    expect(old.error).toBe(true);
    expect(old.text).toContain("the scheduler's leader cannot continue a session yet");
    const oldBox = await callContinue([failedTask], continuingMachines({ box: false }));
    expect(oldBox.error).toBe(true);
    expect(oldBox.text).toContain("can't continue a session yet");
    for (const { fake } of [old, oldBox]) expect(fake.creates).toEqual([]);
    // No verified leader: the leader cannot be confirmed, so nothing is written either.
    const fake = fakeRelay(continuingMachines(), () => ({ tasks: [failedTask], at: 6_000 }));
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const none = await client.callTool({ name: "continue_task", arguments: { taskId: "t-1" } });
    expect(none.isError).toBe(true);
    expect(toolText(none)).toContain("no verified scheduler is leading");
    expect(fake.creates).toEqual([]);
    lazy.stop();
  });

  test("refuses a task the leader does not list, a task that is not a failed session, and a here run", async () => {
    const missing = await callContinue([], continuingMachines());
    expect(missing.error).toBe(true);
    expect(missing.text).toContain(`not in the leader's list (pruned, or past the ${QUEUE_MAX_TASKS} most relevant)`);
    const finished = await callContinue([task({ ...failedTask, state: "done", failure: undefined })]);
    expect(finished.text).toContain(
      "only a task whose session failed or whose window was closed, or that was cancelled after it started, can be continued",
    );
    const hereRun = await callContinue([task({ ...failedTask, spec: { repo: ORIGIN, mode: "here" } })]);
    expect(hereRun.text).toContain("no worktree of its own");
    const other = await callContinue([task({ ...failedTask, failure: { code: "queue_expired", message: "x" } })]);
    expect(other.error).toBe(true);
    for (const { fake } of [missing, finished, hereRun, other]) expect(fake.creates).toEqual([]);
  });

  test("refuses a task something already continues, in any state past the queue, and queues nothing", async () => {
    const continuation = (state: Task["state"]): Task =>
      task({ id: "t-2", state, spec: { repo: ORIGIN, mode: "continue", continues: { task: "t-1", at: AT } } });
    for (const state of ["running", "needs-input", "lost", "awaiting-merge", "done"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one relay at a time
      const held = await callContinue([failedTask, continuation(state)]);
      expect(held.error, state).toBe(true);
      expect(held.text, state).toContain("already underway or finished");
      expect(held.fake.creates, state).toEqual([]);
    }
    // One still waiting withholds it too, and the refusal names it.
    const waiting = await callContinue([failedTask, continuation("queued")]);
    expect(waiting.error).toBe(true);
    expect(waiting.text).toContain("already continuing as task t-2, which is still waiting in the queue");
    expect(waiting.fake.creates).toEqual([]);
    // One the machine refused gives it back.
    const refused = await callContinue([
      failedTask,
      task({ ...continuation("failed"), failure: { code: "not_continuable", message: "x" } }),
    ]);
    expect(refused.error).toBe(false);
  });

  test("a note over the prompt bound is refused before anything is queued, and a malformed id is no task id", async () => {
    const long = await callContinue([failedTask], continuingMachines(), {
      taskId: "t-1",
      prompt: "x".repeat(TASK_REQUEST_LIMITS.prompt + 1),
    });
    expect(long.error).toBe(true);
    expect(long.text).toContain("the prompt is");
    expect(long.fake.creates).toEqual([]);
    const malformed = await callContinue([failedTask], continuingMachines(), { taskId: "a b" });
    expect(malformed.error).toBe(true);
    expect(malformed.text).toContain("is not a task id");
    expect(malformed.fake.requests).toEqual([]);
  });

  test("a keyless box whose daemon predates the broker is told to update, as every scheduler tool is", async () => {
    const double = await startBrokerDouble((raw, id) =>
      isRecord(raw) && raw["action"] === "machines"
        ? brokerOk(id, autoMachines())
        : brokerFail(id, "unsupported", "action is not brokered"),
    );
    try {
      const fleet = selectFleet({
        key: () => Promise.resolve(null),
        direct: () => {
          throw new Error("no key, so no direct path");
        },
        broker: brokerFleet({ path: double.path }),
      });
      const client = await connectedClient(fleet, fakeLocal());
      const result = await client.callTool({ name: "continue_task", arguments: { taskId: "t-1" } });
      expect(result.isError).toBe(true);
      expect(toolText(result)).toContain(SCHEDULER_NEEDS_NEWER_DAEMON);
    } finally {
      await double.stop();
    }
  });

  test("get_queue marks a failed session continuable and names the task a continuation continues", async () => {
    // Refused by the machine: it never held the session, so the old task stays continuable.
    const continuing = task({
      id: "t-2",
      state: "failed",
      failure: { code: "not_continuable", message: "x" },
      spec: { repo: ORIGIN, mode: "continue", continues: { task: "t-1", at: AT } },
    });
    const fake = leaderRelay([{ tasks: [failedTask, continuing], at: 6_000 }], continuingMachines());
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const queue = JSON.parse(toolText(await client.callTool({ name: "get_queue", arguments: {} }))) as {
      tasks: Record<string, unknown>[];
    };
    expect(queue.tasks.find((t) => t["id"] === "t-1")).toMatchObject({ continuable: true });
    expect(queue.tasks.find((t) => t["id"] === "t-1")).not.toHaveProperty("continues");
    expect(queue.tasks.find((t) => t["id"] === "t-2")).toMatchObject({ continues: "t-1" });
    expect(queue.tasks.find((t) => t["id"] === "t-2")).not.toHaveProperty("continuable");
    lazy.stop();
  });

  test("a cancelled task with an assignment is continued only on a box advertising continueCancelled", async () => {
    const cancelled = task({ ...failedTask, state: "cancelled", failure: undefined });
    const queued = await callContinue([cancelled], continuingMachines({ cancelled: true }));
    expect(queued.error).toBe(false);
    expect(queued.fake.creates).toHaveLength(1);
    const refused = await callContinue([cancelled], continuingMachines());
    expect(refused.error).toBe(true);
    expect(refused.text).toContain("continue a cancelled session");
    expect(refused.fake.creates).toEqual([]);
  });

  test("get_queue moves continuable to a continuation that failed after landing", async () => {
    const y = task({
      id: "t-2",
      state: "failed",
      failure: { code: "session_failed", message: "exit 137" },
      assignment: { ...AT, window: "fix-it" },
      spec: { repo: ORIGIN, mode: "continue", continues: { task: "t-1", at: AT } },
    });
    const fake = leaderRelay([{ tasks: [failedTask, y], at: 6_000 }], continuingMachines());
    const lazy = new LazyRelay({ create: () => fake });
    const client = await connectedClient(lazy);
    const queue = JSON.parse(toolText(await client.callTool({ name: "get_queue", arguments: {} }))) as {
      tasks: Record<string, unknown>[];
    };
    expect(queue.tasks.find((t) => t["id"] === "t-1")).not.toHaveProperty("continuable");
    expect(queue.tasks.find((t) => t["id"] === "t-2")).toMatchObject({ continuable: true });
    lazy.stop();
  });

  test("get_queue withdraws continuable while a continuation waits and once one has the session", async () => {
    for (const state of ["ready", "running"] as const) {
      const underway = task({
        id: "t-2",
        state,
        spec: { repo: ORIGIN, mode: "continue", continues: { task: "t-1", at: AT } },
      });
      const fake = leaderRelay([{ tasks: [failedTask, underway], at: 6_000 }], continuingMachines());
      const lazy = new LazyRelay({ create: () => fake });
      // oxlint-disable-next-line no-await-in-loop -- one relay at a time
      const client = await connectedClient(lazy);
      // oxlint-disable-next-line no-await-in-loop -- one relay at a time
      const queue = JSON.parse(toolText(await client.callTool({ name: "get_queue", arguments: {} }))) as {
        tasks: Record<string, unknown>[];
      };
      expect(
        queue.tasks.find((t) => t["id"] === "t-1"),
        state,
      ).not.toHaveProperty("continuable");
      lazy.stop();
    }
  });
});
