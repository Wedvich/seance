import {
  MAX_RECORDS,
  MAX_STORE_CREATES_PER_WINDOW,
  MAX_TASKS,
  STORE_CREATE_WINDOW_MS,
  STORE_PREFIXES,
  type Envelope,
  type StoreDeleteFrame,
  type StoreErrorCode,
  type StorePrefix,
  type StorePutFrame,
  type StoreRecord,
} from "@seance/shared";
import type { Role } from "./wire.ts";

/**
 * Storage namespaces of the store. None starts with `device:` and none is
 * `scheduler:term`, so no store key — which `STORE_KEY_PATTERN` confines to a
 * known prefix and a routing id — can alias the registry or the leader record.
 */
/** A live record: `{ version, env }`, e.g. `store:task:t-1`. */
export const RECORD_NS = "store:";
/** A tombstone: `{ version, at }`, no env. */
export const TOMBSTONE_NS = "store-tomb:";
/**
 * Age index over the tombstones: `<16-digit at>:<store key>` → the store key.
 * Tombstone keys sort by store key, not by age, so a bounded `list({ limit })`
 * over `store-tomb:` could sit on unexpired entries forever; this one walks
 * oldest first.
 */
export const TOMBSTONE_AGE_NS = "store-tomb-at:";
/**
 * `{ total, prefixes }` of live records. Kept because every DO `list` reads
 * values, and a full `task:` prefix is about 5 MiB: counting by listing would
 * pay that on every create.
 */
export const COUNTS_KEY = "store-meta:counts";

/**
 * Tombstones one delete may purge. Cloudflare's KV-style storage API caps
 * `get`/`put`/`delete` at 128 keys per call, and local workerd does not enforce
 * it on `delete`. A delete sends 1 record key + 2 keys per purged tombstone
 * (the tombstone and its age entry) + the counts: 1 + 2 * 32 = 65, well under.
 */
export const PURGE_BATCH = 32;

/**
 * The slice of `DurableObjectStorage` the store uses, so this module takes no
 * workerd types and its tests run on plain bun.
 */
export interface StoreStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
}

/** The `STORE_PREFIXES` entry a key falls under. */
export type StoreRule = (typeof STORE_PREFIXES)[keyof typeof STORE_PREFIXES];

export function ruleFor(key: string): StoreRule | null {
  return Object.values(STORE_PREFIXES).find((rule) => key.startsWith(rule.prefix)) ?? null;
}

export type StoreAct = "create" | "overwrite" | "delete";

export function actOf(frame: Pick<StorePutFrame | StoreDeleteFrame, "t" | "expect">): StoreAct {
  if (frame.t === "store-delete") return "delete";
  return frame.expect === 0 ? "create" : "overwrite";
}

/**
 * Who may do what, from the prefix's rule: `forbidden` or `not_leader`, else
 * null. `leader` is whether the daemon-leg write holds the term (`holdsTerm`);
 * on the app leg a term authorizes nothing, so the caller passes false.
 *
 * Nothing deletes under `queue:`, the leader included: no client deletes the
 * pause (resume overwrites it) and `queue:` keeps no tombstone, so a term
 * holder could otherwise erase a person's pause and re-create it from its own
 * version-1 blob.
 */
export function authorize(rule: StoreRule, act: StoreAct, leg: Role, leader: boolean): StoreErrorCode | null {
  if (act === "delete" && rule.prefix === STORE_PREFIXES.queue.prefix) return "forbidden";
  if (leg === "daemon" && rule.termFenced) return leader ? null : "not_leader";
  if (act === "create") return rule.appCreate ? null : "forbidden";
  return rule.appWrite ? null : "forbidden";
}

export interface CreateWindow {
  readonly windowStart: number;
  readonly creates: number;
}

/**
 * The create rate floor, as `#register`'s limit: a new window when there is none
 * or it has expired, else one more create. Null past the floor — the caller
 * then leaves the attachment untouched, so a refusal cannot reset the window.
 */
export function admitCreate(prior: CreateWindow | undefined, now: number): CreateWindow | null {
  const next =
    prior === undefined || now - prior.windowStart >= STORE_CREATE_WINDOW_MS
      ? { windowStart: now, creates: 1 }
      : { windowStart: prior.windowStart, creates: prior.creates + 1 };
  return next.creates > MAX_STORE_CREATES_PER_WINDOW ? null : next;
}

/** Zero-padded so lexical order is numeric order. */
export function tombstoneAgeKey(at: number, key: string): string {
  return `${TOMBSTONE_AGE_NS}${String(at).padStart(16, "0")}:${key}`;
}

/** `queue:` is bounded only by `MAX_RECORDS`. */
export const PREFIX_CAPS: Readonly<Partial<Record<StorePrefix, number>>> = { [STORE_PREFIXES.task.prefix]: MAX_TASKS };

interface StoredRecord {
  readonly version: number;
  readonly env: Envelope;
}

interface Tombstone {
  readonly version: number;
  readonly at: number;
}

interface Counts {
  readonly total: number;
  readonly prefixes: Readonly<Record<string, number>>;
}

const NO_COUNTS: Counts = { total: 0, prefixes: {} };

function bumped(counts: Counts, prefix: string, by: 1 | -1): Counts {
  return {
    total: Math.max(0, counts.total + by),
    prefixes: { ...counts.prefixes, [prefix]: Math.max(0, (counts.prefixes[prefix] ?? 0) + by) },
  };
}

/** `purged`: expired tombstones a delete removed, always 0 for a put. */
export type WriteResult =
  | { readonly ok: true; readonly version: number; readonly purged: number }
  | { readonly ok: false; readonly code: StoreErrorCode };

