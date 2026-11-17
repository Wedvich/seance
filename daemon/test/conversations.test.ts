import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord, parseTags, SCHEDULER_ID, type Plain, type SessionEntry } from "@seance/shared";
import { ctimeUtcSeconds } from "../src/agent-session-file.ts";
import type { SessionBackend } from "../src/backend.ts";
import { createConversations, SETTLE_MS, type Conversations } from "../src/conversations.ts";
import type { Exclave } from "../src/exclaves.ts";
import { createHandler, type HandlerContext } from "../src/handlers.ts";
import { processStart } from "../src/peer.ts";
import { SESSION_EVENT_KIND, SESSION_EVENT_VERSION } from "../src/session-event-frame.ts";
import { createSessionEvents, EndedTasks, listPanePids, type SessionEvents } from "../src/session-events.ts";
import { tmuxOk } from "../src/tmux.ts";
import { linkClaudeNamed, pollUntil, underClaude, usePrivateTmux, type PrivateTmux } from "./fixtures.ts";

/**
 * Session identity with real processes (docs/tags.md §4): `claude`-named processes in panes of a private tmux server,
 * reporting as the peer the socket would name, and `sessions/<pid>.json` files written as Claude Code writes them. The
 * socket's own peer lookup is `session-events.test.ts`'s; here `handle` is called with the process's pid.
 */

let base: string;
let dirA: string;
let dirB: string;
let claude: string;
let privateTmux: PrivateTmux | undefined;
let exclaves: readonly Exclave[];
const launches = new Map<string, string>();
const tables: Conversations[] = [];
const ingests: SessionEvents[] = [];
let table: Conversations;
let events: SessionEvents;

const id = (n: number): string => `${String(n).padStart(8, "0")}-1c2d-4e5f-8a9b-0c1d2e3f4a5b`;

function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A fresh table and its ingest: what a daemon (re)start builds. */
function boot(opts: { readonly hostNamesPeers?: boolean } = {}): {
  readonly table: Conversations;
  readonly events: SessionEvents;
} {
  const conversations = createConversations({
    configDirs: () => [dirA, dirB],
    launchSession: (taskId) => launches.get(taskId),
    panes: listPanePids,
  });
  const ingest = createSessionEvents({
    panes: listPanePids,
    exclaves: () => exclaves,
    forward: () => {},
    ended: new EndedTasks(),
    coalesceMs: 0,
    conversations,
    ...(opts.hostNamesPeers === false ? { hostNamesPeers: () => false } : {}),
  });
  tables.push(conversations);
  ingests.push(ingest);
  return { table: conversations, events: ingest };
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-conv-")));
  dirA = join(base, ".claude");
  dirB = join(base, ".claude-work");
  await mkdir(join(dirA, "sessions"), { recursive: true });
  await mkdir(join(dirB, "sessions"), { recursive: true });
  exclaves = [{ id: "default", root: base, configDir: dirA, configFile: join(base, ".claude.json") }];
  claude = await linkClaudeNamed(join(base, "bin"));
  privateTmux = usePrivateTmux(base, "conv");
  await tmuxOk(["new-session", "-d", "-s", "conv", "-c", base, "sleep", "600"]);
  ({ table, events } = boot());
});

afterAll(async () => {
  for (const ingest of ingests) ingest.stop();
  for (const each of tables) each.stop();
  await privateTmux?.dispose();
  await rm(base, { recursive: true, force: true });
});

let windows = 0;

/** A pane running `command` under `sh -c`, tagged with `taskId` before anything can report. */
async function pane(command: string, taskId?: string): Promise<string> {
  const name = `w${++windows}`;
  const go = join(base, `${name}.go`);
  const script = `while [ ! -e ${shq(go)} ]; do sleep 0.05; done; ${command}`;
  const paneId = (
    await tmuxOk([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      "conv:",
      "-n",
      name,
      "-c",
      base,
      "sh",
      "-c",
      script,
    ])
  ).trim();
  if (taskId !== undefined) await tmuxOk(["set-option", "-p", "-t", paneId, "@seance-task", taskId]);
  await writeFile(go, "");
  return paneId;
}

async function pidIn(file: string): Promise<number> {
  await pollUntil(async () => (await Bun.file(file).exists()) && (await readFile(file, "utf8")) !== "", `${file}`);
  return Number(await readFile(file, "utf8"));
}

