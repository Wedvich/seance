import {
  httpsUrl,
  isNeedsInputReason,
  isToolName,
  isRecord,
  isRemoteSessionId,
  isSessionState,
  isTaskId,
  quote,
  SESSIONS_MAX_PROGRESS,
  SUCCESSOR_RECORD_MAX,
  type NeedsInputReason,
  type PassCloseResponse,
  type PushBranchResponse,
  type SessionEvent,
  type SessionPass,
  type SessionState,
  type TaskProgress,
} from "@seance/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exclaveOf, type Exclave } from "./exclaves.ts";
import { harvestExits, sampleOomPanes, type HarvestOom, type HarvestPanes } from "./exit-status.ts";
import { LaunchLedger, pathOwners, type LaunchSite, type NoteOutcome } from "./launch-ledger.ts";
import { log } from "./log.ts";
import type { OomProbe } from "./oom-kill.ts";
import { ancestorIn, peerPid, peerPidSupported, socketFd } from "./peer.ts";
import {
  SESSION_EVENT_KIND,
  SESSION_EVENT_VERSION,
  type PassAck,
  type SessionEventReply,
} from "./session-event-frame.ts";
import type { TrackedState } from "./pane-activity.ts";
import { CUSTODIAN_FIELD, FIELD_SEP, listAllPanes, OURS, TASK_FIELD, tmux } from "./tmux.ts";

/**
 * The `session-event` frame kind on the local op socket (DESIGN.md, "Session
 * events"): what the `claude-mods/session-events` mod reports about the session
 * it runs in, through `seanced session-event`. Ingest-only — the handler stores
 * (the ended-task memory, and each séance pane's last state, `pane-activity.ts`)
 * and forwards, and tells the bound pane's exclave it saw activity (the `/usage`
 * refresh's trigger, which decides alone whether anything runs); nothing here
 * spawns or runs a command shaped by the frame. The one despawn is a hand-off's
 * (`hand_off_task`): the bound pane's own, at its next `idle`, never a pane the
 * frame names. Its own only
 * subprocesses are fixed-argv reads: `tmux list-panes` and, on macOS where
 * `proc_pidinfo` will not answer a hop, `ps` for the parent walk. The one
 * indirect run is the `/usage` refresh the poke may start (staleness-gated,
 * fixed argv, built env).
 *
 * Every field of a frame is untrusted. The run directory admits any process of
 * this user, and every session is this user, so a frame could name any pane or
 * task. None is taken from it: the pane is the one the kernel-reported peer
 * pid runs under, and the task and exclave come from that pane. Only on a host
 * that cannot name any peer (`peerPidSupported`) does the frame's own `pane`
 * decide, and that is the residual the threat model records. On one that can,
 * a connection whose pid the kernel did not give is refused, never bound by
 * its claim: macOS's LOCAL_PEERPID fails once the peer has closed, so a sender
 * that writes and exits fast would otherwise pick its own pane.
 *
 * Like a broker frame, never a `Plain` and never an `OpName`: no `op`, no `id`,
 * no `ts`, so it cannot arrive from the relay, no op rides in as one, and a
 * daemon that predates the kind drops it as malformed.
 */

export interface SessionEventFrame {
  readonly v: typeof SESSION_EVENT_VERSION;
  readonly kind: typeof SESSION_EVENT_KIND;
  /** Absent only on an older mod's rate-limit report: activity, nothing else. */
  readonly state?: SessionState;
  readonly prUrl?: string;
  /** `$CLAUDE_CODE_BRIDGE_SESSION_ID` as the session saw it — kept only as `isRemoteSessionId` passes it. */
  readonly remoteSession?: string;
  /** `$TMUX_PANE` as the session saw it — consulted only on a host that can name no peer at all. */
  readonly pane?: string;
  /** `hand_off_task`'s: close this session at the end of its turn, its PR left to the scheduler. Carries no state. */
  readonly handoff?: true;
  /**
   * `pass_to_successor`'s: push this session's branch and pass its task to a successor, closing it at the end
   * of its turn once the leader confirms. Carries no state; `record` is the session's own prompt text for the
   * successor, bounded here and never logged.
   */
  readonly pass?: true;
  readonly record?: string;
  /**
   * Only beside `idle`: the mod saw the main loop's turn complete, so its last message is written. A
   * `session.start` (a hooks-worker respawn mid-turn too) reads idle without it. Only a hand-off reads it.
   */
  readonly turnEnded?: true;
  /** Only beside `needs-input`. `question` (an AskUserQuestion is open) lifts the leader's alert debounce for the stay; `permission` is display-only. */
  readonly reason?: NeedsInputReason;
  /** Only beside `reason: "permission"`: the prompt's tool, kept only as `isToolName` passes it. Display-only. */
  readonly tool?: string;
}

/** Routed on `kind` ahead of the `Plain` check, as broker frames are. */
export function isSessionEventFrameKind(raw: unknown): boolean {
  return isRecord(raw) && raw["kind"] === SESSION_EVENT_KIND;
}

const MAX_FIELD = 64;

/**
 * A frame with no `state` is still read when it carries `rateLimits`: a session
 * started before the mod dropped its rate-limit tap keeps that hook loaded until
 * it restarts (or `/reload-plugins`), and its reports are activity in its
 * exclave — the refresh's trigger — rather than malformed frames to warn about.
 * The numbers themselves are never read: the config dir's cache is the one source.
 * A `reason` is kept only when known and beside `needs-input`, and otherwise
 * dropped, never the frame: it is worth no more than the debounce it lifts. A
 * `tool` is kept only beside `permission` and as `isToolName` passes it; no
 * line is logged for a dropped one.
 */
export function parseSessionEventFrame(raw: unknown): SessionEventFrame | null {
  if (!isRecord(raw) || raw["v"] !== SESSION_EVENT_VERSION || raw["kind"] !== SESSION_EVENT_KIND) return null;
  const { state, prUrl, remoteSession, rateLimits, pane, handoff, pass, record, turnEnded, reason, tool } = raw;
  if (pane !== undefined && (typeof pane !== "string" || pane.length > MAX_FIELD)) return null;
  if (pass !== undefined) {
    // Alone, as a hand-off is, and never beside one: no ingest path can read a pass as anything else.
    if (pass !== true || handoff !== undefined || state !== undefined) return null;
    if (typeof record !== "string" || record === "" || record.length > SUCCESSOR_RECORD_MAX) return null;
    return {
      v: SESSION_EVENT_VERSION,
      kind: SESSION_EVENT_KIND,
      pass: true,
      record,
      ...(pane === undefined ? {} : { pane }),
    };
  }
  if (handoff !== undefined) {
    // Alone: a hand-off rides no state, so no ingest path can read one as the other.
    if (handoff !== true || state !== undefined) return null;
    return {
      v: SESSION_EVENT_VERSION,
      kind: SESSION_EVENT_KIND,
      handoff: true,
      ...(pane === undefined ? {} : { pane }),
    };
  }
  if (state !== undefined && !isSessionState(state)) return null;
  if (prUrl !== undefined && typeof prUrl !== "string") return null;
  if (remoteSession !== undefined && typeof remoteSession !== "string") return null;
  if (turnEnded !== undefined && (turnEnded !== true || state !== "idle")) return null;
  if (state === undefined && rateLimits === undefined) return null;
  return {
    v: SESSION_EVENT_VERSION,
    kind: SESSION_EVENT_KIND,
    ...(state === undefined ? {} : { state }),
    ...(prUrl === undefined ? {} : { prUrl }),
    ...(remoteSession === undefined ? {} : { remoteSession }),
    ...(pane === undefined ? {} : { pane }),
    ...(turnEnded === true ? { turnEnded } : {}),
    ...(state === "needs-input" && isNeedsInputReason(reason) ? { reason } : {}),
    ...(state === "needs-input" && reason === "permission" && isToolName(tool) ? { tool } : {}),
  };
}

