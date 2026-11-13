import { describe, expect, mock, test } from "claude-code/testing";
import type { Engine, MockClock } from "claude-code/testing";
import type { On, ToolCheckDecision } from "claude-code";
import { daemonMain, restartDelay } from "./register.ts";

const KEEP = { messages: 32, bytes: 262_144 };
const ACK = `${JSON.stringify({ ok: true, keep: KEEP })}\n`;
const READ = "mcp__inbox__read_messages";

const line = (id: string, messageKind: string, push: string, body?: string): string =>
  `${JSON.stringify({ v: 1, id, messageKind, push, ...(body === undefined ? {} : { body }) })}\n`;

interface Child {
  readonly argvs: readonly (readonly string[])[];
  /** Writes to the child's stdout, as one piece. */
  readonly say: (text: string) => void;
  /** The child exits. */
  readonly exit: (code: number | null) => void;
  /** The stream was left, as the engine does when it kills a child. */
  readonly killed: () => boolean;
}

/** Stands in for the `seanced inbox` child: nothing is written until the test says, and it lives until it exits. */
function fakeChild(on: On): Child {
  const argvs: (readonly string[])[] = [];
  const queue: ({ readonly text: string } | { readonly exit: number | null })[] = [];
  let killed = false;
  let wake = (): void => {};
  const parked = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });
  on("process.spawn", async function* (_$, e) {
    argvs.push([...e.argv]);
    try {
      for (;;) {
        while (queue.length === 0) {
          // oxlint-disable-next-line no-await-in-loop -- parked until the test speaks
          await parked();
        }
        const item = queue.shift();
        if (item === undefined) continue;
        if ("exit" in item) return { value: { code: item.exit, signal: null } };
        yield { stream: "stdout" as const, text: item.text };
      }
    } finally {
      killed = true;
    }
  });
  return {
    argvs,
    killed: () => killed,
    say: (text) => {
      queue.push({ text });
      wake();
    },
    exit: (code) => {
      queue.push({ exit: code });
      wake();
    },
  };
}

interface Delivered {
  readonly submitted: string[];
  readonly appended: () => string[];
}

/** Records what reaches the session: prompts submitted, and rows appended (the kit's own record). */
function session(on: On): Delivered {
  const submitted: string[] = [];
  const rows = mock.session(on);
  on("prompt.submit", (_$, e) => {
    submitted.push(e.text);
    return { text: e.text };
  });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("session.end", (_$, e) => ({ sessionId: e.sessionId }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  return {
    submitted,
    appended: () =>
      rows
        .appended()
        .flatMap((row) => row.message.content)
        .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])),
  };
}

/** A registered `tool.register` call, answered as the engine does. */
function tools(on: On): string[] {
  const registered: string[] = [];
  on("tool.register", (_$, e) => {
    registered.push(e.name);
    return { value: { tool: `mcp__inbox__${e.name}` } };
  });
  return registered;
}

/** Polls: the reader is unawaited by design, so a test waits for its effect rather than for a hook. */
async function until(done: () => boolean, what: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    // oxlint-disable-next-line no-await-in-loop -- a poll, one wait at a time
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

/** Core's part of a tool call, as in session-events' tests: decided by `verdict`, held until `hold` resolves. */
function core(
  $: Engine,
  on: On,
  { verdict = "allow", hold }: { readonly verdict?: ToolCheckDecision; readonly hold?: Promise<void> } = {},
): void {
  on("tool.check", (_$, e) => ({ decision: e.approver === undefined ? "allow" : verdict }));
  on("tool.call", async (_$, e) => {
    await $.tool.check({
      tool: e.tool,
      input: {},
      ...(e.tool_use_id === undefined ? {} : { tool_use_id: e.tool_use_id }),
      approver: "person",
    });
    await hold;
    return { result: { stdout: "", stderr: "", interrupted: false } };
  });
}

function latch(): { readonly release: () => void; readonly held: Promise<void> } {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, held };
}

const start = ($: Engine): Promise<unknown> =>
  $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });

