import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord, MESSAGE_MAX, MESSAGE_RATE, type RepoEntry } from "@seance/shared";
import { createAdapterFeed, type AdapterFeed } from "../src/adapter-feed.ts";
import { startAdapterHost, type AdapterHost } from "../src/adapter-host.ts";
import { openSubscriptions, type Subscriptions } from "../src/adapter-subscriptions.ts";
import { ctimeUtcSeconds } from "../src/agent-session-file.ts";
import { adapterAudit, messageAudit } from "../src/audit.ts";
import { createConversations, type Conversations } from "../src/conversations.ts";
import { exec } from "../src/exec.ts";
import type { Exclave } from "../src/exclaves.ts";
import { LaunchLedger } from "../src/launch-ledger.ts";
import type { InboxLine } from "../src/message-frame.ts";
import { createMessages, type ListenerSink, type Messages } from "../src/messages.ts";
import { processStart } from "../src/peer.ts";
import { SESSION_EVENT_KIND, SESSION_EVENT_VERSION } from "../src/session-event-frame.ts";
import { createSessionEvents, EndedTasks, listPanePids, type SessionEvents } from "../src/session-events.ts";
import { paneWindowName, tmuxOk } from "../src/tmux.ts";
import { linkClaudeNamed, pollUntil, underClaude, usePrivateTmux, type PrivateTmux } from "./fixtures.ts";

/**
 * Text in and out of an adapter (docs/messaging.md §6, 3b) with real processes: `claude`-named processes in panes of a
 * private tmux server, their conversations verified from `sessions/<pid>.json` or the launch ledger, the real message
 * surface and inbox listeners, and the reference adapter (`test/bin/reference-adapter.ts`) driven through its outbox.
 */

const REFERENCE = resolve(import.meta.dir, "bin/reference-adapter.ts");
const INBOX = { v: 1, kind: "inbox" };

let base: string;
let project: string;
let elsewhere: string;
let claude: string;
let adapter: string;
let privateTmux: PrivateTmux | undefined;
let exclaves: readonly Exclave[];
let repos: readonly RepoEntry[];
let ended: EndedTasks;
/** Every text a test sent either way: none may reach an audit line. */
const texts: string[] = [];
const auditLines: string[] = [];
const stops: (() => unknown)[] = [];

const conv = (n: number): string => `${String(n).padStart(8, "0")}-aaaa-4bbb-8ccc-dddddddddddd`;
const shq = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
let tasks = 0;
const taskId = (): string => `task-am-${++tasks}`;

