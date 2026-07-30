import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "./exec.ts";
import { logPath } from "./paths.ts";
import type { InstallResult, ServiceCheck } from "./service-types.ts";
import { isWsl, schtasksExe } from "./wsl.ts";

export const UNIT_NAME = "seanced.service";

/** Windows scheduled task that boots the distro at logon and pins the VM against its idle timeout. */
export const PIN_TASK_NAME = "SeanceWslPin";

export function unitPath(): string {
  return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "systemd", "user", UNIT_NAME);
}

/** systemd expands % specifiers inside unit values; paths and PATH must stay literal. */
function unitEscape(s: string): string {
  return s.replaceAll("%", "%%");
}

/**
 * Mirrors the launchd plist: run from the checkout via the installing Bun,
 * PATH captured at install time (a user unit's default PATH has no
 * tmux/claude), stdout/stderr appended to the same log file launchd
 * redirects to — journald would fork the audit trail per platform.
 */
export function unitContent(bunPath: string, mainPath: string, pathEnv: string): string {
  return `[Unit]
Description=Seance daemon (seanced)

[Service]
ExecStart="${unitEscape(bunPath)}" "${unitEscape(mainPath)}"
Restart=on-failure
RestartSec=5
Environment="PATH=${unitEscape(pathEnv)}"
StandardOutput=append:${unitEscape(logPath())}
StandardError=append:${unitEscape(logPath())}

[Install]
WantedBy=default.target
`;
}

/**
 * A bare wsl.exe logon task opens a console window that lives as long as the
 * pin; conhost --headless runs it with no window at all. Exported for tests
 * and for printing as the manual fallback.
 */
export function pinTaskCommand(distro: string): string {
  return `conhost.exe --headless wsl.exe -d ${distro} --exec sleep infinity`;
}

function manualTaskCommand(distro: string): string {
  return `schtasks /Create /F /SC ONLOGON /TN ${PIN_TASK_NAME} /TR "${pinTaskCommand(distro)}"`;
}

/**
 * `is-system-running` answers over the bus even when degraded; a missing bus
 * has two distinct causes worth naming. No `/run/systemd/system` (sd_booted's
 * check) means the box doesn't run systemd — on WSL only wsl.conf fixes that
 * (never flipped here: it restarts the distro, killing every session on the
 * box); elsewhere seanced needs a manual supervisor. With systemd as PID 1
 * the culprit is user@<uid> never starting: WSL shells skip PAM and headless
 * boxes (LXC, containers) never log in, so no logind session exists to start
 * it and linger is the only trigger. Message builders are exported for tests.
 */
export function userInstanceMissingMessage(wsl: boolean, username: string): string {
  const why = wsl ? "WSL sessions don't register with logind" : "a headless box has no logind session";
  return (
    `systemd is running but the user instance is not — ${why}, so only linger starts it: ` +
    `run \`sudo loginctl enable-linger ${username}\`, then re-run \`seanced install\``
  );
}

export function noSystemdMessage(wsl: boolean): string {
  return wsl
    ? "systemd is not running in this distro — add [boot] systemd=true to /etc/wsl.conf, " +
        "run `wsl.exe --shutdown` from Windows (kills every session on the box), then re-run `seanced install`"
    : "this system is not running systemd — run seanced under your own supervisor";
}

/** sd_booted(3)'s check: /run/systemd/system exists iff systemd is PID 1. */
export function systemdRunning(): boolean {
  return existsSync("/run/systemd/system");
}

async function assertSystemdRunning(): Promise<void> {
  if (!systemdRunning()) throw new Error(noSystemdMessage(isWsl()));
  // A reachable user manager reports its state on stdout (`running`, `degraded`,
  // …) even when it exits nonzero; no state at all means the bus connect failed.
  // Don't parse the stderr wording — systemd 257 rephrased it.
  const result = await exec(["systemctl", "--user", "is-system-running"]);
  if (result.exitCode !== 0 && result.stdout.trim() === "") {
    throw new Error(userInstanceMissingMessage(isWsl(), userInfo().username));
  }
}

