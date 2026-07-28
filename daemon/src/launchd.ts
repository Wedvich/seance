import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "./exec.ts";
import { logPath } from "./paths.ts";

export const LAUNCHD_LABEL = "io.seance.seanced";

export function plistPath(): string {
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

export async function installService(): Promise<string> {
  assertMacos("seanced install");
  const mainPath = fileURLToPath(new URL("./main.ts", import.meta.url));
  const target = plistPath();
  await mkdir(dirname(target), { recursive: true });
  await mkdir(dirname(logPath()), { recursive: true });
  await Bun.write(target, plistContent(process.execPath, mainPath, process.env["PATH"] ?? ""));
  await exec(["launchctl", "bootout", `${gui()}/${LAUNCHD_LABEL}`]); // ignore failure: not loaded yet
  const bootstrap = await exec(["launchctl", "bootstrap", gui(), target]);
  if (bootstrap.exitCode !== 0) {
    throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr.trim()}`);
  }
  return target;
}

export async function uninstallService(): Promise<void> {
  assertMacos("seanced uninstall");
  await exec(["launchctl", "bootout", `${gui()}/${LAUNCHD_LABEL}`]);
  await exec(["rm", "-f", plistPath()]);
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