/** `ps`'s `lstart` for a pid, as Claude Code writes `procStart` (Linux: `/proc`'s start ticks). */
function procStartOf(pid: number): string {
  const start = processStart(pid);
  if (start === null) throw new Error(`no start time for ${pid}`);
  if (process.platform === "linux") return start;
  const d = new Date(Number(start.split(".")[0]) * 1000);
  const two = (n: number): string => String(n).padStart(2, "0");
  const text = `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]
  } ${String(d.getUTCDate()).padStart(2, " ")} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
  if (ctimeUtcSeconds(text) === null) throw new Error(`unparseable ctime ${text}`);
  return text;
}

/** What Claude Code writes for its process: the conversation it is in, and so the source that verifies a claim. */
async function writeSessionFile(pid: number, sessionId: string): Promise<void> {
  await writeFile(
    join(base, ".claude", "sessions", `${pid}.json`),
    JSON.stringify({ pid, sessionId, procStart: procStartOf(pid) }),
  );
}

interface Daemon {
  readonly table: Conversations;
  readonly events: SessionEvents;
  readonly feed: AdapterFeed;
  readonly messages: Messages;
  readonly subscriptions: Subscriptions;
  readonly hosts: AdapterHost[];
}

/** What a daemon (re)start builds: a fresh table, ingest, feed and message surface, the subscriptions read from disk. */
async function boot(): Promise<Daemon> {
  const table = createConversations({
    configDirs: () => [join(base, ".claude")],
    launchSession: (id) => ended.launchSession(id),
    panes: listPanePids,
  });
  const events = createSessionEvents({
    panes: listPanePids,
    exclaves: () => exclaves,
    forward: () => {},
    ended,
    coalesceMs: 0,
    conversations: table,
  });
  const feed = createAdapterFeed({
    conversations: table,
    tasks: ended,
    exclaves: () => exclaves,
    repos: () => repos,
    intervalMs: 200,
    debounceMs: 10,
  });
  const messages = createMessages({
    panes: listPanePids,
    windowName: paneWindowName,
    launchedAt: (id) => ended.launchedAt(id),
    machine: "box",
    audit: messageAudit((line) => void auditLines.push(line)),
    conversations: table,
  });
  const subscriptions = openSubscriptions(join(base, "conversations.json"));
  // Each boot's adapters get their own dirs: a reference adapter still running from an earlier boot reads its own outbox.
  root = join(base, `adapters-${++boots}`);
  const hosts: AdapterHost[] = [];
  stops.push(feed.stop, events.stop, table.stop, messages.stop, () => Promise.all(hosts.map((h) => h.stop())));
  await feed.start();
  return { table, events, feed, messages, subscriptions, hosts };
}

/** Stops a daemon's pieces, as its process ending would: what a restart test does before booting the next. */
async function halt(d: Daemon): Promise<void> {
  await Promise.all(d.hosts.map((h) => h.stop()));
  await d.subscriptions.flushed();
  d.messages.stop();
  d.feed.stop();
  d.events.stop();
  d.table.stop();
}

interface AdapterConfig {
  readonly kinds?: readonly ("note" | "question" | "request")[];
  readonly repos?: readonly string[];
  readonly argv?: readonly string[];
  /** Its hello asks for no `messages`. */
  readonly deaf?: true;
}

/** One host running the reference adapter under each name. */
async function host(d: Daemon, adapters: Readonly<Record<string, AdapterConfig>>): Promise<AdapterHost> {
  const started = startAdapterHost({
    adapters: Object.fromEntries(
      Object.entries(adapters).map(([name, config]) => [
        name,
        {
          argv: [
            ...(config.argv ?? [adapter]),
            ...(config.deaf === true ? [] : ["--wants", "sessions,tasks,messages"]),
          ],
          kinds: config.kinds ?? ["note", "question"],
          ...(config.repos === undefined ? {} : { repos: config.repos }),
        },
      ]),
    ),
    feed: d.feed,
    taskRepo: (id) => ended.taskRepo(id),
    machine: { deviceId: "dev-1", name: "box" },
    version: "test",
    audit: adapterAudit((line) => {
      auditLines.push(line);
    }),
    root,
    held: () => false,
    messages: d.messages,
    conversations: d.table,
    subscriptions: d.subscriptions,
    launchedAt: (id) => ended.launchedAt(id),
  });
  d.hosts.push(started);
  const before = new Map(
    await Promise.all(Object.keys(adapters).map(async (n) => [n, (await frames(n)).length] as const)),
  );
  started.start();
  for (const name of Object.keys(adapters)) {
    await pollUntil(
      async () => (await frames(name)).slice(before.get(name) ?? 0).some((f) => f["kind"] === "snapshot"),
      `${name}'s snapshot`,
    );
  }
  return started;
}

let boots = 0;
let root = "";
const dirOf = (name: string): string => join(root, name);

