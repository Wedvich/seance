import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CODEX_MODEL, isAgentSessionId, type RepoEntry, type SpawnRequest } from "@seance/shared";
import { CODEX_RUN_PREFIX } from "../src/agents/panes.ts";
import { SpawnFailure, type SpawnOutcome } from "../src/backend.ts";
import type { ClaudeProcess } from "../src/claude-process.ts";
import { codexSessions } from "../src/codex/sessions.ts";
import type { CodexConfig } from "../src/config.ts";
import { despawnSession } from "../src/despawn.ts";
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

async function runDirs(): Promise<readonly string[]> {
  const prefix = CODEX_RUN_PREFIX.slice("/tmp/".length);
  return (await readdir("/tmp")).filter((name) => name.startsWith(prefix)).map((name) => join("/tmp", name));
}

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
    const before = new Set(await runDirs());
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
    const runDir = (await runDirs()).find((dir) => !before.has(dir));
    if (runDir === undefined) throw new Error("no run dir");
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
    await pollUntil(async () => !(await runDirs()).includes(runDir), "the run dir to go");
  });

  test("a window closed by hand ends the TUI, which outlives a hangup, and the server, and removes the run dir", async () => {
    const before = new Set(await runDirs());
    const outcome = await spawnSession(codex("Closed By Hand"), repos, opts);
    const runDir = (await runDirs()).find((dir) => !before.has(dir));
    if (runDir === undefined || outcome.handle === undefined) throw new Error("no run dir or window");
    const sessionProcesses = async (): Promise<string> =>
      (await exec(["pgrep", "-f", `${runDir}/s.sock`])).stdout.trim();
    expect(await sessionProcesses()).not.toBe("");
    // A bare `kill-window`: the pane's hangup alone, none of despawn's escalation.
    await tmuxOk(["kill-window", "-t", outcome.handle]);
    await pollUntil(async () => (await sessionProcesses()) === "", "the TUI and the server to end");
    await pollUntil(async () => !(await runDirs()).includes(runDir), "the run dir to go");
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
    const before = await runDirs();
    const err = await refusal(spawnSession(codex("Loose Dir"), repos, opts));
    expect(err.code).toBe("launch_error");
    expect(await stub.rpc()).toEqual([]);
    expect(await windowNames()).not.toContain("Loose Dir");
    await pollUntil(async () => (await runDirs()).length === before.length, "the run dir to go");
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
    });
  };
  const states = (pane: string): readonly CodexState[] => heard.filter((h) => h.pane === pane).map((h) => h.state);
  const methods = async (): Promise<readonly string[]> => (await stub.rpc()).map((call) => call.method);

  beforeEach(async () => {
    heard.length = 0;
    readings.length = 0;
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
});