async function readMessages($: Engine): Promise<string> {
  const read = await $.tool.call({ tool: READ, tool_use_id: "read-1" });
  return typeof read.result === "string" ? read.result : JSON.stringify(read);
}

/** A session in a pane, its child up and acked; the clock is the test's, so a backoff waits for `clock.advance`. */
async function acked($: Engine, on: On, ack = ACK): Promise<Child & Delivered & { readonly clock: MockClock }> {
  mock.env(on, { TMUX_PANE: "%7" });
  const clock = mock.clock(on);
  const delivered = session(on);
  tools(on);
  const child = fakeChild(on);
  await start($);
  await until(() => child.argvs.length === 1, "the child to start");
  child.say(ack);
  return { ...child, ...delivered, clock };
}

describe("daemonMain", () => {
  test("maps a plugin root to the checkout's daemon, tolerating a trailing slash", () => {
    expect(daemonMain("/r/seance/claude-mods/inbox")).toBe("/r/seance/daemon/src/main.ts");
    expect(daemonMain("/r/seance/claude-mods/inbox/")).toBe("/r/seance/daemon/src/main.ts");
  });
});

describe("restartDelay", () => {
  test("restarts soon after an ack, backs off after a failure, and waits out an explicit refusal", () => {
    expect(restartDelay(0, true, 8_000)).toEqual({ delayMs: 1_000, failureMs: 1_000 });
    expect(restartDelay(2, false, 1_000)).toEqual({ delayMs: 1_000, failureMs: 2_000 });
    expect(restartDelay(null, false, 8_000)).toEqual({ delayMs: 8_000, failureMs: 15_000 });
    expect(restartDelay(2, false, 15_000)).toEqual({ delayMs: 15_000, failureMs: 15_000 });
    expect(restartDelay(3, false, 2_000)).toEqual({ delayMs: 300_000, failureMs: 2_000 });
    expect(restartDelay(4, false, 2_000)).toEqual({ delayMs: 300_000, failureMs: 2_000 });
  });
});

