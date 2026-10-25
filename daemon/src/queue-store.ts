import {
  StoreRevoked,
  type QueueStore,
  type StoreEntry,
  type StoredPause,
  type StoredTask,
  type StoreWrite,
  type Task,
  type UnreadablePause,
} from "@seance/scheduler";
import {
  AT_REST_OPS,
  bindTaskRecord,
  openAtRest,
  openTaskListing,
  openTaskRecord,
  parsePauseRecord,
  PAUSE_KEY,
  sealAtRest,
  sealTaskRecord,
  SCHEDULER_ID,
  STORE_PREFIXES,
  taskKey,
  type PauseHold,
} from "@seance/shared";
import { storeIo, withinCap, type StoreLeg } from "./store-frames.ts";
import type { VersionFloor } from "./version-floor.ts";

/**
 * The leader's `QueueStore` over the relay's store ops (DESIGN.md, Scheduler,
 * "The store"; docs/scheduler.md, "The store adapter"). The port carries plain
 * task bodies and holds: sealing, opening and the reader rules are this
 * module's, so every record is opened through `openAtRest` with its slot's op
 * and a task is kept only through `bindTaskRecord`.
 *
 * One adapter is one term: every write carries `term`, and the relay fences it
 * on that term and the socket it was issued to (`StoreLeg` is that socket).
 * A term's adapter is never shared, so a late pass of an ended term can never
 * write under its successor's.
 *
 * No line is logged per op, and no body, key, `env` or `ct` is ever logged.
 */

export type { StoreLeg };

export interface QueueStoreOpts {
  readonly leg: StoreLeg;
  readonly key: CryptoKey;
  /** The term this adapter writes under. */
  readonly term: number;
  readonly now: () => number;
}

const TASK_PREFIX_LENGTH = STORE_PREFIXES.task.prefix.length;

export function createQueueStore(o: QueueStoreOpts): QueueStore {
  const { read, write } = storeIo(o.leg, (why) => new StoreRevoked(why));

  return {
    async list(): Promise<readonly StoreEntry[]> {
      const reply = await read({ t: "store-list", id: crypto.randomUUID(), prefix: STORE_PREFIXES.task.prefix });
      if (reply.t !== "store-listed") throw new Error(`store-list: answered with ${reply.t}`);
      const { tasks, unreadable } = await openTaskListing(o.key, reply.records, o.now());
      const readable = tasks.map((record): StoredTask => ({
        id: record.task.id,
        version: record.version,
        body: record.task,
      }));
      const skipped = unreadable.map((entry): StoreEntry => ({
        id: entry.key.startsWith(STORE_PREFIXES.task.prefix) ? entry.key.slice(TASK_PREFIX_LENGTH) : entry.key,
        version: entry.version,
        reason: entry.reason,
      }));
      return [...readable, ...skipped];
    },

    async get(id: string): Promise<StoreEntry | null> {
      const key = taskKey(id);
      const reply = await read({ t: "store-get", id: crypto.randomUUID(), key });
      if (reply.t !== "store-record") throw new Error(`store-get: answered with ${reply.t}`);
      if (reply.record === null) return null;
      // A record bound to another key is no answer to this one: binding checks it against the key it came with.
      if (reply.record.key !== key) throw new Error("store-get: the relay answered with another key's record");
      const opened = await openTaskRecord(o.key, reply.record, o.now());
      if (typeof opened === "string") return { id, version: reply.record.version, reason: opened };
      return { id, version: reply.record.version, body: opened.task };
    },

    async put(id: string, expect: number, body: Task): Promise<StoreWrite> {
      const key = taskKey(id);
      const version = expect + 1;
      // Sealed is the parsed copy, which holds only known fields: what is sealed is what was checked.
      const record = bindTaskRecord({ version, task: body }, { key, version }, o.now());
      if (typeof record === "string") return { ok: false, code: "refused" };
      const env = await sealTaskRecord(o.key, SCHEDULER_ID, record);
      if (!withinCap(env, expect)) return { ok: false, code: "too_large" };
      return write({ t: "store-put", id: crypto.randomUUID(), key, expect, env, term: o.term }, version);
    },

    async delete(id: string, expect: number): Promise<StoreWrite> {
      return write({ t: "store-delete", id: crypto.randomUUID(), key: taskKey(id), expect, term: o.term }, expect);
    },

    async getPause(): Promise<StoredPause | UnreadablePause | null> {
      const reply = await read({ t: "store-get", id: crypto.randomUUID(), key: PAUSE_KEY });
      if (reply.t !== "store-record") throw new Error(`store-get: answered with ${reply.t}`);
      const { record } = reply;
      if (record === null) return null;
      if (record.key !== PAUSE_KEY) return { version: record.version, reason: "key_mismatch" };
      if (record.env.to !== SCHEDULER_ID) return { version: record.version, reason: "unopenable" };
      let payload: unknown;
      try {
        payload = (await openAtRest(o.key, record.env, AT_REST_OPS.pauseState)).payload;
      } catch {
        return { version: record.version, reason: "unopenable" };
      }
      const parsed = parsePauseRecord(payload);
      if (parsed === null) return { version: record.version, reason: "malformed" };
      if (parsed.version !== record.version) return { version: record.version, reason: "version_mismatch" };
      return { version: record.version, holds: parsed.holds };
    },

    async putPause(expect: number, holds: readonly PauseHold[]): Promise<StoreWrite> {
      const version = expect + 1;
      const parsed = parsePauseRecord({ version, holds });
      if (parsed === null) return { ok: false, code: "refused" };
      const env = await sealAtRest(o.key, { to: SCHEDULER_ID, from: SCHEDULER_ID }, AT_REST_OPS.pauseState, parsed);
      if (!withinCap(env, expect)) return { ok: false, code: "too_large" };
      return write({ t: "store-put", id: crypto.randomUUID(), key: PAUSE_KEY, expect, env, term: o.term }, version);
    },
  };
}

