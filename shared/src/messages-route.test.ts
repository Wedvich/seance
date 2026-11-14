import { describe, expect, test } from "bun:test";
import { MESSAGE_MAX, MESSAGE_PUSH_MAX, MESSAGE_ROUTE_MAX, receiptNote, routeBytes } from "./messages.ts";
import {
  parseDeliverMessageRequest,
  parseDeliverMessageResponse,
  parseMessageReceiptRequest,
  parseMessageReceiptResponse,
  parseSessionMessage,
} from "./parse.ts";

const ID = "5f0c1c1e-8a5f-4d3a-9d6e-0a3f4a2b7c11";
const REPLY = "0b9d7a54-3c1e-4f6a-8a21-7d5e9c4b1f02";
const TO = "t-0123456789abcdef";
const FROM = "t-fedcba9876543210";

const sessionMessage = { id: ID, to: TO, kind: "note", text: "schema v2 landed" } as const;
const deliver = {
  id: ID,
  taskId: TO,
  addressed: TO,
  kind: "note",
  text: "schema v2 landed",
  fromMachine: "MsgBox",
} as const;

describe("routeBytes", () => {
  test("counts the JSON-escaped text, so an escape costs what it will cost on the wire", () => {
    expect(routeBytes("abc")).toBe(5);
    expect(routeBytes('"')).toBe(4);
    expect(routeBytes("\n")).toBe(4);
    expect(routeBytes("é")).toBe(4);
  });
});

describe("parseSessionMessage", () => {
  test("keeps the carried fields and ignores any other key", () => {
    expect(
      parseSessionMessage({ ...sessionMessage, fromTask: FROM, fromTitle: "Fix", inReplyTo: REPLY, extra: 1 }),
    ).toEqual({ ...sessionMessage, fromTask: FROM, fromTitle: "Fix", inReplyTo: REPLY });
    expect(parseSessionMessage(sessionMessage)).toEqual(sessionMessage);
  });

  test("refuses a wrong-typed field, a bad id and an empty text", () => {
    for (const bad of [
      { ...sessionMessage, id: "nope" },
      { ...sessionMessage, to: "not a task id" },
      { ...sessionMessage, kind: "shout" },
      { ...sessionMessage, text: 4 },
      { ...sessionMessage, text: "" },
      { ...sessionMessage, fromTask: "not a task id" },
      { ...sessionMessage, fromTitle: 4 },
      { ...sessionMessage, fromTitle: "x".repeat(201) },
      { ...sessionMessage, inReplyTo: "nope" },
    ]) {
      expect(parseSessionMessage(bad)).toBeNull();
    }
    expect(parseSessionMessage(null)).toBeNull();
    expect(parseSessionMessage("text")).toBeNull();
  });

  test("holds the text to the byte caps and to the route budget, at the boundary", () => {
    expect(parseSessionMessage({ ...sessionMessage, text: "x".repeat(MESSAGE_ROUTE_MAX - 2) })).not.toBeNull();
    expect(parseSessionMessage({ ...sessionMessage, text: "x".repeat(MESSAGE_ROUTE_MAX - 1) })).toBeNull();
    // Within MESSAGE_MAX in UTF-8 and over the route budget once escaped.
    expect(parseSessionMessage({ ...sessionMessage, text: '"'.repeat(MESSAGE_ROUTE_MAX / 2) })).toBeNull();
    expect(MESSAGE_ROUTE_MAX).toBeLessThan(MESSAGE_MAX);
    expect(
      parseSessionMessage({ ...sessionMessage, kind: "request", text: "x".repeat(MESSAGE_PUSH_MAX) }),
    ).not.toBeNull();
    expect(
      parseSessionMessage({ ...sessionMessage, kind: "request", text: "x".repeat(MESSAGE_PUSH_MAX + 1) }),
    ).toBeNull();
    expect(
      parseSessionMessage({ ...sessionMessage, kind: "note", text: "x".repeat(MESSAGE_PUSH_MAX + 1) }),
    ).not.toBeNull();
  });
});

describe("parseDeliverMessageRequest", () => {
  test("keeps the carried fields, ignores unknown keys, and keeps settled only as true", () => {
    expect(parseDeliverMessageRequest({ ...deliver, extra: 1 })).toEqual(deliver);
    expect(parseDeliverMessageRequest({ ...deliver, settled: true })).toEqual({ ...deliver, settled: true });
    for (const settled of [false, "true", 1, null]) {
      expect(parseDeliverMessageRequest({ ...deliver, settled })).toEqual(deliver);
    }
    expect(parseDeliverMessageRequest({ ...deliver, fromTask: FROM, fromTitle: "Fix", inReplyTo: REPLY })).toEqual({
      ...deliver,
      fromTask: FROM,
      fromTitle: "Fix",
      inReplyTo: REPLY,
    });
  });

  test("refuses a wrong-typed field, an over-long text, an over-budget text and a bad id", () => {
    for (const bad of [
      { ...deliver, id: "nope" },
      { ...deliver, taskId: "not a task id" },
      { ...deliver, addressed: 3 },
      { ...deliver, fromMachine: "" },
      { ...deliver, fromMachine: 3 },
      { ...deliver, text: "x".repeat(MESSAGE_MAX + 1) },
      { ...deliver, text: '"'.repeat(MESSAGE_ROUTE_MAX) },
      { ...deliver, fromTask: "not a task id" },
      { ...deliver, inReplyTo: "nope" },
    ]) {
      expect(parseDeliverMessageRequest(bad)).toBeNull();
    }
    expect(parseDeliverMessageRequest([])).toBeNull();
  });
});

