import { userInfo } from "node:os";
import { exec } from "./exec.ts";

/** Generic-password service name for the PSK in the macOS login keychain. */
export const PSK_SERVICE = "seance-psk";

/**
 * Reads the PSK from the macOS login keychain. Null when absent, unreadable, or
 * off macOS — callers fall back to the config field, which is the only path WSL
 * has. Both read and write go through `/usr/bin/security`, so the ACL entry
 * `security` records on create is the same one it presents on read and the
 * daemon is never prompted.
 */
export async function readKeychainPsk(service: string = PSK_SERVICE): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const result = await exec(["security", "find-generic-password", "-s", service, "-w"], { timeoutMs: 10_000 });
  if (result.exitCode !== 0) return null;
  const psk = result.stdout.trim();
  return psk === "" ? null : psk;
}

/**
 * Hands the terminal to `security` so the key is typed at its own prompt —
 * trailing `-w` with no value is the documented way to be prompted. Passing
 * `-w <psk>` would put the key in argv, where any local `ps` reads it.
 */
export async function importKeychainPsk(service: string = PSK_SERVICE): Promise<void> {
  const proc = Bun.spawn(["security", "add-generic-password", "-U", "-a", userInfo().username, "-s", service, "-w"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`security add-generic-password exited ${code}`);
  }
}

/**
 * The `security -i` command line that stores a known PSK value. Double quotes
 * are safe: callers validate the value as base64 first, and the base64
 * alphabet (`A–Z a–z 0–9 + / =`) contains no quote, backslash, or whitespace.
 * Exported for tests.
 */
export function pskImportCommand(psk: string, account: string, service: string): string {
  return `add-generic-password -U -a "${account}" -s "${service}" -w "${psk}"`;
}

/**
 * Stores a PSK that arrived on our own stdin (e.g. piped from `op`). The
 * interactive path above can't take a pipe — `security`'s prompt reads
 * /dev/tty, not stdin — so this runs `security -i`, where the whole command
 * including `-w <psk>` travels over security's stdin: still never in argv,
 * never in shell history.
 */
export async function importKeychainPskValue(psk: string, service: string = PSK_SERVICE): Promise<void> {
  const proc = Bun.spawn(["security", "-i"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "inherit",
  });
  proc.stdin.write(`${pskImportCommand(psk, userInfo().username, service)}\n`);
  await proc.stdin.end();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`security -i exited ${code}`);
  }
}
