import * as launchd from "./launchd.ts";
import * as systemd from "./systemd.ts";
import { isWsl } from "./wsl.ts";

// One dispatch point per lifecycle action: cli.ts stays platform-blind, and a
// future platform is a new module here, not edits across the CLI.

export interface InstallResult {
  readonly target: string;
  readonly notes: readonly string[];
}

function unsupported(action: string): Error {
  return new Error(
    `${action} needs a service manager — launchd on macOS or systemd on WSL; on plain Linux run seanced under your own supervisor`,
  );
}

export function servicePath(): string {
  if (process.platform === "darwin") return launchd.plistPath();
  if (isWsl()) return systemd.unitPath();
  return "(no service manager)";
}

export async function installService(): Promise<InstallResult> {
  if (process.platform === "darwin") return { target: await launchd.installService(), notes: [] };
  if (isWsl()) return systemd.installService();
  throw unsupported("seanced install");
}

export async function uninstallService(): Promise<readonly string[]> {
  if (process.platform === "darwin") {
    await launchd.uninstallService();
    return [];
  }
  if (isWsl()) return systemd.uninstallService();
  throw unsupported("seanced uninstall");
}

export async function serviceLoaded(): Promise<boolean> {
  if (process.platform === "darwin") return launchd.serviceLoaded();
  if (isWsl()) return systemd.serviceLoaded();
  return false;
}

export async function restartService(): Promise<void> {
  if (process.platform === "darwin") return launchd.restartService();
  if (isWsl()) return systemd.restartService();
  throw unsupported("seanced restart");
}
