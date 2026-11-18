import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * `send_message` runs inside `seance mcp`, whose stdout is the JSON-RPC channel, `seance inbox` writes the
 * mod's data channel to stdout, and `seance custodian` prints the round's replies there; a `log.ts` call from any
 * would corrupt it, and message text, notes and a round's summary must never reach a log. So no entry may load
 * `log.ts`, however indirectly: the walk follows every relative import, type-only ones included, since an allowed
 * module that grows an edge to a logging one must fail here.
 */
const SRC = resolve(import.meta.dir, "../src");

const ENTRIES = [
  "send-message.ts",
  "message-frame.ts",
  "watch-frame.ts",
  "watch-github.ts",
  "inbox-cli.ts",
  "custodian-cli.ts",
  "custodian-frame.ts",
  "custodian-control.ts",
] as const;

const IMPORT = /(?:from|import)\s*\(?\s*["'](\.\/[^"']+)["']/gu;

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

/**
 * Tag text (a claimed `agent.session`, `agent.remote`, what a `sessions/<pid>.json` holds) is never logged or audited
 * (docs/tags.md, "Threat model"). The modules that hold it load neither sink, type-only edges included, so a call
 * that would put it there cannot be written without failing here.
 */
describe("the modules that hold session tags", () => {
  for (const entry of ["conversations.ts", "agent-session-file.ts", "claude-process.ts"]) {
    test(`${entry} loads neither log.ts nor audit.ts`, async () => {
      const reached = await closure(entry);
      expect(reached.has(entry)).toBe(true);
      expect([...reached].filter((file) => file === "log.ts" || file === "audit.ts")).toEqual([]);
    });
  }
});

/**
 * The round runs `seanced` under a sandbox that reads only `daemon/`, `shared/` and `node_modules/` of the checkout
 * (`toolchainAllow`, `custodian-launch.ts`): a static import from `main.ts` that left `daemon/src` or named another
 * workspace (`@seance/scheduler`, whose source is `scheduler/src`) would make every verb fail inside the round, with
 * no error the round could read. Dynamic `import()` is how `main.ts` keeps the rest of the CLI out of this closure.
 */
const STATIC_IMPORT = /^\s*(?:import|export)\s(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/gmu;

describe("what `seance custodian` loads in the round's sandbox", () => {
  test("main.ts's static import closure stays under daemon/src, node and @seance/shared", async () => {
    const files = new Set<string>();
    const bare = new Set<string>();
    const queue = ["main.ts"];
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (files.has(file)) continue;
      files.add(file);
      // oxlint-disable-next-line no-await-in-loop -- a walk
      const source = await readFile(join(SRC, file), "utf8");
      for (const match of source.matchAll(STATIC_IMPORT)) {
        const target = match[1];
        if (target === undefined) continue;
        if (!target.startsWith(".")) {
          bare.add(target);
          continue;
        }
        const resolved = relative(SRC, resolve(SRC, dirname(file), target));
        expect(resolved.startsWith("..")).toBe(false);
        queue.push(resolved);
      }
    }
    expect(files.has("custodian-cli.ts")).toBe(true);
    const outside = [...bare].filter(
      (name) => !name.startsWith("node:") && name !== "bun" && !name.startsWith("bun:") && name !== "@seance/shared",
    );
    expect(outside).toEqual([]);
  });
});