describe("parseDeliverMessageResponse", () => {
  test("accepts each outcome, and a reason only as nolistener beside ended", () => {
    for (const outcome of ["delivered", "sent", "held", "ended", "unknown"] as const) {
      expect(parseDeliverMessageResponse({ ok: true, outcome })).toEqual({ ok: true, outcome });
    }
    expect(parseDeliverMessageResponse({ ok: true, outcome: "ended", reason: "nolistener" })).toEqual({
      ok: true,
      outcome: "ended",
      reason: "nolistener",
    });
    expect(parseDeliverMessageResponse({ ok: true, outcome: "delivered", reason: "nolistener" })).toBeNull();
    expect(parseDeliverMessageResponse({ ok: true, outcome: "ended", reason: "other" })).toBeNull();
  });

  test("refuses an outcome the leader's receipt owns, an unknown code and a failure with no message", () => {
    expect(parseDeliverMessageResponse({ ok: true, outcome: "offline" })).toBeNull();
    expect(parseDeliverMessageResponse({ ok: true, outcome: "unsupported" })).toBeNull();
    expect(parseDeliverMessageResponse({ ok: false, code: "unsupported", message: "no" })).toEqual({
      ok: false,
      code: "unsupported",
      message: "no",
    });
    expect(parseDeliverMessageResponse({ ok: false, code: "nope", message: "no" })).toBeNull();
    expect(parseDeliverMessageResponse({ ok: false, code: "unsupported" })).toBeNull();
    expect(parseDeliverMessageResponse(null)).toBeNull();
  });
});

describe("parseMessageReceiptRequest", () => {
  const receipt = { id: ID, to: TO, kind: "note", outcome: "delivered" } as const;

  test("keeps the carried fields and ignores a text the sender should never have", () => {
    expect(parseMessageReceiptRequest({ ...receipt, text: "secret", extra: 1 })).toEqual(receipt);
    expect(
      parseMessageReceiptRequest({ ...receipt, outcome: "ended", taskId: FROM, reason: "nolistener", fromTask: FROM }),
    ).toEqual({ ...receipt, outcome: "ended", taskId: FROM, reason: "nolistener", fromTask: FROM });
  });

  test("accepts every receipt outcome and refuses a wrong-typed field or a bad id", () => {
    for (const outcome of ["delivered", "sent", "held", "ended", "unknown", "unsupported", "offline"]) {
      expect(parseMessageReceiptRequest({ ...receipt, outcome })).not.toBeNull();
    }
    for (const bad of [
      { ...receipt, id: "nope" },
      { ...receipt, to: "not a task id" },
      { ...receipt, kind: "shout" },
      { ...receipt, outcome: "routed" },
      { ...receipt, taskId: "not a task id" },
      { ...receipt, fromTask: "not a task id" },
      { ...receipt, reason: "other" },
    ]) {
      expect(parseMessageReceiptRequest(bad)).toBeNull();
    }
  });
});

describe("parseMessageReceiptResponse", () => {
  test("accepts the three outcomes and a coded failure, and nothing else", () => {
    for (const outcome of ["delivered", "sent", "dropped"] as const) {
      expect(parseMessageReceiptResponse({ ok: true, outcome })).toEqual({ ok: true, outcome });
    }
    expect(parseMessageReceiptResponse({ ok: true, outcome: "ended" })).toBeNull();
    expect(parseMessageReceiptResponse({ ok: false, code: "invalid_request", message: "m" })).toEqual({
      ok: false,
      code: "invalid_request",
      message: "m",
    });
    expect(parseMessageReceiptResponse({ ok: false, code: "invalid_request" })).toBeNull();
    expect(parseMessageReceiptResponse(3)).toBeNull();
  });
});

describe("receiptNote", () => {
  test("is fixed text per outcome: it names the ids and never carries message text", () => {
    const base = { id: ID, to: TO };
    expect(receiptNote({ ...base, outcome: "delivered" })).toContain("was delivered");
    expect(receiptNote({ ...base, outcome: "delivered", taskId: TO })).not.toContain("now carried");
    expect(receiptNote({ ...base, outcome: "delivered", taskId: FROM })).toContain(`now carried by task \`${FROM}\``);
    expect(receiptNote({ ...base, outcome: "held" })).toContain("has not started yet");
    expect(receiptNote({ ...base, outcome: "ended" })).toContain("no live session");
    expect(receiptNote({ ...base, outcome: "ended", reason: "nolistener" })).toContain("no inbox listener");
    expect(receiptNote({ ...base, outcome: "offline" })).toContain("offline");
    expect(receiptNote({ ...base, outcome: "unsupported" })).toContain("seanced update");
    expect(receiptNote({ ...base, outcome: "unknown" })).toContain("no such task");
    expect(receiptNote({ ...base, outcome: "sent" })).toContain("waiting for its session's inbox listener");
    for (const outcome of ["delivered", "sent", "held", "ended", "unknown", "unsupported", "offline"] as const) {
      const note = receiptNote({ ...base, outcome });
      expect(note).toContain(ID);
      expect(note).toContain(TO);
    }
  });
});
