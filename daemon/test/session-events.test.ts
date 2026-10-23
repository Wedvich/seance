import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent, SessionsResponse } from "@seance/shared";
import type { SessionBackend } from "../src/backend.ts";
import type { ExclaveScan } from "../src/exclaves.ts";
import { createHandler, createLocalOps, type HandlerContext } from "../src/handlers.ts";
import { localRequest } from "../src/local-client.ts";
import { startLocalSocket, type LocalSocketHandle } from "../src/local-socket.ts";
import { SESSION_EVENT_KIND, SESSION_EVENT_VERSION } from "../src/session-event-frame.ts";
import { createSessionEvents, EndedTasks, listPanePids, type SessionEvents } from "../src/session-events.ts";
import { tmuxOk } from "../src/tmux.ts";
import { pollUntil, usePrivateTmux, type PrivateTmux } from "./fixtures.ts";

/**
 * The session-event path with the binding real: a sender inside a tmux pane,
 * the local socket asking the kernel for its pid, and the daemon walking that
 * pid up to the pane. Only the relay is absent — `forward` is where the sealed
 * send to the leader would start.
 */

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

let base: string;
let stateDir: string;
let sockPath: string;
let privateTmux: PrivateTmux | undefined;
let socket: LocalSocketHandle;
let events: SessionEvents;
let scan: ExclaveScan;
const forwarded: SessionEvent[] = [];
/** Every frame the socket handed the handler, with the kernel's pid and the reply. */
const handled: { readonly peer: number | null; readonly reply: unknown }[] = [];
/** Every exclave a bound event poked, in order: the `/usage` refresh's trigger. */
const poked: string[] = [];
const ended = new EndedTasks();

/** A backend with no sessions of its own: the `ended` field is what is under test. */
const backend: SessionBackend = {
  spawn: () => Promise.reject(new Error("not in this suite")),
  sessions: () => Promise.resolve([]),
  doctor: () => Promise.resolve([]),
};

const handlerCtx: HandlerContext = {
  backend,
  getRepos: () => [],
  rescan: () => Promise.resolve([]),
  auditSink: () => {},
  tasks: ended,
};

function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-evt-")));
  stateDir = join(base, "state");
  sockPath = join(stateDir, "run", "seanced.sock");
  await mkdir(join(base, "work"), { recursive: true });
  privateTmux = usePrivateTmux(base, "evt");
  await tmuxOk(["new-session", "-d", "-s", "evt", "-c", base, "sleep", "600"]);

  scan = {
    exclaves: [
      { id: "default", root: base, configDir: join(base, ".claude"), configFile: join(base, ".claude.json") },
      {
        id: "work",
        root: join(base, "work"),
        configDir: join(base, ".claude-work"),
        configFile: join(base, ".claude-work", ".claude.json"),
      },
    ],
    info: [
      { id: "default", accountId: null, extraUsageEnabled: null, authOk: false, skills: [] },
      { id: "work", accountId: "org:acct", extraUsageEnabled: false, authOk: true, skills: [] },
    ],
    rejected: [],
  };
  events = createSessionEvents({
    panes: listPanePids,
    exclaves: () => scan.exclaves,
    forward: (event) => void forwarded.push(event),
    onActivity: (exclave) => void poked.push(exclave),
    ended,
    // Coalescing has its own unit test; here every event goes out at once.
    coalesceMs: 0,
  });
  const handle = createHandler(handlerCtx, "local");
  socket = await startLocalSocket({
    handle,
    sessionEvents: async (raw, peer) => {
      const reply = await events.handle(raw, peer);
      handled.push({ peer, reply });
      return reply;
    },
    path: sockPath,
  });
});

afterAll(async () => {
  events.stop();
  socket.stop();
  await privateTmux?.dispose();
  await rm(base, { recursive: true, force: true });
});

interface Sender {
  readonly pane: string;
  /** Releases the pane's command, which waited so the test could tag the pane first. */
  readonly go: () => Promise<void>;
}

/**
 * A pane whose shell waits for a go file, then runs `command` and stays up. The
 * wait is what lets a task tag land before anything is sent, as a spawn tags
 * its pane before claude can start.
 */
async function senderPane(name: string, cwd: string, command: string, taskId?: string): Promise<Sender> {
  const go = join(base, `${name}.go`);
  const script = `while [ ! -e ${shq(go)} ]; do sleep 0.05; done; ${command}; exec sleep 600`;
  const pane = (
    await tmuxOk([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      "evt:",
      "-n",
      name,
      "-c",
      cwd,
      "-e",
      `SEANCE_STATE_DIR=${stateDir}`,
      "sh",
      "-c",
      script,
    ])
  ).trim();
  if (taskId !== undefined) await tmuxOk(["set-option", "-p", "-t", pane, "@seance-task", taskId]);
  return { pane, go: () => writeFile(go, "") };
}