async function frames(name: string): Promise<readonly Record<string, unknown>[]> {
  return (await readFile(join(dirOf(name), "frames.jsonl"), "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line !== "")
    .map((line): Record<string, unknown> => JSON.parse(line));
}

let refs = 0;
/** Has the adapter send `frame` (its outbox), and waits for the daemon's `result` for it. */
async function fromAdapter(name: string, frame: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const ref = `r-${++refs}`;
  if (typeof frame["text"] === "string") texts.push(frame["text"]);
  await appendFile(join(dirOf(name), "outbox.jsonl"), `${JSON.stringify({ ...frame, ref })}\n`);
  let result: Record<string, unknown> | undefined;
  await pollUntil(async () => {
    result = (await frames(name)).find((f) => f["kind"] === "result" && f["ref"] === ref);
    return result !== undefined;
  }, `${name}'s result for ${ref}`);
  if (result === undefined) throw new Error("unreachable");
  return result;
}

/** The first `message` frame the adapter has read that `match`es: polled, since it writes its file after the send. */
async function messageWhere(
  name: string,
  match: (frame: Readonly<Record<string, unknown>>) => boolean,
): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined;
  await pollUntil(async () => {
    found = (await frames(name)).find((f) => f["kind"] === "message" && match(f));
    return found !== undefined;
  }, `${name}'s message frame`);
  if (found === undefined) throw new Error("unreachable");
  return found;
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-adapter-msg-")));
  await mkdir(join(base, ".claude", "sessions"), { recursive: true });
  project = join(base, "proj");
  elsewhere = join(base, "elsewhere");
  await mkdir(project);
  await mkdir(elsewhere);
  await exec(["git", "init", "-q", "-b", "feature-x", project]);
  exclaves = [{ id: "default", root: base, configDir: join(base, ".claude"), configFile: join(base, ".claude.json") }];
  repos = [{ name: "proj", path: project, defaultBranch: "main" }];
  claude = await linkClaudeNamed(join(base, "bin"));
  adapter = join(base, "bin", "reference-adapter.ts");
  await link(REFERENCE, adapter);
  const warmed = await exec([adapter, "--warm"]);
  if (warmed.exitCode !== 0) throw new Error(`reference adapter failed to start: ${warmed.stderr}`);
  privateTmux = usePrivateTmux(base, "adaptermsg");
  await tmuxOk(["new-session", "-d", "-s", "adaptermsg", "-c", base, "sleep", "600"]);
  ended = new EndedTasks(LaunchLedger.memory());
});

afterAll(async () => {
  for (const stop of stops.toReversed()) await stop();
  await privateTmux?.dispose();
  // Whatever a test sent, either way, the audit lines carry none of it.
  for (const text of texts.filter((each) => each.length >= 6)) {
    for (const line of auditLines) expect(line).not.toContain(text);
  }
  await rm(base, { recursive: true, force: true });
});

let windows = 0;

interface Session {
  readonly pane: string;
  readonly pid: number;
  readonly key: string;
}

/** A pane whose `claude` (the child of its shell) sleeps: a hand-started session, or with `taskId` a launched one. */
async function claudePane(opts: { readonly taskId?: string; readonly cwd?: string } = {}): Promise<Session> {
  const name = `w${++windows}`;
  const go = join(base, `${name}.go`);
  const pidFile = join(base, `${name}.pid`);
  const script = `while [ ! -e ${shq(go)} ]; do sleep 0.05; done; ${underClaude(claude, { pidFile })}`;
  const pane = (
    await tmuxOk([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      "adaptermsg:",
      "-n",
      name,
      "-c",
      opts.cwd ?? project,
      "sh",
      "-c",
      script,
    ])
  ).trim();
  if (opts.taskId !== undefined) await tmuxOk(["set-option", "-p", "-t", pane, "@seance-task", opts.taskId]);
  await writeFile(go, "");
  await pollUntil(async () => (await readFile(pidFile, "utf8").catch(() => "")) !== "", `${name}'s claude`);
  const pid = Number(await readFile(pidFile, "utf8"));
  return { pane, pid, key: `${pid}:${processStart(pid)}` };
}

/** A task launched here under conversation `session` (the ledger verifies its claim), in `repo`. */
async function launch(session: string, repo = "proj"): Promise<string> {
  const id = taskId();
  const settle = await ended.launch(id);
  await settle(true, { site: { repo, worktree: repo === "proj" ? project : elsewhere, session } });
  return id;
}

const report = (d: Daemon, pid: number, frame: object): ReturnType<SessionEvents["handle"]> =>
  d.events.handle({ v: SESSION_EVENT_VERSION, kind: SESSION_EVENT_KIND, ...frame }, pid);

/** Has `s` claim `conversation` and waits until the table verifies it. */
async function claim(d: Daemon, s: Session, conversation: string): Promise<void> {
  await report(d, s.pid, { state: "idle", turnEnded: true, agent: { kind: "claude", session: conversation } });
  await pollUntil(async () => (await d.table.verifiedFor(s.key)) === conversation, `${s.pane}'s verified claim`);
  await d.feed.refresh();
}

/** What a test reads of an inbox line (`InboxLine`). */
type Received = Pick<InboxLine, "id" | "push" | "wake">;

