import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BATCH_STRATEGY, RelayClient, type Task } from "@seance/shared";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { LazyRelay } from "../daemon/src/app-relay.ts";
import { relayFleet } from "../daemon/src/fleet.ts";
import { buildMcpServer } from "../daemon/src/mcp.ts";
import { pollUntil } from "../daemon/test/fixtures.ts";
import { killWindow, startApp, TOKEN, wsUrl, type AppHandle, type Stack } from "./harness.ts";
import { startSuite, type Suite } from "./suite.ts";

let suite: Suite | undefined;
let stack: Stack;

beforeAll(async () => {
  suite = await startSuite("e2e-authoring");
  ({ stack } = suite);
});

afterAll(async () => {
  // startSuite failing in beforeAll leaves suite unset, having torn down what it started.
  await suite?.dispose();
});

async function taskOf(id: string): Promise<Task | null> {
  return (await stack.queue().get(id))?.body ?? null;
}

async function stateOf(id: string): Promise<string | undefined> {
  return (await taskOf(id))?.state;
}

/** Enqueues a plain auto task through the PWA's own store and waits for it to run: the predecessor the tests wait on. */
async function runningPredecessor(app: AppHandle, prompt: string): Promise<{ id: string; window: string }> {
  await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
  await stack.daemon.leader.settled();
  // A spawn before the machine's repos are listed resolves no repo and does nothing, silently.
  await app.waitForApp(
    (state) =>
      state.relay.scheduler.kind === "ready" &&
      state.relay.machines.some((m) => m.deviceId === stack.deviceId && m.connected && m.repos.length > 0),
    "the leader verified and the machine's repos listed",
  );
  app.store.setPrompt(prompt);
  await app.store.spawn();
  const queued = await app.waitForApp(
    (state) => state.verdict?.kind === "queued" && state.verdict.task.state === "running",
    "the predecessor to run",
  );
  if (queued.verdict?.kind !== "queued") throw new Error("no queued verdict");
  const { id } = queued.verdict.task;
  const window = (await taskOf(id))?.assignment?.window;
  if (window === undefined) throw new Error("no window on the running predecessor");
  return { id, window };
}

describe("authoring: dependencies, batches and Linear links, from the PWA and from MCP", () => {
  // "opened" needs a PR and a pushed branch, which a stub session never makes, so a dependent
  // stays blocked until the predecessor is marked done — which releases every edge on it.
  test("the PWA's After, Batch and Linear fields reach the stored task, which waits on its predecessor and then runs", async () => {
    const app = startApp(stack);
    const windows: string[] = [];
    try {
      const p = await runningPredecessor(app, "authoring predecessor (pwa)");
      windows.push(p.window);

      app.store.addAfter(p.id, "opened");
      app.store.startBatch();
      app.store.setLinearIssue("ENG-123");
      app.store.setPrompt("authoring dependent (pwa)");
      await app.store.spawn();
      const queued = app.store.getState().verdict;
      if (queued?.kind !== "queued") throw new Error(`not queued: ${JSON.stringify(queued)}`);
      const b = queued.task.id;
      await pollUntil(async () => (await stateOf(b)) === "blocked", "the dependent to be held blocked", 20_000);

      const stored = await taskOf(b);
      expect(stored?.spec.deps).toEqual([{ task: p.id, after: "opened" }]);
      // The fixed strategy is stored for older readers, whose parser needs one.
      expect(stored?.spec.batch).toMatchObject({ index: 1, strategy: BATCH_STRATEGY });
      expect(stored?.spec.linear).toEqual({ issue: "ENG-123" });
      expect(stored?.spec.client).toBe("pwa");
      // The form is ready for the next member: its per-task fields cleared, the batch one on.
      expect(app.store.getState().form).toMatchObject({
        after: [],
        linearIssue: "",
        batch: { id: stored?.spec.batch?.id, next: 2 },
      });

      const done = await app.client.markDone(p.id);
      expect(done).toMatchObject({ task: { id: p.id, state: "done" } });
      await pollUntil(
        async () => (await stateOf(b)) === "running",
        "the dependent to run once its predecessor is done",
        30_000,
      );
      const window = (await taskOf(b))?.assignment?.window;
      if (window !== undefined) windows.push(window);
    } finally {
      for (const window of windows) await killWindow(window);
      app.stop();
    }
  }, 90_000);

  test("queue_batch stores its members with matching batch ids, indexes and resolved refs, and releases them in their after order", async () => {
    const app = startApp(stack);
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
      { name: "e2e-authoring", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serveStdio(() => buildMcpServer(relayFleet(lazy), null), { transport: serverTransport });
    await client.connect(clientTransport);
    const windows: string[] = [];
    try {
      const p = await runningPredecessor(app, "authoring predecessor (mcp)");
      windows.push(p.window);

      const result = await client.callTool({
        name: "queue_batch",
        arguments: {
          tasks: [
            {
              ref: "m1",
              repo: "myrepo",
              title: "authoring-m1",
              prompt: "first member",
              after: [{ task: p.id, when: "opened" }],
              // The stack's one machine, by deviceId: it still runs, so the pin is stored and honoured.
              pin: { machine: stack.deviceId },
            },
            {
              ref: "m2",
              repo: "myrepo",
              title: "authoring-m2",
              prompt: "second member",
              after: [{ ref: "m1", when: "opened" }],
              linear: { issue: "ENG-9" },
            },
          ],
        },
      });
      expect(result.isError).not.toBe(true);

      const byTitle = async (title: string): Promise<Task | null> =>
        (await stack.queue().list()).map((entry) => entry.body).find((t) => t?.spec.title === title) ?? null;
      await pollUntil(
        async () => (await byTitle("authoring-m1")) !== null && (await byTitle("authoring-m2")) !== null,
        "both members stored",
        20_000,
      );
      const m1 = await byTitle("authoring-m1");
      const m2 = await byTitle("authoring-m2");
      if (m1 === null || m2 === null) throw new Error("members missing");
      await pollUntil(
        async () => (await stateOf(m1.id)) === "blocked" && (await stateOf(m2.id)) === "blocked",
        "both held blocked",
        20_000,
      );

      expect(m1.spec.deps).toEqual([{ task: p.id, after: "opened" }]);
      // `m1` resolved to the id minted for it, which is what the leader reads.
      expect(m2.spec.deps).toEqual([{ task: m1.id, after: "opened" }]);
      expect(m1.spec.batch?.id).toBe(m2.spec.batch?.id);
      expect([m1.spec.batch?.index, m2.spec.batch?.index]).toEqual([1, 2]);
      expect(m2.spec.linear).toEqual({ issue: "ENG-9" });
      expect(m1.spec.pin).toEqual({ deviceId: stack.deviceId });
      expect(m2.spec.pin).toBeUndefined();

      expect(await app.client.markDone(p.id)).toMatchObject({ task: { id: p.id, state: "done" } });
      await pollUntil(async () => (await stateOf(m1.id)) === "running", "the first member to run", 30_000);
      const window = (await taskOf(m1.id))?.assignment?.window;
      if (window !== undefined) windows.push(window);
      // The second waits on the first's PR, which never comes.
      expect(await stateOf(m2.id)).toBe("blocked");
    } finally {
      for (const window of windows) await killWindow(window);
      app.stop();
      await client.close();
      lazy.stop();
    }
  }, 90_000);
});
