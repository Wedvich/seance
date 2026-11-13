// `seance-archivist install --system` and `uninstall --system`: the daemon's
// system-unit machinery (daemon/src/systemd.ts, target-user.ts, tpmcreds.ts)
// pointed at the archivist's three units. Loaded only by main.ts's `import()` in
// those two commands, never by `run` (archivist/test/layering.test.ts): it runs
// systemctl, getent, setpriv and systemd-creds, as root, in a process that is
// never handed the key.

import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "../../daemon/src/exec.ts";
import { pskBlobPathIn } from "../../daemon/src/paths.ts";
import { checkoutRoot, trimRoot } from "../../daemon/src/selfsource.ts";
import { assertUnitFlag, scopeArgv, systemdRunning, UNIT_NAME, unitUser } from "../../daemon/src/systemd.ts";
import {
  asTargetArgv,
  lookupUser,
  missingUnitBinaries,
  reachablePath,
  requireRoot,
  untrustedChain,
  untrustedTree,
  whichIn,
} from "../../daemon/src/target-user.ts";
import { blobLoadable } from "../../daemon/src/tpmcreds.ts";
import { loadArchivistConfig } from "./config.ts";
import { archivistConfigPathFor, archivistStateDirFor } from "./paths.ts";
import { ARCHIVIST_UNIT, archivistUnits, UPDATE_PATH_UNIT, UPDATE_UNIT, type ArchivistUnitName } from "./units.ts";

const SYSTEM_UNIT_DIR = "/etc/systemd/system";
const MAIN_PATH = fileURLToPath(new URL("./main.ts", import.meta.url));

/**
 * The sudo form every refusal names, as `SUDO_SEANCED` is the daemon's but with the
 * archivist's own bun by absolute path: `$(command -v bun)` would expand in the
 * invoking shell, whose user is usually the daemon's, and run a binary its
 * sessions can replace as root. `~archivist` is the account `--user` names (the
 * README's); swap in another's home. The archivist has no `link`, so main.ts is
 * named by its own path, and PATH is not preserved: the unit records only the
 * `--path` it is given.
 */
export const SUDO_ARCHIVIST = `sudo ~archivist/.bun/bin/bun "${MAIN_PATH}"`;

export const SUDO_ARCHIVIST_NOTE =
  "(the archivist's own bun by absolute path, never one found on your PATH, since root runs it; " +
  "substitute its home for ~archivist if the account is named otherwise)";

/** A relative entry would be checked against root's cwd here and searched from the unit's own. */
export function relativePathRefusal(pathEnv: string): string | null {
  const relative = pathEnv.split(delimiter).filter((entry) => !isAbsolute(entry));
  if (relative.length === 0) return null;
  return (
    "--path entries must be absolute and none empty — the unit has no working directory to resolve them " +
    `against (got ${relative.map((entry) => JSON.stringify(entry)).join(", ")})`
  );
}

/** bun runs the service; git is what `update` fast-forwards with. No tmux or claude: it spawns nothing. */
const ARCHIVIST_BINARIES = ["bun", "git"] as const;

export interface ArchivistInstallOptions {
  /** Required: the sudo caller is usually the daemon's user, which A27a refuses. */
  readonly user?: string;
  /** Required: no ambient fallback, since the sudo caller's PATH is the daemon user's. */
  readonly pathEnv?: string;
}

/**
 * The archivist runs as a Unix user of its own (docs/archivist.md, A27a):
 * sessions run as the daemon's user and must not be able to read or change the
 * archive. A `seanced` system unit names its user; a user unit in the target's
 * home is the same daemon by another route. Pure over what was read, so it is
 * testable without either file.
 */
export function daemonUserRefusal(
  target: string,
  seancedSystemUnit: string | null,
  seancedUserUnitExists: boolean,
): string | null {
  const why =
    "the archivist runs as a user of its own, never the daemon's — sessions run as the daemon's user and must " +
    "not be able to read or change archive.sqlite (docs/archivist.md, A27a); create one and pass `--user <name>`";
  if (seancedSystemUnit !== null && unitUser(seancedSystemUnit) === target) {
    return `${target} is the user ${SYSTEM_UNIT_DIR}/${UNIT_NAME} runs seanced as — ${why}`;
  }
  if (seancedUserUnitExists) return `${target} has a seanced user unit — ${why}`;
  return null;
}

/**
 * The unit runs `<checkout>/archivist/src/main.ts`, and `update` fast-forwards
 * that checkout as the archivist's user, so it must be that user's own: one the
 * daemon's user could write would run their code with the archivist's key.
 */
