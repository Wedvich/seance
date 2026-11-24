import { describe, expect, test } from "bun:test";
import { droppedNotice, INBOX_MAX_MESSAGES, type MessageKind } from "@seance/shared";
import type { InboxLine } from "../message-frame.ts";
import type { CodexAnswer, CodexConnection, CodexMethod } from "./client.ts";
import { createCodexDelivery } from "./delivery.ts";

/**
 * The delivery's choices against a server double (the server is an external boundary): which method carries a message,
 * into which turn, and what waits for the next one.
 */

const THREAD = "019a0000-0000-7000-8000-00000000aaaa";

interface Call {
  readonly method: CodexMethod;
  readonly params: Readonly<Record<string, unknown>>;
}

/** A server whose turn the test sets; a steer is taken only into its running turn, a start only while idle. */
function server(): {
  readonly connection: CodexConnection;
  readonly calls: Call[];
  turn: string | null;
  open: boolean;
  /** Called before a request is answered: a turn that starts or ends under it. */
  before: ((call: Call) => void) | null;
} {
  const calls: Call[] = [];
  const state = {
    turn: null as string | null,
    open: true,
    before: null as ((call: Call) => void) | null,
    calls,
    connection: {
      request: async (method: CodexMethod, params: Readonly<Record<string, unknown>>): Promise<CodexAnswer> => {
        const call = { method, params };
        calls.push(call);
        state.before?.(call);
        if (!state.open) return { kind: "closed" };
        if (method === "turn/steer") {
          return state.turn !== null && params["expectedTurnId"] === state.turn
            ? { kind: "result", value: { turnId: state.turn } }
            : { kind: "error", code: -32600 };
        }
        if (method === "turn/start") {
          if (state.turn !== null) return { kind: "error", code: -32600 };
          state.turn = "turn-new";
          return { kind: "result", value: { turn: { id: state.turn, status: "inProgress" } } };
        }
        return { kind: "error", code: -32601 };
      },
      notify: () => undefined,
      closed: new Promise<void>(() => {}),
      close: () => undefined,
    } satisfies CodexConnection,
  };
  return state;
}

function delivery(s: ReturnType<typeof server>, known?: { turn: string | null }) {
  const refusals: string[] = [];
  const d = createCodexDelivery({
    thread: THREAD,
    connection: () => (s.open ? s.connection : null),
    turn: () => known?.turn ?? null,
    refused: (method) => void refusals.push(method),
  });
  return { d, refusals };
}

const line = (messageKind: MessageKind, push: string, extra: Partial<InboxLine> = {}): InboxLine => ({
  v: 1,
  id: `id-${push}`,
  messageKind,
  push,
  ...extra,
});

