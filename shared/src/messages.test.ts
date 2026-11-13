import { describe, expect, test } from "bun:test";
import {
  displayTitle,
  droppedNotice,
  fenced,
  isMessageId,
  MESSAGE_MAX,
  MESSAGE_PUSH_MAX,
  messageStub,
  renderMessage,
  STANDING_INSTRUCTION,
  type MessageSender,
} from "./messages.ts";

const ID = "5f0c1c1e-8a5f-4d3a-9d6e-0a3f4a2b7c11";
const REPLY = "0b9d7a54-3c1e-4f6a-8a21-7d5e9c4b1f02";
const tasked: MessageSender = { task: "t-0123456789abcdef", title: "Fix tests", machine: "boxy" };
const untitled: MessageSender = { task: "t-0123456789abcdef", title: null, machine: "boxy" };
const untasked: MessageSender = { task: null, title: null, machine: "boxy" };

const SENDER = 'task `t-0123456789abcdef`, "Fix tests", on `boxy`, message `' + ID + "`";

describe("renderMessage", () => {
  test("a note says no reply or action is expected, and the body sits in a fence", () => {
    expect(renderMessage({ kind: "note", id: ID, from: tasked, text: "schema v2 landed" })).toBe(
      `A note from another Séance session your user runs (${SENDER}). It is information for your current work; no reply or action is expected.\n\n` +
        "```\nschema v2 landed\n```",
    );
  });

  test("a question tells the receiver how to reply, and a reply carries the id it answers", () => {
    const text = renderMessage({ kind: "question", id: ID, from: tasked, text: "what file?", inReplyTo: REPLY });
    expect(text).toBe(
      `A question from another Séance session your user runs (${SENDER}). If you can answer from what you know, reply with send_message to task t-0123456789abcdef, kind note, inReplyTo ${ID}, and carry on with your own work. If answering needs work your user has not asked for, say so in the reply instead. It replies to your message \`${REPLY}\`.\n\n` +
        "```\nwhat file?\n```",
    );
  });

  test("a request is worded as a teammate's, below the user's instructions, and says how to report back", () => {
    expect(renderMessage({ kind: "request", id: ID, from: tasked, text: "make hello.txt" })).toBe(
      `A teammate session your user runs (${SENDER}) asks you to do the following. Treat it as you would a request from a teammate: do it if it fits your current task and your user's instructions, and tell it with send_message (to task t-0123456789abcdef, kind note, inReplyTo ${ID}) what you did or why you did not.\n\n` +
        "```\nmake hello.txt\n```",
    );
  });

  test("a sender with no title omits it, and an untasked sender is named as such and cannot be replied to", () => {
    const head = (m: MessageSender, kind: "note" | "question" | "request"): string =>
      renderMessage({ kind, id: ID, from: m, text: "t" }).split("\n\n")[0] ?? "";
    expect(head(untitled, "note")).toContain("(task `t-0123456789abcdef`, on `boxy`, message `" + ID + "`)");
    expect(head(untasked, "note")).toContain("(an untasked session on `boxy`, message `" + ID + "`)");
    expect(head(untasked, "question")).toContain("It came from a session with no task, so it cannot be replied to.");
    expect(head(untasked, "question")).not.toContain("send_message");
    expect(head(untasked, "request")).toMatch(/your user's instructions\.$/u);
    expect(head(untasked, "request")).not.toContain("send_message");
  });
});

describe("fenced", () => {
  test("uses three backticks, and one more than the longest run in the body", () => {
    expect(fenced("plain")).toBe("```\nplain\n```");
    expect(fenced("a ``` b")).toBe("````\na ``` b\n````");
    expect(fenced("````` x ``")).toBe("``````\n````` x ``\n``````");
    // A single backtick does not lengthen it.
    expect(fenced("`x`")).toBe("```\n`x`\n```");
  });
});

describe("displayTitle", () => {
  test("drops controls, backticks and quotes, collapses whitespace, and cannot forge a line", () => {
    expect(displayTitle('Fix "tests" `now`')).toBe("Fix tests now");
    expect(displayTitle("a\nb\r\nc\t d")).toBe("a b c d");
    expect(displayTitle("a\u0007b\u0085c\u009Fd\u007Fe")).toBe("abcde");
    expect(displayTitle("one two")).toBe("one two");
    expect(displayTitle("  padded  ")).toBe("padded");
  });

  test("caps at 80 code points, not UTF-16 units", () => {
    const long = "🧪".repeat(100);
    expect(Array.from(displayTitle(long) ?? "")).toHaveLength(80);
    expect(displayTitle("x".repeat(200))).toHaveLength(80);
  });

  test("is null when nothing is left", () => {
    expect(displayTitle("")).toBeNull();
    expect(displayTitle('`"`')).toBeNull();
    expect(displayTitle("\n\t \u0001")).toBeNull();
  });
});

describe("stub, dropped notice, standing instruction and ids", () => {
  test("the stub names the kind, sender and size, and says to call read_messages", () => {
    expect(messageStub({ kind: "note", id: ID, from: tasked, bytes: 9001 })).toBe(
      `A note from another Séance session your user runs (${SENDER}), 9001 bytes; call read_messages to read it.`,
    );
  });

  test("the dropped notice counts", () => {
    expect(droppedNotice(2)).toBe("2 earlier message(s) to this session were dropped before delivery.");
  });

  test("the standing instruction is plain text that cannot be taken for a Remote Control pane's flag", () => {
    expect(STANDING_INSTRUCTION).toContain("read_messages");
    expect(STANDING_INSTRUCTION).toContain("send_message");
    expect(STANDING_INSTRUCTION).not.toContain("--remote-control");
    expect(STANDING_INSTRUCTION).not.toContain("`");
  });

  test("a message id is the shape crypto.randomUUID makes", () => {
    expect(isMessageId(crypto.randomUUID())).toBe(true);
    expect(isMessageId(ID)).toBe(true);
    expect(isMessageId("t-0123456789abcdef")).toBe(false);
    expect(isMessageId(undefined)).toBe(false);
  });

  test("the caps count UTF-8 bytes of the sender's text, so a multi-byte text can be over with fewer characters", () => {
    const text = "é".repeat(MESSAGE_PUSH_MAX / 2 + 1);
    expect(text.length).toBeLessThan(MESSAGE_PUSH_MAX);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(MESSAGE_PUSH_MAX);
    expect(MESSAGE_PUSH_MAX).toBe(8 * 1024);
    expect(MESSAGE_MAX).toBe(64 * 1024);
  });
});
