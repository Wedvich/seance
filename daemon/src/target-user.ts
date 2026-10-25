// Everything `install --system` must resolve for someone other than the process
// resolving it. Under sudo, `homedir()`, `stateDir()`, `logPath()`,
// `process.env.PATH` and `Bun.which` all answer for *root*, and every one of
// those values is written into the unit literally — a unit that outlives the
// install. So nothing here reads the ambient environment except through an
// argument, which also makes it testable without a second user on the box.

import { constants, existsSync } from "node:fs";
import { access, chown, mkdir } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { exec } from "./exec.ts";

export interface TargetUser {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
}

/** One wording for both root refusals — the name check in `targetUserName`, the uid check in `assertUnprivileged`. */
const NEVER_ROOT = "the daemon must never run as root";

/**
 * The sudo prefix every instruction prints. sudo looks the command up in secure_path
 * whatever `--preserve-env` says (that only sets the PATH the command then sees), and
 * `~/.local/bin` is never in it — so seanced is named by full path, resolved by the
 * invoking shell. PATH is still preserved: the `env bun` shebang and the binaries the
 * unit records resolve through it.
 */
export const SUDO_SEANCED = 'sudo --preserve-env=PATH "$(command -v seanced)"';

/** The one privileged action per command, named in the message so the remedy is the whole answer. */
export function requireRoot(uid: number | undefined, action: string): void {
  if (uid === 0) return;
  throw new Error(
    `${action} writes /etc/systemd/system and must run as root — \`${SUDO_SEANCED} ${action}\` ` +
      "(full path, because sudo searches secure_path for the command; --preserve-env, because secure_path " +
      "also holds none of the binaries the unit has to record)",
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
  if (name === "root") throw new Error(`${NEVER_ROOT} — pass \`--user <name>\` naming your account`);
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
  // Number("") is 0 and an integer, so an empty uid or gid field would parse as
  // root and hand it everything this install chowns.
  if (name === "" || home === "" || uid === "" || gid === "") return null;
  if (!Number.isInteger(uidNum) || !Number.isInteger(gidNum)) return null;
  return { name, uid: uidNum, gid: gidNum, home };
}

/**
 * The uid is the invariant; `root` is only its common spelling. A second uid-0
 * account (`toor`) is a normal thing to find in /etc/passwd, and gid 0 gives the
 * same reach over everything the install writes.
 */
export function assertUnprivileged(user: TargetUser): void {
  if (user.uid !== 0 && user.gid !== 0) return;
  throw new Error(
    `"${user.name}" resolves to ${user.uid}:${user.gid} — ${NEVER_ROOT}; pass \`--user <name>\` naming an unprivileged account`,
  );
}

export async function lookupUser(name: string): Promise<TargetUser> {
  const result = await exec(["getent", "passwd", name], { timeoutMs: 10_000 });
  const user = result.exitCode === 0 ? parsePasswdLine(result.stdout) : null;
  if (user === null) throw new Error(`no such user "${name}" (getent passwd found nothing usable)`);
  assertUnprivileged(user);
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

/**
 * Prefix that runs a command as the target user, supplementary groups included —
 * a toolchain dir shared through a group is reachable to the unit too. Root's
 * `access()` answers for root, so it can't say what the unit's user can search
 * or exec; only a process holding that user's credentials can (ACLs included).
 */
export function asTargetArgv(user: TargetUser): readonly string[] {
  return ["setpriv", `--reuid=${user.uid}`, `--regid=${user.gid}`, "--init-groups", "--"];
}

/** Answers by index, so no path byte has to survive the round trip; paths are arguments, never script text. */
const REACHABLE_PROBE = 'i=0; for p do [ -x "$p" ] && echo "$i"; i=$((i+1)); done; exit 0';

/** Which of `paths` the process `asUser` runs as can exec (a file) or search (a dir). */
export async function reachableAs(asUser: readonly string[], paths: readonly string[]): Promise<ReadonlySet<string>> {
  if (paths.length === 0) return new Set();
  const result = await exec([...asUser, "/bin/sh", "-c", REACHABLE_PROBE, "sh", ...paths], { timeoutMs: 10_000 });
  if (result.exitCode !== 0) {
    throw new Error(`couldn't check PATH as the unit's user: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  return new Set(
    result.stdout
      .split("\n")
      // Number("") is 0: the trailing newline's empty line must not vouch for paths[0].
      .filter((line) => line !== "")
      .map((line) => paths[Number(line)])
      .filter((path) => path !== undefined),
  );
}

export interface TargetPath {
  readonly pathEnv: string;
  /** Entries the unit's user can't search, which the unit would only carry as dead weight. */
  readonly dropped: readonly string[];
}

/**
 * The offered PATH minus what the unit's user can't reach. Under sudo a version
 * manager's shim (mise, asdf) resolves the `env bun` shebang *for root* and
 * prepends root's own install dir to PATH before seanced reads it — so the unit
 * recorded `/root/…/bin/bun` and died 203/EXEC on its first start. Empty entries
 * go too: they mean the cwd, which a unit has no useful one of.
 */
export async function reachablePath(offered: string, asUser: readonly string[]): Promise<TargetPath> {
  const entries = offered.split(delimiter).filter((entry) => entry !== "");
  const reachable = await reachableAs(asUser, entries);
  return {
    pathEnv: entries.filter((entry) => reachable.has(entry)).join(delimiter),
    dropped: entries.filter((entry) => !reachable.has(entry)),
  };
}

/** What the daemon needs on PATH once systemd starts it with no shell to inherit from. */
export const UNIT_BINARIES = ["bun", "git", "tmux", "claude"] as const;

/**
 * Resolved as root, confirmed as the unit's user: a binary root can exec, in a
 * dir the user can search, may still lack the user's exec bit.
 */
export async function missingUnitBinaries(pathEnv: string, asUser: readonly string[]): Promise<readonly string[]> {
  const found = await Promise.all(UNIT_BINARIES.map(async (name) => [name, await whichIn(name, pathEnv)] as const));
  const reachable = await reachableAs(
    asUser,
    found.flatMap(([, path]) => (path === null ? [] : [path])),
  );
  return found.filter(([, path]) => path === null || !reachable.has(path)).map(([name]) => name);
}

/**
 * The refusal that catches a plain `sudo`. secure_path holds no mise shim, no
 * ~/.local/bin and no toolchain dir, so the recorded PATH would resolve neither
 * bun nor tmux — and the unit would start and then fail every spawn. With
 * `dropped`, PATH was preserved but its binaries sat in dirs only root reaches:
 * preserving it again changes nothing, naming the user's own dirs does.
 */
export function missingBinariesMessage(
  missing: readonly string[],
  pathEnv: string,
  dropped: readonly string[] = [],
): string {
  const problem = `the PATH this would record resolves no ${missing.join(", ")} — that unit would start and then fail every spawn. `;
  if (dropped.length > 0) {
    return (
      problem +
      `It leaves out ${dropped.join(", ")}, which the unit's user can't reach — a version manager's shim (mise, ` +
      "asdf) run under sudo resolves for root and puts root's own install dir first. Name your own with --path: " +
      `\`${SUDO_SEANCED} install --system --path "<dir holding your bun>:$PATH"\` (recorded PATH was: ${pathEnv})`
    );
  }
  return (
    problem +
    `sudo replaces PATH with secure_path; re-run as \`${SUDO_SEANCED} install --system\`, ` +
    `or, where sudoers refuses --preserve-env, \`sudo env PATH="$PATH" seanced install --system\` (recorded PATH was: ${pathEnv})`
  );
}

/**
 * `mkdir -p` where every component it has to create belongs to the target user.
 * Chowning the leaf alone leaves a root-owned `~/.local` behind on a fresh
 * account — and the user could then never create `~/.local/bin` beside it, which
 * is the dir `seanced link` prefers. The leaf is chowned either way: an install
 * over a directory someone else owns is the case this is fixing.
 */
export async function mkdirAsTarget(dir: string, user: TargetUser): Promise<void> {
  const missing: string[] = [];
  for (let cur = dirname(dir); !existsSync(cur) && dirname(cur) !== cur; cur = dirname(cur)) missing.push(cur);
  await mkdir(dir, { recursive: true });
  for (const path of [...missing.toReversed(), dir]) {
    // oxlint-disable-next-line no-await-in-loop -- outermost first, and a handful of components at most
    await chown(path, user.uid, user.gid);
  }
}
