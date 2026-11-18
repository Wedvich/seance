import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const LINKS_BUN = /\blink(?:Sync)?\(\s*process\.execPath\b/u;

describe("bun's inode", () => {
  // Removing a hard link of the installed bun gets bun execs anywhere on a Mac SIGKILLed by syspolicyd, so a suite's
  // teardown killed other suites' setup (`bunNamed`, fixtures.ts, says how). A named bun is `bunNamed`'s copy.
  test("no source hard-links the running bun", async () => {
    const offenders: string[] = [];
    for await (const path of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: ROOT, onlyFiles: true })) {
      if (path.includes("node_modules/") || path.startsWith(".claude/")) continue;
      // oxlint-disable-next-line no-await-in-loop -- a few hundred small reads, in order
      if (LINKS_BUN.test(await Bun.file(join(ROOT, path)).text())) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
