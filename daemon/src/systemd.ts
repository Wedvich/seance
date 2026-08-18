import { existsSync } from "node:fs";
import { chmod, chown, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIT_LOG_MODE, ensureAuditLog } from "./audit.ts";
import { exec } from "./exec.ts";
import { recordedBunCheck, resolvedBun } from "./link.ts";
import { configDirFor, logPath, logPathIn, pskBlobPathIn, stateDir, stateDirFor } from "./paths.ts";
import {
  lookupUser,
  mkdirAsTarget,
  missingBinariesMessage,
  missingUnitBinaries,
  requireRoot,
  targetUserName,
  whichIn,
} from "./target-user.ts";
import { blobLoadable, CRED_NAME } from "./tpmcreds.ts";
import type { Check } from "./check.ts";
import { NO_SERVICE_MANAGER, type InstallResult } from "./service-types.ts";
import { isWsl, schtasksExe } from "./wsl.ts";

export const UNIT_NAME = "seanced.service";

/** Windows scheduled task that boots the distro at logon and pins the VM against its idle timeout. */
export const PIN_TASK_NAME = "SeanceWslPin";

/**
 * Which systemd manager owns the unit. `user` is every box that resolves its own
 * PSK; `system` exists for one reason — systemd >= 256 refuses unprivileged
 * TPM unseal, so PID 1 has to unseal the blob and deliver it into the service
 * (docs/psk.md), and only a system unit can be given `LoadCredentialEncrypted=`.
 */
export type UnitScope = "user" | "system";

export function unitPathFor(scope: UnitScope): string {
  return scope === "system"
    ? join("/etc/systemd/system", UNIT_NAME)
    : join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "systemd", "user", UNIT_NAME);
}

export function unitPath(): string {
  return unitPathFor("user");
}

/** `--user` or `--system`, so no call site spells the scope itself. */
function scopeArgv(scope: UnitScope): readonly string[] {
  return ["systemctl", `--${scope}`];
}

/**
 * The unit path only where systemd could load it, and in the scope that is
 * actually installed. A box without a running instance has no service to point
 * at, and naming the file there would read as "installed" in `seanced status`.
 */
export function servicePath(): string {
  if (!systemdRunning()) return NO_SERVICE_MANAGER;
  return unitPathFor(installedUnits().system ? "system" : "user");
}

export function systemUnitPath(): string {
  return unitPathFor("system");
}

export interface InstalledUnits {
  readonly user: boolean;
  readonly system: boolean;
}

/**
 * Which unit files exist. This is what the *unprivileged* CLI reads: a delivered
 * key is unreachable from a shell, so the file is the only evidence status and
 * doctor have of which manager owns the daemon. Not persisted anywhere — a
 * recorded scope would go stale against a unit someone edited by hand, which is
 * precisely the box this serves. Both present is a real state and reported as
 * one, never silently resolved: two daemons would share one state dir, one log
 * and one relay identity.
 */
export function installedUnits(userFile: string = unitPath(), systemFile: string = systemUnitPath()): InstalledUnits {
  return { user: existsSync(userFile), system: existsSync(systemFile) };
}

/**
 * The daemon's own scope, from its cgroup — the one signal available inside the
 * process, which is where `selfRestart` needs it and where no CLI flag reaches.
 * A system unit sits at `/system.slice/seanced.service`; a user unit under
 * `/user.slice/user-<uid>.slice/user@<uid>.service/…` (verified on a systemd 257
 * box, which also confirmed `MANAGERPID` is absent under a system unit — the
 * cgroup is preferred because it names the scope rather than inferring it from
 * an absence). Null when the text is neither, so callers fall back to the files.
 */
