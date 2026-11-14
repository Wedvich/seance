import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { CAPABILITIES, isRecord, type Task } from "@seance/shared";
import { tmuxOk } from "../daemon/src/tmux.ts";
import { pollUntil } from "../daemon/test/fixtures.ts";
import {
  cancelTask,
  PSK,
  startApp,
  takeLeakedTasks,
  TOKEN,
  wsUrl,
  type AppHandle,
  type SecondDaemon,
  type Stack,
} from "./harness.ts";
import { fixtureOrigin, q, startSuite, type Suite } from "./suite.ts";

/**
 * Cross-machine session messages with every part real but the session: the leader's resolution and forward, the
 * target daemon's delivery into a pane's real `seanced inbox` listener, the receipt back to the sender's own pane, and
 * the sender's `sendMessage` with the route gate built exactly as `seanced mcp` builds it (`messageRouteGate`) over a
 * real fleet. A stand-in "session" is a script in each task's stub pane.
 */

let suite: Suite | undefined;
let base: string;
let stack: Stack;
let second: SecondDaemon | undefined;
let app: AppHandle | undefined;
let origin = "";
let cloneName = "";

const MAIN = join(import.meta.dir, "..", "daemon", "src", "main.ts");
const SHARED = join(import.meta.dir, "..", "shared", "src", "index.ts");
const DAEMON = join(import.meta.dir, "..", "daemon", "src");
/** The superseded predecessor the file seeds before anything else: it names the successor the last case creates. */
const PREDECESSOR = `e2e-msg-pred-${crypto.randomUUID()}`;
const SUCCESSOR = `e2e-msg-succ-${crypto.randomUUID()}`;
const SECRET = "SECRET-E2E-MESSAGE-TEXT";

const ROUTING_READY =
  (suiteId: string, boxId: string) => (state: Parameters<Parameters<AppHandle["waitForApp"]>[0]>[0]) =>
    state.relay.scheduler.kind === "ready" &&
    [suiteId, boxId].every((id) => {
      const machine = state.relay.machines.find((m) => m.deviceId === id);
      return (
        machine?.connected === true &&
        machine.status !== undefined &&
        machine.repos.length > 0 &&
        machine.capabilities?.includes(CAPABILITIES.messages) === true
      );
    }) &&
    state.relay.machines.find((m) => m.deviceId === suiteId)?.capabilities?.includes(CAPABILITIES.messageRoute) ===
      true;

beforeAll(async () => {
  suite = await startSuite("e2e-messages");
  ({ base, stack } = suite);
  // Seeded first: `seedTask` restarts the suite's daemon, which must not be a second machine's takeover to survive.
  await stack.seedTask({
    id: PREDECESSOR,
    spec: { repo: "github.com/acme/app", mode: "worktree" },
    state: "superseded",
    successor: SUCCESSOR,
    createdAt: Date.now(),
  });
  await stack.restartDaemon();
  await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
  await stack.daemon.leader.settled();
  second = await stack.startSecondDaemon({
    name: "MsgBox",
    exclaves: [{ id: "default", observedAtMs: Date.now(), fiveHourPct: 10 }],
  });
  app = startApp(stack);
  const ready = await app.waitForApp(
    ROUTING_READY(stack.deviceId, second.deviceId),
    "the verified leader advertising messageRoute and both machines advertising messages with their repos listed",
  );
  origin = fixtureOrigin(ready) ?? "";
  cloneName =
    ready.relay.machines.find((m) => m.deviceId === stack.deviceId)?.repos.find((r) => r.origin === origin)?.name ?? "";
  if (origin === "" || cloneName === "") throw new Error("no fixture repo listed");
}, 90_000);

// A task a test leaves running holds a slot under its account's cap (4) for every later test.
afterEach(() => {
  expect(takeLeakedTasks()).toEqual([]);
});

afterAll(async () => {
  app?.stop();
  await second?.stop();
  await suite?.dispose();
});

const client = (): AppHandle["client"] => {
  if (app === undefined) throw new Error("no app");
  return app.client;
};

const machineId = (box: "suite" | "box"): string => (box === "suite" ? stack.deviceId : (second?.deviceId ?? ""));
const stateDirOf = (box: "suite" | "box"): string =>
  box === "suite" ? (process.env["SEANCE_STATE_DIR"] ?? "") : (second?.stateDir ?? "");

