import {
  MAX_RECORDS,
  MAX_STORE_CREATES_PER_WINDOW,
  STORE_CREATE_WINDOW_MS,
  STORE_PREFIXES,
  type Envelope,
  type StoreDeleteFrame,
  type StoreErrorCode,
  type StorePrefix,
  type StorePrefixRule,
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
 * it on `delete`. The delete call carries 1 record key + 2 keys per purged
 * tombstone (the tombstone and its age entry): 1 + 2 * 32 = 65, well under. The
 * counts row goes in the `put` call.
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

/** Null for a key no rule accepts: an unknown prefix, or another key under a singleton prefix. */
export function ruleFor(key: string): StoreRule | null {
  const rule = Object.values(STORE_PREFIXES).find((candidate) => key.startsWith(candidate.prefix));
  if (rule === undefined) return null;
  const general: StorePrefixRule = rule;
  return general.key !== undefined && general.key !== key ? null : rule;
}

export type StoreAct = "create" | "overwrite" | "delete";

export function actOf(frame: Pick<StorePutFrame | StoreDeleteFrame, "t" | "expect">): StoreAct {
  if (frame.t === "store-delete") return "delete";
  return frame.expect === 0 ? "create" : "overwrite";
}

/**
 * Who may do what, from the prefix's rule alone: `forbidden` or `not_leader`,
 * else null. `leader` is whether the daemon-leg write holds the term
 * (`holdsTerm`); on the app leg a term authorizes nothing, so the caller passes
 * false. A daemon-leg caller is a registered socket: the hub refuses every store
 * frame from one that is not before it gets here.
 *
 * The delete policy comes first, so a `never` prefix refuses the leader too:
 * those keep no tombstone, so a term holder could otherwise erase a person's
 * pause or alias and re-create it from its own version-1 blob. A prefix that is
 * not term-fenced gives any registered daemon socket the creates and overwrites
 * its rule allows the daemon leg; a fenced one, only the term holder.
 */
export function authorize(rule: StoreRule, act: StoreAct, leg: Role, leader: boolean): StoreErrorCode | null {
  if (act === "delete") {
    if (rule.deletes === "never" || leg === "app") return "forbidden";
    return leader ? null : "not_leader";
  }
  if (leg === "daemon") {
    if (rule.termFenced && !leader) return "not_leader";
    return act === "create" && !rule.daemonCreate ? "forbidden" : null;
  }
  if (act === "create") return rule.appCreate ? null : "forbidden";
  return rule.appWrite ? null : "forbidden";
}

/**
 * Whether a write meets the per-socket write floor. Wherever the term fence does
 * not cover a prefix, creates and overwrites both do, on either leg: the fence
 * is what bounds a fenced prefix's writes to the one term socket, and without
 * it a socket looping overwrites burns row writes and fans `store-changed`.
 * On a fenced prefix only an app's creates meet it (the daemon leg's writes
 * there are the term holder's own, bounded by caps).
 */
export function floorsWrite(rule: StoreRule, act: StoreAct, leg: Role): boolean {
  if (act === "delete") return false;
  if (!rule.termFenced) return true;
  return act === "create" && leg === "app";
}

/** A per-socket floor's window, kept on the socket's attachment. */
export interface RateWindow {
  readonly windowStart: number;
  readonly count: number;
}

/**
 * A floor as `#register`'s limit: a new window when there is none or it has
 * expired, else one more. Null past the floor — the caller then leaves the
 * attachment untouched, so a refusal cannot reset the window.
 */
function admitWindow(prior: RateWindow | undefined, now: number, windowMs: number, max: number): RateWindow | null {
  const next =
    prior === undefined || now - prior.windowStart >= windowMs
      ? { windowStart: now, count: 1 }
      : { windowStart: prior.windowStart, count: prior.count + 1 };
  return next.count > max ? null : next;
}

/** The write floor (`floorsWrite`). */
export function admitCreate(prior: RateWindow | undefined, now: number): RateWindow | null {
  return admitWindow(prior, now, STORE_CREATE_WINDOW_MS, MAX_STORE_CREATES_PER_WINDOW);
}

/**
 * The `store-list` floors, which bind every socket but the term holder's. A
 * listing reads every row under its prefix — up to its `cap` — and Durable
 * Object reads are billed per row against a daily limit (5M on the free plan)
 * past which every storage op fails until 00:00 UTC, registers and routing
 * included. So the floors are set by that limit, not by a client. Both are per
 * prefix, so an app's `account:` list on open never spends what a `task:` list
 * needs. The DO-wide bucket refills one list per `LIST_REFILL_MS` per prefix,
 * 10,800 a day each; every prefix listed full at that rate reads at most
 * 10,800 × `MAX_RECORDS` (the caps' bound), 2.8M rows — about half the limit,
 * the rest left for everything else. (4 s held that for `task:` alone; five
 * prefixes halved it.) The per-socket window keeps one looping client from
 * spending a whole bucket.
 */
export const LIST_WINDOW_MS = 60_000;
export const MAX_LISTS_PER_WINDOW = 4;
export const LIST_REFILL_MS = 8_000;
export const LIST_BURST = 16;

export function admitList(prior: RateWindow | undefined, now: number): RateWindow | null {
  return admitWindow(prior, now, LIST_WINDOW_MS, MAX_LISTS_PER_WINDOW);
}

/** A token bucket: `tokens` as of `at`. */
export interface ListBucket {
  readonly tokens: number;
  readonly at: number;
}

/** One list from the DO-wide bucket, or null when it is empty — the caller then keeps the bucket it had. */
export function takeList(prior: ListBucket | undefined, now: number): ListBucket | null {
  const tokens =
    prior === undefined ? LIST_BURST : Math.min(LIST_BURST, prior.tokens + (now - prior.at) / LIST_REFILL_MS);
  return tokens < 1 ? null : { tokens: tokens - 1, at: now };
}

/**
 * Standing tombstones at most; a delete that would leave one more is
 * `store_full`. Tombstones count toward no record cap, so without this a term
 * holder could churn create-and-delete into storage writes for as long as it
 * held the term. 4,096 is about 136 deletes a day held for the full
 * `STORE_TOMBSTONE_MS` — several times what pruning a busy queue does — and
 * with its age entry each tombstone is two rows, so the cap holds them to
 * 8,192 rows, well under a megabyte.
 */
export const MAX_TOMBSTONES = 4_096;

/** Zero-padded so lexical order is numeric order. */
export function tombstoneAgeKey(at: number, key: string): string {
  return `${TOMBSTONE_AGE_NS}${String(at).padStart(16, "0")}:${key}`;
}

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
  /**
   * Standing tombstones, expired ones not yet purged included. Absent on a row
   * written before the cap, and kept absent by a put clearing a tombstone: the
   * next delete counts them from the age index and writes it.
   */
  readonly tombstones?: number;
}

