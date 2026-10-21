import type { ReapAudit } from "./audit.ts";
import { listPanes, type PaneInfo } from "./sessions.ts";
import { tmux } from "./tmux.ts";

/**
 * A task session's exit status, for `failed` from exit status (DESIGN.md, Daemon,
 * "Exit status"). A task spawn's window keeps `remain-on-exit failed` once
 * claude has registered (`spawn.ts`), so a clean exit closes it as before and
 * any other leaves the pane dead, holding `pane_dead_status`. The status is
 * noted in the launch ledger, where `progress` carries it to the leader and a
 * restart keeps it, and only then is the pane closed: once it is gone the
 * status is gone with it.
 *
 * Every `sessions` reply runs this after it lists panes and before it reads
 * `progress`. A dead pane drops out of the list (tmux gives it no cwd), so a
 * pane that dies before the listing is harvested here and in `progress`, and
 * one that dies after it was listed alive: either way the leader sees the task
 * running or its exit, never neither. Reap's timer runs it too
 * (`ReapOptions.harvest`), so panes nobody asks about do not linger.
 *
 * Registered panes only: one that died before its title went up is
 * `spawnSession`'s, which captures and closes it itself — and so is one whose
 * spawn is still polling for registration (`whileRegistering`), which harvest
 * leaves alone so it cannot steal the `claude_died` capture.
 */

const registering = new Set<string>();

/** Marks a window a spawn is still polling for registration, for the span of `run`. */
export async function whileRegistering<T>(windowId: string, run: () => Promise<T>): Promise<T> {
  registering.add(windowId);
  try {
    return await run();
  } finally {
    registering.delete(windowId);
  }
}

/** A dead pane of one of our task sessions that registered: this module's to close. */
export function harvestable(pane: PaneInfo): boolean {
  return pane.ours && pane.dead && pane.titled && pane.taskId !== null;
}

/** A harvestable pane holding a status not yet noted: reap leaves it, since closing it would lose the status. */
export function owesExit(pane: PaneInfo): boolean {
  return harvestable(pane) && pane.deadStatus !== null;
}

/** The tmux side of harvest, injected where `EndedTasks` is built so tests never touch the developer's tmux. */
export interface HarvestPanes {
  readonly list: () => Promise<readonly PaneInfo[]>;
  readonly close: (pane: PaneInfo) => Promise<unknown>;
}

/** The real tmux; each pane it closes is audited under origin `harvest`, one line like reap's. */
export function tmuxHarvestPanes(audit: Pick<ReapAudit, "closedPane">): HarvestPanes {
  return {
    list: listPanes,
    close: async (pane) => {
      if ((await tmux(["kill-pane", "-t", pane.paneId])).exitCode !== 0) return;
      await audit.closedPane(pane.paneId, pane.windowName, "exit-status");
    },
  };
}

export interface HarvestDeps extends HarvestPanes {
  /** False when the task is not in this daemon's ledger: its status has nowhere to go, so the pane stays for reap. */
  readonly note: (taskId: string, exit: number) => Promise<boolean>;
}

/**
 * Never throws: a failed pane read notes nothing, and the listing after it
 * fails the same way or lists the dead pane as running, which is no wrong
 * answer.
 */
export async function harvestExits(deps: HarvestDeps): Promise<void> {
  let panes: readonly PaneInfo[];
  try {
    panes = await deps.list();
  } catch {
    return;
  }
  await Promise.all(
    panes
      .filter((pane) => harvestable(pane) && !registering.has(pane.windowId))
      .map(async (pane) => {
        if (pane.taskId !== null && pane.deadStatus !== null && !(await deps.note(pane.taskId, pane.deadStatus)))
          return;
        await deps.close(pane);
      }),
  );
}