/** A pane whose `claude` sleeps: a hand-started (or, with `taskId`, a launched) session. */
async function claudePane(taskId?: string): Promise<{ readonly pane: string; readonly pid: number }> {
  const pidFile = join(base, `claude-${++windows}.pid`);
  const paneId = await pane(underClaude(claude, { pidFile }), taskId);
  return { pane: paneId, pid: await pidIn(pidFile) };
}

/** `procStart` as Claude Code writes it on this platform (S3): Linux's tick string, macOS's start second as UTC ctime. */
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

async function writeSessionFile(pid: number, sessionId: string, opts: { dir?: string; bridge?: string } = {}) {
  const record = {
    pid,
    sessionId,
    procStart: procStartOf(pid),
    ...(opts.bridge === undefined ? {} : { bridgeSessionId: opts.bridge }),
  };
  await writeFile(join(opts.dir ?? dirA, "sessions", `${pid}.json`), JSON.stringify(record));
}

function report(
  pid: number | null,
  frame: object,
  ingest: SessionEvents = events,
): ReturnType<SessionEvents["handle"]> {
  return ingest.handle({ v: SESSION_EVENT_VERSION, kind: SESSION_EVENT_KIND, ...frame }, pid);
}

const claim = (session: string, extra: object = {}): object => ({
  state: "busy",
  agent: { kind: "claude", session },
  ...extra,
});

/** The pane's current conversation claim, as `process` shows it. */
const sessionOf = (paneId: string, on: Conversations = table) => on.process(paneId)?.session ?? null;

