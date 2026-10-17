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
  RequestFailure,
  sealAtRest,
  sealTaskRecord,
  SCHEDULER_ID,
  STORE_CREATE_MAX_CT_LENGTH,
  STORE_MAX_CT_LENGTH,
  STORE_PREFIXES,
  taskKey,
  type Envelope,
  type PauseHold,
  type StoreDeleteFrame,
  type StorePutFrame,
  type StoreReplyFrame,
  type StoreRequestFrame,
} from "@seance/shared";

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

/** What the adapter sends on: the daemon's relay client (`RelayClient.store`). */
export interface StoreLeg {
  /** Null is a reply this build cannot read; rejects `RequestFailure` when nothing answered. */
  store(frame: StoreRequestFrame): Promise<StoreReplyFrame | null>;
}

export interface QueueStoreOpts {
  readonly leg: StoreLeg;
  readonly key: CryptoKey;
  /** The term this adapter writes under. */
  readonly term: number;
  readonly now: () => number;
}

/** Codes the port can carry as they stand. Any other refusal is the request itself being wrong. */
const PASSED_THROUGH = ["version_conflict", "too_large", "rate_limited", "store_full"] as const;

function isPassedThrough(code: string): code is (typeof PASSED_THROUGH)[number] {
  return PASSED_THROUGH.some((passed) => passed === code);
}

const TASK_PREFIX_LENGTH = STORE_PREFIXES.task.prefix.length;

function withinCap(env: Envelope, expect: number): boolean {
  return env.ct.length <= (expect === 0 ? STORE_CREATE_MAX_CT_LENGTH : STORE_MAX_CT_LENGTH);
}

export function createQueueStore(o: QueueStoreOpts): QueueStore {
  /**
   * A read that cannot be answered rejects: a short list read as the whole
   * queue would be tasks the new leader never runs, and the takeover that
   * fails is retried.
   */
  const read = async (frame: StoreRequestFrame): Promise<StoreReplyFrame> => {
    const reply = await o.leg.store(frame);
    if (reply === null) throw new Error(`${frame.t}: the reply was unreadable`);
    if (reply.t === "store-refused") throw new Error(`${frame.t}: the relay refused it (${reply.code})`);
    return reply;
  };

  /** The port's answer to a write: the relay's reply mapped, or the term's end thrown. */
  const write = async (frame: StorePutFrame | StoreDeleteFrame, version: number): Promise<StoreWrite> => {
    let reply: StoreReplyFrame | null;
    try {
      reply = await o.leg.store(frame);
    } catch (err) {
      if (!(err instanceof RequestFailure)) throw err;
      // Nothing was sent: the socket the term belongs to is gone, so the term is over.
      if (err.reason === "disconnected") throw new StoreRevoked(`no socket to send ${frame.t} on`);
      // Sent, then no answer: it may have committed.
      return { ok: false, code: "indeterminate" };
    }
    if (reply === null) return { ok: false, code: "indeterminate" };
    if (reply.t === "store-written") {
      return reply.version === version ? { ok: true, version } : { ok: false, code: "indeterminate" };
    }
    if (reply.t !== "store-refused") return { ok: false, code: "indeterminate" };
    if (reply.code === "not_leader") throw new StoreRevoked(`the relay refused ${frame.t} as not_leader`);
    return { ok: false, code: isPassedThrough(reply.code) ? reply.code : "refused" };
  };

  return {
    async list(): Promise<readonly StoreEntry[]> {
      const reply = await read({ t: "store-list", id: crypto.randomUUID(), prefix: STORE_PREFIXES.task.prefix });
      if (reply.t !== "store-listed") throw new Error(`store-list: answered with ${reply.t}`);
      const { tasks, unreadable } = await openTaskListing(o.key, reply.records, o.now());
      const readable = tasks.map(
        (record): StoredTask => ({
          id: record.task.id,
          version: record.version,
          body: record.task,
        }),
      );
      const skipped = unreadable.map(
        (entry): StoreEntry => ({
          id: entry.key.startsWith(STORE_PREFIXES.task.prefix) ? entry.key.slice(TASK_PREFIX_LENGTH) : entry.key,
          version: entry.version,
          reason: entry.reason,
        }),
      );
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
