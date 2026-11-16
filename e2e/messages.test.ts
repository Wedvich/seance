import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { CAPABILITIES, isRecord, type Task } from "@seance/shared";
import { tmuxOk } from "../daemon/src/tmux.ts";
import { linkClaudeNamed, pollUntil, underClaude } from "../daemon/test/fixtures.ts";
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
 * target daemon's delivery into a pane's real `seance inbox` listener, the receipt back to the sender's own pane, and
 * the sender's `sendMessage` with the route gate built exactly as `seance mcp` builds it (`messageRouteGate`) over a
 * real fleet. A stand-in "session" is a script in each task's stub pane.
 */

let suite: Suite | undefined;
let base: string;
/** A process named `claude`, linked and run once in `beforeAll` so no test's timed window pays a first-exec scan. */
let claudeBin: string;
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

/** The second machine; on the same state dir it boots again as the same device, as the other e2e files rely on. */
const bootBox = (): Promise<SecondDaemon> =>
  stack.startSecondDaemon({
    name: "MsgBox",
    exclaves: [{ id: "default", observedAtMs: Date.now(), fiveHourPct: 10 }],
  });

beforeAll(async () => {
  suite = await startSuite("e2e-messages");
  ({ base, stack } = suite);
  claudeBin = await linkClaudeNamed(join(base, "claude-bin"));
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
  second = await bootBox();
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

interface InboxEntry {
  readonly push: string;
  readonly messageKind: string;
  readonly id?: string;
  /** The daemon's mark that this answers a question the session itself sent. */
  readonly wake?: true;
}

interface SendOpts {
  readonly kind?: "note" | "question" | "request";
  readonly inReplyTo?: string;
}

interface Session {
  /** The session's task, or null for one started by hand. */
  readonly taskId: string | null;
  readonly pane: string;
  /** Lines the session's inbox listener wrote, parsed. */
  readonly inbox: () => Promise<InboxEntry[]>;
  /** The sender's answers, one per `send`. `to` is left out to reply by `inReplyTo` alone. */
  readonly send: (
    to: string | undefined,
    text: string,
    opts?: SendOpts,
  ) => Promise<{ ok: boolean; text: string; id?: string }>;
}

/** Puts a session's two commands in a pane: the task's own (through its stub), or a hand-started one's new window. */
type Launch = (command: string) => Promise<string>;

/**
 * The stand-in session for a task: in its pane, a `seance inbox` listener against its machine's daemon (what the inbox
 * mod runs) and a sender that calls `sendMessage` with the gate `seance mcp` builds, fed by files so one pane sends
 * as often as a test needs. Every command is a separate bun process in the pane, as a session's tools are.
 */
async function session(taskId: string, box: "suite" | "box"): Promise<Session> {
  const pane = await paneOf(taskId);
  return sessionIn(taskId, taskId, box, async (command) => {
    await stack.stub.runInPane(pane, command);
    return pane;
  });
}

/**
 * A session with no task: a window in the box's tmux session running a shell, whose child is a process named `claude`
 * (the daemon finds a session by that name) with the listener and the sender as its own children, as a hand-started
 * session's `seance inbox` and `seance mcp` are. Bound to the process under the pane's, not the pane's own.
 */
async function untaskedSession(label: string, box: "suite" | "box"): Promise<Session> {
  const tmuxSession = box === "suite" ? stack.config.tmuxSession : (second?.tmuxSession ?? "");
  return sessionIn(label, null, box, async (command) =>
    (
      await tmuxOk([
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        `${tmuxSession}:`,
        "-n",
        label,
        "sh",
        "-c",
        `${underClaude(claudeBin, { body: command })}; exec sleep 600`,
      ])
    ).trim(),
  );
}

async function sessionIn(label: string, taskId: string | null, box: "suite" | "box", launch: Launch): Promise<Session> {
  const dir = join(base, `session-${label}`);
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
  const pane = await launch(
    taskId === null
      ? `${listener} & ${q(process.execPath)} ${q(script)} & wait`
      : `${listener} & ${q(process.execPath)} ${q(script)} & exec sleep 600`,
  );
  let sent = 0;
  const inbox = async (): Promise<InboxEntry[]> => {
    const text = (await Bun.file(out).exists()) ? await Bun.file(out).text() : "";
    return text.split("\n").flatMap((line) => {
      if (line === "") return [];
      const parsed: unknown = JSON.parse(line);
      // The ack is the listener's first line and carries no push.
      if (!isRecord(parsed) || typeof parsed["push"] !== "string" || typeof parsed["messageKind"] !== "string") {
        return [];
      }
      return [
        {
          push: parsed["push"],
          messageKind: parsed["messageKind"],
          ...(typeof parsed["id"] === "string" ? { id: parsed["id"] } : {}),
          ...(parsed["wake"] === true ? { wake: true as const } : {}),
        },
      ];
    });
  };
  // Acked, so a message sent now is delivered, not held: the ack is the listener's first line.
  await pollUntil(
    async () => (await Bun.file(out).exists()) && (await Bun.file(out).text()).includes('"ok":true'),
    `${label}'s inbox listener to be acked`,
    20_000,
  );
  return {
    taskId,
    pane,
    inbox,
    send: async (to, text, opts = {}) => {
      const n = sent;
      sent += 1;
      await Bun.write(
        join(dir, `cmd-${n}.json.tmp`),
        JSON.stringify({
          ...(to === undefined ? {} : { to }),
          kind: opts.kind ?? "note",
          text,
          ...(opts.inReplyTo === undefined ? {} : { inReplyTo: opts.inReplyTo }),
        }),
      );
      await rename(join(dir, `cmd-${n}.json.tmp`), join(dir, `cmd-${n}.json`));
      const res = join(dir, `res-${n}.json`);
      await pollUntil(() => Bun.file(res).exists(), `the send ${n} from ${label} to answer`, 30_000);
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

/** As `received`, with the line's own fields: its id and whether it woke the session. */
async function receivedEntry(s: Session, needle: string): Promise<InboxEntry | undefined> {
  return (await s.inbox()).find((line) => line.push.includes(needle));
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
    let successorCreated = false;
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
          // Routing ignores `succeeds.at`, and both machines list the fixture repo: pinned, the session is where `session` looks.
          pin: { deviceId: stack.deviceId },
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
      successorCreated = true;
      await running(SUCCESSOR, "suite");
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
      if (successorCreated) await cancelTask(client(), SUCCESSOR);
    }
  }, 150_000);

  test("a session with no task asks a task on another machine, is answered by the id alone with a wake, and the exchange carries on both ways", async () => {
    const target = await runTask("suite");
    let untasked: Session | undefined;
    try {
      const t = await session(target, "suite");
      untasked = await untaskedSession("e2e-untasked", "box");
      const u = untasked;

      const asked = await u.send(target, `${SECRET}-question`, { kind: "question" });
      expect(asked.ok).toBe(true);
      expect(asked.text).toContain("sent through the scheduler");
      const question = asked.id ?? "no id";
      await pollUntil(
        async () => (await received(t, `${SECRET}-question`)) !== undefined,
        "the question to reach the task's pane",
        20_000,
      );
      // The untasked sender is named as such and told to answer by the id alone.
      const push = (await received(t, `${SECRET}-question`)) ?? "";
      expect(push).toContain("an untasked session on `MsgBox`");
      expect(push).toContain(`inReplyTo ${question}, and no \`to\``);
      // Its receipt reaches it too: its own daemon's table finds the pane, there being no task to name.
      await pollUntil(
        async () => (await received(u, "was delivered")) !== undefined,
        "the receipt in the untasked session's pane",
        20_000,
      );

      // The task answers with no `to`: the handle is the address, and the answer wakes the asker.
      const answered = await t.send(undefined, `${SECRET}-answer`, { inReplyTo: question });
      expect(answered.ok).toBe(true);
      expect(answered.text).toContain("sent through the scheduler to the session that sent message");
      await pollUntil(
        async () => (await receivedEntry(u, `${SECRET}-answer`)) !== undefined,
        "the answer to reach the untasked session",
        20_000,
      );
      const woken = await receivedEntry(u, `${SECRET}-answer`);
      expect(woken?.wake).toBe(true);
      expect(woken?.push).toContain(target);
      await pollUntil(
        async () => (await received(t, "your reply")) !== undefined,
        "the receipt for the reply in the task's pane",
        20_000,
      );

      // And back: the untasked session answers the answer, which was a note it had not asked, so it wakes nobody.
      const thanks = await u.send(undefined, `${SECRET}-thanks`, { inReplyTo: answered.id ?? "no id" });
      expect(thanks.ok).toBe(true);
      await pollUntil(
        async () => (await receivedEntry(t, `${SECRET}-thanks`)) !== undefined,
        "the thanks to reach the task",
        20_000,
      );
      expect((await receivedEntry(t, `${SECRET}-thanks`))?.wake).toBeUndefined();
    } finally {
      if (untasked !== undefined) await tmuxOk(["kill-pane", "-t", untasked.pane]).catch(() => "");
      await cancelTask(client(), target);
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
      if (stopped) {
        // Same device, back up: the target's session lives in its tmux server and its record is the machine's to settle,
        // so the machine returns for the cancel instead of leaving a running task holding a slot.
        second = await bootBox();
        const boxId = machineId("box");
        await app?.waitForApp(
          (state) => state.relay.machines.find((m) => m.deviceId === boxId)?.connected === true,
          "the second machine to return",
        );
      }
      await cancelTask(client(), target);
    }
  }, 120_000);
});
