import {
  AT_REST_OPS,
  SCHEDULER_ID,
  STORE_PREFIXES,
  type Envelope,
  type RecordUnreadable,
  type StoreRecord,
  type TaskRecord,
} from "./types.ts";
import { bindTaskRecord } from "./parse.ts";
import { openAtRest, sealAtRest } from "./crypto.ts";

/** The store key a task lives at: the prefix, then its id as it stands (`STORE_KEY_PATTERN`). */
export function taskKey(taskId: string): string {
  return `${STORE_PREFIXES.task.prefix}${taskId}`;
}

/**
 * A `task:<id>` record as the store holds it: op `task`, sealed to
 * SCHEDULER_ID from its writer — `APP_ID` for an app's create, SCHEDULER_ID
 * for the leader's writes. `record.version` must be the version the put will
 * produce, or every reader refuses it (`bindTaskRecord`).
 */
export function sealTaskRecord(key: CryptoKey, from: string, record: TaskRecord): Promise<Envelope> {
  return sealAtRest(key, { to: SCHEDULER_ID, from }, AT_REST_OPS.task, record);
}

/**
 * Every reader's way into a stored task: opened at rest, never through the
 * replay guard (a record is days old by design), then kept only through
 * `bindTaskRecord`. `unopenable` covers a blob that does not decrypt under
 * this key, one sealed for another op, and one sealed to anyone but the
 * scheduler — none of them is this slot's record. `from` is not checked:
 * between PSK holders it authenticates nothing, and both the app and the
 * leader seal tasks.
 */
export async function openTaskRecord(
  key: CryptoKey,
  stored: StoreRecord,
  now: number,
): Promise<TaskRecord | RecordUnreadable> {
  if (stored.env.to !== SCHEDULER_ID) return "unopenable";
  let payload: unknown;
  try {
    payload = (await openAtRest(key, stored.env, AT_REST_OPS.task)).payload;
  } catch {
    return "unopenable";
  }
  return bindTaskRecord(payload, stored, now);
}
