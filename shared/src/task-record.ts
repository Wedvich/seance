import {
  AT_REST_OPS,
  ATTACHMENTS_DEP_SENTINEL,
  PIN_SENTINEL,
  SCHEDULER_ID,
  STORE_PREFIXES,
  type Envelope,
  type RecordUnreadable,
  type StoreRecord,
  type Task,
  type TaskSpec,
  type TaskRecord,
} from "./types.ts";
import { bindTaskRecord } from "./parse.ts";
import { openAtRest, sealAtRest } from "./crypto.ts";

/** The store key a task lives at: the prefix, then its id as it stands (`STORE_KEY_PATTERN`). */
export function taskKey(taskId: string): string {
  return `${STORE_PREFIXES.task.prefix}${taskId}`;
}

/**
 * A fresh `queued` task, version 1. The id is app-minted so a retry re-puts the
 * same task instead of minting a second one (`createTask`'s id is never reused).
 */
export function queuedTask(spec: TaskSpec, now: number, id: string = crypto.randomUUID()): Task {
  return { id, spec, state: "queued", createdAt: now };
}

/** The seance MCP tool a `until: "reported"` task's session calls to settle itself (#21). */
export const REPORT_DONE_TOOL = "report_task_done";

export const REPORT_DONE_INSTRUCTION =
  `When this task is fully finished, deploy watch included, call the seance MCP tool \`${REPORT_DONE_TOOL}\` once. ` +
  "It settles the task and releases the tasks waiting on it, so do not call it earlier.";

/** One copy of the report instruction for both clients; the prompt bound applies to the combined text. */
export function withReportInstruction(prompt: string): string {
  return `${prompt}\n\n${REPORT_DONE_INSTRUCTION}`;
}

/**
 * A `task:<id>` record as the store holds it: op `task`, sealed to
 * SCHEDULER_ID from its writer — `APP_ID` for an app's create, SCHEDULER_ID
 * for the leader's writes. `record.version` must be the version the put will
 * produce, or every reader refuses it (`bindTaskRecord`).
 */
export function sealTaskRecord(key: CryptoKey, from: string, record: TaskRecord): Promise<Envelope> {
  return sealAtRest(key, { to: SCHEDULER_ID, from }, AT_REST_OPS.task, taskRecordAtRest(record));
}

/**
 * The record as it is sealed: a spec carrying `pin.account` or `avoid` gains
 * `pin.exclave: PIN_SENTINEL`, and one carrying `attachments` gains
 * `ATTACHMENTS_DEP_SENTINEL` in its deps. An older leader's parser refuses
 * each, so it holds the record unreadable instead of re-sealing it without
 * them. Here, in the one sealer, so the app's create and every leader write
 * emit them alike.
 */
export function taskRecordAtRest(record: TaskRecord): unknown {
  const { spec } = record.task;
  const pinned = spec.pin?.account !== undefined || spec.avoid !== undefined;
  const attached = spec.attachments !== undefined;
  if (!pinned && !attached) return record;
  const sealed = {
    ...spec,
    ...(pinned ? { pin: { ...spec.pin, exclave: PIN_SENTINEL } } : {}),
    ...(attached ? { deps: [...(spec.deps ?? []), ATTACHMENTS_DEP_SENTINEL] } : {}),
  };
  return { ...record, task: { ...record.task, spec: sealed } };
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

/** A stored task this build could not keep: skipped and reported with its reason, never fatal, never deleted. */
export interface UnreadableRecord {
  readonly key: string;
  readonly version: number;
  readonly reason: RecordUnreadable;
}

/**
 * Every record of a `task:` listing, opened one by one. The relay is
 * untrusted, so the listing itself is checked too: a key outside the prefix
 * is no task's, and a key listed twice has two authentic blobs for one id —
 * a lie, not a choice to make — so every copy is reported. Both reuse
 * `key_mismatch`: the key is not one record's address. Order is the listing's.
 */
export async function openTaskListing(
  key: CryptoKey,
  records: readonly StoreRecord[],
  now: number,
): Promise<{ readonly tasks: TaskRecord[]; readonly unreadable: UnreadableRecord[] }> {
  const copies = new Map<string, number>();
  for (const stored of records) copies.set(stored.key, (copies.get(stored.key) ?? 0) + 1);
  const opened = await Promise.all(
    records.map(async (stored): Promise<TaskRecord | RecordUnreadable> =>
      !stored.key.startsWith(STORE_PREFIXES.task.prefix) || (copies.get(stored.key) ?? 0) > 1
        ? "key_mismatch"
        : openTaskRecord(key, stored, now),
    ),
  );
  const tasks: TaskRecord[] = [];
  const unreadable: UnreadableRecord[] = [];
  records.forEach((stored, i) => {
    const read = opened[i];
    if (read === undefined) return;
    if (typeof read === "string") unreadable.push({ key: stored.key, version: stored.version, reason: read });
    else tasks.push(read);
  });
  return { tasks, unreadable };
}
