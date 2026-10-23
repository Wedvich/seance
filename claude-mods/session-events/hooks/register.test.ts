import { describe, expect, mock, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On, SessionEndReason, ToolCheckDecision } from "claude-code";
import { daemonMain, prUrlFrom } from "./register.ts";

type Sent = { readonly argv: readonly string[]; readonly report: unknown }[];

/**
 * Records every `session-event` run the mod makes, answering as the CLI does: silently.
 * `env` is the session's: in a tmux pane unless a test says otherwise.
 */
function record(
  on: On,
  {
    fail = false,
    env = { TMUX_PANE: "%7" },
    gate,
  }: {
    readonly fail?: boolean;
    readonly env?: Readonly<Record<string, string>>;
    /** Holds every run (as a wedged daemon would) until it resolves. */
    readonly gate?: Promise<void>;
  } = {},
): Sent {
  const sent: Sent = [];
  mock.env(on, env);
  // The engine's own step beneath each lifecycle event; the mod only observes, so its echo does.
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("session.end", (_$, e) => ({ sessionId: e.sessionId }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("process.run", async (_$, e) => {
    sent.push({ argv: [...e.argv], report: JSON.parse(e.init?.stdin ?? "null") });
    await gate;
    if (fail) throw new Error("spawn bun ENOENT");
    return { value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
  });
  return sent;
}

/**
 * Core's part of a tool call: decides it (`tool.check`, under the call's own id, as the
 * engine raises it inside the call) with `verdict`, then runs it, printing `stdout`.
 * The kit raises a check of its own first, with nobody to ask, where an ask is a deny:
 * that one is allowed so the call reaches the check this raises.
 */
function tools(
  $: Engine,
  on: On,
  {
    verdict = "allow",
    approver = "person",
    stdout = "",
    hold,
    fail = () => false,
    denied = false,
  }: {
    readonly verdict?: ToolCheckDecision;
    readonly approver?: "person" | "host" | undefined;
    readonly stdout?: string;
    /** Keeps a call running (its dialog open) until the promise this returns for its id resolves. */
    readonly hold?: (id: string | undefined) => Promise<void> | undefined;
    /** Whether the call crashes, asked as it runs. */
    readonly fail?: () => boolean;
    /** The person answers the dialog with no: the call comes back denied. */
    readonly denied?: boolean;
  } = {},
): void {
  on("tool.check", (_$, e) => ({ decision: e.approver === undefined ? "allow" : verdict }));
  on("tool.call", async (_$, e) => {
    await $.tool.check({
      tool: e.tool,
      input: {},
      ...(e.tool_use_id === undefined ? {} : { tool_use_id: e.tool_use_id }),
      ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
      ...(approver === undefined ? {} : { approver }),
    });
    await hold?.(e.tool_use_id);
    if (fail()) throw new Error("tool crashed");
    if (denied) return { deny: "The user denied this call" };
    return { result: { stdout, stderr: "", interrupted: false } };
  });
}

/** A promise settled by hand, to hold a call or a daemon while the test watches. */
function latch(): { readonly release: () => void; readonly held: Promise<void> } {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, held };
}

/** The sends are unawaited by design, so a test waits for them rather than for the hook. */
async function settled(sent: Sent, count: number): Promise<void> {
  for (let i = 0; i < 200 && sent.length < count; i++) {
    // oxlint-disable-next-line no-await-in-loop -- a poll, one wait at a time
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

const turn = { turnId: "turn-1" };
const answered = { ...turn, answer: "done", durationMs: 10, isAborted: false, reason: "answer" } as const;

function end($: Engine, reason: SessionEndReason): Promise<unknown> {
  return $.session.end({ reason, sessionId: "s1", resume: { id: "s1" } });
}

describe("prUrlFrom", () => {
  test("takes the URL gh pr create printed", () => {
    const out = "Creating pull request\nhttps://github.com/acme/app/pull/12\n";
    expect(prUrlFrom("gh pr create --fill", out)).toBe("https://github.com/acme/app/pull/12");
  });

  test("ignores other commands, and anything that is not an https PR URL", () => {
    expect(prUrlFrom("gh pr view 12", "https://github.com/a/b/pull/12")).toBeNull();
    expect(prUrlFrom("gh pr create", "http://github.com/acme/app/pull/12")).toBeNull();
    expect(prUrlFrom("gh pr create", "no url here")).toBeNull();
  });
});

describe("daemonMain", () => {
  test("tolerates a trailing slash on the plugin folder", () => {
    expect(daemonMain("/r/seance/claude-mods/session-events/")).toBe("/r/seance/daemon/src/main.ts");
  });
});

describe("reports", () => {
  test("a session's life sends its states through this checkout's daemon CLI, never naming a session", async ($, on) => {
    const sent = record(on);
    await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
    await $.turn.start({ ...turn, text: "hi" });
    await $.turn.complete(answered);
    await end($, "prompt_input_exit");
    await settled(sent, 4);
    // The checkout the mod is read from, never a name on PATH.
    const main = sent[0]?.argv[1] ?? "";
    expect(main.endsWith("/daemon/src/main.ts")).toBe(true);
    expect(sent.map((s) => s.argv)).toEqual(Array.from({ length: 4 }, () => ["bun", main, "session-event"]));
    expect(sent.map((s) => s.report)).toEqual([
      { state: "idle" },
      { state: "busy" },
      { state: "idle" },
      { state: "ended" },
    ]);
  });

  test("a subagent's turns say nothing: the main loop's turn is still running", async ($, on) => {
    const sent = record(on);
    await $.turn.start({ ...turn, text: "look", agentId: "a1" });
    await $.turn.complete({ ...answered, agentId: "a1" });
    // A non-event cannot be polled for: wait as long as a send takes to land above.
    await settled(sent, 1);
    expect(sent).toEqual([]);
  });

  test("a call put to a person needs input until it settles", async ($, on) => {
    const sent = record(on);
    tools($, on, { verdict: "ask" });
    await $.tool.call({ tool: "Bash", command: "rm -r build" });
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }, { state: "busy" }]);
  });

  test("an ask a host answers, or a query, says nothing", async ($, on) => {
    const sent = record(on);
    tools($, on, { verdict: "ask", approver: "host" });
    await $.tool.call({ tool: "Bash", command: "rm -r build" });
    await $.tool.check({ tool: "Bash", input: { command: "rm -r build" } });
    // A non-event cannot be polled for: wait as long as a send takes to land above.
    await settled(sent, 1);
    expect(sent).toEqual([]);
  });

  test("an allowed call says nothing", async ($, on) => {
    const sent = record(on);
    tools($, on, { verdict: "allow" });
    await $.tool.call({ tool: "Bash", command: "ls" });
    // A non-event cannot be polled for: wait as long as a send takes to land above.
    await settled(sent, 1);
    expect(sent).toEqual([]);
  });

  test("a question to the person needs input until it is answered", async ($, on) => {
    const sent = record(on);
    on("tool.call", () => ({ result: { answers: {} } }));
    await $.tool.call({ tool: "AskUserQuestion", questions: [] });
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }, { state: "busy" }]);
  });

  test("a PR opened through gh is reported with its URL", async ($, on) => {
    const sent = record(on);
    tools($, on, { stdout: "https://github.com/acme/app/pull/12\n" });
    await $.tool.call({ tool: "Bash", command: "gh pr create --fill" });
    await $.tool.call({ tool: "Bash", command: "gh pr view 12" });
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "busy", prUrl: "https://github.com/acme/app/pull/12" }]);
  });

  test("a tool's error reaches the session as the tool gave it, and the turn goes on", async ($, on) => {
    const sent = record(on);
    on("tool.check", (_$, e) => ({ decision: e.approver === undefined ? "allow" : "ask" }));
    on("tool.call", async (_$, e) => {
      await $.tool.check({ tool: e.tool, input: {}, tool_use_id: e.tool_use_id ?? "", approver: "person" });
      return { isError: true, result: "exit 1", text: "gh: not logged in" };
    });
    const ran = await $.tool.call({ tool: "Bash", command: "gh pr create" });
    expect(ran).toMatchObject({ isError: true, text: "gh: not logged in" });
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }, { state: "busy" }]);
  });

  test("a query a person would answer, with no tool_use_id, shows no dialog", async ($, on) => {
    const sent = record(on);
    on("tool.check", (_$, e) => ({ decision: e.approver === undefined ? "allow" : "ask" }));
    await $.tool.check({ tool: "Bash", input: { command: "rm -r build" }, approver: "person" });
    // A non-event cannot be polled for: wait as long as a send takes to land above.
    await settled(sent, 1);
    expect(sent).toEqual([]);
  });

  test("a denied call says nothing", async ($, on) => {
    const sent = record(on);
    tools($, on, { verdict: "deny" });
    await $.tool.call({ tool: "Bash", command: "rm -r build" });
    // A non-event cannot be polled for: wait as long as a send takes to land above.
    await settled(sent, 1);
    expect(sent).toEqual([]);
  });

  test("busy waits for the last of overlapping prompts", async ($, on) => {
    const sent = record(on);
    const first = latch();
    const second = latch();
    const holds = [first.held, second.held];
    let started = 0;
    tools($, on, { verdict: "ask", hold: () => holds[started++] });
    const a = $.tool.call({ tool: "Bash", command: "one" });
    const b = $.tool.call({ tool: "Bash", command: "two" });
    await settled(sent, 1);
    first.release();
    await a;
    // A non-event cannot be polled for: wait as long as a send takes to land above.
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }]);
    second.release();
    await b;
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }, { state: "busy" }]);
  });

  test("an open question keeps a settled prompt from reporting busy", async ($, on) => {
    const sent = record(on);
    const question = latch();
    const prompt = latch();
    on("tool.check", (_$, e) => ({ decision: e.approver === undefined ? "allow" : "ask" }));
    on("tool.call", async (_$, e) => {
      await $.tool.check({
        tool: e.tool,
        input: {},
        ...(e.tool_use_id === undefined ? {} : { tool_use_id: e.tool_use_id }),
        approver: "person",
      });
      await (e.tool === "AskUserQuestion" ? question.held : prompt.held);
      return e.tool === "AskUserQuestion" ? { result: { answers: {} } } : { result: { stdout: "" } };
    });
    const q = $.tool.call({ tool: "AskUserQuestion", questions: [] });
    const b = $.tool.call({ tool: "Bash", command: "x" });
    prompt.release();
    await b;
    // A non-event cannot be polled for: wait as long as a send takes to land above.
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }]);
    question.release();
    await q;
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }, { state: "busy" }]);
  });

  test("a question core also checked reports needs input once", async ($, on) => {
    const sent = record(on);
    tools($, on, { verdict: "ask" });
    await $.tool.call({ tool: "AskUserQuestion", questions: [] });
    await settled(sent, 3);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }, { state: "busy" }]);
  });

  test("the main loop's turn ending leaves a subagent's open prompt standing", async ($, on) => {
    const sent = record(on);
    const dialog = latch();
    tools($, on, { verdict: "ask", hold: () => dialog.held });
    const call = $.tool.call({ tool: "Bash", command: "x", agentId: "a1" });
    await settled(sent, 1);
    await $.turn.complete(answered);
    // A non-event cannot be polled for: wait as long as a send takes to land above.
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }]);
    dialog.release();
    await call;
    // The turn already ended, so the dialog closing returns to idle, not busy.
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }, { state: "idle" }]);
  });

  test("a call that rejects after an ask is forgotten, and its error passes up", async ($, on) => {
    const sent = record(on);
    let crashing = true;
    tools($, on, { verdict: "ask", fail: () => crashing });
    // The kit skips a throwing bottom hook, so `next` rejects with its own "no implementation": that rejection is what is under test.
    await expect($.tool.call({ tool: "Bash", command: "x" })).rejects.toThrow();
    // The rejection resumes the session.
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }, { state: "busy" }]);
    // A leaked entry would swallow this call's busy.
    crashing = false;
    await $.tool.call({ tool: "Bash", command: "y" });
    await settled(sent, 4);
    expect(sent.map((s) => s.report)).toEqual([
      { state: "needs-input" },
      { state: "busy" },
      { state: "needs-input" },
      { state: "busy" },
    ]);
  });

  test("a rejection that empties the set resumes, to idle once the turn ended", async ($, on) => {
    const sent = record(on);
    const dialog = latch();
    tools($, on, { verdict: "ask", hold: () => dialog.held, fail: () => true });
    const call = $.tool.call({ tool: "Bash", command: "x", agentId: "a1" });
    await settled(sent, 1);
    await $.turn.complete(answered);
    dialog.release();
    await expect(call).rejects.toThrow();
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }, { state: "idle" }]);
  });

  test("a person denying the call resumes", async ($, on) => {
    const sent = record(on);
    tools($, on, { verdict: "ask", denied: true });
    await $.tool.call({ tool: "Bash", command: "rm -r build" });
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }, { state: "busy" }]);
  });

  test("a new prompt drops dialogs that never settled", async ($, on) => {
    const sent = record(on);
    const stuck = latch();
    let started = 0;
    tools($, on, { verdict: "ask", hold: () => (started++ === 0 ? stuck.held : undefined) });
    const call = $.tool.call({ tool: "Bash", command: "x" });
    await settled(sent, 1);
    await $.turn.start({ ...turn, text: "carry on" });
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }, { state: "busy" }]);
    // A leaked entry would still be outstanding here and swallow this call's busy.
    await $.tool.call({ tool: "Bash", command: "y" });
    await settled(sent, 4);
    expect(sent.map((s) => s.report)).toEqual([
      { state: "needs-input" },
      { state: "busy" },
      { state: "needs-input" },
      { state: "busy" },
    ]);
    stuck.release();
    await call;
  });

  test("a continuation turn with no typed prompt leaves a subagent's dialog standing", async ($, on) => {
    const sent = record(on);
    const dialog = latch();
    tools($, on, { verdict: "ask", hold: () => dialog.held });
    const call = $.tool.call({ tool: "Bash", command: "x", agentId: "a1" });
    await settled(sent, 1);
    await $.turn.start({ ...turn, text: "" });
    // A non-event cannot be polled for: wait as long as a send takes to land above.
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }]);
    dialog.release();
    await call;
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }, { state: "busy" }]);
  });

  test("the main loop's turn ending drops its own dialog that never settled", async ($, on) => {
    const sent = record(on);
    const stuck = latch();
    tools($, on, { verdict: "ask", hold: () => stuck.held });
    const call = $.tool.call({ tool: "Bash", command: "x" });
    await settled(sent, 1);
    await $.turn.complete(answered);
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }, { state: "idle" }]);
    stuck.release();
    await call;
  });

  test("a subagent's activity after the main turn ended resumes to idle", async ($, on) => {
    const sent = record(on);
    tools($, on, { stdout: "https://github.com/acme/app/pull/12\n" });
    await $.turn.start({ ...turn, text: "hi" });
    await $.turn.complete(answered);
    await $.tool.call({ tool: "Bash", command: "gh pr create", agentId: "a1" });
    await settled(sent, 3);
    expect(sent.map((s) => s.report)).toEqual([
      { state: "busy" },
      { state: "idle" },
      { state: "idle", prUrl: "https://github.com/acme/app/pull/12" },
    ]);
  });

  test("a PR found while a dialog is open goes out with needs-input, which the daemon needs", async ($, on) => {
    const sent = record(on);
    const dialog = latch();
    let started = 0;
    tools($, on, {
      verdict: "ask",
      stdout: "https://github.com/acme/app/pull/12\n",
      hold: () => (started++ === 0 ? dialog.held : undefined),
    });
    const first = $.tool.call({ tool: "Bash", command: "x", agentId: "a1" });
    await settled(sent, 1);
    await $.tool.call({ tool: "Bash", command: "gh pr create" });
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([
      { state: "needs-input" },
      { state: "needs-input", prUrl: "https://github.com/acme/app/pull/12" },
    ]);
    dialog.release();
    await first;
  });

  test("a result of an unknown shape still reports busy", async ($, on) => {
    const sent = record(on);
    on("tool.check", (_$, e) => ({ decision: e.approver === undefined ? "allow" : "ask" }));
    on("tool.call", async (_$, e) => {
      await $.tool.check({ tool: e.tool, input: {}, tool_use_id: e.tool_use_id ?? "", approver: "person" });
      // `.stdout` on this throws, so only the guard keeps the busy.
      return { result: null };
    });
    await $.tool.call({ tool: "Bash", command: "gh pr create" });
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "needs-input" }, { state: "busy" }]);
  });

  test("a wedged daemon queues one report, the latest, with the PR URL kept", async ($, on) => {
    const daemon = latch();
    const sent = record(on, { gate: daemon.held });
    tools($, on, { stdout: "https://github.com/acme/app/pull/12\n" });
    await $.turn.start({ ...turn, text: "hi" });
    await settled(sent, 1);
    await $.tool.call({ tool: "Bash", command: "gh pr create" });
    await $.turn.complete(answered);
    await $.turn.start({ ...turn, text: "again" });
    await $.turn.complete(answered);
    daemon.release();
    await settled(sent, 2);
    // A non-event cannot be polled for: wait as long as a send takes to land above.
    await settled(sent, 3);
    expect(sent.map((s) => s.report)).toEqual([
      { state: "busy" },
      { state: "idle", prUrl: "https://github.com/acme/app/pull/12" },
    ]);
  });

  test("ended carries the PR URL, in flight or pending", async ($, on) => {
    const url = "https://github.com/acme/app/pull/12";
    const daemon = latch();
    const sent = record(on, { gate: daemon.held });
    tools($, on, { stdout: `${url}\n` });
    // The busy report holds the daemon, so the PR report stays pending behind it.
    await $.turn.start({ ...turn, text: "hi" });
    await settled(sent, 1);
    await $.tool.call({ tool: "Bash", command: "gh pr create" });
    await end($, "prompt_input_exit");
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "busy" }, { state: "ended", prUrl: url }]);
    daemon.release();
  });

  test("ended carries a PR URL whose report is already in flight", async ($, on) => {
    const url = "https://github.com/acme/app/pull/12";
    const daemon = latch();
    const sent = record(on, { gate: daemon.held });
    tools($, on, { stdout: `${url}\n` });
    await $.tool.call({ tool: "Bash", command: "gh pr create" });
    await settled(sent, 1);
    await end($, "prompt_input_exit");
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([
      { state: "busy", prUrl: url },
      { state: "ended", prUrl: url },
    ]);
    daemon.release();
  });

  test("ended does not wait behind a wedged daemon, and replaces what was queued", async ($, on) => {
    const daemon = latch();
    const sent = record(on, { gate: daemon.held });
    await $.turn.start({ ...turn, text: "hi" });
    await settled(sent, 1);
    await $.turn.complete(answered);
    await end($, "prompt_input_exit");
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "busy" }, { state: "ended" }]);
    daemon.release();
    // A non-event cannot be polled for: wait as long as a send takes to land above.
    await settled(sent, 3);
    expect(sent.map((s) => s.report)).toEqual([{ state: "busy" }, { state: "ended" }]);
  });

  test("a /clear or a /resume is not an end", async ($, on) => {
    const sent = record(on);
    await end($, "clear");
    await end($, "resume");
    await end($, "logout");
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "ended" }]);
  });

  test("a session in no tmux pane sends nothing: the daemon could only answer unbound", async ($, on) => {
    const sent = record(on, { env: {} });
    await $.turn.start({ ...turn, text: "hi" });
    await $.turn.complete(answered);
    // A non-event cannot be polled for: wait as long as a send takes to land above.
    await settled(sent, 1);
    expect(sent).toEqual([]);
  });

  test("bun missing costs the session nothing, and later reports still go", async ($, on) => {
    const sent = record(on, { fail: true });
    await $.turn.start({ ...turn, text: "hi" });
    await $.turn.complete(answered);
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "busy" }, { state: "idle" }]);
  });
});
