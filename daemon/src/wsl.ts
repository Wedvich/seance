import { readFileSync } from "node:fs";

let cached: boolean | null = null;

/**
 * Reads /proc/version rather than WSL_* env vars: a systemd user unit
 * inherits neither WSL_DISTRO_NAME nor WSL_INTEROP, and interop itself works
 * without them — the binfmt handler finds init's socket (verified on WSL
 * 2.7.11, 2026-07-28).
 */
export function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (cached === null) {
    try {
      cached = readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
    } catch {
      cached = false;
    }
  }
  return cached;
}

// PATH normally carries /mnt/c entries (appendWindowsPath default); the
// absolute fallbacks cover a stripped environment such as a systemd unit
// before install captured PATH. They assume the default C: automount root.

export function powershellExe(): string {
  return Bun.which("powershell.exe") ?? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
}

export function schtasksExe(): string {
  return Bun.which("schtasks.exe") ?? "/mnt/c/Windows/System32/schtasks.exe";
}