describe("verification", () => {
  test("a claim the launch ledger made is verified while no file exists", async () => {
    launches.set("t-ledger", id(1));
    const { pane: p, pid } = await claudePane("t-ledger");
    await report(pid, claim(id(1)));
    await pollUntil(() => sessionOf(p)?.verified === true, "the ledger to verify the claim");
    expect(table.tagsFor(p)?.["agent.session"]).toEqual({
      value: id(1),
      at: expect.any(Number),
      scope: "conversation",
      verified: true,
    });
    expect(table.tagsFor(p)?.["agent.kind"]).toEqual({
      value: "claude",
      at: expect.any(Number),
      scope: "conversation",
    });
  });

  test("a claim the process's own file names is verified", async () => {
    const { pane: p, pid } = await claudePane();
    await writeSessionFile(pid, id(2));
    await report(pid, claim(id(2)));
    await pollUntil(() => sessionOf(p)?.verified === true, "the file to verify the claim");
  });

  test("a claim with no file and no launch stays unverifiable", async () => {
    const { pane: p, pid } = await claudePane();
    await report(pid, claim(id(3)));
    await pollUntil(() => sessionOf(p) !== null, "the claim to be retained");
    // A non-event: nothing would ever verify it.
    await Bun.sleep(SETTLE_MS + 100);
    expect(sessionOf(p)).toEqual({ id: id(3), verified: false, conflict: false });
    expect(table.tagsFor(p)?.["agent.session"]?.verified).toBeUndefined();
  });

  test("a claim the file refutes is dropped at the window's end, and counts toward no conflict", async () => {
    const liar = await claudePane();
    const other = await claudePane();
    await writeSessionFile(liar.pid, id(4));
    await report(other.pid, claim(id(5)));
    await pollUntil(() => sessionOf(other.pane) !== null, "the other claim");
    await report(liar.pid, claim(id(5)));
    await pollUntil(() => sessionOf(liar.pane) !== null, "the liar's claim, settling");
    // Settling counts while the file may still catch up.
    expect(sessionOf(other.pane)?.conflict).toBe(true);
    await pollUntil(() => sessionOf(liar.pane) === null, "the refutation", SETTLE_MS * 4);
    expect(table.tagsFor(liar.pane)?.["agent.session"]).toBeUndefined();
    expect(sessionOf(other.pane)).toEqual({ id: id(5), verified: false, conflict: false });
  });

  for (const how of ["resume", "clear"]) {
    test(`a ${how} report the file catches up with inside the window is verified`, async () => {
      const { pane: p, pid } = await claudePane();
      await writeSessionFile(pid, id(6));
      await report(pid, claim(id(6)));
      await pollUntil(() => sessionOf(p)?.verified === true, "the first conversation");
      // The SessionStart hook's report lands before Claude Code rewrites the file (S1).
      await report(pid, { state: "idle", agent: { kind: "claude", session: id(7) } });
      await pollUntil(() => sessionOf(p)?.id === id(7), "the new claim");
      expect(sessionOf(p)?.verified).toBe(false);
      await Bun.sleep(50);
      await writeSessionFile(pid, id(7));
      await pollUntil(() => sessionOf(p)?.verified === true, "the file to catch up", SETTLE_MS * 2);
    });
  }

  test("a report the file never catches up with is refuted only at the window's end", async () => {
    const { pane: p, pid } = await claudePane();
    await writeSessionFile(pid, id(8));
    const at = Date.now();
    await report(pid, claim(id(9)));
    await pollUntil(() => sessionOf(p)?.id === id(9), "the claim");
    await pollUntil(() => sessionOf(p) === null, "the refutation", SETTLE_MS * 4);
    expect(Date.now() - at).toBeGreaterThanOrEqual(SETTLE_MS);
  });

  test("two config dirs whose files both match verify nothing", async () => {
    launches.set("t-two-dirs", id(10));
    const { pane: p, pid } = await claudePane("t-two-dirs");
    await writeSessionFile(pid, id(10), { dir: dirA });
    await writeSessionFile(pid, id(10), { dir: dirB });
    await report(pid, claim(id(10)));
    await pollUntil(() => sessionOf(p) !== null, "the claim");
    // The ledger agrees, but a file exists and cannot say which: no fallback past it.
    await Bun.sleep(100);
    expect(sessionOf(p)?.verified).toBe(false);
  });

  test("two live claimants of one id are a conflict, which an act answers ambiguous", async () => {
    const one = await claudePane();
    const two = await claudePane();
    await report(one.pid, claim(id(11)));
    await report(two.pid, claim(id(11)));
    await pollUntil(() => sessionOf(one.pane)?.conflict === true, "the conflict");
    expect(sessionOf(two.pane)?.conflict).toBe(true);
    expect(await table.atAct(id(11))).toEqual({ ok: false, code: "ambiguous" });
  });

  test("a claim bound through the frame's pane is never verified and never counted", async () => {
    const fallback = boot({ hostNamesPeers: false });
    launches.set("t-fallback", id(12));
    const { pane: p } = await claudePane("t-fallback");
    expect(await report(null, { ...claim(id(12)), pane: p }, fallback.events)).toEqual({ ok: true });
    await pollUntil(() => sessionOf(p, fallback.table) !== null, "the fallback claim");
    await Bun.sleep(100);
    expect(sessionOf(p, fallback.table)).toEqual({ id: id(12), verified: false, conflict: false });
    expect(await fallback.table.atAct(id(12))).toEqual({ ok: false, code: "ended" });
  });

  test("a /clear in a tasked pane demotes the ledger's id at the next act, until the file agrees", async () => {
    launches.set("t-clear", id(13));
    const { pane: p, pid } = await claudePane("t-clear");
    await report(pid, claim(id(13)));
    await pollUntil(() => sessionOf(p)?.verified === true, "the ledger's verification");
    expect(await table.atAct(id(13))).toEqual({ ok: true, pane: p, pid });
    // `/clear`: Claude Code writes the file for the new conversation; no report has come yet.
    await writeSessionFile(pid, id(14));
    expect(await table.atAct(id(13))).toEqual({ ok: false, code: "unverified" });
    expect(sessionOf(p)?.verified).toBe(false);
    await pollUntil(() => sessionOf(p) === null, "the ledger's id refuted", SETTLE_MS * 4);
    await report(pid, claim(id(14)));
    await pollUntil(() => sessionOf(p)?.verified === true, "the file's verification of the new id");
    expect(await table.atAct(id(14))).toEqual({ ok: true, pane: p, pid });
  });
});

describe("a daemon restart", () => {
  test("relearns a conversation from the next report, and an idle pane's from its own read", async () => {
    const busy = await claudePane();
    const idle = await claudePane();
    await writeSessionFile(busy.pid, id(15));
    await writeSessionFile(idle.pid, id(16), { bridge: "session_01IdleBridge" });
    const restarted = boot();
    expect(restarted.table.process(busy.pane)).toBeNull();
    await report(busy.pid, claim(id(15)), restarted.events);
    await pollUntil(() => sessionOf(busy.pane, restarted.table)?.verified === true, "the report's verification");
    await restarted.table.sweep();
    expect(sessionOf(idle.pane, restarted.table)).toEqual({ id: id(16), verified: true, conflict: false });
    expect(restarted.table.tagsFor(idle.pane)?.["agent.remote"]).toEqual({
      value: "session_01IdleBridge",
      at: expect.any(Number),
      scope: "process",
    });
  });
});

