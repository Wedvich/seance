import { MAX_TASKS, STORE_TOMBSTONE_MS, type PauseHold, type RecordUnreadable } from "@seance/shared";
import {
  StoreRevoked,
  type QueueStore,
  type StoreEntry,
  type StoredPause,
  type StoreWrite,
  type StoreWriteFailure,
  type UnreadablePause,
} from "./ports.ts";
import type { Task } from "./task.ts";

/** A record as the store holds it: a body that names some version, or one no reader can open. */
type Held =
  | { readonly version: number; readonly body: Task; readonly names: number }
  | { readonly version: number; readonly unreadable: RecordUnreadable };

/** A fault the next write meets (`failNext`): a refusal, a lost reply, or the term gone. */
export interface StoreFault {
  readonly code: StoreWriteFailure | "revoked";
  /** The write lands before the reply is lost — what makes `indeterminate` indeterminate. */
  readonly commit?: boolean;
}

export interface MemoryQueueStoreOptions {
  readonly now?: () => number;
  readonly tombstoneMs?: number;
  /** Records a create may not grow past (`store_full`): the relay's `MAX_TASKS` unless a test needs a smaller one. */
  readonly maxTasks?: number;
}

/**
 * The relay store's rules over Maps, with the adapter's reader rules folded in:
 * `expect: 0` creates, every put increments, a mismatch is `version_conflict`,
 * a create past `maxTasks` is `store_full`, a delete leaves a tombstone that
 * refuses any put for `tombstoneMs`, and a
 * body that does not name its record's version reads `version_mismatch`. The
 * leader runs on the relay's store (`daemon/src/queue-store.ts`); the suite
 * tests on this, through the fault hooks below for what only a real store
 * or an attacker would do.
 */
export class MemoryQueueStore implements QueueStore {
  readonly #entries = new Map<string, Held>();
  readonly #tombstones = new Map<string, { readonly version: number; readonly at: number }>();
  /** Every body each id has held, by the version it named: what `replay` puts back. */
  readonly #history = new Map<string, Map<number, Task>>();
  readonly #faults: StoreFault[] = [];
  readonly #now: () => number;
  readonly #tombstoneMs: number;
  readonly #maxTasks: number;
  #pause: StoredPause | UnreadablePause | null = null;

  constructor(options: MemoryQueueStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#tombstoneMs = options.tombstoneMs ?? STORE_TOMBSTONE_MS;
    this.#maxTasks = options.maxTasks ?? MAX_TASKS;
  }

  async list(): Promise<readonly StoreEntry[]> {
    return [...this.#entries.keys()].flatMap((id) => this.#read(id) ?? []);
  }

  async get(id: string): Promise<StoreEntry | null> {
    return this.#read(id);
  }

  async put(id: string, expect: number, body: Task): Promise<StoreWrite> {
    return this.#write(() => {
      if (this.#tombstoned(id)) return { ok: false, code: "version_conflict" };
      const version = this.#entries.get(id)?.version ?? 0;
      if (version !== expect) return { ok: false, code: "version_conflict" };
      // Tombstones count toward no cap.
      if (version === 0 && this.#entries.size >= this.#maxTasks) return { ok: false, code: "store_full" };
      this.#hold(id, version + 1, body);
      return { ok: true, version: version + 1 };
    });
  }

  async delete(id: string, expect: number): Promise<StoreWrite> {
    return this.#write(() => {
      const entry = this.#entries.get(id);
      if (entry === undefined || entry.version !== expect) return { ok: false, code: "version_conflict" };
      this.#entries.delete(id);
      this.#tombstones.set(id, { version: entry.version, at: this.#now() });
      return { ok: true, version: entry.version };
    });
  }

  async getPause(): Promise<StoredPause | UnreadablePause | null> {
    return this.#pause;
  }

  async putPause(expect: number, holds: readonly PauseHold[]): Promise<StoreWrite> {
    return this.#write(() => {
      const version = this.#pause?.version ?? 0;
      if (version !== expect) return { ok: false, code: "version_conflict" };
      this.#pause = { version: version + 1, holds };
      return { ok: true, version: version + 1 };
    });
  }

  /** The next write meets `fault` instead of its normal answer; queued, one per write. */
  failNext(fault: StoreFault): void {
    this.#faults.push(fault);
  }

  /**
   * Puts back the body `id` held at `version` as the record's next version —
   * an authentic old blob put back, which only a relay or a term holder can do.
   * It names the version it was sealed at, so a reader refuses it.
   */
  replay(id: string, version: number): void {
    const body = this.#history.get(id)?.get(version);
    const current = this.#entries.get(id);
    if (body === undefined || current === undefined) throw new Error(`no version ${version} of ${id} to replay`);
    this.#entries.set(id, { version: current.version + 1, body, names: version });
  }

  /** A record no reader can use — junk a token holder created, or a body sealed under another PSK. */
  plant(id: string, reason: RecordUnreadable, version = 1): void {
    this.#entries.set(id, { version, unreadable: reason });
  }

  /** The pause record no reader can use. */
  plantPause(reason: RecordUnreadable, version = 1): void {
    this.#pause = { version, reason };
  }

  #read(id: string): StoreEntry | null {
    const entry = this.#entries.get(id);
    if (entry === undefined) return null;
    if ("unreadable" in entry) return { id, version: entry.version, reason: entry.unreadable };
    if (entry.names !== entry.version) return { id, version: entry.version, reason: "version_mismatch" };
    return { id, version: entry.version, body: entry.body };
  }

  #hold(id: string, version: number, body: Task): void {
    this.#entries.set(id, { version, body, names: version });
    const history = this.#history.get(id) ?? new Map<number, Task>();
    history.set(version, body);
    this.#history.set(id, history);
  }

  #tombstoned(id: string): boolean {
    const stone = this.#tombstones.get(id);
    if (stone === undefined) return false;
    if (this.#now() - stone.at < this.#tombstoneMs) return true;
    this.#tombstones.delete(id);
    return false;
  }

  #write(apply: () => StoreWrite): StoreWrite {
    const fault = this.#faults.shift();
    if (fault === undefined) return apply();
    if (fault.code === "revoked") throw new StoreRevoked("not_leader: the term has ended");
    if (fault.commit === true) apply();
    return { ok: false, code: fault.code };
  }
}
