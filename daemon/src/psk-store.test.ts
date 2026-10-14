import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tpmStore } from "./psk-store.ts";
import { isWsl } from "./wsl.ts";

const dir = mkdtempSync(join(tmpdir(), "seance-psk-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The tpm probe is Linux-only, and a garbage blob never decrypts, so this
// exercises the "blob here, this shell can't unseal it" path with or without a TPM.
describe.skipIf(process.platform !== "linux" || isWsl())("tpm store doctor, undecryptable blob", () => {
  const blob = join(dir, "psk.cred");
  writeFileSync(blob, "not a credential");

  test("a system unit delivering it makes the blob an ok line, not a warning", async () => {
    const checks = await tpmStore(blob, () => Promise.resolve(true)).doctor();
    expect(checks.map((c) => c.level)).toEqual(["ok"]);
    expect(checks[0]?.message).toContain("unsealed by systemd for the system unit");
  });

  test("no delivering unit keeps the warning", async () => {
    const checks = await tpmStore(blob, () => Promise.resolve(false)).doctor();
    expect(checks.map((c) => c.level)).toEqual(["warn"]);
  });
});
