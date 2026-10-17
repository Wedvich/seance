import {
  httpsUrl,
  isRecord,
  isSessionState,
  isTaskId,
  quote,
  type QuotaObservation,
  type SessionEvent,
  type SessionState,
} from "@seance/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exclaveOf, type Exclave } from "./exclaves.ts";
import { LaunchLedger } from "./launch-ledger.ts";
import { log } from "./log.ts";
import type { SessionQuota } from "./session-quota.ts";
import { ancestorIn, peerPid, peerPidSupported, socketFd } from "./peer.ts";
import { SESSION_EVENT_KIND, SESSION_EVENT_VERSION } from "./session-event-frame.ts";
import { FIELD_SEP, TASK_FIELD, tmux } from "./tmux.ts";

/**
 * The `session-event` frame kind on the local op socket (DESIGN.md, "Session
 * events"): what the `claude-mods/session-events` mod reports about the session
 * it runs in, through `seanced session-event`. Ingest-only — the handler stores
 * and forwards; nothing here spawns, despawns or runs a command shaped by the
 * frame. Its only subprocesses are fixed-argv reads: `tmux list-panes` and, on
 * macOS where `proc_pidinfo` will not answer a hop, `ps` for the parent walk.
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

/** One rate-limit window as Claude Code reports it (`session.measure`'s `rateLimits`). */
export interface RateLimitReport {
  readonly kind: string;
  readonly percentUsed: number;
  readonly resetsAt?: string;
}

export interface SessionEventFrame {
  readonly v: typeof SESSION_EVENT_VERSION;
  readonly kind: typeof SESSION_EVENT_KIND;
  readonly state?: SessionState;
  readonly prUrl?: string;
  readonly rateLimits?: readonly RateLimitReport[];
  /** `$TMUX_PANE` as the session saw it — consulted only on a host that can name no peer at all. */
  readonly pane?: string;
}

export const SESSION_EVENT_REPLY_CODES = [
  /** Not a frame this daemon reads: wrong version, mistyped fields, nothing to report. */
  "invalid",
  /** The sender runs in no live tmux pane this daemon can see. */
  "unbound",
  /** This daemon runs no session-event ingest. */
  "unsupported",
] as const;

export type SessionEventReply =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: (typeof SESSION_EVENT_REPLY_CODES)[number] };

/** Routed on `kind` ahead of the `Plain` check, as broker frames are. */
export function isSessionEventFrameKind(raw: unknown): boolean {
  return isRecord(raw) && raw["kind"] === SESSION_EVENT_KIND;
}

const MAX_RATE_LIMITS = 8;
const MAX_FIELD = 64;

