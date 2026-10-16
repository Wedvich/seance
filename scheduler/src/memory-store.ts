import type { QueueStore, StoredTask, StoreWrite } from "./ports.ts";
import type { Task } from "./task.ts";

/**
 * The relay store's version rules over a Map: `expect: 0` creates, every put
 * increments, a mismatch is `version_conflict`. M2's leader runs on this —
 * the queue is in-memory until M3's store lands — and the suite tests on it.
 */
export class MemoryQueueStore implements QueueStore {
  readonly #entries = new Map<string, { readonly version: number; readonly body: Task }>();

  async list(): Promise<readonly StoredTask[]> {
    return [...this.#entries].map(([id, { version, body }]) => ({ id, version, body }));
  }

  async get(id: string): Promise<StoredTask | null> {
    const entry = this.#entries.get(id);
    return entry === undefined ? null : { id, version: entry.version, body: entry.body };
  }

  async put(id: string, expect: number, body: Task): Promise<StoreWrite> {
    const version = this.#entries.get(id)?.version ?? 0;
    if (version !== expect) return { ok: false, code: "version_conflict" };
    this.#entries.set(id, { version: version + 1, body });
    return { ok: true, version: version + 1 };
  }

  async delete(id: string, expect: number): Promise<StoreWrite> {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.version !== expect) return { ok: false, code: "version_conflict" };
    this.#entries.delete(id);
    return { ok: true, version: entry.version };
  }
}