const REFUSED_CONFLICT = { ok: false, code: "version_conflict" } as const;

/**
 * Sealed records at keys over Durable Object storage. Holds only the handle and
 * the tombstone age: no caches, so hibernation loses nothing.
 *
 * Atomicity: each op reads, then writes with storage-only awaits. DO input
 * gates deliver no other event while a storage operation is pending, and writes
 * issued with no `await` between them commit atomically — `#register`'s
 * count-then-put in the hub relies on the same rule. No non-storage await
 * (crypto, fetch, timers) may be added inside these methods.
 */
export class RelayStore {
  readonly #storage: StoreStorage;
  readonly #tombstoneMs: number;

  constructor(storage: StoreStorage, tombstoneMs: number) {
    this.#storage = storage;
    this.#tombstoneMs = tombstoneMs;
  }

  /** Ascending by key, which is the storage list order; tombstones live elsewhere and never appear. */
  async list(prefix: StorePrefix): Promise<StoreRecord[]> {
    const stored = await this.#storage.list<StoredRecord>({ prefix: RECORD_NS + prefix });
    return [...stored].map(([key, { version, env }]) => ({ key: key.slice(RECORD_NS.length), version, env }));
  }

  async get(key: string): Promise<StoreRecord | null> {
    const stored = await this.#storage.get<StoredRecord>(RECORD_NS + key);
    return stored === undefined ? null : { key, version: stored.version, env: stored.env };
  }

  /**
   * `createAdmitted` is the caller's verdict on the app-leg create floor (always
   * true on the daemon leg). It is consulted only after the tombstone and version
   * checks, so a create retried after it landed reads `version_conflict`, never
   * `rate_limited` — and the caps come after that for the same reason.
   */
  async put(key: string, expect: number, env: Envelope, now: number, createAdmitted: boolean): Promise<WriteResult> {
    const rule = ruleFor(key);
    if (rule === null) return { ok: false, code: "invalid_request" };
    const [current, stone] = await Promise.all([
      this.#storage.get<StoredRecord>(RECORD_NS + key),
      this.#storage.get<Tombstone>(TOMBSTONE_NS + key),
    ]);
    // A standing tombstone refuses every put, so a deleted task cannot be re-created from an old blob.
    if (stone !== undefined && now - stone.at < this.#tombstoneMs) return REFUSED_CONFLICT;
    const version = current?.version ?? 0;
    if (version !== expect) return REFUSED_CONFLICT;

    const create = current === undefined;
    if (create && !createAdmitted) return { ok: false, code: "rate_limited" };
    const entries: Record<string, StoredRecord | Counts> = { [RECORD_NS + key]: { version: version + 1, env } };
    if (create) {
      const counts = (await this.#storage.get<Counts>(COUNTS_KEY)) ?? NO_COUNTS;
      if (counts.total >= MAX_RECORDS) return { ok: false, code: "store_full" };
      if ((counts.prefixes[rule.prefix] ?? 0) >= (PREFIX_CAPS[rule.prefix] ?? MAX_RECORDS)) {
        return { ok: false, code: "store_full" };
      }
      entries[COUNTS_KEY] = bumped(counts, rule.prefix, 1);
    }

    // No await between the two calls: they commit together. An expired
    // tombstone and its age entry are always removed together.
    const writes: Promise<unknown>[] = [this.#storage.put(entries)];
    if (stone !== undefined) writes.push(this.#storage.delete([TOMBSTONE_NS + key, tombstoneAgeKey(stone.at, key)]));
    await Promise.all(writes);
    return { ok: true, version: version + 1, purged: 0 };
  }

  /**
   * A missing key is `version_conflict` whatever `expect` is, as in
   * `MemoryQueueStore`. Under a prefix apps may create into, the delete leaves a
   * tombstone and purges up to `PURGE_BATCH` expired ones, oldest first: storage
   * stays bounded by a window of deletes without an alarm, and the one alarm
   * (the sweep's) is armed only while daemons are connected.
   */
  async delete(key: string, expect: number, now: number): Promise<WriteResult> {
    const rule = ruleFor(key);
    if (rule === null) return { ok: false, code: "invalid_request" };
    const current = await this.#storage.get<StoredRecord>(RECORD_NS + key);
    if (current === undefined || current.version !== expect) return REFUSED_CONFLICT;

    const counts = (await this.#storage.get<Counts>(COUNTS_KEY)) ?? NO_COUNTS;
    const entries: Record<string, StoredRecord | Tombstone | Counts | string> = {
      [COUNTS_KEY]: bumped(counts, rule.prefix, -1),
    };
    const deletes = [RECORD_NS + key];
    if (rule.appCreate) {
      entries[TOMBSTONE_NS + key] = { version: current.version, at: now };
      entries[tombstoneAgeKey(now, key)] = key;
    }

    // A tombstone and its age entry are written and removed together (here, and
    // by a put clearing an expired one), so the purge needs no cross-check.
    let purged = 0;
    const aged = await this.#storage.list<string>({ prefix: TOMBSTONE_AGE_NS, limit: PURGE_BATCH });
    for (const [ageKey, storeKey] of aged) {
      const at = Number(ageKey.slice(TOMBSTONE_AGE_NS.length, TOMBSTONE_AGE_NS.length + 16));
      if (now - at < this.#tombstoneMs) break;
      deletes.push(ageKey, TOMBSTONE_NS + storeKey);
      purged += 1;
    }

    await Promise.all([this.#storage.put(entries), this.#storage.delete(deletes)]);
    return { ok: true, version: current.version, purged };
  }
}