const NO_COUNTS: Counts = { total: 0, prefixes: {}, tombstones: 0 };

function bumped(counts: Counts, prefix: string, by: 1 | -1): Counts {
  return {
    ...counts,
    total: Math.max(0, counts.total + by),
    prefixes: { ...counts.prefixes, [prefix]: Math.max(0, (counts.prefixes[prefix] ?? 0) + by) },
  };
}

export type WriteResult =
  | { readonly ok: true; readonly version: number }
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
  readonly #maxTombstones: number;

  constructor(storage: StoreStorage, tombstoneMs: number, maxTombstones = MAX_TOMBSTONES) {
    this.#storage = storage;
    this.#tombstoneMs = tombstoneMs;
    this.#maxTombstones = maxTombstones;
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
   * `admitted` is the caller's verdict on the write floor (always true where
   * `floorsWrite` is false). It is consulted only after the tombstone and version
   * checks, so a write retried after it landed reads `version_conflict`, never
   * `rate_limited` — and the caps come after that for the same reason.
   */
  async put(key: string, expect: number, env: Envelope, now: number, admitted: boolean): Promise<WriteResult> {
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

    if (!admitted) return { ok: false, code: "rate_limited" };
    const create = current === undefined;
    const entries: Record<string, StoredRecord | Counts> = { [RECORD_NS + key]: { version: version + 1, env } };
    if (create) {
      const counts = (await this.#storage.get<Counts>(COUNTS_KEY)) ?? NO_COUNTS;
      if (counts.total >= MAX_RECORDS) return { ok: false, code: "store_full" };
      if ((counts.prefixes[rule.prefix] ?? 0) >= rule.cap) {
        return { ok: false, code: "store_full" };
      }
      const next = bumped(counts, rule.prefix, 1);
      // Only a create clears a tombstone: the record is gone, so `expect` had to be 0.
      entries[COUNTS_KEY] =
        stone === undefined || next.tombstones === undefined
          ? next
          : { ...next, tombstones: Math.max(0, next.tombstones - 1) };
    }

    // No await between the two calls: they commit together. An expired
    // tombstone and its age entry are always removed together.
    const writes: Promise<unknown>[] = [this.#storage.put(entries)];
    if (stone !== undefined) writes.push(this.#storage.delete([TOMBSTONE_NS + key, tombstoneAgeKey(stone.at, key)]));
    await Promise.all(writes);
    return { ok: true, version: version + 1 };
  }

  /**
   * A missing key is `version_conflict` whatever `expect` is, as in
   * `MemoryQueueStore`. Under a prefix whose rule has `tombstone`, the delete leaves a
   * tombstone and purges up to `PURGE_BATCH` expired ones, oldest first: storage
   * stays bounded by a window of deletes without an alarm, and the one alarm
   * (the sweep's) is armed only while daemons are connected. One that would
   * leave more than `MAX_TOMBSTONES` standing after its purge is `store_full`,
   * checked after the version so a retried delete still reads `version_conflict`.
   */
  async delete(key: string, expect: number, now: number): Promise<WriteResult> {
    const rule = ruleFor(key);
    if (rule === null) return { ok: false, code: "invalid_request" };
    const current = await this.#storage.get<StoredRecord>(RECORD_NS + key);
    if (current === undefined || current.version !== expect) return REFUSED_CONFLICT;

    const counts = (await this.#storage.get<Counts>(COUNTS_KEY)) ?? NO_COUNTS;
    const deletes = [RECORD_NS + key];
    // A tombstone and its age entry are written and removed together (here, and
    // by a put clearing an expired one), so the purge needs no cross-check.
    const aged = await this.#storage.list<string>({ prefix: TOMBSTONE_AGE_NS, limit: PURGE_BATCH });
    let purged = 0;
    for (const [ageKey, storeKey] of aged) {
      const at = Number(ageKey.slice(TOMBSTONE_AGE_NS.length, TOMBSTONE_AGE_NS.length + 16));
      if (now - at < this.#tombstoneMs) break;
      deletes.push(ageKey, TOMBSTONE_NS + storeKey);
      purged += 1;
    }

    const standing = Math.max(0, (counts.tombstones ?? (await this.#countTombstones())) - purged);
    if (rule.tombstone && standing >= this.#maxTombstones) return { ok: false, code: "store_full" };
    const entries: Record<string, StoredRecord | Tombstone | Counts | string> = {
      [COUNTS_KEY]: { ...bumped(counts, rule.prefix, -1), tombstones: standing + (rule.tombstone ? 1 : 0) },
    };
    if (rule.tombstone) {
      entries[TOMBSTONE_NS + key] = { version: current.version, at: now };
      entries[tombstoneAgeKey(now, key)] = key;
    }

    await Promise.all([this.#storage.put(entries), this.#storage.delete(deletes)]);
    return { ok: true, version: current.version };
  }

  /** Once per counts row from before the cap: an age entry's value is its store key, a few dozen bytes. */
  async #countTombstones(): Promise<number> {
    return (await this.#storage.list<string>({ prefix: TOMBSTONE_AGE_NS })).size;
  }
}