export function checkoutRefusal(
  root: string,
  ownerUid: number,
  user: { readonly name: string; readonly uid: number },
): string | null {
  if (ownerUid === user.uid) return null;
  return (
    `${root} is not ${user.name}'s (owner uid ${ownerUid}) — the unit runs this checkout's code with the key, and ` +
    `\`update\` fast-forwards it as ${user.name}; clone it as that user and run install from there`
  );
}

/**
 * What a unit running as `user` executes, held to `WriteTrust`: the checkout (its
 * whole tree and the dirs above it), the resolved bun and git, and every PATH
 * entry (a shim in one is as good as a replaced bun). Anything the daemon's user
 * — or anyone but root and the archivist — can rewrite would run with the key, or
 * with the update unit's ability to rewrite the checkout the key holder runs from.
 */
export async function untrustedCode(
  user: { readonly uid: number; readonly gid: number },
  checkout: string,
  binaries: readonly string[],
  pathEntries: readonly string[],
): Promise<readonly string[]> {
  const trust = { uids: [0, user.uid], gids: [0, user.gid] };
  const found = [...(await untrustedChain(checkout, trust)), ...(await untrustedTree(checkout, trust))];
  for (const path of [...binaries, ...pathEntries]) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of paths
    found.push(...(await untrustedChain(path, trust)));
  }
  return [...new Set(found)];
}

function unitFile(name: ArchivistUnitName): string {
  return join(SYSTEM_UNIT_DIR, name);
}

function assertSystemd(action: string): void {
  if (process.platform !== "linux") throw new Error(`\`${action}\` is systemd-only`);
  if (!systemdRunning()) {
    throw new Error(
      "this system is not running systemd — the archivist's key comes only from a system unit's LoadCredentialEncrypted=",
    );
  }
  requireRoot(process.getuid?.(), action, SUDO_ARCHIVIST, SUDO_ARCHIVIST_NOTE);
}

async function systemctl(args: readonly string[]): Promise<void> {
  const result = await exec(scopeArgv("system").concat(args));
  if (result.exitCode !== 0) throw new Error(`systemctl ${args.join(" ")} failed: ${result.stderr.trim()}`);
}

/**
 * Everything the units record is resolved for the target user, never from
 * root's own environment (CLAUDE.md, "The daemon never runs as root"; the same
 * holds here). Refuses, before writing anything, whatever would leave a unit that
 * fails at start and restarts every five seconds: no config, or no blob PID 1
 * can unseal — unlike the daemon, the archivist has no keyless mode to come up in.
 */
