import type {
  DespawnRequest,
  DespawnResponse,
  ErrorResponse,
  Machine,
  PauseHold,
  RecordUnreadable,
  SessionEntry,
  SpawnRequest,
  SpawnResponse,
  TaskProgress,
} from "@seance/shared";
import type { Task } from "./task.ts";

/**
 * The two seams the host supplies (docs/scheduler.md, "Scheduler"). The
 * library never learns whether they are the relay's store ops and the
 * leader's app-role leg, or SQLite and a client on a fixed box — that is
 * what keeps the placement reversible.
 */

/** Not a daemon code: the host could not get an answer (no route, timed out, socket gone). */
export const UNREACHABLE = "unreachable";

export interface Unreachable {
  readonly ok: false;
  readonly code: typeof UNREACHABLE;
  readonly message: string;
}

/**
 * Not a daemon code either: the request provably never reached the machine —
 * the relay answered that it could not deliver it, or the host never sent it.
 * Unlike `unreachable`, nothing can have run.
 */
export const UNDELIVERED = "undelivered";

export interface Undelivered {
  readonly ok: false;
  readonly code: typeof UNDELIVERED;
  readonly message: string;
}

/** Every way the host can fail to get a daemon's answer. */
export type NoAnswer = Unreachable | Undelivered;

export interface StoredTask {
  readonly id: string;
  /** Starts at 1 on create and increments per put; `expect: 0` creates. */
  readonly version: number;
  readonly body: Task;
  readonly reason?: never;
}

/**
 * A record the adapter could not read: it did not open, or broke a reader rule
 * (`bindTaskRecord` — an old blob put back at a newer version reads
 * `version_mismatch`). Reported, never acted on and never deleted unasked:
 * after a PSK rotation every record reads `unopenable`, and deleting them would
 * wipe the queue.
 */
export interface UnreadableTask {
  readonly id: string;
  readonly version: number;
  readonly reason: RecordUnreadable;
  readonly body?: never;
}

export type StoreEntry = StoredTask | UnreadableTask;

/**
 * Why a write did not land, as a value — every answer the store can give that
 * leaves this writer still allowed to write. `version_conflict`: another
 * writer's version (a lost race). `indeterminate`: the reply was lost, so it
 * may have committed; a reader settles it as a conflict would, by reading the
 * record. `too_large`: the sealed record is past the store's bound. `store_full`
 * and `rate_limited` refuse creates. `refused`: the store rejected the request
 * itself (`forbidden`, `invalid_request`) — a bug, not a race.
 */
export const STORE_WRITE_FAILURES = [
  "version_conflict",
  "indeterminate",
  "too_large",
  "store_full",
  "rate_limited",
  "refused",
] as const;

export type StoreWriteFailure = (typeof STORE_WRITE_FAILURES)[number];

export type StoreWrite =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly code: StoreWriteFailure };

/**
 * The store said this writer may no longer write (`not_leader`: its term is
 * over). A throw, unlike every `StoreWrite` failure: nothing the library could
 * do next is allowed, so the pass unwinds and the host ends the term.
 */
export class StoreRevoked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreRevoked";
  }
}

/** The `queue:pause` record: every hold on dispatch, at its version. */
export interface StoredPause {
  readonly version: number;
  readonly holds: readonly PauseHold[];
  readonly reason?: never;
}

export interface UnreadablePause {
  readonly version: number;
  readonly reason: RecordUnreadable;
  readonly holds?: never;
}

/**
 * Plain task bodies and holds; sealing, opening and the reader rules are the
 * adapter's. A failed write is a value (`StoreWrite`) — a conflict is the
 * expected answer to a lost race, not a fault — except losing the right to
 * write, which throws `StoreRevoked`.
 */
export interface QueueStore {
  /** Every record under `task:`, the unreadable ones included. */
  list(): Promise<readonly StoreEntry[]>;
  /** One record, or null when none is stored at `id` — what a conflict or `store-changed` refreshes from. */
  get(id: string): Promise<StoreEntry | null>;
  put(id: string, expect: number, body: Task): Promise<StoreWrite>;
  delete(id: string, expect: number): Promise<StoreWrite>;
  /** `queue:pause`, or null before the first pause. */
  getPause(): Promise<StoredPause | UnreadablePause | null>;
  putPause(expect: number, holds: readonly PauseHold[]): Promise<StoreWrite>;
}

/** Every scheduler spawn carries its task id; the wire field is optional only for other clients. */
export interface TaskSpawnRequest extends SpawnRequest {
  readonly taskId: string;
}

export type TaskSpawnReply = SpawnResponse | ErrorResponse | NoAnswer;

export type TaskSessionsReply =
  | {
      readonly ok: true;
      readonly sessions: readonly SessionEntry[];
      /**
       * `SessionsResponse.ended`: task ids launched or ended here that no live
       * pane carries. Absent from older daemons, and when there are none.
       */
      readonly ended?: readonly string[];
      /**
       * `SessionsResponse.ledgerSince`, the machine's clock: `ended` is complete
       * for launches from here on. Absent from older daemons, which prove nothing.
       */
      readonly ledgerSince?: number;
      /**
       * `SessionsResponse.progress`: each task's PR and branch as the machine
       * last saw them. Absent from older daemons; read as no entry for any task.
       */
      readonly progress?: readonly TaskProgress[];
      /**
       * `SessionsResponse.progressTrimmed`. Present, a task with no `progress`
       * entry is unknown, and waits for a later read. An adapter whose
       * `progress` did not parse sets it too.
       */
      readonly progressTrimmed?: number;
    }
  | ErrorResponse
  | NoAnswer;

export interface Fleet {
  /**
   * The registry as last pushed, each machine with the newest status the host
   * holds for it — live or kept. `connected` and the status's own stamp say
   * which; the library decides what each may be used for.
   */
  machines(): readonly Machine[];
  spawn(deviceId: string, request: TaskSpawnRequest): Promise<TaskSpawnReply>;
  sessions(deviceId: string): Promise<TaskSessionsReply>;
  despawn(deviceId: string, request: DespawnRequest): Promise<DespawnResponse | ErrorResponse | NoAnswer>;
}
