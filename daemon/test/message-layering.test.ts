import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { BROKER_OPS } from "../src/broker-protocol.ts";

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

const IMPORT = /(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+)["']/gu;

/** A relative import, keyed by its path under `daemon/src` (`agents/claude.ts`, `log.ts`) wherever it was written. */
function under(file: string, target: string): string {
  return relative(SRC, resolve(SRC, dirname(file), target));
}

async function closure(entry: string): Promise<ReadonlySet<string>> {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    // oxlint-disable-next-line no-await-in-loop -- a walk
    const source = await readFile(join(SRC, file), "utf8");
    for (const match of source.matchAll(IMPORT)) {
      const target = match[1];
      if (target !== undefined) queue.push(under(file, target));
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
 * (DESIGN.md, "Tags and session identity", threat model). The modules that hold it load neither sink, type-only edges included, so a call
 * that would put it there cannot be written without failing here.
 */
describe("the modules that hold session tags", () => {
  for (const entry of ["conversations.ts", "adapter-subscriptions.ts", "agent-session-file.ts", "claude-process.ts"]) {
    test(`${entry} loads neither log.ts nor audit.ts`, async () => {
      const reached = await closure(entry);
      expect(reached.has(entry)).toBe(true);
      expect([...reached].filter((file) => file === "log.ts" || file === "audit.ts")).toEqual([]);
    });
  }
});

/**
 * A session's name is the owner's and the session's own text (DESIGN.md, "Tags and session identity", threat model): a message's wrapper, a
 * receipt and the custodian's `sessions` verb name a sender or a session by task, pane and machine only. So the modules
 * that build them run neither the table that holds the names nor the file that keeps the owner's, and never name the
 * keys or the precedence that reads them. Run, not load: `messages.ts` and `custodian-verbs.ts` take a type from
 * `session-events.ts`, which erases, so this walk follows only imports that are not `import type`.
 */
const VALUE_IMPORT = /^\s*(?:import|export)\s(type\s)?(?:[^;]*?\sfrom\s*)?["'](\.\.?\/[^"']+)["']/gmu;

async function valueClosure(entry: string): Promise<ReadonlySet<string>> {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    // oxlint-disable-next-line no-await-in-loop -- a walk
    const source = await readFile(join(SRC, file), "utf8");
    for (const match of source.matchAll(VALUE_IMPORT)) {
      const target = match[2];
      if (match[1] === undefined && target !== undefined) queue.push(under(file, target));
    }
  }
  return seen;
}

describe("the paths that tell one session about another", () => {
  for (const entry of ["messages.ts", "message-frame.ts", "send-message.ts", "custodian-verbs.ts"]) {
    test(`${entry} reaches no session name`, async () => {
      const reached = await valueClosure(entry);
      expect(reached.has(entry)).toBe(true);
      expect([...reached].filter((file) => file === "conversations.ts" || file === "adapter-subscriptions.ts")).toEqual(
        [],
      );
      const sources = await Promise.all([...reached].map((file) => readFile(join(SRC, file), "utf8")));
      for (const source of sources) {
        expect(source).not.toMatch(/owner\.label|self\.name|displayName/u);
      }
    });
  }
});

/**
 * `session-tag` is the owner's act from the PWA alone: the relay leg's handler is the one daemon module that answers
 * it, so no local op, broker action or MCP tool can send it (`local-socket.test.ts` and `mcp.test.ts` hold the
 * surfaces themselves).
 */
describe("who may send session-tag", () => {
  test("only handlers.ts names the op, and the broker does not carry it", async () => {
    const naming: string[] = [];
    for await (const file of new Bun.Glob("**/*.ts").scan(SRC)) {
      if (file.endsWith(".test.ts")) continue;
      // oxlint-disable-next-line no-await-in-loop -- a walk
      if ((await readFile(join(SRC, file), "utf8")).includes('"session-tag"')) naming.push(file);
    }
    expect(naming).toEqual(["handlers.ts"]);
    expect(BROKER_OPS).not.toContain("session-tag");
  });

  // The module graph is the whole of what a tool or a broker call can reach: a tool that sent the op would have to name it.
  for (const entry of ["mcp.ts", "broker-client.ts"]) {
    test(`${entry}'s run-time closure names neither the op nor its parser, handler or table`, async () => {
      const reached = await valueClosure(entry);
      expect(reached.has(entry)).toBe(true);
      expect(reached.has("conversations.ts")).toBe(false);
      // `audit.ts` is every origin's line formatters, `sessionTagAudit` among them: it sends nothing.
      const sources = await Promise.all(
        [...reached].filter((file) => file !== "audit.ts").map((file) => readFile(join(SRC, file), "utf8")),
      );
      for (const source of sources) expect(source).not.toMatch(/session-tag|SessionTag|sessionTag/u);
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
