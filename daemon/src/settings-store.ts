import {
  AT_REST_OPS,
  openAtRest,
  parseSettingsRecord,
  sealAtRest,
  SCHEDULER_ID,
  SETTINGS_KEY,
  type SettingsRecord,
} from "@seance/shared";
import { storeIo, withinCap, type FrameWrite, type StoreLeg } from "./store-frames.ts";
import type { VersionFloor } from "./version-floor.ts";

/**
 * The leader's adapter over `settings:main` (DESIGN.md, Scheduler, "Settings
 * record"): one `SettingsRecord`, sealed to `SCHEDULER_ID` from itself with op
 * `settings`, read by the same rules as every at-rest blob (`openAtRest`, then
 * the strict parser, then the version binding).
 *
 * One adapter is one term, as `queue-store.ts`'s is: every write carries `term`
 * and is fenced on `live`, so a late write of an ended term never lands under
 * its successor's. It is not a `LEADER_MODULES` file, so it names no library
 * type: the term's end is thrown as the caller's `revoked`.
 *
 * Logs nothing — the record holds a private key, and a log line is where it
 * would leak. A reason is the caller's to log, never a body, `env` or `ct`.
 */

/** Why a record that exists reads as nothing the leader may use. Never a reason to write over it. */
export type SettingsUnreadable = "key_mismatch" | "unopenable" | "malformed" | "version_mismatch" | "version_regressed";

/** Null: no record. A reason: one is there that this leader will neither use nor replace. */
export type SettingsRead =
  | { readonly version: number; readonly record: SettingsRecord; readonly reason?: undefined }
  | { readonly version: number; readonly reason: SettingsUnreadable; readonly record?: undefined }
  | null;

export type SettingsWrite = FrameWrite;

export interface SettingsStore {
  get(): Promise<SettingsRead>;
  /** Writes `record` at `expect + 1`, as the version it is sealed with: `expect` 0 creates. */
  put(expect: number, record: Omit<SettingsRecord, "version">): Promise<SettingsWrite>;
}

export interface SettingsStoreOpts {
  readonly leg: StoreLeg;
  readonly key: CryptoKey;
  /** The term this adapter writes under. */
  readonly term: number;
  /** Whether the term still runs; a write after it ended throws `revoked` and sends nothing. */
  readonly live: () => boolean;
  /** The process's version floor; absent, the record is read unfloored (tests). */
  readonly floor?: VersionFloor;
  /** The term's end, as the library's `StoreRevoked`. */
  readonly revoked: (why: string) => Error;
}

export function createSettingsStore(o: SettingsStoreOpts): SettingsStore {
  const { read, write } = storeIo(o.leg, o.revoked);

  /** The record as the relay holds it, before the floor. */
  const fetchRecord = async (): Promise<SettingsRead> => {
    const reply = await read({ t: "store-get", id: crypto.randomUUID(), key: SETTINGS_KEY });
    if (reply.t !== "store-record") throw new Error(`store-get: answered with ${reply.t}`);
    const { record } = reply;
    if (record === null) return null;
    if (record.key !== SETTINGS_KEY) return { version: record.version, reason: "key_mismatch" };
    if (record.env.to !== SCHEDULER_ID) return { version: record.version, reason: "unopenable" };
    let payload: unknown;
    try {
      payload = (await openAtRest(o.key, record.env, AT_REST_OPS.settings)).payload;
    } catch {
      return { version: record.version, reason: "unopenable" };
    }
    const parsed = parseSettingsRecord(payload);
    if (parsed === null) return { version: record.version, reason: "malformed" };
    if (parsed.version !== record.version) return { version: record.version, reason: "version_mismatch" };
    return { version: record.version, record: parsed };
  };

  return {
    async get(): Promise<SettingsRead> {
      const found = await fetchRecord();
      const floor = o.floor;
      if (floor === undefined) return found;
      // Missing once one was seen is a rolled-back store, not a first run: nothing may be created over it.
      if (found === null) return floor.settings() === 0 ? null : { version: 0, reason: "version_regressed" };
      if (found.reason !== undefined) return found;
      if (found.version < floor.settings()) return { version: found.version, reason: "version_regressed" };
      if (floor.sawSettings(found.version)) await floor.save();
      return found;
    },

    async put(expect: number, record: Omit<SettingsRecord, "version">): Promise<SettingsWrite> {
      // The library's writes are fenced the same way (`fencedStore`), since a write runs after awaits.
      if (!o.live()) throw o.revoked(`settings term ${o.term} has ended`);
      const version = expect + 1;
      // Sealed is the parsed copy, which holds only known fields: what is sealed is what was checked.
      const parsed = parseSettingsRecord({ ...record, version });
      if (parsed === null) return { ok: false, code: "refused" };
      const env = await sealAtRest(o.key, { to: SCHEDULER_ID, from: SCHEDULER_ID }, AT_REST_OPS.settings, parsed);
      if (!withinCap(env, expect)) return { ok: false, code: "too_large" };
      const result = await write(
        { t: "store-put", id: crypto.randomUUID(), key: SETTINGS_KEY, expect, env, term: o.term },
        version,
      );
      if (result.ok && o.floor?.wroteSettings(result.version) === true) await o.floor.save();
      return result;
    },
  };
}
