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
      // oxlint-disable-next-line no-await-in-loop -- a handful of small files; concurrency buys nothing
      const source = await readFile(join(SRC, name), "utf8");
      // The package index is the only door: a deep path would skirt this list.
      if (/["']@seance\/shared\/.+["']/u.test(source)) offenders.push(`${name}: deep import into shared`);
      // `timingSafeEqual` on the bearer token is the one WebCrypto call allowed.
      if (/subtle\.(?:decrypt|encrypt|importKey|deriveKey)|\bAES-GCM\b/u.test(source)) {
        offenders.push(`${name}: uses envelope crypto`);
      }
      if (/\batob\s*\(/u.test(source)) offenders.push(`${name}: decodes base64`);
      for (const value of sharedValueImports(source)) {
        if (ALLOWED_VALUES.has(value) || CONSTANT.test(value)) continue;
        offenders.push(`${name}: imports ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("reads the ciphertext field only to bound its size", async () => {
    // wire.ts caps `ct` so a bearer-token holder cannot fill DO storage or the
    // socket attachment; anywhere else `ct` rides inside an opaque envelope.
    const files = (await readdir(SRC)).filter((name) => name.endsWith(".ts"));
    const offenders: string[] = [];
    for (const name of files) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of small files; concurrency buys nothing
      const source = await readFile(join(SRC, name), "utf8");
      const reads = [...source.matchAll(/\.ct\b|\[["']ct["']\]/gu)].length;
      const bounds = name === "wire.ts" ? [...source.matchAll(/\b(?:boundedString|fitsBytes)\(env\.ct,/gu)].length : 0;
      if (reads > bounds) offenders.push(`${name}: ${reads - bounds} read(s) of ct beyond a bound`);
    }
    expect(offenders).toEqual([]);
  });

  test("the Worker's env holds no key: one secret, the leader allowlist, the attachment bucket and test-only bounds", async () => {
    // A new binding is where a PSK would arrive; pinning the list makes adding one a reviewed change.
    const env = await readFile(join(SRC, "env.ts"), "utf8");
    const fields = [...env.matchAll(/^\s*readonly\s+([A-Z_]+)\??:/gmu)].map((m) => m[1]);
    expect(fields).toEqual([
      "HUB",
      // A bucket binding carries no key in, only the bucket's own ciphertext (DESIGN.md, "Attachments").
      "ATTACHMENTS",
      "BEARER_TOKEN",
      "SCHEDULER_LEADERS",
      "SWEEP_INTERVAL_MS",
      "SWEEP_SILENCE_LIMIT_MS",
      "STORE_TOMBSTONE_MS",
      "SCHEDULER_REPLY_WINDOW_MS",
      "UPLOAD_WINDOW_BYTES",
      "UPLOAD_HOUR_BYTES",
      "UPLOAD_HOUR_UPLOADS",
    ]);
  });

  test("never reads a request or object body: attachments stream through untouched", async () => {
    // Socket frames arrive as strings, so nothing here has a reason to buffer a body;
    // the first that did would hold an attachment's bytes where a log line could reach them.
    const files = (await readdir(SRC)).filter((name) => name.endsWith(".ts"));
    const offenders: string[] = [];
    for (const name of files) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of small files; concurrency buys nothing
      const source = await readFile(join(SRC, name), "utf8");
      // `Response.json(` builds a body; it reads none.
      for (const match of source.matchAll(
        /(?<!\bResponse)\.(?:arrayBuffer|bytes|text|blob|formData|json|getReader)\(/gu,
      )) {
        offenders.push(`${name}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
