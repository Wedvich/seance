import type { Check } from "./check.ts";

// Leaf module so the service.ts dispatcher and its per-platform backends can
// share these shapes without importing each other.

export interface InstallResult {
  readonly target: string;
  /** Non-fatal steps that need a hand — each carries the manual command. */
  readonly notes: readonly string[];
}

/** What `servicePath()` reports where nothing supervises the daemon. */
export const NO_SERVICE_MANAGER = "(no service manager)";

/**
 * What every lifecycle backend answers, so `service.ts` dispatches on platform
 * once instead of adapting six return shapes. Not an extension point — DESIGN.md
 * declines a third init system — but it is what stops launchd and systemd
 * drifting apart under the dispatcher, which they had already started to do.
 */
export interface ServiceManager {
  /** Where the unit or plist lives, or `NO_SERVICE_MANAGER` when this box has no supervisor. */
  readonly servicePath: () => string;
  /** Installs and starts the service; notes carry any step the user must finish by hand. */
  readonly installService: () => Promise<InstallResult>;
  /** Stops and removes the service, returning anything deliberately left behind. */
  readonly uninstallService: () => Promise<readonly string[]>;
  /** Whether the supervisor currently has the service loaded. False off-platform, never throws. */
  readonly serviceLoaded: () => Promise<boolean>;
  readonly restartService: () => Promise<void>;
  /** Doctor's service section for this platform. */
  readonly doctorServiceChecks: () => Promise<readonly Check[]>;
}
