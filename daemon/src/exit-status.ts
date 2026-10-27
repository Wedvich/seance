import { isTaskId, SIGKILL_STATUS } from "@seance/shared";
import type { ReapAudit } from "./audit.ts";
import { judgeOomKill, perPass, sampleOom, type OomProbe, type OomSample } from "./oom-kill.ts";
import { exitStatus, listPanes, paneInfo, type PaneInfo } from "./sessions.ts";
import { CLOSED_OPTION_PREFIX, EXIT_OPTION_PREFIX, noServer, tmux } from "./tmux.ts";

/**
 * A task session's exit status, for `failed` from exit status, and a window closed from
 * outside, for `session_closed` (DESIGN.md, Daemon, "Exit status", "Window closed from
 * outside"). A task spawn's window keeps `remain-on-exit on` once claude has registered
 * (`spawn.ts`), so every exit, a clean one included, leaves the pane dead holding
 * `pane_dead_status`. The status is noted in the launch ledger, where `progress` carries
 * it to the leader and a restart keeps it, and only then is the pane closed: once it is
 * gone the status is gone with it. A per-pane `pane-died` hook also records the status in
 * a server-wide option and closes a clean exit's pane at once, so a pane closed before
 * harvest still leaves its status; harvest reads and unsets those options too.
 *
 * A launched task whose pane is in no listing, with no exit and no close of this daemon's
 * own (`closing`) or marked by the CLI's despawn (`markClosed`), is noted `vanished`: something
 * outside Séance closed it, or its tmux server or machine stopped. The snapshot of such candidates is taken before the listing
 * and judged only against a listing from the server the task ran on.
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

/** An exit a task pane's `pane-died` hook recorded; `exit` is null when the value was not a status. */
export interface RecordedExit {
  readonly taskId: string;
  readonly exit: number | null;
}

/** What the server-wide options hold: the hooks' recorded exits, and the task ids `markClosed` marked. */
export interface Recorded {
  readonly exits: readonly RecordedExit[];
  readonly closes: readonly string[];
}

/** The tmux side of harvest, injected where `EndedTasks` is built so tests never touch the developer's tmux. */
export interface HarvestPanes {
  readonly list: () => Promise<readonly PaneInfo[]>;
  readonly close: (pane: PaneInfo) => Promise<unknown>;
  /** The answering tmux server's pid; null when no server answers. Throws on any other failure. */
  readonly server: () => Promise<number | null>;
  /** Every exit the hooks recorded (`EXIT_OPTION_PREFIX`) and close marked (`CLOSED_OPTION_PREFIX`); empty when no server answers. */
  readonly recorded: () => Promise<Recorded>;
  /** Unsets one recorded exit. */
  readonly clearExit: (taskId: string) => Promise<unknown>;
  /** Unsets one marked close. */
  readonly clearClose: (taskId: string) => Promise<unknown>;
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
    server: async () => {
      const result = await tmux(["display-message", "-p", "#{pid}"]);
      if (result.exitCode !== 0) {
        if (await noServer(result)) return null;
        throw new Error(`tmux display-message failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
      }
      const pid = Number(result.stdout.trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("tmux gave no server pid");
      return pid;
    },
    recorded: async () => {
      const result = await tmux(["show-options", "-g"]);
      if (result.exitCode !== 0) {
        if (await noServer(result)) return { exits: [], closes: [] };
        throw new Error(`tmux show-options failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
      }
      return parseRecorded(result.stdout);
    },
    clearExit: async (taskId) => {
      if (isTaskId(taskId)) await tmux(["set-option", "-gu", `${EXIT_OPTION_PREFIX}${taskId}`]);
    },
    clearClose: async (taskId) => {
      if (isTaskId(taskId)) await tmux(["set-option", "-gu", `${CLOSED_OPTION_PREFIX}${taskId}`]);
    },
  };
}

/**
 * `DespawnOptions.closing` for a process without the ledger (`seanced despawn`): marks the close in the
 * task's tmux server, for the daemon's harvest to note as `closedHere`. Set before the pane is touched, so
 * any listing that misses the pane postdates the mark, and harvest reads marks after its listing. A kill of
 * the server's last pane takes the mark with the server (DESIGN.md, "Window closed from outside").
 * False when tmux refused it.
 */
export async function markClosed(taskId: string): Promise<boolean> {
  if (!isTaskId(taskId)) return false;
  return (await tmux(["set-option", "-g", `${CLOSED_OPTION_PREFIX}${taskId}`, "1"])).exitCode === 0;
}

/**
 * `show-options -g` lines `@seance-exit-<id> <status>:<signal>` and `@seance-closed-<id> <any>`; any
 * same-uid process can set one, so ids and exit values are revalidated.
 */
