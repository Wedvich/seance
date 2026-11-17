import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INBOX_MAX_BYTES,
  INBOX_MAX_MESSAGES,
  MESSAGE_MAX,
  MESSAGE_PUSH_MAX,
  receiptNote,
  type DeliverMessageRequest,
  type MessageReceiptRequest,
  type SessionMessage,
} from "@seance/shared";
import { messageAudit, type MessageAudit } from "../src/audit.ts";
import { exec } from "../src/exec.ts";
import { startLocalSocket, type LocalSocketHandle } from "../src/local-socket.ts";
import type { InboxLine, MessageReply } from "../src/message-frame.ts";
import {
  createMessages,
  REPLY_HANDLE_MAX,
  REPLY_HANDLE_TTL_MS,
  type ListenerSink,
  type Messages,
  type MessagesDeps,
} from "../src/messages.ts";
import { EndedTasks, listPanePids } from "../src/session-events.ts";
import { LaunchLedger } from "../src/launch-ledger.ts";
import { processNames } from "../src/peer.ts";
import { paneWindowName, tmuxOk } from "../src/tmux.ts";
import { linkClaudeNamed, pollUntil, underClaude, usePrivateTmux, type PrivateTmux } from "./fixtures.ts";

/**
 * Session messages with the binding real: panes in a private tmux server, the kernel's peer pid, and for the
 * socket-level cases the real `seance inbox` child and a sender in its own pane. The cases that need no socket
 * call the surface with a pid inside a pane, which `ancestorIn` resolves exactly as a connection's would, and an
 * injected clock for the grace and the rate limit.
 */

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const LOCAL_CLIENT = join(import.meta.dir, "..", "src", "local-client.ts");
const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

let base: string;
let stateDir: string;
let sockPath: string;
let privateTmux: PrivateTmux | undefined;
/** A process named `claude`: the binding finds a session by that name (`processNames`). */
let claudeBin: string;
/** The same binary under a version's name, as the native installer keeps it and macOS tmux reads it. */
let versionedBin: string;
let socket: LocalSocketHandle;
let socketMessages: Messages;

const clock = { now: 1_000_000 };
const ended = new EndedTasks(
  LaunchLedger.memory(() => clock.now),
  () => clock.now,
);

type AuditLine = Parameters<MessageAudit>[0];
const audits: AuditLine[] = [];
/** The same lines as the daemon's log carries them. */
const lines: string[] = [];
const audit: MessageAudit = (line) => {
  audits.push(line);
  return messageAudit((formatted) => void lines.push(formatted))(line);
};
/** Everything a test sent: none of it may reach an audit line. */
const texts: string[] = [];

const made: Messages[] = [];

function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function setup(overrides: Partial<MessagesDeps> = {}): Messages {
  const messages = createMessages({
    panes: listPanePids,
    windowName: () => Promise.resolve("Sender"),
    launchedAt: (taskId) => ended.launchedAt(taskId),
    machine: "testbox",
    audit,
    now: () => clock.now,
    ...overrides,
  });
  made.push(messages);
  return messages;
}

let counter = 0;
/** A fresh task id, recorded in the ledger as launched now. */
async function launched(label: string): Promise<string> {
  counter += 1;
  const id = `task-${label}-${counter}`;
  await ended.ledger.record(id);
  return id;
}

interface Pane {
  readonly id: string;
  readonly pid: number;
}

/** A pane running a `claude`-named process, whose own pid stands as the peer: `ancestorIn` takes the first hit, which is itself. */
async function pane(name: string, taskId?: string): Promise<Pane> {
  const out = (
    await tmuxOk([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id} #{pane_pid}",
      "-t",
      "msg:",
      "-n",
      name,
      "-c",
      base,
      claudeBin,
      "-e",
      "await Bun.sleep(600_000);",
    ])
  ).trim();
  const [id, pid] = out.split(" ");
  if (id === undefined || pid === undefined) throw new Error(`no pane from ${out}`);
  // The pane's process reads as tmux's own fork until its exec lands.
  await pollUntil(async () => (await processNames(Number(pid))).includes("claude"), `${name}'s claude to exec`);
  if (taskId !== undefined) await tmuxOk(["set-option", "-p", "-t", id, "@seance-task", taskId]);
  return { id, pid: Number(pid) };
}

function sinkDouble(failAfter = Infinity): {
  readonly sink: ListenerSink;
  readonly lines: string[];
  readonly closed: () => boolean;
  readonly drop: () => void;
} {
  const written: string[] = [];
  const gone = new AbortController();
  let closed = false;
  return {
    sink: {
      write: (line) => {
        if (closed) return false;
        if (written.length >= failAfter) {
          // As the real sink's: a write it cannot take closes the connection.
          closed = true;
          gone.abort();
          return false;
        }
        written.push(line);
        return true;
      },
      close: () => {
        closed = true;
        gone.abort();
      },
      gone: gone.signal,
    },
    lines: written,
    closed: () => closed,
    drop: () => gone.abort(),
  };
}

const INBOX = { v: 1, kind: "inbox" };
function message(to: string, messageKind: "note" | "question" | "request", text: string, inReplyTo?: string): object {
  texts.push(text);
  return { v: 1, kind: "message", to, messageKind, text, ...(inReplyTo === undefined ? {} : { inReplyTo }) };
}

const lineOf = (raw: string | undefined): InboxLine => JSON.parse(raw ?? "null") as InboxLine;
const inAudits = (outcome: string): AuditLine[] => audits.filter((a) => a.dir === "in" && a.outcome === outcome);

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-msg-")));
  stateDir = join(base, "state");
  claudeBin = await linkClaudeNamed(join(base, "claude-bin"));
  versionedBin = await linkClaudeNamed(join(base, "versioned-bin"), "9.9.9");
  sockPath = join(stateDir, "run", "seanced.sock");
  await mkdir(stateDir, { recursive: true });
  privateTmux = usePrivateTmux(base, "msg");
  await tmuxOk(["new-session", "-d", "-s", "msg", "-c", base, "sleep", "600"]);
  socketMessages = createMessages({
    panes: listPanePids,
    windowName: paneWindowName,
    launchedAt: (taskId) => ended.launchedAt(taskId),
    machine: "testbox",
    audit,
    now: () => clock.now,
  });
  socket = await startLocalSocket({ handle: () => Promise.resolve(null), messages: socketMessages, path: sockPath });
});

afterEach(() => {
  while (made.length > 0) made.pop()?.stop();
  audits.length = 0;
  lines.length = 0;
});

afterAll(async () => {
  socketMessages.stop();
  socket.stop();
  await privateTmux?.dispose();
  await rm(base, { recursive: true, force: true });
});

interface Runner {
  readonly pane: string;
  readonly go: () => Promise<void>;
}

/**
 * A pane whose shell waits for a go file, then runs `command` and stays up, so a tag lands before anything is
 * sent, as a spawn tags its pane before claude can start.
 */
async function runner(name: string, command: string, taskId?: string): Promise<Runner> {
  const go = join(base, `${name}.go`);
  const script = `while [ ! -e ${shq(go)} ]; do sleep 0.05; done; ${command}; exec sleep 600`;
  const id = (
    await tmuxOk([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      "msg:",
      "-n",
      name,
      "-c",
      base,
      "-e",
      `SEANCE_STATE_DIR=${stateDir}`,
      "sh",
      "-c",
      script,
    ])
  ).trim();
  if (taskId !== undefined) await tmuxOk(["set-option", "-p", "-t", id, "@seance-task", taskId]);
  return { pane: id, go: () => writeFile(go, "") };
}

/**
 * `seance inbox`, the real CLI: stdout to a file, its exit code beside it, renamed in. A redirect creates the
 * file before `echo` writes it, so a test polling for it to exist could read it empty.
 */
function inboxCommand(out: string, state = stateDir): string {
  return `SEANCE_STATE_DIR=${shq(state)} ${shq(process.execPath)} ${shq(MAIN)} inbox > ${shq(out)}; echo $? > ${shq(`${out}.exit.part`)} && mv ${shq(`${out}.exit.part`)} ${shq(`${out}.exit`)}`;
}

/** The raw replies to `frames`, sent in order from inside the pane: not through `sendMessage`, so the reply is the daemon's own. */
async function senderCommand(name: string, frames: readonly object[]): Promise<{ command: string; replies: string }> {
  const file = join(base, `${name}.frames.json`);
  const replies = join(base, `${name}.replies`);
  await writeFile(file, JSON.stringify(frames));
  const script = join(base, `${name}.send.ts`);
  await writeFile(
    script,
    `import { rename } from "node:fs/promises";
import { exchange } from ${JSON.stringify(LOCAL_CLIENT)};
const frames = JSON.parse(await Bun.file(${JSON.stringify(file)}).text());
const replies = [];
for (const frame of frames) {
  replies.push(await exchange(frame, { path: ${JSON.stringify(sockPath)}, timeoutMs: 8000, timeoutText: "no reply" }));
}
await Bun.write(${JSON.stringify(`${replies}.part`)}, JSON.stringify(replies));
await rename(${JSON.stringify(`${replies}.part`)}, ${JSON.stringify(replies)});
`,
  );
  return { command: `${shq(process.execPath)} ${shq(script)}`, replies };
}

