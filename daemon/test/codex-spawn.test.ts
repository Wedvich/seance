import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_STANDING_INSTRUCTION,
  DEFAULT_CODEX_MODEL,
  isAgentSessionId,
  type RepoEntry,
  type SpawnRequest,
} from "@seance/shared";
import { CODEX_RUN_PREFIX } from "../src/agents/panes.ts";
import { SpawnFailure, type SpawnOutcome } from "../src/backend.ts";
import type { ClaudeProcess } from "../src/claude-process.ts";
import { codexSessions } from "../src/codex/sessions.ts";
import type { CodexConfig } from "../src/config.ts";
import { despawnSession } from "../src/despawn.ts";
import { DRAIN_PROMPT } from "../src/drain-ask.ts";
import type { InboxLine } from "../src/message-frame.ts";
import type { SessionInbox } from "../src/messages.ts";
import type { SessionKey } from "../src/claude-process.ts";
import { exec, git } from "../src/exec.ts";
import { scanRepos } from "../src/scan.ts";
import type { CodexState } from "../src/session-events.ts";
import { listClaudeSessions, paneInfo } from "../src/sessions.ts";
import { spawnSession, type SpawnOptions } from "../src/spawn.ts";
import { tmux, tmuxOk } from "../src/tmux.ts";
import {
  makeCodexStub,
  makeGitFixture,
  pollUntil,
  usePrivateTmux,
  type CodexStub,
  type GitFixture,
  type PrivateTmux,
} from "./fixtures.ts";

// Not the defaults, so a value reaching `thread/start` is shown to come from config.
const CONFIG: CodexConfig = { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" };
const PROMPT = "say hello and stop";

let base: string;
let codexHome: string;
let privateTmux: PrivateTmux | undefined;
let fixture: GitFixture;
let stub: CodexStub;
let repos: readonly RepoEntry[];
let opts: SpawnOptions;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-codex-spawn-"));
  privateTmux = usePrivateTmux(base, "codex-spawn");
  process.env["SEANCE_STATE_DIR"] = join(base, "state");
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "claude-config");
  codexHome = join(base, "codex-home");
  await mkdir(codexHome);
  await chmod(codexHome, 0o700);
  const home = join(base, "home");
  await mkdir(home);
  fixture = await makeGitFixture(base);
  stub = await makeCodexStub(join(base, "codex"));
  process.env["SEANCE_CODEX_BIN"] = stub.path;
  repos = await scanRepos([fixture.root]);
  opts = { tmuxSession: "main", waitMs: 10_000, home, codex: { config: CONFIG, home: codexHome } };
});

afterEach(async () => {
  await stub.scenario({});
  await stub.reset();
});

