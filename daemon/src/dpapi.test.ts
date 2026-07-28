import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toBase64 } from "@seance/shared";
import { dpapiRoundTrip, importDpapiPskValue, readDpapiPsk } from "./dpapi.ts";
import { isWsl } from "./wsl.ts";

const wsl = isWsl();

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "seance-dpapi-"));
  cleanups.push(dir);
  return dir;
}

// The protect/unprotect paths need a real Windows user context, so they run
// only on a WSL box — where they are the real interop, not a double. This is
// the DPAPI analogue of the keychain's "verified by hand on a machine" note,
// except a WSL test runner verifies it on every run.
describe("dpapi", () => {
  test("a missing blob reads as null without touching interop", async () => {
    const dir = await tempDir();
    expect(await readDpapiPsk(join(dir, "absent.dpapi"))).toBeNull();
  });

  test.skipIf(!wsl)(
    "round-trips a key and stores the blob 0600",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "psk.dpapi");
      const psk = toBase64(new Uint8Array(32).fill(3));
      await importDpapiPskValue(psk, path);
      expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
      const blob = await Bun.file(path).text();
      expect(blob).not.toContain(psk);
      expect(await readDpapiPsk(path)).toBe(psk);
    },
    30_000,
  );

  test.skipIf(!wsl)(
    "a corrupted blob reads as null rather than throwing",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "psk.dpapi");
      await writeFile(path, "AAAAgarbage==\n");
      expect(await readDpapiPsk(path)).toBeNull();
    },
    30_000,
  );

  test.skipIf(!wsl)(
    "doctor's round-trip probe reports healthy interop",
    async () => {
      expect(await dpapiRoundTrip()).toBeNull();
    },
    30_000,
  );
});