const readLines = async (file: string): Promise<string[]> => {
  try {
    return (await readFile(file, "utf8")).split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
};

describe("the real listener child and a real sender", () => {
  test("tasked and untasked listeners are both acked, and a note arrives as one line naming its sender", async () => {
    const receiver = await launched("recv");
    const sender = await launched("send");
    const recvOut = join(base, "a-recv.out");
    const bareOut = join(base, "a-bare.out");
    const recv = await runner("a-recv", inboxCommand(recvOut), receiver);
    const bare = await runner("a-bare", underClaude(claudeBin, { body: inboxCommand(bareOut) }));
    await recv.go();
    await bare.go();
    await pollUntil(async () => (await readLines(recvOut)).length > 0, "the tasked listener's ack");
    await pollUntil(async () => (await readLines(bareOut)).length > 0, "the untasked listener's ack");
    const ack = { ok: true, keep: { messages: INBOX_MAX_MESSAGES, bytes: INBOX_MAX_BYTES } };
    expect(JSON.parse((await readLines(recvOut))[0] ?? "")).toEqual(ack);
    // Acked and staying up: an untasked session is no longer refused (exit 4), since a reply can reach it.
    expect(JSON.parse((await readLines(bareOut))[0] ?? "")).toEqual(ack);
    expect(await Bun.file(`${bareOut}.exit`).exists()).toBe(false);

    const text = "schema v2 landed";
    const send = await senderCommand("a-send", [message(receiver, "note", text)]);
    const from = await runner("Sender Win", send.command, sender);
    await from.go();
    await pollUntil(() => Bun.file(send.replies).exists(), "the sender's reply");
    const [reply] = JSON.parse(await readFile(send.replies, "utf8")) as { ok: boolean; id: string; outcome: string }[];
    expect(reply).toEqual({ ok: true, id: expect.stringMatching(MESSAGE_ID), outcome: "delivered" });

    await pollUntil(async () => (await readLines(recvOut)).length >= 2, "the message line");
    const delivered = lineOf((await readLines(recvOut))[1]);
    expect(delivered).toEqual({ v: 1, id: reply?.id ?? "", messageKind: "note", push: expect.any(String) });
    expect(delivered.push).toContain(sender);
    expect(delivered.push).toContain("Sender Win");
    expect(delivered.push).toContain("testbox");
    expect(delivered.push).toContain(text);

    expect(lines.filter((l) => l.includes(`to="${receiver}"`))).toEqual([
      `audit message origin=message dir=out from="${sender}" to="${receiver}" kind=note bytes=${text.length} outcome=delivered`,
      `audit message origin=message dir=in from="${sender}" to="${receiver}" kind=note bytes=${text.length} outcome=delivered`,
    ]);
    expect(lines.join("\n")).not.toContain("schema");
  });

  test("one listener per pane: a second in the same pane makes the first exit 0, and the next message goes only to the second", async () => {
    const receiver = await launched("one");
    const sender = await launched("onesend");
    const outA = join(base, "d-a.out");
    const outB = join(base, "d-b.out");
    const go2 = join(base, "d-second.go");
    const command = `(${inboxCommand(outA)}) & while [ ! -e ${shq(go2)} ]; do sleep 0.05; done; ${inboxCommand(outB)}`;
    const listeners = await runner("d-listeners", command, receiver);
    await listeners.go();
    await pollUntil(async () => (await readLines(outA)).length > 0, "the first listener's ack");
    await writeFile(go2, "");
    await pollUntil(async () => (await readLines(outB)).length > 0, "the second listener's ack");
    await pollUntil(() => Bun.file(`${outA}.exit`).exists(), "the first listener to exit");
    expect((await readFile(`${outA}.exit`, "utf8")).trim()).toBe("0");

    const send = await senderCommand("d-send", [message(receiver, "note", "second only")]);
    const from = await runner("d-from", send.command, sender);
    await from.go();
    await pollUntil(async () => (await readLines(outB)).length >= 2, "the line on the second listener");
    expect(lineOf((await readLines(outB))[1]).push).toContain("second only");
    expect((await readLines(outA)).length).toBe(1);
  });

  test("the CLI's exit code is the mod's backoff signal: 3 for unsupported, 5 for a pane in no tmux of the daemon's, 2 for no daemon, a close with no reply, and a reader that went away", async () => {
    const exitOf = async (name: string, state: string): Promise<string> => {
      const out = join(base, `${name}.out`);
      const proc = Bun.spawn(["sh", "-c", inboxCommand(out, state)], { stdout: "ignore", stderr: "ignore" });
      await proc.exited;
      return (await readFile(`${out}.exit`, "utf8")).trim();
    };

    // A daemon that runs no message delivery answers the inbox frame `unsupported`.
    const bare = join(base, "exit-bare");
    await mkdir(bare, { recursive: true });
    const bareSocket = await startLocalSocket({
      handle: () => Promise.resolve(null),
      path: join(bare, "run", "seanced.sock"),
    });
    try {
      expect(await exitOf("x-unsupported", bare)).toBe("3");
    } finally {
      bareSocket.stop();
    }

    // This process runs in no pane of the daemon's tmux: its pid walks to none.
    expect(await exitOf("x-unbound", stateDir)).toBe("5");

    // Nothing listening.
    expect(await exitOf("x-nodaemon", join(base, "exit-none"))).toBe("2");

    // A connection closed with no reply: an older daemon dropping the frame as malformed.
    const quiet = join(base, "exit-quiet");
    await mkdir(join(quiet, "run"), { recursive: true });
    const server = Bun.listen<undefined>({
      unix: join(quiet, "run", "seanced.sock"),
      socket: { data: (sock) => void sock.end(), open: () => {} },
    });
    try {
      expect(await exitOf("x-noreply", quiet)).toBe("2");
    } finally {
      server.stop(true);
    }
  });

  test("a child whose stdout has no reader exits 2 at its first write, so the daemon holds the next message instead of calling it delivered", async () => {
    const receiver = await launched("epipe");
    const sender = await launched("epipesend");
    const out = join(base, "epipe.out");
    const readerPid = join(base, "epipe.reader");
    // The reader records its pid (atomically) and exits at once; the child starts only once that pid is gone, so
    // its first write, the ack, meets a closed pipe rather than racing the reader's exit.
    const reader = `echo $$ > ${shq(`${readerPid}.part`)} && mv ${shq(`${readerPid}.part`)} ${shq(readerPid)}`;
    const child = `SEANCE_STATE_DIR=${shq(stateDir)} ${shq(process.execPath)} ${shq(MAIN)} inbox; echo $? > ${shq(`${out}.exit.part`)} && mv ${shq(`${out}.exit.part`)} ${shq(`${out}.exit`)}`;
    const wait = `while [ ! -e ${shq(readerPid)} ] || kill -0 "$(cat ${shq(readerPid)})" 2>/dev/null; do sleep 0.05; done`;
    const command = `( ${wait}; ${child} ) | sh -c ${shq(reader)}`;
    const listeners = await runner("epipe-listener", command, receiver);
    await listeners.go();
    await pollUntil(() => Bun.file(`${out}.exit`).exists(), "the child to exit on its broken stdout");
    expect((await readFile(`${out}.exit`, "utf8")).trim()).toBe("2");

    // The connection is gone with the child, so the message is held for a listener, not called delivered.
    const send = await senderCommand("epipe-send", [message(receiver, "note", "to a dead reader")]);
    const from = await runner("epipe-from", send.command, sender);
    await from.go();
    await pollUntil(() => Bun.file(send.replies).exists(), "the sender's reply");
    expect(JSON.parse(await readFile(send.replies, "utf8"))).toEqual([
      { ok: true, id: expect.stringMatching(MESSAGE_ID), outcome: "sent" },
    ]);
  });

  test("a child orphaned by its parent's death exits within seconds and drops its binding, so the next message is held, not called delivered", async () => {
    const receiver = await launched("orphan");
    const sender = await launched("orphansend");
    const out = join(base, "orphan.out");
    const parentFile = join(base, "orphan.parent");
    const childFile = join(base, "orphan.child");
    // The inner shell stands for claude: the child's parent, killed below. `$!` is the child's own pid, as the
    // background simple command execs in place.
    const inner = `echo $$ > ${shq(parentFile)}; SEANCE_STATE_DIR=${shq(stateDir)} ${shq(process.execPath)} ${shq(MAIN)} inbox > ${shq(out)} & echo $! > ${shq(childFile)}; wait`;
    const listeners = await runner("orphan-listener", `sh -c ${shq(inner)}`, receiver);
    await listeners.go();
    await pollUntil(async () => (await readLines(out)).length > 0, "the listener's ack");
    const pidOf = async (file: string): Promise<number> => Number((await readFile(file, "utf8")).trim());
    const [parent, child] = [await pidOf(parentFile), await pidOf(childFile)];
    // A zombie still answers `kill(pid, 0)`, and whatever reaps an orphan here (init, a subreaper, a container's
    // PID 1) may not do it promptly: exited is what counts.
    const alive = async (pid: number): Promise<boolean> => {
      const ps = await exec(["ps", "-o", "stat=", "-p", String(pid)]);
      return ps.exitCode === 0 && !ps.stdout.trim().startsWith("Z");
    };
    expect(await alive(child)).toBe(true);

    process.kill(parent, "SIGKILL");
    await pollUntil(async () => !(await alive(child)), "the orphaned child to exit", 10_000);

    const send = await senderCommand("orphan-send", [message(receiver, "note", "to a dead session")]);
    const from = await runner("orphan-from", send.command, sender);
    await from.go();
    await pollUntil(() => Bun.file(send.replies).exists(), "the sender's reply");
    expect(JSON.parse(await readFile(send.replies, "utf8"))).toEqual([
      { ok: true, id: expect.stringMatching(MESSAGE_ID), outcome: "sent" },
    ]);
  });

  test("an unbound sender, in no pane, is refused", async () => {
    // This process runs in no pane: its pid walks to none.
    let reply = "";
    await new Promise<void>((resolve) => {
      void Bun.connect<undefined>({
        unix: sockPath,
        socket: {
          open: (s) => void s.write(`${JSON.stringify(message("task-nobody", "note", "x"))}\n`),
          data: (_s, chunk) => {
            reply = chunk.toString("utf8");
            resolve();
          },
          close: () => resolve(),
        },
      });
    });
    expect(JSON.parse(reply)).toEqual({ ok: false, code: "unbound" });
    expect(audits.at(-1)).toMatchObject({ dir: "out", from: undefined, outcome: "unbound" });
    expect(lines.at(-1)).toContain("from=- ");
  });
});

describe("refusing to bind", () => {
  test("a null pid is refused for a listener and a sender, never bound by a claim, and the listener's sink is closed", async () => {
    const messages = setup();
    const receiver = await launched("null");
    await pane("null-pane", receiver);
    const listener = sinkDouble();
    await messages.listen(INBOX, null, listener.sink);
    expect(listener.lines.map((l) => JSON.parse(l))).toEqual([{ ok: false, code: "unbound" }]);
    expect(listener.closed()).toBe(true);
    expect(await messages.send(message(receiver, "note", "x"), null)).toEqual({ ok: false, code: "unbound" });
  });

  test("a host that names no peers refuses even a pid that sits in a pane: a listener is told unsupported (a retry changes nothing), a sender unbound", async () => {
    const messages = setup({ hostNamesPeers: () => false });
    const receiver = await launched("host");
    const target = await pane("host-pane", receiver);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    expect(listener.lines.map((l) => JSON.parse(l))).toEqual([{ ok: false, code: "unsupported" }]);
    expect(listener.closed()).toBe(true);
    expect(await messages.send(message(receiver, "note", "x"), target.pid)).toEqual({ ok: false, code: "unbound" });
  });

  test("a pane with no task, or one tagged with an id this machine never launched, is acked (a reply can reach it) but no task id does", async () => {
    const messages = setup();
    const bare = await pane("bare-pane");
    const forged = await pane("forged-pane", "task-never-launched-here");
    const listeners = [];
    for (const target of [bare, forged]) {
      const listener = sinkDouble();
      listeners.push(listener);
      // oxlint-disable-next-line no-await-in-loop -- one pane at a time
      await messages.listen(INBOX, target.pid, listener.sink);
      expect(listener.lines.map((l) => JSON.parse(l))).toEqual([
        { ok: true, keep: { messages: INBOX_MAX_MESSAGES, bytes: INBOX_MAX_BYTES } },
      ]);
      expect(listener.closed()).toBe(false);
    }
    // Neither is any task's address: the forged tag resolves to no launch, the bare pane to no tag.
    const from = await pane("bare-from", await launched("bare-from"));
    expect(await messages.send(message("task-never-launched-here", "note", "x"), from.pid)).toEqual({
      ok: false,
      code: "unknown",
    });
    for (const listener of listeners) expect(listener.lines).toHaveLength(1);
  });

  test("a frame that is not exactly {v:1, kind:inbox} is invalid, so a listener can never name a pane", async () => {
    const messages = setup();
    const target = await pane("inv-pane", await launched("inv"));
    const listener = sinkDouble();
    await messages.listen({ v: 1, kind: "inbox", pane: "%1" }, target.pid, listener.sink);
    expect(listener.lines.map((l) => JSON.parse(l))).toEqual([{ ok: false, code: "invalid" }]);
    expect(listener.closed()).toBe(true);
    expect(
      await messages.send(
        { v: 1, kind: "message", to: "task-x", messageKind: "note", text: "x", pane: "%1" },
        target.pid,
      ),
    ).toEqual({ ok: false, code: "invalid" });
  });
});

describe("the daemon's inbox", () => {
  test("holds for a listener that has not connected, then flushes in order; past 32 messages the oldest are dropped and the next push says so", async () => {
    const messages = setup({ graceMs: 1e9 });
    const receiver = await launched("cap");
    const sender = await launched("capsend");
    const target = await pane("cap-target", receiver);
    const from = await pane("cap-from", sender);
    const replies = [];
    for (let i = 0; i < 34; i++) {
      clock.now += 5_000;
      // oxlint-disable-next-line no-await-in-loop -- ordered sends
      replies.push(await messages.send(message(receiver, "note", `n${i}`), from.pid));
    }
    expect(replies.every((r) => r.ok && r.outcome === "sent")).toBe(true);
    expect(inAudits("dropped")).toHaveLength(2);
    expect(inAudits("dropped").map((a) => a.bytes)).toEqual([2, 2]);

    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    const [ack, ...delivered] = listener.lines;
    expect(JSON.parse(ack ?? "")).toMatchObject({ ok: true });
    expect(delivered).toHaveLength(INBOX_MAX_MESSAGES);
    expect(lineOf(delivered[0]).push).toContain("2 earlier message(s) to this session were dropped before delivery.");
    expect(lineOf(delivered[0]).push).toContain("n2");
    expect(lineOf(delivered[1]).push).not.toContain("dropped before delivery");
    expect(lineOf(delivered.at(-1)).push).toContain("n33");
    expect(inAudits("delivered")).toHaveLength(INBOX_MAX_MESSAGES);
  });

  test("is capped by bytes too: five 60 KiB notes keep the newest four, each a stub with its body", async () => {
    const messages = setup({ graceMs: 1e9 });
    const receiver = await launched("bytes");
    const sender = await launched("bytessend");
    const target = await pane("bytes-target", receiver);
    const from = await pane("bytes-from", sender);
    for (let i = 0; i < 5; i++) {
      clock.now += 5_000;
      // oxlint-disable-next-line no-await-in-loop -- ordered sends
      await messages.send(message(receiver, "note", `${i}`.repeat(60 * 1024)), from.pid);
    }
    expect(inAudits("dropped")).toHaveLength(1);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    const delivered = listener.lines.slice(1).map(lineOf);
    expect(delivered).toHaveLength(4);
    expect(delivered[0]?.push).toContain("earlier message(s) to this session were dropped");
    expect(delivered[0]?.push).toContain("61440 bytes; call read_messages to read it");
    expect(delivered[0]?.body).toContain("1".repeat(100));
    expect(delivered[3]?.body).toContain("4".repeat(100));
  });

  test("each held message has its own grace: an earlier one's expiry takes no later one with it", async () => {
    // Real timers: the second message must still be held when the first expires, and the listener must connect
    // between the two expiries, so the margin is the gap (1.5 s), wide enough for a slow `list-panes`.
    const messages = setup({ graceMs: 3_000 });
    const receiver = await launched("peritem");
    const sender = await launched("peritemsend");
    const target = await pane("peritem-target", receiver);
    const from = await pane("peritem-from", sender);
    await messages.send(message(receiver, "note", "first"), from.pid);
    // The second is held part-way through the first's grace: a fixed wait is the scenario itself.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1_500);
    });
    await messages.send(message(receiver, "note", "second"), from.pid);
    await pollUntil(() => inAudits("nolistener").length === 1, "the first message's grace to end");
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    expect(listener.lines).toHaveLength(2);
    expect(lineOf(listener.lines[1]).push).toContain("second");
    expect(inAudits("nolistener")).toHaveLength(1);
    expect(inAudits("delivered")).toHaveLength(1);
  });

  test("a write that fails mid-flush leaves the rest held for the next listener, and the dropped notice is not repeated", async () => {
    const messages = setup({ graceMs: 1e9 });
    const receiver = await launched("flush");
    const sender = await launched("flushsend");
    const target = await pane("flush-target", receiver);
    const from = await pane("flush-from", sender);
    for (let i = 0; i < 34; i++) {
      clock.now += 5_000;
      // oxlint-disable-next-line no-await-in-loop -- ordered sends
      await messages.send(message(receiver, "note", `n${i}`), from.pid);
    }
    // The ack and one message get out, then the connection dies.
    const first = sinkDouble(2);
    await messages.listen(INBOX, target.pid, first.sink);
    expect(first.lines).toHaveLength(2);
    expect(lineOf(first.lines[1]).push).toContain("2 earlier message(s)");
    expect(inAudits("delivered")).toHaveLength(1);
    expect(inAudits("nolistener")).toHaveLength(0);

    const second = sinkDouble();
    await messages.listen(INBOX, target.pid, second.sink);
    const [, ...rest] = second.lines;
    expect(rest).toHaveLength(INBOX_MAX_MESSAGES - 1);
    expect(lineOf(rest[0]).push).toContain("n3");
    expect(lineOf(rest[0]).push).not.toContain("dropped before delivery");
    expect(lineOf(rest.at(-1)).push).toContain("n33");
    expect(inAudits("delivered")).toHaveLength(INBOX_MAX_MESSAGES);
    expect(inAudits("nolistener")).toHaveLength(0);
  });

  test("is cleared when its pane is bound to another task: the held messages are audited ended and nothing is delivered", async () => {
    const messages = setup({ graceMs: 1e9 });
    const old = await launched("old");
    const next = await launched("new");
    const sender = await launched("rebsend");
    const target = await pane("rebind-target", old);
    const from = await pane("rebind-from", sender);
    expect(await messages.send(message(old, "note", "for the old task"), from.pid)).toMatchObject({
      ok: true,
      outcome: "sent",
    });
    await tmuxOk(["set-option", "-p", "-t", target.id, "@seance-task", next]);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    // The ack only: nothing held for another task reaches this session.
    expect(listener.lines).toHaveLength(1);
    expect(inAudits("ended")).toHaveLength(1);
    expect(inAudits("delivered")).toHaveLength(0);
  });

  test("is cleared on the pane's ended: the held messages are audited ended and a later listener gets none", async () => {
    const messages = setup({ graceMs: 1e9 });
    const receiver = await launched("end");
    const sender = await launched("endsend");
    const target = await pane("end-target", receiver);
    const from = await pane("end-from", sender);
    await messages.send(message(receiver, "note", "one"), from.pid);
    await messages.send(message(receiver, "question", "two"), from.pid);
    messages.onEnded(target.id, receiver);
    expect(inAudits("ended")).toHaveLength(2);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    expect(listener.lines).toHaveLength(1);
    expect(inAudits("delivered")).toHaveLength(0);
  });

  test("an ended for another task leaves the held messages, and closes only a listener bound to that task", async () => {
    const messages = setup({ graceMs: 1e9 });
    const receiver = await launched("keep");
    const sender = await launched("keepsend");
    const target = await pane("keep-target", receiver);
    const from = await pane("keep-from", sender);
    await messages.send(message(receiver, "note", "stays"), from.pid);
    messages.onEnded(target.id, "task-someone-else");
    expect(inAudits("ended")).toHaveLength(0);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    expect(listener.lines).toHaveLength(2);
    messages.onEnded(target.id, receiver);
    expect(listener.closed()).toBe(true);
  });
});

