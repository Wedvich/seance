import type {
  DespawnRequest,
  DespawnResponse,
  ErrorResponse,
  Machine,
  SessionEntry,
  SpawnRequest,
  SpawnResponse,
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

export interface StoredTask {
  readonly id: string;
  /** Starts at 1 on create and increments per put; `expect: 0` creates. */
  readonly version: number;
  readonly body: Task;
}

export type StoreWrite =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly code: "version_conflict" };

/**
 * Plain task bodies; sealing and opening (and M3's version binding) are the
 * adapter's. A conflict is a value, never a throw — it is the expected answer
 * to a lost race, not a fault.
 */
export interface QueueStore {
  list(): Promise<readonly StoredTask[]>;
  /** One task, or null when none is stored at `id` — what a conflict refreshes from, instead of a full list. */
  get(id: string): Promise<StoredTask | null>;
  put(id: string, expect: number, body: Task): Promise<StoreWrite>;
  delete(id: string, expect: number): Promise<StoreWrite>;
}

/** Every scheduler spawn carries its task id; the wire field is optional only for other clients. */
export interface TaskSpawnRequest extends SpawnRequest {
  readonly taskId: string;
}

export type TaskSpawnReply = SpawnResponse | ErrorResponse | Unreachable;

export type TaskSessionsReply =
  | { readonly ok: true; readonly sessions: readonly SessionEntry[] }
  | ErrorResponse
  | Unreachable;

export interface Fleet {
  /**
   * The registry as last pushed, each machine with the newest status the host
   * holds for it — live or kept. `connected` and the status's own stamp say
   * which; the library decides what each may be used for.
   */
  machines(): readonly Machine[];
  spawn(deviceId: string, request: TaskSpawnRequest): Promise<TaskSpawnReply>;
  sessions(deviceId: string): Promise<TaskSessionsReply>;
  despawn(deviceId: string, request: DespawnRequest): Promise<DespawnResponse | ErrorResponse | Unreachable>;
}