interface Inbox {
  readonly lines: () => readonly Received[];
  readonly close: () => void;
}

/** The pane's `seance inbox` listener, bound by its `claude` process as the real one is. */
async function listen(d: Daemon, s: Session): Promise<Inbox> {
  const written: string[] = [];
  const gone = new AbortController();
  const sink: ListenerSink = {
    write: (line) => {
      written.push(line);
      return true;
    },
    close: () => gone.abort(),
    gone: gone.signal,
  };
  await d.messages.listen(INBOX, s.pid, sink);
  return {
    lines: () =>
      written.flatMap((raw): Received[] => {
        const line: unknown = JSON.parse(raw);
        if (!isRecord(line) || typeof line["id"] !== "string" || typeof line["push"] !== "string") return [];
        return [{ id: line["id"], push: line["push"], ...(line["wake"] === true ? { wake: true } : {}) }];
      }),
    close: () => gone.abort(),
  };
}

/** A session's `send_message`, from inside its pane. */
function send(d: Daemon, s: Session, frame: Readonly<Record<string, unknown>>): ReturnType<Messages["send"]> {
  if (typeof frame["text"] === "string" && frame["text"] !== "") texts.push(frame["text"]);
  return d.messages.send({ v: 1, kind: "message", ...frame }, s.pid);
}

describe("an adapter's delivery into a session", () => {
  let d: Daemon;
  beforeAll(async () => {
    d = await boot();
    await host(d, { tg: {}, kinds: { kinds: ["note"] }, scoped: { repos: ["proj"] } });
  });
  afterAll(() => halt(d));

  test("to a task: the adapter wrapper, `wake` only when asked, a kind not in `kinds` refused", async () => {
    const id = await launch(conv(1));
    const s = await claudePane({ taskId: id });
    const inbox = await listen(d, s);
    const note = await fromAdapter("tg", { kind: "deliver", to: id, messageKind: "note", text: "build is green" });
    expect(note).toMatchObject({ outcome: "delivered", id: expect.any(String) });
    const woken = await fromAdapter("tg", {
      kind: "deliver",
      to: id,
      messageKind: "note",
      text: "ping",
      wake: true,
      from: "Ada",
    });
    expect(woken).toMatchObject({ outcome: "delivered" });
    const [first, second] = inbox.lines();
    expect(first?.push).toContain("the `tg` adapter on `box` relays a message");
    expect(first?.push).toContain("build is green");
    expect(first?.wake).toBeUndefined();
    expect(second?.wake).toBe(true);
    expect(second?.push).toContain('"Ada"');
    const question = await fromAdapter("kinds", { kind: "deliver", to: id, messageKind: "question", text: "why?" });
    expect(question).toEqual({ kind: "result", ref: expect.any(String), outcome: "refused", code: "kind" });
    expect(inbox.lines()).toHaveLength(2);
    expect(auditLines).toContain(
      `audit adapter origin=adapter op=deliver name=tg dir=in to="${id}" kind=note bytes=14 outcome=delivered`,
    );
    expect(auditLines).toContain(
      `audit adapter origin=adapter op=deliver name=kinds dir=in to="${id}" kind=question bytes=4 outcome=refused code=kind`,
    );
  });

  test("held for a listener that has not come yet, then a `delivery` frame with what became of it", async () => {
    const id = await launch(conv(2));
    const s = await claudePane({ taskId: id });
    const held = await fromAdapter("tg", { kind: "deliver", to: id, messageKind: "question", text: "still there?" });
    expect(held).toMatchObject({ outcome: "sent" });
    const inbox = await listen(d, s);
    await pollUntil(
      async () => (await frames("tg")).some((f) => f["kind"] === "delivery" && f["id"] === held["id"]),
      "the delivery frame",
    );
    expect((await frames("tg")).find((f) => f["kind"] === "delivery" && f["id"] === held["id"])).toEqual({
      kind: "delivery",
      id: held["id"],
      outcome: "delivered",
    });
    expect(inbox.lines().map((line): unknown => line.id)).toEqual([held["id"]]);
  });

  test("an unknown task, an oversized text, a task outside `repos`, and the per-target rate", async () => {
    expect(
      await fromAdapter("tg", { kind: "deliver", to: "task-never", messageKind: "note", text: "x" }),
    ).toMatchObject({
      outcome: "unknown",
    });
    const id = await launch(conv(3));
    const s = await claudePane({ taskId: id });
    const inbox = await listen(d, s);
    expect(
      await fromAdapter("tg", { kind: "deliver", to: id, messageKind: "note", text: "y".repeat(MESSAGE_MAX + 1) }),
    ).toMatchObject({ outcome: "too_long" });
    const away = await launch(conv(4), "other");
    await claudePane({ taskId: away, cwd: elsewhere });
    expect(await fromAdapter("scoped", { kind: "deliver", to: away, messageKind: "note", text: "z" })).toMatchObject({
      outcome: "refused",
      code: "repo",
    });
    const outcomes: unknown[] = [];
    for (let n = 0; n <= MESSAGE_RATE.perMinute; n++) {
      // oxlint-disable-next-line no-await-in-loop -- in order: the bucket counts each before the next
      outcomes.push(
        (await fromAdapter("scoped", { kind: "deliver", to: id, messageKind: "note", text: `n${n}` }))["outcome"],
      );
    }
    expect(outcomes.slice(0, -1).every((outcome) => outcome === "delivered")).toBe(true);
    expect(outcomes.at(-1)).toBe("rate_limited");
    expect(inbox.lines()).toHaveLength(MESSAGE_RATE.perMinute);
  });
});