describe("starting", () => {
  test("outside a tmux pane there is no child and no tool", async ($, on) => {
    mock.env(on, {});
    session(on);
    const registered = tools(on);
    const child = fakeChild(on);
    await start($);
    // A non-event cannot be polled for: let anything a start would launch get going.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(child.argvs).toEqual([]);
    expect(registered).toEqual([]);
  });

  test("in a pane it runs this checkout's `inbox` command and registers read_messages, once however often it starts", async ($, on) => {
    mock.env(on, { TMUX_PANE: "%7" });
    session(on);
    const registered = tools(on);
    const child = fakeChild(on);
    await start($);
    await start($);
    await until(() => child.argvs.length > 0, "the child to start");
    expect(child.argvs).toHaveLength(1);
    const [argv] = child.argvs;
    expect(argv?.[0]).toBe("bun");
    expect(argv?.[1]?.endsWith("/daemon/src/main.ts")).toBe(true);
    expect(argv?.[2]).toBe("inbox");
    expect(argv).toHaveLength(3);
    expect(registered).toEqual(["read_messages"]);
  });

  test("a child that exited after an ack is started again after a second, and a session that ended is not", async ($, on) => {
    const child = await acked($, on);
    child.exit(0);
    await until(() => child.argvs.length === 1 && !child.killed(), "the child to finish");
    await child.clock.advance(999);
    expect(child.argvs).toHaveLength(1);
    await child.clock.advance(1);
    await until(() => child.argvs.length === 2, "the restart after an ack");
    child.say(ACK);
    await end($, "prompt_input_exit");
    child.exit(0);
    await child.clock.advance(60_000);
    // A non-event cannot be polled for: let anything a restart would launch get going.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(child.argvs).toHaveLength(2);
  });

  test("an explicit refusal (exit 3, unsupported; exit 4, an unbindable or untasked pane) is waited out for five minutes, however often the child is refused", async ($, on) => {
    mock.env(on, { TMUX_PANE: "%7" });
    const clock = mock.clock(on);
    session(on);
    tools(on);
    const child = fakeChild(on);
    await start($);
    await until(() => child.argvs.length === 1, "the child to start");
    for (const [code, starts] of [
      [3, 2],
      [4, 3],
    ] as const) {
      child.exit(code);
      // oxlint-disable-next-line no-await-in-loop -- ordered rounds
      await clock.advance(299_999);
      // oxlint-disable-next-line no-await-in-loop -- a non-event cannot be polled for
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      expect(child.argvs).toHaveLength(starts - 1);
      // oxlint-disable-next-line no-await-in-loop -- ordered rounds
      await clock.advance(1);
      // oxlint-disable-next-line no-await-in-loop -- ordered rounds
      await until(() => child.argvs.length === starts, `the restart after exit ${code}`);
    }
  });

  test("any other failure backs off from one second, doubling", async ($, on) => {
    mock.env(on, { TMUX_PANE: "%7" });
    const clock = mock.clock(on);
    session(on);
    tools(on);
    const child = fakeChild(on);
    await start($);
    await until(() => child.argvs.length === 1, "the child to start");
    child.exit(2);
    await clock.advance(1_000);
    await until(() => child.argvs.length === 2, "the first retry, after a second");
    child.exit(2);
    await clock.advance(1_999);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(child.argvs).toHaveLength(2);
    await clock.advance(1);
    await until(() => child.argvs.length === 3, "the second retry, after two");
  });

  test("a session that ended for good stops its child, and a later session.start in the same process starts a fresh one", async ($, on) => {
    const child = await acked($, on);
    await end($, "logout");
    await until(() => child.killed(), "the child to be left");
    await start($);
    await until(() => child.argvs.length === 2, "a fresh child");
  });

  test("a session that continues in the same process (/clear, /resume) keeps its child, with or without a session.start after", async ($, on) => {
    const child = await acked($, on);
    await end($, "clear");
    await end($, "resume");
    await start($);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(child.argvs).toHaveLength(1);
    expect(child.killed()).toBe(false);
  });
});

function end($: Engine, reason: "clear" | "resume" | "logout" | "prompt_input_exit"): Promise<unknown> {
  return $.session.end({ reason, sessionId: "s1", resume: { id: "s1" } });
}

