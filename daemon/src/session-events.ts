import {
  httpsUrl,
  isRecord,
  isRemoteSessionId,
  isSessionState,
  isTaskId,
  quote,
  type SessionEvent,
  type SessionState,
  type TaskProgress,
} from "@seance/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exclaveOf, type Exclave } from "./exclaves.ts";
import { harvestExits, type HarvestPanes } from "./exit-status.ts";
import { LaunchLedger, type LaunchSite, type NoteOutcome } from "./launch-ledger.ts";
import { log } from "./log.ts";
import { ancestorIn, peerPid, peerPidSupported, socketFd } from "./peer.ts";
import { SESSION_EVENT_KIND, SESSION_EVENT_VERSION, type SessionEventReply } from "./session-event-frame.ts";
import { FIELD_SEP, TASK_FIELD, tmux } from "./tmux.ts";

/**
 * The `session-event` frame kind on the local op socket (DESIGN.md, "Session
 * events"): what the `claude-mods/session-events` mod reports about the session
 * it runs in, through `seanced session-event`. Ingest-only — the handler stores
 * and forwards, and tells the bound pane's exclave it saw activity (the `/usage`
 * refresh's trigger, which decides alone whether anything runs); nothing here
 * spawns, despawns or runs a command shaped by the frame. Its own only
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
 */
export function parseSessionEventFrame(raw: unknown): SessionEventFrame | null {
  if (!isRecord(raw) || raw["v"] !== SESSION_EVENT_VERSION || raw["kind"] !== SESSION_EVENT_KIND) return null;
  const { state, prUrl, remoteSession, rateLimits, pane } = raw;
  if (state !== undefined && !isSessionState(state)) return null;
  if (prUrl !== undefined && typeof prUrl !== "string") return null;
  if (remoteSession !== undefined && typeof remoteSession !== "string") return null;
  if (pane !== undefined && (typeof pane !== "string" || pane.length > MAX_FIELD)) return null;
  if (state === undefined && rateLimits === undefined) return null;
  return {
    v: SESSION_EVENT_VERSION,
    kind: SESSION_EVENT_KIND,
    ...(state === undefined ? {} : { state }),
    ...(prUrl === undefined ? {} : { prUrl }),
    ...(remoteSession === undefined ? {} : { remoteSession }),
    ...(pane === undefined ? {} : { pane }),
  };
}

/** A pane as the binding needs it: its process, liveness, task and where it sits. */
export interface BoundPane {
  readonly id: string;
  readonly pid: number;
  readonly dead: boolean;
  readonly taskId: string | null;
  readonly path: string;
}

const PANE_PID_FORMAT = ["#{pane_id}", "#{pane_pid}", "#{pane_dead}", TASK_FIELD, "#{pane_current_path}"].join(
  FIELD_SEP,
);