async function taskOf(id: string): Promise<Task | null> {
  return (await stack.queue().get(id))?.body ?? null;
}

/** Creates a task pinned to a machine and waits for its session to run there with a window and a tagged pane. */
async function runTask(
  box: "suite" | "box",
  extra: Partial<Task["spec"]> = {},
  id = crypto.randomUUID(),
): Promise<string> {
  const created = await client().createTask({
    id,
    spec: { repo: origin, mode: "worktree", prompt: "haunt the relay", pin: { deviceId: machineId(box) }, ...extra },
    state: "queued",
    createdAt: Date.now(),
  });
  expect(created).toEqual({ ok: true, landedEarlier: false });
  await running(id, box);
  return id;
}

async function running(id: string, box?: "suite" | "box"): Promise<void> {
  await pollUntil(
    async () => {
      const task = await taskOf(id);
      return task?.state === "running" && task.assignment?.window !== undefined;
    },
    `task ${id} to run`,
    30_000,
  );
  if (box !== undefined) expect((await taskOf(id))?.assignment?.deviceId).toBe(machineId(box));
}

async function paneOf(taskId: string): Promise<string> {
  let found: string | undefined;
  await pollUntil(
    async () => {
      const panes = await tmuxOk(["list-panes", "-a", "-F", "#{pane_id} #{@seance-task}"]);
      found = panes
        .split("\n")
        .map((line) => line.split(" "))
        .find(([, task]) => task === taskId)?.[0];
      return found !== undefined;
    },
    `a pane carrying ${taskId}`,
    10_000,
  );
  if (found === undefined) throw new Error(`no pane carries ${taskId}`);
  return found;
}

interface Session {
  readonly taskId: string;
  readonly pane: string;
  /** Lines the session's inbox listener wrote, parsed. */
  readonly inbox: () => Promise<{ push: string; messageKind: string }[]>;
  /** The sender's answers, one per `send`. */
  readonly send: (to: string, text: string) => Promise<{ ok: boolean; text: string; id?: string }>;
}

/**
 * The stand-in session for a task: in its pane, a `seanced inbox` listener against its machine's daemon (what the inbox
 * mod runs) and a sender that calls `sendMessage` with the gate `seanced mcp` builds, fed by files so one pane sends
 * as often as a test needs. Every command is a separate bun process in the pane, as a session's tools are.
 */
