import * as launchd from "./launchd.ts";
import * as systemd from "./systemd.ts";

// One dispatch point per lifecycle action: cli.ts stays platform-blind, and a
// future platform is a new module here, not edits across the CLI. Linux means
// systemd.ts on WSL and plain distros alike — WSL's extras are gated inside it.

export interface InstallResult {
  readonly target: string;
  /** Non-fatal steps that need a hand — each carries the manual command. */
  readonly notes: readonly string[];
}

function unsupported(action: string): Error {
  return new Error(
    `${action} needs a service manager — launchd on macOS or systemd on Linux/WSL; without systemd run seanced under your own supervisor`,
  );
}

export function servicePath(): string {
  if (process.platform === "darwin") return launchd.plistPath();
  if (process.platform === "linux") return systemd.unitPath();
  return "(no service manager)";
}

export async function installService(): Promise<InstallResult> {
  if (process.platform === "darwin") return { target: await launchd.installService(), notes: [] };
  if (process.platform === "linux") return systemd.installService();
  throw unsupported("seanced install");
}

export async function uninstallService(): Promise<readonly string[]> {
  if (process.platform === "darwin") {
    await launchd.uninstallService();
    return [];
  }
  if (process.platform === "linux") return systemd.uninstallService();
  throw unsupported("seanced uninstall");
}

export async function serviceLoaded(): Promise<boolean> {
  if (process.platform === "darwin") return launchd.serviceLoaded();
  if (process.platform === "linux") return systemd.serviceLoaded();
  return false;
}

export async function restartService(): Promise<void> {
  if (process.platform === "darwin") return launchd.restartService();
  if (process.platform === "linux") return systemd.restartService();
  throw unsupported("seanced restart");
}
