import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { adapterProtocolSchema, adapterWants, encodeDaemonFrame, parseAdapterLine } from "./adapter-protocol.ts";

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

  test("a kind protocol 1 defines for later is unsupported; anything else malformed is invalid", () => {
    expect(parseAdapterLine('{"kind":"deliver"}')).toEqual({ ok: false, code: "unsupported" });
    expect(parseAdapterLine('{"kind":"tag"}')).toEqual({ ok: false, code: "unsupported" });
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
  });
});

describe("the committed JSON Schema", () => {
  test("is what the record generates (bun run adapter-schema; the formatter lays it out)", async () => {
    const committed = await readFile(join(import.meta.dir, "adapter-protocol.schema.json"), "utf8");
    expect(JSON.parse(committed)).toEqual(adapterProtocolSchema());
  });
});