async function session(taskId: string, box: "suite" | "box"): Promise<Session> {
  const pane = await paneOf(taskId);
  const dir = join(base, `session-${taskId}`);
  const out = join(dir, "inbox.out");
  const stateDir = stateDirOf(box);
  const socket = join(stateDir, "run", "seanced.sock");
  const cfg = join(dir, "cfg.json");
  await Bun.write(cfg, JSON.stringify({ dir, socket, url: wsUrl(stack.relay, "/app"), token: TOKEN, psk: PSK }));
  const script = join(dir, "sender.ts");
  await Bun.write(
    script,
    `import { rename } from "node:fs/promises";
import { importPsk, RelayClient } from ${JSON.stringify(SHARED)};
import { LazyRelay } from ${JSON.stringify(join(DAEMON, "app-relay.ts"))};
import { relayFleet } from ${JSON.stringify(join(DAEMON, "fleet.ts"))};
import { messageRouteGate } from ${JSON.stringify(join(DAEMON, "mcp.ts"))};
import { sendMessage } from ${JSON.stringify(join(DAEMON, "send-message.ts"))};
const cfg = JSON.parse(await Bun.file(${JSON.stringify(cfg)}).text());
const key = await importPsk(cfg.psk);
for (let i = 0; ; i++) {
  const cmd = \`\${cfg.dir}/cmd-\${i}.json\`;
  while (!(await Bun.file(cmd).exists())) await Bun.sleep(50);
  const message = JSON.parse(await Bun.file(cmd).text());
  const lazy = new LazyRelay({
    create: () => new RelayClient({
      url: cfg.url, token: cfg.token, key,
      createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
    }),
  });
  const result = await sendMessage(message, { path: cfg.socket, routeGate: messageRouteGate(relayFleet(lazy)) });
  lazy.stop();
  await Bun.write(\`\${cfg.dir}/res-\${i}.part\`, JSON.stringify(result));
  await rename(\`\${cfg.dir}/res-\${i}.part\`, \`\${cfg.dir}/res-\${i}.json\`);
}
`,
  );
  const listener = `SEANCE_STATE_DIR=${q(stateDir)} ${q(process.execPath)} ${q(MAIN)} inbox > ${q(out)}`;
  // `exec sleep` keeps the pane up; the listener and the sender are its children, so each binds by its parent walk.
  await stack.stub.runInPane(pane, `${listener} & ${q(process.execPath)} ${q(script)} & exec sleep 600`);
  let sent = 0;
  const inbox = async (): Promise<{ push: string; messageKind: string }[]> => {
    const text = (await Bun.file(out).exists()) ? await Bun.file(out).text() : "";
    return text.split("\n").flatMap((line) => {
      if (line === "") return [];
      const parsed: unknown = JSON.parse(line);
      // The ack is the listener's first line and carries no push.
      if (!isRecord(parsed) || typeof parsed["push"] !== "string" || typeof parsed["messageKind"] !== "string") {
        return [];
      }
      return [{ push: parsed["push"], messageKind: parsed["messageKind"] }];
    });
  };
  // Acked, so a message sent now is delivered, not held: the ack is the listener's first line.
  await pollUntil(
    async () => (await Bun.file(out).exists()) && (await Bun.file(out).text()).includes('"ok":true'),
    `${taskId}'s inbox listener to be acked`,
    20_000,
  );
  return {
    taskId,
    pane,
    inbox,
    send: async (to, text) => {
      const n = sent;
      sent += 1;
      await Bun.write(join(dir, `cmd-${n}.json.tmp`), JSON.stringify({ to, kind: "note", text }));
      await rename(join(dir, `cmd-${n}.json.tmp`), join(dir, `cmd-${n}.json`));
      const res = join(dir, `res-${n}.json`);
      await pollUntil(() => Bun.file(res).exists(), `the send ${n} from ${taskId} to answer`, 30_000);
      const answer: unknown = JSON.parse(await Bun.file(res).text());
      if (!isRecord(answer) || typeof answer["ok"] !== "boolean" || typeof answer["text"] !== "string") {
        throw new Error(`not a send result: ${JSON.stringify(answer)}`);
      }
      return {
        ok: answer["ok"],
        text: answer["text"],
        ...(typeof answer["id"] === "string" ? { id: answer["id"] } : {}),
      };
    },
  };
}

/** A line the session's inbox has received that contains `needle`. */
async function received(s: Session, needle: string): Promise<string | undefined> {
  return (await s.inbox()).find((line) => line.push.includes(needle))?.push;
}

