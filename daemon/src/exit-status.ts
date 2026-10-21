import type { PaneInfo } from "./sessions.ts";

/**
 * A task session's exit status, for `failed` from exit status (DESIGN.md, Daemon,
 * "Exit status"). A task spawn's window keeps `remain-on-exit failed` once
 * claude has registered (`spawn.ts`), so a clean exit closes it as before and
 * any other leaves the pane dead, holding `pane_dead_status`. The status is
 * noted in the launch ledger, where `progress` carries it to the leader and a
 * restart keeps it, and only then is the pane closed: once it is gone the
 * status is gone with it.
 *
 * Every `sessions` reply runs this before it lists panes, so a dead pane is in
 * the list (and its task still running) or its status is in `progress`, never
 * neither. Registered panes only: one that died before its title went up is
 * `spawnSession`'s, which captures and closes it itself.
 */

/** A dead pane of one of our task sessions that registered: this module's to close. */
export function harvestable(pane: PaneInfo): boolean {
  return pane.ours && pane.dead && pane.titled && pane.taskId !== null;
}

/** A harvestable pane holding a status not yet noted: reap leaves it, since closing it would lose the status. */
export function owesExit(pane: PaneInfo): boolean {
  return harvestable(pane) && pane.deadStatus !== null;
}

export interface HarvestDeps {
  readonly panes: () => Promise<readonly PaneInfo[]>;
  /** Best-effort, like every ledger note: the pane is closed whether or not the write landed, as memory keeps it. */
  readonly note: (taskId: string, exit: number) => Promise<unknown>;
  readonly close: (paneId: string) => Promise<unknown>;
}

/**
 * Never throws: a failed pane read notes nothing, and the listing after it
 * fails the same way or lists the dead pane as running, which is no wrong
 * answer.
 */
export async function harvestExits(deps: HarvestDeps): Promise<void> {
  let panes: readonly PaneInfo[];
  try {
    panes = await deps.panes();
  } catch {
    return;
  }
  await Promise.all(
    panes.filter(harvestable).map(async (pane) => {
      if (pane.taskId !== null && pane.deadStatus !== null) await deps.note(pane.taskId, pane.deadStatus);
      await deps.close(pane.paneId);
    }),
  );
}
