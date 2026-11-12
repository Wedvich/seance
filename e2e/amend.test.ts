import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  CAPABILITIES,
  isRecord,
  promptBasis,
  RelayClient,
  sendAmend,
  TASK_REQUEST_LIMITS,
  type Machine,
  type RelayState,
  type TaskReply,
  type TaskSpec,
} from "@seance/shared";
import { LazyRelay } from "../daemon/src/app-relay.ts";
import { amendAuto } from "../daemon/src/auto.ts";
import { relayFleet } from "../daemon/src/fleet.ts";
import { pollUntil } from "../daemon/test/fixtures.ts";
import { killWindow, TOKEN, wsUrl, type Stack } from "./harness.ts";
import { startSuite, type Suite } from "./suite.ts";

let suite: Suite | undefined;
let stack: Stack;

beforeAll(async () => {
  suite = await startSuite("e2e-amend");
  ({ stack } = suite);
});

afterAll(async () => {
  // startSuite failing in beforeAll leaves suite unset, having torn down what it started.
  await suite?.dispose();
});

/**
 * A bare app client whose socket records every frame it sends, so a test can put one back on the wire
 * as a relay replaying it would: the relay is blind, so the frame reaches the leader byte for byte.
 */
function recordingClient(): {
  readonly client: RelayClient;
  readonly sent: () => readonly string[];
  readonly resend: (frame: string) => void;
} {
  const sent: string[] = [];
  let socket: WebSocket | null = null;
  const client = new RelayClient({
    url: wsUrl(stack.relay, "/app"),
    token: TOKEN,
    key: stack.appKey,
    createSocket: (url) => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      const send = ws.send.bind(ws);
      ws.send = (data): void => {
        if (typeof data === "string") sent.push(data);
        send(data);
      };
      socket = ws;
      return ws;
    },
  });
  client.start();
  return {
    client,
    sent: () => [...sent],
    resend: (frame) => {
      if (socket === null) throw new Error("no socket to resend on");
      socket.send(frame);
    },
  };
}

/** The suite's daemon leads, verified, advertising `amend`, with its clones listed: the origin a task names. */
async function readyOrigin(client: RelayClient): Promise<string> {
  let state: RelayState = client.getState();
  await pollUntil(
    () => {
      state = client.getState();
      const leader = state.scheduler;
      return (
        leader.kind === "ready" &&
        state.machines.some(
          (m) =>
            m.deviceId === leader.deviceId &&
            m.capabilities?.includes(CAPABILITIES.amend) === true &&
            m.repos.some((r) => r.origin !== undefined),
        )
      );
    },
    "the leader verified, advertising amend, with its repos listed",
    20_000,
  );
  return state.machines.flatMap((m) => m.repos).find((r) => r.origin !== undefined)?.origin ?? "";
}

async function create(client: RelayClient, id: string, spec: TaskSpec): Promise<void> {
  expect(await client.createTask({ id, spec, state: "queued", createdAt: Date.now() })).toEqual({
    ok: true,
    landedEarlier: false,
  });
  // Amend answers from the leader's own view, which takes the create on the store's nudge.
  await pollUntil(async () => {
    const queue = await client.queue({ tasks: [id] });
    return queue !== null && "tasks" in queue && queue.tasks.some((t) => t.id === id);
  }, "the leader to list the created task");
}

function amended(reply: TaskReply | { readonly ok: false } | null): TaskSpec {
  if (reply === null || !("task" in reply)) throw new Error(`not amended: ${JSON.stringify(reply)}`);
  return reply.task.spec;
}

const auditLines = (spy: { readonly mock: { readonly calls: readonly unknown[][] } }): readonly string[] =>
  spy.mock.calls.map((args) => args.join(" "));

