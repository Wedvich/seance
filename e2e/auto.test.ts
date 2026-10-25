import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AT_REST_OPS,
  openAtRest,
  parseStoreReply,
  taskKey,
  DAEMON_ROLES,
  RelayClient,
  SCHEDULER_ID,
  signRegister,
  type QueueChanged,
  type QueueReply,
  type SessionEntry,
  type SpawnResponse,
} from "@seance/shared";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { LazyRelay } from "../daemon/src/app-relay.ts";
import { autoFleet, spawnAuto } from "../daemon/src/cli-auto.ts";
import { brokerFleet, relayFleet, selectFleet } from "../daemon/src/fleet.ts";
import { buildMcpServer } from "../daemon/src/mcp.ts";
import { identityOfState, readState } from "../daemon/src/state.ts";
import { pollUntil } from "../daemon/test/fixtures.ts";
import { connectApp, connectDaemon, newDeviceId, register } from "../relay/test/harness.ts";
import { deriveView, type AppState } from "../pwa/src/view.ts";
import {
  killWindow,
  listWindows,
  ownMachine,
  startApp,
  TOKEN,
  wsUrl,
  type SecondDaemon,
  type Stack,
} from "./harness.ts";
import { fixtureOrigin, startSuite, watchLeader, type Suite } from "./suite.ts";

let suite: Suite | undefined;
let stack: Stack;
let stolenSeedId: string;

beforeAll(async () => {
  suite = await startSuite("e2e-auto");
  ({ stack, stolenSeedId } = suite);
});