export function parseRecorded(output: string): Recorded {
  const exits: RecordedExit[] = [];
  const closes: string[] = [];
  for (const line of output.split("\n")) {
    const space = line.indexOf(" ");
    const name = line.slice(0, space === -1 ? undefined : space);
    if (name.startsWith(CLOSED_OPTION_PREFIX)) {
      const taskId = name.slice(CLOSED_OPTION_PREFIX.length);
      if (isTaskId(taskId)) closes.push(taskId);
      continue;
    }
    if (!name.startsWith(EXIT_OPTION_PREFIX)) continue;
    const taskId = name.slice(EXIT_OPTION_PREFIX.length);
    if (!isTaskId(taskId)) continue;
    const value = space === -1 ? "" : line.slice(space + 1).replace(/^"(.*)"$/u, "$1");
    const [status = "", signal = ""] = value.split(":");
    exits.push({ taskId, exit: exitStatus(status, signal) });
  }
  return { exits, closes };
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
  /** Called before closing a dead task pane that holds no status: the daemon's own close is never `vanished`. */
  readonly closing: (taskId: string) => Promise<unknown>;
  /**
   * True while a launch of the task is still in flight: its `startNote` replaces the whole note, so an exit
   * noted before it would be lost. Absent means none is.
   */
  readonly launching?: (taskId: string) => boolean;
  /** Launches no exit, close or `vanished` note has accounted for yet, with the server each ran on. */
  readonly unaccounted: () => readonly {
    readonly taskId: string;
    readonly recordedAt: number;
    readonly server: number;
  }[];
  /** Notes the launch `vanished`, re-checking the ledger synchronously first (`LaunchLedger.noteVanished`). */
  readonly vanished: (launch: { readonly taskId: string; readonly recordedAt: number }) => Promise<unknown>;
  readonly oom?: HarvestOom;
}

/** Dead for certain: no such process. EPERM is a live process of another user. */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "ESRCH";
  }
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
 *
 * Order matters. The unaccounted launches are snapshotted before the listing, so a
 * launch that settles after it is not judged on a listing that predates it; the hooks'
 * recorded exits are read after it, since one may land between the two; and a failed
 * listing returns before anything is judged.
 */
export async function harvestExits(deps: HarvestDeps): Promise<void> {
  const candidates = deps.unaccounted();
  let panes: readonly PaneInfo[];
  try {
    panes = await deps.list();
  } catch {
    return;
  }
  const { oom } = deps;
  const probe = oom === undefined ? undefined : perPass(oom.probe);
  const noted = new Set<string>();
  await Promise.all(
    panes
      .filter((pane) => harvestable(pane) && !registering.has(pane.windowId))
      .map(async (pane) => {
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
          noted.add(pane.taskId);
        } else if (pane.taskId !== null) {
          // The daemon closing a pane that kept no status, so it must not read as closed from outside.
          await deps.closing(pane.taskId);
        }
        await deps.close(pane);
      }),
  );
  const recorded = await settleRecordedExits(deps, noted);
  if (recorded !== null) await judgeVanished(deps, candidates, panes, recorded);
  if (oom !== undefined) await sampleLive(panes, oom);
}

/**
 * The hooks' recorded exits into the ledger, then unset: only once the note was staged, so a failed
 * one is retried next pass. A task this pass already noted from its dead pane is only unset, and so is
 * one the ledger does not hold. One whose launch is still in flight is left unread and unset: the launch's
 * `startNote` would overwrite the exit, so a later pass picks it up. A value that is no status (a signal
 * death on a tmux without `pane_dead_signal`) notes `closedHere` first, as a pane with no status does, so
 * a close of its dead pane never reads `vanished`. A close `markClosed` marked is noted `closedHere` and
 * unset the same way, in flight launches excepted for the same reason. Null when tmux could not be read,
 * which judges nothing.
 */
async function settleRecordedExits(deps: HarvestDeps, noted: ReadonlySet<string>): Promise<ReadonlySet<string> | null> {
  let recorded: Recorded;
  try {
    recorded = await deps.recorded();
  } catch {
    return null;
  }
  const accounted = new Set<string>();
  for (const taskId of recorded.closes) {
    accounted.add(taskId);
    if (deps.launching?.(taskId) === true) continue;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one note each, a few at most
      await deps.closing(taskId);
      // oxlint-disable-next-line no-await-in-loop
      await deps.clearClose(taskId);
    } catch {
      // Left in place: the next pass notes and clears it.
    }
  }
  for (const { taskId, exit } of recorded.exits) {
    accounted.add(taskId);
    if (deps.launching?.(taskId) === true) continue;
    try {
      if (exit === null && !noted.has(taskId)) {
        // oxlint-disable-next-line no-await-in-loop -- one note each, a few at most
        await deps.closing(taskId);
      }
      // oxlint-disable-next-line no-await-in-loop -- one note each, a few at most
      if (exit !== null && !noted.has(taskId)) await deps.note(taskId, exit);
      // oxlint-disable-next-line no-await-in-loop
      await deps.clearExit(taskId);
    } catch {
      // Left in place: the next pass notes and clears it.
    }
  }
  return accounted;
}

/**
 * A launch no listed pane carries (live or dead, ours or not, registering or not: a pane moved by
 * `join-pane` keeps its task id) and no recorded exit explains is judged `vanished`, but only when the
 * listing provably speaks for the server it ran on: the same server answered, or that server is a dead
 * process. A missing socket while the old server still runs (a tmp cleaner, another `TMUX_TMPDIR`)
 * must not fail live sessions.
 */
async function judgeVanished(
  deps: HarvestDeps,
  candidates: ReturnType<HarvestDeps["unaccounted"]>,
  panes: readonly PaneInfo[],
  recorded: ReadonlySet<string>,
): Promise<void> {
  const carried = new Set(panes.flatMap((pane) => pane.taskId ?? []));
  const missing = candidates.filter((launch) => !carried.has(launch.taskId) && !recorded.has(launch.taskId));
  if (missing.length === 0) return;
  let answering: number | null;
  try {
    answering = await deps.server();
  } catch {
    return;
  }
  for (const launch of missing) {
    if (answering !== launch.server && !processGone(launch.server)) continue;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one note each, a few at most
      await deps.vanished(launch);
    } catch {
      // Harvest never throws; the next pass judges it again.
    }
  }
}