describe("a session's message to an adapter, and replies both ways", () => {
  let d: Daemon;
  beforeAll(async () => {
    d = await boot();
    await host(d, { echo: {}, deaf: { deaf: true }, scoped: { repos: ["proj"] } });
  });
  afterAll(() => halt(d));

  test("a question answered by the adapter's reply, which wakes the asker", async () => {
    const s = await claudePane();
    await writeSessionFile(s.pid, conv(10));
    await claim(d, s, conv(10));
    const inbox = await listen(d, s);
    const reply = await send(d, s, { to: "adapter:echo", messageKind: "question", text: "are you there" });
    expect(reply).toMatchObject({
      ok: true,
      outcome: "delivered",
      subscribed: true,
      session: conv(10),
      adapter: "echo",
    });
    const out = await messageWhere("echo", (f) => f["text"] === "are you there");
    expect(out).toMatchObject({
      kind: "message",
      messageKind: "question",
      text: "are you there",
      from: { key: s.key, session: conv(10) },
      subscribed: true,
    });
    await pollUntil(() => inbox.lines().length > 0, "the echo");
    const [echo] = inbox.lines();
    expect(echo?.push).toContain("echo: are you there");
    expect(echo?.wake).toBe(true);
    expect(auditLines).toContain(
      "audit adapter origin=adapter op=message name=echo dir=out from=untasked kind=question bytes=13 outcome=delivered subscribed=true",
    );
  });

  test("an adapter's question answered by the session's reply by handle, which subscribes nothing", async () => {
    const id = await launch(conv(11));
    const s = await claudePane({ taskId: id });
    await claim(d, s, conv(11));
    const inbox = await listen(d, s);
    const asked = await fromAdapter("echo", { kind: "deliver", to: id, messageKind: "question", text: "deploy?" });
    await pollUntil(() => inbox.lines().length > 0, "the question");
    const reply = await send(d, s, { inReplyTo: asked["id"], messageKind: "note", text: "yes, at noon" });
    expect(reply).toMatchObject({ ok: true, subscribed: false, adapter: "echo" });
    expect(d.subscriptions.has("echo", conv(11))).toBe(false);
    const answer = await messageWhere("echo", (f) => f["inReplyTo"] === asked["id"]);
    expect(answer).toMatchObject({ messageKind: "note", text: "yes, at noon", from: { key: s.key, task: id } });
    // An `inReplyTo` the adapter never sent this session is dropped, never passed on as the adapter's own id.
    await send(d, s, { to: "adapter:echo", inReplyTo: crypto.randomUUID(), messageKind: "note", text: "stray" });
    const stray = await messageWhere("echo", (f) => f["text"] === "stray");
    expect(stray?.["inReplyTo"]).toBeUndefined();
  });

  test("an unverified sender is never subscribed, and its reply still comes back", async () => {
    const s = await claudePane();
    // A claim no file and no launch backs: shown, never verified.
    await report(d, s.pid, { state: "idle", agent: { kind: "claude", session: conv(12) } });
    const inbox = await listen(d, s);
    const reply = await send(d, s, { to: "adapter:echo", messageKind: "request", text: "summarise" });
    expect(reply).toMatchObject({ ok: true, subscribed: false });
    expect(reply).not.toHaveProperty("session");
    const out = await messageWhere("echo", (f) => f["text"] === "summarise");
    expect(out?.["subscribed"]).toBe(false);
    expect(out?.["from"]).toEqual({ key: s.key });
    await pollUntil(() => inbox.lines().length > 0, "the echo");
    expect(inbox.lines()[0]?.push).toContain("echo: summarise");
  });

  test("an unknown adapter, one that takes no messages, a sender outside `repos`, an oversized text", async () => {
    const s = await claudePane({ cwd: elsewhere });
    await writeSessionFile(s.pid, conv(13));
    await claim(d, s, conv(13));
    expect(await send(d, s, { to: "adapter:nobody", messageKind: "note", text: "hello" })).toEqual({
      ok: false,
      code: "unknown",
    });
    expect(await send(d, s, { to: "adapter:deaf", messageKind: "note", text: "hello" })).toEqual({
      ok: false,
      code: "unknown",
    });
    expect(d.subscriptions.has("deaf", conv(13))).toBe(false);
    expect(await send(d, s, { to: "adapter:scoped", messageKind: "note", text: "outside" })).toEqual({
      ok: false,
      code: "refused",
    });
    expect(d.subscriptions.has("scoped", conv(13))).toBe(false);
    expect(await send(d, s, { to: "adapter:echo", messageKind: "note", text: "w".repeat(MESSAGE_MAX + 1) })).toEqual({
      ok: false,
      code: "too_long",
    });
    expect(auditLines).toContain(
      "audit adapter origin=adapter op=message name=scoped dir=out from=untasked kind=note bytes=7 outcome=refused subscribed=false",
    );
  });
});

