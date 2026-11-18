import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * Nothing an adapter sends or is sent reaches a log or an audit line (DESIGN.md, "Adapters"): the audit carries the
 * name, an exit code and a reason, from the supervisor's own constants. So the adapter modules load no module that
 * logs, by any runtime import, and reach `audit.ts` only for its types (`AdapterAudit`, whose methods take no text the
 * adapter wrote): the walk follows every relative import that is not `import type`.
 */
const SRC = resolve(import.meta.dir, "../src");

const ENTRIES = [
  "adapter-supervisor.ts",
  "adapter-feed.ts",
  "adapter-host.ts",
  "adapter-subscriptions.ts",
  "closing-panes.ts",
] as const;

/** A static or dynamic import, with whether the whole statement is type-only. */
const IMPORT = /(?:^|\n)\s*(import|export)(\s+type)?\b[^;]*?["'](\.\/[^"']+)["']|import\(\s*["'](\.\/[^"']+)["']/gu;

async function edges(file: string): Promise<readonly { readonly target: string; readonly typeOnly: boolean }[]> {
  const source = await readFile(join(SRC, file), "utf8");
  const out: { target: string; typeOnly: boolean }[] = [];
  for (const match of source.matchAll(IMPORT)) {
    const target = (match[3] ?? match[4])?.replace(/^\.\//u, "");
    if (target !== undefined) out.push({ target, typeOnly: match[2] !== undefined });
  }
  return out;
}

async function runtimeClosure(entry: string): Promise<ReadonlySet<string>> {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    // oxlint-disable-next-line no-await-in-loop -- a walk
    for (const edge of await edges(file)) if (!edge.typeOnly) queue.push(edge.target);
  }
  return seen;
}

describe("the adapter modules", () => {
  for (const entry of ENTRIES) {
    test(`${entry} loads neither log.ts nor audit.ts at run time`, async () => {
      const reached = await runtimeClosure(entry);
      expect(reached.has(entry)).toBe(true);
      expect([...reached].filter((file) => file === "log.ts" || file === "audit.ts")).toEqual([]);
    });
  }

  test("the walk sees a type-only edge as one", async () => {
    const supervisor = await edges("adapter-supervisor.ts");
    expect(supervisor).toContainEqual({ target: "audit.ts", typeOnly: true });
  });
});
