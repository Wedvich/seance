import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  APP_ID,
  fromBase64,
  liveStatus,
  newestQuotaByAccount,
  open,
  seal,
  toBase64,
  type Plain,
  type RegistryView,
  type RelayToAppFrame,
  type SessionEntry,
  type SpawnResponse,
} from "@seance/shared";
import { deregisterMachine } from "../daemon/src/deregister.ts";
import { exec } from "../daemon/src/exec.ts";
import { pollUntil } from "../daemon/test/fixtures.ts";
import { connectApp } from "../relay/test/harness.ts";
import { deriveMachines } from "../pwa/src/machines-view.ts";
import type { AppState } from "../pwa/src/view.ts";
import { E2E_ACCOUNT_ID, killWindow, listWindows, ownMachine, startApp, type Stack } from "./harness.ts";
import { startSuite, type Suite } from "./suite.ts";

let suite: Suite | undefined;
let stack: Stack;

beforeAll(async () => {
  suite = await startSuite("e2e-app");
  ({ stack } = suite);
});

afterAll(async () => {
  // startSuite failing in beforeAll leaves suite unset, having torn down what it started.
  await suite?.dispose();
});

// Store.spawn() silently no-ops unless the machine entry already carries the
// repo — the daemon registers before its scan finishes, so `connected` alone
// is a spawn-shaped race, not readiness.
function spawnReady(state: AppState): boolean {
  const machine = ownMachine(state, stack.deviceId);
  return machine?.connected === true && machine.repos.some((r) => r.name === "myrepo");
}