describe("amend: app ↔ relay ↔ leader ↔ the machine that runs the amended task", () => {
  // The task waits behind a pause, is amended field by field, and runs on what was amended; its id,
  // and so a dependent's link to it, never changes. Once placed or settled it is refused.
  test("a waiting task's prompt, title, model and effort are amended, and the session starts with them", async () => {
    const { client } = recordingClient();
    const audit = spyOn(console, "log");
    const id = crypto.randomUUID();
    const dependent = crypto.randomUUID();
    let window: string | null = null;
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      const origin = await readyOrigin(client);
      expect(await client.pause({ until: "resume" })).toMatchObject({ holds: [{ until: "resume" }] });

      await create(client, id, { repo: origin, mode: "worktree", prompt: "first draft", title: "amend-e2e" });
      await create(client, dependent, {
        repo: origin,
        mode: "worktree",
        prompt: "after it",
        deps: [{ task: id, after: "done" }],
      });

      // An append: the client reads the prompt it adds to and names it as the basis.
      const appended = await sendAmend(client, { taskId: id, prompt: { mode: "append", text: "also this" } });
      expect(amended(appended).prompt).toBe("first draft\n\nalso this");

      // A replace naming a prompt that moved since is refused, and changes nothing.
      const stale = await client.amend({
        taskId: id,
        prompt: { mode: "replace", text: "lost edit" },
        basis: await promptBasis("first draft"),
      });
      expect(stale).toMatchObject({ ok: false, code: "prompt_changed" });

      const replaced = await sendAmend(client, {
        taskId: id,
        prompt: { mode: "replace", text: "rewritten prompt" },
        title: "amend-e2e renamed",
        model: "sonnet",
        effort: "low",
      });
      // Still waiting: `ready` under the pause, under the same id.
      expect(replaced).toMatchObject({ task: { id } });
      expect(amended(replaced)).toMatchObject({
        prompt: "rewritten prompt",
        title: "amend-e2e renamed",
        model: "sonnet",
        effort: "low",
      });

      // At rest: the store holds the amended record under the same id; the dependent still names it.
      expect((await stack.queue().get(id))?.body?.spec).toMatchObject({
        prompt: "rewritten prompt",
        title: "amend-e2e renamed",
      });
      expect((await stack.queue().get(dependent))?.body?.spec.deps).toEqual([{ task: id, after: "done" }]);

      expect(await client.resume()).toMatchObject({ holds: [] });
      await pollUntil(
        async () => (await stack.queue().get(id))?.body?.state === "running",
        "the amended task to run",
        20_000,
      );
      window = (await stack.queue().get(id))?.body?.assignment?.window ?? null;
      // The stub's records: the seed on its stdin, and claude's argv.
      const seed = await Bun.file(`${stack.stub.ok}.stdin`).text();
      expect(seed).toContain("rewritten prompt");
      expect(seed).not.toContain("first draft");
      const argv = (await Bun.file(`${stack.stub.ok}.argv`).text()).split("\0");
      expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
      expect(argv[argv.indexOf("--effort") + 1]).toBe("low");

      // Placed: its session already has its prompt. Wait for the leader's own view, as mark-done's test does.
      await pollUntil(async () => {
        const queue = await client.queue({ tasks: [id] });
        return queue !== null && "tasks" in queue && queue.tasks.some((t) => t.id === id && t.state === "running");
      }, "the leader to hold the task running");
      expect(await client.amend({ taskId: id, title: "too late" })).toMatchObject({ ok: false, code: "placed" });

      expect(await client.cancel(id)).toMatchObject({ task: { id, state: "cancelled" } });
      expect(await client.amend({ taskId: id, title: "later still" })).toMatchObject({
        ok: false,
        code: "finished",
      });

      const lines = auditLines(audit);
      expect(
        lines.filter((l) => l.includes("op=amend") && l.includes(`task="${id}"`) && l.endsWith(" ok")),
      ).toHaveLength(2);
      expect(lines.some((l) => l.includes("op=amend") && l.includes("placed"))).toBe(true);
      // Prompt text, the amendment's included, never reaches a log line.
      for (const text of ["first draft", "also this", "rewritten prompt", "lost edit"]) {
        expect(lines.filter((l) => l.includes(text))).toEqual([]);
      }
    } finally {
      audit.mockRestore();
      // Cancelled before the resume, so nothing still waiting is placed on the way out.
      await client.cancel(id).catch(() => null);
      await client.cancel(dependent).catch(() => null);
      await client.resume().catch(() => null);
      if (window !== null) await killWindow(window);
      client.stop();
    }
  }, 90_000);

  test("refusals: an unknown task, an oversized amendment, and a replayed append that lands once", async () => {
    const { client, sent, resend } = recordingClient();
    const audit = spyOn(console, "log");
    const big = crypto.randomUUID();
    const small = crypto.randomUUID();
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      const origin = await readyOrigin(client);
      await client.pause({ until: "resume" });

      expect(await client.amend({ taskId: crypto.randomUUID(), title: "nobody" })).toMatchObject({
        ok: false,
        code: "task_not_found",
      });

      // Within the parser's bound on its own, past the task's once joined to the prompt it adds to.
      const long = "p".repeat(TASK_REQUEST_LIMITS.prompt - 100);
      await create(client, big, { repo: origin, mode: "worktree", prompt: long });
      const over = await sendAmend(client, { taskId: big, prompt: { mode: "append", text: "q".repeat(500) } });
      expect(over).toMatchObject({ ok: false, code: "prompt_too_long" });
      expect((await stack.queue().get(big))?.body?.spec.prompt).toBe(long);

      // The relay replays the leader the exact sealed frame of an append that landed: the one guard
      // every term shares drops it, so the text is added once.
      await create(client, small, { repo: origin, mode: "worktree", prompt: "base" });
      const before = sent().length;
      const once = await sendAmend(client, { taskId: small, prompt: { mode: "append", text: "once" } });
      expect(amended(once).prompt).toBe("base\n\nonce");
      // The append's own frame: the one envelope sealed to the scheduler since (the basis read is a store-get).
      const sealed = sent()
        .slice(before)
        .filter((raw) => raw.startsWith("{"))
        .flatMap((raw) => {
          const frame: unknown = JSON.parse(raw);
          if (!isRecord(frame) || frame["t"] !== "msg" || !isRecord(frame["env"])) return [];
          const { to, iv } = frame["env"];
          return to === "scheduler" && typeof iv === "string" ? [{ raw, iv }] : [];
        });
      expect(sealed).toHaveLength(1);
      const [replayed] = sealed;
      if (replayed === undefined) throw new Error("unreachable");
      resend(replayed.raw);
      // The leader's app-role leg, the one `schedulerGuard` every term shares, names the envelope it dropped.
      await pollUntil(
        () =>
          auditLines(audit).some((l) => l.includes(`wire dropped iv="${replayed.iv}"`) && l.includes("reason=replay")),
        "the leader to drop the replayed frame as a replay",
      );
      // A non-event: nothing to poll for, so a settle before reading what the store holds.
      await Bun.sleep(500);
      expect((await stack.queue().get(small))?.body?.spec.prompt).toBe("base\n\nonce");
      expect(
        auditLines(audit).filter((l) => l.includes("op=amend") && l.includes(`task="${small}"`) && l.endsWith(" ok")),
      ).toHaveLength(1);
    } finally {
      audit.mockRestore();
      await client.cancel(big).catch(() => null);
      await client.cancel(small).catch(() => null);
      await client.resume().catch(() => null);
      client.stop();
    }
  }, 90_000);

  // No daemon in this suite predates `amend`, and a capability list has no seam to drop one, so the
  // lease is the real one over the real registry with the leader's entry as an older daemon would
  // register it. The same lease unstripped amends, so it is the gate that refused, before any send.
  test("an older leader without the capability: the client's gate refuses before anything is sent", async () => {
    const id = crypto.randomUUID();
    const { client } = recordingClient();
    const lazy = new LazyRelay({
      create: () =>
        new RelayClient({
          url: wsUrl(stack.relay, "/app"),
          token: TOKEN,
          key: stack.appKey,
          createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
        }),
    });
    const fleet = relayFleet(lazy);
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      const origin = await readyOrigin(client);
      await client.pause({ until: "resume" });
      await create(client, id, { repo: origin, mode: "worktree", prompt: "unchanged", title: "older" });

      const lease = await fleet.open();
      try {
        await pollUntil(async () => {
          const probe = await fleet.open();
          const ready = probe.scheduler?.availability().kind === "ready";
          probe.release();
          return ready;
        }, "the lease to see a verified leader");
        const fresh = await fleet.open();
        const scheduler = fresh.scheduler;
        if (scheduler === null) throw new Error("no scheduler leg");
        const older = (m: Machine): Machine => ({
          ...m,
          capabilities: (m.capabilities ?? []).filter((c) => c !== CAPABILITIES.amend),
        });
        const amendCalls = spyOn(scheduler, "amend");
        const refused = await amendAuto(
          { machines: fresh.machines.map(older), scheduler },
          { taskId: id, title: "should not land" },
          "cli",
        );
        expect(refused.ok).toBe(false);
        expect(refused.text).toContain("needs `seanced update`");
        expect(amendCalls).not.toHaveBeenCalled();
        expect((await stack.queue().get(id))?.body?.spec.title).toBe("older");

        const landed = await amendAuto({ machines: fresh.machines, scheduler }, { taskId: id, title: "landed" }, "cli");
        expect(landed.ok).toBe(true);
        expect((await stack.queue().get(id))?.body?.spec.title).toBe("landed");
        fresh.release();
      } finally {
        lease.release();
      }
    } finally {
      await client.cancel(id).catch(() => null);
      await client.resume().catch(() => null);
      lazy.stop();
      client.stop();
    }
  }, 60_000);
});
