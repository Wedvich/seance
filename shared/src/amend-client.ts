import { applyDepsChange, depsBasis, promptBasis, type DepsChange } from "./amend.ts";
import { codexAmendRefusal, codexRefusalText } from "./codex.ts";
import { isRecord, isTaskId, parseAmendRequest, parseDepList } from "./parse.ts";
import type { StoreRefusal, TaskLookup } from "./app-client.ts";
import { TASK_SPEC_LIMITS, type AmendRequest, type TaskReply } from "./types.ts";

/**
 * An amendment as a caller writes it: `basis` only when it read the prompt it replaces itself, and `deps` a change
 * (`DepsChange`), never a whole list against a basis: `sendAmend` reads the task and applies it.
 */
export type AmendDraft = Omit<AmendRequest, "basis" | "deps"> & {
  readonly basis?: string;
  readonly deps?: DepsChange;
};

/** What `sendAmend` needs of an app-role client: a store read of the task and the one op. */
export interface AmendSender {
  readonly getTask: (taskId: string) => Promise<TaskLookup | StoreRefusal | null>;
  readonly amend: (request: AmendRequest) => Promise<TaskReply | null>;
}

/**
 * `sendAmend` refused before any leader was asked, worded here since none was: the store refused or did not
 * answer the read (`unread`), holds no such task (`task_not_found`) or one it cannot read (`unreadable`), the
 * task's agent refuses the effort asked (`agent_unsupported`: `codexAmendRefusal`, whose one clause is `effort max`),
 * or a deps change would leave more edges than a task holds (`deps_full`). Shaped as a `SchedulerError`, so it crosses
 * the broker as one.
 */
export const AMEND_CLIENT_REFUSALS = {
  unread: "the task could not be read from the store, so nothing was sent; try again",
  task_not_found: "the store holds no such task",
  unreadable: "the task's record cannot be read with this key, so nothing was sent",
  agent_unsupported: `${codexRefusalText("effort max")}, so nothing was sent`,
  deps_full: `the task would wait on more than ${TASK_SPEC_LIMITS.deps} tasks, so nothing was sent; drop an edge too`,
} as const;

export interface AmendClientRefusal {
  readonly ok: false;
  readonly code: keyof typeof AMEND_CLIENT_REFUSALS;
  readonly message: string;
}

function clientRefusal(code: AmendClientRefusal["code"]): AmendClientRefusal {
  return { ok: false, code, message: AMEND_CLIENT_REFUSALS[code] };
}

/** An append whose prompt moved first, or a deps change whose list did, is sent again on the new one, this many times in all. */
const APPEND_ATTEMPTS = 3;

/**
 * Sends `draft`, naming as `basis` the prompt the store holds now when the draft names none (an
 * append, or a replace of whatever is there), and applying a deps change to the list the store holds now
 * (`applyDepsChange`) with that list's `depsBasis`; one read serves both. Only then is a `prompt_changed` or a
 * `deps_changed` sent again, the change re-applied to the task read afresh: the refusal says it did not land, and a
 * refusal of either basis re-applies both. A lost answer (null) is never retried — it may have landed, and a second
 * append would add the text twice. Effort `max` reads the task too, and is refused unsent on a Codex one
 * (`codexAmendRefusal`), which the leader would only refuse again. Any other draft needs no read.
 */
export async function sendAmend(
  client: AmendSender,
  draft: AmendDraft,
): Promise<TaskReply | AmendClientRefusal | null> {
  const readsBasis = draft.prompt !== undefined && draft.basis === undefined;
  const readsDeps = draft.deps !== undefined;
  if (!readsBasis && !readsDeps && draft.effort !== "max") return client.amend(requestOf(draft, draft.basis));
  let reply: TaskReply | null = null;
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each read follows the refusal before it
    const read = await client.getTask(draft.taskId);
    if (read === null || !read.ok) return clientRefusal("unread");
    if (read.task === null) return clientRefusal("task_not_found");
    if (!("task" in read.task)) return clientRefusal("unreadable");
    const { spec } = read.task.task;
    if (codexAmendRefusal(spec, draft) !== null) return clientRefusal("agent_unsupported");
    const list = draft.deps === undefined ? undefined : applyDepsChange(spec.deps, draft.deps);
    if (list !== undefined && list.length > TASK_SPEC_LIMITS.deps) return clientRefusal("deps_full");
    if (!readsBasis && !readsDeps) return client.amend(requestOf(draft, draft.basis));
    // oxlint-disable-next-line no-await-in-loop -- as above
    const basis = readsBasis ? await promptBasis(spec.prompt) : draft.basis;
    // oxlint-disable-next-line no-await-in-loop -- as above
    const deps = list === undefined ? undefined : { list, basis: await depsBasis(spec.deps) };
    // oxlint-disable-next-line no-await-in-loop -- as above
    reply = await client.amend(requestOf(draft, basis, deps));
    if (reply === null || "task" in reply) return reply;
    const moved = (readsBasis && reply.code === "prompt_changed") || (readsDeps && reply.code === "deps_changed");
    if (!moved) return reply;
  }
  return reply;
}