describe("delivery", () => {
  test("a question and a request are submitted as the daemon rendered them, verbatim", async ($, on) => {
    const child = await acked($, on);
    child.say(line("m1", "question", "A question from another Séance session: what file?"));
    child.say(line("m2", "request", "A teammate session asks you to do the following: make hello.txt"));
    await until(() => child.submitted.length === 2, "both prompts");
    expect(child.submitted).toEqual([
      "A question from another Séance session: what file?",
      "A teammate session asks you to do the following: make hello.txt",
    ]);
    expect(child.appended()).toEqual([]);
  });

  test("a note is appended as a row, never submitted, so it does not wake the session", async ($, on) => {
    const child = await acked($, on);
    child.say(line("m1", "note", "A note: schema v2 landed"));
    await until(() => child.appended().length === 1, "the appended note");
    expect(child.appended()).toEqual(["A note: schema v2 landed"]);
    expect(child.submitted).toEqual([]);
  });

  test("a note mid-turn is appended at once too", async ($, on) => {
    const child = await acked($, on);
    await $.turn.start({ turnId: "t1", text: "work" });
    child.say(line("m1", "note", "A note: mid-turn"));
    await until(() => child.appended().length === 1, "the appended note");
    expect(child.submitted).toEqual([]);
  });

  test("a note while a permission dialog is open waits for the call to settle, in order", async ($, on) => {
    mock.env(on, { TMUX_PANE: "%7" });
    const delivered = session(on);
    tools(on);
    const child = fakeChild(on);
    const dialog = latch();
    core($, on, { verdict: "ask", hold: dialog.held });
    await start($);
    await until(() => child.argvs.length === 1, "the child to start");
    child.say(ACK);

    const call = $.tool.call({ tool: "Bash", command: "rm -r build", tool_use_id: "b1" });
    // The dialog is open once the ask has been decided; a note then must wait.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    child.say(line("m1", "note", "first"));
    child.say(line("m2", "note", "second"));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(delivered.appended()).toEqual([]);

    dialog.release();
    await call;
    await until(() => delivered.appended().length === 2, "the held notes");
    expect(delivered.appended()).toEqual(["first", "second"]);
  });

  test("a line split across two pieces is reassembled, and garbage and unknown kinds are ignored", async ($, on) => {
    const child = await acked($, on);
    const whole = line("m1", "question", "A question: split");
    child.say("not json\n");
    child.say(`${JSON.stringify({ v: 1, id: "x", messageKind: "shout", push: "p" })}\n`);
    child.say(`${JSON.stringify({ v: 2, id: "x", messageKind: "note", push: "p" })}\n`);
    child.say(`${JSON.stringify({ v: 1, id: "x", messageKind: "note" })}\n`);
    child.say(whole.slice(0, 20));
    child.say(whole.slice(20));
    await until(() => child.submitted.length === 1, "the reassembled question");
    expect(child.submitted).toEqual(["A question: split"]);
    expect(child.appended()).toEqual([]);
    expect(await readMessages($)).toContain("A question: split");
  });

  test("a refusal line is not a message, and a message after it is still delivered", async ($, on) => {
    mock.env(on, { TMUX_PANE: "%7" });
    const delivered = session(on);
    tools(on);
    const child = fakeChild(on);
    await start($);
    await until(() => child.argvs.length === 1, "the child to start");
    child.say(`${JSON.stringify({ ok: false, code: "unsupported" })}\n`);
    child.say(line("m1", "note", "after a refusal"));
    await until(() => delivered.appended().length === 1, "the note");
  });
});

describe("read_messages", () => {
  test("answers that nothing has come when nothing has", async ($, on) => {
    await acked($, on);
    expect(await readMessages($)).toContain("No messages yet.");
  });

  test("a stub's body is what it returns, oldest first, after the notes that arrived whole", async ($, on) => {
    const child = await acked($, on);
    child.say(line("m1", "note", "A note: short"));
    child.say(line("m2", "note", "A note, 9001 bytes; call read_messages to read it.", "FULL BODY ".repeat(10)));
    await until(() => child.appended().length === 2, "both rows");
    const text = await readMessages($);
    expect(text.startsWith("2 message(s) this session has received, oldest first:")).toBe(true);
    expect(text).toContain("A note: short\n\n---\n\nFULL BODY FULL BODY");
    expect(text).not.toContain("call read_messages to read it");
  });

  test("keeps only what the daemon's ack says to, dropping the oldest", async ($, on) => {
    const child = await acked($, on, `${JSON.stringify({ ok: true, keep: { messages: 2, bytes: 1_000_000 } })}\n`);
    for (const n of ["one", "two", "three"]) child.say(line(n, "note", n));
    await until(() => child.appended().length === 3, "three rows");
    const text = await readMessages($);
    expect(text.startsWith("2 message(s)")).toBe(true);
    expect(text).not.toContain("one");
    expect(text).toContain("two\n\n---\n\nthree");
  });

  test("reading while a note waits for a dialog means the note is not appended again afterwards", async ($, on) => {
    mock.env(on, { TMUX_PANE: "%7" });
    const delivered = session(on);
    tools(on);
    const child = fakeChild(on);
    const dialog = latch();
    core($, on, { verdict: "ask", hold: dialog.held });
    await start($);
    await until(() => child.argvs.length === 1, "the child to start");
    child.say(ACK);

    const call = $.tool.call({ tool: "Bash", command: "rm -r build", tool_use_id: "b1" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    child.say(line("m1", "note", "waiting"));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(await readMessages($)).toContain("waiting");
    dialog.release();
    await call;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(delivered.appended()).toEqual([]);
  });
});