export async function installArchivistSystem(opts: ArchivistInstallOptions): Promise<readonly string[]> {
  assertSystemd("install --system");
  if (opts.pathEnv === undefined || opts.pathEnv === "") {
    throw new Error(
      "pass `--path <dirs>` — the unit's PATH, which must hold bun and git; it is never taken from the environment, " +
        "since the sudo caller is usually the daemon's user and everything on the PATH runs with the archivist's key: " +
        `\`${SUDO_ARCHIVIST} install --system --user <name> --path "<dir holding bun>:/usr/bin:/bin"\``,
    );
  }
  assertUnitFlag("--path", opts.pathEnv);
  const relative = relativePathRefusal(opts.pathEnv);
  if (relative !== null) throw new Error(relative);
  if (opts.user === undefined || opts.user === "") {
    throw new Error(
      "pass `--user <name>` — the archivist's own unprivileged account, never root and never the daemon's",
    );
  }
  if (opts.user === "root") throw new Error("seance-archivist must never run as root — pass `--user <name>`");
  const user = await lookupUser(opts.user);

  const seancedUnit = await Bun.file(join(SYSTEM_UNIT_DIR, UNIT_NAME))
    .text()
    .catch(() => null);
  const daemonRefusal = daemonUserRefusal(
    user.name,
    seancedUnit,
    existsSync(join(user.home, ".config", "systemd", "user", UNIT_NAME)),
  );
  if (daemonRefusal !== null) throw new Error(daemonRefusal);

  const root = trimRoot(checkoutRoot());
  const ownership = checkoutRefusal(root, (await stat(root)).uid, user);
  if (ownership !== null) throw new Error(ownership);

  // Loaded for its refusals (missing, not JSON, a `psk` key): `run` would exit on each, and Restart= loop on it.
  await loadArchivistConfig(archivistConfigPathFor(user.home));

  const stateDir = archivistStateDirFor(user.home);
  const blob = pskBlobPathIn(stateDir);
  if (!existsSync(blob)) {
    throw new Error(
      `no sealed PSK at ${blob} — seal it first (docs/psk.md, "A second service: the archivist"); the archivist ` +
        "has no key but the unit's credential, so a unit without one could only fail at start",
    );
  }
  const unsealable = await blobLoadable(blob);
  if (unsealable !== null) {
    throw new Error(
      `the blob at ${blob} does not decrypt here (${unsealable}) — blobs are machine-bound, re-seal it here`,
    );
  }

  const asUser = asTargetArgv(user);
  const { pathEnv, dropped } = await reachablePath(opts.pathEnv, asUser);
  const missing = await missingUnitBinaries(pathEnv, asUser, ARCHIVIST_BINARIES);
  const bunPath = await whichIn("bun", pathEnv);
  if (missing.length > 0 || bunPath === null) {
    const left = dropped.length === 0 ? "" : ` (left out, since ${user.name} can't reach them: ${dropped.join(", ")})`;
    throw new Error(
      `the PATH this would record resolves no ${missing.join(", ") || "bun"} for ${user.name}${left} — the service ` +
        `runs on bun and \`update\` needs git; name ${user.name}'s own dirs: ` +
        `\`${SUDO_ARCHIVIST} install --system --user ${user.name} --path "<dir holding bun>:/usr/bin:/bin"\` ` +
        `(recorded PATH was: ${pathEnv})`,
    );
  }

  const gitPath = await whichIn("git", pathEnv);
  const writable = await untrustedCode(
    user,
    root,
    [bunPath, ...(gitPath === null ? [] : [gitPath])],
    pathEnv.split(delimiter),
  );
  if (writable.length > 0) {
    throw new Error(
      `the archivist would run code that ${user.name} does not hold alone — it executes with the key, and the ` +
        `update unit rewrites the checkout, so each of these must belong to root or ${user.name} and be writable ` +
        `by nobody else, nor by any group but root's or ${user.name}'s: ${writable.join("; ")}. Fix the ` +
        "permissions, or name other dirs with --path (a group-writable /usr/local/bin is refused on purpose)",
    );
  }

  const notes: string[] = [];
  if (dropped.length > 0) {
    notes.push(`left out of the units' PATH, since ${user.name} can't reach them: ${dropped.join(", ")}`);
  }
  const units = archivistUnits({ user: user.name, bunPath, mainPath: MAIN_PATH, pathEnv, stateDir });
  const previous = await Bun.file(unitFile(ARCHIVIST_UNIT))
    .text()
    .catch(() => null);
  const previousPath = await Bun.file(unitFile(UPDATE_PATH_UNIT))
    .text()
    .catch(() => null);
  for (const [name, text] of Object.entries(units)) {
    // oxlint-disable-next-line no-await-in-loop -- three small files
    await Bun.write(join(SYSTEM_UNIT_DIR, name), text);
  }
  await systemctl(["daemon-reload"]);
  await systemctl(["enable", "--now", UPDATE_PATH_UNIT, ARCHIVIST_UNIT]);
  // As in the daemon's reinstall: `enable --now` leaves a running unit on its old
  // definition, and nothing else applies a new one — the service never rewrites its unit.
  if (previous !== null && previous !== units[ARCHIVIST_UNIT]) {
    const restart = await exec(scopeArgv("system").concat(["restart", ARCHIVIST_UNIT]));
    notes.push(
      restart.exitCode === 0
        ? "the unit definition changed, so the running archivist was restarted onto it"
        : `the unit definition changed but the restart failed (${restart.stderr.trim() || "denied"}): ` +
            `sudo systemctl restart ${ARCHIVIST_UNIT}`,
    );
  }
  // A running .path unit keeps the watch it was loaded with.
  if (previousPath !== null && previousPath !== units[UPDATE_PATH_UNIT]) {
    await exec(scopeArgv("system").concat(["restart", UPDATE_PATH_UNIT]));
  }
  notes.push(
    `the archivist runs as ${user.name}; \`journalctl -u ${ARCHIVIST_UNIT}\` is its log, and ` +
      `\`seance-archivist status\` run as ${user.name} prints the device id the relay's ARCHIVIST secret must name`,
  );
  return notes;
}

export async function uninstallArchivistSystem(): Promise<readonly string[]> {
  assertSystemd("uninstall --system");
  // Failures ignored: a unit that is not installed has nothing to stop.
  await exec(scopeArgv("system").concat(["disable", "--now", UPDATE_PATH_UNIT, ARCHIVIST_UNIT]));
  await exec(scopeArgv("system").concat(["stop", UPDATE_UNIT]));
  for (const name of [ARCHIVIST_UNIT, UPDATE_UNIT, UPDATE_PATH_UNIT] as const) {
    // oxlint-disable-next-line no-await-in-loop -- three small files
    await rm(unitFile(name), { force: true });
  }
  await exec(scopeArgv("system").concat("daemon-reload"));
  return [
    "the state dir is left in place: archive.sqlite, metrics.sqlite, the identity and the sealed blob " +
      "(a TPM-sealed blob can't be recreated from a backup)",
    "the relay still lists the seat and ARCHIVIST still names it — the README's move-the-seat runbook says how to forget it",
  ];
}