describe("when there is no listener", () => {
  test("a message held within the grace is audited nolistener when the grace ends, and one sent after it is answered ended/nolistener", async () => {
    const messages = setup({ graceMs: 300 });
    const receiver = await launched("grace");
    const sender = await launched("gracesend");
    await pane("grace-target", receiver);
    const from = await pane("grace-from", sender);
    expect(await messages.send(message(receiver, "note", "held"), from.pid)).toMatchObject({
      ok: true,
      outcome: "sent",
    });
    await pollUntil(() => inAudits("nolistener").length === 1, "the held message to be dropped at the grace's end");
    clock.now += 10_000;
    expect(await messages.send(message(receiver, "note", "late"), from.pid)).toEqual({
      ok: false,
      code: "ended",
      reason: "nolistener",
    });
    expect(audits.filter((a) => a.outcome === "nolistener" && a.dir === "out")).toHaveLength(1);
    expect(inAudits("nolistener")).toHaveLength(2);
  });

  test("a listener that dropped is waited for within the grace, and not past it", async () => {
    const messages = setup({ graceMs: 60_000 });
    const receiver = await launched("drop");
    const sender = await launched("dropsend");
    const target = await pane("drop-target", receiver);
    const from = await pane("drop-from", sender);
    // Long past the launch and the daemon's own start, so only the disconnect's grace can hold it.
    clock.now += 600_000;
    const first = sinkDouble();
    await messages.listen(INBOX, target.pid, first.sink);
    first.drop();
    clock.now += 30_000;
    expect(await messages.send(message(receiver, "note", "soon"), from.pid)).toMatchObject({
      ok: true,
      outcome: "sent",
    });
    clock.now += 61_000;
    expect(await messages.send(message(receiver, "note", "late"), from.pid)).toMatchObject({
      ok: false,
      reason: "nolistener",
    });
  });

  test("a restarted daemon treats every live pane as just disconnected, so a mod that is reconnecting is not told it has no listener", async () => {
    const receiver = await launched("restart");
    const sender = await launched("restartsend");
    await pane("restart-target", receiver);
    const from = await pane("restart-from", sender);
    clock.now += 600_000;
    const messages = setup({ graceMs: 60_000 });
    expect(await messages.send(message(receiver, "note", "right after start"), from.pid)).toMatchObject({
      ok: true,
      outcome: "sent",
    });
    clock.now += 61_000;
    expect(await messages.send(message(receiver, "note", "much later"), from.pid)).toMatchObject({ ok: false });
  });

  test("a task that was never launched here is unknown, one launched with no pane is held while starting and ended afterwards", async () => {
    const messages = setup({ graceMs: 60_000 });
    const sender = await launched("unksend");
    const from = await pane("unk-from", sender);
    expect(await messages.send(message("task-never-launched", "note", "x"), from.pid)).toEqual({
      ok: false,
      code: "unknown",
    });
    const gone = await launched("gone");
    expect(await messages.send(message(gone, "note", "x"), from.pid)).toEqual({ ok: false, code: "held" });
    expect(audits.at(-1)).toMatchObject({ dir: "out", to: gone, outcome: "held" });
    clock.now += 61_000;
    expect(await messages.send(message(gone, "note", "x"), from.pid)).toEqual({ ok: false, code: "ended" });
    expect(audits.at(-1)).toMatchObject({ dir: "out", to: gone, outcome: "ended" });
  });
});

describe("size, kind and rate", () => {
  test("a request over the push cap and any message over the hard cap are too_long; a note between them arrives as a stub with its full body", async () => {
    const messages = setup();
    const receiver = await launched("big");
    const sender = await launched("bigsend");
    const target = await pane("big-target", receiver);
    const from = await pane("big-from", sender);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);

    expect(await messages.send(message(receiver, "request", "r".repeat(MESSAGE_PUSH_MAX + 1)), from.pid)).toEqual({
      ok: false,
      code: "too_long",
    });
    expect(await messages.send(message(receiver, "note", "n".repeat(MESSAGE_MAX + 1)), from.pid)).toEqual({
      ok: false,
      code: "too_long",
    });
    // Bytes, not characters.
    expect(await messages.send(message(receiver, "request", "é".repeat(MESSAGE_PUSH_MAX / 2 + 1)), from.pid)).toEqual({
      ok: false,
      code: "too_long",
    });
    expect(audits.filter((a) => a.outcome === "too_long")).toHaveLength(3);
    expect(listener.lines).toHaveLength(1);

    const body = "b".repeat(MESSAGE_PUSH_MAX + 1);
    const reply = await messages.send(message(receiver, "question", body), from.pid);
    expect(reply).toMatchObject({ ok: true, outcome: "delivered" });
    const stub = lineOf(listener.lines[1]);
    expect(stub.push).toContain(`${MESSAGE_PUSH_MAX + 1} bytes; call read_messages to read it`);
    expect(stub.push).not.toContain(body);
    expect(stub.body).toContain(body);
    expect(stub.body).toContain("A question from another Séance session");

    const small = await messages.send(message(receiver, "request", "do it", stub.id), from.pid);
    expect(small).toMatchObject({ ok: true, outcome: "delivered" });
    const request = lineOf(listener.lines[2]);
    expect(request.body).toBeUndefined();
    expect(request.push).toContain("It replies to your message `" + stub.id + "`");
  });

  test("the 21st message inside a minute is rate limited, and the window slides", async () => {
    const messages = setup({ graceMs: 1e9 });
    const receiver = await launched("rate");
    const sender = await launched("ratesend");
    await pane("rate-target", receiver);
    const from = await pane("rate-from", sender);
    const replies = [];
    for (let i = 0; i < 21; i++) {
      // oxlint-disable-next-line no-await-in-loop -- ordered sends
      replies.push(await messages.send(message(receiver, "note", `r${i}`), from.pid));
    }
    expect(replies.slice(0, 20).every((r) => r.ok)).toBe(true);
    expect(replies[20]).toEqual({ ok: false, code: "rate_limited" });
    expect(audits.at(-1)).toMatchObject({ dir: "out", outcome: "rate_limited" });
    clock.now += 61_000;
    expect(await messages.send(message(receiver, "note", "again"), from.pid)).toMatchObject({ ok: true });
  });

  test("200 an hour per task holds even when no minute is full", async () => {
    const messages = setup({ graceMs: 1e9 });
    const receiver = await launched("hour");
    const sender = await launched("hoursend");
    await pane("hour-target", receiver);
    const from = await pane("hour-from", sender);
    let last: unknown;
    for (let i = 0; i < 201; i++) {
      clock.now += 15_000;
      // oxlint-disable-next-line no-await-in-loop -- ordered sends
      last = await messages.send(message(receiver, "note", `h${i}`), from.pid);
    }
    expect(last).toEqual({ ok: false, code: "rate_limited" });
  });
});

describe("a sender that claims a task", () => {
  test("a pane tagged with an id this machine never launched is untasked: no borrowed name in the wrapper, and one rate bucket however many ids it tries", async () => {
    const messages = setup({ graceMs: 1e9 });
    const receiver = await launched("forge");
    const victim = await launched("victim");
    const target = await pane("forge-target", receiver);
    const forger = await pane("forge-from", "task-forged-a");
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);

    expect(await messages.send(message(receiver, "note", "claims to be the victim"), forger.pid)).toMatchObject({
      ok: true,
      outcome: "delivered",
    });
    expect(lineOf(listener.lines[1]).push).toContain("an untasked session on `testbox`");
    expect(audits.at(-1)).toMatchObject({ dir: "in", from: null });
    expect(lines.at(-1)).toContain("from=untasked");
    expect(lineOf(listener.lines[1]).push).not.toContain(victim);

    for (let i = 0; i < 19; i++) {
      // oxlint-disable-next-line no-await-in-loop -- ordered sends
      await tmuxOk(["set-option", "-p", "-t", forger.id, "@seance-task", `task-forged-${i}`]);
      // oxlint-disable-next-line no-await-in-loop
      expect(await messages.send(message(receiver, "note", `f${i}`), forger.pid)).toMatchObject({ ok: true });
    }
    await tmuxOk(["set-option", "-p", "-t", forger.id, "@seance-task", "task-forged-last"]);
    expect(await messages.send(message(receiver, "note", "one more"), forger.pid)).toEqual({
      ok: false,
      code: "rate_limited",
    });
  });
});

describe("a pane whose task changed under a live listener", () => {
  test("the listener is closed, and a send to the old task finds no pane: held while starting, ended after", async () => {
    const messages = setup({ graceMs: 60_000 });
    const old = await launched("tag");
    const next = await launched("tagnew");
    const sender = await launched("tagsend");
    const target = await pane("tag-target", old);
    const from = await pane("tag-from", sender);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    expect(listener.closed()).toBe(false);

    await tmuxOk(["set-option", "-p", "-t", target.id, "@seance-task", next]);
    expect(await messages.send(message(old, "note", "to the old task"), from.pid)).toEqual({ ok: false, code: "held" });
    expect(listener.closed()).toBe(true);
    clock.now += 61_000;
    expect(await messages.send(message(old, "note", "to the old task"), from.pid)).toEqual({
      ok: false,
      code: "ended",
    });

    // The new task is held for the mod's reconnect, never written to the stale connection.
    expect(listener.lines).toHaveLength(1);
  });
});

