import type { Check } from "./check.ts";
import * as launchd from "./launchd.ts";
import type { InstallResult } from "./service-types.ts";
import * as systemd from "./systemd.ts";
import { isWsl } from "./wsl.ts";

// One dispatch point per lifecycle action: cli.ts stays platform-blind, and a
// future platform is a new module here, not edits across the CLI. Linux means
// systemd.ts on WSL and plain distros alike — WSL's extras are gated inside it,
// and systemd.ts's entry points all self-guard on systemdRunning(), so a
// systemd-less box gets its WSL-aware message rather than a raw spawn error.

export type { InstallResult } from "./service-types.ts";

function unsupported(action: string): Error {
  return new Error(
    `${action} needs a service manager — launchd on macOS or systemd on Linux/WSL; without systemd run seanced under your own supervisor`,
  );
}

export function servicePath(): string {
  if (process.platform === "darwin") return launchd.plistPath();
  if (process.platform === "linux" && systemd.systemdRunning()) return systemd.unitPath();
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

export async function doctorServiceChecks(): Promise<readonly Check[]> {
  if (process.platform === "darwin") {
    return (await launchd.serviceLoaded())
      ? [{ level: "ok", message: "launchd agent loaded" }]
      : [{ level: "warn", message: "launchd agent not loaded — run `seanced install`" }];
  }
  if (process.platform === "linux") {
    return systemd.systemdRunning()
      ? systemd.doctorServiceChecks()
      : [{ level: "warn", message: systemd.noSystemdMessage(isWsl()) }];
  }
  return [{ level: "warn", message: "no service manager integration here — run seanced under your own supervisor" }];
}
