import {
  StoreRevoked,
  UNDELIVERED,
  UNREACHABLE,
  type Fleet,
  type NoAnswer,
  type QueueStore,
  type StoreWrite,
  type TaskSessionsReply,
  type Undelivered,
  type Unreachable,
} from "@seance/scheduler";
import {
  OP_TIMEOUT_MS,
  parseInterrupted,
  parseTaskProgressList,
  quote,
  RequestFailure,
  type DespawnResponse,
  type ErrorResponse,
  type FailureReason,
  type SessionsResponse,
  type SpawnResponse,
} from "@seance/shared";
import type { AppRelay } from "./app-relay.ts";
import type { LocalOps } from "./handlers.ts";

/**
 * The scheduler term's two adapters onto the library's ports (`leader.ts` runs
 * the term): the fence the term's store writes through — over the relay store
 * of `queue-store.ts` — and the `Fleet` over its leg.
 */

function unreachable(message: string): Unreachable {
  return { ok: false, code: UNREACHABLE, message };
}

function undelivered(message: string): Undelivered {
  return { ok: false, code: UNDELIVERED, message };
}

/**
 * The library writes after awaits — a spawn verdict lands seconds later — so a
 * scheduler whose term ended mid-pass would otherwise write into a store the
 * next term already reads. Reads stay open: they change nothing.
 */
export function fencedStore(inner: QueueStore, term: number, live: () => boolean): QueueStore {
  // What M3's relay answers a write from an ended term (`not_leader`), refused here first.
  const fence = (write: () => Promise<StoreWrite>): Promise<StoreWrite> =>
    live() ? write() : Promise.reject(new StoreRevoked(`scheduler term ${term} has ended`));
  return {
    list: () => inner.list(),
    get: (id) => inner.get(id),
    put: (id, expect, body) => fence(() => inner.put(id, expect, body)),
    delete: (id, expect) => fence(() => inner.delete(id, expect)),
    getPause: () => inner.getPause(),
    putPause: (expect, holds) => fence(() => inner.putPause(expect, holds)),
  };
}

function sessionsOf(reply: SessionsResponse | ErrorResponse | NoAnswer): TaskSessionsReply {
  if ("ok" in reply) return reply;
  const { sessions, ended, interrupted, ledgerSince, progress, progressTrimmed } = reply;
  // A proof that does not parse proves nothing: the task then fails rather than risk a twin.
  const proof = typeof ledgerSince === "number" && Number.isFinite(ledgerSince) ? { ledgerSince } : {};
  // A remote daemon's payload is untrusted until parsed. A list that does not
  // parse marks the reply trimmed, as a daemon's own trim does (DESIGN.md, "Done detection").
  const parsed = progress === undefined ? undefined : parseTaskProgressList(progress);
  const trimmed =
    typeof progressTrimmed === "number" && Number.isSafeInteger(progressTrimmed) && progressTrimmed >= 0
      ? progressTrimmed
      : undefined;
  const trimmedBy = parsed === null ? Math.max(trimmed ?? 0, 1) : trimmed;
  // Only ids that are also in `ended`: a bad entry falls back to `done`, never to a re-dispatch.
  const interruptedIds = parseInterrupted(interrupted, ended);
  return {
    ok: true,
    sessions,
    ...(ended === undefined ? {} : { ended }),
    ...(interruptedIds === undefined ? {} : { interrupted: interruptedIds }),
    ...proof,
    ...(parsed === undefined || parsed === null ? {} : { progress: parsed }),
    ...(trimmedBy === undefined ? {} : { progressTrimmed: trimmedBy }),
  };
}

export interface TermFleetOpts {
  /** The term's leg (`LeaderRelay`); the fleet only sends on it and reads its registry. */
  readonly relay: AppRelay;
  readonly selfDeviceId: string;
  readonly local: LocalOps;
  readonly live: () => boolean;
  readonly demote: (why: string) => void;
  /** How long this machine's own `sessions` may take; `OP_TIMEOUT_MS.sessions`, as a remote's, by default. */
  readonly sessionsTimeoutMs?: number;
}

/**
 * This machine's `sessions`, held to the deadline a remote one gets. It waits
 * for every launch in flight, ones that start while it waits included, and the
 * pass waits for it: past the deadline it is `unreachable`, as a remote that
 * never answered is.
 */
async function timeBoxed(
  reply: Promise<SessionsResponse | ErrorResponse>,
  timeoutMs: number = OP_TIMEOUT_MS.sessions,
): Promise<SessionsResponse | ErrorResponse | Unreachable> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Unreachable>((resolve) => {
    timer = setTimeout(() => resolve(unreachable(`this machine's sessions took over ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([reply, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Failures that prove the request never reached its machine: the relay
 * declined delivery, or there was no socket to send it on. `not_leader` is one
 * too, but it ends the term, whose fenced store then refuses the verdict.
 */
const NEVER_DELIVERED: ReadonlySet<FailureReason> = new Set(["offline", "unknown", "refused", "disconnected"]);

/**
 * The `Fleet` over one term's leg. Every call is refused once the term ends,
 * the local ones included, so a stale pass cannot dispatch here either. A
 * request provably never delivered is the library's `undelivered`, which sends
 * a spawn straight back to `ready`; any other missing answer — a timeout, the
 * socket closing after the send, the leg stopping — is `unreachable`, which
 * never fails a task. `not_leader` additionally ends the term, since the relay
 * has said it is someone else's.
 */
export function termFleet(o: TermFleetOpts): Fleet {
  const remote = async <T>(deviceId: string, op: "spawn" | "sessions" | "despawn", payload: unknown) => {
    try {
      return await o.relay.request<T>(deviceId, op, payload);
    } catch (err) {
      if (!(err instanceof RequestFailure)) throw err;
      if (err.reason === "not_leader") o.demote(`the relay refused ${op} to ${quote(deviceId)} as not_leader`);
      return NEVER_DELIVERED.has(err.reason) ? undelivered(err.message) : unreachable(err.message);
    }
  };
  const ended = unreachable("the scheduler term has ended");
  return {
    machines: () => o.relay.getState().machines,
    fleetQuota: () => o.relay.getState().fleetQuota,
    spawn: async (deviceId, request) => {
      if (!o.live()) return ended;
      if (deviceId === o.selfDeviceId) return o.local.spawn(request);
      return remote<SpawnResponse>(deviceId, "spawn", request);
    },
    sessions: async (deviceId) => {
      if (!o.live()) return ended;
      if (deviceId === o.selfDeviceId) return sessionsOf(await timeBoxed(o.local.sessions(), o.sessionsTimeoutMs));
      return sessionsOf(await remote<SessionsResponse>(deviceId, "sessions", {}));
    },
    despawn: async (deviceId, request) => {
      if (!o.live()) return ended;
      if (deviceId === o.selfDeviceId) return o.local.despawn(request);
      return remote<DespawnResponse>(deviceId, "despawn", request);
    },
  };
}