describe("every audit line", () => {
  test("carry ids, kind and a byte count only under the message origin, and none carries message text or a window name", async () => {
    const messages = setup();
    const receiver = await launched("fmt");
    const sender = await launched("fmtsend");
    const target = await pane("fmt-target", receiver);
    const from = await pane("fmt-from", sender);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    await messages.send(message(receiver, "note", "secret-note-text"), from.pid);
    await messages.send(message(receiver, "question", "secret-question-text"), from.pid);
    await messages.send(message("task-unknown-x", "request", "secret-request-text"), from.pid);
    await messages.send(message(receiver, "request", "q".repeat(MESSAGE_PUSH_MAX + 1)), from.pid);
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const line of lines) {
      expect(line).toMatch(
        /^audit message origin=message dir=(out|in) from=("[^"]+"|untasked|-) to="[^"]+" kind=\w+ bytes=\d+ outcome=\w+$/u,
      );
      for (const text of ["secret-note-text", "secret-question-text", "secret-request-text", "Sender"]) {
        expect(line).not.toContain(text);
      }
    }
  });
});

const of = (target: Pane, taskId: string): { pid: number; taskId: string } => ({ pid: target.pid, taskId });

describe("a custodian nudge", () => {
  test("goes to the pane's listener as one request in the custodian's wrapper, audited from=custodian, never the text", async () => {
    const messages = setup();
    const receiver = await launched("nudge");
    const target = await pane("nudge-target", receiver);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    texts.push("secret-nudge-text");
    expect(await messages.deliverAsCustodian(target.id, "secret-nudge-text", of(target, receiver))).toEqual({
      ok: true,
      taskId: receiver,
      outcome: "delivered",
    });
    const [, line] = listener.lines;
    const delivered = lineOf(line);
    expect(delivered.messageKind).toBe("request");
    expect(delivered.push).toStartWith("The custodian on `testbox` (message `");
    expect(delivered.push).toContain("```\nsecret-nudge-text\n```");
    expect(delivered.push).not.toContain("send_message");
    expect(delivered.body).toBeUndefined();
    expect(audits).toEqual([
      { dir: "in", from: { custodian: true }, to: receiver, kind: "request", bytes: 17, outcome: "delivered" },
    ]);
    expect(lines).toEqual([
      `audit message origin=message dir=in from=custodian to="${receiver}" kind=request bytes=17 outcome=delivered`,
    ]);
  });

  test("is held for a listener within the grace and delivered when one connects", async () => {
    const messages = setup({ graceMs: 60_000 });
    const receiver = await launched("nudgehold");
    const target = await pane("nudgehold-target", receiver);
    expect(await messages.deliverAsCustodian(target.id, "soon", of(target, receiver))).toEqual({
      ok: true,
      taskId: receiver,
      outcome: "sent",
    });
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    expect(listener.lines.slice(1).map((raw) => lineOf(raw).push.endsWith("```\nsoon\n```"))).toEqual([true]);
  });

  test("a held nudge no listener claims within the grace expires audited nolistener, and a later one is refused no_listener", async () => {
    // The hold's expiry is a real timer: the grace is short so the test waits on it, not on the fake clock.
    const messages = setup({ graceMs: 80 });
    const receiver = await launched("nudgeexpire");
    const target = await pane("nudgeexpire-target", receiver);
    expect(await messages.deliverAsCustodian(target.id, "soon", of(target, receiver))).toMatchObject({
      outcome: "sent",
    });
    await pollUntil(() => inAudits("nolistener").length === 1, "the held nudge's grace to run out");
    expect(inAudits("nolistener").map((a) => a.from)).toEqual([{ custodian: true }]);
    clock.now += 1_000;
    expect(await messages.deliverAsCustodian(target.id, "late", of(target, receiver))).toEqual({
      ok: false,
      code: "no_listener",
    });
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    expect(listener.lines.slice(1)).toEqual([]);
  });

  test("canDeliver answers what a delivery would find, and places and audits nothing", async () => {
    const messages = setup({ graceMs: 60_000 });
    const receiver = await launched("candeliver");
    const target = await pane("candeliver-target", receiver);
    // Inside the grace: a nudge would be held.
    expect(await messages.canDeliver(target.id, of(target, receiver))).toBe(true);
    // Past it, with no listener ever: no_listener.
    clock.now += 120_000;
    expect(await messages.canDeliver(target.id, of(target, receiver))).toBe(false);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    expect(await messages.canDeliver(target.id, of(target, receiver))).toBe(true);
    // Another process or task, or a pane that is not there: the delivery would not land.
    expect(await messages.canDeliver(target.id, { pid: target.pid + 1, taskId: receiver })).toBe(false);
    expect(await messages.canDeliver("%99999", { pid: 1, taskId: "x" })).toBe(false);
    expect(listener.lines.slice(1)).toEqual([]);
    expect(audits).toEqual([]);
  });

  test("a pane carrying another process or task than the counts were written under is gone, nothing placed", async () => {
    const messages = setup({ graceMs: 1e9 });
    const receiver = await launched("nudgemoved");
    const target = await pane("nudgemoved-target", receiver);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    expect(await messages.deliverAsCustodian(target.id, "x", { pid: target.pid + 1, taskId: receiver })).toEqual({
      ok: false,
      code: "gone",
    });
    expect(await messages.deliverAsCustodian(target.id, "x", { pid: target.pid, taskId: "another" })).toEqual({
      ok: false,
      code: "gone",
    });
    expect(listener.lines.slice(1)).toEqual([]);
  });

  test("reaches only a live pane carrying a task this machine launched, under the push cap, and no sender's rate bucket", async () => {
    const messages = setup({ graceMs: 1e9 });
    const untagged = await pane("nudge-untasked");
    const stranger = await pane("nudge-stranger", "task-never-launched-here");
    expect(await messages.deliverAsCustodian(untagged.id, "x", of(untagged, "x"))).toEqual({
      ok: false,
      code: "untasked",
    });
    expect(await messages.deliverAsCustodian(stranger.id, "x", of(stranger, "task-never-launched-here"))).toEqual({
      ok: false,
      code: "untasked",
    });
    expect(await messages.deliverAsCustodian("%99999", "x", { pid: 1, taskId: "x" })).toEqual({
      ok: false,
      code: "gone",
    });
    const receiver = await launched("nudgecap");
    const target = await pane("nudgecap-target", receiver);
    expect(
      await messages.deliverAsCustodian(target.id, "é".repeat(MESSAGE_PUSH_MAX / 2 + 1), of(target, receiver)),
    ).toEqual({
      ok: false,
      code: "too_long",
    });
    for (let i = 0; i < 25; i++) {
      // oxlint-disable-next-line no-await-in-loop -- ordered sends
      expect((await messages.deliverAsCustodian(target.id, `n${i}`, of(target, receiver))).ok).toBe(true);
    }
    messages.stop();
    expect(await messages.deliverAsCustodian(target.id, "x", of(target, receiver))).toEqual({
      ok: false,
      code: "stopping",
    });
  });
});

/** A `message` frame that names its routing step, as `sendMessage` sends one. */
function routedFrame(
  to: string,
  route: "ask" | "send",
  text: string,
  messageKind: "note" | "question" | "request" = "note",
): object {
  texts.push(text);
  return { v: 1, kind: "message", to, messageKind, text, route };
}

