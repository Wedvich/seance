import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent, SessionsResponse } from "@seance/shared";
import type { SessionBackend } from "../src/backend.ts";
import type { ExclaveScan } from "../src/exclaves.ts";
import { createHandler } from "../src/handlers.ts";
import { localRequest } from "../src/local-client.ts";
import { startLocalSocket, type LocalSocketHandle } from "../src/local-socket.ts";
import { MetricsStore } from "../src/metrics-store.ts";
import {
  createSessionEvents,
  EndedTasks,
  listPanePids,
  SESSION_EVENT_KIND,
  SESSION_EVENT_VERSION,
  SessionQuota,
  type SessionEvents,
} from "../src/session-events.ts";
import { createTelemetry } from "../src/telemetry.ts";
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
const quota = new SessionQuota();
const ended = new EndedTasks();

/** A backend with no sessions of its own: the `ended` field is what is under test. */
const backend: SessionBackend = {
  spawn: () => Promise.reject(new Error("not in this suite")),
  sessions: () => Promise.resolve([]),
  doctor: () => Promise.resolve([]),
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
    quota,
    ended,
    // Coalescing has its own unit test; here every event goes out at once.
    coalesceMs: 0,
  });
  const handle = createHandler(
    {
      backend,
      getRepos: () => [],
      rescan: () => Promise.resolve([]),
      auditSink: () => {},
      tasks: ended,
    },
    "local",
  );
  socket = await startLocalSocket({ handle, sessionEvents: events.handle, path: sockPath });
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

    // The session exits after its SessionEnd: the backstop reports its task, and only it.
    await tmuxOk(["kill-pane", "-t", forger.pane]);
    const reply = await localRequest<SessionsResponse>("sessions", {}, { path: sockPath });
    expect("sessions" in reply ? reply.ended : undefined).toEqual(["task-a"]);
    expect("sessions" in reply ? reply.ledgerSince : undefined).toEqual(expect.any(Number));
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

describe("rate limits", () => {
  test("a session's report through `seanced session-event` becomes a quota observation in status", async () => {
    const resets = "2026-10-16T18:00:00.000Z";
    const input = join(base, "quota.json");
    await writeFile(
      input,
      JSON.stringify({
        rateLimits: [
          { kind: "five_hour", percentUsed: 42.4, resetsAt: resets },
          { kind: "seven_day", percentUsed: 10 },
          { kind: "spend_limit", percentUsed: 99 },
        ],
      }),
    );
    // No task on this pane: quota is the exclave's whatever the session, and nothing is forwarded.
    const cli = `${shq(process.execPath)} ${shq(MAIN)} session-event < ${shq(input)}`;
    const sender = await senderPane("quota", join(base, "work"), cli);
    const before = forwarded.length;
    await sender.go();
    await pollUntil(() => quota.get("work") !== undefined, "the report to land", 10_000);
    expect(forwarded.length).toBe(before);

    const telemetry = createTelemetry(MetricsStore.memory(), {
      machine: "test",
      diskPaths: [base],
      registered: () => ({ scan: 1, exclaves: scan }),
      sessions: () => Promise.resolve([]),
      sessionQuota: (exclave) => quota.get(exclave),
    });
    const snapshot = await telemetry.tick();
    expect(snapshot.quota).toEqual([
      { x: 1, s: "session", at: expect.any(Number), h: 42, d: 10, hr: Date.parse(resets) / 1000 },
    ]);
  });
});
