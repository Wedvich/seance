import { describe, expect, mock, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On, SessionEndReason, ToolCheckDecision } from "claude-code";
import { prUrlFrom } from "./register.ts";

type Sent = { readonly argv: readonly string[]; readonly report: unknown }[];

/**
 * Records every `seanced session-event` the mod runs, answering as seanced does: silently.
 * `env` is the session's: in a tmux pane unless a test says otherwise.
 */
function record(
  on: On,
  {
    fail = false,
    env = { TMUX_PANE: "%7" },
  }: { readonly fail?: boolean; readonly env?: Readonly<Record<string, string>> } = {},
): Sent {
  const sent: Sent = [];
  mock.env(on, env);
  // The engine's own step beneath each lifecycle event; the mod only observes, so its echo does.
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("session.end", (_$, e) => ({ sessionId: e.sessionId }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("process.run", (_$, e) => {
    sent.push({ argv: [...e.argv], report: JSON.parse(e.init?.stdin ?? "null") });
    if (fail) throw new Error("spawn seanced ENOENT");
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
  }: {
    readonly verdict?: ToolCheckDecision;
    readonly approver?: "person" | "host" | undefined;
    readonly stdout?: string;
  } = {},
): void {
  on("tool.check", (_$, e) => ({ decision: e.approver === undefined ? "allow" : verdict }));
  on("tool.call", async (_$, e) => {
    await $.tool.check({
      tool: e.tool,
      input: {},
      ...(e.tool_use_id === undefined ? {} : { tool_use_id: e.tool_use_id }),
      ...(approver === undefined ? {} : { approver }),
    });
    return { result: { stdout, stderr: "", interrupted: false } };
  });
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

describe("reports", () => {
  test("a session's life sends its states through seanced, never naming a session", async ($, on) => {
    const sent = record(on);
    await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
    await $.turn.start({ ...turn, text: "hi" });
    await $.turn.complete(answered);
    await end($, "prompt_input_exit");
    await settled(sent, 4);
    expect(sent.map((s) => s.argv)).toEqual(Array.from({ length: 4 }, () => ["seanced", "session-event"]));
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

  test("seanced missing costs the session nothing, and later reports still go", async ($, on) => {
    const sent = record(on, { fail: true });
    await $.turn.start({ ...turn, text: "hi" });
    await $.turn.complete(answered);
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "busy" }, { state: "idle" }]);
  });
});
