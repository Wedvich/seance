// `seance-archivist update`: the daemon's update pipeline (daemon/src/update.ts)
// on the archivist's own checkout. Run by hand as the archivist's user, or by
// `seance-archivist-update.service` when the running archivist asks
// (update-request.ts) — in both cases a process with no credential delivered,
// loaded only by main.ts's `import()` in this command (archivist/test/layering.test.ts).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { daemonSink } from "../../daemon/src/audit.ts";
import { checkoutRoot, readSource, trimRoot } from "../../daemon/src/selfsource.ts";
import { signalRestartUnit } from "../../daemon/src/systemd.ts";
import { defaultUpdateEffects, updateNow, type ManualUpdate } from "../../daemon/src/update.ts";
import { archivistStateDir, servedShaPathIn, updateRequestPathIn } from "./paths.ts";
import { ARCHIVIST_UNIT, expectedArchivistUnits } from "./units.ts";
import { rootRefusal } from "./unprivileged.ts";
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
 * Fetch, fast-forward the default branch, `bun install --frozen-lockfile`, and on
 * `ok` restart the service the way `seanced restart` restarts a system unit's
 * daemon: SIGTERM its MainPID, as the same user, for `Restart=always` to relaunch
 * on the new code. The unit files are never rewritten here (they are root's); a
 * changed definition is reported and applied by re-running `install --system`. The
 * same refusals as a daemon's: a dirty, re-branched or diverged checkout is left alone.
 *
 * The running archivist cannot read its own HEAD without running git, which it
 * never does, so `served-sha` in the state dir stands for it: written after each
 * restart this command made (and, the first time, with the HEAD it found, taken
 * to be what the install started). A checkout ahead of it — a failed install
 * after a fast-forward, or a hand `git pull` — is installed again and restarted onto.
 *
 * A request that lands while this runs is merged into the running job by systemd, so the
 * run repeats while the request file changes (`runWhileRequested`).
 */
export async function updateArchivist(opts: { readonly requested: boolean }): Promise<ManualUpdate> {
  // Root would leave root-owned files in the checkout and its node_modules.
  const refusal = rootRefusal(process.getuid?.(), process.getgid?.());
  if (refusal !== null) throw new Error(refusal);
  const root = trimRoot(checkoutRoot());
  const stateDir = archivistStateDir();
  const requestPath = updateRequestPathIn(stateDir);
  const servedPath = servedShaPathIn(stateDir);

  const drift = await unitDrift();
  if (drift.length > 0) {
    console.error(
      `warning: the installed units differ from this checkout's (${drift.join(", ")}) — re-run ` +
        '`install --system` as root to apply them (README, "Optional: the archivist")',
    );
  }

  const recordServed = async (): Promise<void> => {
    const sha = (await readSource(root))?.sha;
    if (sha !== undefined) await Bun.write(servedPath, `${sha}\n`, { mode: 0o600 });
  };
  const readServed = async (): Promise<string | null> => {
    const text = (await readFile(servedPath, "utf8").catch(() => "")).trim();
    return SHA.test(text) ? text : null;
  };
  if ((await readServed()) === null) await recordServed();

  return runWhileRequested(requestPath, async () =>
    updateNow({
      root,
      sink: daemonSink,
      servingSha: await readServed(),
      effects: {
        install: defaultUpdateEffects().install,
        restart: async () => {
          await signalRestartUnit(ARCHIVIST_UNIT, RESTART_WORDING);
          await recordServed();
        },
      },
      origin: opts.requested ? await readRequestOrigin(requestPath) : "cli",
    }),
  );
}