/** A pane as the binding needs it: its process, liveness, task, whether séance started it, and where it sits. */
export interface BoundPane {
  readonly id: string;
  readonly pid: number;
  readonly dead: boolean;
  readonly taskId: string | null;
  /** Started by séance (`OURS`): only these are retained per pane (`pane-activity.ts`). */
  readonly ours: boolean;
  readonly path: string;
}

const PANE_PID_FORMAT = [
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_dead}",
  TASK_FIELD,
  OURS,
  CUSTODIAN_FIELD,
  "#{pane_current_path}",
].join(FIELD_SEP);

/**
 * Pure parser over `list-panes -a` in `PANE_PID_FORMAT`; path last, taken as the remainder. A pane carrying
 * `@seance-custodian` is dropped (C10): the seat's round can bind no frame, take no message or drain key and is never
 * sampled. The `custodian` frame binds against its own reader, `listRoundPanePids` (`custodian-launch.ts`), which keeps them.
 */
export function parsePanePids(raw: string): readonly BoundPane[] {
  const seen = new Set<string>();
  const panes: BoundPane[] = [];
  for (const line of raw.split("\n")) {
    const [id, pid, dead, task, ours, custodian, ...rest] = line.split(FIELD_SEP);
    if (
      id === undefined ||
      pid === undefined ||
      dead === undefined ||
      task === undefined ||
      ours === undefined ||
      custodian === undefined ||
      rest.length === 0
    )
      continue;
    if (custodian === "1") continue;
    // Grouped sessions repeat every pane.
    if (seen.has(id) || !/^%\d+$/u.test(id)) continue;
    seen.add(id);
    panes.push({
      id,
      pid: Number(pid),
      dead: dead === "1",
      taskId: isTaskId(task) ? task : null,
      ours: ours === "1",
      path: rest.join(FIELD_SEP),
    });
  }
  return panes;
}

export async function listPanePids(): Promise<readonly BoundPane[]> {
  const result = await tmux(["list-panes", "-a", "-F", PANE_PID_FORMAT]);
  return result.exitCode === 0 ? parsePanePids(result.stdout) : [];
}

/**
 * As `listPanePids`, but a failed read throws (`TmuxError`) and only a missing server reads as no panes: the
 * screen sampler must never take a tmux hiccup for every pane gone.
 */
export async function readPanePids(): Promise<readonly BoundPane[]> {
  return parsePanePids(await listAllPanes(PANE_PID_FORMAT));
}

/**
 * How long an `ended` event is remembered: at least the reservation TTL (120s,
 * `scheduler/src/config.ts`) with room for a check that waited out an
 * unreachable machine. The launches themselves are the ledger's, which outlives
 * restarts; an event adds only a task some other path tagged. The cap bounds
 * memory however fast tasks churn and, with `LEDGER_MAX`, keeps the reply's
 * `ended` far inside one envelope.
 */
export const ENDED_TTL_MS = 30 * 60_000;
export const ENDED_MAX = 128;

/**
 * What `EndedTasks.launch` hands back: told whether the spawn launched, and
 * only then is the launch over. `launched` is about the id (a launch that may
 * have run is not retracted); `landed` is passed only by a spawn that
 * succeeded, and only that starts the task's note afresh — a refusal such as
 * `task_running`, or a crash, leaves the earlier launch's note alone. `site`
 * is where a worktree-mode launch landed, noted before the launch counts as
 * over so a `sessions` waiting on `settled` sees it.
 */
export type SettleLaunch = (
  launched: boolean,
  landed?: { readonly site?: LaunchSite; readonly server?: number },
  /**
   * `unknown`: the backend crashed (threw something that is no refusal), so a window may exist untagged. With
   * `launched: true`; the id is then marked `interrupted` rather than cleared, like a launch the process died in.
   */
  outcome?: { readonly unknown?: true },
) => Promise<void>;

/**
 * The `sessions` reply's `ended` and `ledgerSince` — the backstop for a
 * scheduler that lost both a spawn's reply and the session's `ended` event, and
 * the proof that lets it re-dispatch one that never landed (DESIGN.md,
 * "Session events"). Two inputs: every task this daemon launches, recorded in
 * the durable `LaunchLedger` before the spawn runs, and `ended` events, kept in
 * memory. A task in either that no session in the reply carries is listed — so
 * a lost event, a session the mod never saw, a crash that fired no SessionEnd,
 * and a pane stuck before it registered all read as ran-and-ended, never as
 * never-started. A launch the process died in the middle of is listed too, and
 * also named in `interrupted` (`LaunchLedger`): a leader that reads the field
 * does not settle it `done`, and one that predates it still reads it as ran.
 *
 * It also holds task launches while the daemon is about to exit (`drain`): a
 * launch begun then would be cut off, so it is refused unrecorded instead
 * (`LaunchesClosed`).
 */
/**
 * The launches of one task id in flight together. Only the first can find the
 * id unrecorded, and only once none of them landed may it be retracted: two
 * spawns of one id (a duplicate dispatch) must not let the one that failed
 * take back the one that ran.
 */
interface Launches {
  open: number;
  retractable: boolean;
  landed: boolean;
  /** One of them crashed with no verdict (`SettleLaunch`'s `unknown`) and none was seen to land. */
  crashed: boolean;
  confirmed: boolean;
  /** Newest PR URL a session reported while one of them was in flight: the landed launch's note keeps it. */
  prUrl?: string;
}

/**
 * A task launch arrived while the daemon is restarting. Nothing was recorded or
 * run, so the spawn is answered with a transport code (`internal_error`): its
 * leader leaves the task reserved and settles it from `sessions` at the TTL.
 */
export class LaunchesClosed extends Error {
  constructor() {
    super("this daemon is restarting, so no task launch was recorded or run — it will be settled from `sessions`");
    this.name = "LaunchesClosed";
  }
}

