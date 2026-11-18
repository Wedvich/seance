import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AdapterSession, RepoEntry } from "@seance/shared";
import { createAdapterFeed, type AdapterFeed, type FeedFrame } from "../src/adapter-feed.ts";
import { startAdapterHost, tagsFor, type AdapterHost } from "../src/adapter-host.ts";
import { adapterAudit } from "../src/audit.ts";
import { noteClosing } from "../src/closing-panes.ts";
import { createConversations, type Conversations } from "../src/conversations.ts";
import { exec } from "../src/exec.ts";
import type { Exclave } from "../src/exclaves.ts";
import { LaunchLedger } from "../src/launch-ledger.ts";
import { processStart } from "../src/peer.ts";
import { SESSION_EVENT_KIND, SESSION_EVENT_VERSION } from "../src/session-event-frame.ts";
import { createSessionEvents, EndedTasks, listPanePids, type SessionEvents } from "../src/session-events.ts";
import { tmuxOk } from "../src/tmux.ts";
import { linkClaudeNamed, pollUntil, underClaude, usePrivateTmux, type PrivateTmux } from "./fixtures.ts";

/**
 * State out to adapters (docs/messaging.md §6.1) with real processes: `claude`-named processes in panes of a private
 * tmux server, reporting through the session-event ingest as the peer the socket would name, the feed reading them,
 * and the host handing the frames to the reference adapter (`test/bin/reference-adapter.ts`).
 */

const REFERENCE = resolve(import.meta.dir, "bin/reference-adapter.ts");

let base: string;
let project: string;
let claude: string;
let adapter: string;
let privateTmux: PrivateTmux | undefined;
let exclaves: readonly Exclave[];
let repos: readonly RepoEntry[];
let ended: EndedTasks;
const stops: (() => unknown)[] = [];

const id = (n: number): string => `${String(n).padStart(8, "0")}-2c2d-4e5f-8a9b-0c1d2e3f4a5b`;
const conv = (n: number): string => `${String(n).padStart(8, "0")}-aaaa-4bbb-8ccc-dddddddddddd`;
const shq = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

interface Daemon {
  readonly table: Conversations;
  readonly events: SessionEvents;
  readonly feed: AdapterFeed;
  readonly frames: FeedFrame[];
}