/** Pure parser over `list-panes -a` in `PANE_PID_FORMAT`; path last, taken as the remainder. */
export function parsePanePids(raw: string): readonly BoundPane[] {
  const seen = new Set<string>();
  const panes: BoundPane[] = [];
  for (const line of raw.split("\n")) {
    const [id, pid, dead, task, ...rest] = line.split(FIELD_SEP);
    if (id === undefined || pid === undefined || dead === undefined || task === undefined || rest.length === 0)
      continue;
    // Grouped sessions repeat every pane.
    if (seen.has(id) || !/^%\d+$/u.test(id)) continue;
    seen.add(id);
    panes.push({
      id,
      pid: Number(pid),
      dead: dead === "1",
      taskId: isTaskId(task) ? task : null,
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
export type SettleLaunch = (launched: boolean, landed?: { readonly site?: LaunchSite }) => Promise<void>;

/**
 * The `sessions` reply's `ended` and `ledgerSince` — the backstop for a
 * scheduler that lost both a spawn's reply and the session's `ended` event, and
 * the proof that lets it re-dispatch one that never landed (DESIGN.md,
 * "Session events"). Two inputs: every task this daemon launches, recorded in
 * the durable `LaunchLedger` before the spawn runs, and `ended` events, kept in
 * memory. A task in either that no session in the reply carries is listed — so
 * a lost event, a session the mod never saw, a crash that fired no SessionEnd,
 * and a pane stuck before it registered all read as ran-and-ended, never as
 * never-started.
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
  /** Newest PR URL a session reported while one of them was in flight: the landed launch's note keeps it. */
  prUrl?: string;
}

export class EndedTasks {
  readonly #ended = new Map<string, number>();
  readonly #ledger: LaunchLedger;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #launches = new Map<string, Launches>();
  readonly #now: () => number;
  readonly #panes: HarvestPanes | undefined;

  /** `panes` is the tmux side of `harvestExits`; without it harvest does nothing. */
  constructor(ledger: LaunchLedger = LaunchLedger.memory(), now: () => number = Date.now, panes?: HarvestPanes) {
    this.#ledger = ledger;
    this.#now = now;
    this.#panes = panes;
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
    const over = Promise.withResolvers<void>();
    this.#inFlight.add(over.promise);
    const launches = this.#launches.get(taskId) ?? { open: 0, retractable: false, landed: false };
    this.#launches.set(taskId, launches);
    launches.open += 1;
    // Retracted before the launch stops counting as in flight, so no `sessions` reply sees it half-done.
    const finish = async (): Promise<void> => {
      try {
        launches.open -= 1;
        if (launches.open > 0) return;
        this.#launches.delete(taskId);
        if (launches.retractable && !launches.landed) await this.#ledger.retract(taskId);
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
    return async (launched, landed) => {
      if (launched) launches.landed = true;
      try {
        const site = landed?.site;
        if (launched && landed !== undefined) {
          await this.#ledger.startNote(taskId, site && { repo: site.repo, path: site.worktree }, launches.prUrl);
        }
      } finally {
        await finish();
      }
    };
  }

  /**
   * A session's own `done` report (#21), kept for `progress` so a leader that
   * missed the event reads it on takeover. `refused`: the ledger holds no such
   * launch; `same`: already reported, so already forwarded.
   */
  noteReported(taskId: string): Promise<NoteOutcome> {
    return this.#ledger.apply(taskId, { reported: true });
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

  /** Each dead task pane's exit status into the ledger, then the pane closed (`exit-status.ts`). */
  async harvestExits(): Promise<void> {
    if (this.#panes === undefined) return;
    await harvestExits({ ...this.#panes, note: (taskId, exit) => this.#ledger.note(taskId, { exit }) });
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
   */
  report(carried: ReadonlySet<string>): { readonly ended: readonly string[]; readonly ledgerSince: number } {
    this.#prune();
    const out = new Set<string>();
    for (const id of [...this.#ended.keys(), ...this.#ledger.ids()]) if (!carried.has(id)) out.add(id);
    return { ended: [...out], ledgerSince: this.#ledger.since() };
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
export async function peerBindingProblem(): Promise<string | null> {
  if (!peerPidSupported()) return null;
  const dir = await mkdtemp(join(tmpdir(), "seanced-peer-"));
  const accepted = Promise.withResolvers<number | null>();
  try {
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
    await rm(dir, { recursive: true, force: true });
  }
}

/** At most one event per session per this window (docs/scheduler.md, "Daemon → scheduler"). */
export const COALESCE_MS = 5_000;

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
  readonly ended: EndedTasks;
  readonly now?: () => number;
  readonly coalesceMs?: number;
  /** Whether this host can name a peer at all; `peerPidSupported` unless a test stands in for another host. */
  readonly hostNamesPeers?: () => boolean;
}

export interface SessionEvents {
  /** `peer`: the kernel's pid for the connecting process, or null where the host cannot say. */
  readonly handle: (raw: unknown, peer: number | null) => Promise<SessionEventReply>;
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
  let stopped = false;

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
    handle: async (raw, peer): Promise<SessionEventReply> => {
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
      if (frame.state === "done" && pane.taskId === null) return { ok: false, code: "untasked" };
      if (frame.state === undefined || pane.taskId === null) return { ok: true };
      // A stopped ingest sends nothing, so a report must not be told it went.
      if (stopped) return frame.state === "done" ? { ok: false, code: "stopping" } : { ok: true };
      if (frame.state === "ended") deps.ended.ended(pane.taskId);
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
          ...(prUrl === null ? {} : { prUrl }),
          ...(remoteSession === null ? {} : { remoteSession }),
        });
      }
      // Forwarded either way: only the proof that survives a restart is missing.
      return reported === "unwritten" ? { ok: false, code: "unwritten" } : { ok: true };
    },
    stop: (): void => {
      stopped = true;
      for (const box of outboxes.values()) if (box.timer !== null) clearTimeout(box.timer);
      outboxes.clear();
    },
  };
}