/** The texts each call carried, by method. */
const sent = (calls: readonly Call[]): (readonly [string, readonly string[]])[] =>
  calls.map((c) => {
    const input = c.params["input"];
    const texts = Array.isArray(input) ? input.map((item: { text: string }) => item.text) : [];
    return [c.method, texts] as const;
  });

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe("a message into a Codex session", () => {
  test("into a running turn every kind is steered, naming that turn; nothing starts a turn", async () => {
    const s = server();
    s.turn = "turn-7";
    const { d } = delivery(s, { turn: "turn-7" });
    for (const kind of ["note", "question", "request"] as const) expect(d.take(line(kind, kind))).toBe(true);
    await settle();
    expect(sent(s.calls)).toEqual([
      ["turn/steer", ["note"]],
      ["turn/steer", ["question"]],
      ["turn/steer", ["request"]],
    ]);
    expect(s.calls.every((c) => c.params["expectedTurnId"] === "turn-7" && c.params["threadId"] === THREAD)).toBe(true);
  });

  test("an idle session is woken by a question, a request or a note marked wake, never by a plain note", async () => {
    const s = server();
    const { d } = delivery(s);
    d.take(line("note", "fyi"));
    await settle();
    expect(s.calls).toEqual([]);
    expect(d.held()).toBe(1);
    d.take(line("request", "do it"));
    await settle();
    // The held note rides ahead of the waking message, as an appended row is read before the next turn's prompt.
    expect(sent(s.calls)).toEqual([["turn/start", ["fyi", "do it"]]]);
    expect(d.held()).toBe(0);

    const t = server();
    const woken = delivery(t);
    woken.d.take(line("note", "answer", { wake: true }));
    await settle();
    expect(sent(t.calls)).toEqual([["turn/start", ["answer"]]]);
  });

  test("held notes are steered into the next turn when it starts, whoever started it", async () => {
    const s = server();
    const known = { turn: null as string | null };
    const { d } = delivery(s, known);
    d.take(line("note", "one"));
    d.take(line("note", "two"));
    await settle();
    s.turn = "turn-owner";
    known.turn = "turn-owner";
    d.turnStarted("turn-owner");
    await settle();
    expect(sent(s.calls)).toEqual([["turn/steer", ["one", "two"]]]);
    expect(s.calls[0]?.params["expectedTurnId"]).toBe("turn-owner");
    expect(d.held()).toBe(0);
  });

  test("a turn that ends under its steer: the note waits for the next turn, and the request after it starts one", async () => {
    const s = server();
    const known = { turn: "turn-1" as string | null };
    const { d } = delivery(s, known);
    // The server has already ended the turn the daemon still holds.
    d.take(line("note", "late note"));
    d.take(line("request", "late request"));
    s.before = (call) => {
      if (call.method === "turn/steer") known.turn = null;
    };
    await settle();
    await settle();
    expect(sent(s.calls)).toEqual([
      ["turn/steer", ["late note"]],
      ["turn/start", ["late note", "late request"]],
    ]);
  });

  test("a turn that starts under its start: the message is steered into it instead", async () => {
    const s = server();
    const known = { turn: null as string | null };
    const { d, refusals } = delivery(s, known);
    s.before = (call) => {
      if (call.method === "turn/start") {
        s.turn = "turn-owner";
        known.turn = "turn-owner";
      }
    };
    d.take(line("question", "q"));
    await settle();
    await settle();
    expect(sent(s.calls)).toEqual([
      ["turn/start", ["q"]],
      ["turn/steer", ["q"]],
    ]);
    expect(refusals).toEqual([]);
  });

  test("a message after the daemon's own start joins that turn before the server names it", async () => {
    const s = server();
    const { d } = delivery(s);
    d.take(line("request", "first"));
    d.take(line("note", "second"));
    await settle();
    await settle();
    expect(sent(s.calls)).toEqual([
      ["turn/start", ["first"]],
      ["turn/steer", ["second"]],
    ]);
    expect(s.calls[1]?.params["expectedTurnId"]).toBe("turn-new");
  });

  test("the full body goes, never the stub: Codex has no read_messages", async () => {
    const s = server();
    const { d } = delivery(s);
    d.take(line("question", "stub: call read_messages", { body: "the whole question" }));
    await settle();
    expect(sent(s.calls)).toEqual([["turn/start", ["the whole question"]]]);
  });

  test("no connection takes nothing, so messaging holds the line for the reconnect", () => {
    const s = server();
    s.open = false;
    const { d } = delivery(s);
    expect(d.take(line("request", "r"))).toBe(false);
    expect(s.calls).toEqual([]);
  });

  test("a waking message nothing takes is reported by method, and held notes are kept for the next turn", async () => {
    const s = server();
    const { d, refusals } = delivery(s);
    d.take(line("note", "kept"));
    s.before = () => {
      s.open = false;
    };
    d.take(line("request", "lost"));
    await settle();
    await settle();
    expect(refusals).toEqual(["turn/start"]);
    expect(d.held()).toBe(1);
  });

  test("held notes past the inbox's cap drop the oldest, and the next delivery says how many", async () => {
    const s = server();
    const { d } = delivery(s);
    for (let i = 0; i <= INBOX_MAX_MESSAGES; i += 1) d.take(line("note", `n${i}`));
    await settle();
    expect(d.held()).toBe(INBOX_MAX_MESSAGES);
    d.take(line("request", "go"));
    await settle();
    const [, texts] = sent(s.calls)[0] ?? ["", []];
    expect(texts[0]).toBe(`${droppedNotice(1)}\n\nn1`);
    expect(texts.at(-1)).toBe("go");
  });
});
