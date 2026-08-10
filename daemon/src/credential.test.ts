import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toBase64 } from "@seance/shared";
import { credentialPskPath, readCredentialPsk } from "./credential.ts";
import { credentialStore } from "./psk-store.ts";

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "seance-cred-"));
  cleanups.push(dir);
  return dir;
}

const PSK = toBase64(new Uint8Array(32).fill(7));

describe("credential path", () => {
  const original = process.env["CREDENTIALS_DIRECTORY"];
  afterEach(() => {
    if (original === undefined) delete process.env["CREDENTIALS_DIRECTORY"];
    else process.env["CREDENTIALS_DIRECTORY"] = original;
  });

  test("null outside a credential-bearing service", () => {
    delete process.env["CREDENTIALS_DIRECTORY"];
    expect(credentialPskPath()).toBeNull();
  });

  test("points at the seance-psk credential inside the delivered directory", () => {
    process.env["CREDENTIALS_DIRECTORY"] = "/run/credentials/seanced.service";
    expect(credentialPskPath()).toBe("/run/credentials/seanced.service/seance-psk");
  });
});

describe("credential read", () => {
  test("a null path reads as null without touching the filesystem", async () => {
    expect(await readCredentialPsk(null)).toBeNull();
  });

  test("a unit loading credentials under other ids reads as null", async () => {
    const dir = await tempDir();
    expect(await readCredentialPsk(join(dir, "seance-psk"))).toBeNull();
  });

  test("reads the delivered PSK, trimming the trailing newline", async () => {
    const dir = await tempDir();
    const path = join(dir, "seance-psk");
    await writeFile(path, `${PSK}\n`);
    expect(await readCredentialPsk(path)).toBe(PSK);
  });

  test("an empty credential reads as null", async () => {
    const dir = await tempDir();
    const path = join(dir, "seance-psk");
    await writeFile(path, "\n");
    expect(await readCredentialPsk(path)).toBeNull();
  });
});

describe("credential store", () => {
  test("unavailable outside a credential-bearing service", async () => {
    expect(await credentialStore(null).available()).toBe(false);
  });

  test("available and readable where the manager delivered a key", async () => {
    const dir = await tempDir();
    const path = join(dir, "seance-psk");
    await writeFile(path, `${PSK}\n`);
    const store = credentialStore(path);
    expect(await store.available()).toBe(true);
    expect(await store.read()).toBe(PSK);
  });

  test("an empty delivery is unavailable, not an available store psk-import would then refuse", async () => {
    const dir = await tempDir();
    const path = join(dir, "seance-psk");
    await writeFile(path, "\n");
    expect(await credentialStore(path).available()).toBe(false);
  });

  test("import refuses — the delivery mount is the manager's, not ours", async () => {
    await expect(credentialStore(null).importValue(PSK)).rejects.toThrow("LoadCredentialEncrypted");
  });

  test("doctor is silent in a shell, warns inside a service delivering the wrong id", async () => {
    expect(await credentialStore(null).doctor()).toEqual([]);
    const dir = await tempDir();
    const checks = await credentialStore(join(dir, "seance-psk")).doctor();
    expect(checks).toHaveLength(1);
    expect(checks[0]?.level).toBe("warn");
  });
});
