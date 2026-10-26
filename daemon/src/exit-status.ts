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
  /** The sample the ledger holds for a task, taken while its pane lived. */
  readonly sampled: (taskId: string) => OomSample | undefined;
  /** Every task's sample of one pass, persisted together. */
  readonly noteSamples: (
    entries: readonly { readonly taskId: string; readonly sample: OomSample }[],
  ) => Promise<unknown>;
  readonly now?: () => number;
  /** Per sample and per judge read; tests shorten it. */
  readonly timeoutMs?: number;
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

/** Reads still running per probe: `bounded` stops waiting at its timeout, not reading, so a stalled `/proc` read outlives its pass. */
const outstanding = new WeakMap<OomProbe, number>();

/** The probe with its in-flight reads counted, so a pass can tell whether an earlier one's are still stuck. */
function counted(probe: OomProbe): OomProbe {
  const track = <A, T>(read: (arg: A) => Promise<T>) => {
    return (arg: A): Promise<T> => {
      outstanding.set(probe, (outstanding.get(probe) ?? 0) + 1);
      const settle = (): void => void outstanding.set(probe, (outstanding.get(probe) ?? 1) - 1);
      const running = read(arg);
      running.then(settle, settle);
      return running;
    };
  };
  return { cgroupOf: track(probe.cgroupOf), kills: track(probe.kills), exiting: track(probe.exiting) };
}

/**
 * Each live task pane's cgroup count into the ledger, one write for the pass, so the next pass that finds a pane
 * dead has a baseline. Single-flight: while an earlier sample's reads (a previous pass's or a spawn's) are still
 * outstanding it takes none, so stalled reads never pile up; the next pass samples once they settle.
 */
async function sampleLive(panes: readonly PaneInfo[], oom: HarvestOom): Promise<void> {
  if ((outstanding.get(oom.probe) ?? 0) > 0) return;
  // A fresh cache: counts the judge reads cached are older than this pass. One `at` taken before any read, so
  // it is never later than the count it stamps. Early is the safe side for the window checks: the death-side check
  // only rejects more, the span to the death is overstated by at most one read bound, and a kill landing between
  // `at` and the read is caught by the `exiting` check made after the count.
  const probe = perPass(counted(oom.probe));
  const at = (oom.now ?? Date.now)();
  const taken = await Promise.all(
    panes.filter(sampleable).map(async (pane) => {
      const sample = await sampleOom(pane, probe, () => at, oom.timeoutMs);
      return sample === null ? null : { taskId: pane.taskId, sample };
    }),
  );
  const entries = taken.filter((entry) => entry !== null);
  if (entries.length > 0) await oom.noteSamples(entries).catch(() => undefined);
}

/** `sampleLive` on its own, for a spawn that just landed: never throws. */
export async function sampleOomPanes(deps: Pick<HarvestPanes, "list">, oom: HarvestOom): Promise<void> {
  try {
    await sampleLive(await deps.list(), oom);
  } catch {
    // No baseline from this call; the next pass takes one.
  }
}

/**
 * Never throws: a failed pane read notes nothing, and the listing after it
 * fails the same way or lists the dead pane as running, which is no wrong
 * answer. With `oom`, a SIGKILL death is judged against its pane's last sample
 * before its status is noted, in one note. The dead panes go first: sampling
 * the live ones, however slow its reads, never delays noting an exit.
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
  await Promise.all(
    panes
      .filter((pane) => harvestable(pane) && !registering.has(pane.windowId))
      .map(async (pane) => {
        // Closed either way: reap skips a pane holding a status (`owesExit`), so one left here would linger for good.
        if (pane.taskId !== null && pane.deadStatus !== null) {
          const oomKill =
            pane.deadStatus === SIGKILL_STATUS && oom !== undefined && probe !== undefined
              ? await judgeOomKill(
                  oom.sampled(pane.taskId),
                  { paneId: pane.paneId, windowId: pane.windowId, deadAt: pane.deadAt },
                  probe,
                  oom.now,
                  oom.timeoutMs,
                )
              : undefined;
          await deps.note(pane.taskId, pane.deadStatus, oomKill);
        }
        await deps.close(pane);
      }),
  );
  if (oom !== undefined) await sampleLive(panes, oom);
}