export function scopeFromCgroup(cgroup: string): UnitScope | null {
  if (/\/user@\d+\.service\//u.test(cgroup)) return "user";
  if (/\/system\.slice\//u.test(cgroup)) return "system";
  return null;
}

async function runningScope(): Promise<UnitScope> {
  const cgroup = await Bun.file("/proc/self/cgroup")
    .text()
    .catch(() => null);
  const fromCgroup = cgroup === null ? null : scopeFromCgroup(cgroup);
  if (fromCgroup !== null) return fromCgroup;
  return installedUnits().system ? "system" : "user";
}

/**
 * Whether a system unit hands the daemon its PSK at start. Read from the unit
 * text because the key itself is unreachable from anywhere else by design: PID
 * 1 mounts it on a service-private tmpfs inside the service, so `doctor` — which
 * runs in a shell — resolves no key on a perfectly healthy box and would report
 * it broken without this.
 */
export async function systemUnitDeliversPsk(path: string = systemUnitPath()): Promise<boolean> {
  const unit = await Bun.file(path)
    .text()
    .catch(() => null);
  return unit !== null && unitDeliversPsk(unit);
}

export function unitDeliversPsk(unit: string): boolean {
  return unitCredentialBlob(unit) !== null;
}

/** A single unit value by key, first occurrence, `%%` unescaped back to what it meant. */
function unitField(unit: string, key: string): string | null {
  const line = unit.split("\n").find((l) => l.trim().startsWith(`${key}=`));
  return line === undefined ? null : unitUnescape(line.trim().slice(key.length + 1));
}

/**
 * The blob path the unit has systemd deliver, or null when it delivers nothing.
 * The credential id is part of the syntax (`id:path`) and must be ours — systemd
 * refuses a blob whose embedded name doesn't match, so another id is not our key.
 */
export function unitCredentialBlob(unit: string): string | null {
  const prefix = `LoadCredentialEncrypted=${CRED_NAME}:`;
  const line = unit.split("\n").find((l) => l.trim().startsWith(prefix));
  return line === undefined ? null : unitUnescape(line.trim().slice(prefix.length));
}

export function unitStateDirEnv(unit: string): string | null {
  const raw = /^Environment="SEANCE_STATE_DIR=([^"]*)"/mu.exec(unit)?.[1];
  return raw === undefined ? null : unitUnescape(raw);
}

/**
 * What `install --system` would write for the unit already installed: its own
 * `User=`, PATH, log file and credential line, but *this* checkout's main.ts and
 * the current field set. So the comparison reports the drift that matters — a
 * unit generated by older code, or pointed at another checkout — without
 * flagging the per-machine values doctor has no way to re-derive unprivileged.
 * Null when the unit isn't one of ours to compare.
 */
export function expectedSystemUnit(unitText: string): string | null {
  const user = unitField(unitText, "User");
  const bunPath = unitBunPath(unitText);
  const pathEnv = unitPathEnv(unitText);
  const logFile = unitField(unitText, "StandardOutput")?.replace(/^append:/u, "") ?? null;
  if (user === null || bunPath === null || pathEnv === null || logFile === null) return null;
  return unitContent({
    scope: "system",
    user,
    bunPath,
    mainPath: fileURLToPath(new URL("./main.ts", import.meta.url)),
    pathEnv,
    logFile,
    credentialBlob: unitCredentialBlob(unitText) ?? undefined,
    stateDirEnv: unitStateDirEnv(unitText) ?? undefined,
  });
}

/** systemd expands % specifiers inside unit values; paths and PATH must stay literal. */
function unitEscape(s: string): string {
  return s.replaceAll("%", "%%");
}

function unitUnescape(s: string): string {
  return s.replaceAll("%%", "%");
}

/**
 * A value that arrives from an install flag and lands in the unit verbatim.
 * `unitEscape` covers `%`; a quote or newline it cannot — those close the field and
 * malform the unit. A relative path is worse than useless: it resolves against
 * root's cwd here, and systemd rejects one outright in `append:`, so the install
 * would create a stray directory and leave a unit that fails at start.
 */
export function assertUnitFlag(flag: string, value: string, absolute = false): void {
  if (/["\n]/u.test(value)) {
    throw new Error(
      `${flag} must contain no quote or newline — the unit records it verbatim (got ${JSON.stringify(value)})`,
    );
  }
  if (absolute && !isAbsolute(value)) {
    throw new Error(
      `${flag} must be an absolute path — the unit has no cwd to resolve it against (got ${JSON.stringify(value)})`,
    );
  }
}

/** The ExecStart interpreter — what systemd will actually run. Null when the unit doesn't parse. */
export function unitBunPath(unit: string): string | null {
  const raw = /^ExecStart="([^"]*)"/mu.exec(unit)?.[1];
  return raw === undefined ? null : unitUnescape(raw);
}

/** Its PATH counterpart, for reporting what an installed unit will actually resolve. */
export function unitPathEnv(unit: string): string | null {
  const raw = /^Environment="PATH=([^"]*)"/mu.exec(unit)?.[1];
  return raw === undefined ? null : unitUnescape(raw);
}

