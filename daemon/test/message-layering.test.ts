import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * `send_message` runs inside `seanced mcp`, whose stdout is the JSON-RPC channel, `seanced inbox` writes the
 * mod's data channel to stdout, and `seanced custodian` prints the round's replies there; a `log.ts` call from any
 * would corrupt it, and message text, notes and a round's summary must never reach a log. So no entry may load
 * `log.ts`, however indirectly: the walk follows every relative import, type-only ones included, since an allowed
 * module that grows an edge to a logging one must fail here.
 */
const SRC = resolve(import.meta.dir, "../src");

const ENTRIES = [
  "send-message.ts",
  "message-frame.ts",
  "inbox-cli.ts",
  "custodian-cli.ts",
  "custodian-frame.ts",
  "custodian-control.ts",
] as const;

const IMPORT = /(?:from|import)\s*\(?\s*"(\.\/[^"]+)"/gu;

async function closure(entry: string): Promise<ReadonlySet<string>> {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    // oxlint-disable-next-line no-await-in-loop -- a walk
    const source = await readFile(join(SRC, file), "utf8");
    for (const match of source.matchAll(IMPORT)) {
      const target = match[1]?.replace(/^\.\//u, "");
      if (target !== undefined) queue.push(target);
    }
  }
  return seen;
}

describe("the message paths that run where stdout is a protocol channel", () => {
  for (const entry of ENTRIES) {
    test(`${entry} loads no module that logs`, async () => {
      const reached = await closure(entry);
      expect(reached.has(entry)).toBe(true);
      expect([...reached].filter((file) => file === "log.ts")).toEqual([]);
    });
  }
});