afterAll(async () => {
  // startSuite failing in beforeAll leaves suite unset, having torn down what it started.
  await suite?.dispose();
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One machine's `exclaves` from a `list_machines` result, narrowed rather than cast; empty when the shape is off. */
function exclavesOf(result: { readonly content: unknown }, deviceId: string): readonly unknown[] {
  const [first] = Array.isArray(result.content) ? result.content : [];
  if (!isRecord(first) || typeof first["text"] !== "string") return [];
  const machines: unknown = JSON.parse(first["text"]);
  if (!Array.isArray(machines)) return [];
  const machine = machines.find((entry: unknown) => isRecord(entry) && entry["deviceId"] === deviceId);
  return isRecord(machine) && Array.isArray(machine["exclaves"]) ? machine["exclaves"] : [];
}

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
    const app = startApp(stack, { prompt: "route me" });
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

  // The credential-delivered box: this process holds no key (`key` answers null), so
  // `auto` reaches the scheduler only through the daemon's broker, over its real op
  // socket. The daemon seals the task; `avoid` keeps it queued so cancel has one to end.
  test("a keyless MCP auto spawn queues through the daemon's broker; get_queue shows it and cancel_task cancels it", async () => {
    const fleet = selectFleet({
      key: () => Promise.resolve(null),
      direct: () => {
        throw new Error("a keyless process must never dial the relay itself");
      },
      broker: brokerFleet(),
    });
    const surfaceAudit: string[] = [];
    const client = new Client(
      { name: "e2e-keyless-auto", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serveStdio(() => buildMcpServer(fleet, null, (line) => void surfaceAudit.push(line)), {
      transport: serverTransport,
    });
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean }> => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { text: string }[];
      return { text: content.map((entry) => entry.text).join("\n"), error: result.isError === true };
    };
    // The suite's daemon audits to its stdout, which in-process is console.log.
    const audit = spyOn(console, "log");
    let id: string | undefined;
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();

      const spawned = await call("spawn_session", {
        machine: "auto",
        repo: "myrepo",
        prompt: "keyless route me",
        avoid: ["TestMac"],
      });
      expect(spawned.error).toBe(false);
      expect(spawned.text).toMatch(/^task (\S+): queued/u);
      id = /^task (\S+):/u.exec(spawned.text)?.[1];
      if (id === undefined) throw new Error(`no task id in: ${spawned.text}`);
      const taskId = id;

      type Queue = { tasks: { id: string; state: string }[] };
      await pollUntil(
        async () => {
          const queue = JSON.parse((await call("get_queue", {})).text) as Queue;
          return queue.tasks.some((t) => t.id === taskId);
        },
        "get_queue to show the brokered task",
        20_000,
      );
      // Sealed by the daemon with the app key it holds: the record reads as the MCP's.
      const stored = (await stack.queue().get(taskId))?.body;
      expect(stored?.spec.client).toBe("mcp");
      expect(stored?.spec.avoid).toEqual([stack.deviceId]);
      expect(stored?.state).not.toBe("running");

      const cancelled = await call("cancel_task", { taskId });
      expect(cancelled.error).toBe(false);
      expect(cancelled.text).toContain("cancelled");
      await pollUntil(
        async () => (await stack.queue().get(taskId))?.body?.state === "cancelled",
        "the brokered cancel to land",
        20_000,
      );

      // The daemon's own trail names the origin and the peer's claimed client, never the prompt.
      const lines = audit.mock.calls.map((args) => args.join(" "));
      expect(
        lines.some((line) => line.includes('audit broker origin=local-broker action=scheduler op="enqueue"')),
      ).toBe(true);
      const enqueued = lines.find((line) => line.includes("audit enqueue origin=local-broker"));
      expect(enqueued).toContain("claimed_client=mcp");
      expect(enqueued).toContain(`task=${JSON.stringify(taskId)}`);
      expect(enqueued).toMatch(/ queued$/u);
      expect(lines.some((line) => line.includes("keyless route me"))).toBe(false);
      // The surface's own line is unchanged by the route.
      expect(surfaceAudit).toEqual([
        expect.stringMatching(/^audit enqueue origin=mcp client=mcp task="[^"]+" createdAt=\d+ queued$/u),
      ]);
    } finally {
      audit.mockRestore();
      await client.close();
      fleet.stop();
    }
  }, 60_000);

  // M4's account pin and avoid list, end to end: an alias another client wrote
  // resolves at submit time to the accountId alone, the real leader rejects the
  // machine signed in elsewhere, and the record at rest carries the sentinel an
  // older leader would refuse. Then the CLI's --not keeps a task off the leader.
  test("an alias-pinned MCP task and a CLI task avoiding the leader both land on the other machine", async () => {
    const other = { organizationUuid: "e2e-org-b", accountUuid: "pinned", emailAddress: "pin@e2e.test" };
    const otherId = `${other.organizationUuid}:${other.accountUuid}`;
    const second = await stack.startSecondDaemon({
      name: "PinBox",
      exclaves: [{ id: "default", observedAtMs: Date.now() - 10 * 60_000, fiveHourPct: 20, account: other }],
    });
    const app = startApp(stack, {}, { accounts: true });
    const lazy = new LazyRelay({
      create: () =>
        new RelayClient({
          url: wsUrl(stack.relay, "/app"),
          token: TOKEN,
          key: stack.appKey,
          accountKey: stack.accountKey,
          createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
        }),
    });
    const client = new Client(
      { name: "e2e-pin", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serveStdio(() => buildMcpServer(relayFleet(lazy), null), { transport: serverTransport });
    await client.connect(clientTransport);
    const built = await autoFleet(stack.config, { stores: [] });
    const raw = await connectApp(stack.relay);
    const ids: string[] = [];
    const windows: string[] = [];
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      await app.waitForApp(
        (state) =>
          state.relay.scheduler.kind === "ready" &&
          state.relay.machines.some(
            (m) =>
              m.deviceId === second.deviceId &&
              m.connected &&
              m.repos.length > 0 &&
              m.exclaves?.some((x) => x.accountId === otherId) === true &&
              m.status !== undefined,
          ),
        "the second machine live, signed in as the other account",
      );
      const named = await app.client.putAccountAlias(otherId, "elsewhere", 0);
      expect(named?.ok).toBe(true);

      // The alias the app set names the account in list_machines too, beside its id and email.
      const listing = await client.callTool({ name: "list_machines", arguments: {} });
      expect(exclavesOf(listing, second.deviceId)).toContainEqual(
        expect.objectContaining({
          accountId: otherId,
          email: "pin@e2e.test",
          account: "elsewhere",
          alias: "elsewhere",
        }),
      );

      const placedOn = async (id: string, label: string): Promise<void> => {
        await pollUntil(
          async () => (await stack.queue().get(id))?.body?.state === "running",
          `${label} to run`,
          20_000,
        );
        const running = (await stack.queue().get(id))?.body;
        expect(running?.assignment?.deviceId).toBe(second.deviceId);
        const window = running?.assignment?.window;
        if (window !== undefined) windows.push(window);
      };

      const result = await client.callTool({
        name: "spawn_session",
        arguments: { machine: "auto", repo: "myrepo", prompt: "pinned by alias", pin: { account: "elsewhere" } },
      });
      const text = (result.content as { text: string }[]).map((entry) => entry.text).join("\n");
      expect(result.isError).not.toBe(true);
      expect(text).toContain(`pinned to account ${otherId} (pin@e2e.test)`);
      const pinnedId = /^task (\S+):/u.exec(text)?.[1];
      if (pinnedId === undefined) throw new Error(`no task id in: ${text}`);
      ids.push(pinnedId);
      await placedOn(pinnedId, "the alias-pinned task");
      const pinned = (await stack.queue().get(pinnedId))?.body;
      expect(pinned?.spec.pin).toEqual({ account: otherId });
      const rejected = pinned?.decision?.candidates.find((c) => c.deviceId === stack.deviceId)?.rejected;
      expect(rejected).toContainEqual({ code: "pin_mismatch", field: "account" });

      // At rest: the accountId and the sentinel, never the alias or the email.
      raw.send({ t: "store-get", id: "get-pinned", key: taskKey(pinnedId) });
      const stored = parseStoreReply(await raw.waitForRe<{ re: string }>("get-pinned", 10_000));
      if (stored?.t !== "store-record" || stored.record === null) throw new Error("no stored record");
      const atRest = JSON.stringify((await openAtRest(stack.appKey, stored.record.env, AT_REST_OPS.task)).payload);
      expect(atRest).toContain(`"pin":{"account":"${otherId}","exclave":""}`);
      expect(atRest).not.toContain("elsewhere");
      expect(atRest).not.toContain("pin@e2e.test");

      const outcome = await spawnAuto(
        { repo: "myrepo", here: false, prompt: "keep off the leader", not: [stack.deviceId] },
        built.fleet,
        () => {},
      );
      expect(outcome.ok).toBe(true);
      const avoidId = /^task (\S+): queued/u.exec(outcome.text)?.[1];
      if (avoidId === undefined) throw new Error(`no task id in: ${outcome.text}`);
      ids.push(avoidId);
      await placedOn(avoidId, "the task avoiding the leader");
      const avoided = (await stack.queue().get(avoidId))?.body;
      expect(avoided?.spec.avoid).toEqual([stack.deviceId]);
      expect(avoided?.decision?.candidates.find((c) => c.deviceId === stack.deviceId)?.rejected).toContainEqual({
        code: "avoided",
      });
    } finally {
      await Promise.all(ids.map((id) => app.client.cancel(id).catch(() => null)));
      await Promise.all(windows.map((window) => killWindow(window).catch(() => {})));
      raw.close();
      built.fleet.stop();
      await client.close();
      lazy.stop();
      app.stop();
      await second.stop();
    }
  }, 90_000);

  // `seanced spawn` in a shell with no key: `autoFleet` finds none and takes the
  // broker. The alias is another client's write, resolved by the CLI from the broker's
  // accounts read, so the stored record carries the accountId and the CLI's client.
  test("a keyless CLI spawn resolves an account alias through the broker and records the pin", async () => {
    const other = { organizationUuid: "e2e-org-c", accountUuid: "keyless", emailAddress: "keyless@e2e.test" };
    const otherId = `${other.organizationUuid}:${other.accountUuid}`;
    const second = await stack.startSecondDaemon({
      name: "KeylessBox",
      exclaves: [{ id: "default", observedAtMs: Date.now() - 10 * 60_000, fiveHourPct: 20, account: other }],
    });
    const app = startApp(stack, {}, { accounts: true });
    const built = await autoFleet({ ...stack.config, psk: "" }, { stores: [] });
    const enqueued: string[] = [];
    let id: string | undefined;
    let window: string | null = null;
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      await app.waitForApp(
        (state) =>
          state.relay.scheduler.kind === "ready" &&
          state.relay.machines.some(
            (m) =>
              m.deviceId === second.deviceId &&
              m.connected &&
              m.repos.length > 0 &&
              m.exclaves?.some((x) => x.accountId === otherId) === true &&
              m.status !== undefined,
          ),
        "the second machine live, signed in as the other account",
      );
      const named = await app.client.putAccountAlias(otherId, "keyless-alias", 0);
      expect(named?.ok).toBe(true);

      const outcome = await spawnAuto(
        {
          repo: "myrepo",
          here: false,
          prompt: "keyless by alias",
          account: "keyless-alias",
          not: [stack.deviceId],
        },
        built.fleet,
        (line) => {
          enqueued.push(line);
        },
      );
      expect(outcome.ok).toBe(true);
      id = /^task (\S+): queued/u.exec(outcome.text)?.[1];
      if (id === undefined) throw new Error(`no task id in: ${outcome.text}`);
      const taskId = id;
      await pollUntil(
        async () => (await stack.queue().get(taskId))?.body?.state === "running",
        "the keyless CLI's task to run",
        20_000,
      );
      const running = (await stack.queue().get(taskId))?.body;
      expect(running?.assignment?.deviceId).toBe(second.deviceId);
      window = running?.assignment?.window ?? null;
      expect(running?.spec.client).toBe("cli");
      expect(running?.spec.pin).toEqual({ account: otherId });
      // `--not` rides the broker's frame too: the suite's own daemon, which would otherwise be a candidate.
      expect(running?.spec.avoid).toEqual([stack.deviceId]);
      expect(enqueued).toEqual([
        expect.stringMatching(/^audit enqueue origin=cli client=cli task="[^"]+" createdAt=\d+ queued$/u),
      ]);
    } finally {
      if (id !== undefined) await app.client.cancel(id).catch(() => null);
      if (window !== null) await killWindow(window).catch(() => {});
      built.fleet.stop();
      app.stop();
      await second.stop();
    }
  }, 90_000);

  // An app's cancel of a task running on another machine: the leader despawns
  // it there through the relay, and that machine's audit trail says who asked —
  // origin=relay, client=scheduler — which only the target daemon can show.
  test("an app's cancel ends a task's session on another machine, audited there as the scheduler's", async () => {
    const taskId = "e2e-cancel-task";
    const app = startApp(stack);
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
    const app = startApp(stack);
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

  // docs/scheduler.md M4, CLI spawn: `seanced spawn` enqueues as an app
  // does, so it lands with no leader up and runs once one leads. Driven through
  // `autoFleet` (the config's PSK, its `/daemon` URL turned `/app`) and `spawnAuto`
  // over a real app socket — `cmdSpawnAuto` adds only the process exit.
  test("a CLI spawn queues with no leader up and runs once one leads, recorded as the CLI's", async () => {
    const app = startApp(stack);
    const built = await autoFleet(stack.config, { stores: [] });
    const enqueued: string[] = [];
    let down = false;
    let id: string | undefined;
    let window: string | null = null;
    // The leader audits to its stdout, which in-process is console.log.
    const audit = spyOn(console, "log");
    try {
      await app.waitForApp(
        (state) => state.relay.scheduler.kind === "ready" && fixtureOrigin(state) !== null,
        "the suite's daemon verified as leader, with its repos listed",
      );
      stack.daemon.stop();
      down = true;
      await app.waitForApp((state) => state.relay.scheduler.kind === "none", "no leader while the daemon is down");

      const outcome = await spawnAuto(
        { repo: "myrepo", here: true, title: "cli spawn", prompt: "queued from a shell" },
        built.fleet,
        (line) => {
          enqueued.push(line);
        },
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.text).toContain("No scheduler is leading right now");
      id = /^task (\S+): queued/u.exec(outcome.text)?.[1];
      if (id === undefined) throw new Error(`no task id in: ${outcome.text}`);
      const taskId = id;
      expect(enqueued).toEqual([
        expect.stringMatching(/^audit enqueue origin=cli client=cli task="[^"]+" createdAt=\d+ queued$/u),
      ]);

      await stack.restartDaemon();
      down = false;
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead again", 10_000);
      await stack.daemon.leader.settled();
      await pollUntil(
        async () => (await stack.queue().get(taskId))?.body?.state === "running",
        "the CLI's task to run under the new term",
        20_000,
      );
      // `stack.queue()` reads over the daemon's own socket, so the record is read once it is back.
      const running = (await stack.queue().get(taskId))?.body;
      expect(running?.spec.client).toBe("cli");
      window = running?.assignment?.window ?? null;
      if (window === null) throw new Error("no window on the running task");
      expect(await listWindows()).toContain(window);
      const lines = audit.mock.calls.map((args) => args.join(" "));
      const admit = lines.find((line) => line.includes("op=admit") && line.includes(`task=${JSON.stringify(taskId)}`));
      expect(admit).toContain('client="cli"');
      expect(lines.some((line) => line.includes("queued from a shell"))).toBe(false);
    } finally {
      audit.mockRestore();
      if (down) await stack.restartDaemon();
      if (id !== undefined) await app.client.cancel(id).catch(() => null);
      if (window !== null) await killWindow(window);
      built.fleet.stop();
      app.stop();
    }
  }, 60_000);

  // The spec's "a plain `seanced spawn` lands as a task": the real CLI, as a subprocess, with the
  // suite's config (key included) and a state dir of its own, so its audit lines are its alone.
  test("a plain seanced spawn from a shell lands as a task, recorded as the CLI's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seance-e2e-cli-"));
    const configDir = join(dir, "config");
    const stateDir = join(dir, "state");
    await mkdir(configDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await Bun.write(join(configDir, "config.json"), JSON.stringify(stack.config));
    const app = startApp(stack);
    let id: string | undefined;
    let window: string | null = null;
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      await app.waitForApp(
        (state) => state.relay.scheduler.kind === "ready" && fixtureOrigin(state) !== null,
        "the suite's daemon verified as leader, with its repos listed",
      );
      const main = fileURLToPath(new URL("../daemon/src/main.ts", import.meta.url));
      const proc = Bun.spawn([process.execPath, main, "spawn", "myrepo", "-p", "plain from a shell"], {
        env: { ...process.env, SEANCE_CONFIG_DIR: configDir, SEANCE_STATE_DIR: stateDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      id = /^task (\S+): queued/u.exec(stdout)?.[1];
      if (id === undefined) throw new Error(`no task id in: ${stdout}`);
      // A verified leader is up, so the leaderless advice (which names --now) has no business here.
      expect(stdout).not.toContain("--now");
      expect(stdout).not.toContain("No scheduler is leading");
      const taskId = id;
      await pollUntil(
        async () => (await stack.queue().get(taskId))?.body?.state === "running",
        "the plain spawn's task to run",
        20_000,
      );
      const running = (await stack.queue().get(taskId))?.body;
      expect(running?.spec.client).toBe("cli");
      window = running?.assignment?.window ?? null;
      if (window === null) throw new Error("no window on the running task");
      expect(await listWindows()).toContain(window);
      const log = await Bun.file(join(stateDir, "seanced.log")).text();
      expect(log).toContain("audit enqueue origin=cli client=cli");
      expect(log).not.toContain("audit spawn");
      expect(log).not.toContain("plain from a shell");
    } finally {
      if (id !== undefined) await app.client.cancel(id).catch(() => null);
      if (window !== null) await killWindow(window);
      app.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // An app's create while the daemon leads is placed by `store-changed`, not by
  // a tick. The leader's own tick and the status beat (whose registry push also
  // ticks it) are pushed out for this daemon, so the nudge is the only thing
  // that can wake it once its boot-time status has landed.
  test("a task enqueued while a daemon leads is picked up on the store's nudge, not a tick", async () => {
    const id = crypto.randomUUID();
    await stack.restartDaemon({ quiet: true });
    const app = startApp(stack);
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
    const app = startApp(stack);
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
      const running = (await stack.queue().get(id))?.body;
      window = running?.assignment?.window ?? null;
      expect(running?.spec.prompt).toBe("mark me done");
      // The store reads `running` once the write lands; the leader holds it `reserved`
      // (and refuses `dispatching`) until it has taken the ack, so wait for its own view.
      await pollUntil(async () => {
        const queue = await app.client.queue();
        return queue !== null && "tasks" in queue && queue.tasks.some((t) => t.id === id && t.state === "running");
      }, "the leader to hold the task running");

      const marked = await app.client.markDone(id);
      expect(marked).toMatchObject({ task: { id, state: "done", doneBy: "manual" } });
      // The finishing write dropped the prompt: through the real relay, adapter and seal.
      const finished = (await stack.queue().get(id))?.body;
      expect(finished?.spec.prompt).toBeUndefined();
      expect(finished?.spec.repo).toBe(fixtureOrigin(up) ?? "");
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
    const app = startApp(stack);
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
    const app = startApp(stack);
    const watch = watchLeader(stack.relay);
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
      // The verified leader takes over the store and runs what was queued under the unverified one.
      const queued = queuedId;
      if (queued === null) throw new Error("no queued task");
      await pollUntil(
        async () => {
          const body = (await stack.queue().get(queued))?.body;
          return body !== undefined && body.state !== "queued" && body.assignment !== undefined;
        },
        "the verified leader to dispatch the task queued while unverified",
        20_000,
      );
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
    const app = startApp(stack);
    const watch = watchLeader(stack.relay);
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