describe("the subscription", () => {
  test("reaches the conversation across a `--resume` in another process and a daemon restart", async () => {
    let d = await boot();
    await host(d, { tg: { argv: [adapter, "--no-echo"] } });
    const first = await claudePane();
    await writeSessionFile(first.pid, conv(20));
    await claim(d, first, conv(20));
    await send(d, first, { to: "adapter:tg", messageKind: "note", text: "subscribe me" });
    expect(d.subscriptions.has("tg", conv(20))).toBe(true);

    // `claude --resume` in another pane: a new process in the same conversation.
    process.kill(first.pid, "SIGKILL");
    const resumed = await claudePane();
    await writeSessionFile(resumed.pid, conv(20));
    await claim(d, resumed, conv(20));
    let inbox = await listen(d, resumed);
    expect(
      await fromAdapter("tg", { kind: "deliver", toSession: conv(20), messageKind: "note", text: "after resume" }),
    ).toMatchObject({ outcome: "delivered" });
    expect(
      inbox
        .lines()
        .map((line) => line.push)
        .join("\n"),
    ).toContain("after resume");

    await halt(d);
    d = await boot();
    await host(d, { tg: { argv: [adapter, "--no-echo"] } });
    await claim(d, resumed, conv(20));
    inbox = await listen(d, resumed);
    expect(
      await fromAdapter("tg", { kind: "deliver", toSession: conv(20), messageKind: "note", text: "after restart" }),
    ).toMatchObject({ outcome: "delivered" });
    expect(
      inbox
        .lines()
        .map((line) => line.push)
        .join("\n"),
    ).toContain("after restart");
    await halt(d);
  });

  test("`ambiguous` while two processes claim it, `unverified` after a `/clear`", async () => {
    const d = await boot();
    await host(d, { tg: { argv: [adapter, "--no-echo"] } });
    const s = await claudePane();
    await writeSessionFile(s.pid, conv(21));
    await claim(d, s, conv(21));
    await send(d, s, { to: "adapter:tg", messageKind: "note", text: "hi" });
    const twin = await claudePane();
    await writeSessionFile(twin.pid, conv(21));
    await report(d, twin.pid, { state: "idle", agent: { kind: "claude", session: conv(21) } });
    await pollUntil(async () => (await d.table.atAct(conv(21))).ok === false, "the conflict");
    expect(
      await fromAdapter("tg", { kind: "deliver", toSession: conv(21), messageKind: "note", text: "which one" }),
    ).toMatchObject({ outcome: "ambiguous" });
    process.kill(twin.pid, "SIGKILL");
    await pollUntil(async () => (await d.table.atAct(conv(21))).ok, "the twin gone");
    // `/clear`: Claude Code writes the file for the new conversation before any report.
    await writeSessionFile(s.pid, conv(22));
    expect(
      await fromAdapter("tg", { kind: "deliver", toSession: conv(21), messageKind: "note", text: "still you?" }),
    ).toMatchObject({ outcome: "unverified" });
    await halt(d);
  });

  test("ended by the session's `leave`, and by the name re-added as another program", async () => {
    let d = await boot();
    await host(d, { tg: { argv: [adapter, "--no-echo"] }, mail: { argv: [adapter, "--no-echo"] } });
    const s = await claudePane();
    await writeSessionFile(s.pid, conv(23));
    await claim(d, s, conv(23));
    await send(d, s, { to: "adapter:tg", messageKind: "note", text: "join tg" });
    await send(d, s, { to: "adapter:mail", messageKind: "note", text: "join mail" });
    const left = await send(d, s, { to: "adapter:tg", messageKind: "note", text: "", leave: true });
    expect(left).toMatchObject({ ok: true, subscribed: false });
    expect(await messageWhere("tg", (f) => f["leave"] === true)).toMatchObject({ subscribed: false, text: "" });
    expect(
      await fromAdapter("tg", { kind: "deliver", toSession: conv(23), messageKind: "note", text: "gone?" }),
    ).toMatchObject({ outcome: "unknown" });
    await listen(d, s);
    expect(
      await fromAdapter("mail", { kind: "deliver", toSession: conv(23), messageKind: "note", text: "still here" }),
    ).toMatchObject({ outcome: "delivered" });

    // `mail` configured as another program under the same name inherits nothing.
    await halt(d);
    d = await boot();
    await host(d, { mail: { argv: [adapter, "--no-echo", "--name", "mail"] } });
    await claim(d, s, conv(23));
    expect(
      await fromAdapter("mail", { kind: "deliver", toSession: conv(23), messageKind: "note", text: "who?" }),
    ).toMatchObject({ outcome: "unknown" });
    await halt(d);
  });
});

