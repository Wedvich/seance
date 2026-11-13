import { CRED_NAME } from "../../daemon/src/credential.ts";
import { dirname } from "node:path";
import { pskBlobPathIn } from "../../daemon/src/paths.ts";
import {
  ARCHIVIST_UNIT_NAME,
  assertUnitFlag,
  unitBunPath,
  unitCredentialBlob,
  unitEscape,
  unitPathEnv,
  unitUser,
} from "../../daemon/src/systemd.ts";
import { updateRequestPathIn } from "./paths.ts";

/** The service that holds the seat and the key. */
export const ARCHIVIST_UNIT = ARCHIVIST_UNIT_NAME;
/** The oneshot that runs `update`: same user, no credential. */
export const UPDATE_UNIT = "seance-archivist-update.service";
/** Starts the update unit when the running archivist writes its request. */
export const UPDATE_PATH_UNIT = "seance-archivist-update.path";

export type ArchivistUnitName = typeof ARCHIVIST_UNIT | typeof UPDATE_UNIT | typeof UPDATE_PATH_UNIT;

export interface ArchivistUnitOptions {
  /** The archivist's own account, never root and never the daemon's (DESIGN.md, Archivist, A27a). */
  readonly user: string;
  /** Resolved from `pathEnv`, never the running interpreter's realpath, which a package manager retires. */
  readonly bunPath: string;
  readonly mainPath: string;
  readonly pathEnv: string;
  /** The user's archivist state dir: the blob and the update request live there. */
  readonly stateDir: string;
}

/**
 * The three system units `install --system` writes, from one set of values so
 * they cannot disagree on the user, the checkout or the PATH. Values go through
 * the daemon's own `unitEscape`, and the credential id is its `CRED_NAME`: the
 * archivist reads `$CREDENTIALS_DIRECTORY/seance-psk` like a daemon does.
 *
 * Only the service gets `LoadCredentialEncrypted=`. The update unit runs git and
 * `bun install` from origin, so it is the one that must not hold the key; the
 * service holds it and loads no exec path. `Restart=always` is load-bearing as
 * in the daemon's system unit: `update` restarts the service by SIGTERM, which
 * it can send as the same user but which a clean exit under `on-failure` would
 * leave down. Logs go to the journal: the archivist is Linux-only, so there is
 * no other platform's trail to match, and no `append:` file for root to create.
 */
export function archivistUnits(opts: ArchivistUnitOptions): Readonly<Record<ArchivistUnitName, string>> {
  assertUnitFlag("--path", opts.pathEnv);
  // Neither arrives from a flag, but both land in the unit verbatim all the same.
  assertUnitFlag("the checkout's main.ts", opts.mainPath, true);
  assertUnitFlag("the state dir", opts.stateDir, true);
  const exec = (command: string): string =>
    `ExecStart="${unitEscape(opts.bunPath)}" "${unitEscape(opts.mainPath)}" ${command}`;
  const user = `User=${unitEscape(opts.user)}`;
  const path = `Environment="PATH=${unitEscape(opts.pathEnv)}"`;
  return {
    [ARCHIVIST_UNIT]: lines([
      "[Unit]",
      "Description=Seance archivist (seance-archivist)",
      "",
      "[Service]",
      user,
      exec("run"),
      `LoadCredentialEncrypted=${CRED_NAME}:${unitEscape(pskBlobPathIn(opts.stateDir))}`,
      "Restart=always",
      "RestartSec=5",
      path,
      "",
      "[Install]",
      "WantedBy=multi-user.target",
    ]),
    [UPDATE_UNIT]: lines([
      "[Unit]",
      "Description=Seance archivist update check (seance-archivist update)",
      // A crash-looping service asks on each start and a skip exits fast; under the default limit (5 starts
      // in 10s) systemd would fail this unit and then the path unit, which would stop watching for good.
      "StartLimitIntervalSec=0",
      "",
      "[Service]",
      "Type=oneshot",
      user,
      exec("update --requested"),
      // A oneshot has no start timeout by default; a fetch, an install and a restart fit well inside this.
      "TimeoutStartSec=15min",
      path,
    ]),
    [UPDATE_PATH_UNIT]: lines([
      "[Unit]",
      "Description=Seance archivist: check for an update when the archivist asks",
      "",
      "[Path]",
      `PathChanged=${unitEscape(updateRequestPathIn(opts.stateDir))}`,
      `Unit=${UPDATE_UNIT}`,
      "",
      "[Install]",
      "WantedBy=multi-user.target",
    ]),
  };
}

/**
 * The units `install --system` would write now for the service already
 * installed: its own user, bun, PATH and state dir (read back from its text),
 * this checkout's main.ts and the current generators. What differs from the
 * installed files is drift an automatic update cannot apply (the units are
 * root's). Null when the installed service isn't one of ours to compare.
 */
export function expectedArchivistUnits(
  installedService: string,
  mainPath: string,
): Readonly<Record<ArchivistUnitName, string>> | null {
  const user = unitUser(installedService);
  const bunPath = unitBunPath(installedService);
  const pathEnv = unitPathEnv(installedService);
  const blob = unitCredentialBlob(installedService);
  if (user === null || bunPath === null || pathEnv === null || blob === null) return null;
  return archivistUnits({ user, bunPath, mainPath, pathEnv, stateDir: dirname(blob) });
}

function lines(body: readonly string[]): string {
  return `${body.join("\n")}\n`;
}