/**
 * A raw frame from inside a pane — not through the CLI, so it can claim whatever it likes.
 * The reply lands by rename, so once `reply` exists it is whole.
 */
async function rawSender(name: string, frame: object): Promise<{ readonly script: string; readonly reply: string }> {
  const file = join(base, `${name}.frame.json`);
  const reply = join(base, `${name}.reply`);
  await writeFile(file, JSON.stringify({ v: SESSION_EVENT_VERSION, kind: SESSION_EVENT_KIND, ...frame }));
  const script = join(base, `${name}.send.ts`);
  await writeFile(
    script,
    `import { rename } from "node:fs/promises";
const frame = await Bun.file(${JSON.stringify(file)}).text();
await new Promise((resolve) => {
  void Bun.connect({ unix: ${JSON.stringify(sockPath)}, socket: {
    open: (s) => void s.write(frame + "\\n"),
    data: async (_s, chunk) => {
      await Bun.write(${JSON.stringify(`${reply}.part`)}, chunk);
      await rename(${JSON.stringify(`${reply}.part`)}, ${JSON.stringify(reply)});
      resolve(undefined);
    },
    close: () => resolve(undefined),
  } });
});
`,
  );
  return { script: `${shq(process.execPath)} ${shq(script)}`, reply };
}

const forwardedFor = (taskId: string): SessionEvent[] => forwarded.filter((e) => e.taskId === taskId);

describe("binding", () => {
  test("an event naming another session and task moves only what the sender's own pane carries", async () => {
    const other = await senderPane("other", base, "true", "task-b");
    const claim = {
      state: "ended",
      // What a forger would reach for: another pane, its task, a session id and an exclave.
      pane: other.pane,
      taskId: "task-b",
      session: other.pane,
      exclave: "default",
      prUrl: "https://github.com/acme/app/pull/7",
    };
    const sent = await rawSender("forger", claim);
    const forger = await senderPane("forger", join(base, "work"), sent.script, "task-a");
    await forger.go();

    await pollUntil(() => forwarded.some((e) => e.taskId === "task-a"), "the forger's event to be forwarded");
    // Forwarding precedes the reply, which the sender then writes from its own process.
    await pollUntil(() => Bun.file(sent.reply).exists(), "the forger's reply");
    expect(JSON.parse(await readFile(sent.reply, "utf8"))).toEqual({ ok: true });
    expect(forwardedFor("task-a")).toEqual([
      {
        session: forger.pane,
        taskId: "task-a",
        exclave: "work",
        state: "ended",
        prUrl: "https://github.com/acme/app/pull/7",
        at: expect.any(Number),
      },
    ]);
    expect(forwardedFor("task-b")).toEqual([]);

    // The session exits after its SessionEnd: the backstop reports its task, and only it —
    // to the scheduler (here the leader's in-process path), never to a local-socket caller.
    await tmuxOk(["kill-pane", "-t", forger.pane]);
    const reply = await createLocalOps(handlerCtx, "leader").sessions();
    expect("sessions" in reply ? reply.ended : undefined).toEqual(["task-a"]);
    expect("sessions" in reply ? reply.ledgerSince : undefined).toEqual(expect.any(Number));
    const local = await localRequest<SessionsResponse>("sessions", {}, { path: sockPath });
    expect(local).not.toHaveProperty("ended");
    expect(local).not.toHaveProperty("ledgerSince");
  });

  test("a sender in no pane is refused, whatever pane it names", async () => {
    const target = await senderPane("target", base, "true", "task-c");
    let reply = "";
    await new Promise<void>((resolve) => {
      void Bun.connect<undefined>({
        unix: sockPath,
        socket: {
          open: (s) =>
            void s.write(
              `${JSON.stringify({ v: SESSION_EVENT_VERSION, kind: SESSION_EVENT_KIND, state: "busy", pane: target.pane })}\n`,
            ),
          data: (_s, chunk) => {
            reply = chunk.toString("utf8");
            resolve();
          },
          close: () => resolve(),
        },
      });
    });
    expect(JSON.parse(reply)).toEqual({ ok: false, code: "unbound" });
    // The reply follows the handling, so nothing forwarded by now never will be.
    expect(forwardedFor("task-c")).toEqual([]);
  });
});

function frameNaming(pane: string): object {
  return { v: SESSION_EVENT_VERSION, kind: SESSION_EVENT_KIND, state: "ended", pane };
}