describe("retention", () => {
  test("is kept for a hand-started pane's claude, tasked or not", async () => {
    const { pane: p, pid } = await claudePane();
    await report(pid, { state: "idle", turnEnded: true, agent: { kind: "claude", remote: "session_01Hand" } });
    await pollUntil(() => table.process(p)?.state === "idle", "the state retained");
    expect(table.process(p)?.remote).toBe("session_01Hand");
    expect(table.process(p)?.taskId).toBeNull();
  });

  test("is none for a shell's child with no claude on its chain", async () => {
    const pidFile = join(base, "shell-child.pid");
    const p = await pane(`sleep 600 & echo $! > ${shq(pidFile)}; wait`);
    const pid = await pidIn(pidFile);
    expect(await report(pid, claim(id(17)))).toEqual({ ok: true });
    // A non-event: there is nothing to poll for.
    await Bun.sleep(150);
    expect(table.process(p)).toBeNull();
    expect(table.tagsFor(p)).toBeUndefined();
  });

  test("a claude restarted under the same shell starts with no process tags", async () => {
    const first = join(base, "first.pid");
    const second = join(base, "second.pid");
    const p = await pane(`${underClaude(claude, { pidFile: first })}; ${underClaude(claude, { pidFile: second })}`);
    const firstPid = await pidIn(first);
    await report(firstPid, { state: "busy", agent: { kind: "claude", remote: "session_01First" } });
    await pollUntil(() => table.process(p)?.remote === "session_01First", "the first claude's remote");
    process.kill(firstPid, "SIGKILL");
    const secondPid = await pidIn(second);
    await report(secondPid, { state: "idle" });
    await pollUntil(() => table.process(p)?.pid === secondPid, "the second claude's report");
    expect(table.process(p)?.remote).toBeNull();
    expect(table.tagsFor(p)?.["agent.remote"]).toBeUndefined();
  });

  test("the remoteSession field is agent.remote's fallback", async () => {
    const { pane: p, pid } = await claudePane();
    await report(pid, { state: "busy", remoteSession: "session_01Legacy" });
    await pollUntil(() => table.process(p)?.remote === "session_01Legacy", "the fallback remote");
    await report(pid, { state: "busy", remoteSession: "session_01Legacy", agent: { remote: "session_01New" } });
    await pollUntil(() => table.process(p)?.remote === "session_01New", "agent.remote first");
  });
});

describe("SessionEntry.tags", () => {
  test("ride an app's sessions reply and never a scheduler-sealed one", async () => {
    const { pane: p, pid } = await claudePane();
    await writeSessionFile(pid, id(18));
    await report(pid, claim(id(18)));
    await pollUntil(() => sessionOf(p)?.verified === true, "the claim verified");
    const entry: SessionEntry = { id: p, window: "w", repo: null, path: base };
    const backend: SessionBackend = {
      spawn: () => Promise.reject(new Error("not in this suite")),
      sessions: () => Promise.resolve([entry]),
      doctor: () => Promise.resolve([]),
    };
    const ctx: HandlerContext = {
      backend,
      getRepos: () => [],
      rescan: () => Promise.resolve([]),
      auditSink: () => {},
      tasks: new EndedTasks(),
      conversations: table,
    };
    /** The first entry's `tags` as the wire carries them. */
    const ask = async (from: string): Promise<unknown> => {
      const request: Plain = { id: crypto.randomUUID(), ts: Date.now(), op: "sessions", payload: {} };
      const payload = (await createHandler(ctx)(request, from))?.payload;
      const sessions = isRecord(payload) ? payload["sessions"] : undefined;
      const first: unknown = Array.isArray(sessions) ? sessions[0] : undefined;
      if (!isRecord(first)) throw new Error("no session entry in the reply");
      return first["tags"];
    };
    expect(parseTags(await ask("app"), { scope: "session" })?.["agent.session"]).toEqual({
      value: id(18),
      at: expect.any(Number),
      scope: "conversation",
      verified: true,
    });
    expect(await ask(SCHEDULER_ID)).toBeUndefined();
  });
});
