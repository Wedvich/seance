import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * "The relay is blind" is a structural claim, not a behavioural one: the Worker
 * holds no PSK and no code path that could use one. The behavioural suites are
 * existence witnesses (this frame was forwarded untouched); this is the universal
 * half, enforced rather than remembered, because a single `open()` import in
 * hub.ts would pass every routing test and end the property.
 */
const SRC = join(import.meta.dir, "../src");

/** The envelope-crypto surface of `shared/`. The relay may import routing ids and shapes, never these. */
const CRYPTO_EXPORTS = new Set(["seal", "open", "importPsk", "ReplayGuard", "fromBase64", "toBase64"]);

async function sources(): Promise<readonly { readonly name: string; readonly text: string }[]> {
  const names = (await readdir(SRC)).filter((name) => name.endsWith(".ts"));
  expect(names.length).toBeGreaterThan(0);
  return Promise.all(names.map(async (name) => ({ name, text: await readFile(join(SRC, name), "utf8") })));
}

/** Named specifiers of every `import { … } from "@seance/shared"` in a file, type-only ones included. */
function sharedImports(text: string): readonly string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@seance\/shared["']/gu)) {
    for (const spec of match[1]!.split(",")) {
      const name = spec
        .trim()
        .replace(/^type\s+/u, "")
        .split(/\s+as\s+/u)[0]
        ?.trim();
      if (name !== undefined && name !== "") names.push(name);
    }
  }
  return names;
}

describe("relay/src is blind by construction", () => {
  test("never imports the envelope crypto from shared", async () => {
    const offenders: string[] = [];
    for (const { name, text } of await sources()) {
      for (const spec of sharedImports(text)) {
        if (CRYPTO_EXPORTS.has(spec)) offenders.push(`${name}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("never decodes or decrypts anything itself", async () => {
    // `timingSafeEqual` on the bearer token is the one WebCrypto call allowed.
    const forbidden = [/\batob\s*\(/u, /subtle\.(?:decrypt|encrypt|importKey|deriveKey)\b/u, /\bAES-GCM\b/u];
    const offenders: string[] = [];
    for (const { name, text } of await sources()) {
      for (const re of forbidden) if (re.test(text)) offenders.push(`${name}: ${re.source}`);
    }
    expect(offenders).toEqual([]);
  });

  test("reads the ciphertext field only to bound its length", async () => {
    // wire.ts caps `ct` so a bearer-token holder cannot write a 128 KiB storage
    // value. That is the only read; anywhere else `ct` is part of an opaque envelope.
    const offenders: string[] = [];
    for (const { name, text } of await sources()) {
      const reads = [...text.matchAll(/\.ct\b|\["ct"\]/gu)].length;
      if (name === "wire.ts") expect(reads).toBe(1);
      else if (reads > 0) offenders.push(`${name}: ${reads}`);
    }
    expect(offenders).toEqual([]);
  });

  test("the Worker's env carries one secret and it is not a key", async () => {
    const env = await readFile(join(SRC, "env.ts"), "utf8");
    const fields = [...env.matchAll(/^\s*readonly\s+([A-Z_]+)\??:/gmu)].map((m) => m[1]!);
    expect(fields).toEqual(["HUB", "BEARER_TOKEN", "SWEEP_INTERVAL_MS", "SWEEP_SILENCE_LIMIT_MS"]);
  });
});
