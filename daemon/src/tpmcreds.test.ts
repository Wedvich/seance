import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toBase64 } from "@seance/shared";
import { importTpmPskValue, readTpmPsk, tpmAvailable, tpmRoundTrip } from "./tpmcreds.ts";

const hasTpm = await tpmAvailable();

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "seance-tpm-"));
  cleanups.push(dir);
  return dir;
}

// The seal/unseal paths need a real TPM 2.0 device, so they run only on a box
// that has one — where they are the real thing, not a double. This mirrors
// dpapi.test.ts, whose gated tests likewise verify the real interop per run.
describe("tpmcreds", () => {
  test.skipIf(process.platform === "linux")("unavailable off Linux", async () => {
    expect(await tpmAvailable()).toBe(false);
  });

  test("a missing blob reads as null without touching systemd-creds", async () => {
    const dir = await tempDir();
    expect(await readTpmPsk(join(dir, "absent.cred"))).toBeNull();
  });

  test("an empty blob reads as null without touching systemd-creds", async () => {
    const dir = await tempDir();
    const path = join(dir, "psk.cred");
    await writeFile(path, "\n");
    expect(await readTpmPsk(path)).toBeNull();
  });

  test.skipIf(!hasTpm)(
    "round-trips a key and stores the blob 0600",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "psk.cred");
      const psk = toBase64(new Uint8Array(32).fill(3));
      await importTpmPskValue(psk, path);
      expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
      const blob = await Bun.file(path).text();
      expect(blob).not.toContain(psk);
      expect(await readTpmPsk(path)).toBe(psk);
    },
    30_000,
  );

  test.skipIf(!hasTpm)(
    "a corrupted blob reads as null rather than throwing",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "psk.cred");
      await writeFile(path, "AAAAgarbage==\n");
      expect(await readTpmPsk(path)).toBeNull();
    },
    30_000,
  );

  test.skipIf(!hasTpm)(
    "doctor's round-trip probe reports a healthy seal path",
    async () => {
      expect(await tpmRoundTrip()).toBeNull();
    },
    30_000,
  );
});
