import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_ROLES,
  liveStatus,
  SCHEDULER_ID,
  signRegister,
  newestQuotaByAccount,
  type QueueChanged,
  type QueueReply,
  type RegistryView,
  type RelayToAppFrame,
  type SchedulerLeader,
  type SessionEntry,
  type SpawnResponse,
} from "@seance/shared";
import { deregisterMachine } from "../daemon/src/deregister.ts";
import { exec } from "../daemon/src/exec.ts";
import { identityOfState, readState } from "../daemon/src/state.ts";
import { localSocketReachable } from "../daemon/src/local-client.ts";
import { pollUntil, usePrivateTmux, type PrivateTmux } from "../daemon/test/fixtures.ts";
import { connectApp, connectDaemon, newDeviceId, register } from "../relay/test/harness.ts";
import { deriveMachines } from "../pwa/src/machines-view.ts";
import { deriveView, type AppState } from "../pwa/src/view.ts";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { RelayClient } from "@seance/shared";
import { LazyRelay } from "../daemon/src/app-relay.ts";
import { brokerFleet, relayFleet, selectFleet } from "../daemon/src/fleet.ts";
import { tmux, tmuxOk } from "../daemon/src/tmux.ts";
import { buildMcpServer, localMachine, type LocalMachine } from "../daemon/src/mcp.ts";
import {
  E2E_ACCOUNT_ID,
  killWindow,
  listRegisteredWindows,
  listWindows,
  ownMachine,
  startApp,
  startStack,
  TOKEN,
  wsUrl,
  type SecondDaemon,
  type Stack,
} from "./harness.ts";

/**
 * The one suite where all three components are real: seanced from daemon/src,
 * the Worker + Durable Object under workerd, and the app's RelayClient + Store.
 * Every pairwise seam has its own suite; what lives here is the composition —
 * the flows a user actually performs, end to end.
 */

let base: string;
let privateTmux: PrivateTmux | undefined;
let stack: Stack;
/** A listed machine's seed, copied out without the PSK: the reader check's case once the allowlist holds. */
let stolenSeedId: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-e2e-"));
  process.env["SEANCE_STATE_DIR"] = join(base, "state");
  privateTmux = usePrivateTmux(base, "e2e");
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "claude-config");
  stolenSeedId = await newDeviceId();
  // Observed well before any second machine's reading, so that one is the newest.
  stack = await startStack(base, [{ id: "default", observedAtMs: Date.now() - 10 * 60_000, fiveHourPct: 20 }], {
    secondLeaders: ["LeaderBox"],
    leaders: [stolenSeedId],
  });
});

