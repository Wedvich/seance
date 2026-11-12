import { promptBasis } from "./amend.ts";
import { isRecord, parseAmendRequest } from "./parse.ts";
import type { StoreRefusal, TaskLookup } from "./app-client.ts";
import type { AmendRequest, TaskReply } from "./types.ts";

/** An amendment as a caller writes it: `basis` only when it read the prompt it replaces itself. */
export type AmendDraft = Omit<AmendRequest, "basis"> & { readonly basis?: string };

/** What `sendAmend` needs of an app-role client: a store read of the task and the one op. */
export interface AmendSender {
  readonly getTask: (taskId: string) => Promise<TaskLookup | StoreRefusal | null>;
  readonly amend: (request: AmendRequest) => Promise<TaskReply | null>;
}

/**
 * `sendAmend` could not read the prompt to name its `basis`, worded here since no leader was asked: the
 * store refused or did not answer (`unread`), holds no such task (`task_not_found`), or holds one it
 * cannot read (`unreadable`). Shaped as a `SchedulerError`, so it crosses the broker as one.
 */
export const AMEND_READ_FAILURES = {
  unread: "the task's prompt could not be read from the store, so nothing was sent; try again",
  task_not_found: "the store holds no such task",
  unreadable: "the task's record cannot be read with this key, so nothing was sent",
} as const;

export interface AmendReadFailure {
  readonly ok: false;
  readonly code: keyof typeof AMEND_READ_FAILURES;
  readonly message: string;
}

function readFailure(code: AmendReadFailure["code"]): AmendReadFailure {
  return { ok: false, code, message: AMEND_READ_FAILURES[code] };
}

/** An append whose prompt moved first is sent again on the new one, this many times in all. */
const APPEND_ATTEMPTS = 3;

/**
 * Sends `draft`, naming as `basis` the prompt the store holds now when the draft names none (an
 * append, or a replace of whatever is there). Only then is a `prompt_changed` sent again, on the
 * prompt read afresh: the refusal says it did not land. A lost answer (null) is never retried — it
 * may have landed, and a second append would add the text twice. A draft with no prompt needs no read.
 */
export async function sendAmend(client: AmendSender, draft: AmendDraft): Promise<TaskReply | AmendReadFailure | null> {
  if (draft.prompt === undefined || draft.basis !== undefined) {
    return client.amend(draft.basis === undefined ? withoutBasis(draft) : { ...draft, basis: draft.basis });
  }
  let reply: TaskReply | null = null;
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each read follows the refusal before it
    const read = await client.getTask(draft.taskId);
    if (read === null || !read.ok) return readFailure("unread");
    if (read.task === null) return readFailure("task_not_found");
    if (!("task" in read.task)) return readFailure("unreadable");
    // oxlint-disable-next-line no-await-in-loop -- as above
    const basis = await promptBasis(read.task.task.spec.prompt);
    // oxlint-disable-next-line no-await-in-loop -- as above
    reply = await client.amend({ ...draft, basis });
    if (reply === null || "task" in reply || reply.code !== "prompt_changed") return reply;
  }
  return reply;
}

function withoutBasis({ basis: _basis, ...rest }: AmendDraft): AmendRequest {
  return rest;
}

/** Stands in for `basis` while a draft without one is checked by the leader's own parser. */
const NO_BASIS = "0".repeat(64);

/**
 * A draft as the fleet broker takes it from a keyless peer: `parseAmendRequest`'s checks, with
 * `basis` optional beside `prompt` (the broker's daemon reads the task for it), built afresh.
 */
export function parseAmendDraft(value: unknown): AmendDraft | null {
  if (!isRecord(value)) return null;
  if (value["prompt"] === undefined || value["basis"] !== undefined) return parseAmendRequest(value);
  const parsed = parseAmendRequest({ ...value, basis: NO_BASIS });
  return parsed === null ? null : withoutBasis(parsed);
}