describe("session messages across machines: sender ↔ leader ↔ target daemon ↔ receipt", () => {
  test("a message from a task on one machine reaches a task on another through the real gate, and the sender's pane gets the receipt", async () => {
    const tasks: string[] = [];
    try {
      const target = await runTask("suite");
      tasks.push(target);
      const sender = await runTask("box");
      tasks.push(sender);
      const t = await session(target, "suite");
      const s = await session(sender, "box");

      const result = await s.send(target, SECRET);
      expect(result.ok).toBe(true);
      expect(result.text).toContain("sent through the scheduler");
      expect(result.text).toContain("receipt note");
      await pollUntil(
        async () => (await received(t, SECRET)) !== undefined,
        "the text to reach the target's pane",
        20_000,
      );
      const push = (await received(t, SECRET)) ?? "";
      expect(push).toContain(sender);
      expect(push).toContain("MsgBox");
      await pollUntil(
        async () => (await received(s, "was delivered")) !== undefined,
        "the receipt in the sender's pane",
        20_000,
      );
      const receipt = (await received(s, "was delivered")) ?? "";
      expect(receipt).toContain(result.id ?? "no id");
      expect(receipt).toContain(target);
      expect(receipt).not.toContain(SECRET);
      // The receipt is the only line the sender got: the leader kept nothing else to send.
      expect((await s.inbox()).filter((line) => line.push.includes(SECRET))).toEqual([]);
    } finally {
      for (const id of tasks) await cancelTask(client(), id);
    }
  }, 120_000);

  test("the other way: a task on the leader's machine reaches one on a second machine, whose daemon delivers it", async () => {
    const tasks: string[] = [];
    try {
      const target = await runTask("box");
      tasks.push(target);
      const sender = await runTask("suite");
      tasks.push(sender);
      const t = await session(target, "box");
      const s = await session(sender, "suite");

      const result = await s.send(target, SECRET);
      expect(result.ok).toBe(true);
      await pollUntil(
        async () => (await received(t, SECRET)) !== undefined,
        "the text to reach the second machine's pane",
        20_000,
      );
      await pollUntil(
        async () => (await received(s, "was delivered")) !== undefined,
        "the receipt in the leader's own machine's pane",
        20_000,
      );
    } finally {
      for (const id of tasks) await cancelTask(client(), id);
    }
  }, 120_000);

  test("a task that ended is answered by the leader as settled: the receipt says it has no live session", async () => {
    const sender = await runTask("box");
    const target = await runTask("suite");
    try {
      const s = await session(sender, "box");
      const targetPane = await paneOf(target);
      await cancelTask(client(), target);
      await pollUntil(
        async () => !(await tmuxOk(["list-panes", "-a", "-F", "#{pane_id}"])).split("\n").includes(targetPane),
        "the cancelled task's pane to close",
        20_000,
      );
      const result = await s.send(target, SECRET);
      expect(result.ok).toBe(true);
      await pollUntil(
        async () => (await received(s, "no live session")) !== undefined,
        "the receipt saying the task has no live session",
        20_000,
      );
    } finally {
      await cancelTask(client(), sender);
      await cancelTask(client(), target);
    }
  }, 120_000);

  test("a message to a superseded task follows its chain: no such task while the successor is missing, then the successor's session", async () => {
    // The predecessor was seeded superseded naming a successor the queue does not hold yet, so the chain breaks.
    const sender = await runTask("box");
    let successorRunning = false;
    try {
      const s = await session(sender, "box");
      const first = await s.send(PREDECESSOR, SECRET);
      expect(first.ok).toBe(true);
      await pollUntil(
        async () => (await received(s, "holds no such task")) !== undefined,
        "the receipt saying the scheduler holds no such task",
        20_000,
      );

      const created = await client().createTask({
        id: SUCCESSOR,
        spec: {
          repo: origin,
          mode: "worktree",
          succeeds: {
            task: PREDECESSOR,
            account: "org:e2e",
            at: { deviceId: stack.deviceId, exclave: "default", clone: cloneName },
            trigger: "manual",
          },
        },
        state: "queued",
        createdAt: Date.now(),
      });
      expect(created).toEqual({ ok: true, landedEarlier: false });
      await running(SUCCESSOR);
      successorRunning = true;
      const t = await session(SUCCESSOR, "suite");
      const again = await s.send(PREDECESSOR, `${SECRET}-again`);
      expect(again.ok).toBe(true);
      await pollUntil(
        async () => (await received(t, `${SECRET}-again`)) !== undefined,
        "the text to reach the successor's pane",
        20_000,
      );
      await pollUntil(
        async () => (await received(s, `now carried by task \`${SUCCESSOR}\``)) !== undefined,
        "the receipt naming the successor",
        20_000,
      );
    } finally {
      await cancelTask(client(), sender);
      if (successorRunning) await cancelTask(client(), SUCCESSOR);
    }
  }, 150_000);

  test("a target on a machine that went offline is reported offline in the sender's pane", async () => {
    const target = await runTask("box");
    const sender = await runTask("suite");
    let stopped = false;
    try {
      const s = await session(sender, "suite");
      await second?.stop();
      stopped = true;
      const boxId = machineId("box");
      await app?.waitForApp(
        (state) => state.relay.machines.find((m) => m.deviceId === boxId)?.connected === false,
        "the app to see the second machine offline",
      );
      const result = await s.send(target, SECRET);
      expect(result.ok).toBe(true);
      await pollUntil(
        async () => (await received(s, "offline")) !== undefined,
        "the receipt saying the target is offline",
        20_000,
      );
    } finally {
      await cancelTask(client(), sender);
      // The target's machine is gone: its record settles when it returns, and the file's afterAll stops what is left.
      if (!stopped) await cancelTask(client(), target);
    }
  }, 120_000);
});
