import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exec, type ExecResult, execFailure } from "./exec.ts";
import { stateDir } from "./paths.ts";
import { isWsl, powershellExe } from "./wsl.ts";

/** DPAPI(CurrentUser) blob, base64 — the WSL counterpart of the macOS login keychain. */
export function dpapiPskPath(): string {
  return join(stateDir(), "psk.dpapi");
}

// Script text is static, so PowerShell script-block logging (event 4104) can
// capture it harmlessly: key and blob travel only as stdin/stdout data —
// never argv, which both OS process lists can read, and never script text.
const PROTECT_SCRIPT =
  "Add-Type -AssemblyName System.Security; " +
  "$k = [Console]::In.ReadToEnd().Trim(); " +
  "$b = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($k), $null, 'CurrentUser'); " +
  "[Console]::Out.Write([Convert]::ToBase64String($b))";

const UNPROTECT_SCRIPT =
  "Add-Type -AssemblyName System.Security; " +
  "$c = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($c, $null, 'CurrentUser')))";

function runPowershell(script: string, stdinData: string): Promise<ExecResult> {
  return exec([powershellExe(), "-NoProfile", "-NonInteractive", "-Command", script], {
    stdin: stdinData,
    timeoutMs: 15_000,
  });
}

/**
 * Reads the PSK from the DPAPI blob. Null when absent, undecryptable, or off
 * WSL — callers fall back to the config field. The existence check runs
 * before any interop spawn, so machines without a stored key never pay the
 * powershell round-trip.
 */
export async function readDpapiPsk(path: string = dpapiPskPath()): Promise<string | null> {
  if (!isWsl()) return null;
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const blob = (await file.text()).trim();
  if (blob === "") return null;
  const result = await runPowershell(UNPROTECT_SCRIPT, blob);
  if (result.exitCode !== 0) return null;
  const psk = result.stdout.trim();
  return psk === "" ? null : psk;
}

/**
 * Encrypts and stores a PSK that reached us over stdin or a tty read. Unlike
 * macOS `security`, DPAPI has no prompt of its own, so the key necessarily
 * transits this process — it still crosses to powershell as stdin data only.
 */
export async function importDpapiPskValue(psk: string, path: string = dpapiPskPath()): Promise<void> {
  const result = await runPowershell(PROTECT_SCRIPT, psk);
  const blob = result.stdout.trim();
  if (result.exitCode !== 0 || blob === "") {
    throw new Error(`DPAPI encrypt failed (${execFailure(result)})`);
  }
  await mkdir(dirname(path), { recursive: true });
  // Created 0600 outright — write-then-chmod would leave a umask-mode window.
  await writeFile(path, `${blob}\n`, { mode: 0o600 });
}

/**
 * Doctor's interop probe: a full protect/unprotect round-trip of a dummy
 * value. Null when healthy, otherwise what failed — this is what catches a
 * broken interop (binfmt clobbered, powershell missing) before it surfaces
 * as "no psk" at daemon start.
 */
export async function dpapiRoundTrip(): Promise<string | null> {
  const probe = "seance-doctor-probe";
  const enc = await runPowershell(PROTECT_SCRIPT, probe);
  if (enc.exitCode !== 0) return `DPAPI encrypt failed: ${execFailure(enc)}`;
  const dec = await runPowershell(UNPROTECT_SCRIPT, enc.stdout.trim());
  if (dec.exitCode !== 0) return `DPAPI decrypt failed: ${execFailure(dec)}`;
  return dec.stdout.trim() === probe ? null : "DPAPI round-trip returned a different value";
}