describe("an adapter's tags", () => {
  test("only on a conversation subscribed to it or a task launched here, and seen by no other adapter", async () => {
    const d = await boot();
    await host(d, { tg: { argv: [adapter, "--no-echo"] }, mail: { argv: [adapter, "--no-echo"] } });
    const s = await claudePane();
    await writeSessionFile(s.pid, conv(30));
    await claim(d, s, conv(30));
    expect(await fromAdapter("tg", { kind: "tag", session: conv(30), key: "ticket", value: "ENG-1" })).toMatchObject({
      outcome: "unknown",
    });
    expect(await fromAdapter("tg", { kind: "tag", task: "task-never", key: "ticket", value: "ENG-1" })).toMatchObject({
      outcome: "unknown",
    });
    await send(d, s, { to: "adapter:tg", messageKind: "note", text: "please subscribe me" });
    expect(await fromAdapter("tg", { kind: "tag", session: conv(30), key: "ticket", value: "ENG-2" })).toMatchObject({
      outcome: "ok",
    });
    await d.feed.refresh();
    await pollUntil(
      async () =>
        (await frames("tg")).some(
          (f) => f["kind"] === "session" && JSON.stringify(f["session"]).includes('"adapter.tg.ticket"'),
        ),
      "the tag on tg's record",
    );
    const mailSaw = (await frames("mail")).filter((f) => f["kind"] === "session" || f["kind"] === "snapshot");
    expect(mailSaw.length).toBeGreaterThan(0);
    expect(JSON.stringify(mailSaw)).not.toContain("adapter.tg.");
    await halt(d);
  });
});
