import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * `@raycast/api` throws when imported outside the Raycast host, so a module
 * under src/lib that reached for it would be unloadable under `bun test` — and
 * every test in this directory would fail at import time with nothing useful to
 * say. The rule is what makes the rest of this suite possible, so it is
 * enforced rather than remembered: views are .tsx at src/, logic is .ts at
 * src/lib/.
 */
describe("src/lib is free of @raycast/api", () => {
  test("no module under src/lib imports it", async () => {
    const dir = new URL(".", import.meta.url).pathname;
    const files = (await readdir(dir)).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const name of files) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of small files; concurrency buys nothing
      const source = await readFile(join(dir, name), "utf8");
      if (/["']@raycast\/api["']/u.test(source)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
