import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * The relay is blind by construction: it holds ciphertext and routing and
 * never the PSK, so no module under relay/src may reach the envelope crypto
 * or a payload parser. `status` is the frame that makes this worth enforcing
 * rather than remembering — plaintext pressure numbers were the tempting
 * shortcut (DESIGN.md, "Presence & identity"), and the first readable payload
 * would turn the relay's logs into an activity timeline.
 */
const SRC = join(import.meta.dir, "../src");

/** Everything the relay may take from shared as a value; types are free. */
const ALLOWED_VALUES = new Set(["isRecord", "isTerm", "quote", "base64Length", "parseEnvelope", "verifyRegister"]);
const CONSTANT = /^[A-Z][A-Z0-9_]*$/u;

function sharedValueImports(source: string): readonly string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/import\s*(type\s*)?\{([^}]*)\}\s*from\s*["']@seance\/shared["']/gu)) {
    if (match[1] !== undefined) continue; // `import type {…}`: nothing runs
    for (const raw of (match[2] ?? "").split(",")) {
      const spec = raw.trim();
      if (spec === "" || spec.startsWith("type ")) continue;
      names.push(spec.split(/\s+as\s+/u)[0] ?? spec);
    }
  }
  return names;
}

describe("relay/src stays blind", () => {
  test("imports from shared are routing, bounds and the register verify — never seal/open or a payload parser", async () => {
    const files = (await readdir(SRC)).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const name of files) {
      // oxlint-disable-next-line no-await-in-loop -- seven small files; concurrency buys nothing
      const source = await readFile(join(SRC, name), "utf8");
      // The package index is the only door: a deep path would skirt this list.
      if (/["']@seance\/shared\/.+["']/u.test(source)) offenders.push(`${name}: deep import into shared`);
      if (/subtle\.(?:decrypt|encrypt|importKey)/u.test(source)) offenders.push(`${name}: uses envelope crypto`);
      for (const value of sharedValueImports(source)) {
        if (ALLOWED_VALUES.has(value) || CONSTANT.test(value)) continue;
        offenders.push(`${name}: imports ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
