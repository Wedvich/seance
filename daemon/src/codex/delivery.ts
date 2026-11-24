import { droppedNotice, INBOX_MAX_BYTES, INBOX_MAX_MESSAGES, isRecord } from "@seance/shared";
import type { InboxLine } from "../message-frame.ts";
import type { CodexAnswer, CodexConnection } from "./client.ts";
import { turnIdOf } from "./events.ts";

/**
 * Messages into a Codex session (DESIGN.md, "Session messages", "A Codex session"; docs/codex.md O4, build order item 12):
 * what the `inbox` mod does for a Claude session, done by the daemon over its own connection to the pane's server.
 *
 * - A question, a request, and a note the daemon marked `wake` (an answer to what this session asked, or an adapter's
 *   `wake`) are the mod's submit: `turn/steer` into the running turn, else `turn/start`, which wakes an idle session.
 * - Any other note is the mod's append: steered into the running turn, else held here and steered into the next turn
 *   when it starts (or sent ahead of a waking message in its `turn/start`), so it never wakes an idle session (D4).
 *
 * The text is the line's full rendered body: Codex has no `read_messages`, so a note or question over
 * `MESSAGE_PUSH_MAX` goes whole rather than as a stub (a request over it was refused at the sender). It is data in an
 * input item, never argv, never logged. The methods are constants and the thread and turn ids the daemon's own.
 *
 * `take` answers whether the line was handed to a live connection: that is `delivered`, as a line written to a mod's
 * child is. A turn the server then refuses loses the message, as a child that dies after the write does.
 */

export interface CodexDeliveryTarget {
  /** The thread this daemon started (or resumed) on the pane's server. */
  readonly thread: string;
  readonly connection: () => CodexConnection | null;
  /** The running turn's id, from the server's own notifications; null when idle. */
  readonly turn: () => string | null;
  /** A turn the server would not take: its method and code only, never the text. */
  readonly refused?: (method: "turn/steer" | "turn/start", answer: CodexAnswer) => void;
}

export interface CodexDelivery {
  readonly take: (line: InboxLine) => boolean;
  /** `turn/started` for this thread: the held notes are steered into it. */
  readonly turnStarted: (turn: string) => void;
  /** Held notes, for a test. */
  readonly held: () => number;
}

interface Item {
  readonly text: string;
  readonly wakes: boolean;
}

export function createCodexDelivery(target: CodexDeliveryTarget): CodexDelivery {
  /** Notes taken while idle, oldest first, under the inbox's own caps: past them the oldest goes and the next says so. */
  const notes: string[] = [];
  let noteBytes = 0;
  let dropped = 0;
  /** One delivery at a time, in the order taken: a steer and a start must not race each other's turn. */
  let chain: Promise<void> = Promise.resolve();
  /** The turn this daemon's own `turn/start` began, before the server's `turn/started` names it. */
  let started: string | null = null;

  const input = (texts: readonly string[]): readonly object[] =>
    texts.map((text) => ({ type: "text", text, text_elements: [] }));

  const holdNote = (text: string): void => {
    notes.push(text);
    noteBytes += Buffer.byteLength(text, "utf8");
    while (notes.length > INBOX_MAX_MESSAGES || noteBytes > INBOX_MAX_BYTES) {
      const oldest = notes.shift();
      if (oldest === undefined) break;
      noteBytes -= Buffer.byteLength(oldest, "utf8");
      dropped += 1;
    }
  };

  /** The held notes, oldest first, the drop notice on the first: emptied, for one request that carries them all. */
  const takeNotes = (): string[] => {
    const taken = notes.splice(0);
    noteBytes = 0;
    if (dropped > 0 && taken.length > 0) {
      taken[0] = `${droppedNotice(dropped)}\n\n${taken[0]}`;
      dropped = 0;
    }
    return taken;
  };

  /** Puts notes back at the head, as they were: the request that carried them was not taken. */
  const restoreNotes = (texts: readonly string[]): void => {
    notes.unshift(...texts);
    noteBytes += texts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
  };

  const steer = async (turn: string, texts: readonly string[]): Promise<CodexAnswer | null> => {
    const connection = target.connection();
    if (connection === null) return null;
    return connection.request("turn/steer", { threadId: target.thread, expectedTurnId: turn, input: input(texts) });
  };

  const start = async (texts: readonly string[]): Promise<CodexAnswer | null> => {
    const connection = target.connection();
    if (connection === null) return null;
    return connection.request("turn/start", { threadId: target.thread, input: input(texts) });
  };

  const refused = (method: "turn/steer" | "turn/start", answer: CodexAnswer | null): void => {
    if (answer !== null) target.refused?.(method, answer);
  };

  /**
   * Into the running turn if there is one; else a note waits for the next turn and a waking message starts one. A steer
   * refused because the turn just ended, or a start refused because one just began, is tried the other way once.
   */
  const deliver = async (item: Item): Promise<void> => {
    const running = target.turn() ?? started;
    if (running !== null) {
      const steered = await steer(running, [item.text]);
      if (steered?.kind === "result") return;
      started = null;
    }
    // Idle, or the turn ended under the steer: a note waits for the next turn, as on an idle session.
    if (!item.wakes) {
      holdNote(item.text);
      return;
    }
    const carried = takeNotes();
    const answer = await start([...carried, item.text]);
    if (answer?.kind === "result") {
      // Until the server's `turn/started` names it, the turn this start began is the one a next message joins.
      started = turnIdOf(field(answer.value, "turn"));
      return;
    }
    restoreNotes(carried);
    // A turn began between the read and the start (the owner's, from the TUI): the message joins it.
    const now = target.turn();
    if (now !== null) {
      const steered = await steer(now, [item.text]);
      if (steered?.kind === "result") return;
      refused("turn/steer", steered);
      return;
    }
    refused("turn/start", answer);
  };

  const enqueue = (run: () => Promise<void>): void => {
    // A request never rejects (client.ts), but a reader's mistake must not stop the chain for the next message.
    chain = chain.then(run).catch(() => undefined);
  };

  return {
    take: (line) => {
      if (target.connection() === null) return false;
      const wakes = line.messageKind !== "note" || line.wake === true;
      const item: Item = { text: line.body ?? line.push, wakes };
      enqueue(() => deliver(item));
      return true;
    },
    turnStarted: (turn) => {
      started = null;
      if (notes.length === 0) return;
      enqueue(async () => {
        if (notes.length === 0) return;
        const carried = takeNotes();
        const steered = await steer(turn, carried);
        if (steered?.kind === "result") return;
        // The turn ended first, or the connection went: they wait for the next turn.
        restoreNotes(carried);
      });
    },
    held: () => notes.length,
  };
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