describe("binding without a peer pid", () => {
  // macOS's LOCAL_PEERPID fails once the peer has closed, so a sender that
  // writes and exits fast reaches the handler with no pid — on a host that
  // names every other connection's. Its claim must not decide the pane.
  test("a sender that writes a frame naming another pane and exits at once is refused", async () => {
    const target = await senderPane("fast-target", base, "true", "task-fast");
    const script = join(base, "fast.send.ts");
    await writeFile(
      script,
      `const frame = ${JSON.stringify(`${JSON.stringify(frameNaming(target.pane))}
`)};
await Bun.connect({ unix: ${JSON.stringify(sockPath)}, socket: {
  open: (s) => { s.write(frame); s.end(); process.exit(0); },
  data: () => {},
} });
`,
    );
    const before = handled.length;
    const sender = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "ignore" });
    await sender.exited;
    await pollUntil(() => handled.length > before, "the fast sender's frame to be handled");
    expect(handled.at(-1)?.reply).toEqual({ ok: false, code: "unbound" });
    expect(forwardedFor("task-fast")).toEqual([]);
  });

  test("per host, not per connection: a missing pid is refused where the host names peers, and the pane decides only where it names none", async () => {
    const target = await senderPane("hostless", base, "true", "task-hostless");
    const onHost = (hostNamesPeers: boolean): SessionEvents =>
      createSessionEvents({
        panes: listPanePids,
        exclaves: () => scan.exclaves,
        forward: (event) => void forwarded.push(event),
        ended,
        coalesceMs: 0,
        hostNamesPeers: () => hostNamesPeers,
      });
    const naming = onHost(true);
    const peerless = onHost(false);
    try {
      expect(await naming.handle(frameNaming(target.pane), null)).toEqual({ ok: false, code: "unbound" });
      expect(forwardedFor("task-hostless")).toEqual([]);
      expect(await peerless.handle(frameNaming(target.pane), null)).toEqual({ ok: true });
      expect(forwardedFor("task-hostless")).toMatchObject([{ session: target.pane, state: "ended" }]);
    } finally {
      naming.stop();
      peerless.stop();
    }
  });
});

describe("PR URLs", () => {
  test("only an https: URL reaches a forwarded event", async () => {
    const cases = [
      { task: "pr-js", url: "javascript:alert(1)//github.com/acme/app/pull/1", kept: undefined },
      { task: "pr-http", url: "http://github.com/acme/app/pull/2", kept: undefined },
      { task: "pr-creds", url: "https://user:pw@github.com/acme/app/pull/3", kept: undefined },
      { task: "pr-ok", url: "https://github.com/acme/app/pull/4", kept: "https://github.com/acme/app/pull/4" },
    ];
    const senders = await Promise.all(
      cases.map(async ({ task, url }) => {
        const sent = await rawSender(task, { state: "busy", prUrl: url });
        return senderPane(task, base, sent.script, task);
      }),
    );
    await Promise.all(senders.map((s) => s.go()));
    await pollUntil(() => cases.every(({ task }) => forwardedFor(task).length === 1), "every PR event");
    for (const { task, kept } of cases) {
      const [event] = forwardedFor(task);
      expect(event?.state).toBe("busy");
      expect(event?.prUrl).toBe(kept);
    }
  });
});

describe("`seanced session-event` and a done report (#21)", () => {
  /** The CLI run outside any pane, as the mod's hook runs it; it exits once the daemon has answered or it gave up. */
  async function runCli(input: object): Promise<void> {
    const proc = Bun.spawn([process.execPath, MAIN, "session-event"], {
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, SEANCE_STATE_DIR: stateDir },
    });
    expect(await proc.exited).toBe(0);
  }

  test("refuses state: done — the MCP tool is the only report path — while other states still reach the daemon", async () => {
    const before = handled.length;
    await runCli({ state: "done" });
    // The CLI waits for the daemon's answer before it exits, so a frame it sent is already handled.
    expect(handled.length).toBe(before);
    await runCli({ state: "busy" });
    expect(handled.length).toBe(before + 1);
  });
});

describe("activity", () => {
  test("a report through `seanced session-event` pokes the sender's exclave — an older mod's rate limits included — and forwards nothing", async () => {
    const input = join(base, "legacy.json");
    // What a session started before the mod dropped its rate-limit tap still sends.
    await writeFile(input, JSON.stringify({ rateLimits: [{ kind: "five_hour", percentUsed: 42.4 }] }));
    // No task on this pane: activity is the exclave's whatever the session.
    const cli = `${shq(process.execPath)} ${shq(MAIN)} session-event < ${shq(input)}`;
    const sender = await senderPane("legacy", join(base, "work"), cli);
    const before = { poked: poked.length, forwarded: forwarded.length, handled: handled.length };
    await sender.go();
    await pollUntil(() => handled.length > before.handled, "the report to be handled", 10_000);
    expect(handled.at(-1)?.reply).toEqual({ ok: true });
    expect(poked.slice(before.poked)).toEqual(["work"]);
    expect(forwarded.length).toBe(before.forwarded);
  });
});
