import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadArchivistConfig } from "./config.ts";

const TOKEN = "archivist-config-test-token-0123456789abcdef";
const GOOD = { name: "archive", relayUrl: "wss://relay.example", bearerToken: TOKEN };

let base: string;
let seq = 0;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "archivist-config-"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function configWith(text: string): Promise<string> {
  const path = join(base, `config-${seq++}.json`);
  await writeFile(path, text);
  return path;
}

async function messageOf(path: string): Promise<string> {
  try {
    await loadArchivistConfig(path);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "";
}

describe("loadArchivistConfig", () => {
  test("loads the three fields and nothing else", async () => {
    const path = await configWith(JSON.stringify({ ...GOOD, extra: "ignored" }));
    expect(await loadArchivistConfig(path)).toEqual(GOOD);
  });

  test("refuses a missing file, non-JSON, a non-object, a psk and a non-string field", async () => {
    expect(await messageOf(join(base, "absent.json"))).toContain("no config at");
    expect(await messageOf(await configWith("[]"))).toContain("must be a JSON object");
    expect(await messageOf(await configWith(JSON.stringify({ ...GOOD, psk: "x" })))).toContain('holds a "psk"');
    expect(await messageOf(await configWith(JSON.stringify({ ...GOOD, name: 3 })))).toContain(
      '"name" must be a string',
    );
  });

  test("a parse failure never echoes the file's content, which may hold the token", async () => {
    const message = await messageOf(await configWith(`{"bearerToken": "${TOKEN}", oops`));
    expect(message).toContain("is not valid JSON");
    expect(message).not.toContain(TOKEN);
  });
});
