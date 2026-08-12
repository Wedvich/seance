// Everything `install --system` must resolve for someone other than the process
// resolving it. Under sudo, `homedir()`, `stateDir()`, `logPath()`,
// `process.env.PATH` and `Bun.which` all answer for *root*, and every one of
// those values is written into the unit literally — a unit that outlives the
// install. So nothing here reads the ambient environment except through an
// argument, which also makes it testable without a second user on the box.

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { exec } from "./exec.ts";

export interface TargetUser {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
}

/** The one privileged action per command, named in the message so the remedy is the whole answer. */
export function requireRoot(uid: number | undefined, action: string): void {
  if (uid === 0) return;
  throw new Error(
    `${action} writes /etc/systemd/system and must run as root — \`sudo --preserve-env=PATH seanced ${action}\` ` +
      "(--preserve-env, because sudo's secure_path holds none of the binaries the unit has to record)",
  );
}

/**
 * Who the unit will run as. Under sudo `SUDO_USER` is the only trace of the
 * invoking user left in the environment; `--user` overrides it for the case
 * where root is not reached through sudo at all. Refusing `root` is the
 * threat-model line, not a nicety: the daemon spawns Claude sessions.
 */
export function targetUserName(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  const name = flag ?? env["SUDO_USER"];
  if (name === undefined || name === "") {
    throw new Error(
      "can't tell which user the unit should run as — reached root without sudo? pass `--user <name>` " +
        "(the daemon must not run as root)",
    );
  }
  if (name === "root") throw new Error("the daemon must never run as root — pass `--user <name>` naming your account");
  return name;
}

/**
 * `getent passwd` rather than reading /etc/passwd: it answers for LDAP/SSSD
 * users too. Fields are name:passwd:uid:gid:gecos:home:shell — GECOS can hold
 * commas, never colons, so a plain split is safe.
 */
export function parsePasswdLine(line: string): TargetUser | null {
  const fields = line.trim().split(":");
  if (fields.length < 7) return null;
  const [name, , uid, gid, , home] = fields as [string, string, string, string, string, string, string];
  const uidNum = Number(uid);
  const gidNum = Number(gid);
  if (name === "" || home === "" || !Number.isInteger(uidNum) || !Number.isInteger(gidNum)) return null;
  return { name, uid: uidNum, gid: gidNum, home };
}

export async function lookupUser(name: string): Promise<TargetUser> {
  const result = await exec(["getent", "passwd", name], { timeoutMs: 10_000 });
  const user = result.exitCode === 0 ? parsePasswdLine(result.stdout) : null;
  if (user === null) throw new Error(`no such user "${name}" (getent passwd found nothing usable)`);
  return user;
}

/**
 * `Bun.which` resolves against *this* process's PATH, which under sudo is
 * `secure_path`. The unit records a PATH for the target user, so every binary
 * check has to be made against that same string or the unit installs green and
 * then can't spawn anything. Never falls back to `process.execPath` — see
 * link.ts on what persisting a realpath'd interpreter costs.
 */
export async function whichIn(name: string, pathEnv: string): Promise<string | null> {
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    // oxlint-disable-next-line no-await-in-loop -- PATH order is the answer; the first hit wins
    const ok = await access(candidate, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (ok) return candidate;
  }
  return null;
}

/** What the daemon needs on PATH once systemd starts it with no shell to inherit from. */
export const UNIT_BINARIES = ["bun", "git", "tmux", "claude"] as const;

export async function missingUnitBinaries(pathEnv: string): Promise<readonly string[]> {
  const found = await Promise.all(UNIT_BINARIES.map(async (name) => [name, await whichIn(name, pathEnv)] as const));
  return found.filter(([, path]) => path === null).map(([name]) => name);
}

/**
 * The refusal that catches a plain `sudo`. secure_path holds no mise shim, no
 * ~/.local/bin and no toolchain dir, so the recorded PATH would resolve neither
 * bun nor tmux — and the unit would start and then fail every spawn.
 */
export function missingBinariesMessage(missing: readonly string[], pathEnv: string): string {
  return (
    `the PATH this would record resolves no ${missing.join(", ")} — that unit would start and then fail every spawn. ` +
    "sudo replaces PATH with secure_path; re-run as `sudo --preserve-env=PATH seanced install --system`, " +
    `or pass \`--path "$PATH"\` explicitly (recorded PATH was: ${pathEnv})`
  );
}

/** Ownership for what root creates on the target user's behalf — the state dir and the log file. */
export async function ownedByTarget(path: string, user: TargetUser): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info !== null && info.uid === user.uid && info.gid === user.gid;
}