export class EndedTasks {
  #closed = false;
  /** Set by `drain(_, { final: true })`: the daemon is exiting, so `reopen` no longer undoes the close. */
  #final = false;
  /** Spawn handlers a launch was accepted for, until their reply is out. Only `drain` waits on these. */
  readonly #holds = new Set<Promise<void>>();
  /** Told on each close and reopen of the gate: a daemon's status carries it (`MachineStatus.drn`). */
  readonly #gateListeners = new Set<(closed: boolean) => void>();
  readonly #ended = new Map<string, number>();
  readonly #ledger: LaunchLedger;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #launches = new Map<string, Launches>();
  readonly #now: () => number;
  readonly #panes: HarvestPanes | undefined;
  readonly #oom: HarvestOom | undefined;

  /**
   * `panes` is the tmux side of `harvestExits`; without it harvest does nothing.
   * `oom` (Linux only) samples live task panes and judges a SIGKILL death.
   */
  constructor(
    ledger: LaunchLedger = LaunchLedger.memory(),
    now: () => number = Date.now,
    panes?: HarvestPanes,
    oom?: OomProbe,
    oomTimeoutMs?: number,
  ) {
    this.#ledger = ledger;
    this.#now = now;
    this.#panes = panes;
    this.#oom =
      oom === undefined
        ? undefined
        : {
            probe: oom,
            sampled: (taskId) => ledger.notes().find((note) => note.taskId === taskId)?.oom,
            noteSamples: (entries) =>
              ledger.noteBatch(entries.map(({ taskId, sample }) => ({ taskId, patch: { oom: sample } }))),
            now,
            ...(oomTimeoutMs === undefined ? {} : { timeoutMs: oomTimeoutMs }),
          };
  }

