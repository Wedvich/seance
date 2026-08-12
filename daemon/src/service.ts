import type { Check } from "./check.ts";
import * as launchd from "./launchd.ts";
import { NO_SERVICE_MANAGER, type InstallResult, type ServiceManager } from "./service-types.ts";
import * as systemd from "./systemd.ts";
import type { SystemInstallOptions } from "./systemd.ts";

// One dispatch point for every lifecycle action: cli.ts stays platform-blind,
// and a future platform is a new module here, not edits across the CLI. Linux
// means systemd.ts on WSL and plain distros alike — WSL's extras are gated
// inside it, and systemd.ts's entry points all self-guard on systemdRunning(),
// so a systemd-less box gets its WSL-aware message rather than a raw spawn
// error. Both modules satisfy ServiceManager, which is what keeps them from
// drifting into return shapes this file would have to adapt.

export type { InstallResult, ServiceManager } from "./service-types.ts";
export type { SystemInstallOptions } from "./systemd.ts";

/** Null off the two supported platforms; callers turn that into the message the action deserves. */
function manager(): ServiceManager | null {
  if (process.platform === "darwin") return launchd;
  if (process.platform === "linux") return systemd;
  return null;
}

function unsupported(action: string): Error {
  return new Error(
    `${action} needs a service manager — launchd on macOS or systemd on Linux/WSL; without systemd run seanced under your own supervisor`,
  );
}

export function servicePath(): string {
  return manager()?.servicePath() ?? NO_SERVICE_MANAGER;
}

export async function installService(): Promise<InstallResult> {
  const service = manager();
  if (service === null) throw unsupported("seanced install");
  return service.installService();
}

export async function uninstallService(): Promise<readonly string[]> {
  const service = manager();
  if (service === null) throw unsupported("seanced uninstall");
  return service.uninstallService();
}

/**
 * System scope stays off `ServiceManager` for the reason `serviceDeliversPsk`
 * does: it exists to satisfy `LoadCredentialEncrypted=`, which only systemd has,
 * and a launchd daemon is a different thing with a different threat model
 * (DESIGN.md declines it). So these two are Linux-only by signature.
 */
export async function installSystemService(opts: SystemInstallOptions): Promise<InstallResult> {
  if (process.platform !== "linux") throw new Error("`install --system` is a systemd arrangement — see docs/psk.md");
  return systemd.installSystemService(opts);
}

export async function uninstallSystemService(): Promise<readonly string[]> {
  if (process.platform !== "linux") throw new Error("`uninstall --system` is a systemd arrangement — see docs/psk.md");
  return systemd.uninstallSystemService();
}

export async function serviceLoaded(): Promise<boolean> {
  return (await manager()?.serviceLoaded()) ?? false;
}

export async function restartService(): Promise<void> {
  const service = manager();
  if (service === null) throw unsupported("seanced restart");
  return service.restartService();
}

/** With no service manager, exit clean and let whatever supervises apply its restart policy. */
export async function selfRestartService(): Promise<void> {
  const service = manager();
  if (service === null) process.exit(0);
  return service.selfRestart();
}

/**
 * Whether the platform supervisor started this process. systemd sets
 * INVOCATION_ID on every unit start; launchd sets XPC_SERVICE_NAME to the job
 * label. A manual foreground run has neither — and self-update must stay off
 * there, because its restart would either exit a process nothing relaunches or
 * bounce the *service* while this terminal keeps serving old code and reports
 * success.
 */
export function startedBySupervisor(): boolean {
  if (process.platform === "linux") return (process.env["INVOCATION_ID"] ?? "") !== "";
  if (process.platform === "darwin") return (process.env["XPC_SERVICE_NAME"] ?? "").includes(launchd.LAUNCHD_LABEL);
  return false;
}

/**
 * Whether the service definition hands the daemon its PSK at start rather than
 * leaving it to be resolved. Deliberately not on `ServiceManager`: only the
 * hand-written systemd system unit does this (docs/psk.md), and launchd has no
 * counterpart to implement.
 */
export async function serviceDeliversPsk(): Promise<boolean> {
  return process.platform === "linux" ? systemd.systemUnitDeliversPsk() : false;
}

export async function doctorServiceChecks(): Promise<readonly Check[]> {
  return (
    (await manager()?.doctorServiceChecks()) ?? [
      { level: "warn", message: "no service manager integration here — run seanced under your own supervisor" },
    ]
  );
}
