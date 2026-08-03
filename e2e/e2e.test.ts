import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry, SpawnResponse } from "@seance/shared";
import { exec } from "../daemon/src/exec.ts";
import { pollUntil } from "../daemon/test/fixtures.ts";
import type { AppState } from "../pwa/src/view.ts";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { RelayClient } from "@seance/shared";
import { buildMcpServer, LazyRelay } from "../daemon/src/mcp.ts";
import { killWindow, listWindows, ownMachine, startApp, startStack, TOKEN, wsUrl, type Stack } from "./harness.ts";

/**
 * The one suite where all three components are real: seanced from daemon/src,
 * the Worker + Durable Object under workerd, and the app's RelayClient + Store.
 * Every pairwise seam has its own suite; what lives here is the composition —
 * the flows a user actually performs, end to end.
 */

let base: string;
let stack: Stack;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-e2e-"));
  process.env["SEANCE_STATE_DIR"] = join(base, "state");
  process.env["SEANCE_TMUX_SOCKET"] = `seance-e2e-${process.pid}`;
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "claude-config");
  stack = await startStack(base);
});

afterAll(async () => {
  // startStack failing in beforeAll leaves stack unset; a teardown TypeError
  // here would mask the real error.
  await stack?.dispose();
  delete process.env["SEANCE_STATE_DIR"];
  delete process.env["SEANCE_TMUX_SOCKET"];
  delete process.env["SEANCE_CLAUDE_BIN"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  await rm(base, { recursive: true, force: true });
});

// Store.spawn() silently no-ops unless the machine entry already carries the
// repo — the daemon registers before its scan finishes, so `connected` alone
// is a spawn-shaped race, not readiness.
function spawnReady(state: AppState): boolean {
  const machine = ownMachine(state, stack.deviceId);
  return machine?.connected === true && machine.repos.some((r) => r.name === "myrepo");
}

describe("daemon ↔ relay ↔ app", () => {
  test("machine appears decrypted and sessions fan out on connect", async () => {
    const app = startApp(stack);
    try {
      const state = await app.waitForApp(
        (s) => ownMachine(s, stack.deviceId)?.repos.some((r) => r.name === "myrepo") ?? false,
        "machine with myrepo",
      );
      const machine = ownMachine(state, stack.deviceId);
      expect(machine?.name).toBe("TestMac");
      expect(machine?.platform).toBe(process.platform);
      expect(machine?.connected).toBe(true);
      expect(machine?.repos.find((r) => r.name === "myrepo")?.defaultBranch).toBe("main");

      // Store's on-connect fan-out asked the real daemon, which asked real
      // tmux: a resolved answer, never the "unknown" placeholder.
      const withSessions = await app.waitForApp(
        (s) => typeof s.sessions[stack.deviceId] === "object",
        "sessions answered",
      );
      const view = withSessions.sessions[stack.deviceId];
      if (typeof view !== "object") throw new Error("unreachable");
      expect(view.sessions).toEqual([]);
      expect(view.at).toBeGreaterThan(0);
    } finally {
      app.stop();
    }
  });

  test("spawn happy path: worktree mode lands a verdict and a real tmux window", async () => {
    const app = startApp(stack, {
      machineId: stack.deviceId,
      repos: { [stack.deviceId]: "myrepo" },
      prompt: "port the pane",
      worktree: true,
    });
    let window: string | null = null;
    try {
      await app.waitForApp(spawnReady, "machine ready to spawn");
      await app.store.spawn();

      const { verdict, form } = app.store.getState();
      if (verdict?.kind !== "ok") throw new Error(`expected ok verdict, got ${JSON.stringify(verdict)}`);
      window = verdict.window;
      expect(window).toBe("port-the-pane");
      expect(form.prompt).toBe("");

      // Not just a verdict: the window is really running on the tmux server.
      expect(await listWindows()).toContain(window);

      // The reply embeds a refreshed session list and the Store adopts it.
      const sessions = sessionsView(app.store.getState(), stack.deviceId);
      const entry = sessions.find((s) => s.window === window);
      expect(entry?.repo).toBe("myrepo");
    } finally {
      if (window !== null) await killWindow(window);
      app.stop();
    }
  });

  test("spawn failure: claude dying becomes a failed verdict carrying the captured error", async () => {
    const app = startApp(stack, {
      machineId: stack.deviceId,
      repos: { [stack.deviceId]: "myrepo" },
      prompt: "doomed",
      worktree: false,
    });
    process.env["SEANCE_CLAUDE_BIN"] = stack.stub.failing;
    try {
      // Only a death is asserted here, and the daemon reports one as soon as the pane
      // goes — the budget is the deadline for calling a corpse alive, so it is generous
      // rather than tight. At the default it read the stub's bash + sleep 0.3 as a live
      // session whenever the other shards were competing for the CPU.
      // Well under the runner's 15s per-test timeout: if the stub is slower than even
      // this, the assertion below has to be what reports it, not a killed test whose
      // finally never restores the default budget for the spawns that follow.
      await stack.restartDaemon({ spawnWaitMs: 8_000 });
      await app.waitForApp(spawnReady, "machine ready to spawn");
      await app.store.spawn();

      const { verdict } = app.store.getState();
      if (verdict?.kind !== "failed") throw new Error(`expected failed verdict, got ${JSON.stringify(verdict)}`);
      expect(verdict.code).toBe("claude_died");
      expect(verdict.message).toContain("boom: untrusted workspace");

      // The daemon killed the dead window rather than leaving a corpse.
      expect(await listWindows()).not.toContain("doomed");
    } finally {
      process.env["SEANCE_CLAUDE_BIN"] = stack.stub.ok;
      app.stop();
      // Back to the default, or every later spawn in this file pays 15s to be called alive.
      await stack.restartDaemon();
    }
  });

  test("dropped reply mid-spawn: reconciliation asks the machine and finds the live session", async () => {
    const form = {
      machineId: stack.deviceId,
      repos: { [stack.deviceId]: "myrepo" },
      prompt: "recover me",
      worktree: false,
    };
    const app = startApp(stack, form);
    let recovered: ReturnType<typeof startApp> | null = null;
    let window: string | null = null;
    try {
      await app.waitForApp(spawnReady, "machine ready to spawn");

      // Close the app after the request is in flight but well before the
      // daemon's reply (>= 1500ms spawnWaitMs) — the iOS-kill-mid-spawn shape.
      const spawning = app.store.spawn();
      await Bun.sleep(300);
      app.stop();
      await spawning;

      const { verdict } = app.store.getState();
      if (verdict?.kind !== "unknown") throw new Error(`expected unknown verdict, got ${JSON.stringify(verdict)}`);
      expect(verdict.reason).toBe("dropped");
      const pending = app.store.pendingSpawn;
      expect(pending).not.toBeNull();

      // Let the daemon finish the spawn nobody heard the answer to (its
      // window exists from new-window time, well before the verdict).
      await pollUntil(async () => {
        window = (await listWindows()).find((name) => name === "recover-me") ?? null;
        return window !== null;
      }, "the recover-me window on the tmux server");

      // Relaunch: a fresh client + Store seeded with the persisted pending
      // spawn, exactly main.tsx's readPending() path.
      recovered = startApp(stack, form, pending);
      const state = await recovered.waitForApp(
        (s) => s.verdict?.kind === "unknown" && s.verdict.sessionCount !== null,
        "reconciled verdict",
      );
      if (state.verdict?.kind !== "unknown") throw new Error("unreachable");
      expect(state.verdict.reason).toBe("dropped");
      expect(state.verdict.sessionCount).toBeGreaterThanOrEqual(1);
      expect(sessionsView(state, stack.deviceId).some((s) => s.window === window)).toBe(true);
    } finally {
      if (window !== null) await killWindow(window);
      recovered?.stop();
      app.stop();
    }
  });

  test("resume: re-dialling re-asks every machine, so a session started elsewhere is picked up", async () => {
    const app = startApp(stack, { machineId: stack.deviceId });
    let window: string | null = null;
    try {
      await app.waitForApp((s) => typeof s.sessions[stack.deviceId] === "object", "sessions answered");

      // Straight down the transport, bypassing the Store: what a `seanced spawn`
      // at the machine, or another device's session, looks like from here.
      const reply = await app.client.request<SpawnResponse>(stack.deviceId, "spawn", {
        repo: "myrepo",
        mode: "here",
        title: "elsewhere",
      });
      if (!reply.ok) throw new Error(`spawn failed: ${reply.message}`);
      window = reply.window;
      expect(sessionsView(app.store.getState(), stack.deviceId).some((s) => s.window === window)).toBe(false);

      // attach()'s visibilitychange handler does exactly this: an installed PWA
      // is suspended constantly and the socket dies without a close frame, so a
      // resume re-dials whether or not the old one looked alive.
      app.client.reconnect();
      const state = await app.waitForApp(
        (s) => sessionsFor(s, stack.deviceId).some((entry) => entry.window === window),
        "sessions re-asked after re-dialling",
      );
      expect(sessionsFor(state, stack.deviceId).find((s) => s.window === window)?.repo).toBe("myrepo");
    } finally {
      if (window !== null) await killWindow(window);
      app.stop();
    }
  });

  test("rescan: a new clone reaches the app through re-register and a registry push", async () => {
    const app = startApp(stack, { machineId: stack.deviceId });
    const clonePath = join(stack.fixture.root, "newrepo");
    try {
      await app.waitForApp(
        (s) => ownMachine(s, stack.deviceId)?.repos.some((r) => r.name === "myrepo") ?? false,
        "machine with myrepo",
      );
      const cloned = await exec(["git", "clone", stack.fixture.barePath, clonePath]);
      expect(cloned.exitCode).toBe(0);

      // The raw request, not store.rescan(): the store folds the reply into the
      // machine itself, which would satisfy the assertion below without the
      // re-register and registry push this test exists to measure.
      await app.client.request(stack.deviceId, "rescan", {});
      await app.waitForApp(
        (s) => ownMachine(s, stack.deviceId)?.repos.some((r) => r.name === "newrepo") ?? false,
        "machine with newrepo",
      );
    } finally {
      await rm(clonePath, { recursive: true, force: true });
      // Rescan again so later tests see the fixture's real repo set.
      await app.client.request(stack.deviceId, "rescan", {}).catch(() => {});
      app.stop();
    }
  });

  test("daemon restart: presence flips offline (refusing sends) then back online, same identity", async () => {
    const app = startApp(stack);
    try {
      await app.waitForApp((s) => ownMachine(s, stack.deviceId)?.connected === true, "machine online");
      stack.daemon.stop();
      await app.waitForApp((s) => ownMachine(s, stack.deviceId)?.connected === false, "machine offline");

      // The DO answers a send to the dead daemon with a real undeliverable.
      await expect(app.client.request(stack.deviceId, "spawn", { repo: "myrepo", mode: "here" })).rejects.toMatchObject(
        { reason: "offline" },
      );
    } finally {
      await stack.restartDaemon();
      app.stop();
    }

    const verify = startApp(stack);
    try {
      const state = await verify.waitForApp(
        (s) =>
          (ownMachine(s, stack.deviceId)?.connected ?? false) &&
          (ownMachine(s, stack.deviceId)?.repos.some((r) => r.name === "myrepo") ?? false),
        "machine back online",
      );
      // Same state dir, same deviceId: the registry updated one entry in
      // place instead of growing a ghost machine.
      expect(state.relay.machines.filter((m) => m.deviceId === stack.deviceId)).toHaveLength(1);
    } finally {
      verify.stop();
    }
  });
});

function sessionsView(state: AppState, deviceId: string): readonly SessionEntry[] {
  const view = state.sessions[deviceId];
  if (view === undefined || view === "unknown") throw new Error(`no sessions view for ${deviceId}`);
  return view.sessions;
}

/** As above but tolerant, for predicates that run while an answer is still outstanding. */
function sessionsFor(state: AppState, deviceId: string): readonly SessionEntry[] {
  const view = state.sessions[deviceId];
  return view === undefined || view === "unknown" ? [] : view.sessions;
}

describe("mcp ↔ relay ↔ daemon", () => {
  test("the MCP tools list, spawn, and see the session — over the real relay", async () => {
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
    serveStdio(() => buildMcpServer(lazy), { transport: serverTransport });
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

      const spawned = await text("spawn_session", {
        machine: "TestMac",
        repo: "myrepo",
        prompt: "haunt the relay",
      });
      window = "haunt-the-relay";
      expect(spawned).toContain("spawned window haunt-the-relay on TestMac");
      expect(await listWindows()).toContain(window);

      const sessions = await text("get_sessions", { machine: "TestMac" });
      expect(JSON.parse(sessions).map((entry: SessionEntry) => entry.window)).toContain(window);
    } finally {
      if (window !== null) await killWindow(window);
      await client.close();
      lazy.stop();
    }
  });
});