function requestOf(draft: AmendDraft, basis: string | undefined, deps?: AmendRequest["deps"]): AmendRequest {
  const { basis: _basis, deps: _change, ...rest } = draft;
  return {
    ...rest,
    ...(basis === undefined ? {} : { basis }),
    ...(deps === undefined ? {} : { deps }),
  };
}

/** Stands in for `basis` while a draft without one is checked by the leader's own parser. */
const NO_BASIS = "0".repeat(64);

/** Stands in for `deps` while a draft carrying a change is checked by the leader's own parser. */
const NO_DEPS = { list: [], basis: NO_BASIS } as const;

/**
 * A draft as the fleet broker takes it from a keyless peer: `parseAmendRequest`'s checks, with
 * `basis` optional beside `prompt` (the broker's daemon reads the task for it) and `deps` a change
 * (`parseDepsChange`), built afresh. Never `ownerTags`: the owner's labels come from the PWA alone (DESIGN.md, "Task
 * tags"), so the broker, MCP and the CLI refuse them here. A broker older than `amendDeps` refuses `deps` as an unknown
 * key, so a deps change never reaches a leader through one.
 */
export function parseAmendDraft(value: unknown): AmendDraft | null {
  if (!isRecord(value) || value["ownerTags"] !== undefined) return null;
  const change = value["deps"] === undefined ? undefined : parseDepsChange(value["deps"]);
  if (change === null) return null;
  const readsBasis = value["prompt"] !== undefined && value["basis"] === undefined;
  const parsed = parseAmendRequest({
    ...value,
    ...(change === undefined ? {} : { deps: NO_DEPS }),
    ...(readsBasis ? { basis: NO_BASIS } : {}),
  });
  if (parsed === null) return null;
  const { basis, deps: _deps, ...rest } = parsed;
  return {
    ...rest,
    ...(readsBasis || basis === undefined ? {} : { basis }),
    ...(change === undefined ? {} : { deps: change }),
  };
}

const DEPS_CHANGE_KEYS: ReadonlySet<string> = new Set(["add", "drop", "replace"]);

/**
 * A `DepsChange`, built afresh: `replace` alone (`[]` clears), or `add` and `drop` with at least one edge between
 * them, no task named twice, so none in both. Each edge is a create's (`parseDepList`).
 */
export function parseDepsChange(value: unknown): DepsChange | null {
  if (!isRecord(value) || !Object.keys(value).every((k) => DEPS_CHANGE_KEYS.has(k))) return null;
  const { add, drop, replace } = value;
  if (replace !== undefined) {
    if (add !== undefined || drop !== undefined) return null;
    const list = parseDepList(replace);
    return list === null ? null : { replace: list };
  }
  const added = add === undefined ? [] : parseDepList(add);
  const dropped = drop === undefined ? [] : parseDropList(drop);
  if (added === null || dropped === null || added.length + dropped.length === 0) return null;
  const named = [...added.map((d) => d.task), ...dropped];
  if (new Set(named).size !== named.length) return null;
  return {
    ...(added.length === 0 ? {} : { add: added }),
    ...(dropped.length === 0 ? {} : { drop: dropped }),
  };
}

function parseDropList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > TASK_SPEC_LIMITS.deps) return null;
  const ids: string[] = [];
  for (const id of value) {
    if (!isTaskId(id)) return null;
    ids.push(id);
  }
  return ids;
}
