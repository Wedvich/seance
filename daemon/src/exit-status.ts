import { SIGKILL_STATUS } from "@seance/shared";
import type { ReapAudit } from "./audit.ts";
import { judgeOomKill, perPass, sampleOom, type OomProbe, type OomSample } from "./oom-kill.ts";
import { listPanes, paneInfo, type PaneInfo } from "./sessions.ts";
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
 * (`ReapOptions.harvest`) when it is on (`intervalHours` is 0 by default).
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
      // Pane ids restart from %0 with the tmux server: the one listed may be another window's by now.
      const fresh = await paneInfo(pane.paneId);
      if (fresh === null || !fresh.dead || fresh.windowId !== pane.windowId || fresh.taskId !== pane.taskId) return;
      if ((await tmux(["kill-pane", "-t", pane.paneId])).exitCode !== 0) return;
      await audit.closedPane(pane.paneId, pane.windowName, "exit-status");
    },
  };
}

/**
 * What harvest needs for the OOM verdict (`oom-kill.ts`); Linux only, so a
 * daemon elsewhere passes none and notes the status alone.
 */
export interface HarvestOom {
  readonly probe: OomProbe;
  /** The samples the ledger holds for a task, taken while its pane lived. */
  readonly sampled: (taskId: string) => readonly OomSample[] | undefined;
  readonly noteSamples: (taskId: string, samples: readonly OomSample[]) => Promise<unknown>;
}

export interface HarvestDeps extends HarvestPanes {
  /**
   * False when the task is not in this daemon's ledger (evicted, retracted, replaced): its status has nowhere to go.
   * `oomKill` only beside a SIGKILL status, and only when known.
   */
  readonly note: (taskId: string, exit: number, oomKill?: boolean) => Promise<boolean>;
  readonly oom?: HarvestOom;
}

/** A live pane of one of our tasks whose process can be sampled; one a spawn still awaits is sampled once it lands. */
function sampleable(pane: PaneInfo): pane is PaneInfo & { readonly taskId: string; readonly pid: number } {
  return pane.ours && !pane.dead && pane.taskId !== null && pane.pid !== null && !registering.has(pane.windowId);
}

/** Each live task pane's cgroup counts into the ledger, so the next pass that finds it dead has a baseline. */
async function sampleLive(panes: readonly PaneInfo[], oom: HarvestOom, probe: OomProbe): Promise<void> {
  await Promise.all(
    panes.filter(sampleable).map(async (pane) => {
      const samples = await sampleOom(pane.pid, probe);
      if (samples.length > 0) await oom.noteSamples(pane.taskId, samples).catch(() => undefined);
    }),
  );
}

/** `sampleLive` on its own, for a spawn that just landed: never throws. */
export async function sampleOomPanes(deps: Pick<HarvestPanes, "list">, oom: HarvestOom): Promise<void> {
  let panes: readonly PaneInfo[];
  try {
    panes = await deps.list();
  } catch {
    return;
  }
  await sampleLive(panes, oom, perPass(oom.probe));
}

/**
 * Never throws: a failed pane read notes nothing, and the listing after it
 * fails the same way or lists the dead pane as running, which is no wrong
 * answer. With `oom`, live task panes are sampled first and a SIGKILL death
 * judged against its last sample before its status is noted, in one note.
 */
export async function harvestExits(deps: HarvestDeps): Promise<void> {
  let panes: readonly PaneInfo[];
  try {
    panes = await deps.list();
  } catch {
    return;
  }
  const { oom } = deps;
  const probe = oom === undefined ? undefined : perPass(oom.probe);
  if (oom !== undefined && probe !== undefined) await sampleLive(panes, oom, probe);
  await Promise.all(
    panes
      .filter((pane) => harvestable(pane) && !registering.has(pane.windowId))
      .map(async (pane) => {
        // Closed either way: reap skips a pane holding a status (`owesExit`), so one left here would linger for good.
        if (pane.taskId !== null && pane.deadStatus !== null) {
          const oomKill =
            pane.deadStatus === SIGKILL_STATUS && oom !== undefined && probe !== undefined
              ? await judgeOomKill(oom.sampled(pane.taskId) ?? [], probe)
              : undefined;
          await deps.note(pane.taskId, pane.deadStatus, oomKill);
        }
        await deps.close(pane);
      }),
  );
}
