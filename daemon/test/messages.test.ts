import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_MAX_BYTES, INBOX_MAX_MESSAGES, MESSAGE_MAX, MESSAGE_PUSH_MAX } from "@seance/shared";
import { messageAudit, type MessageAudit } from "../src/audit.ts";
import { exec } from "../src/exec.ts";
import { startLocalSocket, type LocalSocketHandle } from "../src/local-socket.ts";
import type { InboxLine } from "../src/message-frame.ts";
import { createMessages, type ListenerSink, type Messages, type MessagesDeps } from "../src/messages.ts";
import { EndedTasks, listPanePids } from "../src/session-events.ts";
import { LaunchLedger } from "../src/launch-ledger.ts";
import { paneWindowName, tmuxOk } from "../src/tmux.ts";
import { pollUntil, usePrivateTmux, type PrivateTmux } from "./fixtures.ts";

/**
 * Session messages with the binding real: panes in a private tmux server, the kernel's peer pid, and for the
 * socket-level cases the real `seanced inbox` child and a sender in its own pane. The cases that need no socket
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

/** A pane running `sleep`, whose own pid stands as the peer: `ancestorIn` takes the first hit, which is itself. */
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
      "sleep",
      "600",
    ])
  ).trim();
  const [id, pid] = out.split(" ");
  if (id === undefined || pid === undefined) throw new Error(`no pane from ${out}`);
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

/** `seanced inbox`, the real CLI: stdout to a file, its exit code beside it. */
function inboxCommand(out: string, state = stateDir): string {
  return `SEANCE_STATE_DIR=${shq(state)} ${shq(process.execPath)} ${shq(MAIN)} inbox > ${shq(out)}; echo $? > ${shq(`${out}.exit`)}`;
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
  test("a tasked listener is acked, an untasked one is refused (exit 4), and a note arrives as one line naming its sender", async () => {
    const receiver = await launched("recv");
    const sender = await launched("send");
    const recvOut = join(base, "a-recv.out");
    const bareOut = join(base, "a-bare.out");
    const recv = await runner("a-recv", inboxCommand(recvOut), receiver);
    const bare = await runner("a-bare", inboxCommand(bareOut));
    await recv.go();
    await bare.go();
    await pollUntil(async () => (await readLines(recvOut)).length > 0, "the tasked listener's ack");
    await pollUntil(() => Bun.file(`${bareOut}.exit`).exists(), "the untasked listener to be refused");
    expect(JSON.parse((await readLines(recvOut))[0] ?? "")).toEqual({
      ok: true,
      keep: { messages: INBOX_MAX_MESSAGES, bytes: INBOX_MAX_BYTES },
    });
    // The refusal is the CLI's exit code, never a line the mod would read.
    expect(await readLines(bareOut)).toEqual([]);
    expect((await readFile(`${bareOut}.exit`, "utf8")).trim()).toBe("4");

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
    const child = `SEANCE_STATE_DIR=${shq(stateDir)} ${shq(process.execPath)} ${shq(MAIN)} inbox; echo $? > ${shq(`${out}.exit`)}`;
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

  test("a pane with no task, or one tagged with an id this machine never launched, is refused untasked and acked nothing: no listener idles for a session nothing can reach", async () => {
    const messages = setup();
    const bare = await pane("bare-pane");
    const forged = await pane("forged-pane", "task-never-launched-here");
    for (const target of [bare, forged]) {
      const listener = sinkDouble();
      // oxlint-disable-next-line no-await-in-loop -- one pane at a time
      await messages.listen(INBOX, target.pid, listener.sink);
      expect(listener.lines.map((l) => JSON.parse(l))).toEqual([{ ok: false, code: "untasked" }]);
      expect(listener.closed()).toBe(true);
    }
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