/** What a daemon (re)start builds: a fresh table, ingest and feed over the same panes and ledger. */
async function boot(): Promise<Daemon> {
  const table = createConversations({
    configDirs: () => [join(base, ".claude")],
    launchSession: (taskId) => ended.launchSession(taskId),
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
  const frames: FeedFrame[] = [];
  feed.listen((frame) => frames.push(frame));
  stops.push(feed.stop, events.stop, table.stop);
  await feed.start();
  return { table, events, feed, frames };
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-adapters-")));
  await mkdir(join(base, ".claude", "sessions"), { recursive: true });
  project = join(base, "proj");
  await mkdir(project);
  await exec(["git", "init", "-q", "-b", "feature-x", project]);
  exclaves = [{ id: "default", root: base, configDir: join(base, ".claude"), configFile: join(base, ".claude.json") }];
  repos = [{ name: "proj", path: project, defaultBranch: "main" }];
  claude = await linkClaudeNamed(join(base, "bin"));
  adapter = join(base, "bin", "reference-adapter.ts");
  await link(REFERENCE, adapter);
  const warmed = await exec([adapter, "--warm"]);
  if (warmed.exitCode !== 0) throw new Error(`reference adapter failed to start: ${warmed.stderr}`);
  privateTmux = usePrivateTmux(base, "adapters");
  await tmuxOk(["new-session", "-d", "-s", "adapters", "-c", base, "sleep", "600"]);
  ended = new EndedTasks(LaunchLedger.memory());
});

afterAll(async () => {
  for (const stop of stops.toReversed()) await stop();
  await privateTmux?.dispose();
  await rm(base, { recursive: true, force: true });
});

let windows = 0;

/** A pane whose `claude` (the child of its shell) sleeps: a hand-started session, or with `taskId` a launched one. */
async function claudePane(opts: { readonly taskId?: string; readonly cwd?: string } = {}): Promise<{
  readonly pane: string;
  readonly pid: number;
  readonly key: string;
}> {
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
      "adapters:",
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

const report = (d: Daemon, pid: number, frame: object): ReturnType<SessionEvents["handle"]> =>
  d.events.handle({ v: SESSION_EVENT_VERSION, kind: SESSION_EVENT_KIND, ...frame }, pid);

const sessionOf = (d: Daemon, key: string): AdapterSession | undefined =>
  d.feed.current().find((session) => session.key === key);

const sessionsFor = (d: Daemon, key: string): readonly AdapterSession[] =>
  d.frames.flatMap((frame) => (frame.kind === "session" && frame.session.key === key ? [frame.session] : []));

const goneFor = (d: Daemon, key: string): readonly string[] =>
  d.frames.flatMap((frame) => (frame.kind === "session-gone" && frame.key === key ? [frame.reason] : []));

describe("the state feed", () => {
  let d: Daemon;
  beforeAll(async () => {
    d = await boot();
  });

  test("a hand-started session is listed before it reports: key, repo, branch, window name, state unknown", async () => {
    const { key } = await claudePane();
    await d.feed.refresh();
    const session = sessionOf(d, key);
    expect(session).toMatchObject({
      key,
      exclave: "default",
      repo: "proj",
      branch: "feature-x",
      state: "unknown",
      name: { text: `w${windows}`, source: "window" },
      tags: {},
    });
    expect(session?.task).toBeUndefined();
    expect(session?.session).toBeUndefined();
    expect(sessionsFor(d, key)).toHaveLength(1);
  });

  test("a report moves it: one whole `session` record per change, with the conversation it claims", async () => {
    const { key, pid } = await claudePane();
    await d.feed.refresh();
    await report(d, pid, { state: "busy", agent: { kind: "claude", session: conv(1) } });
    await pollUntil(() => sessionsFor(d, key).some((s) => s.state === "busy"), "the busy record");
    const busy = sessionOf(d, key);
    // No `sessions/<pid>.json` and no launch: a claim the daemon cannot check, shown but never verified.
    expect(busy?.session).toEqual({ id: conv(1), verified: false });
    expect(busy?.tags["agent.session"]).toMatchObject({ value: conv(1), scope: "conversation" });
    expect(busy?.tags["agent.kind"]).toMatchObject({ value: "claude" });
    await report(d, pid, { state: "idle", turnEnded: true });
    await pollUntil(() => sessionOf(d, key)?.state === "idle", "the idle record");
    expect(sessionOf(d, key)?.turnEnded).toBe(true);
    // A `/clear`: the same process moves to another conversation, one record, never a `session-gone`.
    await report(d, pid, { agent: { session: conv(2) } });
    await pollUntil(() => sessionOf(d, key)?.session?.id === conv(2), "the new conversation");
    expect(goneFor(d, key)).toEqual([]);
    const count = sessionsFor(d, key).length;
    await d.feed.refresh();
    expect(sessionsFor(d, key)).toHaveLength(count);
  });

  test("a process that ends on its own is `exited`", async () => {
    const { key, pid } = await claudePane();
    await d.feed.refresh();
    expect(sessionOf(d, key)).toBeDefined();
    process.kill(pid, "SIGKILL");
    await pollUntil(() => goneFor(d, key).length > 0, "the session-gone");
    expect(goneFor(d, key)).toEqual(["exited"]);
  });

  test("one Séance closes is `closed`", async () => {
    const { key, pid, pane } = await claudePane();
    await d.feed.refresh();
    // What `despawnSession` notes before every close of its own (a despawn, a hand-off, a pass, a custodian close).
    noteClosing(pane);
    process.kill(pid, "SIGKILL");
    await pollUntil(() => goneFor(d, key).length > 0, "the session-gone");
    expect(goneFor(d, key)).toEqual(["closed"]);
  });

  test("an `ended` report takes it out at once, as `exited`", async () => {
    const { key, pid } = await claudePane();
    await report(d, pid, { state: "busy" });
    await pollUntil(() => sessionOf(d, key)?.state === "busy", "the busy record");
    await report(d, pid, { state: "ended" });
    await pollUntil(() => goneFor(d, key).length > 0, "the session-gone");
    expect(goneFor(d, key)).toEqual(["exited"]);
    await d.feed.refresh();
    expect(sessionOf(d, key)).toBeUndefined();
  });

  test("a pane re-tagged for another task under the same process is `replaced`, then the new record", async () => {
    const { key, pid, pane } = await claudePane({ taskId: id(1) });
    await report(d, pid, { state: "busy" });
    await pollUntil(() => sessionOf(d, key)?.state === "busy", "the busy record");
    expect(sessionOf(d, key)?.task).toEqual({ id: id(1) });
    const before = d.frames.length;
    await tmuxOk(["set-option", "-p", "-t", pane, "@seance-task", id(2)]);
    await pollUntil(() => sessionOf(d, key)?.task?.id === id(2), "the re-tagged record");
    // A late refresh may still restate the old record before the re-tag lands (as on CI runners); what must hold is
    // that the old task's record is gone, as `replaced`, before any record names the new task.
    const after = d.frames
      .slice(before)
      .flatMap((frame) =>
        frame.kind === "session" && frame.session.key === key
          ? [`session:${frame.session.task?.id ?? "-"}`]
          : frame.kind === "session-gone" && frame.key === key
            ? [`gone:${frame.reason}`]
            : [],
      );
    const gone = after.indexOf("gone:replaced");
    expect(gone).toBeGreaterThanOrEqual(0);
    expect(after.slice(0, gone).every((entry) => entry === `session:${id(1)}`)).toBe(true);
    expect(after[gone + 1]).toBe(`session:${id(2)}`);
    expect(goneFor(d, key)).toEqual(["replaced"]);
    // The table's facts were the old task's: state reads unknown until this session reports under the new one.
    expect(sessionOf(d, key)?.state).toBe("unknown");
  });

  test("after a daemon restart every session reads `unknown` until it reports", async () => {
    const { key, pid } = await claudePane();
    await report(d, pid, { state: "busy" });
    await pollUntil(() => sessionOf(d, key)?.state === "busy", "the busy record");
    const restarted = await boot();
    expect(restarted.feed.current().length).toBeGreaterThan(0);
    expect(restarted.feed.current().every((session) => session.state === "unknown")).toBe(true);
    await report(restarted, pid, { state: "idle", turnEnded: true });
    await pollUntil(() => sessionOf(restarted, key)?.state === "idle", "the record after its report");
  });
});

describe("task events", () => {
  test("launched, done, handoff and ended, each once, with the PR the ledger holds", async () => {
    const d = await boot();
    const taskId = id(10);
    const settle = await ended.launch(taskId);
    await settle(true, { site: { repo: "proj", worktree: project } });
    await ended.notePr(taskId, "https://github.com/o/r/pull/7");
    await ended.noteReported(taskId);
    await ended.noteReported(taskId);
    await ended.handingOff(taskId);
    ended.ended(taskId);
    ended.ended(taskId);
    // Not launched here: no event.
    ended.ended(id(11));
    const tasks = d.frames.flatMap((frame) => (frame.kind === "task" ? [frame] : []));
    expect(tasks).toEqual([
      { kind: "task", task: taskId, event: "launched" },
      { kind: "task", task: taskId, event: "done", prUrl: "https://github.com/o/r/pull/7" },
      { kind: "task", task: taskId, event: "handoff", prUrl: "https://github.com/o/r/pull/7" },
      { kind: "task", task: taskId, event: "ended", prUrl: "https://github.com/o/r/pull/7" },
    ]);
  });
});

describe("the host and the reference adapter", () => {
  let d: Daemon;
  let audit: string[];
  const hosts: AdapterHost[] = [];

  beforeAll(async () => {
    d = await boot();
    audit = [];
  });

  afterAll(async () => {
    await Promise.all(hosts.map((each) => each.stop()));
  });

  const frames = async (dir: string): Promise<readonly Record<string, unknown>[]> =>
    (await readFile(join(dir, "frames.jsonl"), "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line !== "")
      .map((line): Record<string, unknown> => JSON.parse(line));

  function host(name: string, config: { readonly repos?: readonly string[] } = {}): AdapterHost {
    const started = startAdapterHost({
      adapters: { [name]: { argv: [adapter], kinds: ["note", "question"], ...config } },
      feed: d.feed,
      taskRepo: (taskId) => ended.taskRepo(taskId),
      machine: { deviceId: "dev-1", name: "box" },
      version: "test",
      audit: adapterAudit((line) => {
        audit.push(line);
      }),
      root: join(base, "adapters"),
      held: () => false,
    });
    hosts.push(started);
    started.start();
    return started;
  }

  test("snapshot after the handshake, then each session event from a real report", async () => {
    const { key, pid } = await claudePane();
    await d.feed.refresh();
    const ref = host("ref");
    const dir = join(base, "adapters", "ref");
    await pollUntil(async () => (await frames(dir)).some((f) => f["kind"] === "snapshot"), "the snapshot");
    const [hello, snapshot] = await frames(dir);
    expect(hello).toEqual({
      kind: "hello",
      protocol: [1],
      features: [],
      machine: { deviceId: "dev-1", name: "box" },
      daemon: { version: "test" },
    });
    const listed = snapshot?.["sessions"];
    expect(Array.isArray(listed) && listed.some((s: { key?: unknown }) => s.key === key)).toBe(true);
    await report(d, pid, { state: "needs-input", reason: "question" });
    await pollUntil(
      async () =>
        (await frames(dir)).some((f) => {
          const session = f["session"];
          return f["kind"] === "session" && typeof session === "object" && session !== null && "reason" in session;
        }),
      "the needs-input record",
    );
    const last = (await frames(dir)).findLast((f) => f["kind"] === "session");
    expect(last?.["session"]).toMatchObject({ key, state: "needs-input", reason: "question" });
    process.kill(pid, "SIGKILL");
    await pollUntil(
      async () => (await frames(dir)).some((f) => f["kind"] === "session-gone" && f["key"] === key),
      "the session-gone",
    );
    expect(ref.state("ref")).toBe("running");
    expect(audit.filter((line) => line.includes("name=ref") && line.includes(" op=start "))).toHaveLength(1);
  });

  test("`repos` keeps sessions outside it from the adapter", async () => {
    const outside = join(base, "elsewhere");
    await mkdir(outside, { recursive: true });
    const inside = await claudePane();
    const away = await claudePane({ cwd: outside });
    await d.feed.refresh();
    host("scoped", { repos: ["proj"] });
    const dir = join(base, "adapters", "scoped");
    await pollUntil(async () => (await frames(dir)).some((f) => f["kind"] === "snapshot"), "the snapshot");
    const snapshot = (await frames(dir)).find((f) => f["kind"] === "snapshot");
    const keys = (Array.isArray(snapshot?.["sessions"]) ? snapshot["sessions"] : []).map(
      (s: { key?: unknown }) => s.key,
    );
    expect(keys).toContain(inside.key);
    expect(keys).not.toContain(away.key);
    process.kill(away.pid, "SIGKILL");
    process.kill(inside.pid, "SIGKILL");
    await pollUntil(
      async () => (await frames(dir)).some((f) => f["kind"] === "session-gone" && f["key"] === inside.key),
      "the in-scope session-gone",
    );
    expect((await frames(dir)).some((f) => f["key"] === away.key)).toBe(false);
  });
});

describe("tags an adapter sees", () => {
  test("every namespace but another adapter's", () => {
    const tag = { value: "x", at: 1, scope: "conversation" as const };
    expect(
      Object.keys(
        tagsFor("mine", {
          "agent.kind": tag,
          "adapter.mine.ticket": tag,
          "adapter.theirs.ticket": tag,
          "self.name": tag,
        }),
      ),
    ).toEqual(["agent.kind", "adapter.mine.ticket", "self.name"]);
  });
});
