import { describe, expect, test } from "bun:test";
import { parseMessageFrame } from "./message-frame.ts";

const TO = "t-0123456789abcdef";
const ID = "5f0c1c1e-8a5f-4d3a-9d6e-0a3f4a2b7c11";
const frame = { v: 1, kind: "message", to: TO, messageKind: "note", text: "hi" } as const;

describe("parseMessageFrame", () => {
  test("takes a task address, with the optional reply id and route", () => {
    expect(parseMessageFrame(frame)).toEqual({ to: TO, messageKind: "note", text: "hi" });
    expect(parseMessageFrame({ ...frame, inReplyTo: ID, route: "ask" })).toEqual({
      to: TO,
      messageKind: "note",
      text: "hi",
      inReplyTo: ID,
      route: "ask",
    });
  });

  test("takes no `to` only where `inReplyTo` stands in for it", () => {
    const { to: _to, ...bare } = frame;
    expect(parseMessageFrame({ ...bare, inReplyTo: ID })).toEqual({ messageKind: "note", text: "hi", inReplyTo: ID });
    expect(parseMessageFrame(bare)).toBeNull();
    expect(parseMessageFrame({ ...bare, inReplyTo: "nope" })).toBeNull();
  });

  test("refuses a `to` that is not a task id, however a handle is given, and a field it does not know", () => {
    for (const bad of [
      { ...frame, to: "../etc" },
      { ...frame, to: 3 },
      { ...frame, to: null },
      { ...frame, pane: "%1" },
      { ...frame, messageKind: "shout" },
      { ...frame, text: "" },
      { ...frame, route: "now" },
      { ...frame, v: 2 },
    ]) {
      expect(parseMessageFrame(bad)).toBeNull();
    }
    expect(parseMessageFrame(null)).toBeNull();
  });
});