export interface UnitOptions {
  readonly scope: UnitScope;
  readonly bunPath: string;
  readonly mainPath: string;
  readonly pathEnv: string;
  /** Literal, never `logPath()`: under `--system` this generator runs as root, whose state dir is the wrong one. */
  readonly logFile: string;
  /** System scope only — the account the daemon runs as. It is never root. */
  readonly user?: string;
  /** System scope only, and only when the blob exists: a credential systemd can't load is fatal to unit start. */
  readonly credentialBlob?: string;
  /** System scope only, and only when the state dir isn't the default for that user's home. */
  readonly stateDirEnv?: string;
}

/**
 * Mirrors the launchd plist: run from the checkout via PATH's bun (never the
 * realpath'd install path, which a runtime upgrade deletes), PATH captured at
 * install time (a unit's default PATH has no tmux/claude), stdout/stderr
 * appended to the same log file launchd redirects to — journald would fork the
 * audit trail per platform.
 *
 * One generator for both scopes on purpose: the three fields that differ are the
 * three a hand-written system unit got wrong most easily, and a second template
 * would let them drift.
 */
export function unitContent(opts: UnitOptions): string {
  const system = opts.scope === "system";
  const lines = [
    "[Unit]",
    "Description=Seance daemon (seanced)",
    "",
    "[Service]",
    ...(opts.user === undefined ? [] : [`User=${unitEscape(opts.user)}`]),
    `ExecStart="${unitEscape(opts.bunPath)}" "${unitEscape(opts.mainPath)}"`,
    ...(opts.credentialBlob === undefined
      ? []
      : [`LoadCredentialEncrypted=${CRED_NAME}:${unitEscape(opts.credentialBlob)}`]),
    // `always` under system scope is load-bearing, not taste: `selfRestart`
    // can't rewrite /etc or daemon-reload as the daemon's unprivileged user, so
    // it exits 0 and leaves the relaunch to the supervisor. Under `on-failure` a
    // clean exit stays down and the first auto-update would strand the box.
    `Restart=${system ? "always" : "on-failure"}`,
    "RestartSec=5",
    // Emitted into the unit, not just written here: whoever reads the installed
    // file next is the one who needs it.
    "# process, not the default control-group kill: the daemon may have cold-booted",
    "# the tmux server as its child, and cgroup teardown would take every Claude",
    "# session on the box down with a restart.",
    "KillMode=process",
    `Environment="PATH=${unitEscape(opts.pathEnv)}"`,
    ...(opts.stateDirEnv === undefined ? [] : [`Environment="SEANCE_STATE_DIR=${unitEscape(opts.stateDirEnv)}"`]),
    `StandardOutput=append:${unitEscape(opts.logFile)}`,
    `StandardError=append:${unitEscape(opts.logFile)}`,
    "",
    "[Install]",
    // default.target is the user manager's; multi-user.target its system counterpart.
    `WantedBy=${system ? "multi-user" : "default"}.target`,
    "",
  ];
  return lines.join("\n");
}