  /**
   * Before a spawn with a task id runs. Resolves once the id is on disk, and
   * throws when it cannot be — the spawn must then not run. The launch counts
   * as in flight, holding every `sessions` reply back (`settled`), until the
   * returned function is told how it went; one that never launched leaves the
   * ledger again, unless an earlier launch put it there or another launch of
   * the same id, in flight beside it, ran.
   */
  async launch(taskId: string): Promise<SettleLaunch> {
    // Before any await, and never parked for later: a launch held outside `#inFlight` reads as never-landed in
    // `sessions`, so one resumed after its reservation's TTL would start a twin of a task re-dispatched elsewhere.
    if (this.#closed) throw new LaunchesClosed();
    const over = Promise.withResolvers<void>();
    this.#inFlight.add(over.promise);
    const launches = this.#launches.get(taskId) ?? {
      open: 0,
      retractable: false,
      landed: false,
      crashed: false,
      confirmed: false,
    };
    this.#launches.set(taskId, launches);
    launches.open += 1;
    // Retracted before the launch stops counting as in flight, so no `sessions` reply sees it half-done.
    const finish = async (): Promise<void> => {
      try {
        launches.open -= 1;
        if (launches.open > 0) return;
        this.#launches.delete(taskId);
        if (launches.retractable && !launches.landed) await this.#ledger.retract(taskId);
        // A crash with no landed launch beside it may have left a window: interrupted, not ran-and-ended.
        // On disk before `over` resolves, so a drain that returns has left nothing pending.
        else if (launches.crashed && !launches.confirmed) await this.#ledger.markInterrupted(taskId);
        else await this.#ledger.clearPending(taskId);
      } finally {
        this.#inFlight.delete(over.promise);
        over.resolve();
      }
    };
    try {
      if (await this.#ledger.record(taskId)) launches.retractable = true;
    } catch (err) {
      // Nothing launched under this call; a retraction the others earned still happens.
      await finish();
      throw err;
    }
    return async (launched, landed, outcome) => {
      if (launched) launches.landed = true;
      if (outcome?.unknown === true) launches.crashed = true;
      if (launched && landed !== undefined) launches.confirmed = true;
      let sample = false;
      try {
        const site = landed?.site;
        if (launched && landed !== undefined) {
          await this.#ledger.startNote(
            taskId,
            site && {
              repo: site.repo,
              path: site.worktree,
              ...(site.session === undefined ? {} : { session: site.session }),
              ...(site.continuedPr === undefined ? {} : { continuedPr: site.continuedPr }),
            },
            launches.prUrl,
            landed?.server,
          );
          sample = true;
        }
      } finally {
        await finish();
      }
      // A baseline from the start, not the next pass: a session dying before that would have none. After
      // `finish`, and not awaited: its reads can stall, and neither the launch nor `sessions` waits on them.
      if (sample && this.#panes !== undefined && this.#oom !== undefined) {
        void sampleOomPanes(this.#panes, this.#oom);
      }
    };
  }

  /**
   * A spawn handler whose task launch was accepted: `drain` also waits for the returned release, which
   * the handler calls once its reply is handed to the transport. Apart from `#inFlight` on purpose: that
   * ends when the ledger write does, and `settled()` — what a `sessions` reply, and so the handler's own
   * `sessionsAfter`, waits on — must not wait for the reply it is part of. Idempotent.
   */
  hold(): () => void {
    const over = Promise.withResolvers<void>();
    this.#holds.add(over.promise);
    return () => {
      this.#holds.delete(over.promise);
      over.resolve();
    };
  }

  /**
   * Stops accepting task launches (`LaunchesClosed`) and resolves once those in flight are over and
   * their spawn handlers' replies are out (`hold`), or `timeoutMs` has passed. True when they finished,
   * false on the timeout. Idempotent. `final`: the daemon is exiting, so a later `reopen` (an update's
   * release) cannot undo this close.
   */
  async drain(timeoutMs: number, opts?: { readonly final?: boolean }): Promise<boolean> {
    this.#setClosed(true);
    if (opts?.final === true) this.#final = true;
    if (this.#inFlight.size + this.#holds.size > 0) {
      log.info(
        `holding task launches: waiting up to ${timeoutMs / 1000}s for ${this.#inFlight.size} launching, ${this.#holds.size} replying`,
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      const done = await Promise.race([this.#quiet().then(() => true as const), timeout]);
      if (!done) {
        log.warn(
          `task launches still in flight after ${timeoutMs / 1000}s: ${this.#inFlight.size} launching, ${this.#holds.size} replying`,
        );
      }
      return done;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Takes task launches again. Only launches that arrive later: a refused one was never parked. Not after a final drain. */
  reopen(): void {
    if (!this.#final) this.#setClosed(false);
  }

  /** True while task launches are refused (`LaunchesClosed`): what routing reads as draining. */
  get draining(): boolean {
    return this.#closed;
  }

  /**
   * `listener` hears each change of the gate, never a repeat. Returns its unsubscribe: the gate is per
   * process, and a config reload swaps the daemon that listens.
   */
  onGate(listener: (closed: boolean) => void): () => void {
    this.#gateListeners.add(listener);
    return () => {
      this.#gateListeners.delete(listener);
    };
  }

  #setClosed(closed: boolean): void {
    if (this.#closed === closed) return;
    this.#closed = closed;
    for (const listener of this.#gateListeners) {
      try {
        listener(closed);
      } catch (err) {
        log.warn(`launch gate listener failed: ${String(err)}`);
      }
    }
  }

  async #quiet(): Promise<void> {
    // oxlint-disable-next-line no-await-in-loop -- a launch or reply begun while waiting is waited for too
    while (this.#inFlight.size > 0 || this.#holds.size > 0) await Promise.all([...this.#inFlight, ...this.#holds]);
  }

  /**
   * A session's own `done` report (#21), kept for `progress` so a leader that
   * missed the event reads it on takeover. `refused`: the ledger holds no such
   * launch; `same`: already reported, so already forwarded.
   */
  noteReported(taskId: string): Promise<NoteOutcome> {
    return this.#ledger.apply(taskId, { reported: true });
  }

  /**
   * Whether a session of this task may hand its PR over: launched here, with a PR URL noted. Without
   * one its end would settle `done` or `failed`, never `awaiting-merge`. A continuation resumes the
   * conversation that opened the PR, so it may hand back the one its own note inherited at launch
   * (`continuedPr`, copied from the launch it continued, and only from one that ended handed off or by
   * itself, `continuation`), and a successor the one it inherited from the task it succeeds (the same
   * `continuedPr`, noted at launch from the scheduler-sealed spawn, `handlers.ts` `inheritedPr` handling, never
   * from a frame): only its own note, never another's by path or
   * session, which broke once the continued launch was evicted and would let a fresh task in a reused
   * worktree hand off a PR it never touched.
   */
  handoffCheck(taskId: string): "ok" | "unrecorded" | "prless" {
    if (!this.#ledger.ids().includes(taskId)) return "unrecorded";
    return this.prUrl(taskId) === undefined ? "prless" : "ok";
  }

  /**
   * Whether a session's own pass may push here, and from where: the task's worktree site, else why not.
   * `here`: launched in place, no branch of its own. `unrecorded`: no launch of it here, or one still in
   * flight, or a later task took over its worktree (the push is that task's).
   */
  passSite(
    taskId: string,
  ): { readonly site: { readonly repo: string; readonly path: string } } | { readonly code: "here" | "unrecorded" } {
    if (!this.launched(taskId)) return { code: "unrecorded" };
    const site = this.worktree(taskId);
    if (!("refused" in site)) return { site };
    const note = this.#ledger.notes().find((n) => n.taskId === taskId);
    return { code: note?.path === undefined || note.repo === undefined ? "here" : "unrecorded" };
  }

  /**
   * Whether the drain ask may type into this task's pane: a worktree launch this ledger holds (`passSite`),
   * not yet reported done (a pass would be refused `not_running`) and not being closed here (`closedHere`:
   * a close's own keys are going in).
   */
  askable(taskId: string): boolean {
    if (!("site" in this.passSite(taskId))) return false;
    const note = this.#ledger.notes().find((n) => n.taskId === taskId);
    return note?.reported !== true && note?.closedHere !== true;
  }

  /** Whether this launch noted a PR (`handoffCheck`'s lookup, a continuation's or successor's inherited one included), for a pass: a branch with no upstream then has to be the PR's. */
  hasPr(taskId: string): boolean {
    return this.prUrl(taskId) !== undefined;
  }

  /** The PR URL this launch noted, a continuation's or successor's inherited one included: the one lookup `handoffCheck`, `hasPr` and the custodian's `sessions` share. */
  prUrl(taskId: string): string | undefined {
    const note = this.#ledger.notes().find((n) => n.taskId === taskId);
    return this.#launches.get(taskId)?.prUrl ?? note?.prUrl ?? note?.continuedPr;
  }

  /**
   * The PR URL a session of this launch reported itself, for its `ended` event: the one event that carried
   * it may never have reached the leader. Never `continuedPr` (a continuation's or successor's inherited PR): as the
   * event's PR it would settle a continuation `awaiting-merge` on a PR it never touched.
   */
  notedPr(taskId: string): string | undefined {
    return this.#launches.get(taskId)?.prUrl ?? this.#ledger.notes().find((n) => n.taskId === taskId)?.prUrl;
  }

  /** The newest `https:` PR URL a session reported, kept for `progress` across restarts. */
  async notePr(taskId: string, prUrl: string): Promise<void> {
    const launches = this.#launches.get(taskId);
    if (launches !== undefined) launches.prUrl = prUrl;
    await this.#ledger.note(taskId, { prUrl });
  }

  /** `SessionsResponse.progress`: what the ledger holds of each launched task's PR, branch and exit. */
  progress(): readonly TaskProgress[] {
    return this.#ledger.progress();
  }

  /**
   * This daemon is about to close the task's pane (despawn, reap): noted first, so the pane going
   * missing never reads as `vanished`. Best-effort; a failed note only risks a false `vanished` on a
   * close the leader itself asked for, which settles the task `failed` it was already ending.
   * `cancelled`: the scheduler ends it by hand (cancel, mark done), noted too: its PR is no watch's.
   */
  async closing(taskId: string, cancelled = false): Promise<void> {
    try {
      await this.#ledger.note(taskId, cancelled ? { closedHere: true, cancelled: true } : { closedHere: true });
    } catch (err) {
      log.warn(`launch ledger: could not note that task ${taskId} is being closed (${String(err)})`);
    }
  }

  /**
   * This daemon is about to close the task's pane for its hand-off: `closing`, and noted as a hand-off too,
   * so a continuation of it is worded as a handed-off session. Reap and despawn keep `closing`.
   */
  async handingOff(taskId: string): Promise<void> {
    try {
      await this.#ledger.note(taskId, { closedHere: true, handedOff: true });
    } catch (err) {
      log.warn(`launch ledger: could not note that task ${taskId} is being handed off (${String(err)})`);
    }
  }

  /** Launches harvest may judge, minus any whose spawn is still in flight or registering. */
  unaccounted(): readonly { readonly taskId: string; readonly recordedAt: number; readonly server: number }[] {
    return this.#ledger.unaccounted().filter((launch) => !this.#launches.has(launch.taskId));
  }

  /** Notes `vanished` unless a launch is in flight or the ledger refuses it (`LaunchLedger.noteVanished`). */
  vanished(taskId: string, recordedAt: number): Promise<boolean> {
    if (this.#launches.has(taskId)) return Promise.resolve(false);
    return this.#ledger.noteVanished(taskId, recordedAt);
  }

  /** Each dead task pane's exit status into the ledger, then the pane closed (`exit-status.ts`). */
  async harvestExits(): Promise<void> {
    if (this.#panes === undefined) return;
    await harvestExits({
      ...this.#panes,
      note: async (taskId, exit, oomKill) => {
        const noted = await this.#ledger.note(taskId, { exit, ...(oomKill === undefined ? {} : { oomKill }) });
        await this.#ledger.clearInterrupted([taskId]);
        return noted;
      },
      closing: (taskId) => this.closing(taskId),
      launching: (taskId) => this.#launches.has(taskId),
      unaccounted: () => this.unaccounted(),
      vanished: (launch) => this.vanished(launch.taskId, launch.recordedAt),
      ...(this.#oom === undefined ? {} : { oom: this.#oom }),
    });
  }

  /** A live pane carries this task: no longer an interrupted launch. Best-effort, never rejects. */
  sessionSeen(taskId: string): Promise<void> {
    return this.#ledger.clearInterrupted([taskId]);
  }

  /** The one ledger of this file in this process, for the branch-state emitter. */
  get ledger(): LaunchLedger {
    return this.#ledger;
  }

  ended(taskId: string): void {
    this.#ended.delete(taskId); // re-insert, so insertion order stays age order
    this.#ended.set(taskId, this.#now());
    this.#prune();
  }

  /**
   * The ledger holds the task as launched here, and no launch of it is in
   * flight: a launch beside one in flight is a duplicate dispatch, which the
   * spawn's own `task_running` check answers once the first has tagged its pane.
   */
  launched(taskId: string): boolean {
    return !this.#launches.has(taskId) && this.#ledger.ids().includes(taskId);
  }

  /**
   * When the ledger recorded the task's launch, in flight or not (it is written before the worktree is made
   * and the window opened); undefined when it holds none. Messaging's grace for a session still starting.
   */
  launchedAt(taskId: string): number | undefined {
    return this.#ledger.recordedAt(taskId);
  }

  /**
   * Where a task's worktree is, from this ledger alone — the one authority on a worktree path
   * (a frame never names one). The newest note on a path owns it: a later launch there continued
   * the same conversation and its work sits in the worktree, so only it may be continued or
   * pushed for. `refused` says why there is none, in words a task's failure carries.
   */
  worktree(taskId: string): { readonly repo: string; readonly path: string } | { readonly refused: string } {
    if (this.#launches.has(taskId)) return { refused: "a launch of it is still in flight here" };
    if (!this.#ledger.ids().includes(taskId)) {
      return { refused: "this machine holds no launch of it (its launch ledger keeps a week, at most 128 launches)" };
    }
    const notes = this.#ledger.notes();
    const note = notes.find((n) => n.taskId === taskId);
    if (note?.path === undefined || note.repo === undefined) {
      return { refused: "no worktree of it was noted here (a here-mode run, or it never landed)" };
    }
    const owner = pathOwners(notes).get(note.path);
    if (owner !== undefined && owner.taskId !== taskId) {
      return {
        refused: `task ${owner.taskId} took over its worktree ${note.path} and its conversation after it; continue that task instead`,
      };
    }
    return { repo: note.repo, path: note.path };
  }

  /**
   * Where a continued task's session ran, and the Claude session id it chose for the launch
   * (DESIGN.md, Daemon, "Continuing a session"): `worktree`'s site plus the id; a frame names neither.
   */
  continuation(taskId: string):
    | {
        readonly repo: string;
        readonly path: string;
        readonly session: string;
        readonly exit?: number;
        readonly vanished?: true;
        readonly handedOff?: true;
        readonly continuedPr?: string;
        readonly branch?: string;
      }
    | { readonly refused: string } {
    const site = this.worktree(taskId);
    if ("refused" in site) return site;
    const note = this.#ledger.notes().find((n) => n.taskId === taskId);
    if (note === undefined)
      return { refused: "no worktree of it was noted here (a here-mode run, or it never landed)" };
    // No `--continue` fallback: it is what misses a worktree spawn's conversation.
    if (note.session === undefined) {
      return { refused: "it was launched before this daemon noted session ids; resume it by hand" };
    }
    // The PR this session had, for the continuation to inherit: its own report, else what it inherited. Every
    // ending that leaves the task awaiting-merge keeps it (a crash, a vanished window, a despawn: `ended()` in
    // scheduler/done.ts settles a task with a PR so however it ended), and the blocked continuation of it must
    // be able to hand off. Only the scheduler's own cancel or mark-done does not: that task is no awaiting-merge
    // one, its PR no scheduler watch's, so a continuation keeps watching the PR itself (`prless`).
    const handedOff = note.handedOff === true && (note.exit ?? 0) === 0;
    const pr = note.cancelled === true ? undefined : (note.prUrl ?? note.continuedPr);
    return {
      repo: site.repo,
      path: site.path,
      session: note.session,
      ...(note.exit === undefined ? {} : { exit: note.exit }),
      ...(note.vanished === true && note.exit === undefined ? { vanished: true as const } : {}),
      ...(handedOff ? { handedOff: true as const } : {}),
      ...(pr === undefined ? {} : { continuedPr: pr }),
      // Branch-state's last read of the live worktree: what a reaped worktree is re-added from.
      ...(note.branch === undefined ? {} : { branch: note.branch }),
    };
  }

  /**
   * Resolves once no launch is in flight. A reply listed mid-spawn would show
   * the task in neither `sessions` nor `ended` — the shape that proves a spawn
   * never landed — so the reply waits the few seconds a spawn takes instead.
   */
  async settled(): Promise<void> {
    // oxlint-disable-next-line no-await-in-loop -- a launch begun while waiting is waited for too
    while (this.#inFlight.size > 0) await Promise.all(this.#inFlight);
  }

  /**
   * `carried`: the task ids of the sessions the same reply lists. Every task
   * this daemon launched since `ledgerSince` is in exactly one of the two.
   * `interrupted` is the part of `ended` a past process died launching; one a
   * live session carries is accounted for, and its mark is cleared.
   */
  report(carried: ReadonlySet<string>): {
    readonly ended: readonly string[];
    readonly ledgerSince: number;
    readonly interrupted?: readonly string[];
  } {
    this.#prune();
    const out = new Set<string>();
    for (const id of [...this.#ended.keys(), ...this.#ledger.ids()]) if (!carried.has(id)) out.add(id);
    const marked = this.#ledger.interrupted();
    // Capped here too: `parseInterrupted` drops the whole list past `SESSIONS_MAX_PROGRESS`.
    const interrupted = marked.filter((id) => !carried.has(id)).slice(0, SESSIONS_MAX_PROGRESS);
    void this.#ledger.clearInterrupted(marked.filter((id) => carried.has(id)));
    return { ended: [...out], ledgerSince: this.#ledger.since(), ...(interrupted.length === 0 ? {} : { interrupted }) };
  }

  #prune(): void {
    const cutoff = this.#now() - ENDED_TTL_MS;
    for (const [id, at] of this.#ended) {
      if (at >= cutoff && this.#ended.size <= ENDED_MAX) break;
      this.#ended.delete(id);
    }
  }
}

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Whether peer binding works end to end on this runtime: a self-connect over a
 * throwaway unix socket must hand the accepted side an fd (`socketFd`, which
 * reads a field Bun leaves undocumented) and the kernel must name this process
 * on it. Null when it does; otherwise what failed. Where the host names peers
 * but this fails, every event is refused — the probe is what says why, at
 * start, instead of a stream of `unbound` replies after a Bun upgrade.
 */
export function peerBindingProblem(): Promise<string | null> {
  if (peerProbe !== undefined) return peerProbe;
  const probe = probePeerBinding();
  peerProbe = probe;
  // Only a success stands for the process, like `peerPidSupported`. The probe runs at start, when the box is
  // busiest, and a slow accept or a full tmpdir there must not withhold the `messages` capability until a restart
  // while binding itself works: a failure is probed again by the next reader.
  void probe.then((problem) => {
    if (problem !== null && peerProbe === probe) peerProbe = undefined;
  });
  return probe;
}

let peerProbe: Promise<string | null> | undefined;

async function probePeerBinding(): Promise<string | null> {
  if (!peerPidSupported()) return null;
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "seanced-peer-"));
    const accepted = Promise.withResolvers<number | null>();
    const server = Bun.listen<undefined>({
      unix: join(dir, "probe.sock"),
      socket: {
        open: (sock) => {
          const fd = socketFd(sock);
          accepted.resolve(fd < 0 ? null : peerPid(fd));
        },
        data: () => {},
      },
    });
    try {
      const client = await Bun.connect<undefined>({ unix: join(dir, "probe.sock"), socket: { data: () => {} } });
      const timer = setTimeout(() => accepted.resolve(-1), PROBE_TIMEOUT_MS);
      const pid = await accepted.promise;
      clearTimeout(timer);
      client.end();
      if (pid === -1) return "the probe connection was never accepted";
      if (pid === null) return "Bun gave the accepted socket no fd, or the kernel named no peer on it";
      return pid === process.pid ? null : `the kernel named pid ${pid} for this process's own connection`;
    } finally {
      server.stop(true);
    }
  } catch (err) {
    return `the probe socket failed: ${String(err)}`;
  } finally {
    // Never rejects: this promise is awaited by every register.
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** At most one event per session per this window (docs/scheduler.md, "Daemon → scheduler"). */
export const COALESCE_MS = 5_000;

/**
 * The mod's report of a PR can sit behind one in flight (its run times out at 3 s), so a hand-off made right
 * after `gh pr create` waits this long for it. Under `hand_off_task`'s own 5 s wait for the answer.
 */
export const HANDOFF_PR_WAIT_MS = 3_000;
const HANDOFF_PR_POLL_MS = 100;

export interface SessionEventDeps {
  readonly panes: () => Promise<readonly BoundPane[]>;
  readonly exclaves: () => readonly Exclave[];
  /** Sealed to the scheduler and sent; fire-and-forget, so nothing comes back. */
  readonly forward: (event: SessionEvent) => void;
  /**
   * Every bound event, task or not: a session in this exclave has spent quota.
   * The `/usage` refresh's poke, which runs nothing while the cache is fresh.
   */
  readonly onActivity?: (exclave: string) => void;
  /** A bound, tasked `ended` frame: messaging clears that pane's held messages and listener for the task. */
  readonly onEnded?: (pane: string, taskId: string) => void;
  readonly ended: EndedTasks;
  readonly now?: () => number;
  readonly coalesceMs?: number;
  /** Whether this host can name a peer at all; `peerPidSupported` unless a test stands in for another host. */
  readonly hostNamesPeers?: () => boolean;
  /**
   * Closes a pane whose session handed its task off, once its turn ends. Absent, a hand-off is
   * answered `unsupported`. Not awaited by the ingest; it audits under its own origin (`handoff.ts`).
   */
  readonly handOff?: (pane: string, taskId: string) => Promise<void>;
  /** How long a hand-off waits for a PR URL still on its way from the mod; `HANDOFF_PR_WAIT_MS` unless a test shortens it. */
  readonly handoffPrWaitMs?: number;
  /**
   * Every bound, tasked event's state, after its marks are handled; the drain ask times its keys by it. It sees
   * the pane's binding, never a frame field but the state. `reason` is the frame's kept reason (beside
   * needs-input only); `closing` is true when this very frame started a hand-off or pass close for the pane
   * (its mark was consumed here), so the drain drops its entry.
   */
  readonly onState?: (
    pane: string,
    taskId: string,
    state: SessionState,
    turnEnded: boolean,
    reason: NeedsInputReason | undefined,
    closing: boolean,
  ) => void;
  /** True while this machine is closed: a pass sent then carries `drain`. */
  readonly drainMark?: () => boolean;
  /**
   * Every bound frame's state, tasked or not, except `done` (a report sent mid-turn, not a state the session
   * rests in): retention for the custodian (`pane-activity.ts`), never an act. It sees the kernel-bound pane and
   * the state alone, and runs before any reply is chosen, so no reply depends on it.
   */
  readonly retain?: (pane: BoundPane, state: TrackedState, turnEnded: boolean) => void;
  /**
   * A session's own pass (`pass_to_successor`), all of it the host's: the push the pass asks for (audited under
   * its own origin), the report to the scheduler, and the close at a turn's end, which only
   * `armPassClose` lets run. Absent, a pass is answered `unsupported`.
   */
  readonly pass?: {
    readonly push: (taskId: string, options: { readonly hasPr: boolean }) => Promise<PushBranchResponse>;
    /** False when the report could not be handed on at all. */
    readonly send: (pass: SessionPass) => Promise<boolean>;
    readonly close: (pane: string, taskId: string) => Promise<void>;
  };
}

export interface SessionEvents {
  /**
   * `peer`: the kernel's pid for the connecting process, or null where the host cannot say. `caller` aborts when
   * the connection goes away before the reply: a pass whose caller is gone is never sent (an interrupted tool call).
   */
  readonly handle: (raw: unknown, peer: number | null, caller?: AbortSignal) => Promise<SessionEventReply>;
  /**
   * The leader's `pass-close`: its commit point for a session's pass is written, so the pane carrying
   * `taskId` may be closed at its turn's end. Answers at once and never waits for the close.
   */
  readonly armPassClose: (taskId: string) => Promise<PassCloseResponse>;
  /**
   * Whether the pane holds a hand-off or pass mark, or its close for one has started and not settled: the
   * mark is consumed before the despawn writes `closedHere`, so this covers that gap. The drain never types
   * into such a pane (one close per pane; two C-c exit Claude Code).
   */
  readonly marked: (pane: string) => boolean;
  readonly stop: () => void;
}

interface Outbox {
  lastSentAt: number;
  pending: SessionEvent | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createSessionEvents(deps: SessionEventDeps): SessionEvents {
  const now = deps.now ?? Date.now;
  const windowMs = deps.coalesceMs ?? COALESCE_MS;
  const outboxes = new Map<string, Outbox>();
  /** Pane → the task it handed off. Bound like a `done` report; acted on at that pane's next end of turn. */
  const handoffs = new Map<string, string>();
  /**
   * Pane → the task whose pass it asked for. `confirmed`: the leader's `pass-close` landed (its commit point is
   * written). `turnEnded`: the pane's turn ended since. The close runs when both hold, whichever lands second, so
   * a pass the leader refused never closes the session and a turn begun after an unconfirmed one is never cut.
   */
  const passes = new Map<string, { readonly taskId: string; confirmed: boolean; turnEnded: boolean }>();
  /** Panes whose hand-off or pass close was started and has not settled. */
  const closing = new Set<string>();
  const startClose = (pane: string, run: Promise<void> | undefined): void => {
    if (run === undefined) return;
    closing.add(pane);
    const settled = (): void => {
      closing.delete(pane);
    };
    run.then(settled, settled);
  };
  const prWaitMs = deps.handoffPrWaitMs ?? HANDOFF_PR_WAIT_MS;
  let stopped = false;
  const isStopped = (): boolean => stopped;

  const markHandoff = async (pane: BoundPane): Promise<SessionEventReply> => {
    const taskId = pane.taskId;
    if (taskId === null) return { ok: false, code: "untasked" };
    if (deps.handOff === undefined) return { ok: false, code: "unsupported" };
    if (stopped) return { ok: false, code: "stopping" };
    let check = deps.ended.handoffCheck(taskId);
    // The mod reports the PR from its own queue, so `gh pr create`'s URL may land just after the tool call.
    const deadline = now() + prWaitMs;
    while (check === "prless" && now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop -- polling the ledger for the report still in flight
      await Bun.sleep(HANDOFF_PR_POLL_MS);
      // `stop()` may run between polls.
      if (isStopped()) return { ok: false, code: "stopping" };
      check = deps.ended.handoffCheck(taskId);
    }
    if (check !== "ok") return { ok: false, code: check };
    // A pass is irreversible once the leader acts on it, so it outranks a hand-off: one close per pane, never two despawns.
    if (passes.get(pane.id)?.taskId === taskId) return { ok: false, code: "passed" };
    handoffs.set(pane.id, taskId);
    return { ok: true };
  };

  const markPass = async (
    pane: BoundPane,
    exclave: string,
    record: string,
    caller: AbortSignal | undefined,
  ): Promise<SessionEventReply> => {
    const taskId = pane.taskId;
    if (taskId === null) return { ok: false, code: "untasked" };
    const host = deps.pass;
    if (host === undefined) return { ok: false, code: "unsupported" };
    if (stopped) return { ok: false, code: "stopping" };
    // Fail closed: a caller that has gone (the person interrupted the tool call, or it timed out) is told
    // nothing and must leave no mark behind, which would close the session at some later turn's end.
    const callerGone = (): boolean => caller?.aborted === true;
    if (callerGone()) return { ok: false, code: "cancelled" };
    const site = deps.ended.passSite(taskId);
    if ("code" in site) return { ok: false, code: site.code };
    // No `expect`: the daemon holds no PR head, and the leader refuses a branch that is not the PR's.
    let pushed: PushBranchResponse;
    try {
      pushed = await host.push(taskId, { hasPr: deps.ended.hasPr(taskId) });
    } catch (err) {
      // An audit write or a repo read that threw: the push may have happened, but nothing was passed. Never the record or branch.
      log.error(`local socket: a session's pass could not push (${String(err)})`);
      return { ok: false, code: "push_failed" };
    }
    if (!pushed.ok) return { ok: false, code: passRefusal(pushed.code) };
    // The push may have outlasted `stop()` or the caller: nothing is sent then, and the pushed branch is said to be there.
    if (stopped) return { ok: false, code: "stopping_pushed" };
    if (callerGone()) return { ok: false, code: "cancelled" };
    const prior = passes.get(pane.id);
    // Before the report: the leader's `pass-close` may land as soon as it is sent.
    passes.set(pane.id, {
      taskId,
      confirmed: prior?.taskId === taskId && prior.confirmed,
      turnEnded: false,
    });
    // One close per pane: a hand-off mark left on it would send a second despawn at the same turn's end.
    if (handoffs.get(pane.id) === taskId) handoffs.delete(pane.id);
    const sent = await host
      .send({
        session: pane.id,
        taskId,
        exclave,
        remoteBranch: pushed.remoteBranch,
        tip: pushed.tip,
        record,
        at: now(),
        ...(deps.drainMark?.() === true ? { drain: true as const } : {}),
      })
      .catch((): boolean => false);
    if (!sent) {
      passes.delete(pane.id);
      return { ok: false, code: "unsent" };
    }
    const pass: PassAck = { taskId, remoteBranch: pushed.remoteBranch, tip: pushed.tip, pushed: pushed.pushed };
    return { ok: true, pass };
  };

  const armPassClose = async (taskId: string): Promise<PassCloseResponse> => {
    // Not `no_pane`, which tells the leader the session is gone and lets it close at once: a stopping daemon arms nothing.
    if (stopped) return { ok: false, code: "unsupported", message: "this daemon is stopping" };
    const pane = (await deps.panes()).find((p) => !p.dead && p.taskId === taskId);
    if (pane === undefined) return { ok: false, code: "no_pane", message: "no live pane carries the task" };
    // After a restart the entry is gone: the pane carrying the task is the proof, and it has seen no turn end.
    const entry = passes.get(pane.id);
    if (entry === undefined || entry.taskId !== taskId) {
      passes.set(pane.id, { taskId, confirmed: true, turnEnded: false });
      return { ok: true };
    }
    entry.confirmed = true;
    if (entry.turnEnded) {
      passes.delete(pane.id);
      startClose(pane.id, deps.pass?.close(pane.id, taskId));
    }
    return { ok: true };
  };

  const send = (box: Outbox, event: SessionEvent): void => {
    box.lastSentAt = now();
    box.pending = null;
    deps.forward(event);
    if (event.state === "ended") outboxes.delete(event.session);
  };

  // The newest state wins a window; a PR URL or remote session seen earlier in it is carried, not lost.
  const enqueue = (event: SessionEvent): void => {
    for (const [id, box] of outboxes) {
      if (box.timer === null && now() - box.lastSentAt > 10 * windowMs) outboxes.delete(id);
    }
    const box = outboxes.get(event.session) ?? { lastSentAt: -Infinity, pending: null, timer: null };
    outboxes.set(event.session, box);
    const prUrl = event.prUrl ?? box.pending?.prUrl;
    const remoteSession = event.remoteSession ?? box.pending?.remoteSession;
    const merged: SessionEvent = {
      ...event,
      ...(prUrl === undefined ? {} : { prUrl }),
      ...(remoteSession === undefined ? {} : { remoteSession }),
    };
    // A report is acted on once and not repeated, so no later state in the window may replace it.
    if (event.state === "done") {
      deps.forward(merged);
      return;
    }
    const wait = box.lastSentAt + windowMs - now();
    if (wait <= 0 && box.timer === null) {
      send(box, merged);
      return;
    }
    box.pending = merged;
    box.timer ??= setTimeout(
      () => {
        box.timer = null;
        if (!stopped && box.pending !== null) send(box, box.pending);
      },
      Math.max(0, wait),
    );
  };

  const hostNamesPeers = deps.hostNamesPeers ?? peerPidSupported;

  const bind = async (frame: SessionEventFrame, peer: number | null): Promise<BoundPane | null> => {
    // Per host, never per connection: a sender the kernel could not name here is refused.
    if (peer === null && hostNamesPeers()) return null;
    const live = (await deps.panes()).filter((pane) => !pane.dead);
    if (peer === null) return live.find((pane) => pane.id === frame.pane) ?? null;
    return ancestorIn(peer, new Map(live.map((pane) => [pane.pid, pane])));
  };

  return {
    handle: async (raw, peer, caller): Promise<SessionEventReply> => {
      const frame = parseSessionEventFrame(raw);
      if (frame === null) {
        log.warn("local socket: dropped a malformed session-event frame");
        return { ok: false, code: "invalid" };
      }
      const pane = await bind(frame, peer);
      if (pane === null) {
        // Info: a claude run outside tmux, or a background session, is ordinary.
        log.info(`local socket: session-event from pid=${peer ?? "unknown"} matched no live pane — dropped`);
        return { ok: false, code: "unbound" };
      }
      const at = now();
      const exclave = exclaveOf(pane.path, deps.exclaves());
      if (!stopped) deps.onActivity?.(exclave);
      if (frame.handoff === true) return markHandoff(pane);
      if (frame.pass === true && frame.record !== undefined) return markPass(pane, exclave, frame.record, caller);
      // Before the untasked return: an untasked pane's state is retained too, and goes nowhere else.
      if (!stopped && frame.state !== undefined && frame.state !== "done") {
        deps.retain?.(pane, frame.state, frame.state === "idle" && frame.turnEnded === true);
      }
      if (frame.state === "done" && pane.taskId === null) return { ok: false, code: "untasked" };
      if (frame.state === undefined || pane.taskId === null) return { ok: true };
      // A stopped ingest sends nothing, so a report must not be told it went.
      if (stopped) return frame.state === "done" ? { ok: false, code: "stopping" } : { ok: true };
      // Ingest, not a new act: the id is the kernel-bound pane's own, never the frame's. Only `ended` and `done`
      // prove the session ran and may leave no exit note (a clean exit closes the window); a live one is cleared
      // by the `sessions` listing once it registers, which a bare `running` frame does not show.
      if (frame.state === "ended" || frame.state === "done") void deps.ended.sessionSeen(pane.taskId);
      if (frame.state === "ended") {
        deps.ended.ended(pane.taskId);
        deps.onEnded?.(pane.id, pane.taskId);
      }
      // Before the reply, so `ok` tells the session its report is on disk — or says it is not.
      let reported: NoteOutcome | null = null;
      if (frame.state === "done") {
        reported = await deps.ended.noteReported(pane.taskId).catch((): NoteOutcome => "unwritten");
        // No launch of this task here: nothing this machine could settle, and nothing to recover it from.
        if (reported === "refused") return { ok: false, code: "unrecorded" };
      }
      const prUrl = frame.prUrl === undefined ? null : httpsUrl(frame.prUrl);
      if (frame.prUrl !== undefined && prUrl === null) {
        log.warn(`local socket: session-event pane=${quote(pane.id)} carried a PR URL that is not https — dropped it`);
      }
      if (prUrl !== null) void deps.ended.notePr(pane.taskId, prUrl);
      // An `ended` the leader cannot match to a PR waits for the exit, and settles `done` if the machine goes
      // first: so it carries the PR this pane's own launch noted, in case the event that carried it was lost.
      const sentPr = prUrl ?? (frame.state === "ended" ? (deps.ended.notedPr(pane.taskId) ?? null) : null);
      const remoteSession = isRemoteSessionId(frame.remoteSession) ? frame.remoteSession : null;
      if (frame.remoteSession !== undefined && remoteSession === null) {
        log.warn(
          `local socket: session-event pane=${quote(pane.id)} carried a malformed remote session id — dropped it`,
        );
      }
      // The ledger already held a report: it was forwarded then, and a repeat only re-sends what a lost frame is recovered by on the next sweep.
      if (reported !== "same") {
        enqueue({
          session: pane.id,
          taskId: pane.taskId,
          exclave,
          state: frame.state,
          at,
          ...(sentPr === null ? {} : { prUrl: sentPr }),
          ...(remoteSession === null ? {} : { remoteSession }),
          ...(frame.reason === undefined ? {} : { reason: frame.reason }),
          ...(frame.tool === undefined ? {} : { tool: frame.tool }),
        });
      }
      // After the enqueue, so the idle is in the outbox before the close; a coalesced one may still give way to
      // the `ended`, which carries the PR as well. Only the task the pane handed off: a pane id tmux reused for
      // another task's window carries a different one. Only an idle the turn's own end raised: one from a
      // hooks-worker respawn mid-turn would close the session before its final message.
      const handedOff = handoffs.get(pane.id);
      const turnEnd = frame.state === "idle" && frame.turnEnded === true;
      let closingNow = false;
      if (handedOff !== undefined && (frame.state === "ended" || turnEnd || handedOff !== pane.taskId)) {
        handoffs.delete(pane.id);
        if (turnEnd && handedOff === pane.taskId) {
          closingNow = true;
          startClose(pane.id, deps.handOff?.(pane.id, handedOff));
        }
      }
      const passed = passes.get(pane.id);
      if (passed !== undefined) {
        if (frame.state === "ended" || passed.taskId !== pane.taskId) {
          passes.delete(pane.id);
        } else if (turnEnd) {
          if (!passed.confirmed) passed.turnEnded = true;
          else {
            passes.delete(pane.id);
            closingNow = true;
            startClose(pane.id, deps.pass?.close(pane.id, passed.taskId));
          }
        } else if (frame.state === "busy" || frame.state === "needs-input") {
          passed.turnEnded = false;
        }
      }
      deps.onState?.(
        pane.id,
        pane.taskId,
        frame.state,
        turnEnd,
        frame.state === "needs-input" ? frame.reason : undefined,
        closingNow,
      );
      // Forwarded either way: only the proof that survives a restart is missing.
      return reported === "unwritten" ? { ok: false, code: "unwritten" } : { ok: true };
    },
    armPassClose,
    marked: (pane): boolean => handoffs.has(pane) || passes.has(pane) || closing.has(pane),
    stop: (): void => {
      stopped = true;
      handoffs.clear();
      passes.clear();
      closing.clear();
      for (const box of outboxes.values()) if (box.timer !== null) clearTimeout(box.timer);
      outboxes.clear();
    },
  };
}

/** A `push-branch` refusal as the code a session is told: only the ones a pass can meet keep their own. */
function passRefusal(
  code: string,
):
  | "unrecorded"
  | "dirty_worktree"
  | "detached_head"
  | "default_branch"
  | "no_upstream"
  | "push_rejected"
  | "push_failed" {
  switch (code) {
    case "not_launched":
      return "unrecorded";
    case "dirty_worktree":
    case "detached_head":
    case "default_branch":
    case "no_upstream":
    case "push_rejected":
      return code;
    default:
      return "push_failed";
  }
}
