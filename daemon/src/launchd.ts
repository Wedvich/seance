import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Check } from "./check.ts";
import { exec } from "./exec.ts";
import { logPath } from "./paths.ts";
import type { InstallResult } from "./service-types.ts";

export const LAUNCHD_LABEL = "io.seance.seanced";

export function servicePath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function xmlEscape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Runs the daemon from the git checkout via the installing Bun — update =
 * `git pull` + `seanced restart`. PATH is captured at install time because
 * launchd agents otherwise get /usr/bin:/bin, which has no tmux/claude.
 */
export function plistContent(bunPath: string, mainPath: string, pathEnv: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(bunPath)}</string>
    <string>${xmlEscape(mainPath)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logPath())}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath())}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(pathEnv)}</string>
  </dict>
</dict>
</plist>
`;
}

function gui(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export function assertMacos(action: string): void {
  if (process.platform !== "darwin") {
    throw new Error(`${action} reached the launchd path off macOS — service.ts owns platform dispatch`);
  }
}

/** `notes` is always empty: launchd needs no step the user has to finish by hand. */
export async function installService(): Promise<InstallResult> {
  assertMacos("seanced install");
  const mainPath = fileURLToPath(new URL("./main.ts", import.meta.url));
  const target = servicePath();
  await mkdir(dirname(target), { recursive: true });
  await mkdir(dirname(logPath()), { recursive: true });
  await Bun.write(target, plistContent(process.execPath, mainPath, process.env["PATH"] ?? ""));
  await exec(["launchctl", "bootout", `${gui()}/${LAUNCHD_LABEL}`]); // ignore failure: not loaded yet
  const bootstrap = await exec(["launchctl", "bootstrap", gui(), target]);
  if (bootstrap.exitCode !== 0) {
    throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr.trim()}`);
  }
  return { target, notes: [] };
}

/** Nothing is left behind, so there is never a note — unlike systemd's linger. */
export async function uninstallService(): Promise<readonly string[]> {
  assertMacos("seanced uninstall");
  await exec(["launchctl", "bootout", `${gui()}/${LAUNCHD_LABEL}`]);
  await exec(["rm", "-f", servicePath()]);
  return [];
}

export async function serviceLoaded(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const result = await exec(["launchctl", "print", `${gui()}/${LAUNCHD_LABEL}`]);
  return result.exitCode === 0;
}

export async function restartService(): Promise<void> {
  assertMacos("seanced restart");
  const result = await exec(["launchctl", "kickstart", "-k", `${gui()}/${LAUNCHD_LABEL}`]);
  if (result.exitCode !== 0) {
    throw new Error(`launchctl kickstart failed: ${result.stderr.trim()}`);
  }
}

/**
 * The self-update's restart. launchd caches job definitions, so a plist
 * rewrite here would not land until the next bootstrap — exiting clean and
 * letting KeepAlive relaunch on the new code is the whole mechanism.
 */
export function selfRestart(): Promise<void> {
  assertMacos("self-update restart");
  process.exit(0);
}

/** Doctor's macOS service section. One check — launchd needs no linger or pin task. */
export async function doctorServiceChecks(): Promise<readonly Check[]> {
  return (await serviceLoaded())
    ? [{ level: "ok", message: "launchd agent loaded" }]
    : [{ level: "warn", message: "launchd agent not loaded — run `seanced install`" }];
}
