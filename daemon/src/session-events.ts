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
import { exclaveOf, type Exclave } from "./exclaves.ts";
import { log } from "./log.ts";
import { ancestorIn } from "./peer.ts";
import { FIELD_SEP, TASK_FIELD, tmux } from "./tmux.ts";

/**
 * The `session-event` frame kind on the local op socket (DESIGN.md, "Session
 * events"): what the `claude-mods/session-events` mod reports about the session
 * it runs in, through `seanced session-event`. Ingest-only — the handler stores
 * and forwards; nothing here spawns, despawns or runs a command shaped by the
 * frame. Its only subprocesses are fixed-argv reads: `tmux list-panes` and, on
 * macOS, `ps` for the parent walk.
 *
 * Every field of a frame is untrusted. The run directory admits any process of
 * this user, and every session is this user, so a frame could name any pane or
 * task. None is taken from it: the pane is the one the kernel-reported peer
 * pid runs under, and the task and exclave come from that pane. Only where the
 * host cannot name a peer (`peer.ts`) does the frame's own `pane` decide, and
 * that is the residual the threat model records.
 *
 * Like a broker frame, never a `Plain` and never an `OpName`: no `op`, no `id`,
 * no `ts`, so it cannot arrive from the relay, no op rides in as one, and a
 * daemon that predates the kind drops it as malformed.
 */

export const SESSION_EVENT_VERSION = 1;

export const SESSION_EVENT_KIND = "session-event";

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
  /** `$TMUX_PANE` as the session saw it — consulted only where no peer pid is to be had. */
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
 * Newest session-reported quota per exclave id, kept in memory: the telemetry
 * tick folds it beside the config dir's cache (`telemetry.ts`). Lost on a
 * restart, which costs only freshness — the cache and the metrics history stay.
 */
export class SessionQuota {
  readonly #byExclave = new Map<string, Omit<QuotaObservation, "x">>();

  record(exclave: string, observation: Omit<QuotaObservation, "x">): void {
    const current = this.#byExclave.get(exclave);
    if (current === undefined || observation.at >= current.at) this.#byExclave.set(exclave, observation);
  }

  get(exclave: string): Omit<QuotaObservation, "x"> | undefined {
    return this.#byExclave.get(exclave);
  }
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
 * At least the reservation TTL (120s, `scheduler/src/config.ts`) with room for
 * a check that waited out an unreachable machine. The cap bounds memory however
 * fast tasks churn, and keeps the reply's `ended` far inside one envelope —
 * sixteen times the scheduler's global in-flight max.
 */
export const ENDED_TTL_MS = 30 * 60_000;
export const ENDED_MAX = 128;

/**
 * Task ids whose sessions ended here recently — the `sessions` reply's `ended`,
 * the backstop for a scheduler that lost both a spawn's reply and the session's
 * `ended` event (docs/scheduler.md, M2 item 5). Two inputs: an `ended` event,
 * and every task this daemon launched, which counts as ended once no live pane
 * carries it — so a lost event, a session the mod never saw, or a crash that
 * fired no SessionEnd all still read as ran-and-ended. In memory only: a daemon
 * restart within the window forgets both.
 */
export class EndedTasks {
  readonly #ended = new Map<string, number>();
  readonly #launched = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  launched(taskId: string): void {
    this.#put(this.#launched, taskId);
  }

  ended(taskId: string): void {
    this.#put(this.#ended, taskId);
  }

  /** Nothing remembered once what has aged out is dropped — then a `sessions` reply need not list panes. */
  isEmpty(): boolean {
    this.#prune(this.#ended);
    this.#prune(this.#launched);
    return this.#ended.size === 0 && this.#launched.size === 0;
  }

  /** `live`: task ids some live pane carries now — a live session is running, never ended. */
  report(live: ReadonlySet<string>): readonly string[] {
    this.#prune(this.#ended);
    this.#prune(this.#launched);
    const out = new Set<string>();
    for (const id of [...this.#ended.keys(), ...this.#launched.keys()]) if (!live.has(id)) out.add(id);
    return [...out];
  }

  #put(map: Map<string, number>, taskId: string): void {
    map.delete(taskId); // re-insert, so insertion order stays age order
    map.set(taskId, this.#now());
    this.#prune(map);
  }

  #prune(map: Map<string, number>): void {
    const cutoff = this.#now() - ENDED_TTL_MS;
    for (const [id, at] of map) {
      if (at >= cutoff && map.size <= ENDED_MAX) break;
      map.delete(id);
    }
  }
}

/** `EndedTasks.report` against the panes alive now — every pane, registered or not, as `task_running` counts them. */
export async function reportEnded(
  ended: EndedTasks,
  panes: () => Promise<readonly BoundPane[]> = listPanePids,
): Promise<readonly string[]> {
  if (ended.isEmpty()) return [];
  const live = new Set<string>();
  for (const pane of await panes()) if (!pane.dead && pane.taskId !== null) live.add(pane.taskId);
  return ended.report(live);
}

/** At most one event per session per this window (docs/scheduler.md, "Daemon → scheduler"). */
export const COALESCE_MS = 5_000;

export interface SessionEventDeps {
  readonly panes: () => Promise<readonly BoundPane[]>;
  readonly exclaves: () => readonly Exclave[];
  /** Sealed to the scheduler and sent; fire-and-forget, so nothing comes back. */
  readonly forward: (event: SessionEvent) => void;
  readonly quota: SessionQuota;
  readonly ended: EndedTasks;
  readonly now?: () => number;
  readonly coalesceMs?: number;
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

  const bind = async (frame: SessionEventFrame, peer: number | null): Promise<BoundPane | null> => {
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
        if (observation !== null) deps.quota.record(exclave, observation);
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