export async function installService(): Promise<InstallResult> {
  await assertSystemdRunning();
  const notes: string[] = [];
  const mainPath = fileURLToPath(new URL("./main.ts", import.meta.url));
  const target = unitPath();
  await mkdir(dirname(target), { recursive: true });
  await mkdir(dirname(logPath()), { recursive: true });
  await Bun.write(target, unitContent(process.execPath, mainPath, process.env["PATH"] ?? ""));
  const reload = await exec(["systemctl", "--user", "daemon-reload"]);
  if (reload.exitCode !== 0) {
    throw new Error(`systemctl --user daemon-reload failed: ${reload.stderr.trim()}`);
  }
  const enable = await exec(["systemctl", "--user", "enable", "--now", UNIT_NAME]);
  if (enable.exitCode !== 0) {
    throw new Error(`systemctl --user enable --now failed: ${enable.stderr.trim()}`);
  }

  const username = userInfo().username;
  if (Bun.which("loginctl") === null) {
    notes.push(
      `loginctl not found — without linger the daemon dies with your last session; run: sudo loginctl enable-linger ${username}`,
    );
  } else {
    const linger = await exec(["loginctl", "enable-linger", username]);
    if (linger.exitCode !== 0) {
      notes.push(
        `loginctl enable-linger failed (${linger.stderr.trim() || "denied"}) — without it the daemon dies with your last session; run: sudo loginctl enable-linger ${username}`,
      );
    }
  }

  if (isWsl()) {
    const distro = process.env["WSL_DISTRO_NAME"];
    if (distro === undefined) {
      notes.push(
        `WSL_DISTRO_NAME not set — register the logon pin task from a Windows shell yourself: ${manualTaskCommand("<distro>")}`,
      );
    } else {
      const task = await exec([
        schtasksExe(),
        "/Create",
        "/F",
        "/SC",
        "ONLOGON",
        "/TN",
        PIN_TASK_NAME,
        "/TR",
        pinTaskCommand(distro),
      ]);
      if (task.exitCode !== 0) {
        notes.push(
          `scheduled-task registration failed (${task.stderr.trim() || "denied"}) — without it a Windows reboot leaves the machine offline; run from a Windows shell: ${manualTaskCommand(distro)}`,
        );
      }
    }
  }
  return { target, notes };
}

export async function uninstallService(): Promise<readonly string[]> {
  if (!systemdRunning()) throw new Error(noSystemdMessage(isWsl()));
  const notes: string[] = [];
  await exec(["systemctl", "--user", "disable", "--now", UNIT_NAME]); // ignore failure: not installed
  await rm(unitPath(), { force: true });
  await exec(["systemctl", "--user", "daemon-reload"]);
  if (isWsl()) {
    const task = await exec([schtasksExe(), "/Delete", "/F", "/TN", PIN_TASK_NAME]);
    if (task.exitCode !== 0) {
      notes.push(`pin task not removed — from a Windows shell: schtasks /Delete /F /TN ${PIN_TASK_NAME}`);
    }
  }
  notes.push(
    `linger left enabled (it may serve other units) — sudo loginctl disable-linger ${userInfo().username} to revert`,
  );
  return notes;
}

export async function serviceLoaded(): Promise<boolean> {
  if (!systemdRunning()) return false;
  const result = await exec(["systemctl", "--user", "is-active", UNIT_NAME]);
  return result.exitCode === 0;
}

export async function restartService(): Promise<void> {
  if (!systemdRunning()) throw new Error(noSystemdMessage(isWsl()));
  const result = await exec(["systemctl", "--user", "restart", UNIT_NAME]);
  if (result.exitCode !== 0) {
    throw new Error(`systemctl --user restart failed: ${result.stderr.trim()}`);
  }
}

/** Doctor's Linux service section — kept here so cli.ts doesn't grow systemctl/schtasks plumbing. */
export async function doctorServiceChecks(): Promise<readonly ServiceCheck[]> {
  const checks: ServiceCheck[] = [];
  if (await serviceLoaded()) {
    checks.push({ ok: true, message: `systemd unit ${UNIT_NAME} active` });
  } else {
    checks.push({
      ok: false,
      message: "systemd unit not active — run `seanced install` (its preflight names what's missing)",
    });
  }
  const username = userInfo().username;
  if (Bun.which("loginctl") === null) {
    checks.push({
      ok: false,
      message: "loginctl not found — can't check linger; without it the daemon dies with your last session",
    });
  } else {
    const linger = await exec(["loginctl", "show-user", username, "--property=Linger"]);
    if (linger.stdout.trim() === "Linger=yes") {
      checks.push({ ok: true, message: "linger enabled — unit starts without a login session" });
    } else {
      checks.push({
        ok: false,
        message: `linger off — daemon dies with your last session: sudo loginctl enable-linger ${username}`,
      });
    }
  }
  if (isWsl()) {
    const task = await exec([schtasksExe(), "/Query", "/TN", PIN_TASK_NAME]);
    if (task.exitCode === 0) {
      checks.push({ ok: true, message: `logon pin task ${PIN_TASK_NAME} registered` });
    } else {
      // install's own registration may be denied (interop schtasks runs non-elevated), so point at the manual command directly
      checks.push({
        ok: false,
        message:
          `no ${PIN_TASK_NAME} scheduled task — a Windows reboot leaves the machine offline; ` +
          `from a Windows shell: ${manualTaskCommand(process.env["WSL_DISTRO_NAME"] ?? "<distro>")}`,
      });
    }
  }
  return checks;
}