describe("routing a message for a task that is not on this machine", () => {
  test("an ask for a task this ledger lacks is remote and audits nothing; asks have their own bucket, so a loop of them is limited and a send is not", async () => {
    const routed: SessionMessage[] = [];
    const messages = setup({
      route: (m) => {
        routed.push(m);
        return Promise.resolve(true);
      },
    });
    const sender = await launched("askfrom");
    const from = await pane("ask-from", sender);
    for (let i = 0; i < 20; i++) {
      // oxlint-disable-next-line no-await-in-loop -- ordered asks
      expect(await messages.send(routedFrame("task-elsewhere", "ask", "x"), from.pid)).toEqual({
        ok: false,
        code: "remote",
      });
    }
    expect(audits).toEqual([]);
    expect(routed).toEqual([]);
    // Each ask costs a pane listing, so the 21st in a minute is refused where it is asked.
    expect(await messages.send(routedFrame("task-elsewhere", "ask", "x"), from.pid)).toEqual({
      ok: false,
      code: "rate_limited",
    });
    // The asks did not count against the sends: the minute's 20 are all still there.
    expect(await messages.send(routedFrame("task-elsewhere", "send", "now"), from.pid)).toMatchObject({
      ok: true,
      outcome: "routed",
    });
  });

  test("a send hands the leader one SessionMessage and audits routed; a refused route is no_leader; no route dep is unsupported", async () => {
    const seen: SessionMessage[] = [];
    const messages = setup({
      route: (m) => {
        seen.push(m);
        return Promise.resolve(true);
      },
    });
    const sender = await launched("sendfrom");
    const from = await pane("send-from", sender);
    const reply = await messages.send(routedFrame("task-elsewhere", "send", "hello", "question"), from.pid);
    expect(reply).toMatchObject({ ok: true, outcome: "routed" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      id: reply.ok ? reply.id : "",
      to: "task-elsewhere",
      kind: "question",
      text: "hello",
      fromTask: sender,
      fromTitle: "Sender",
    });
    expect(audits).toEqual([
      { dir: "out", from: sender, to: "task-elsewhere", kind: "question", bytes: 5, outcome: "routed" },
    ]);

    const refused = setup({ route: () => Promise.resolve(false) });
    expect(await refused.send(routedFrame("task-elsewhere", "send", "x"), from.pid)).toEqual({
      ok: false,
      code: "no_leader",
    });
    expect(audits.at(-1)).toMatchObject({ dir: "out", outcome: "no_leader" });

    const none = setup();
    expect(await none.send(routedFrame("task-elsewhere", "send", "x"), from.pid)).toEqual({
      ok: false,
      code: "unsupported",
    });
  });

  test("an untasked sender is routed with no fromTask, and a receipt is promised as for any sender", async () => {
    const seen: SessionMessage[] = [];
    const messages = setup({
      route: (m) => {
        seen.push(m);
        return Promise.resolve(true);
      },
    });
    const from = await pane("untasked-from");
    expect(await messages.send(routedFrame("task-elsewhere", "send", "hi"), from.pid)).toMatchObject({
      ok: true,
      outcome: "routed",
    });
    expect(seen[0]).not.toHaveProperty("fromTask");
    expect(seen[0]).not.toHaveProperty("fromTitle");
  });

  test("a text within the hard cap that is over the route budget once escaped is too_long with reason route", async () => {
    const messages = setup({ route: () => Promise.resolve(true) });
    const sender = await launched("budgetfrom");
    const from = await pane("budget-from", sender);
    // 20 001 bytes of UTF-8, 40 004 once each quote is escaped.
    const text = '"'.repeat(20_001);
    expect(await messages.send(routedFrame("task-elsewhere", "send", text), from.pid)).toEqual({
      ok: false,
      code: "too_long",
      reason: "route",
    });
    expect((await messages.send(routedFrame("task-elsewhere", "send", '"'.repeat(19_999)), from.pid)).ok).toBe(true);
  });

  test("a local target is delivered locally whatever the route step, and the route is not used", async () => {
    const messages = setup({ route: () => Promise.reject(new Error("must not route")) });
    const receiver = await launched("localask");
    const sender = await launched("localaskfrom");
    const target = await pane("localask-target", receiver);
    const from = await pane("localask-from", sender);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    for (const route of ["ask", "send"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- ordered sends
      expect(await messages.send(routedFrame(receiver, route, `via ${route}`), from.pid)).toMatchObject({
        ok: true,
        outcome: "delivered",
      });
    }
    expect(listener.lines).toHaveLength(3);
  });

  test("a launched task with no pane is held within the grace, and remote past it", async () => {
    const messages = setup({ graceMs: 60_000, route: () => Promise.resolve(true) });
    const sender = await launched("starting-from");
    const from = await pane("starting-from", sender);
    const starting = await launched("starting");
    expect(await messages.send(routedFrame(starting, "ask", "x"), from.pid)).toEqual({ ok: false, code: "held" });
    clock.now += 61_000;
    expect(await messages.send(routedFrame(starting, "ask", "x"), from.pid)).toEqual({ ok: false, code: "remote" });
    // Without a route step it is PR 1's answer.
    expect(await messages.send(message(starting, "note", "x"), from.pid)).toEqual({ ok: false, code: "ended" });
  });
});

describe("a message the leader routed here", () => {
  const request = (
    taskId: string,
    extra: Partial<Extract<DeliverMessageRequest, { readonly taskId: string }>> = {},
  ): DeliverMessageRequest => ({
    id: crypto.randomUUID(),
    taskId,
    addressed: taskId,
    kind: "note",
    text: "routed text",
    fromMachine: "MsgBox",
    fromTask: "t-remote-sender",
    fromTitle: "Remote title",
    ...extra,
  });

  test("goes to the live listener in a wrapper naming the remote machine and task, audited in", async () => {
    const messages = setup();
    const receiver = await launched("routed");
    const target = await pane("routed-target", receiver);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    texts.push("routed text");
    expect(await messages.deliverRouted(request(receiver))).toEqual({ ok: true, outcome: "delivered" });
    const push = lineOf(listener.lines[1]).push;
    expect(push).toContain("MsgBox");
    expect(push).toContain("t-remote-sender");
    expect(push).toContain("Remote title");
    expect(push).toContain("routed text");
    expect(audits).toEqual([
      {
        dir: "in",
        from: "t-remote-sender",
        to: receiver,
        kind: "note",
        bytes: 11,
        outcome: "delivered",
      },
    ]);
  });

  test("is held within the grace for a launch with no pane, and a settled task never is", async () => {
    const messages = setup({ graceMs: 60_000 });
    const starting = await launched("routedstart");
    expect(await messages.deliverRouted(request(starting))).toEqual({ ok: true, outcome: "held" });
    expect(await messages.deliverRouted(request(starting, { settled: true }))).toEqual({
      ok: true,
      outcome: "ended",
    });
    clock.now += 61_000;
    expect(await messages.deliverRouted(request(starting))).toEqual({ ok: true, outcome: "ended" });
  });

  test("a task this ledger never launched is unknown, and a pane with no listener past the grace is ended/nolistener", async () => {
    const messages = setup({ graceMs: 60_000 });
    expect(await messages.deliverRouted(request("task-never-launched"))).toEqual({ ok: true, outcome: "unknown" });
    const receiver = await launched("routednolisten");
    await pane("routednolisten-target", receiver);
    clock.now += 600_000;
    expect(await messages.deliverRouted(request(receiver))).toEqual({
      ok: true,
      outcome: "ended",
      reason: "nolistener",
    });
  });

  test("a message held for a listener is sent, and flushed when one connects", async () => {
    const messages = setup({ graceMs: 60_000 });
    const receiver = await launched("routedhold");
    const target = await pane("routedhold-target", receiver);
    expect(await messages.deliverRouted(request(receiver))).toEqual({ ok: true, outcome: "sent" });
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    expect(listener.lines).toHaveLength(2);
    expect(inAudits("delivered")).toHaveLength(1);
  });

  test("the same id twice inside the replay window is one delivery with the same reply, and is taken again after it", async () => {
    const messages = setup();
    const receiver = await launched("routeddup");
    const target = await pane("routeddup-target", receiver);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    const first = request(receiver);
    const [a, b] = await Promise.all([messages.deliverRouted(first), messages.deliverRouted(first)]);
    expect(a).toEqual({ ok: true, outcome: "delivered" });
    expect(b).toEqual(a);
    clock.now += 60_000;
    expect(await messages.deliverRouted(first)).toEqual(a);
    expect(listener.lines).toHaveLength(2);
    expect(inAudits("delivered")).toHaveLength(1);
    clock.now += 61_000;
    expect(await messages.deliverRouted(first)).toEqual({ ok: true, outcome: "delivered" });
    expect(listener.lines).toHaveLength(3);
  });

  test("an oversize note arrives as a stub the receiver pulls, as a local one does", async () => {
    const messages = setup();
    const receiver = await launched("routedstub");
    const target = await pane("routedstub-target", receiver);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    const text = "x".repeat(MESSAGE_PUSH_MAX + 1);
    texts.push(text);
    await messages.deliverRouted(request(receiver, { text }));
    const line = lineOf(listener.lines[1]);
    expect(line.body).toContain(text);
    expect(line.push).not.toContain(text);
  });
});

describe("a receipt the leader sent here", () => {
  const receiptFor = (
    fromTask: string | undefined,
    over: Partial<MessageReceiptRequest> = {},
  ): MessageReceiptRequest => ({
    id: crypto.randomUUID(),
    to: "t-0123456789abcdef",
    kind: "note",
    outcome: "delivered",
    ...(fromTask === undefined ? {} : { fromTask }),
    ...over,
  });

  test("is one fixed-text note in the sending task's pane, audited as a receipt with no byte count", async () => {
    const messages = setup();
    const sender = await launched("receipt");
    const target = await pane("receipt-target", sender);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    const request = receiptFor(sender, { outcome: "offline" });
    expect(await messages.receipt(request)).toEqual({ ok: true, outcome: "delivered" });
    const line = lineOf(listener.lines[1]);
    expect(line.push).toBe(receiptNote(request));
    expect(line.messageKind).toBe("note");
    expect(audits).toEqual([
      { dir: "receipt", from: sender, to: "t-0123456789abcdef", kind: "note", outcome: "offline" },
    ]);
    expect(lines).toEqual([
      `audit message origin=message dir=receipt from="${sender}" to="t-0123456789abcdef" kind=note bytes=- outcome=offline`,
    ]);
  });

  test("is dropped when no pane carries the task, the task was never launched here, or the sender was untasked", async () => {
    const messages = setup();
    const gone = await launched("receiptgone");
    expect(await messages.receipt(receiptFor(gone))).toEqual({ ok: true, outcome: "dropped" });
    expect(await messages.receipt(receiptFor("task-never-launched"))).toEqual({ ok: true, outcome: "dropped" });
    expect(await messages.receipt(receiptFor(undefined))).toEqual({ ok: true, outcome: "dropped" });
    expect(audits).toEqual([]);
  });

  test("a replay of the same receipt is answered from the first, with one note and one audit line", async () => {
    const messages = setup();
    const sender = await launched("receiptreplay");
    const target = await pane("receiptreplay-target", sender);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    const request = receiptFor(sender);
    const [first, second] = await Promise.all([messages.receipt(request), messages.receipt(request)]);
    expect(first).toEqual({ ok: true, outcome: "delivered" });
    expect(second).toEqual(first);
    expect(listener.lines).toHaveLength(2);
    expect(audits).toHaveLength(1);
    // Another message's receipt is its own.
    expect(await messages.receipt(receiptFor(sender))).toEqual({ ok: true, outcome: "delivered" });
    expect(listener.lines).toHaveLength(3);
  });

  test("is held for a listener within the grace and never audited as a message the receiver got", async () => {
    const messages = setup({ graceMs: 60_000 });
    const sender = await launched("receiptheld");
    const target = await pane("receiptheld-target", sender);
    expect(await messages.receipt(receiptFor(sender))).toEqual({ ok: true, outcome: "sent" });
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    expect(listener.lines).toHaveLength(2);
    expect(inAudits("delivered")).toEqual([]);
  });
});

describe("every audit line of a routed message", () => {
  test("carry ids, kind and a byte count (or none for a receipt), and none carries message text or a title", async () => {
    const messages = setup({ route: () => Promise.resolve(true) });
    const receiver = await launched("fmtroute");
    const sender = await launched("fmtroutesend");
    const target = await pane("fmtroute-target", receiver);
    const from = await pane("fmtroute-from", sender);
    const listener = sinkDouble();
    await messages.listen(INBOX, target.pid, listener.sink);
    texts.push("routed-secret-text");
    await messages.send(routedFrame("task-elsewhere", "send", "routed-secret-text"), from.pid);
    await messages.deliverRouted({
      id: crypto.randomUUID(),
      taskId: receiver,
      addressed: receiver,
      kind: "note",
      text: "forwarded-secret-text",
      fromMachine: "MsgBox",
      fromTask: "t-remote-sender",
      fromTitle: "Secret Title",
    });
    await messages.receipt({
      id: crypto.randomUUID(),
      to: "t-0123456789abcdef",
      kind: "note",
      outcome: "ended",
      fromTask: receiver,
    });
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(line).toMatch(
        /^audit message origin=message dir=(out|in|receipt) from=("[^"]+"|untasked|-) to="[^"]+" kind=\w+ bytes=(\d+|-) outcome=\w+$/u,
      );
      for (const text of ["routed-secret-text", "forwarded-secret-text", "Secret Title", "MsgBox", "Sender"]) {
        expect(line).not.toContain(text);
      }
    }
  });
});

/** A reply by handle: no `to`, the id of the message answered as `inReplyTo`. */
function replyFrame(
  inReplyTo: string,
  messageKind: "note" | "question" | "request",
  text: string,
  route?: "ask" | "send",
): object {
  texts.push(text);
  return { v: 1, kind: "message", messageKind, text, inReplyTo, ...(route === undefined ? {} : { route }) };
}

const idOf = (reply: MessageReply): string => (reply.ok ? reply.id : "");

/** Message ids are bearer handles: no audit line may carry one, nor any text a test sent. */
function expectNoIdsOrText(...ids: readonly string[]): void {
  for (const line of lines) {
    for (const id of ids) expect(line).not.toContain(id);
    // Short texts ("x", "hi") would match the line's own words.
    for (const text of texts) if (text.length >= 8) expect(line).not.toContain(text);
  }
}

/** A pid a script wrote to a file, once the write is whole. */
async function pidFrom(file: string): Promise<number> {
  await pollUntil(async () => (await readLines(file)).length > 0, `${file} to be written`);
  return Number((await readLines(file))[0]);
}

describe("a reply by handle, on one machine", () => {
  test("a task answers an untasked session's question by the id alone, the answer wakes the asker, and no line carries an id or text", async () => {
    const messages = setup();
    const taskId = await launched("rep-t");
    const t = await pane("rep-t", taskId);
    const u = await pane("rep-u");
    const tListener = sinkDouble();
    const uListener = sinkDouble();
    await messages.listen(INBOX, t.pid, tListener.sink);
    await messages.listen(INBOX, u.pid, uListener.sink);

    const asked = await messages.send(message(taskId, "question", "which file?"), u.pid);
    expect(asked).toMatchObject({ ok: true, outcome: "delivered" });
    const q = idOf(asked);
    // The wrapper tells the receiver how to answer a session that has no task.
    expect(lineOf(tListener.lines[1]).push).toContain(`inReplyTo ${q}, and no \`to\``);

    const answered = await messages.send(replyFrame(q, "note", "src/a.ts"), t.pid);
    expect(answered).toMatchObject({ ok: true, outcome: "delivered" });
    const r = idOf(answered);
    const line = lineOf(uListener.lines[1]);
    expect(line).toEqual({ v: 1, id: r, messageKind: "note", push: expect.any(String), wake: true });
    expect(line.push).toContain("src/a.ts");
    expect(line.push).toContain(taskId);
    expect(line.push).toContain(`It replies to your message \`${q}\``);

    // The answer can be answered in turn, and that answer to a note wakes nobody.
    const again = await messages.send(replyFrame(r, "note", "thanks"), u.pid);
    expect(again).toMatchObject({ ok: true, outcome: "delivered" });
    expect(lineOf(tListener.lines[2])).not.toHaveProperty("wake");

    expect(audits.filter((a) => a.to === "reply").map((a) => [a.dir, a.outcome])).toEqual([
      ["out", "delivered"],
      ["in", "delivered"],
      ["out", "delivered"],
      ["in", "delivered"],
    ]);
    expectNoIdsOrText(q, r, idOf(again));
    for (const l of lines) {
      expect(l).toMatch(
        /^audit message origin=message dir=(out|in) from=("[^"]+"|untasked) to="[^"]+" kind=\w+ bytes=\d+ outcome=\w+$/u,
      );
    }
  });

  test("an answer wakes only for a question or request this pane's session sent: not for a note, and not for another pane's", async () => {
    const messages = setup();
    const taskId = await launched("wake-t");
    const t = await pane("wake-t", taskId);
    const u = await pane("wake-u");
    const other = await pane("wake-other");
    const tListener = sinkDouble();
    const uListener = sinkDouble();
    const otherListener = sinkDouble();
    await messages.listen(INBOX, t.pid, tListener.sink);
    await messages.listen(INBOX, u.pid, uListener.sink);
    await messages.listen(INBOX, other.pid, otherListener.sink);

    const note = idOf(await messages.send(message(taskId, "note", "fyi"), u.pid));
    await messages.send(replyFrame(note, "note", "ok"), t.pid);
    expect(lineOf(uListener.lines[1])).not.toHaveProperty("wake");

    const request = idOf(await messages.send(message(taskId, "request", "do it"), u.pid));
    await messages.send(replyFrame(request, "note", "done"), t.pid);
    expect(lineOf(uListener.lines[2]).wake).toBe(true);

    // A message to `other` that names `u`'s question: `u` did not send it from `other`'s pane, so `other` is not woken.
    const question = idOf(await messages.send(message(taskId, "question", "which?"), u.pid));
    const named = await messages.send(replyFrame(question, "note", "that one"), t.pid);
    expect(lineOf(uListener.lines[3]).wake).toBe(true);
    expect(named).toMatchObject({ ok: true });
    expect(otherListener.lines).toHaveLength(1);
  });

  test("a handle is held by the session the message reached: another pane, an unknown id and the asker itself get unknown", async () => {
    const messages = setup();
    const taskId = await launched("own-t");
    const otherId = await launched("own-x");
    const t = await pane("own-t", taskId);
    const x = await pane("own-x", otherId);
    const u = await pane("own-u");
    for (const target of [t, x, u]) {
      // oxlint-disable-next-line no-await-in-loop -- one listener at a time
      await messages.listen(INBOX, target.pid, sinkDouble().sink);
    }
    const q = idOf(await messages.send(message(taskId, "question", "which?"), u.pid));

    expect(await messages.send(replyFrame(q, "note", "me too"), x.pid)).toEqual({ ok: false, code: "unknown" });
    expect(await messages.send(replyFrame(crypto.randomUUID(), "note", "guess"), x.pid)).toEqual({
      ok: false,
      code: "unknown",
    });
    // The asker holds no handle for its own message: it was never placed in its pane.
    expect(await messages.send(replyFrame(q, "note", "myself"), u.pid)).toEqual({ ok: false, code: "unknown" });
    expect(audits.filter((a) => a.dir === "in" && a.to === "reply")).toEqual([]);
    expect(audits.filter((a) => a.outcome === "unknown").map((a) => a.to)).toEqual(["reply", "reply", "reply"]);
  });

  test("a reply to an asker whose listener only dropped waits for that session, and one to an asker with no listener is ended", async () => {
    const messages = setup();
    const taskId = await launched("nl-t");
    const t = await pane("nl-t", taskId);
    const u = await pane("nl-u");
    const tListener = sinkDouble();
    const uListener = sinkDouble();
    await messages.listen(INBOX, t.pid, tListener.sink);
    await messages.listen(INBOX, u.pid, uListener.sink);
    const q = idOf(await messages.send(message(taskId, "question", "which?"), u.pid));

    // Dropped, not gone: the reconnect grace holds the answer for that very session.
    uListener.drop();
    expect(await messages.send(replyFrame(q, "note", "held answer"), t.pid)).toMatchObject({
      ok: true,
      outcome: "sent",
    });
    const back = sinkDouble();
    await messages.listen(INBOX, u.pid, back.sink);
    expect(back.lines).toHaveLength(2);
    expect(lineOf(back.lines[1]).wake).toBe(true);
    expect(lineOf(back.lines[1]).push).toContain("held answer");

    // Never listened: no launch or restart grace applies to a session nobody was waiting for.
    const w = await pane("nl-w");
    const asked = idOf(await messages.send(message(taskId, "question", "and you?"), w.pid));
    expect(await messages.send(replyFrame(asked, "note", "nobody there"), t.pid)).toEqual({
      ok: false,
      code: "ended",
      reason: "nolistener",
    });
    expect(inAudits("nolistener").filter((a) => a.to === "reply")).toHaveLength(1);
  });

  test("a handle lapses after an hour", async () => {
    const messages = setup();
    const taskId = await launched("ttl-t");
    const t = await pane("ttl-t", taskId);
    const u = await pane("ttl-u");
    await messages.listen(INBOX, t.pid, sinkDouble().sink);
    await messages.listen(INBOX, u.pid, sinkDouble().sink);
    const first = idOf(await messages.send(message(taskId, "question", "first"), u.pid));
    clock.now += REPLY_HANDLE_TTL_MS - 1;
    const second = idOf(await messages.send(message(taskId, "question", "second"), u.pid));
    expect(await messages.send(replyFrame(first, "note", "still good"), t.pid)).toMatchObject({ ok: true });
    clock.now += 1;
    expect(await messages.send(replyFrame(first, "note", "too late"), t.pid)).toEqual({ ok: false, code: "unknown" });
    expect(await messages.send(replyFrame(second, "note", "in time"), t.pid)).toMatchObject({ ok: true });
  });

  test("a daemon keeps 256 handles: past that the oldest is forgotten and the newest still answers", async () => {
    const taskId = await launched("hcap-t");
    const t = await pane("hcap-t", taskId);
    const senders = [await pane("hcap-u1"), await pane("hcap-u2")];
    // One pane listing for all of them: 257 sends would otherwise cost 257 tmux round trips.
    const snapshot = await listPanePids();
    const messages = setup({ panes: () => Promise.resolve(snapshot) });
    await messages.listen(INBOX, t.pid, sinkDouble().sink);
    for (const sender of senders) {
      // oxlint-disable-next-line no-await-in-loop -- one listener at a time
      await messages.listen(INBOX, sender.pid, sinkDouble().sink);
    }
    const ids: string[] = [];
    for (let i = 0; i < REPLY_HANDLE_MAX + 1; i++) {
      // Two panes and 4 s apart keep each under the rate limits, and the 257 inside the hour.
      clock.now += 4_000;
      const from = senders[i % 2];
      if (from === undefined) throw new Error("no sender");
      // oxlint-disable-next-line no-await-in-loop -- ordered sends
      ids.push(idOf(await messages.send(message(taskId, "question", `q${i}`), from.pid)));
    }
    expect(ids.filter((id) => id === "")).toEqual([]);
    expect(await messages.send(replyFrame(ids[0] ?? "", "note", "evicted"), t.pid)).toEqual({
      ok: false,
      code: "unknown",
    });
    expect(await messages.send(replyFrame(ids[1] ?? "", "note", "kept"), t.pid)).toMatchObject({ ok: true });
    expect(await messages.send(replyFrame(ids.at(-1) ?? "", "note", "newest"), t.pid)).toMatchObject({ ok: true });
  }, 60_000);

  test("in a pane whose process is claude every child is one session, so the listener and the sender need not be the same child", async () => {
    const messages = setup();
    const aFile = join(base, "exec-a.pid");
    const bFile = join(base, "exec-b.pid");
    const body = `sleep 600 & echo $! > ${shq(aFile)}; sleep 600 & echo $! > ${shq(bFile)}; wait`;
    // `exec`: the pane's own process is the claude, as a séance spawn's (and a hand-started `exec claude`'s) is.
    await tmuxOk([
      "new-window",
      "-d",
      "-t",
      "msg:",
      "-n",
      "exec-pane",
      "-c",
      base,
      "sh",
      "-c",
      `exec ${underClaude(claudeBin, { body })}`,
    ]);
    const [a, b] = [await pidFrom(aFile), await pidFrom(bFile)];

    const taskId = await launched("exec-t");
    const t = await pane("exec-t", taskId);
    await messages.listen(INBOX, t.pid, sinkDouble().sink);
    const uListener = sinkDouble();
    await messages.listen(INBOX, a, uListener.sink);
    const q = idOf(await messages.send(message(taskId, "question", "which?"), b));
    expect(q).not.toBe("");
    await messages.send(replyFrame(q, "note", "this one"), t.pid);
    expect(lineOf(uListener.lines[1]).wake).toBe(true);
  });

  test("a process with no claude above it holds no handle: an untasked one cannot listen, and a message it sends to a task cannot be answered by handle", async () => {
    const messages = setup();
    const file = join(base, "noclaude.peer");
    const shell = await runner("noclaude-shell", `sleep 600 & echo $! > ${shq(file)}; wait`);
    await shell.go();
    const peer = await pidFrom(file);
    const refused = sinkDouble();
    await messages.listen(INBOX, peer, refused.sink);
    expect(JSON.parse(refused.lines[0] ?? "null")).toEqual({ ok: false, code: "unbound" });
    // Never bound to the shell, and not shut out of a send either: a task's id needs no session.
    expect(await messages.send(message("task-anywhere", "note", "from a bare shell"), peer)).toEqual({
      ok: false,
      code: "unknown",
    });

    const taskId = await launched("noclaude-t");
    const t = await pane("noclaude-t", taskId);
    const tListener = sinkDouble();
    await messages.listen(INBOX, t.pid, tListener.sink);
    const asked = await messages.send(message(taskId, "question", "which file?"), peer);
    expect(asked).toMatchObject({ ok: true, outcome: "delivered" });
    expect(lineOf(tListener.lines[1]).push).toContain("cannot be answered from here");
    // No handle was made for it: the id answers nothing.
    expect(await messages.send(replyFrame(idOf(asked), "note", "src/a.ts"), t.pid)).toEqual({
      ok: false,
      code: "unknown",
    });
  });

  test("a tasked pane whose process is no claude still listens and sends by task id, as in Part A, but holds no handle and no wake", async () => {
    const messages = setup();
    const askerTask = await launched("nc-asker");
    const file = join(base, "nc-asker.peer");
    const shell = await runner("nc-asker", `sleep 600 & echo $! > ${shq(file)}; wait`, askerTask);
    await shell.go();
    const peer = await pidFrom(file);
    const answerTask = await launched("nc-answer");
    const t = await pane("nc-answer", answerTask);
    const tListener = sinkDouble();
    await messages.listen(INBOX, t.pid, tListener.sink);

    const listener = sinkDouble();
    await messages.listen(INBOX, peer, listener.sink);
    expect(JSON.parse(listener.lines[0] ?? "null")).toMatchObject({ ok: true });
    expect(await messages.send(message(answerTask, "note", "hello"), peer)).toMatchObject({
      ok: true,
      outcome: "delivered",
    });
    const q = idOf(await messages.send(message(answerTask, "question", "which file?"), peer));
    expect(q).not.toBe("");
    // The answer goes by the asker's task id, as it always did, and wakes nobody: no session holds the question.
    expect(await messages.send(message(askerTask, "note", "src/a.ts", q), t.pid)).toMatchObject({
      ok: true,
      outcome: "delivered",
    });
    expect(lineOf(listener.lines[1]).push).toContain("src/a.ts");
    expect(lineOf(listener.lines[1])).not.toHaveProperty("wake");
    // By handle it answers nothing, in either direction.
    expect(await messages.send(replyFrame(q, "note", "by handle"), t.pid)).toEqual({ ok: false, code: "unknown" });
  });

  test("a claude found only by its versioned filename is a session, as macOS tmux names it", async () => {
    const messages = setup();
    const id = (
      await tmuxOk([
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id} #{pane_pid}",
        "-t",
        "msg:",
        "-n",
        "versioned",
        "-c",
        base,
        versionedBin,
        "-e",
        "await Bun.sleep(600_000);",
      ])
    ).trim();
    const pid = Number(id.split(" ")[1]);
    await pollUntil(async () => (await processNames(pid)).includes("9.9.9"), "the versioned claude to exec");
    expect(await processNames(pid)).not.toContain("claude");
    // An untasked pane is acked only when a session was found: it matched by the version alone.
    const listener = sinkDouble();
    await messages.listen(INBOX, pid, listener.sink);
    expect(JSON.parse(listener.lines[0] ?? "null")).toMatchObject({ ok: true });
  });

  test("a pane started with `--remote-control` that runs claude under a shell is bound to the claude, not the shell: the next claude holds none of the first's handles", async () => {
    const messages = setup();
    const taskId = await launched("ours-t");
    const t = await pane("ours-t", taskId);
    const tListener = sinkDouble();
    await messages.listen(INBOX, t.pid, tListener.sink);

    // The start command names the flag, so `ours` holds, yet the pane process is the shell and each claude its child.
    const file = (name: string): string => join(base, `ours-${name}`);
    const claude = (name: string): string =>
      underClaude(claudeBin, {
        body: `sleep 600 & echo $! > ${shq(file(`${name}.peer`))}; wait`,
        pidFile: file(`${name}.claude`),
      });
    const paneId = (
      await tmuxOk([
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        "msg:",
        "-n",
        "ours-shell",
        "-c",
        base,
        "sh",
        "-c",
        `${claude("one")}; ${claude("two")}; sleep 600`,
        "claude",
        "--remote-control",
      ])
    ).trim();
    expect((await listPanePids()).find((p) => p.id === paneId)?.ours).toBe(true);
    const [claudeOne, peerOne] = [await pidFrom(file("one.claude")), await pidFrom(file("one.peer"))];

    const first = sinkDouble();
    await messages.listen(INBOX, peerOne, first.sink);
    const q = idOf(await messages.send(message(taskId, "question", "which file?"), peerOne));
    expect(q).not.toBe("");

    first.drop();
    process.kill(claudeOne, "SIGKILL");
    process.kill(peerOne, "SIGKILL");
    const peerTwo = await pidFrom(file("two.peer"));
    expect(await pidFrom(file("two.claude"))).not.toBe(claudeOne);
    expect((await listPanePids()).find((p) => p.id === paneId)?.ours).toBe(true);

    // The shell outlives the first claude, which is the only reason a handle bound to it would have survived.
    expect(await messages.send(replyFrame(q, "note", "too late"), t.pid)).toEqual({ ok: false, code: "ended" });
    const second = sinkDouble();
    await messages.listen(INBOX, peerTwo, second.sink);
    expect(await messages.send(replyFrame(q, "note", "after it listened"), t.pid)).toEqual({
      ok: false,
      code: "ended",
    });
    expect(second.lines).toHaveLength(1);
  });

  test("a pane re-tagged for a task after the question holds no handle, even once it is untagged again", async () => {
    const messages = setup();
    const taskId = await launched("retag-t");
    const t = await pane("retag-t", taskId);
    const u = await pane("retag-u");
    await messages.listen(INBOX, t.pid, sinkDouble().sink);
    const first = sinkDouble();
    await messages.listen(INBOX, u.pid, first.sink);
    const q = idOf(await messages.send(message(taskId, "question", "which?"), u.pid));
    expect(q).not.toBe("");

    // Tagged for another task: its listener is closed, and the next listen is another task's binding.
    await tmuxOk(["set-option", "-p", "-t", u.id, "@seance-task", await launched("retag-other")]);
    expect(await messages.send(replyFrame(q, "note", "to a re-tagged pane"), t.pid)).toEqual({
      ok: false,
      code: "ended",
    });
    expect(first.closed()).toBe(true);
    const second = sinkDouble();
    await messages.listen(INBOX, u.pid, second.sink);
    // Untagged again: the pane and process are the question's, but the handle was made for another binding.
    await tmuxOk(["set-option", "-p", "-u", "-t", u.id, "@seance-task"]);
    await messages.listen(INBOX, u.pid, sinkDouble().sink);
    expect(await messages.send(replyFrame(q, "note", "back again"), t.pid)).toEqual({ ok: false, code: "ended" });
    expect(second.lines).toHaveLength(1);
  });

  test("a handle names nobody once its pane is gone", async () => {
    const messages = setup();
    const taskId = await launched("gone-t");
    const t = await pane("gone-t", taskId);
    const u = await pane("gone-u");
    await messages.listen(INBOX, t.pid, sinkDouble().sink);
    await messages.listen(INBOX, u.pid, sinkDouble().sink);
    const q = idOf(await messages.send(message(taskId, "question", "which?"), u.pid));
    await tmuxOk(["kill-pane", "-t", u.id]);
    await pollUntil(async () => (await listPanePids()).every((p) => p.id !== u.id), "the pane to go");
    expect(await messages.send(replyFrame(q, "note", "nobody home"), t.pid)).toEqual({ ok: false, code: "ended" });
  });

  test("one busy sender cannot push another session's open question out of the table", async () => {
    const messages = setup();
    const taskId = await launched("busy-t");
    const t = await pane("busy-t", taskId);
    const other = await launched("busy-o");
    const o = await pane("busy-o", other);
    const quiet = await pane("busy-quiet");
    const busy = [await pane("busy-1"), await pane("busy-2"), await pane("busy-3")];
    await messages.listen(INBOX, t.pid, sinkDouble().sink);
    await messages.listen(INBOX, o.pid, sinkDouble().sink);
    await messages.listen(INBOX, quiet.pid, sinkDouble().sink);
    for (const b of busy) {
      // oxlint-disable-next-line no-await-in-loop -- one listener at a time
      await messages.listen(INBOX, b.pid, sinkDouble().sink);
    }
    const q = idOf(await messages.send(message(taskId, "question", "which?"), quiet.pid));
    expect(q).not.toBe("");
    // Notes enough from three panes to pass the cap, well inside each pane's rate limit and the hour.
    for (let i = 0; i < REPLY_HANDLE_MAX; i++) {
      clock.now += 4_000;
      const from = busy[i % busy.length];
      if (from === undefined) throw new Error("no sender");
      // oxlint-disable-next-line no-await-in-loop -- ordered sends
      expect(await messages.send(message(other, "note", `n${i}`), from.pid)).toMatchObject({ ok: true });
    }
    expect(await messages.send(replyFrame(q, "note", "still here"), t.pid)).toMatchObject({ ok: true });
  }, 60_000);

  test("past the cap a busy pane's oldest note goes before its own open question", async () => {
    const messages = setup();
    const taskId = await launched("keepq-t");
    const t = await pane("keepq-t", taskId);
    const other = await launched("keepq-o");
    const o = await pane("keepq-o", other);
    const busy = await pane("keepq-busy");
    const quiet = [await pane("keepq-1"), await pane("keepq-2")];
    for (const target of [t, o, busy, ...quiet]) {
      // oxlint-disable-next-line no-await-in-loop -- one listener at a time
      await messages.listen(INBOX, target.pid, sinkDouble().sink);
    }
    const q = idOf(await messages.send(message(taskId, "question", "which?"), busy.pid));
    expect(q).not.toBe("");
    // The busy pane holds the most (101), so each entry past the cap is its own: the question is the oldest of all.
    const send = async (from: Pane, i: number): Promise<void> => {
      clock.now += 4_000;
      expect(await messages.send(message(other, "note", `n${i}`), from.pid)).toMatchObject({ ok: true });
    };
    for (let i = 0; i < 100; i++) await send(busy, i);
    for (let i = 0; i < 160; i++) {
      const from = quiet[i % quiet.length];
      if (from === undefined) throw new Error("no sender");
      await send(from, i);
    }
    expect(await messages.send(replyFrame(q, "note", "still here"), t.pid)).toMatchObject({ ok: true });
  }, 60_000);

  test("a claude a tool started under a claude is its own session: its listener neither reads nor ends the outer session's handles", async () => {
    const messages = setup();
    const taskId = await launched("nest-t");
    const t = await pane("nest-t", taskId);
    const tListener = sinkDouble();
    await messages.listen(INBOX, t.pid, tListener.sink);

    const file = (name: string): string => join(base, `nest-${name}`);
    const inner = underClaude(claudeBin, {
      body: `sleep 600 & echo $! > ${shq(file("inner.peer"))}; wait`,
      pidFile: file("inner.claude"),
    });
    const outer = underClaude(claudeBin, {
      body: `sleep 600 & echo $! > ${shq(file("outer.peer"))}; ${inner}`,
      pidFile: file("outer.claude"),
    });
    const shell = await runner("nest-shell", outer);
    await shell.go();
    const [outerPeer, innerPeer] = [await pidFrom(file("outer.peer")), await pidFrom(file("inner.peer"))];

    const first = sinkDouble();
    await messages.listen(INBOX, outerPeer, first.sink);
    const q = idOf(await messages.send(message(taskId, "question", "which file?"), outerPeer));
    expect(q).not.toBe("");
    const r = idOf(await messages.send(replyFrame(q, "note", "src/a.ts"), t.pid));
    expect(lineOf(first.lines[1]).wake).toBe(true);

    // The nested claude's listener takes the pane's one listener, and answers nothing the outer one received.
    const nested = sinkDouble();
    await messages.listen(INBOX, innerPeer, nested.sink);
    expect(first.closed()).toBe(true);
    expect(await messages.send(replyFrame(r, "note", "not mine"), innerPeer)).toEqual({ ok: false, code: "unknown" });

    // It ends; the outer session listens again and still holds what it received.
    nested.drop();
    await messages.listen(INBOX, outerPeer, sinkDouble().sink);
    expect(await messages.send(replyFrame(r, "note", "thanks"), outerPeer)).toMatchObject({
      ok: true,
      outcome: "delivered",
    });
    expect(tListener.lines).toHaveLength(3);
  });
});

describe("a hand-started session that restarts under the same shell", () => {
  const alive = async (pid: number): Promise<boolean> => {
    const ps = await exec(["ps", "-o", "stat=", "-p", String(pid)]);
    return ps.exitCode === 0 && !ps.stdout.trim().startsWith("Z");
  };

  test("the second claude holds none of the first's handles, and an answer to the first is ended: never held for it, delivered to it or woken into it", async () => {
    const messages = setup();
    const taskId = await launched("rs-t");
    const t = await pane("rs-t", taskId);
    const tListener = sinkDouble();
    await messages.listen(INBOX, t.pid, tListener.sink);

    // The pane's process is a shell; each `claude` is its child (an inner sh), and the peer a child of that, as a
    // `seance mcp` or `seance inbox` is. The two run in sequence, so both sit under the same shell pid.
    const file = (name: string): string => join(base, `rs-${name}`);
    const claude = (name: string): string =>
      underClaude(claudeBin, {
        body: `sleep 600 & echo $! > ${shq(file(`${name}.peer`))}; wait`,
        pidFile: file(`${name}.claude`),
      });
    const shell = await runner("rs-shell", `${claude("one")}; ${claude("two")}`);
    await shell.go();
    const [claudeOne, peerOne] = [await pidFrom(file("one.claude")), await pidFrom(file("one.peer"))];
    const shellBefore = (await listPanePids()).find((p) => p.id === shell.pane)?.pid;

    // The first claude listens, asks, and is answered with a wake.
    const first = sinkDouble();
    await messages.listen(INBOX, peerOne, first.sink);
    const asked = await messages.send(message(taskId, "question", "which file?"), peerOne);
    expect(asked).toMatchObject({ ok: true, outcome: "delivered" });
    const q = idOf(asked);
    const answered = await messages.send(replyFrame(q, "note", "src/a.ts"), t.pid);
    expect(answered).toMatchObject({ ok: true, outcome: "delivered" });
    const r = idOf(answered);
    expect(lineOf(first.lines[1]).wake).toBe(true);

    // The claude goes; its shell stays, and nothing tells the daemon (no `ended` fires for an untasked pane).
    first.drop();
    process.kill(claudeOne, "SIGKILL");
    process.kill(peerOne, "SIGKILL");
    const [claudeTwo, peerTwo] = [await pidFrom(file("two.claude")), await pidFrom(file("two.peer"))];
    expect(claudeTwo).not.toBe(claudeOne);
    expect(await alive(claudeOne)).toBe(false);
    expect((await listPanePids()).find((p) => p.id === shell.pane)?.pid).toBe(shellBefore);

    // An answer to the first's question finds no session: ended, and nothing held for the next one.
    expect(await messages.send(replyFrame(q, "note", "too late"), t.pid)).toEqual({ ok: false, code: "ended" });

    // The second claude cannot answer what the first received, whether or not it has a listener yet.
    expect(await messages.send(replyFrame(r, "note", "not mine"), peerTwo)).toEqual({ ok: false, code: "unknown" });
    const second = sinkDouble();
    await messages.listen(INBOX, peerTwo, second.sink);
    expect(await messages.send(replyFrame(r, "note", "still not mine"), peerTwo)).toEqual({
      ok: false,
      code: "unknown",
    });
    expect(await messages.send(replyFrame(q, "note", "after it listened"), t.pid)).toEqual({
      ok: false,
      code: "ended",
    });

    // Nothing reached the second claude but the ack, and nothing it said reached the task.
    expect(second.lines).toHaveLength(1);
    expect(tListener.lines).toHaveLength(2);
    expect(audits.filter((a) => a.dir === "in" && a.to === "reply" && a.outcome === "delivered")).toHaveLength(1);
    expectNoIdsOrText(q, r);
  });

  test("a wrapper called claude that runs claude twice is not the session: each claude is, so the second holds none of the first's handles", async () => {
    const messages = setup();
    const taskId = await launched("wrap-t");
    const t = await pane("wrap-t", taskId);
    await messages.listen(INBOX, t.pid, sinkDouble().sink);

    const file = (name: string): string => join(base, `wrap-${name}`);
    const claude = (name: string): string =>
      underClaude(claudeBin, {
        body: `sleep 600 & echo $! > ${shq(file(`${name}.peer`))}; wait`,
        pidFile: file(`${name}.claude`),
      });
    // `claude "$@"; claude --continue`: the wrapper reads as a claude to tmux and ps, and outlives both.
    const wrapper = underClaude(claudeBin, { body: `${claude("one")}; ${claude("two")}` });
    const shell = await runner("wrap-shell", wrapper);
    await shell.go();
    const [claudeOne, peerOne] = [await pidFrom(file("one.claude")), await pidFrom(file("one.peer"))];

    const first = sinkDouble();
    await messages.listen(INBOX, peerOne, first.sink);
    const q = idOf(await messages.send(message(taskId, "question", "which file?"), peerOne));
    expect(q).not.toBe("");
    const r = idOf(await messages.send(replyFrame(q, "note", "src/a.ts"), t.pid));
    expect(lineOf(first.lines[1]).wake).toBe(true);

    first.drop();
    process.kill(claudeOne, "SIGKILL");
    process.kill(peerOne, "SIGKILL");
    const peerTwo = await pidFrom(file("two.peer"));
    expect(await pidFrom(file("two.claude"))).not.toBe(claudeOne);

    expect(await messages.send(replyFrame(q, "note", "too late"), t.pid)).toEqual({ ok: false, code: "ended" });
    const second = sinkDouble();
    await messages.listen(INBOX, peerTwo, second.sink);
    expect(await messages.send(replyFrame(r, "note", "not mine"), peerTwo)).toEqual({ ok: false, code: "unknown" });
    expect(await messages.send(replyFrame(q, "note", "after it listened"), t.pid)).toEqual({
      ok: false,
      code: "ended",
    });
    expect(second.lines).toHaveLength(1);
  });

  test("a receipt for a pane tagged with a task this machine never launched is pinned to its session: a sibling claude's listener is not served it", async () => {
    const messages = setup({ route: () => Promise.resolve(true) });
    const file = (name: string): string => join(base, `rcpt-${name}`);
    const claude = (name: string): string =>
      underClaude(claudeBin, {
        body: `sleep 600 & echo $! > ${shq(file(`${name}.peer`))}; wait`,
        pidFile: file(`${name}.claude`),
      });
    // Two claudes alive under one shell, so the shell's later `claude` is not the first's: no launch ledger entry stands
    // for the tag, so nothing but the session separates them.
    const shell = await runner("rcpt-shell", `${claude("one")} & ${claude("two")} & wait`, "task-never-launched-rcpt");
    await shell.go();
    const [peerOne, peerTwo] = [await pidFrom(file("one.peer")), await pidFrom(file("two.peer"))];

    const one = sinkDouble();
    await messages.listen(INBOX, peerOne, one.sink);
    const routed = await messages.send(
      { ...message("t-0123456789abcdef", "note", "hello there"), route: "send" },
      peerOne,
    );
    expect(routed).toMatchObject({ ok: true, outcome: "routed" });

    const two = sinkDouble();
    await messages.listen(INBOX, peerTwo, two.sink);
    expect(
      await messages.receipt({
        id: idOf(routed),
        to: "t-0123456789abcdef",
        kind: "note",
        outcome: "delivered",
      }),
    ).toEqual({ ok: true, outcome: "dropped" });
    expect(two.lines).toHaveLength(1);
  });
});

describe("a reply or a message routed here from another machine, by handle", () => {
  const ORIGIN = "d-remote";
  const routedTo = (
    taskId: string,
    over: Partial<Extract<DeliverMessageRequest, { readonly taskId: string }>> = {},
  ): DeliverMessageRequest => ({
    id: crypto.randomUUID(),
    taskId,
    addressed: taskId,
    kind: "question",
    text: "remote question",
    fromMachine: "MsgBox",
    origin: ORIGIN,
    ...over,
  });

  test("a reply for a question this machine's session sent is delivered with a wake, and an unknown, retired or note's handle is not", async () => {
    const messages = setup();
    const taskId = await launched("rr-t");
    const t = await pane("rr-t", taskId);
    const u = await pane("rr-u");
    await messages.listen(INBOX, t.pid, sinkDouble().sink);
    const uListener = sinkDouble();
    await messages.listen(INBOX, u.pid, uListener.sink);
    const q = idOf(await messages.send(message(taskId, "question", "which?"), u.pid));
    const note = idOf(await messages.send(message(taskId, "note", "fyi"), u.pid));

    const reply = (replyTo: string, text: string): DeliverMessageRequest => {
      texts.push(text);
      return {
        id: crypto.randomUUID(),
        replyTo,
        kind: "note",
        text,
        fromMachine: "MsgBox",
        origin: ORIGIN,
        fromTask: "t-remote",
      };
    };
    expect(await messages.deliverRouted(reply(q, "remote answer"))).toEqual({ ok: true, outcome: "delivered" });
    const line = lineOf(uListener.lines[1]);
    expect(line.wake).toBe(true);
    expect(line.push).toContain("MsgBox");
    expect(line.push).toContain("remote answer");
    expect(audits.at(-1)).toEqual({
      dir: "in",
      from: "t-remote",
      to: "reply",
      kind: "note",
      bytes: "remote answer".length,
      outcome: "delivered",
    });

    // A note's answer is delivered, without a wake; a handle nobody was sent is ended.
    expect(await messages.deliverRouted(reply(note, "remote ok"))).toEqual({ ok: true, outcome: "delivered" });
    expect(lineOf(uListener.lines[2])).not.toHaveProperty("wake");
    expect(await messages.deliverRouted(reply(crypto.randomUUID(), "who?"))).toEqual({ ok: true, outcome: "ended" });
    expect(audits.at(-1)).toMatchObject({ dir: "in", to: "reply", outcome: "ended" });
    expect(uListener.lines).toHaveLength(3);
    expectNoIdsOrText(q, note);
  });

  test("a message from another machine is answerable: the answer asks for a route, then is handed to the leader against its origin's handle", async () => {
    const seen: SessionMessage[] = [];
    const messages = setup({
      route: (m) => {
        seen.push(m);
        return Promise.resolve(true);
      },
    });
    const taskId = await launched("ro-t");
    const t = await pane("ro-t", taskId);
    const tListener = sinkDouble();
    await messages.listen(INBOX, t.pid, tListener.sink);
    const incoming = routedTo(taskId);
    expect(await messages.deliverRouted(incoming)).toEqual({ ok: true, outcome: "delivered" });
    expect(lineOf(tListener.lines[1]).push).toContain("no `to`");

    expect(await messages.send(replyFrame(incoming.id, "note", "answer", "ask"), t.pid)).toEqual({
      ok: false,
      code: "remote",
    });
    // A caller that never asked to route is answered as an unreachable local handle.
    expect(await messages.send(replyFrame(incoming.id, "note", "answer"), t.pid)).toEqual({
      ok: false,
      code: "unknown",
    });
    expect(seen).toEqual([]);
    const sent = await messages.send(replyFrame(incoming.id, "note", "answer", "send"), t.pid);
    expect(sent).toMatchObject({ ok: true, outcome: "routed" });
    expect(seen).toEqual([
      {
        id: idOf(sent),
        kind: "note",
        text: "answer",
        fromTask: taskId,
        fromTitle: "Sender",
        inReplyTo: incoming.id,
        replyTo: { id: incoming.id, deviceId: ORIGIN },
      },
    ]);
    expect(audits.at(-1)).toEqual({
      dir: "out",
      from: taskId,
      to: "reply",
      kind: "note",
      bytes: "answer".length,
      outcome: "routed",
    });
    expectNoIdsOrText(incoming.id, idOf(sent));
  });

  test("a frame that carries the handle as `to` is a caller that predates replies: a remote handle is refused as unknown and nothing is routed", async () => {
    const seen: SessionMessage[] = [];
    const messages = setup({
      route: (m) => {
        seen.push(m);
        return Promise.resolve(true);
      },
    });
    const taskId = await launched("via-t");
    const t = await pane("via-t", taskId);
    await messages.listen(INBOX, t.pid, sinkDouble().sink);
    const incoming = routedTo(taskId);
    await messages.deliverRouted(incoming);

    for (const route of ["ask", "send"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- ordered sends
      expect(await messages.send({ ...replyFrame(incoming.id, "note", "x", route), to: incoming.id }, t.pid)).toEqual({
        ok: false,
        code: "unknown",
      });
    }
    expect(seen).toEqual([]);
    // The same handle without `to` is answerable.
    expect(await messages.send(replyFrame(incoming.id, "note", "x", "ask"), t.pid)).toEqual({
      ok: false,
      code: "remote",
    });
  });

  test("a message from a leader that predates replies carries no handle: a tasked sender is answered by task id, an untasked one is told it cannot be", async () => {
    const messages = setup();
    const taskId = await launched("legacy-t");
    const t = await pane("legacy-t", taskId);
    const tListener = sinkDouble();
    await messages.listen(INBOX, t.pid, tListener.sink);
    const legacy = (
      over: Partial<Extract<DeliverMessageRequest, { readonly taskId: string }>>,
    ): DeliverMessageRequest => ({
      id: crypto.randomUUID(),
      taskId,
      addressed: taskId,
      kind: "question",
      text: "legacy question",
      fromMachine: "MsgBox",
      ...over,
    });
    await messages.deliverRouted(legacy({ fromTask: "t-remote" }));
    await messages.deliverRouted(legacy({}));
    const [tasked, untasked] = [lineOf(tListener.lines[1]).push, lineOf(tListener.lines[2]).push];
    expect(tasked).toContain("to task t-remote");
    expect(untasked).toContain("no handle");
    expect(untasked).not.toContain("inReplyTo");
  });

  test("a message that came back to the machine that sent it is answered here, not through the leader", async () => {
    const seen: SessionMessage[] = [];
    const messages = setup({
      deviceId: "d-self",
      route: (m) => {
        seen.push(m);
        return Promise.resolve(true);
      },
    });
    const taskId = await launched("self-t");
    const t = await pane("self-t", taskId);
    const u = await pane("self-u");
    await messages.listen(INBOX, t.pid, sinkDouble().sink);
    const uListener = sinkDouble();
    await messages.listen(INBOX, u.pid, uListener.sink);

    // This daemon never launched the task the question names, so it routes; the leader hands it to that task's
    // successor on this very machine, with this machine as its origin.
    const asked = await messages.send(routedFrame("task-superseded", "send", "which?", "question"), u.pid);
    expect(asked).toMatchObject({ ok: true, outcome: "routed" });
    const q = idOf(asked);
    seen.length = 0;
    expect(
      await messages.deliverRouted(routedTo(taskId, { id: q, origin: "d-self", text: "forwarded question" })),
    ).toEqual({ ok: true, outcome: "delivered" });

    expect(await messages.send(replyFrame(q, "note", "answered here", "ask"), t.pid)).toMatchObject({
      ok: true,
      outcome: "delivered",
    });
    expect(seen).toEqual([]);
    const line = lineOf(uListener.lines.at(-1));
    expect(line.push).toContain("answered here");
    expect(line.wake).toBe(true);
  });

  test("a receipt for a tasked sender's message waits out the launch grace for its listener, as it did before handles", async () => {
    const messages = setup({ graceMs: 60_000, route: () => Promise.resolve(true) });
    const sender = await launched("rcgrace");
    const from = await pane("rcgrace-from", sender);
    const sent = await messages.send(routedFrame("task-elsewhere", "send", "hi"), from.pid);
    expect(sent).toMatchObject({ ok: true, outcome: "routed" });
    // No listener has bound in the sender's pane yet: held, not dropped.
    const request: MessageReceiptRequest = {
      id: idOf(sent),
      to: "task-elsewhere",
      kind: "note",
      outcome: "delivered",
    };
    expect(await messages.receipt(request)).toEqual({ ok: true, outcome: "sent" });
    const listener = sinkDouble();
    await messages.listen(INBOX, from.pid, listener.sink);
    expect(lineOf(listener.lines[1]).push).toBe(receiptNote(request));
  });

  test("a refused route leaves the handle usable, and a route-less daemon answers unsupported", async () => {
    const taskId = await launched("rn-t");
    const t = await pane("rn-t", taskId);
    const refused = setup({ route: () => Promise.resolve(false) });
    await refused.listen(INBOX, t.pid, sinkDouble().sink);
    const incoming = routedTo(taskId);
    await refused.deliverRouted(incoming);
    expect(await refused.send(replyFrame(incoming.id, "note", "x", "send"), t.pid)).toEqual({
      ok: false,
      code: "no_leader",
    });
    expect(audits.at(-1)).toMatchObject({ dir: "out", to: "reply", outcome: "no_leader" });

    const none = setup();
    await none.listen(INBOX, t.pid, sinkDouble().sink);
    await none.deliverRouted(routedTo(taskId, { id: incoming.id }));
    expect(await none.send(replyFrame(incoming.id, "note", "x", "send"), t.pid)).toEqual({
      ok: false,
      code: "unsupported",
    });
  });

  test("a receipt that names no task finds the pane that sent the message: an untasked sender's, and a reply's", async () => {
    const messages = setup({ route: () => Promise.resolve(true) });
    const u = await pane("rc-u");
    const uListener = sinkDouble();
    await messages.listen(INBOX, u.pid, uListener.sink);
    const sent = await messages.send(routedFrame("task-elsewhere", "send", "hi"), u.pid);
    const request: MessageReceiptRequest = {
      id: idOf(sent),
      to: "task-elsewhere",
      kind: "note",
      outcome: "offline",
    };
    expect(await messages.receipt(request)).toEqual({ ok: true, outcome: "delivered" });
    expect(lineOf(uListener.lines[1]).push).toBe(receiptNote(request));
    expect(audits.at(-1)).toEqual({
      dir: "receipt",
      from: null,
      to: "task-elsewhere",
      kind: "note",
      outcome: "offline",
    });
    expect(lines.at(-1)).toContain("dir=receipt from=untasked");

    // A reply's receipt names no `to` either, and is worded for a reply.
    const taskId = await launched("rc-t");
    const t = await pane("rc-t", taskId);
    const tListener = sinkDouble();
    await messages.listen(INBOX, t.pid, tListener.sink);
    const incoming = routedTo(taskId);
    await messages.deliverRouted(incoming);
    const reply = await messages.send(replyFrame(incoming.id, "note", "answer", "send"), t.pid);
    const receipt: MessageReceiptRequest = { id: idOf(reply), kind: "note", outcome: "delivered" };
    expect(await messages.receipt(receipt)).toEqual({ ok: true, outcome: "delivered" });
    expect(lineOf(tListener.lines[2]).push).toBe(receiptNote(receipt));
    expect(lineOf(tListener.lines[2]).push).toContain("your reply");
    expect(audits.at(-1)).toMatchObject({ dir: "receipt", from: taskId, to: "reply", outcome: "delivered" });

    // Nothing remembered for an id and no task named: dropped, and nothing audited for it.
    const before = audits.length;
    expect(await messages.receipt({ id: crypto.randomUUID(), kind: "note", outcome: "delivered" })).toEqual({
      ok: true,
      outcome: "dropped",
    });
    expect(audits).toHaveLength(before);
  });

  test("a receipt for an untasked sender whose claude is gone is dropped, not held for the next one", async () => {
    const messages = setup({ route: () => Promise.resolve(true) });
    const file = join(base, "rcg.peer");
    const claudeFile = join(base, "rcg.claude");
    const body = `sleep 600 & echo $! > ${shq(file)}; wait`;
    const shell = await runner("rcg-shell", `${underClaude(claudeBin, { body, pidFile: claudeFile })}; sleep 600`);
    await shell.go();
    const [claude, peer] = [await pidFrom(claudeFile), await pidFrom(file)];
    const listener = sinkDouble();
    await messages.listen(INBOX, peer, listener.sink);
    const sent = await messages.send(routedFrame("task-elsewhere", "send", "hi"), peer);
    process.kill(claude, "SIGKILL");
    process.kill(peer, "SIGKILL");
    await pollUntil(async () => {
      const ps = await exec(["ps", "-o", "stat=", "-p", String(claude)]);
      return ps.exitCode !== 0 || ps.stdout.trim().startsWith("Z");
    }, "the claude to be gone");
    listener.drop();
    expect(
      await messages.receipt({ id: idOf(sent), to: "task-elsewhere", kind: "note", outcome: "delivered" }),
    ).toEqual({
      ok: true,
      outcome: "dropped",
    });
  });
});
