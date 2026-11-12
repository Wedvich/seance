// `seance-archivist update`: the daemon's update pipeline (daemon/src/update.ts)
// on the archivist's own checkout. Run by hand as the archivist's user, or by
// `seance-archivist-update.service` when the running archivist asks
// (update-request.ts) — in both cases a process with no credential delivered,
// loaded only by main.ts's `import()` in this command (archivist/test/layering.test.ts).

import { daemonSink } from "../../daemon/src/audit.ts";
import { checkoutRoot, trimRoot } from "../../daemon/src/selfsource.ts";
import { signalRestartUnit } from "../../daemon/src/systemd.ts";
import { defaultUpdateEffects, updateNow, type ManualUpdate } from "../../daemon/src/update.ts";
import { archivistStateDir, updateRequestPathIn } from "./paths.ts";
import { ARCHIVIST_UNIT } from "./units.ts";
import { rootRefusal } from "./unprivileged.ts";
import { readRequestOrigin } from "./update-request.ts";

/**
 * Fetch, fast-forward the default branch, `bun install --frozen-lockfile`, and on
 * `ok` restart the service the way `seanced restart` restarts a system unit's
 * daemon: SIGTERM its MainPID, as the same user, for `Restart=always` to relaunch
 * on the new code. The unit file is never rewritten here (it is root's); a changed
 * definition is applied by re-running `install --system`. The same refusals as a
 * daemon's: a dirty, re-branched or diverged checkout is left alone.
 *
 * `servingSha` is null: the running archivist cannot read its own HEAD without
 * running git, which it never does, so a checkout already current restarts
 * nothing. After a hand `git pull`, restart the unit yourself.
 */
export async function updateArchivist(opts: { readonly requested: boolean }): Promise<ManualUpdate> {
  // Root would leave root-owned files in the checkout and its node_modules.
  const refusal = rootRefusal(process.getuid?.(), process.getgid?.());
  if (refusal !== null) throw new Error(refusal);
  return updateNow({
    root: trimRoot(checkoutRoot()),
    sink: daemonSink,
    servingSha: null,
    effects: { install: defaultUpdateEffects().install, restart: () => signalRestartUnit(ARCHIVIST_UNIT) },
    origin: opts.requested ? await readRequestOrigin(updateRequestPathIn(archivistStateDir())) : "cli",
  });
}