const regressed = (entry: StoreEntry): StoreEntry => ({
  id: entry.id,
  version: entry.version,
  reason: "version_regressed",
});

/**
 * `inner` held to the process's version floor (`version-floor.ts`): a readable
 * task record below it reads `version_regressed`; a pause below it, or missing
 * once one was seen, reads the same, so the library holds the whole queue as it
 * does for any unreadable pause; and a task record that vanished without this
 * leader deleting it is no answer — the read rejects, and the library keeps the
 * task as it held it. Every read at or above the floor, and every write that
 * landed, raises it, saved before the library acts on what it read.
 *
 * A listing that leaves a key out is not a vanish: a new term holds only what
 * it lists, and a task it does not hold runs nothing.
 */
export function flooredStore(inner: QueueStore, floor: VersionFloor): QueueStore {
  /** Each entry against the floor, then the floor raised by those that passed. */
  const read = async (entries: readonly StoreEntry[]): Promise<StoreEntry[]> => {
    const checked = entries.map((entry) =>
      entry.body !== undefined && entry.version < floor.task(entry.id) ? regressed(entry) : entry,
    );
    const raised = checked.map((entry) => entry.body !== undefined && floor.sawTask(entry.id, entry.version));
    if (raised.includes(true)) await floor.save();
    return checked;
  };
  return {
    list: async () => read(await inner.list()),

    async get(id: string): Promise<StoreEntry | null> {
      const entry = await inner.get(id);
      if (entry !== null) return (await read([entry]))[0] ?? null;
      if (!floor.vanished(id)) {
        throw new Error(`task:${id} vanished from the store without this leader deleting it — kept as it was`);
      }
      await floor.save();
      return null;
    },

    async put(id: string, expect: number, body: Task): Promise<StoreWrite> {
      const write = await inner.put(id, expect, body);
      if (write.ok && floor.wroteTask(id, write.version)) await floor.save();
      return write;
    },

    async delete(id: string, expect: number): Promise<StoreWrite> {
      const write = await inner.delete(id, expect);
      if (write.ok || write.code === "indeterminate") {
        floor.deletedTask(id, expect, write.ok);
        await floor.save();
      }
      return write;
    },

    async getPause(): Promise<StoredPause | UnreadablePause | null> {
      const pause = await inner.getPause();
      if (pause === null) return floor.pause() === 0 ? null : { version: 0, reason: "version_regressed" };
      if (pause.reason !== undefined) return pause;
      if (pause.version < floor.pause()) return { version: pause.version, reason: "version_regressed" };
      if (floor.sawPause(pause.version)) await floor.save();
      return pause;
    },

    async putPause(expect: number, holds: readonly PauseHold[]): Promise<StoreWrite> {
      const write = await inner.putPause(expect, holds);
      if (write.ok) {
        floor.wrotePause(write.version);
        await floor.save();
      }
      return write;
    },
  };
}
