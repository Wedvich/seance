// `seance-archivist update`: the daemon's update pipeline (daemon/src/update.ts)
// on the archivist's own checkout. Run by hand as the archivist's user, or by
// `seance-archivist-update.service` when the running archivist asks
// (update-request.ts) — in both cases a process with no credential delivered,
// loaded only by main.ts's `import()` in this command (archivist/test/layering.test.ts).

import { readFile, rm } from "node:fs/promises";
import type { SourceInfo } from "@seance/shared";
import { fileURLToPath } from "node:url";
import { daemonSink } from "../../daemon/src/audit.ts";
import { checkoutRoot, readSource, trimRoot } from "../../daemon/src/selfsource.ts";
import { signalRestartUnit } from "../../daemon/src/systemd.ts";
import { defaultUpdateEffects, updateNow, type ManualUpdate } from "../../daemon/src/update.ts";
import {
  archivistStateDir,
  servedShaPathIn,
  servedSourcePathIn,
  updateLockPathIn,
  updateRequestPathIn,
} from "./paths.ts";
import { ARCHIVIST_UNIT, expectedArchivistUnits } from "./units.ts";
import { rootRefusal } from "./unprivileged.ts";
import { withUpdateLock } from "./update-lock.ts";
import { readRequestOrigin, runWhileRequested } from "./update-request.ts";

const SYSTEM_UNIT_DIR = "/etc/systemd/system";
const MAIN_PATH = fileURLToPath(new URL("./main.ts", import.meta.url));

/** The service's unit by name, so a failed restart names the archivist's own unit and root command. */
const RESTART_WORDING = {
  who: "the archivist",
  privileged: `sudo systemctl restart ${ARCHIVIST_UNIT}`,
  checkAlso: "",
} as const;

const SHA = /^[0-9a-f]{40}$/u;
/** Never equal to a HEAD, so a run with no `served-sha` restarts onto the checkout; it reads in the audit detail. */
const UNRECORDED = "no recorded sha";

/**
 * The installed units that differ from what this checkout's generators would
 * write for the same user, bun, PATH and state dir. Empty when they match, or
 * when there is no installed service to compare (a hand-run `update`). The
 * running process is the old code on the run that fast-forwards, so a change a
 * pull brings in is seen on the next run.
 */
export async function unitDrift(
  mainPath: string = MAIN_PATH,
  unitDir: string = SYSTEM_UNIT_DIR,
): Promise<readonly string[]> {
  const read = (name: string): Promise<string | null> => readFile(`${unitDir}/${name}`, "utf8").catch(() => null);
  const installed = await read(ARCHIVIST_UNIT);
  if (installed === null) return [];
  const expected = expectedArchivistUnits(installed, mainPath);
  if (expected === null) return [];
  const drifted: string[] = [];
  for (const [name, text] of Object.entries(expected)) {
    // oxlint-disable-next-line no-await-in-loop -- three small files
    if ((await read(name)) !== text) drifted.push(name);
  }
  return drifted;
}

/**
 * Write the checkout's git identity for the restarted archivist's card (its build line).
 * Best-effort: a cosmetic file never decides whether new code goes live, so a failed
 * write is logged and the restart goes on. With no readable source the old file is
 * removed, since it describes a commit this update replaced — no build line beats a wrong one.
 */
export async function recordServedSource(path: string, read: () => Promise<SourceInfo | null>): Promise<void> {
  try {
    const source = await read();
    if (source === null) {
      await rm(path, { force: true });
      return;
    }
    await Bun.write(path, JSON.stringify(source), { mode: 0o600 });
  } catch (err) {
    console.error(`warning: could not record the served source: ${String(err)}`);
  }
}

/**
 * Fetch, fast-forward the default branch, `bun install --frozen-lockfile`, and on
 * `ok` restart the service the way `seanced restart` restarts a system unit's
 * daemon: SIGTERM its MainPID, as the same user, for `Restart=always` to relaunch
 * on the new code. The unit files are never rewritten here (they are root's); a
 * changed definition is reported and applied by re-running `install --system`. The
 * same refusals as a daemon's: a dirty, re-branched or diverged checkout is left alone.
 *
 * The running archivist cannot read its own HEAD without running git, which it
 * never does, so `served-sha` in the state dir stands for it: written only after
 * a restart this command made, which follows a successful install, so it never
 * names a sha whose install failed. With none (a first run, or one deleted) what
 * the service runs is unknown, so the checkout is installed again and the service
 * restarted onto it once, rather than assuming HEAD. A checkout ahead of it — a
 * failed install after a fast-forward, or a hand `git pull` — likewise.
 *
 * A request that lands while this runs is merged into the running job by systemd, so the
 * run repeats while the request file changes (`runWhileRequested`); the stamp it compares
 * is taken before anything else here runs. One update at a time holds `update.lock`:
 * null when another does, which has that loop for any request made since.
 */
export async function updateArchivist(opts: { readonly requested: boolean }): Promise<ManualUpdate | null> {
  // Root would leave root-owned files in the checkout and its node_modules.
  const refusal = rootRefusal(process.getuid?.(), process.getgid?.());
  if (refusal !== null) throw new Error(refusal);
  const root = trimRoot(checkoutRoot());
  const stateDir = archivistStateDir();
  const requestPath = updateRequestPathIn(stateDir);
  const servedPath = servedShaPathIn(stateDir);

  const recordServed = async (): Promise<void> => {
    const sha = (await readSource(root))?.sha;
    if (sha !== undefined) await Bun.write(servedPath, `${sha}\n`, { mode: 0o600 });
  };
  const recordSource = (): Promise<void> => recordServedSource(servedSourcePathIn(stateDir), () => readSource(root));
  const readServed = async (): Promise<string | null> => {
    const text = (await readFile(servedPath, "utf8").catch(() => "")).trim();
    return SHA.test(text) ? text : null;
  };

  return withUpdateLock(updateLockPathIn(stateDir), () =>
    runWhileRequested(requestPath, async () => {
      const drift = await unitDrift();
      if (drift.length > 0) {
        console.error(
          `warning: the installed units differ from this checkout's (${drift.join(", ")}) — re-run ` +
            '`install --system` as root to apply them (README, "Optional: the archivist")',
        );
      }
      return updateNow({
        root,
        sink: daemonSink,
        servingSha: (await readServed()) ?? UNRECORDED,
        effects: {
          install: defaultUpdateEffects().install,
          restart: async () => {
            // Before the signal: the restarted process reads it at start, so it must be there first.
            await recordSource();
            await signalRestartUnit(ARCHIVIST_UNIT, RESTART_WORDING);
            await recordServed();
          },
        },
        origin: opts.requested ? await readRequestOrigin(requestPath) : "cli",
      });
    }),
  );
}
