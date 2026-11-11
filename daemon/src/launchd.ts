import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAuditLog } from "./audit.ts";
import type { Check } from "./check.ts";
import { SHUTDOWN_DRAIN_MS } from "./drain-limits.ts";
import { exec, type ExecResult } from "./exec.ts";
import { recordedBunCheck, resolvedBun } from "./link.ts";
import { logPath } from "./paths.ts";
import type { InstallResult } from "./service-types.ts";

export const LAUNCHD_LABEL = "io.seance.seanced";

export function servicePath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function xmlEscape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function xmlUnescape(s: string): string {
  return s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** First ProgramArguments entry — the interpreter launchd will exec. Null when the plist doesn't parse. */
export function plistBunPath(plist: string): string | null {
  const match = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/u.exec(plist);
  const raw = match?.[1];
  return raw === undefined ? null : xmlUnescape(raw);
}

/**
 * Seconds launchd waits between SIGTERM and SIGKILL. Unset, it is "system-defined": 5 s on
 * macOS 26 (`launchctl print` shows `exit timeout = 5` for every agent that sets none), which
 * kills the daemon mid-drain, before `stop()` closes the relay socket. The 15 s past the drain
 * covers `stop()` and exit with room to spare. A system shutdown or logout may still cut
 * it short.
 */
export const LAUNCHD_EXIT_TIMEOUT_S = (SHUTDOWN_DRAIN_MS + 15_000) / 1000;

const EXIT_TIMEOUT_ENTRY = `<key>ExitTimeOut</key><integer>${LAUNCHD_EXIT_TIMEOUT_S}</integer>`;

/**
 * Runs the daemon from the git checkout via PATH's bun (never the realpath'd
 * keg, which a runtime upgrade deletes) — update = `git pull` + `seanced
 * restart`. PATH is captured at install time because launchd agents otherwise
 * get /usr/bin:/bin, which has no tmux/claude.
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
  ${EXIT_TIMEOUT_ENTRY}
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

/**
 * `bootout` SIGTERMs the daemon, which then drains task launches for up to `SHUTDOWN_DRAIN_MS` before it
 * exits; the job is unloaded only after, so the wait must outlast that, or `install` bootstraps over a
 * job still going down and leaves the agent unloaded. Sized from the `ExitTimeOut`, launchd's SIGKILL
 * ceiling, so it outlasts even a daemon that overruns its drain.
 */
const UNLOAD_WAIT_MS = LAUNCHD_EXIT_TIMEOUT_S * 1000 + 5_000;

/**
 * `bootout` returns before launchd has finished tearing the job down, and
 * bootstrapping into that window fails with EIO — which leaves the agent
 * unloaded, strictly worse than never having tried. `install` is what a machine
 * runs to repoint a *live* agent, so that window is the common path, not an edge
 * case. So: bootout, wait for the job to actually go, then bootstrap.
 */
async function bootstrapPass(target: string): Promise<ExecResult> {
  await exec(["launchctl", "bootout", `${gui()}/${LAUNCHD_LABEL}`]); // ignore failure: not loaded yet
  const deadline = Date.now() + UNLOAD_WAIT_MS;
  // oxlint-disable-next-line no-await-in-loop -- a poll is sequential by definition
  while ((await serviceLoaded()) && Date.now() < deadline) await Bun.sleep(50);
  return exec(["launchctl", "bootstrap", gui(), target]);
}

async function bootstrapFresh(target: string): Promise<void> {
  const first = await bootstrapPass(target);
  if (first.exitCode === 0) return;
  // A teardown slower than the wait is the only thing a second pass can fix, and
  // an agent left unloaded is worth one more try.
  const retry = await bootstrapPass(target);
  if (retry.exitCode !== 0) throw new Error(`launchctl bootstrap failed: ${retry.stderr.trim()}`);
}

/** `notes` is empty unless the log could not be prepared: launchd needs no step the user has to finish by hand. */
export async function installService(): Promise<InstallResult> {
  assertMacos("seanced install");
  const mainPath = fileURLToPath(new URL("./main.ts", import.meta.url));
  const target = servicePath();
  await mkdir(dirname(target), { recursive: true });
  // The redirect's directory stays a hard requirement: bootstrap succeeds
  // without it, but the job can't open its stdout and fails only at spawn time.
  await mkdir(dirname(logPath()), { recursive: true });
  // Before the bootstrap, so `StandardOutPath` opens a file that is already
  // there at 0600 — launchd creates it at the session's umask otherwise. Unlike
  // systemd's root-opened `append:`, the agent's opener is already the user
  // (per-login), so the mode, never the ownership, is what needs preparing here.
  const logProblem = await ensureAuditLog();
  await Bun.write(target, plistContent(resolvedBun(), mainPath, process.env["PATH"] ?? ""));
  await bootstrapFresh(target);
  return { target, notes: logProblem === null ? [] : [logProblem] };
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

/**
 * A plist written before `ExitTimeOut` was set (or with another value) leaves launchd's 5 s default,
 * which SIGKILLs mid-drain. Only `seanced install` rewrites the plist, so nothing else notices.
 * Null when the plist matches. Exported for tests.
 */
export function exitTimeoutCheck(plist: string): Check | null {
  if (plist.includes(EXIT_TIMEOUT_ENTRY)) return null;
  return {
    level: "warn",
    message: `plist lacks ExitTimeOut ${LAUNCHD_EXIT_TIMEOUT_S} s, so launchd kills the daemon mid-shutdown — \`seanced install\` rewrites it`,
  };
}

/** Doctor's macOS service section: the agent, whether the plist's bun still resolves, and its ExitTimeOut. */
export async function doctorServiceChecks(): Promise<readonly Check[]> {
  const loaded: Check = (await serviceLoaded())
    ? { level: "ok", message: "launchd agent loaded" }
    : { level: "warn", message: "launchd agent not loaded — run `seanced install`" };
  const plist = await Bun.file(servicePath())
    .text()
    .catch(() => null);
  if (plist === null) return [loaded];
  const drift = await recordedBunCheck(plistBunPath(plist));
  return [loaded, drift, exitTimeoutCheck(plist)].filter((check) => check !== null);
}
