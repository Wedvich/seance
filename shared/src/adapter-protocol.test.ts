import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  adapterOfAddress,
  adapterProtocolSchema,
  adapterWants,
  encodeDaemonFrame,
  parseAdapterLine,
} from "./adapter-protocol.ts";

const hello = {
  kind: "hello",
  protocol: 1,
  name: "tg",
  version: "1.2.3",
  wants: ["sessions", "tasks"],
  features: [],
} as const;

describe("parseAdapterLine", () => {
  test("takes a hello and a resync into fresh values", () => {
    expect(parseAdapterLine(JSON.stringify(hello))).toEqual({ ok: true, frame: hello });
    expect(parseAdapterLine('{"kind":"resync"}')).toEqual({ ok: true, frame: { kind: "resync" } });
  });

  test("a major it does not speak still parses: refusing it is the supervisor's, by reason", () => {
    expect(parseAdapterLine(JSON.stringify({ ...hello, protocol: 2 }))).toMatchObject({ ok: true });
  });

  test("a deliver names exactly one address; a tag a bare suffix on a session or a task", () => {
    const task = "11111111-2222-4333-8444-555555555555";
    const deliver = {
      kind: "deliver",
      ref: "r-1",
      to: task,
      messageKind: "question",
      text: "hi",
      wake: true,
      from: "Ada",
    } as const;
    expect(parseAdapterLine(JSON.stringify(deliver))).toEqual({ ok: true, frame: deliver });
    const bySession = { kind: "deliver", ref: "r-2", toSession: task, messageKind: "note", text: "hi" } as const;
    expect(parseAdapterLine(JSON.stringify(bySession))).toEqual({ ok: true, frame: bySession });
    const reply = { kind: "deliver", ref: "r-3", inReplyTo: task, messageKind: "note", text: "hi" } as const;
    expect(parseAdapterLine(JSON.stringify(reply))).toEqual({ ok: true, frame: reply });
    const tag = { kind: "tag", ref: "t", session: task, key: "ticket", value: "ENG-1" } as const;
    expect(parseAdapterLine(JSON.stringify(tag))).toEqual({ ok: true, frame: tag });
    const malformed = [
      { kind: "deliver" },
      { ...deliver, toSession: task },
      { kind: "deliver", ref: "r", messageKind: "note", text: "hi" },
      { ...deliver, to: "not:a-task" },
      { ...deliver, ref: "has space" },
      { ...deliver, ref: "x".repeat(65) },
      { ...deliver, text: "" },
      { ...deliver, messageKind: "shout" },
      { ...deliver, wake: "yes" },
      { ...deliver, from: "x".repeat(257) },
      { ...deliver, extra: 1 },
      { kind: "tag" },
      { ...tag, task },
      { ...tag, key: "adapter.other.ticket" },
      { ...tag, key: "Ticket" },
      { ...tag, value: 7 },
    ];
    for (const frame of malformed)
      expect(parseAdapterLine(JSON.stringify(frame))).toEqual({ ok: false, code: "invalid" });
  });

  test("an adapter address is adapter:<name>, a valid name, nothing else", () => {
    expect(adapterOfAddress("adapter:tg")).toBe("tg");
    expect(adapterOfAddress("adapter:")).toBeNull();
    expect(adapterOfAddress("adapter:Bad Name")).toBeNull();
    expect(adapterOfAddress("11111111-2222-4333-8444-555555555555")).toBeNull();
    expect(adapterOfAddress(7)).toBeNull();
  });

  test("anything malformed is invalid, an unknown kind included", () => {
    const invalid = [
      "not json",
      "[]",
      '{"kind":"nope"}',
      '{"kind":"resync","extra":1}',
      JSON.stringify({ ...hello, extra: true }),
      JSON.stringify({ ...hello, protocol: 0 }),
      JSON.stringify({ ...hello, protocol: 1.5 }),
      JSON.stringify({ ...hello, version: "" }),
      JSON.stringify({ ...hello, wants: ["sessions", "sessions"] }),
      JSON.stringify({ ...hello, wants: ["everything"] }),
      JSON.stringify({ ...hello, features: ["Bad Feature"] }),
      JSON.stringify({ ...hello, name: 7 }),
    ];
    for (const line of invalid) expect(parseAdapterLine(line)).toEqual({ ok: false, code: "invalid" });
  });
});

describe("frames out", () => {
  test("one frame per line", () => {
    expect(encodeDaemonFrame({ kind: "error", code: "invalid" })).toBe('{"kind":"error","code":"invalid"}\n');
  });

  test("a frame kind goes only to an adapter that wants it", () => {
    const task = { kind: "task", task: "t1", event: "ended" } as const;
    expect(adapterWants(["sessions"], task)).toBe(false);
    expect(adapterWants(["tasks"], task)).toBe(true);
    expect(adapterWants([], { kind: "error", code: "invalid" })).toBe(true);
    const message = {
      kind: "message",
      id: "m",
      messageKind: "note",
      text: "hi",
      from: { key: "1:2" },
      subscribed: false,
    } as const;
    expect(adapterWants(["sessions"], message)).toBe(false);
    expect(adapterWants(["messages"], message)).toBe(true);
    // An answer to the adapter's own frame always goes.
    expect(adapterWants([], { kind: "result", ref: "r", outcome: "ok" })).toBe(true);
    expect(adapterWants([], { kind: "delivery", id: "m", outcome: "delivered" })).toBe(true);
  });
});

describe("the committed JSON Schema", () => {
  test("is what the record generates (bun run adapter-schema; the formatter lays it out)", async () => {
    const committed = await readFile(join(import.meta.dir, "adapter-protocol.schema.json"), "utf8");
    expect(JSON.parse(committed)).toEqual(adapterProtocolSchema());
  });
});
