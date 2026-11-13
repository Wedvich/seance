import { describe, expect, test } from "bun:test";
import { isCustodianFrameKind, parseCustodianFrame } from "./custodian-frame.ts";

const base = { v: 1, kind: "custodian" } as const;

describe("parseCustodianFrame", () => {
  test("each verb's valid shape", () => {
    expect(parseCustodianFrame({ ...base, verb: "sessions" })).toEqual({ ...base, verb: "sessions" });
    expect(parseCustodianFrame({ ...base, verb: "close", pane: "%12" })).toEqual({
      ...base,
      verb: "close",
      pane: "%12",
    });
    expect(parseCustodianFrame({ ...base, verb: "notes", text: "## standing\nx\n" })).toEqual({
      ...base,
      verb: "notes",
      text: "## standing\nx\n",
    });
    expect(parseCustodianFrame({ ...base, verb: "done", summary: "ok" })).toEqual({
      ...base,
      verb: "done",
      summary: "ok",
    });
  });

  test("sizes are the handler's to refuse, not the parser's", () => {
    const big = "x".repeat(100_000);
    expect(parseCustodianFrame({ ...base, verb: "notes", text: big })).not.toBeNull();
    expect(parseCustodianFrame({ ...base, verb: "done", summary: big })).not.toBeNull();
  });

  test("an extra key, a missing key, another version or verb, a bad pane, a non-string text", () => {
    expect(parseCustodianFrame({ ...base, verb: "sessions", pane: "%1" })).toBeNull();
    expect(parseCustodianFrame({ ...base, verb: "close" })).toBeNull();
    expect(parseCustodianFrame({ ...base, verb: "close", pane: "%1", text: "x" })).toBeNull();
    expect(parseCustodianFrame({ ...base, v: 2, verb: "sessions" })).toBeNull();
    expect(parseCustodianFrame({ ...base, verb: "nudge", pane: "%1" })).toBeNull();
    expect(parseCustodianFrame({ ...base, verb: "close", pane: "12" })).toBeNull();
    expect(parseCustodianFrame({ ...base, verb: "close", pane: "%x" })).toBeNull();
    expect(parseCustodianFrame({ ...base, verb: "close", pane: 12 })).toBeNull();
    expect(parseCustodianFrame({ ...base, verb: "notes", text: 5 })).toBeNull();
    expect(parseCustodianFrame({ ...base, verb: "done", summary: null })).toBeNull();
    expect(parseCustodianFrame({ ...base, kind: "message", verb: "sessions" })).toBeNull();
    expect(parseCustodianFrame("sessions")).toBeNull();
    expect(parseCustodianFrame(null)).toBeNull();
  });
});

describe("isCustodianFrameKind", () => {
  test("only an object whose kind is custodian", () => {
    expect(isCustodianFrameKind({ kind: "custodian" })).toBe(true);
    expect(isCustodianFrameKind({ kind: "message" })).toBe(false);
    expect(isCustodianFrameKind(null)).toBe(false);
    expect(isCustodianFrameKind("custodian")).toBe(false);
  });
});
