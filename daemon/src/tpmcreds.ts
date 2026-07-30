import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exec } from "./exec.ts";
import { stateDir } from "./paths.ts";
import { isWsl } from "./wsl.ts";

/** TPM2-sealed systemd-creds blob, base64 — the plain-Linux counterpart of the macOS login keychain. */
export function tpmPskPath(): string {
  return join(stateDir(), "psk.cred");
}

/** Name embedded in the credential at encrypt time; decrypt must present the same one. */
const CRED_NAME = "seance-psk";

// No PCR binding (--tpm2-pcrs=): a PCR-bound blob dies on the next firmware
// update, and the threat model here is at-rest exfiltration, not a tampered
// boot chain. Sealing to the TPM alone keeps the blob decryptable across
// updates while still useless off this machine.
const ENCRYPT_ARGV = ["systemd-creds", "encrypt", "--with-key=tpm2", "--tpm2-pcrs=", `--name=${CRED_NAME}`, "-", "-"];
const DECRYPT_ARGV = ["systemd-creds", "decrypt", `--name=${CRED_NAME}`, "-", "-"];

let cached: Promise<boolean> | null = null;

/**
 * True only on plain Linux with a usable TPM 2.0: /dev/tpmrm0 present,
 * systemd-creds on PATH, and `has-tpm2` reporting full support. Memoized —
 * hardware does not change under a running process. `has-tpm2` exits non-zero
 * on partial support; if an LXC guest masks /sys firmware info this probe may
 * need loosening (unverified on hardware, see DESIGN.md).
 */
export function tpmAvailable(): Promise<boolean> {
  cached ??= probeTpm();
  return cached;
}

async function probeTpm(): Promise<boolean> {
  if (process.platform !== "linux" || isWsl()) return false;
  if (!existsSync("/dev/tpmrm0")) return false;
  if (Bun.which("systemd-creds") === null) return false;
  const result = await exec(["systemd-creds", "has-tpm2"], { timeoutMs: 10_000 });
  return result.exitCode === 0;
}

interface CredsResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Not exec(): that pins stdin to "ignore", and stdin is the whole point here.
 * Both directions run as pure pipes (input "-", output "-") so the blob file
 * is read and written by us — the key and blob never touch argv.
 */
async function runSystemdCreds(argv: readonly string[], stdinData: string, timeoutMs = 15_000): Promise<CredsResult> {
  const proc = Bun.spawn([...argv], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(stdinData);
  await proc.stdin.end();
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

/**
 * Reads the PSK from the TPM-sealed blob. Null when absent, undecryptable, or
 * the machine has no TPM tooling — callers fall back to the config field. The
 * existence check runs before any spawn, so machines without a stored key
 * never pay the unseal round-trip. A blob restored onto different hardware
 * lands here as null: machine-bound by design, doctor explains it.
 */
export async function readTpmPsk(path: string = tpmPskPath()): Promise<string | null> {
  if (process.platform !== "linux" || isWsl()) return null;
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const blob = (await file.text()).trim();
  if (blob === "") return null;
  if (Bun.which("systemd-creds") === null) return null;
  const result = await runSystemdCreds(DECRYPT_ARGV, blob);
  if (result.exitCode !== 0) return null;
  const psk = result.stdout.trim();
  return psk === "" ? null : psk;
}

/**
 * Seals and stores a PSK that reached us over stdin or a tty read. Like DPAPI
 * and unlike macOS `security`, systemd-creds has no prompt of its own, so the
 * key necessarily transits this process — it crosses to systemd-creds as
 * stdin data only.
 */
export async function importTpmPskValue(psk: string, path: string = tpmPskPath()): Promise<void> {
  const result = await runSystemdCreds(ENCRYPT_ARGV, psk);
  const blob = result.stdout.trim();
  if (result.exitCode !== 0 || blob === "") {
    throw new Error(`systemd-creds encrypt failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${blob}\n`);
  await chmod(path, 0o600);
}

/**
 * Doctor's seal probe: a full seal/unseal round-trip of a dummy value, no
 * file involved. Null when healthy, otherwise what failed — this is what
 * catches a TPM the daemon user cannot open (uid/gid mapping in an
 * unprivileged container) before it surfaces as "no psk" at daemon start.
 */
export async function tpmRoundTrip(): Promise<string | null> {
  const probe = "seance-doctor-probe";
  const enc = await runSystemdCreds(
    ["systemd-creds", "encrypt", "--with-key=tpm2", "--tpm2-pcrs=", "--name=seance-doctor-probe", "-", "-"],
    probe,
  );
  if (enc.exitCode !== 0) return `systemd-creds encrypt failed: ${enc.stderr.trim()}`;
  const dec = await runSystemdCreds(
    ["systemd-creds", "decrypt", "--name=seance-doctor-probe", "-", "-"],
    enc.stdout.trim(),
  );
  if (dec.exitCode !== 0) return `systemd-creds decrypt failed: ${dec.stderr.trim()}`;
  return dec.stdout.trim() === probe ? null : "TPM seal round-trip returned a different value";
}