/** The user-scope unit as `install` and `selfRestart` write it, resolved from this process's own env. */
function userUnitContent(): string {
  return unitContent({
    scope: "user",
    bunPath: resolvedBun(),
    mainPath: fileURLToPath(new URL("./main.ts", import.meta.url)),
    pathEnv: process.env["PATH"] ?? "",
    logFile: logPath(),
  });
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

/**
 * Two units, one state dir, one log and one relay identity — so two daemons
 * fighting over the same device id. Refused in both directions rather than
 * resolved, because which one the operator meant is not ours to guess.
 */
export function conflictingScopeMessage(installing: UnitScope, existing: string): string {
  return installing === "system"
    ? `a user unit already exists at ${existing} — it would run a second daemon against the same state dir, ` +
        "log and relay identity, and it is the one `selfRestart` rewrites; run `seanced uninstall` as that user first"
    : `a system unit already exists at ${existing} — installing a user unit too would run a second daemon ` +
        "against the same state dir, log and relay identity; `sudo seanced uninstall --system` removes it";
}

export async function installService(): Promise<InstallResult> {
  await assertSystemdRunning();
  if (installedUnits().system) throw new Error(conflictingScopeMessage("user", systemUnitPath()));
  const notes: string[] = [];
  const target = unitPath();
  await mkdir(dirname(target), { recursive: true });
  // Before the unit starts, so `append:` opens a file that is already there at
  // 0600 rather than creating it at the manager's umask.
  const logProblem = await ensureAuditLog();
  if (logProblem !== null) notes.push(logProblem);
  await Bun.write(target, userUnitContent());
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

export interface SystemInstallOptions {
  /** Defaults to `SUDO_USER`. Never root. */
  readonly user?: string;
  readonly stateDir?: string;
  /** Defaults to the invoking PATH, which under a plain `sudo` is secure_path — hence the binary check. */
  readonly pathEnv?: string;
}

/**
 * The runbook docs/platform-notes.md used to spell out by hand. Root-only, and
 * everything it records is resolved for the target user rather than for the
 * process doing the recording — see target-user.ts on why that distinction is
 * the whole difficulty here.
 *
 * Deliberately does not call `assertSystemdRunning`: that preflight probes the
 * *user* manager, and a headless box that needs a system unit is exactly the box
 * where no user instance exists.
 */
export async function installSystemService(opts: SystemInstallOptions = {}): Promise<InstallResult> {
  if (process.platform !== "linux") throw new Error("`install --system` is systemd-only");
  if (!systemdRunning()) throw new Error(noSystemdMessage(isWsl()));
  requireRoot(process.getuid?.(), "install --system");

  // Before anything is created: a value the unit can't carry would otherwise be
  // discovered by systemd, after root has made a directory and left a broken unit
  // file behind.
  if (opts.stateDir !== undefined) assertUnitFlag("--state-dir", opts.stateDir, true);
  if (opts.pathEnv !== undefined) assertUnitFlag("--path", opts.pathEnv);

  const user = await lookupUser(targetUserName(opts.user, process.env));
  // The target's own XDG_CONFIG_HOME is unknowable from root, so this checks the
  // default location; a relocated user unit is caught by doctor instead.
  const userUnit = join(user.home, ".config", "systemd", "user", UNIT_NAME);
  if (existsSync(userUnit)) throw new Error(conflictingScopeMessage("system", userUnit));

  const pathEnv = opts.pathEnv ?? process.env["PATH"] ?? "";
  const missing = await missingUnitBinaries(pathEnv);
  if (missing.length > 0) throw new Error(missingBinariesMessage(missing, pathEnv));
  const bunPath = await whichIn("bun", pathEnv);
  if (bunPath === null) throw new Error(missingBinariesMessage(["bun"], pathEnv));

  const notes: string[] = [];
  const defaultStateDir = stateDirFor(user.home);
  const targetStateDir = opts.stateDir ?? defaultStateDir;
  const logFile = logPathIn(targetStateDir);
  await mkdirAsTarget(targetStateDir, user);
  // systemd opens `append:` as root before dropping to User=, so a log file it
  // has to create lands root-owned and the daemon's own CLI can't append to it —
  // silently unauditing every `seanced spawn`. Root can put an existing one back
  // too, which is the fix for a log rotated or deleted since the last install;
  // the daemon repairs the mode on start, but never another user's ownership.
  if (!existsSync(logFile)) await writeFile(logFile, "", { mode: AUDIT_LOG_MODE });
  await chown(logFile, user.uid, user.gid);
  await chmod(logFile, AUDIT_LOG_MODE);

  const blob = pskBlobPathIn(targetStateDir);
  const credentialBlob = await credentialBlobFor(blob, join(configDirFor(user.home), "config.json"), notes);
  const target = unitPathFor("system");
  const previous = await Bun.file(target)
    .text()
    .catch(() => null);
  const unit = unitContent({
    scope: "system",
    user: user.name,
    bunPath,
    mainPath: fileURLToPath(new URL("./main.ts", import.meta.url)),
    pathEnv,
    logFile,
    credentialBlob,
    stateDirEnv: targetStateDir === defaultStateDir ? undefined : targetStateDir,
  });
  await Bun.write(target, unit);
  const reload = await exec(scopeArgv("system").concat("daemon-reload"));
  if (reload.exitCode !== 0) throw new Error(`systemctl daemon-reload failed: ${reload.stderr.trim()}`);
  const enable = await exec(scopeArgv("system").concat(["enable", "--now", UNIT_NAME]));
  if (enable.exitCode !== 0) throw new Error(`systemctl enable --now failed: ${enable.stderr.trim()}`);
  // `enable --now` starts a stopped unit but leaves a running one on its old
  // definition, and nothing else can apply a new one — `selfRestart` exits under a
  // system unit rather than rewriting /etc. So a reinstall is where a changed
  // definition takes effect; without this, doctor's drift warning goes quiet while
  // the process keeps serving the old ExecStart.
  if (previous !== null && previous !== unit) {
    const restart = await exec(scopeArgv("system").concat(["restart", UNIT_NAME]));
    notes.push(
      restart.exitCode === 0
        ? "the unit definition changed, so the running daemon was restarted onto it"
        : `the unit definition changed but the restart failed (${restart.stderr.trim() || "denied"}) — the daemon ` +
            `still serves the old one: sudo systemctl restart ${UNIT_NAME}`,
    );
  }

  notes.push(
    `the daemon runs as ${user.name}; \`systemctl status ${UNIT_NAME}\` and ${logFile} are how you see its health — ` +
      "`seanced status` and `seanced doctor` work as that user too",
  );
  return { target, notes };
}

/**
 * Only a blob PID 1 can actually unseal earns the `LoadCredentialEncrypted=`
 * line: a credential it can't load fails the unit at start, which is worse than
 * a unit that comes up and reports no PSK. So an absent or undecryptable blob
 * installs a working unit plus the note saying what to do about it.
 */
async function credentialBlobFor(blob: string, configFile: string, notes: string[]): Promise<string | undefined> {
  if (!existsSync(blob)) {
    notes.push(
      `no sealed PSK blob at ${blob}, so the unit delivers no credential — seal it (docs/psk.md, "Sealing the ` +
        'blob as root") and re-run `sudo seanced install --system` to add the LoadCredentialEncrypted= line',
    );
    return undefined;
  }
  const problem = await blobLoadable(blob);
  if (problem !== null) {
    notes.push(
      `the blob at ${blob} does not decrypt here (${problem}), so the unit delivers no credential — a credential ` +
        "systemd can't load would fail the unit at start; blobs are machine-bound, re-seal on this machine",
    );
    return undefined;
  }
  notes.push(
    `the unit delivers the key from ${blob} — clear "psk" in ${configFile} so nothing on disk holds it in ` +
      "plaintext, then `sudo systemctl restart seanced`",
  );
  return blob;
}

export async function uninstallSystemService(): Promise<readonly string[]> {
  if (process.platform !== "linux") throw new Error("`uninstall --system` is systemd-only");
  if (!systemdRunning()) throw new Error(noSystemdMessage(isWsl()));
  requireRoot(process.getuid?.(), "uninstall --system");
  await exec(scopeArgv("system").concat(["disable", "--now", UNIT_NAME])); // ignore failure: not installed
  await rm(unitPathFor("system"), { force: true });
  await exec(scopeArgv("system").concat("daemon-reload"));
  return [
    "the sealed PSK blob and state dir are left in place — a TPM-sealed blob can't be recreated from a backup",
    "the `seanced` name on PATH is left too: it belongs to the user, whose PATH root can't see — `seanced unlink` as that user",
  ];
}

async function scopeActive(scope: UnitScope): Promise<boolean> {
  const result = await exec(scopeArgv(scope).concat(["is-active", UNIT_NAME]));
  return result.exitCode === 0;
}

/**
 * Which scope's unit holds this box's daemon, as far as an unprivileged caller can
 * tell. The files answer unless both exist — there only `is-active` separates the
 * live daemon from a leftover unit file, and answering "system" for a daemon the
 * user manager is running sends `seanced restart` at the wrong one.
 */
async function ownerScope(units: InstalledUnits = installedUnits()): Promise<UnitScope> {
  if (units.system && units.user && !(await scopeActive("system"))) return "user";
  return units.system ? "system" : "user";
}

/**
 * Whether the unit is up. The scope is a parameter because its two kinds of caller
 * know it differently: `selfRestart` reads its own cgroup, which is exact, while
 * status and doctor have only the unit files.
 */
export async function serviceLoaded(scope?: UnitScope): Promise<boolean> {
  if (!systemdRunning()) return false;
  return scopeActive(scope ?? (await ownerScope()));
}

/** What restarts this box's daemon, in the scope that owns it — a system unit needs privilege the CLI doesn't have. */
export function restartCommandFor(scope: UnitScope): string {
  return scope === "system" ? `sudo systemctl restart ${UNIT_NAME}` : `seanced restart`;
}

export async function restartService(): Promise<void> {
  if (!systemdRunning()) throw new Error(noSystemdMessage(isWsl()));
  const scope = await ownerScope();
  // Root-owned unit, unprivileged caller: say so rather than surface systemd's
  // interactive-auth refusal, which reads like the unit is broken.
  if (scope === "system" && process.getuid?.() !== 0) {
    throw new Error(`the daemon runs under a system unit — restarting it needs root: ${restartCommandFor(scope)}`);
  }
  const result = await exec(scopeArgv(scope).concat(["restart", UNIT_NAME]));
  if (result.exitCode !== 0) {
    throw new Error(`systemctl --${scope} restart failed: ${result.stderr.trim()}`);
  }
}

/**
 * The self-update's restart. Rewrites the unit first so definition drift
 * (KillMode above) ships with the code that needs it, reloads, and restarts
 * without blocking — the caller is inside the process being restarted. The
 * rewrite runs from the pre-update process, still serving old code from memory,
 * so a definition change lands one update after the code that introduced it.
 * Not running under systemd? Exit clean and let the supervisor apply its policy.
 *
 * Under a system unit the daemon can do none of that — it runs as an
 * unprivileged `User=` and can neither write /etc/systemd/system nor reach the
 * system manager — so it exits 0 and `Restart=always` relaunches it on the new
 * code. That is a chosen branch, not a fall-through: `on-failure` there would
 * make this exit the last thing the machine ever did.
 */
export async function selfRestart(): Promise<void> {
  if (!systemdRunning()) process.exit(0);
  // The cgroup, not the unit files: with both installed, file order answers
  // "system" for a daemon the user manager is running, and this would then exit 0
  // under `Restart=on-failure` — a clean exit that stays down until someone logs in.
  const scope = await runningScope();
  if (!(await serviceLoaded(scope))) process.exit(0);
  if (scope === "system") {
    console.log(
      "updated — exiting for Restart=always to relaunch on the new code; the unit definition is not rewritten " +
        "here, so run `sudo seanced install --system` if `seanced doctor` reports it drifted",
    );
    process.exit(0);
  }
  await Bun.write(unitPath(), userUnitContent());
  const reload = await exec(["systemctl", "--user", "daemon-reload"]);
  if (reload.exitCode !== 0) throw new Error(`systemctl --user daemon-reload failed: ${reload.stderr.trim()}`);
  // Throwing matters more here than anywhere else in this file: the caller has
  // already recorded the update as ok, so a silent failure leaves the machine
  // serving old code while every later check reads `current`.
  const restart = await exec(["systemctl", "--user", "restart", "--no-block", UNIT_NAME]);
  if (restart.exitCode !== 0) throw new Error(`systemctl --user restart failed: ${restart.stderr.trim()}`);
}

/**
 * The scope-dependent half of doctor's service section: which unit owns this box,
 * whether it is active, and whether its recorded definition still matches what
 * `install` would write. Pure over what the probes found, so all four
 * installed-scope combinations are testable without a systemd to talk to.
 *
 * `expectedUnit` is what `install --system` would generate now. A system unit is
 * never rewritten by the daemon — `selfRestart` can't — so reporting the drift is
 * the only thing available, and it replaces the "re-check the ExecStart= line by
 * hand" instruction the docs used to carry.
 */
export async function scopeChecks(
  units: InstalledUnits,
  active: boolean,
  ctx: {
    readonly unitText: string | null;
    readonly expectedUnit: string | null;
    /** Where a sealed blob was found, or null when there is none to deliver. */
    readonly blobPath: string | null;
  },
): Promise<readonly Check[]> {
  const checks: Check[] = [];
  const scope: UnitScope = units.system ? "system" : "user";
  if (units.system && units.user) {
    checks.push({
      level: "warn",
      message:
        `both a system unit (${systemUnitPath()}) and a user unit (${unitPath()}) exist — two daemons against ` +
        "one state dir, log and relay identity; `seanced uninstall` drops the user one",
    });
  }
  if (active) {
    checks.push({
      level: "ok",
      message: scope === "system" ? `systemd system unit ${UNIT_NAME} active` : `systemd unit ${UNIT_NAME} active`,
    });
  } else {
    checks.push({
      level: "warn",
      message:
        scope === "system"
          ? `systemd system unit not active — \`systemctl status ${UNIT_NAME}\` says why`
          : "systemd unit not active — run `seanced install` (its preflight names what's missing)",
    });
  }
  if (ctx.unitText !== null) {
    // A system unit is started by PID 1 with the PATH the unit itself records,
    // not with the shell's — so that is the PATH its ExecStart has to resolve in.
    const unitPathEnvValue = scope === "system" ? unitPathEnv(ctx.unitText) : null;
    const current = unitPathEnvValue === null ? undefined : ((await whichIn("bun", unitPathEnvValue)) ?? undefined);
    const drift = await recordedBunCheck(
      unitBunPath(ctx.unitText),
      "service",
      scope === "system" ? "sudo seanced install --system" : "seanced install",
      current,
    );
    if (drift !== null) checks.push(drift);
  }
  if (scope === "system" && ctx.unitText !== null && ctx.expectedUnit !== null && ctx.unitText !== ctx.expectedUnit) {
    checks.push({
      level: "warn",
      message:
        "the installed system unit differs from what this checkout would write — nothing rewrites a system unit " +
        "on its own; `sudo seanced install --system` reinstalls it",
    });
  }
  if (scope === "system" && ctx.blobPath !== null && ctx.unitText !== null && !unitDeliversPsk(ctx.unitText)) {
    checks.push({
      level: "warn",
      message:
        `a sealed blob exists at ${ctx.blobPath} but the system unit has no ` +
        `LoadCredentialEncrypted=${CRED_NAME}: line, so the daemon is never handed the key — ` +
        "`sudo seanced install --system` adds it once the blob decrypts",
    });
  }
  return checks;
}

/** Doctor's Linux service section — kept here so cli.ts doesn't grow systemctl/schtasks plumbing. */
export async function doctorServiceChecks(): Promise<readonly Check[]> {
  if (!systemdRunning()) return [{ level: "warn", message: noSystemdMessage(isWsl()) }];
  const units = installedUnits();
  const scope: UnitScope = units.system ? "system" : "user";
  const unitText = await Bun.file(unitPathFor(scope))
    .text()
    .catch(() => null);
  // The unit's own state dir where it names one: a `--state-dir` install puts the
  // blob somewhere this shell's `stateDir()` would never look.
  const blobPath = pskBlobPathIn((unitText === null ? null : unitStateDirEnv(unitText)) ?? stateDir());
  const checks: Check[] = [
    ...(await scopeChecks(units, await serviceLoaded(scope), {
      unitText,
      expectedUnit: scope === "user" || unitText === null ? null : expectedSystemUnit(unitText),
      blobPath: existsSync(blobPath) ? blobPath : null,
    })),
  ];
  // Linger is a user-manager concept: a system unit starts at boot with no login
  // session involved, so probing it there reported a healthy box as broken.
  if (scope === "system") {
    checks.push({ level: "ok", message: "system unit — linger not required, it starts at boot" });
    return checks;
  }
  const username = userInfo().username;
  if (Bun.which("loginctl") === null) {
    checks.push({
      level: "warn",
      message: "loginctl not found — can't check linger; without it the daemon dies with your last session",
    });
  } else {
    const linger = await exec(["loginctl", "show-user", username, "--property=Linger"]);
    if (linger.stdout.trim() === "Linger=yes") {
      checks.push({ level: "ok", message: "linger enabled — unit starts without a login session" });
    } else {
      checks.push({
        level: "warn",
        message: `linger off — daemon dies with your last session: sudo loginctl enable-linger ${username}`,
      });
    }
  }
  if (isWsl()) {
    const task = await exec([schtasksExe(), "/Query", "/TN", PIN_TASK_NAME]);
    if (task.exitCode === 0) {
      checks.push({ level: "ok", message: `logon pin task ${PIN_TASK_NAME} registered` });
    } else {
      // install's own registration may be denied (interop schtasks runs non-elevated), so point at the manual command directly
      checks.push({
        level: "warn",
        message:
          `no ${PIN_TASK_NAME} scheduled task — a Windows reboot leaves the machine offline; ` +
          `from a Windows shell: ${manualTaskCommand(process.env["WSL_DISTRO_NAME"] ?? "<distro>")}`,
      });
    }
  }
  return checks;
}