afterAll(async () => {
  // startStack failing in beforeAll leaves stack unset; a teardown TypeError
  // here would mask the real error.
  try {
    await stack?.dispose();
  } finally {
    // A relay teardown error must not leave the server (and its claude stub) running.
    await privateTmux?.dispose();
  }
  delete process.env["SEANCE_STATE_DIR"];
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

  test("status: the real daemon's snapshot reaches a fresh app in its first push, through the DO", async () => {
    const app = startApp(stack);
    try {
      // Sent after every register, so it is on the relay before this app
      // dials: no beat to wait for. Numbers are the host's, so only their
      // shape is asserted.
      const state = await app.waitForApp((s) => ownMachine(s, stack.deviceId)?.status !== undefined, "status rendered");
      const machine = ownMachine(state, stack.deviceId);
      const status = machine?.status;
      if (machine === null || status === undefined) throw new Error("unreachable");
      expect(status.at * 1000).toBeGreaterThan(Date.now() - 120_000);
      expect(status.scan).toBe(machine.scannedAt);
      expect(status.mem).toBeGreaterThanOrEqual(0);
      expect(status.mem).toBeLessThanOrEqual(100);
      expect(status.sess?.length).toBeGreaterThan(0);
      // The machines screen renders pressure and the exclave rows from that push alone.
      const card = deriveMachines(state.relay.machines, Date.now()).cards.find((c) => c.deviceId === stack.deviceId);
      expect(card?.gauges.map((gauge) => gauge.label)).toContain("Memory");
      expect(card?.exclaves.map((row) => row.id)).toContain("default");
    } finally {
      app.stop();
    }
  });

  // The M2 exit for the kept status (docs/scheduler.md): an asleep machine's
  // accounts keep their quota, its pressure is unknown, and the register that
  // replaces the blob the status indexes takes the kept one away.
  test("status: kept through a disconnect as quota, never pressure, and cleared by the next register", async () => {
    const app = startApp(stack);
    // A raw socket beside the app, to see the register's own push before the
    // status the daemon sends right after it lands.
    const raw = await connectApp(stack.relay);
    const { deviceId } = stack;
    const rawEntry = async (connected: boolean): Promise<RegistryView> => {
      for (;;) {
        const frame = await raw.waitFor<Extract<RelayToAppFrame, { t: "registry" }>>("registry", 10_000);
        const entry = frame.entries.find((candidate) => candidate.deviceId === deviceId);
        if (entry?.connected === connected) return entry;
      }
    };
    let restored = false;
    try {
      await app.waitForApp(
        (s) => ownMachine(s, stack.deviceId)?.status?.quota !== undefined,
        "a status carrying quota",
      );
      stack.daemon.stop();
      const asleep = await app.waitForApp((s) => ownMachine(s, stack.deviceId)?.connected === false, "machine offline");
      const machine = ownMachine(asleep, stack.deviceId);
      if (machine === null) throw new Error("unreachable");
      expect(machine.status?.quota).toBeDefined();
      expect(liveStatus(machine)).toBeUndefined();
      expect(newestQuotaByAccount(asleep.relay.machines).get(E2E_ACCOUNT_ID)?.deviceId).toBe(stack.deviceId);
      const view = deriveMachines(asleep.relay.machines, Date.now());
      expect(view.cards.find((c) => c.deviceId === stack.deviceId)?.gauges).toEqual([]);
      const account = view.accounts.find((a) => a.accountId === E2E_ACCOUNT_ID);
      expect(account?.observed).toEndWith("on TestMac, asleep");
      expect(account?.bars.map((bar) => [bar.label, bar.pct])).toEqual([["5h", 20]]);
      // Drained to the close's push, so the next connected one is the register's.
      expect((await rawEntry(false)).status).toBeDefined();

      await stack.restartDaemon();
      expect((await rawEntry(true)).status).toBeUndefined();
      // Then the daemon's next status, live again.
      await app.waitForApp((s) => {
        const back = ownMachine(s, stack.deviceId);
        return back !== null && back.connected && liveStatus(back) !== undefined;
      }, "a live status after the register");
      restored = true;
    } finally {
      if (!restored) {
        await stack.restartDaemon();
        await app
          .waitForApp((s) => ownMachine(s, stack.deviceId)?.connected === true, "machine restored")
          .catch(() => undefined);
      }
      raw.close();
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

      // Let the daemon finish the spawn nobody heard the answer to. The window
      // exists from new-window time, well before the verdict, but the session
      // list admits it only once the stub has titled its pane — and that list
      // is what the relaunched app asks for.
      await pollUntil(async () => {
        window = (await listRegisteredWindows()).find((name) => name === "recover-me") ?? null;
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

  test("taskId: advertised, listed with the session, and a duplicate refused — before and after a daemon restart", async () => {
    const app = startApp(stack, { machineId: stack.deviceId });
    let window: string | null = null;
    try {
      const ready = await app.waitForApp((s) => ownMachine(s, stack.deviceId)?.connected === true, "machine online");
      expect(ownMachine(ready, stack.deviceId)?.capabilities).toContain("taskId");

      const spawn = { repo: "myrepo", mode: "here", title: "tracked", taskId: "e2e-task" } as const;
      const reply = await app.client.request<SpawnResponse>(stack.deviceId, "spawn", spawn);
      if (!reply.ok) throw new Error(`spawn failed: ${reply.message}`);
      window = reply.window;
      const entry = reply.sessions.find((s) => s.window === window);
      expect(entry?.taskId).toBe("e2e-task");

      const duplicate = await app.client.request<SpawnResponse>(stack.deviceId, "spawn", { ...spawn, title: "dup" });
      expect(duplicate).toMatchObject({ ok: false, code: "task_running", id: entry?.id });

      // A restarted daemon has nothing in memory; the pane is what still says the task is running.
      await stack.restartDaemon();
      await app.waitForApp((s) => ownMachine(s, stack.deviceId)?.connected === true, "machine back online");
      const afterRestart = await app.client.request<SpawnResponse>(stack.deviceId, "spawn", { ...spawn, title: "dup" });
      expect(afterRestart).toMatchObject({ ok: false, code: "task_running", id: entry?.id });
      expect(await listWindows()).not.toContain("dup");
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

  // A config blanked or never filled in (`init` writes the skeleton "wss://")
  // reaches here as a string loadConfig accepts and `new URL` rejects. Uninstall
  // has already stopped the service by then, so a throw would skip removing the
  // links — the outcome must be a reported failure, never an exception.
  test("an unusable relayUrl fails the deregistration instead of throwing", async () => {
    for (const relayUrl of ["", "wss://", "not a url"]) {
      const outcome = await deregisterMachine({ ...stack.config, relayUrl }, stack.deviceId);
      expect(outcome.kind).toBe("failed");
    }
  });

  // Last in this describe: it deletes the shared stack's registry entry, which
  // every test above assumes is there.
  test("uninstall deregisters: the entry leaves the registry, and a fresh install brings it back", async () => {
    const app = startApp(stack);
    let restored = false;
    try {
      await app.waitForApp((s) => ownMachine(s, stack.deviceId)?.connected === true, "machine online");
      // The order `uninstall` relies on: while the service still holds a socket
      // the relay refuses, which is why the CLI stops it first.
      expect(await deregisterMachine(stack.config, stack.deviceId)).toEqual({ kind: "connected" });

      stack.daemon.stop();
      await app.waitForApp((s) => ownMachine(s, stack.deviceId)?.connected === false, "machine offline");

      expect(await deregisterMachine(stack.config, stack.deviceId)).toEqual({ kind: "forgotten" });
      await app.waitForApp((s) => ownMachine(s, stack.deviceId) === null, "entry gone from the app");
      // Idempotent: an uninstall run twice reports nothing to delete, not a failure.
      expect(await deregisterMachine(stack.config, stack.deviceId)).toEqual({ kind: "absent" });

      await stack.restartDaemon();
      // Waited for, not just started: the suites after this one open with a spawn,
      // and a daemon still mid-register reads to them as a machine that is asleep.
      await app.waitForApp((s) => ownMachine(s, stack.deviceId)?.connected === true, "machine back after reinstall");
      restored = true;
    } finally {
      if (!restored) {
        await stack.restartDaemon();
        await app
          .waitForApp((s) => ownMachine(s, stack.deviceId)?.connected === true, "machine restored")
          .catch(() => undefined);
      }
      app.stop();
    }
    // Longer budget than the rest: proving the refusal spends the retry window
    // (three attempts, a second apart) before anything else happens.
  }, 30_000);
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
  test("the MCP tools list, spawn, see and despawn the session — over the real relay", async () => {
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

      const spawned = await text("spawn_session", {
        machine: "TestMac",
        repo: "myrepo",
        prompt: "haunt the relay",
      });
      window = "haunt-the-relay";
      expect(spawned).toContain("spawned window haunt-the-relay on TestMac");
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

  test("a self-targeted spawn goes over the local socket, with the relay unreachable throughout", async () => {
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
        throw new Error("the relay must not be touched by a local spawn");
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

    let window: string | null = null;
    try {
      const spawned = await text("spawn_session", {
        machine: "TestMac",
        repo: "myrepo",
        prompt: "skip the relay",
      });
      window = "skip-the-relay";
      expect(spawned).toContain("spawned window skip-the-relay on TestMac");
      // A real window, from the same backend the relay path uses.
      expect(await listWindows()).toContain(window);

      const sessions = await text("get_sessions", { machine: "TestMac" });
      expect(JSON.parse(sessions).map((entry: SessionEntry) => entry.window)).toContain(window);

      // And the fleet view still needs the relay, so it degrades to this box.
      const listed = JSON.parse(await text("list_machines", {})) as {
        machines: { name: string; local: boolean }[];
      };
      expect(listed.machines).toEqual([expect.objectContaining({ name: "TestMac", local: true })]);
    } finally {
      if (window !== null) await killWindow(window);
      await client.close();
      dead.stop();
    }
  });
});

describe("two daemons ↔ relay ↔ app", () => {
  test("status: a fresh app sees both machines' pressure, and one account folded across them", async () => {
    // The account sits at a different exclave index on each machine — `default`
    // here, `work` (after a signed-out `default`) there — so the fold has to
    // resolve each status's indexes against its own blob.
    const second = await stack.startSecondDaemon({
      name: "StatusBox",
      exclaves: [{ id: "work", observedAtMs: Date.now() - 60_000, fiveHourPct: 64 }],
    });
    const app = startApp(stack);
    try {
      const ids = [stack.deviceId, second.deviceId];
      const state = await app.waitForApp(
        (s) => ids.every((id) => ownMachine(s, id)?.status?.quota !== undefined),
        "both machines with a status carrying quota",
      );
      expect(
        state.relay.machines
          .filter((machine) => machine.connected)
          .map((machine) => machine.deviceId)
          .toSorted(),
      ).toEqual(ids.toSorted());
      for (const id of ids) {
        const machine = ownMachine(state, id);
        const status = machine?.status;
        if (machine === null || status === undefined) throw new Error("unreachable");
        // Each status indexes its own machine's blob, not the other's.
        expect(status.scan).toBe(machine.scannedAt);
        expect(status.sess?.length).toBe(machine.exclaves?.length);
      }
      expect(ownMachine(state, second.deviceId)?.exclaves?.map((exclave) => exclave.id)).toEqual(["default", "work"]);

      const view = deriveMachines(state.relay.machines, Date.now());
      for (const id of ids) {
        const card = view.cards.find((c) => c.deviceId === id);
        expect(card?.gauges.map((gauge) => gauge.label)).toContain("Memory");
      }
      const account = view.accounts.find((a) => a.accountId === E2E_ACCOUNT_ID);
      // Both machines' exclaves, in fleet order — the registry's, not boot order.
      expect(account?.title.split(" · ").toSorted()).toEqual(["default", "work"]);
      expect(account?.detail).toContain("TestMac");
      expect(account?.detail).toContain("StatusBox");
      // StatusBox read the account nine minutes after TestMac did: its numbers win.
      expect(account?.observed).toEndWith("on StatusBox");
      expect(account?.bars.map((bar) => [bar.label, bar.pct])).toEqual([["5h", 64]]);
    } finally {
      app.stop();
      await second.stop();
    }
  });
});

/**
 * The latest registry push as a bearer-token holder reads it, off a bare app
 * socket: the raw leader record (with its proof) and entries the app's
 * RelayClient only shows once they open.
 */
function watchLeader(): {
  readonly current: () => SchedulerLeader | null;
  readonly connected: (deviceId: string) => boolean;
  readonly entry: (deviceId: string) => RegistryView | undefined;
  readonly close: () => void;
} {
  const url = new URL(wsUrl(stack.relay, "/app"));
  url.searchParams.set("t", TOKEN);
  const ws = new WebSocket(url.href, { perMessageDeflate: false });
  let latest: Extract<RelayToAppFrame, { t: "registry" }> | null = null;
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string" || event.data === "pong") return;
    const frame = JSON.parse(event.data) as RelayToAppFrame;
    if (frame.t === "registry") latest = frame;
  });
  return {
    current: () => latest?.scheduler ?? null,
    connected: (deviceId) => latest?.entries.some((entry) => entry.deviceId === deviceId && entry.connected) === true,
    entry: (deviceId) => latest?.entries.find((entry) => entry.deviceId === deviceId),
    close: () => ws.close(),
  };
}

describe("scheduler leadership ↔ real daemons", () => {
  test("real daemons are nominated, a stopped leader hands over under a higher term, and a returning one follows", async () => {
    const watch = watchLeader();
    const second = await stack.startSecondDaemon({ name: "LeaderBox" });
    let down = false;
    try {
      // The suite's own daemon has been connected longest.
      await pollUntil(() => watch.current()?.deviceId === stack.deviceId, "the suite's daemon to lead");
      const term = watch.current()?.term ?? 0;

      // Stopped and kept down until the handover shows, not restarted outright:
      // a redial that registers before the relay has processed its old socket's
      // close finds itself still a candidate, and a current leader keeps the
      // role across its own reconnect — on a fast runner, every time.
      stack.daemon.stop();
      down = true;
      await pollUntil(
        () => watch.current()?.deviceId === second.deviceId && (watch.current()?.term ?? 0) > term,
        "the second daemon to take over",
        10_000,
      );
      const handedOver = watch.current()?.term ?? 0;
      await stack.restartDaemon();
      down = false;
      // The first daemon is back, and connected later: it follows.
      await pollUntil(() => watch.connected(stack.deviceId), "the restarted daemon to reconnect", 10_000);
      expect(watch.current()).toMatchObject({ deviceId: second.deviceId, term: handedOver });
      await pollUntil(
        async () => (await Bun.file(second.log).text()).includes(`relay says lead term=${handedOver}`),
        "the second daemon to log its lead",
      );
    } finally {
      // The suites after this one need the stack's own daemon up.
      if (down) await stack.restartDaemon();
      await second.stop();
      watch.close();
    }
  });
});

/** The origin key the fixture clone is listed under, once a machine has listed its repos. */
function fixtureOrigin(state: AppState): string | null {
  return state.relay.machines.flatMap((m) => m.repos).find((repo) => repo.origin !== undefined)?.origin ?? null;
}

/** Single-quoted for `sh -c`, as `spawn.ts` quotes its one shell string. */
function q(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

describe("session event: mod's CLI ↔ remote daemon ↔ relay ↔ leader", () => {
  // The double spawn item 5 closes, end to end: a task reserved on machine B
  // whose spawn reply never came, and whose session reports itself ended.
  test("a session's ended event on another machine resolves the leader's reservation as done", async () => {
    const taskId = "e2e-event-task";
    let second: SecondDaemon | null = null;
    let pane: string | null = null;
    try {
      // B's id first: booted once to mint it, then down, so the suite's daemon
      // leads alone and takes the task over finding no session for it.
      const minted = await stack.startSecondDaemon({ name: "EventBox" });
      const b = minted.deviceId;
      await minted.stop();
      await stack.seedTask({
        id: taskId,
        spec: { repo: "github.com/acme/app", mode: "worktree" },
        state: "reserved",
        createdAt: Date.now(),
        reservation: { deviceId: b, exclave: "default", clone: "app", expiresAt: Date.now() + 600_000 },
      });
      await stack.restartDaemon();
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      expect((await stack.queue().get(taskId))?.body?.state).toBe("reserved");
      // Same state dir, same id; connected later, so it follows.
      second = await stack.startSecondDaemon({ name: "EventBox" });
      expect(second.deviceId).toBe(b);

      // A pane carrying the task whose process sends `ended` through the real
      // CLI to B's op socket: B binds it by peer pid and forwards it sealed to
      // the scheduler, and the relay routes it to the leader.
      const input = join(base, "event.json");
      await Bun.write(input, JSON.stringify({ state: "ended" }));
      const go = join(base, "event.go");
      const main = join(import.meta.dir, "..", "daemon", "src", "main.ts");
      // A session of its own: B's opens only with its first spawn.
      const created = await tmuxOk([
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-s",
        "e2e-event-sender",
        "-c",
        stack.fixture.root,
        "-e",
        `SEANCE_STATE_DIR=${second.stateDir}`,
        "sh",
        "-c",
        `while [ ! -e ${q(go)} ]; do sleep 0.05; done; ${q(process.execPath)} ${q(main)} session-event < ${q(input)}; exec sleep 600`,
      ]);
      pane = created.trim();
      await tmux(["set-option", "-p", "-t", pane, "@seance-task", taskId]);
      const socket = join(second.stateDir, "run", "seanced.sock");
      await pollUntil(() => localSocketReachable(socket), "B's op socket", 10_000);
      await Bun.write(go, "");

      await pollUntil(
        async () => (await stack.queue().get(taskId))?.body?.state === "done",
        "the leader to take the event",
        10_000,
      );
      expect((await stack.queue().get(taskId))?.body?.assignment).toMatchObject({ deviceId: b, pane });
    } finally {
      if (pane !== null) await tmux(["kill-session", "-t", "e2e-event-sender"]);
      await second?.stop();
    }
  });
});

describe("keyless mcp ↔ local daemon's broker ↔ relay ↔ remote daemon", () => {
  test("a process with no PSK lists, sees, spawns and despawns on another machine through its own daemon", async () => {
    // Machine B: a second real daemon, its own deviceId, on the same relay and tmux server.
    const remote = await stack.startSecondDaemon({ name: "RemoteBox" });
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

      const spawned = await call("spawn_session", {
        machine: "RemoteBox",
        repo: "myrepo",
        mode: "here",
        prompt: "broker the fleet",
      });
      window = "broker-the-fleet";
      expect(spawned.text).toContain("spawned window broker-the-fleet on RemoteBox");
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

async function heldBy(reply: Promise<QueueReply | null>): Promise<unknown> {
  const read = await reply;
  if (read === null || !("holds" in read)) throw new Error(`no queue: ${JSON.stringify(read)}`);
  return read.holds;
}

describe("auto: app ↔ relay ↔ leader ↔ the machine it chose", () => {
  // M2's first Exit bullet: two daemons up, an `auto` spawn from the app lands
  // where its decision record says, and the record says why the other lost.
  test("an auto spawn lands on the machine its decision names, and the record says why the other was rejected", async () => {
    // B is signed out: its only exclave has no account, so it can bill nothing.
    const second = await stack.startSecondDaemon({ name: "AutoBox" });
    const app = startApp(stack, { auto: true, prompt: "route me" });
    let window: string | null = null;
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      // Both machines decrypted with a live status, and the leader verified.
      const ready = (state: AppState): boolean =>
        state.relay.scheduler.kind === "ready" &&
        [stack.deviceId, second.deviceId].every((id) => {
          const machine = state.relay.machines.find((m) => m.deviceId === id);
          return machine?.connected === true && machine.status !== undefined && machine.repos.length > 0;
        });
      await app.waitForApp(ready, "both machines live and the leader verified");
      expect(deriveView(app.store.getState(), Date.now()).autoAvailability).toEqual({
        available: true,
        reason: null,
        note: null,
      });

      // The preview first, as the form shows it: a dry run, nothing reserved.
      await app.store.refreshPreview();
      const preview = app.store.getState().preview;
      if (preview?.kind !== "ok") throw new Error(`no preview: ${JSON.stringify(preview)}`);
      expect(preview.decision.chosen?.deviceId).toBe(stack.deviceId);
      expect(stack.daemon.leader.term()).not.toBeNull();
      expect((await stack.queue().list()).filter((t) => t.body?.state === "reserved")).toEqual([]);
      // A drop leaves the leader as it was, and the form still asks again once back — a
      // preview the drop failed in flight would otherwise stand until tapped.
      app.client.reconnect();
      await app.waitForApp(
        (state) => state.relay.status === "open" && state.preview?.kind === "ok" && state.preview !== preview,
        "the preview asked again after the reconnect",
      );

      // The leader nudges apps when its queue changes; the PWA's own read-back rides on it.
      const nudges: QueueChanged[] = [];
      const stopNudges = app.client.onQueueChanged((change) => nudges.push(change));
      await app.store.spawn();
      const queued = await app.waitForApp(
        (state) => state.verdict?.kind === "queued" && state.verdict.task.state === "running",
        "the queued task to run",
      );
      if (queued.verdict?.kind !== "queued") throw new Error("no queued verdict");
      const { task } = queued.verdict;
      const decision = task.decision;
      expect(decision?.chosen?.deviceId).toBe(stack.deviceId);
      expect(task.assignment?.deviceId).toBe(decision?.chosen?.deviceId);
      const loser = decision?.candidates.find((c) => c.deviceId === second.deviceId);
      expect(loser?.score).toBeUndefined();
      expect(loser?.rejected).toContainEqual({ code: "auth_missing" });
      // And it really is there: the chosen machine runs a session carrying the task id.
      const listed = await app.client.request<{ sessions: readonly SessionEntry[] }>(stack.deviceId, "sessions", {});
      if ("ok" in listed) throw new Error(listed.code);
      const session = listed.sessions.find((s) => s.taskId === task.id);
      expect(session).toBeDefined();
      window = session?.window ?? null;
      // Nothing reached B: no spawn ever audited there.
      expect(await Bun.file(second.log).text()).not.toContain('op="spawn"');
      await pollUntil(() => nudges.some((n) => n.tasks?.includes(task.id)), "a queue-changed naming the task");
      stopNudges();
    } finally {
      if (window !== null) await killWindow(window);
      app.stop();
      await second.stop();
    }
  }, 60_000);

  // MCP's `auto` is M2's `submit` over the same app client: a clone name from
  // list_machines resolves to its origin, the leader places the task, and the
  // spawn is the scheduler's — audited as the leader's, never as `mcp`.
  test("an MCP auto spawn lands through the real leader, audited as the scheduler's, and get_queue shows it", async () => {
    const lazy = new LazyRelay({
      create: () =>
        new RelayClient({
          url: wsUrl(stack.relay, "/app"),
          token: TOKEN,
          key: stack.appKey,
          createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
        }),
    });
    const client = new Client(
      { name: "e2e-auto", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serveStdio(() => buildMcpServer(relayFleet(lazy), null), { transport: serverTransport });
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean }> => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { text: string }[];
      return { text: content.map((entry) => entry.text).join("\n"), error: result.isError === true };
    };
    // The suite's daemon audits to its stdout, which in-process is console.log.
    const audit = spyOn(console, "log");
    let window: string | null = null;
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();

      const spawned = await call("spawn_session", { machine: "auto", repo: "myrepo", prompt: "route me by mcp" });
      expect(spawned.error).toBe(false);
      // The spawn is an enqueue: it answers queued, and the leader places it afterwards.
      expect(spawned.text).toMatch(/^task (\S+): queued/u);
      const id = /^task (\S+):/u.exec(spawned.text)?.[1];
      if (id === undefined) throw new Error(`no task id in: ${spawned.text}`);

      type Queue = {
        tasks: { id: string; state: string; placement?: { machine: string; window?: string } }[];
        holds: unknown[];
      };
      const seen: { queue: Queue | null } = { queue: null };
      await pollUntil(
        async () => {
          const queue = JSON.parse((await call("get_queue", {})).text) as Queue;
          if (queue.tasks.find((t) => t.id === id)?.state !== "running") return false;
          seen.queue = queue;
          return true;
        },
        "the queued task to run",
        20_000,
      );
      const seenRunning = seen.queue;
      expect(seenRunning?.tasks.find((t) => t.id === id)).toMatchObject({
        state: "running",
        placement: { machine: "TestMac" },
      });
      expect(seenRunning?.holds).toEqual([]);
      window = (await stack.queue().get(id))?.body?.assignment?.window ?? null;
      if (window === null) throw new Error("no window on the running task");
      expect(await listWindows()).toContain(window);

      // The leader dispatched to its own machine in process; the request carried no `mcp`.
      const lines = audit.mock.calls.map((args) => args.join(" "));
      const spawn = lines.find((line) => line.includes("audit spawn origin=leader"));
      expect(spawn).toContain('client="scheduler"');
      expect(lines.some((line) => line.includes("route me by mcp"))).toBe(false);
    } finally {
      audit.mockRestore();
      if (window !== null) await killWindow(window);
      await client.close();
      lazy.stop();
    }
  }, 60_000);

  // An app's cancel of a task running on another machine: the leader despawns
  // it there through the relay, and that machine's audit trail says who asked —
  // origin=relay, client=scheduler — which only the target daemon can show.
  test("an app's cancel ends a task's session on another machine, audited there as the scheduler's", async () => {
    const taskId = "e2e-cancel-task";
    const app = startApp(stack, { auto: true });
    let second: SecondDaemon | null = null;
    let window: string | null = null;
    try {
      // Not on SCHEDULER_LEADERS, so the suite's daemon leads again once it is back.
      second = await stack.startSecondDaemon({ name: "CancelBox" });
      const b = second.deviceId;
      await app.waitForApp(
        (state) => state.relay.machines.some((m) => m.deviceId === b && m.connected && m.repos.length > 0),
        "the second machine online with its repos",
      );
      const spawned = await app.client.request<SpawnResponse>(b, "spawn", {
        repo: "myrepo",
        mode: "here",
        title: "cancel me",
        taskId,
      });
      if (!spawned.ok) throw new Error(`spawn failed: ${spawned.message}`);
      window = spawned.window;
      const pane = spawned.sessions.find((s) => s.window === spawned.window)?.id;
      if (pane === undefined) throw new Error("the spawned session is not listed");

      // The leader's queue holds the task running there, as a dispatch would have left it.
      await stack.seedTask({
        id: taskId,
        spec: { repo: "github.com/acme/app", mode: "here" },
        state: "running",
        createdAt: Date.now(),
        assignment: { deviceId: b, exclave: "default", clone: "myrepo", window, pane },
      });
      await stack.restartDaemon();
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead again", 10_000);
      await stack.daemon.leader.settled();
      // Takeover asked B and found the session, so the task is still running.
      expect((await stack.queue().get(taskId))?.body?.state).toBe("running");
      await app.waitForApp((state) => state.relay.scheduler.kind === "ready", "the leader verified");

      const reply = await app.client.cancel(taskId);
      if (reply === null || "ok" in reply) throw new Error(`cancel failed: ${JSON.stringify(reply)}`);
      expect(reply.task.state).toBe("cancelled");
      await pollUntil(
        async () => !(await listWindows()).includes(window ?? ""),
        "the session's window to close",
        10_000,
      );
      window = null;
      const despawn = (await Bun.file(second.log).text())
        .split("\n")
        .find((line) => line.includes("audit despawn origin=relay") && line.includes(`target=${JSON.stringify(pane)}`));
      expect(despawn).toContain('client="scheduler"');
    } finally {
      if (window !== null) await killWindow(window);
      app.stop();
      await second?.stop();
    }
  }, 60_000);

  // M3's first Exit bullet: the queue is the relay's, so an enqueue needs no
  // leader and the next one to lead runs it.
  test("a task enqueued while no daemon leads runs once one does", async () => {
    const id = crypto.randomUUID();
    const app = startApp(stack, { auto: true });
    let down = false;
    let window: string | null = null;
    try {
      const up = await app.waitForApp(
        (state) => state.relay.scheduler.kind === "ready" && fixtureOrigin(state) !== null,
        "the suite's daemon verified as leader, with its repos listed",
      );
      stack.daemon.stop();
      down = true;
      await app.waitForApp((state) => state.relay.scheduler.kind === "none", "no leader while the daemon is down");
      const created = await app.client.createTask({
        id,
        spec: { repo: fixtureOrigin(up) ?? "", mode: "worktree", prompt: "durable" },
        state: "queued",
        createdAt: Date.now(),
      });
      expect(created).toEqual({ ok: true, landedEarlier: false });

      await stack.restartDaemon();
      down = false;
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead again", 10_000);
      await stack.daemon.leader.settled();
      await pollUntil(
        async () => (await stack.queue().get(id))?.body?.state === "running",
        "the enqueued task to run under the new term",
        20_000,
      );
      window = (await stack.queue().get(id))?.body?.assignment?.window ?? null;
    } finally {
      if (down) await stack.restartDaemon();
      await app.client.cancel(id).catch(() => null);
      if (window !== null) await killWindow(window);
      app.stop();
    }
  }, 60_000);

  // An app's create while the daemon leads is placed by `store-changed`, not by
  // a tick. The leader's own tick and the status beat (whose registry push also
  // ticks it) are pushed out for this daemon, so the nudge is the only thing
  // that can wake it once its boot-time status has landed.
  test("a task enqueued while a daemon leads is picked up on the store's nudge, not a tick", async () => {
    const id = crypto.randomUUID();
    await stack.restartDaemon({ quiet: true });
    const app = startApp(stack, { auto: true });
    let window: string | null = null;
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      const ready = await app.waitForApp(
        (state) =>
          state.relay.scheduler.kind === "ready" &&
          fixtureOrigin(state) !== null &&
          state.relay.machines.some((m) => m.deviceId === stack.deviceId && m.status !== undefined),
        "the leader verified, with the repos listed and the daemon's boot status in",
      );
      const created = await app.client.createTask({
        id,
        spec: { repo: fixtureOrigin(ready) ?? "", mode: "worktree", prompt: "nudged" },
        state: "queued",
        createdAt: Date.now(),
      });
      expect(created).toEqual({ ok: true, landedEarlier: false });
      // Neither timer can fire inside the hour: only the relay's `store-changed` could have woken the leader.
      await pollUntil(
        async () => (await stack.queue().get(id))?.body?.state === "running",
        "the leader to run the task on the store's nudge",
        10_000,
      );
      window = (await stack.queue().get(id))?.body?.assignment?.window ?? null;
    } finally {
      await app.client.cancel(id).catch(() => null);
      if (window !== null) await killWindow(window);
      app.stop();
      await stack.restartDaemon();
    }
  }, 60_000);

  // Mark done is the leader's, not the session's: the task finishes as `manual`,
  // its session is ended first (a done task holds no slot, so a session left
  // running would work past the caps), and the daemon audits the request as the
  // scheduler's.
  test("mark-done finishes a running task as manual and ends its session, audited", async () => {
    const id = crypto.randomUUID();
    const app = startApp(stack, { auto: true });
    const audit = spyOn(console, "log");
    let window: string | null = null;
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      const up = await app.waitForApp(
        (state) => state.relay.scheduler.kind === "ready" && fixtureOrigin(state) !== null,
        "the leader verified, with the repos listed",
      );
      const created = await app.client.createTask({
        id,
        spec: { repo: fixtureOrigin(up) ?? "", mode: "worktree", prompt: "mark me done" },
        state: "queued",
        createdAt: Date.now(),
      });
      expect(created).toEqual({ ok: true, landedEarlier: false });
      await pollUntil(
        async () => (await stack.queue().get(id))?.body?.state === "running",
        "the enqueued task to run",
        20_000,
      );
      window = (await stack.queue().get(id))?.body?.assignment?.window ?? null;

      const marked = await app.client.markDone(id);
      expect(marked).toMatchObject({ task: { id, state: "done", doneBy: "manual" } });
      expect(window).not.toBeNull();
      await pollUntil(async () => !(await listWindows()).includes(window ?? ""), "the marked task's session to end");
      const lines = audit.mock.calls.map((args) => args.join(" "));
      expect(
        lines.some((line) => line.includes("op=mark-done") && line.includes(`task="${id}"`) && line.endsWith("ok")),
      ).toBe(true);
    } finally {
      audit.mockRestore();
      if (window !== null) await killWindow(window);
      app.stop();
    }
  }, 60_000);

  // Holds live in the relay's store, so a pause outlasts the daemon that took it
  // and `queue` reports it back.
  test("pause and resume show up as holds in the queue", async () => {
    const app = startApp(stack, { auto: true });
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      await app.waitForApp((state) => state.relay.scheduler.kind === "ready", "the leader verified");

      const paused = await app.client.pause({ until: "resume" });
      expect(paused).toMatchObject({ holds: [{ until: "resume" }] });
      expect(await heldBy(app.client.queue())).toMatchObject([{ until: "resume" }]);

      const resumed = await app.client.resume();
      expect(resumed).toMatchObject({ holds: [] });
      expect(await heldBy(app.client.queue())).toEqual([]);
    } finally {
      await app.client.resume().catch(() => null);
      app.stop();
    }
  }, 60_000);

  // The M3 gate's exit, with M2's reader check kept as its tripwire. A
  // bearer-token holder's daemon socket with signed roles and no PSK, connected
  // while the real leader is down, is never nominated: auto stays "no
  // scheduler". A listed machine's seed copied out without the PSK is
  // nominated, and the app reads it as "leader unverified", still enqueues (the
  // queue is the relay's) and sends it nothing. When it goes, the real daemon
  // leads under a higher term and runs what was queued.
  test("a squatter is never nominated; a stolen listed seed reads as leader unverified, and nothing is sent to either", async () => {
    const app = startApp(stack, { auto: true });
    const watch = watchLeader();
    const squatterId = await newDeviceId();
    let squatter: Awaited<ReturnType<typeof connectDaemon>> | null = null;
    let stolen: Awaited<ReturnType<typeof connectDaemon>> | null = null;
    let down = false;
    let queuedId: string | null = null;
    try {
      await app.waitForApp((state) => state.relay.scheduler.kind === "ready", "the suite's daemon verified as leader");
      const before = app.client.getState().scheduler;
      const term = before.kind === "ready" ? before.term : 0;

      stack.daemon.stop();
      down = true;
      await app.waitForApp((state) => state.relay.scheduler.kind === "none", "no leader while the daemon is down");

      // Signed roles and the oldest socket, but not on SCHEDULER_LEADERS.
      squatter = await connectDaemon(stack.relay);
      squatter.send(await register(squatterId, { roles: [DAEMON_ROLES.scheduler] }));
      // Its entry does not open, so only the raw push shows it registered.
      await pollUntil(() => watch.connected(squatterId), "the squatter registered");
      expect(watch.current()).toBeNull();
      await squatter.expectNo("lead", 500);
      expect(app.client.getState().scheduler).toEqual({ kind: "none" });
      // Auto still enqueues with nobody leading; the note says it waits.
      const unled = deriveView(app.store.getState(), Date.now()).autoAvailability;
      expect(unled).toMatchObject({ available: true, reason: null });
      expect(unled.note).toContain("No scheduler is leading right now");

      // Listed, so the relay nominates it; an info blob it cannot seal under the PSK.
      stolen = await connectDaemon(stack.relay);
      stolen.send(await register(stolenSeedId, { roles: [DAEMON_ROLES.scheduler] }));
      await stolen.waitFor("lead");
      await stack.restartDaemon();
      down = false;
      const seen = await app.waitForApp(
        (state) => state.relay.scheduler.kind === "unverified" && ownMachine(state, stack.deviceId)?.connected === true,
        "the stolen seed nominated, with the real daemon back and following",
      );
      expect(seen.relay.scheduler).toMatchObject({ kind: "unverified", deviceId: stolenSeedId });
      const view = deriveView(seen, Date.now());
      // The queue is the relay's, so auto still enqueues; only a preview needs a verified leader.
      expect(view.autoAvailability).toMatchObject({ available: true, reason: null });
      expect(view.autoAvailability.note).toContain("unverified");
      await app.store.refreshPreview();
      expect(app.store.getState().preview).toMatchObject({
        kind: "failed",
        message: expect.stringContaining("nothing is sent"),
      });
      await app.store.spawn();
      const verdict = app.store.getState().verdict;
      expect(verdict?.kind).toBe("queued");
      await expect(app.client.queue()).rejects.toMatchObject({ reason: "leader_unverified" });
      // The task sits in the store, queued; nothing is ever sent to the nominee.
      const listing = await app.client.listTasks();
      if (listing === null || !listing.ok) throw new Error("no listing");
      queuedId = verdict?.kind === "queued" ? verdict.task.id : null;
      expect(listing.tasks.find((t) => t.task.id === queuedId)?.task.state).toBe("queued");
      await stolen.expectNo("msg", 500);

      // The stolen seed's socket goes: the real daemon leads, verified, under a
      // higher term — and the squatter, connected longer than either, still does not.
      stolen.close();
      const back = await app.waitForApp(
        (state) => state.relay.scheduler.kind === "ready" && state.relay.scheduler.deviceId === stack.deviceId,
        "the real daemon to lead again",
      );
      const now = back.relay.scheduler;
      expect(now.kind === "ready" ? now.term : 0).toBeGreaterThan(term);
      // The form asks the new leader at once, mid-takeover: `not_ready` is waited out, not shown.
      await app.waitForApp((state) => state.preview?.kind === "ok", "the preview from the new leader");
      await squatter.expectNo("lead");
      await squatter.expectNo("msg");
    } finally {
      squatter?.close();
      stolen?.close();
      if (down) await stack.restartDaemon();
      // The real leader runs what the squatter-era app queued; cancel ends that session too.
      if (queuedId !== null) {
        const id = queuedId;
        // `dispatching` (spawn in flight) and a leader still taking over are asked again, never ignored: a task spawning after the test is a leak.
        // A cleanup that gives up must not skip the teardown below, nor mask the test's own failure.
        await pollUntil(
          async () => {
            const reply = await app.client.cancel(id).catch(() => null);
            return reply !== null && ("task" in reply || reply.code === "finished" || reply.code === "task_not_found");
          },
          "the leftover task to be cancelled or finished",
          20_000,
        ).catch((err: unknown) => console.error(`leftover task ${id} not cleaned up: ${String(err)}`));
      }
      app.stop();
      watch.close();
    }
  }, 60_000);

  // The gap the entry check left: a listed machine's own seed, copied out with
  // the bearer token but not the PSK, registering that machine's own `info`
  // blob read off any push. The entry opens, so only the lead proof tells the
  // thief apart: the relay minted a term the machine never heard, and the proof
  // it sealed for an older one, replayed, names the wrong term.
  test("a stolen seed registering the machine's own info blob, and replaying its last proof, reads as leader unverified", async () => {
    const app = startApp(stack, { auto: true });
    const watch = watchLeader();
    let thief: Awaited<ReturnType<typeof connectDaemon>> | null = null;
    let down = false;
    try {
      await app.waitForApp(
        (state) => state.relay.scheduler.kind === "ready" && state.relay.scheduler.deviceId === stack.deviceId,
        "the suite's daemon verified as leader",
      );
      await pollUntil(() => watch.current()?.proof !== undefined, "the leader's proof in the raw push");
      const info = watch.entry(stack.deviceId)?.info;
      const replayed = watch.current()?.proof;
      if (info === undefined || replayed === undefined) throw new Error("unreachable");
      // The suite's daemon keeps its state under this process's SEANCE_STATE_DIR.
      const state = await readState();
      if (state === null) throw new Error("the suite's daemon has no state.json");
      const seed = await identityOfState(state);

      // Down, so it cannot redial and take its route back mid-test.
      stack.daemon.stop();
      down = true;
      await app.waitForApp((s) => s.relay.scheduler.kind === "none", "no leader while the daemon is down");
      thief = await connectDaemon(stack.relay);
      const ts = Date.now();
      const roles = [DAEMON_ROLES.scheduler];
      thief.send({
        t: "register",
        deviceId: stack.deviceId,
        info,
        key: seed.publicKey,
        ts,
        sig: await signRegister(seed, ts, roles),
        roles,
      });
      const { term } = await thief.waitFor<{ t: "lead"; term: number }>("lead");
      thief.send({ t: "lead-proof", term, env: replayed });
      await pollUntil(
        () => watch.current()?.term === term && watch.current()?.proof?.iv === replayed.iv,
        "the replayed proof kept under the thief's term",
      );
      // The entry opened — the machine reads as itself, connected — and still the leader is not believed.
      const seen = await app.waitForApp(
        (s) => s.relay.scheduler.kind !== "none" && s.relay.scheduler.term === term,
        "the thief's term in the app",
      );
      expect(ownMachine(seen, stack.deviceId)?.connected).toBe(true);
      expect(seen.relay.scheduler).toEqual({ kind: "unverified", deviceId: stack.deviceId, term });
      await expect(app.client.queue()).rejects.toMatchObject({ reason: "leader_unverified" });
      // It holds the machine's route, so the app's own polls of that machine reach it
      // sealed; what must not is anything for the scheduler.
      const reached: string[] = [];
      for (;;) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- drained one frame at a time
          reached.push((await thief.waitFor<{ t: "msg"; env: { to: string } }>("msg", 500)).env.to);
        } catch {
          break;
        }
      }
      expect(reached).not.toContain(SCHEDULER_ID);

      thief.close();
      await stack.restartDaemon();
      down = false;
      const back = await app.waitForApp(
        (s) => s.relay.scheduler.kind === "ready" && s.relay.scheduler.deviceId === stack.deviceId,
        "the real daemon proving a term of its own",
      );
      expect(back.relay.scheduler.kind === "ready" ? back.relay.scheduler.term : 0).toBeGreaterThan(term);
    } finally {
      thief?.close();
      if (down) await stack.restartDaemon();
      app.stop();
      watch.close();
    }
  }, 60_000);
});

describe("takeover: a leader stopped between spawn and verdict", () => {
  // M3's Exit bullet "kill the leader between `spawn` and its verdict": B's spawn is
  // held mid-flight (a claude stub that waits for a go file), the leader stops, and B
  // answers into the void. The next term finds the session and must not start a twin.
  let held: string;
  let go: string;

  beforeAll(async () => {
    const dir = join(base, "held");
    await mkdir(dir, { recursive: true });
    held = join(dir, "claude");
    go = join(dir, "go");
    // The go path is baked in: a pane gets the tmux server's environment, not B's.
    await Bun.write(
      held,
      [
        "#!/bin/bash",
        '[ "$1" = --held-warm ] && exit 0',
        `while [ ! -e ${q(go)} ]; do sleep 0.05; done`,
        `exec ${q(stack.stub.ok)} "$@"`,
        "",
      ].join("\n"),
    );
    await chmod(held, 0o755);
    // First exec of a new executable pays the macOS scan: here, not inside a timed window.
    await exec([held, "--held-warm"]);
  });

  test("a spawn answered after the leader stopped is settled running by the next term, with no second spawn", async () => {
    // A rerun in this process finds the go file the last run left, and the stub would not hold.
    await rm(go, { force: true });
    const id = crypto.randomUUID();
    const title = "held-dispatch";
    // The suite's daemon audits to its stdout, which in-process is console.log.
    const audit = spyOn(console, "log");
    const app = startApp(stack, { auto: true });
    let second: SecondDaemon | null = null;
    let down = false;
    try {
      // The takeover settles what earlier tests left running, whose windows are gone: caps are clear.
      await stack.restartDaemon();
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();

      // A ledger old enough to prove a never-landed spawn (`ledgerSince` + the replay window <= the
      // reservation), so only B's write-ahead listing of the task keeps the next term from
      // returning it to `ready`. A ledger created at B's boot would be too young to ever do so.
      const ledgerSince = Date.now() - 10 * 60_000;
      second = await stack.startSecondDaemon({
        name: "LedgerBox",
        exclaves: [{ id: "default", observedAtMs: Date.now(), fiveHourPct: 10 }],
        env: { SEANCE_CLAUDE_BIN: held, SEANCE_E2E_SPAWN_WAIT_MS: "60000" },
        beforeBoot: (stateDir) =>
          writeFile(join(stateDir, "launched.json"), JSON.stringify({ v: 1, since: ledgerSince, tasks: [] }), {
            mode: 0o600,
          }),
      });
      const b = second.deviceId;
      // Not on SCHEDULER_LEADERS: with the suite's daemon down, nobody leads.
      const ready = await app.waitForApp(
        (state) =>
          state.relay.scheduler.kind === "ready" &&
          fixtureOrigin(state) !== null &&
          state.relay.machines.some(
            (m) => m.deviceId === b && m.connected && m.status !== undefined && m.repos.length > 0,
          ),
        "the leader verified and LedgerBox live with its repos listed",
      );
      const origin = fixtureOrigin(ready) ?? "";

      // The pin forces the decision onto B.
      const created = await app.client.createTask({
        id,
        spec: { repo: origin, mode: "here", title, prompt: "held", pin: { deviceId: b } },
        state: "queued",
        createdAt: Date.now(),
      });
      expect(created).toEqual({ ok: true, landedEarlier: false });
      // The window exists only after B's launch ledger recorded the id: the write precedes the spawn.
      await pollUntil(async () => (await listWindows()).includes(title), "B's spawn to reach its backend", 15_000);

      stack.daemon.stop();
      down = true;
      await app.waitForApp((state) => state.relay.scheduler.kind === "none", "no leader after the stop");
      const stopped = await app.client.getTask(id);
      if (stopped === null || !stopped.ok || stopped.task === null || !("task" in stopped.task)) {
        throw new Error(`no readable record: ${JSON.stringify(stopped)}`);
      }
      // The verdict never landed.
      expect(stopped.task.task).toMatchObject({ state: "reserved", reservation: { deviceId: b } });

      // B's stub registers and its reply goes out, to no leader.
      await Bun.write(go, "");
      await pollUntil(async () => (await listRegisteredWindows()).includes(title), "the held pane to register", 15_000);
      await pollUntil(
        async () => (await Bun.file(second?.log ?? "").text()).includes("audit spawn origin=relay ok window="),
        "B to audit the spawn as done",
        15_000,
      );

      await stack.restartDaemon();
      down = false;
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead again", 10_000);
      await stack.daemon.leader.settled();

      const listed = await app.client.request<{ sessions: readonly SessionEntry[] }>(b, "sessions", {});
      if ("ok" in listed) throw new Error(listed.code);
      // The precondition of the whole test, read off B's disk (only the scheduler is sent
      // `ledgerSince`): the ledger reaches back past the reservation, and lists the task.
      const ledger: unknown = await Bun.file(join(second.stateDir, "launched.json")).json();
      expect(ledger).toMatchObject({ since: ledgerSince, tasks: expect.arrayContaining([[id, expect.any(Number)]]) });
      const carrying = listed.sessions.filter((s) => s.taskId === id);
      expect(carrying).toHaveLength(1);
      const pane = carrying[0]?.id;
      if (pane === undefined) throw new Error("the session has no pane id");
      await pollUntil(
        async () => (await stack.queue().get(id))?.body?.state === "running",
        "the next term to settle the task running",
        10_000,
      );
      expect((await stack.queue().get(id))?.body).toMatchObject({
        state: "running",
        assignment: { deviceId: b, pane },
      });

      // No second spawn. A sleep is right before a negative assertion: a non-event cannot be polled.
      await Bun.sleep(500);
      const requests = (await Bun.file(second.log).text())
        .split("\n")
        .filter((line) => line.includes("audit spawn origin=relay") && line.includes(`task=${JSON.stringify(id)}`));
      expect(requests).toHaveLength(1);
      expect((await listWindows()).filter((w) => w === title)).toHaveLength(1);
      expect(
        audit.mock.calls.map((args) => args.join(" ")).filter((l) => l.includes("audit spawn") && l.includes(id)),
      ).toEqual([]);
    } finally {
      if (down) await stack.restartDaemon();
      // Frees a stub still waiting if the test failed before releasing it.
      await Bun.write(go, "");
      await app.client.cancel(id).catch(() => null);
      if (second !== null) await tmux(["kill-session", "-t", second.tmuxSession]).catch(() => undefined);
      await second?.stop();
      app.stop();
      audit.mockRestore();
    }
  }, 60_000);
});