afterAll(async () => {
  await privateTmux?.dispose();
  delete process.env["SEANCE_CODEX_BIN"];
  delete process.env["SEANCE_STATE_DIR"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  await rm(base, { recursive: true, force: true });
});

const codex = (title: string, over: Partial<SpawnRequest> = {}): SpawnRequest => ({
  repo: "myrepo",
  mode: "worktree",
  title,
  prompt: PROMPT,
  agent: "codex",
  ...over,
});

async function windowNames(): Promise<readonly string[]> {
  const out = await tmux(["list-windows", "-a", "-F", "#{window_name}"]);
  return out.stdout.split("\n").filter((line) => line !== "");
}

/**
 * The run dir this test's launch made, read from the `--listen` path the stub server was started with. Never a scan of
 * `/tmp`: another checkout's suite on the same machine makes run dirs under the same prefix at the same time.
 */
async function launchedRunDir(): Promise<string> {
  const listen = (await stub.calls()).find((call) => call.argv[0] === "app-server" && call.argv[1] === "--listen");
  const url = listen?.argv[2] ?? "";
  const dir = url.replace(/^unix:\/\//u, "").replace(/\/s\.sock$/u, "");
  if (!dir.startsWith(CODEX_RUN_PREFIX)) throw new Error(`no run dir in ${url}`);
  return dir;
}

const runDirGone = async (dir: string): Promise<boolean> =>
  lstat(dir).then(
    () => false,
    () => true,
  );

async function paneOf(outcome: SpawnOutcome): Promise<string> {
  if (outcome.handle === undefined) throw new Error("the spawn named no window");
  return (await tmuxOk(["list-panes", "-t", outcome.handle, "-F", "#{pane_id}"])).trim();
}

async function refusal(run: Promise<unknown>): Promise<SpawnFailure> {
  const err = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(err instanceof SpawnFailure)) throw new Error(`expected a SpawnFailure, got ${String(err)}`);
  return err;
}

describe("a Codex spawn (real tmux, real git, stub codex)", () => {
  test("starts the thread itself, seeds its first turn over the socket, and the TUI joins it", async () => {
    await fixture.advanceOrigin();
    const outcome = await spawnSession(codex("Codex Hello"), repos, opts);

    expect(outcome.agent).toBe("codex");
    expect(outcome.registered).toBe(true);
    expect(outcome.path).toEndWith(join(".claude", "worktrees", "codex-hello"));
    const thread = outcome.session ?? "";
    expect(isAgentSessionId(thread)).toBe(true);

    // The daemon made the worktree, at origin's tip after the fetch: Codex has no `--worktree` of its own.
    const head = await git(outcome.path, ["rev-parse", "HEAD"]);
    expect(head.stdout.trim()).toBe((await git(fixture.barePath, ["rev-parse", "main"])).stdout.trim());

    const rpc = await stub.rpc();
    expect(rpc.map((call) => call.method)).toEqual(["initialize", "thread/start", "turn/start"]);
    expect(rpc[1]?.params).toEqual({ cwd: outcome.path, model: DEFAULT_CODEX_MODEL, ...CONFIG });
    expect(rpc[2]?.params).toMatchObject({ threadId: thread, input: [{ type: "text" }] });
    expect(JSON.stringify(rpc[2]?.params)).toContain(PROMPT);
    // Codex's own words: no AskUserQuestion, and AGENTS.md beside CLAUDE.md (autonomy.ts).
    expect(JSON.stringify(rpc[2]?.params)).toContain("end your turn with the question stated");
    expect(JSON.stringify(rpc[2]?.params)).not.toContain("AskUserQuestion");

    // The seed reaches Codex as the turn's input only: never argv, never the run dir.
    const calls = await stub.calls();
    for (const call of calls) expect(call.argv.join(" ")).not.toContain(PROMPT);
    expect(calls.map((call) => call.codexHome)).toEqual([codexHome, codexHome]);
    const [server, tui] = calls.map((call) => call.argv);
    const runDir = await launchedRunDir();
    expect(server).toEqual(["app-server", "--listen", `unix://${runDir}/s.sock`]);
    expect(tui).toEqual(["resume", "--remote", `unix://${runDir}/s.sock`, "--", thread]);
    expect(((await lstat(runDir)).mode & 0o777).toString(8)).toBe("700");
    expect((await Bun.file(join(runDir, "thread")).text()).trim()).toBe(thread);
    expect(await Bun.file(join(runDir, "run.sh")).text()).not.toContain(PROMPT);

    // Recognised by its start mark alone, and listed.
    const pane = await paneOf(outcome);
    expect((await paneInfo(pane))?.agent).toBe("codex");
    const listed = await listClaudeSessions(repos);
    expect(listed.some((entry) => entry.window === "Codex Hello")).toBe(true);

    // Idle, no turn to interrupt: the pane is killed, and its shell ends the server and removes the run dir.
    const closed = await despawnSession(pane, { force: false, graceMs: 200, reapWaitMs: 2_000 });
    expect(closed).toEqual({ window: "Codex Hello", outcome: "killed", agent: "codex" });
    await pollUntil(() => runDirGone(runDir), "the run dir to go");
  });

  test("a window closed by hand ends the TUI, which outlives a hangup, and the server, and removes the run dir", async () => {
    const outcome = await spawnSession(codex("Closed By Hand"), repos, opts);
    const runDir = await launchedRunDir();
    if (outcome.handle === undefined) throw new Error("no window");
    const sessionProcesses = async (): Promise<string> =>
      (await exec(["pgrep", "-f", `${runDir}/s.sock`])).stdout.trim();
    expect(await sessionProcesses()).not.toBe("");
    // A bare `kill-window`: the pane's hangup alone, none of despawn's escalation.
    await tmuxOk(["kill-window", "-t", outcome.handle]);
    await pollUntil(async () => (await sessionProcesses()) === "", "the TUI and the server to end");
    await pollUntil(() => runDirGone(runDir), "the run dir to go");
  });

  test("an effort is sent with the first turn only when set; a model only as asked", async () => {
    const outcome = await spawnSession(codex("Codex Effort", { effort: "high", model: "gpt-6.2" }), repos, opts);
    const rpc = await stub.rpc();
    expect(rpc[1]?.params).toMatchObject({ model: "gpt-6.2" });
    expect(rpc[2]?.params).toMatchObject({ effort: "high" });
    await despawnSession(await paneOf(outcome), { force: true });
  });

  test("refuses before any worktree or pane: no codex block, no prompt, effort max", async () => {
    const before = await windowNames();
    const trees = await readdir(join(fixture.repoPath, ".claude", "worktrees")).catch(() => []);
    const noCodex: SpawnOptions = { tmuxSession: opts.tmuxSession, waitMs: opts.waitMs, home: opts.home };
    expect((await refusal(spawnSession(codex("No Block"), repos, noCodex))).code).toBe("launch_error");
    expect((await refusal(spawnSession(codex("No Prompt", { prompt: "" }), repos, opts))).code).toBe("launch_error");
    expect((await refusal(spawnSession(codex("Max", { effort: "max" }), repos, opts))).code).toBe("launch_error");
    expect(await windowNames()).toEqual(before);
    expect(await readdir(join(fixture.repoPath, ".claude", "worktrees")).catch(() => [])).toEqual(trees);
    expect(await stub.calls()).toEqual([]);
  });

  test("a server whose socket sits in a directory not its own 0700 is never dialled", async () => {
    await stub.scenario({ listenDirMode: 0o755 });
    const err = await refusal(spawnSession(codex("Loose Dir"), repos, opts));
    expect(err.code).toBe("launch_error");
    expect(await stub.rpc()).toEqual([]);
    expect(await windowNames()).not.toContain("Loose Dir");
    const runDir = await launchedRunDir();
    await pollUntil(() => runDirGone(runDir), "the run dir to go");
  });

  test("a server answering for another home, or refusing the thread, ends the window", async () => {
    await stub.scenario({ codexHome: join(base, "elsewhere") });
    expect((await refusal(spawnSession(codex("Wrong Home"), repos, opts))).code).toBe("launch_error");
    expect((await stub.rpc()).map((call) => call.method)).toEqual(["initialize"]);
    await stub.reset();
    await stub.scenario({ threadStartError: -32600 });
    expect((await refusal(spawnSession(codex("No Thread"), repos, opts))).code).toBe("launch_error");
    expect((await stub.rpc()).map((call) => call.method)).toEqual(["initialize", "thread/start"]);
    const names = await windowNames();
    expect(names).not.toContain("Wrong Home");
    expect(names).not.toContain("No Thread");
  });

  test("a server that dies before it listens is the session dying", async () => {
    await stub.scenario({ listenExit: 3 });
    expect((await refusal(spawnSession(codex("Dies"), repos, opts))).code).toBe("claude_died");
    expect(await windowNames()).not.toContain("Dies");
  });
});

interface Heard {
  readonly pane: string;
  readonly thread: string;
  readonly process: ClaudeProcess | null;
  readonly state: CodexState;
}

describe("a Codex session's life: its server's notifications (codex/sessions.ts, docs/codex.md item 7)", () => {
  const heard: Heard[] = [];
  const readings: unknown[] = [];
  /** Each pane's inbox as `Messages.attachCodex` is handed it (messages.test.ts covers what messaging does with it). */
  const inboxes = new Map<string, SessionInbox>();
  const inboxSessions = new Map<string, SessionKey | null>();
  const configure = async (): Promise<void> => {
    codexSessions.configure({
      sink: {
        state: async (pane, thread, process, state) => {
          heard.push({ pane: pane.id, thread, process, state });
        },
        rateLimits: (value) => void readings.push(value),
      },
      home: await realpath(codexHome),
      launchSession: () => undefined,
      inbox: (pane, session, inbox) => {
        inboxes.set(pane.id, inbox);
        inboxSessions.set(pane.id, session);
      },
    });
  };
  const states = (pane: string): readonly CodexState[] => heard.filter((h) => h.pane === pane).map((h) => h.state);
  const methods = async (): Promise<readonly string[]> => (await stub.rpc()).map((call) => call.method);

  beforeEach(async () => {
    heard.length = 0;
    readings.length = 0;
    inboxes.clear();
    inboxSessions.clear();
    await configure();
  });

  afterEach(() => {
    codexSessions.stop();
  });

  test("a turn reads busy, then idle and its end; another thread's approval is dropped; the login's reading follows", async () => {
    const reading = { rateLimits: { limitId: "codex", primary: { usedPercent: 9 } }, rateLimitsByLimitId: null };
    await stub.scenario({ turn: "complete", rateLimits: { result: reading } });
    const outcome = await spawnSession(codex("Codex Turn"), repos, opts);
    const pane = await paneOf(outcome);
    await pollUntil(() => states(pane).some((s) => s.turnEnded === true), "the turn's end", 10_000);
    expect(states(pane)).toEqual([{ state: "busy" }, { state: "idle" }, { state: "idle", turnEnded: true }]);
    expect(heard.every((h) => h.thread === outcome.session)).toBe(true);
    // Its server, as `seance mcp` from inside the pane binds it (`sessionOf`'s innermost `codex`).
    expect(heard[0]?.process?.pid).toBeGreaterThan(1);
    await pollUntil(() => readings.length === 1, "the session's own rate-limit read");
    expect(readings).toEqual([reading]);
    expect(await methods()).toContain("account/rateLimits/read");
    await despawnSession(pane, { force: true });
  });

  test("an approval is the pane's needs-input, never answered; a close interrupts the turn before killing the pane", async () => {
    await stub.scenario({ turn: "approval" });
    const outcome = await spawnSession(codex("Codex Approval"), repos, opts);
    const pane = await paneOf(outcome);
    await pollUntil(() => states(pane).some((s) => s.state === "needs-input"), "the approval's wait", 10_000);
    expect(states(pane).at(-1)).toEqual({ state: "needs-input", reason: "permission" });
    const closed = await despawnSession(pane, { force: false, graceMs: 2_000, reapWaitMs: 2_000 });
    expect(closed).toMatchObject({ window: "Codex Approval", outcome: "killed", agent: "codex" });
    const rpc = await stub.rpc();
    expect(rpc.find((call) => call.method === "turn/interrupt")?.params).toEqual({
      threadId: outcome.session,
      turnId: "turn-1",
    });
    // The server's request carries an id: the daemon read it as nothing and sent no response.
    expect(rpc.map((call) => call.method)).not.toContain("(response)");
    await pollUntil(
      () => states(pane).some((s) => s.turnEnded === true),
      "the interrupted turn's end to reach the session-event step",
    );
  });

  test("the drain's interrupt and prompt go over the connection, only under the pane's pid and only when the turn allows", async () => {
    await stub.scenario({ turn: "hold" });
    const outcome = await spawnSession(codex("Codex Drain"), repos, opts);
    const paneId = await paneOf(outcome);
    const pid = Number((await tmuxOk(["display-message", "-p", "-t", paneId, "#{pane_pid}"])).trim());
    // The stub announces the rate limits after `turn/started`, and messages are read in order: once the read they
    // prompted has answered, the session holds the running turn's id (the busy state alone can come before it).
    await pollUntil(() => readings.length > 0, "the turn's start", 10_000);
    const sent = async (method: string): Promise<number> => (await methods()).filter((m) => m === method).length;

    // A pane id tmux reused, or one this process holds no session for, gets nothing.
    expect(await codexSessions.interruptTurn({ paneId, pid: pid + 1 })).toBe(false);
    expect(await codexSessions.interruptTurn({ paneId: "%999", pid })).toBe(false);
    // No new turn over a running one.
    const starts = await sent("turn/start");
    expect(await codexSessions.drainTurn({ paneId, pid })).toBe(false);
    expect(await sent("turn/interrupt")).toBe(0);
    expect(await sent("turn/start")).toBe(starts);

    expect(await codexSessions.interruptTurn({ paneId, pid })).toBe(true);
    await pollUntil(() => states(paneId).some((s) => s.turnEnded === true), "the interrupted turn's end", 10_000);
    // Nothing left to interrupt.
    expect(await codexSessions.interruptTurn({ paneId, pid })).toBe(false);

    expect(await codexSessions.drainTurn({ paneId, pid })).toBe(true);
    const drain = (await stub.rpc()).findLast((call) => call.method === "turn/start");
    expect(drain?.params).toEqual({
      threadId: outcome.session,
      input: [{ type: "text", text: DRAIN_PROMPT, text_elements: [] }],
    });
    await despawnSession(paneId, { force: true });
  });

  test("a daemon restart re-joins a running session: its thread resumed, its status and running turn re-read", async () => {
    await stub.scenario({ turn: "hold" });
    const outcome = await spawnSession(codex("Codex Rejoin"), repos, opts);
    const pane = await paneOf(outcome);
    await pollUntil(() => states(pane).length > 0, "the turn's start", 10_000);
    expect(codexSessions.holds(pane)).toBe(true);

    codexSessions.stop();
    expect(codexSessions.holds(pane)).toBe(false);
    heard.length = 0;
    await configure();
    await codexSessions.reconnectAll();
    expect(codexSessions.holds(pane)).toBe(true);
    expect(states(pane)).toEqual([{ state: "busy" }]);
    const rpc = await stub.rpc();
    expect(rpc.find((call) => call.method === "thread/resume")?.params).toEqual({
      threadId: outcome.session,
      excludeTurns: true,
    });
    expect(rpc.map((call) => call.method)).toContain("thread/turns/list");
    // Twice is one: a held pane is not dialled again.
    await codexSessions.reconnectAll();
    expect((await methods()).filter((m) => m === "thread/resume")).toHaveLength(1);

    // The turn id came back with it: the close still interrupts it.
    await despawnSession(pane, { force: false, graceMs: 2_000, reapWaitMs: 2_000 });
    expect((await stub.rpc()).findLast((call) => call.method === "turn/interrupt")?.params).toEqual({
      threadId: outcome.session,
      turnId: "turn-1",
    });
    // The pane's death, not the connection's loss, ends the session here.
    await pollUntil(() => !codexSessions.holds(pane), "the dead pane's session to go", 10_000);
  });

  const inboxLine = (messageKind: InboxLine["messageKind"], push: string): InboxLine => ({
    v: 1,
    id: crypto.randomUUID(),
    messageKind,
    push,
  });
  const inputOf = (params: unknown): string => JSON.stringify(params);

  test("messages (docs/codex.md item 12): a tasked thread carries the standing instruction; an idle session's note waits, a request starts a turn carrying it", async () => {
    await stub.scenario({ turn: "complete" });
    const outcome = await spawnSession(codex("Codex Idle Msg", { taskId: "task-idle-msg" }), repos, opts);
    const pane = await paneOf(outcome);
    const start = (await stub.rpc()).find((call) => call.method === "thread/start");
    expect(start?.params).toMatchObject({ developerInstructions: CODEX_STANDING_INSTRUCTION });
    await pollUntil(() => states(pane).some((s) => s.turnEnded === true), "the first turn's end", 10_000);
    const inbox = inboxes.get(pane);
    if (inbox === undefined) throw new Error("no inbox registered for the held session");
    // Bound to the pane's server, the process a peer in the pane binds to: a reply by handle finds this inbox.
    const server = heard[0]?.process;
    expect(server).not.toBeNull();
    expect(inboxSessions.get(pane)).toBe(server?.key ?? "none");

    expect(inbox.take(inboxLine("note", "fyi: main moved"))).toBe(true);
    expect(inbox.take(inboxLine("request", "rebase onto main"))).toBe(true);
    await pollUntil(
      async () => (await methods()).filter((m) => m === "turn/start").length === 2,
      "the request's turn/start",
    );
    const turns = (await stub.rpc()).filter((call) => call.method === "turn/start");
    expect(inputOf(turns[1]?.params)).toContain("fyi: main moved");
    expect(inputOf(turns[1]?.params)).toContain("rebase onto main");
    expect(await methods()).not.toContain("turn/steer");
    await despawnSession(pane, { force: true });
    // The connection's end closes the inbox: messaging's grace holds what comes next.
    await pollUntil(() => inbox.gone.aborted, "the inbox to close with the session");
  });

  test("messages: into a busy session every kind is steered into the running turn, and an untasked thread has no instruction", async () => {
    await stub.scenario({ turn: "hold" });
    const outcome = await spawnSession(codex("Codex Busy Msg"), repos, opts);
    const pane = await paneOf(outcome);
    expect((await stub.rpc()).find((call) => call.method === "thread/start")?.params).not.toHaveProperty(
      "developerInstructions",
    );
    await pollUntil(() => states(pane).some((s) => s.state === "busy"), "the turn's start", 10_000);
    const inbox = inboxes.get(pane);
    if (inbox === undefined) throw new Error("no inbox registered for the held session");
    expect(inbox.take(inboxLine("note", "a note mid-turn"))).toBe(true);
    expect(inbox.take(inboxLine("question", "which branch?"))).toBe(true);
    await pollUntil(async () => (await methods()).filter((m) => m === "turn/steer").length === 2, "both steers");
    const steers = (await stub.rpc()).filter((call) => call.method === "turn/steer");
    for (const steer of steers) {
      expect(steer.params).toMatchObject({ threadId: outcome.session, expectedTurnId: "turn-1" });
    }
    expect(inputOf(steers[0]?.params)).toContain("a note mid-turn");
    expect((await methods()).filter((m) => m === "turn/start")).toHaveLength(1);
    await despawnSession(pane, { force: false, graceMs: 2_000, reapWaitMs: 2_000 });
  });
});

describe("a Codex continuation (docs/codex.md item 10)", () => {
  let seq = 0;
  const continuing = (
    session: string,
    path: string,
    over: Partial<SpawnRequest> = {},
    exit?: number,
  ): Promise<SpawnOutcome> => {
    seq += 1;
    return spawnSession(
      {
        repo: "myrepo",
        mode: "continue",
        title: `Codex Cont ${seq}`,
        taskId: `cx-cont-${seq}`,
        continues: "cx-old",
        client: "scheduler",
        agent: "codex",
        autonomy: "auto",
        ...over,
      },
      repos,
      opts,
      { path, session, agent: "codex", ...(exit === undefined ? {} : { exit }) },
    );
  };

  /** A Codex launch, then its pane closed: the worktree and the thread its ledger would note. */
  async function ended(title: string): Promise<{ readonly path: string; readonly thread: string }> {
    const outcome = await spawnSession(codex(title, { taskId: `cx-first-${seq}-${title.length}` }), repos, opts);
    await despawnSession(await paneOf(outcome), { force: true });
    await pollUntil(async () => !(await windowNames()).includes(title), "the first session's window to go");
    await stub.reset();
    return { path: await realpath(outcome.path), thread: outcome.session ?? "" };
  }

  test("resumes the noted thread on a fresh server, under config.json, seeds a turn, and the TUI joins it", async () => {
    const first = await ended("Codex First");
    const outcome = await continuing(first.thread, first.path, { prompt: "carry on", model: "gpt-6.2" }, 137);

    expect(outcome.agent).toBe("codex");
    expect(outcome.registered).toBe(true);
    expect(outcome.path).toBe(first.path);
    // The ledger notes the same thread again, so a continuation of this one resumes it too.
    expect(outcome.session).toBe(first.thread);

    const rpc = await stub.rpc();
    expect(rpc.map((call) => call.method)).toEqual(["initialize", "thread/resume", "turn/start"]);
    expect(rpc[1]?.params).toEqual({
      threadId: first.thread,
      cwd: first.path,
      model: "gpt-6.2",
      ...CONFIG,
      excludeTurns: true,
    });
    const seed = JSON.stringify(rpc[2]?.params);
    expect(rpc[2]?.params).toMatchObject({ threadId: first.thread });
    expect(seed).toContain("resumed by séance in the same git worktree");
    expect(seed).toContain("only codex itself");
    expect(seed).toContain("From the user: carry on");
    const tui = (await stub.calls()).map((call) => call.argv).find((argv) => argv[0] === "resume");
    expect(tui?.at(-1)).toBe(first.thread);
    await despawnSession(await paneOf(outcome), { force: true });
  });

  test("a continuation with no note still seeds its turn: the preamble says why it was resumed", async () => {
    const first = await ended("Codex Noteless");
    const outcome = await continuing(first.thread, first.path);
    const seed = JSON.stringify((await stub.rpc())[2]?.params);
    expect(seed).toContain("cancelled from séance");
    expect(seed).not.toContain("From the user");
    await despawnSession(await paneOf(outcome), { force: true });
  });

  test("a thread the home's store no longer holds is not_continuable, and the window goes", async () => {
    const first = await ended("Codex Lost");
    await stub.scenario({ resumeError: -32600 });
    const err = await refusal(continuing(first.thread, first.path, { title: "Codex Lost Cont" }));
    expect(err.code).toBe("not_continuable");
    expect((await stub.rpc()).map((call) => call.method)).toEqual(["initialize", "thread/resume"]);
    expect(await windowNames()).not.toContain("Codex Lost Cont");
  });

  test("a noted id that is no thread id is refused before any pane", async () => {
    const first = await ended("Codex Bad Id");
    const before = await windowNames();
    const err = await refusal(continuing("not-a-thread", first.path));
    expect(err.code).toBe("not_continuable");
    expect(await windowNames()).toEqual(before);
    expect(await stub.calls()).toEqual([]);
  });
});