export function parseSessionEventFrame(raw: unknown): SessionEventFrame | null {
  if (!isRecord(raw) || raw["v"] !== SESSION_EVENT_VERSION || raw["kind"] !== SESSION_EVENT_KIND) return null;
  const { state, prUrl, rateLimits, pane } = raw;
  if (state !== undefined && !isSessionState(state)) return null;
  if (prUrl !== undefined && typeof prUrl !== "string") return null;
  if (pane !== undefined && (typeof pane !== "string" || pane.length > MAX_FIELD)) return null;
  let limits: RateLimitReport[] | undefined;
  if (rateLimits !== undefined) {
    if (!Array.isArray(rateLimits) || rateLimits.length > MAX_RATE_LIMITS) return null;
    limits = [];
    for (const item of rateLimits) {
      if (!isRecord(item)) return null;
      const { kind, percentUsed, resetsAt } = item;
      if (typeof kind !== "string" || kind.length > MAX_FIELD) return null;
      if (typeof percentUsed !== "number" || !Number.isFinite(percentUsed)) return null;
      if (resetsAt !== undefined && (typeof resetsAt !== "string" || resetsAt.length > MAX_FIELD)) return null;
      limits.push({ kind, percentUsed, ...(resetsAt === undefined ? {} : { resetsAt }) });
    }
  }
  if (state === undefined && limits === undefined) return null;
  return {
    v: SESSION_EVENT_VERSION,
    kind: SESSION_EVENT_KIND,
    ...(state === undefined ? {} : { state }),
    ...(prUrl === undefined ? {} : { prUrl }),
    ...(limits === undefined ? {} : { rateLimits: limits }),
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
 * `rateLimits` as a `session` observation. Stamped with the daemon's receive
 * time — the report rides the turn it came from — never a time the frame names.
 * Unknown kinds (a gateway's `spend_limit`) are not quota windows and are skipped.
 */
export function quotaFromRateLimits(
  limits: readonly RateLimitReport[],
  nowMs: number,
): Omit<QuotaObservation, "x"> | null {
  const window = (kind: string): { readonly p: number; readonly r?: number } | null => {
    const limit = limits.find((l) => l.kind === kind);
    if (limit === undefined) return null;
    const p = Math.min(100, Math.max(0, Math.round(limit.percentUsed)));
    const resetsMs = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt);
    return Number.isFinite(resetsMs) && resetsMs >= 0 ? { p, r: Math.floor(resetsMs / 1000) } : { p };
  };
  const five = window("five_hour");
  const seven = window("seven_day");
  if (five === null && seven === null) return null;
  return {
    s: "session",
    at: Math.floor(nowMs / 1000),
    ...(five === null ? {} : { h: five.p }),
    ...(seven === null ? {} : { d: seven.p }),
    ...(five?.r === undefined ? {} : { hr: five.r }),
    ...(seven?.r === undefined ? {} : { dr: seven.r }),
  };
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

/** What `EndedTasks.launch` hands back: told whether the spawn launched, and only then is the launch over. */
export type SettleLaunch = (launched: boolean) => Promise<void>;

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
}

export class EndedTasks {
  readonly #ended = new Map<string, number>();
  readonly #ledger: LaunchLedger;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #launches = new Map<string, Launches>();
  readonly #now: () => number;

  constructor(ledger: LaunchLedger = LaunchLedger.memory(), now: () => number = Date.now) {
    this.#ledger = ledger;
    this.#now = now;
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
    return async (launched) => {
      if (launched) launches.landed = true;
      await finish();
    };
  }

  ended(taskId: string): void {
    this.#ended.delete(taskId); // re-insert, so insertion order stays age order
    this.#ended.set(taskId, this.#now());
    this.#prune();
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
  /** The account an exclave is signed into, as the last scan read it; a quota reading is kept under it. */
  readonly accountOf: (exclave: string) => string | null;
  /** Sealed to the scheduler and sent; fire-and-forget, so nothing comes back. */
  readonly forward: (event: SessionEvent) => void;
  readonly quota: SessionQuota;
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

  // The newest state wins a window; a PR URL seen earlier in it is carried, not lost.
  const enqueue = (event: SessionEvent): void => {
    for (const [id, box] of outboxes) {
      if (box.timer === null && now() - box.lastSentAt > 10 * windowMs) outboxes.delete(id);
    }
    const box = outboxes.get(event.session) ?? { lastSentAt: -Infinity, pending: null, timer: null };
    outboxes.set(event.session, box);
    const prUrl = event.prUrl ?? box.pending?.prUrl;
    const merged: SessionEvent = { ...event, ...(prUrl === undefined ? {} : { prUrl }) };
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
      if (frame.rateLimits !== undefined) {
        const observation = quotaFromRateLimits(frame.rateLimits, at);
        if (observation !== null) deps.quota.record(exclave, deps.accountOf(exclave), observation);
      }
      if (frame.state === undefined || pane.taskId === null || stopped) return { ok: true };
      if (frame.state === "ended") deps.ended.ended(pane.taskId);
      const prUrl = frame.prUrl === undefined ? null : httpsUrl(frame.prUrl);
      if (frame.prUrl !== undefined && prUrl === null) {
        log.warn(`local socket: session-event pane=${quote(pane.id)} carried a PR URL that is not https — dropped it`);
      }
      enqueue({
        session: pane.id,
        taskId: pane.taskId,
        exclave,
        state: frame.state,
        at,
        ...(prUrl === null ? {} : { prUrl }),
      });
      return { ok: true };
    },
    stop: (): void => {
      stopped = true;
      for (const box of outboxes.values()) if (box.timer !== null) clearTimeout(box.timer);
      outboxes.clear();
    },
  };
}
