import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exec, execFailure } from "./exec.ts";
import { stateDir } from "./paths.ts";
import { isWsl } from "./wsl.ts";

/** TPM2-sealed systemd-creds blob, base64 — the plain-Linux counterpart of the macOS login keychain. */
export function tpmPskPath(): string {
  return join(stateDir(), "psk.cred");
}

/**
 * Name embedded in the credential at encrypt time; decrypt must present the
 * same one, and a unit loading the blob must use it as the credential id
 * (credential.ts reads $CREDENTIALS_DIRECTORY under this name).
 */
export const CRED_NAME = "seance-psk";

// No PCR binding (--tpm2-pcrs=): a PCR-bound blob dies on the next firmware
// update, and the threat model here is at-rest exfiltration, not a tampered
// boot chain. Sealing to the TPM alone keeps the blob decryptable across
// updates while still useless off this machine. Both directions run as pure
// pipes (input "-", output "-") so the blob file is read and written by us —
// the key and blob cross to systemd-creds as stdin data, never argv.
function encryptArgv(name: string): readonly string[] {
  return ["systemd-creds", "encrypt", "--with-key=tpm2", "--tpm2-pcrs=", `--name=${name}`, "-", "-"];
}

function decryptArgv(name: string): readonly string[] {
  return ["systemd-creds", "decrypt", `--name=${name}`, "-", "-"];
}

let cached: Promise<boolean> | null = null;

/**
 * True only on plain Linux with a usable TPM 2.0: /dev/tpmrm0 present,
 * systemd-creds on PATH, and `has-tpm2` reporting full support. Memoized —
 * hardware does not change under a running process. `has-tpm2` exits non-zero
 * on partial support, which an LXC guest reports even with a working seal path
 * (masked /sys firmware info — verified 2026-08-10, see DESIGN.md). The gate
 * stays strict anyway: it guards *import*, and systemd >= 256 refuses
 * unprivileged seal/unseal regardless, so the container path is a system unit
 * delivering the key via LoadCredentialEncrypted= (credential.ts) — `loadPsk`
 * reads the blob without consulting this probe.
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

const CREDS_TIMEOUT_MS = 15_000;

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
  const result = await exec(decryptArgv(CRED_NAME), { stdin: blob, timeoutMs: CREDS_TIMEOUT_MS });
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
  const enc = await exec(encryptArgv(CRED_NAME), { stdin: psk, timeoutMs: CREDS_TIMEOUT_MS });
  const blob = enc.stdout.trim();
  if (enc.exitCode !== 0 || blob === "") {
    throw new Error(`systemd-creds encrypt failed (${execFailure(enc)})`);
  }
  // Decrypt the fresh blob in memory before it replaces the file: encrypt can
  // succeed where decrypt fails (systemd >= 256 refuses unprivileged unseal,
  // TPM lockout), and that asymmetry must not clobber a previously working
  // credential.
  const dec = await exec(decryptArgv(CRED_NAME), { stdin: blob, timeoutMs: CREDS_TIMEOUT_MS });
  if (dec.exitCode !== 0 || dec.stdout.trim() !== psk) {
    throw new Error(
      `sealed blob does not decrypt back (${execFailure(dec)}) — existing blob left untouched, check \`seanced doctor\``,
    );
  }
  await mkdir(dirname(path), { recursive: true });
  // Created 0600 outright — write-then-chmod would leave a umask-mode window,
  // and unlike DPAPI the file mode is this blob's only user-binding.
  await writeFile(path, `${blob}\n`, { mode: 0o600 });
}

/**
 * Doctor's seal probe: a full seal/unseal round-trip of a dummy value, no
 * file involved. Null when healthy, otherwise what failed — this is what
 * catches a TPM the daemon user cannot open (uid/gid mapping in an
 * unprivileged container) before it surfaces as "no psk" at daemon start.
 */
export async function tpmRoundTrip(): Promise<string | null> {
  const probe = "seance-doctor-probe";
  const enc = await exec(encryptArgv(CRED_NAME), { stdin: probe, timeoutMs: CREDS_TIMEOUT_MS });
  if (enc.exitCode !== 0) return `systemd-creds encrypt failed: ${execFailure(enc)}`;
  const dec = await exec(decryptArgv(CRED_NAME), { stdin: enc.stdout.trim(), timeoutMs: CREDS_TIMEOUT_MS });
  if (dec.exitCode !== 0) return `systemd-creds decrypt failed: ${execFailure(dec)}`;
  return dec.stdout.trim() === probe ? null : "TPM seal round-trip returned a different value";
}