/** A fresh `sessions` request; the daemon's reply names its id in `re`. */
function sessionsRequest(): Plain {
  return { id: crypto.randomUUID(), ts: Date.now(), op: "sessions", payload: {} };
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

  /**
   * The pieces are proven apart — shared/ shows a re-addressed or tampered
   * envelope fails AAD, the daemon suite shows its client drops one, the relay
   * suite shows the hub forwards a blob untouched. This is the composition over
   * the shipped relay: the frames a compromised relay could emit reach the real
   * daemon and die there, while an honest frame on the same socket is answered.
   * A raw app socket rather than startApp; replies to every app are fanned to
   * it too, so each is opened and matched on `re`.
   */
  test("a re-addressed or tampered envelope crosses the real relay and is dropped by the daemon", async () => {
    const raw = await connectApp(stack.relay);
    const ownEntryOnline = (frame: Extract<RelayToAppFrame, { t: "registry" }>): boolean =>
      frame.entries.some((entry) => entry.deviceId === stack.deviceId && entry.connected);
    try {
      while (!ownEntryOnline(await raw.waitFor<Extract<RelayToAppFrame, { t: "registry" }>>("registry", 10_000)));
      const replyTo = async (timeoutMs = 5_000): Promise<string | undefined> => {
        const frame = await raw.waitFor<Extract<RelayToAppFrame, { t: "msg" }>>("msg", timeoutMs);
        return (await open(stack.appKey, frame.env)).re;
      };

      // A relay re-addressing a blob sealed for another machine to this one.
      const readdressed = sessionsRequest();
      const elsewhere = await seal(stack.appKey, { to: "some-other-device", from: APP_ID }, readdressed);
      raw.send({ t: "msg", env: { ...elsewhere, to: stack.deviceId } });

      // A relay flipping one ciphertext byte.
      const tampered = sessionsRequest();
      const flipped = await seal(stack.appKey, { to: stack.deviceId, from: APP_ID }, tampered);
      const ct = fromBase64(flipped.ct);
      ct[0] = (ct[0] ?? 0) ^ 0xff;
      raw.send({ t: "msg", env: { ...flipped, ct: toBase64(ct) } });

      // Control, sent last: its reply proves the daemon was listening on this
      // socket for both frames above, so silence on them is a drop, not a race.
      const honest = sessionsRequest();
      raw.send({ t: "msg", env: await seal(stack.appKey, { to: stack.deviceId, from: APP_ID }, honest) });
      const dropped = new Set([readdressed.id, tampered.id]);
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- replies arrive one at a time
        const re = await replyTo();
        expect(dropped.has(re ?? "")).toBe(false);
        if (re === honest.id) break;
      }
      // Nothing answers a dropped frame later either — a negative, so a sleep is the honest tool.
      await Bun.sleep(300);
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- draining what already arrived
        const re = await replyTo(300).catch(() => null);
        if (re === null) break;
        expect(dropped.has(re ?? "")).toBe(false);
      }
    } finally {
      raw.close();
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
      const card = deriveMachines(state.relay.machines, Date.now(), state.relay.scheduler).cards.find(
        (c) => c.deviceId === stack.deviceId,
      );
      expect(card?.gauges.map((gauge) => gauge.label)).toContain("Memory");
      // The daemon runs from this checkout, so its register blob names the build. Needs a git checkout (readSource).
      expect(card?.build).toMatch(/^[0-9a-f]{12} · committed /u);
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
      const view = deriveMachines(asleep.relay.machines, Date.now(), asleep.relay.scheduler);
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

  // The PWA no longer sends `spawn` (every PWA spawn is a task), but the daemon still answers it for
  // older apps, older MCP clients and `seanced spawn --now`: these two keep that op honest.
  test("the spawn op: worktree mode lands a reply and a real tmux window", async () => {
    const app = startApp(stack);
    let window: string | null = null;
    try {
      await app.waitForApp(spawnReady, "machine ready to spawn");
      const reply = await app.client.request<SpawnResponse>(stack.deviceId, "spawn", {
        repo: "myrepo",
        mode: "worktree",
        prompt: "port the pane",
        client: "pwa",
      });
      if (!reply.ok) throw new Error(`expected ok reply, got ${JSON.stringify(reply)}`);
      window = reply.window;
      expect(window).toBe("port-the-pane");

      // Not just a reply: the window is really running on the tmux server.
      expect(await listWindows()).toContain(window);

      // The reply embeds a refreshed session list.
      const entry = reply.sessions.find((s) => s.window === window);
      expect(entry?.repo).toBe("myrepo");
    } finally {
      if (window !== null) await killWindow(window);
      app.stop();
    }
  });

  test("the spawn op: claude dying becomes a failed reply carrying the captured error", async () => {
    const app = startApp(stack);
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
      const reply = await app.client.request<SpawnResponse>(stack.deviceId, "spawn", {
        repo: "myrepo",
        mode: "here",
        prompt: "doomed",
        client: "pwa",
      });
      if (reply.ok || !("message" in reply)) throw new Error(`expected a failed reply, got ${JSON.stringify(reply)}`);
      expect(reply.code).toBe("claude_died");
      expect(reply.message).toContain("boom: untrusted workspace");

      // The daemon killed the dead window rather than leaving a corpse.
      expect(await listWindows()).not.toContain("doomed");
    } finally {
      process.env["SEANCE_CLAUDE_BIN"] = stack.stub.ok;
      app.stop();
      // Back to the default, or every later spawn in this file pays 15s to be called alive.
      await stack.restartDaemon();
    }
  });

  test("resume: re-dialling re-asks every machine, so a session started elsewhere is picked up", async () => {
    const app = startApp(stack);
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
    const app = startApp(stack);
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
    const app = startApp(stack);
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
      // The daemon's own reading lands in the fleet quota record, which outlives its entry below.
      const recorded = async (): Promise<boolean> => {
        await app.client.refreshFleetQuota();
        return app.client
          .getState()
          .fleetQuota.some((entry) => entry.accountId === E2E_ACCOUNT_ID && entry.observer === stack.deviceId);
      };
      await pollUntil(recorded, "the daemon's reading in the fleet quota record");
      // The order `uninstall` relies on: while the service still holds a socket
      // the relay refuses, which is why the CLI stops it first.
      expect(await deregisterMachine(stack.config, stack.deviceId)).toEqual({ kind: "connected" });

      stack.daemon.stop();
      await app.waitForApp((s) => ownMachine(s, stack.deviceId)?.connected === false, "machine offline");

      expect(await deregisterMachine(stack.config, stack.deviceId)).toEqual({ kind: "forgotten" });
      const forgotten = await app.waitForApp((s) => ownMachine(s, stack.deviceId) === null, "entry gone from the app");
      const fleetQuota = app.client.getState().fleetQuota;
      expect(newestQuotaByAccount(forgotten.relay.machines, fleetQuota).get(E2E_ACCOUNT_ID)?.deviceId).toBe(
        stack.deviceId,
      );
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

      const view = deriveMachines(state.relay.machines, Date.now(), state.relay.scheduler);
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
