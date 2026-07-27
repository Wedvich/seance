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
