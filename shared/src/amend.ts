import { utf8Length } from "./successor.ts";
import { ownerTagsOf, withOwnerTags, writeTags } from "./tags.ts";
import {
  ATTACHMENT_LIMITS,
  SUCCESSOR_PROMPT_BYTES,
  TASK_REQUEST_LIMITS,
  type AmendRequest,
  type TaskSpec,
} from "./types.ts";

/**
 * Amending a waiting task (DESIGN.md, Scheduler, "Amending a waiting task"): what every client and
 * the leader agree on, so the prompt a client previews is the one the leader writes.
 */

const BASIS_PATTERN = /^[0-9a-f]{64}$/u;

/** `AmendRequest.basis`: SHA-256 of the prompt as UTF-8, lowercase hex. An absent prompt hashes as `""`. */
export async function promptBasis(prompt: string | undefined): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prompt ?? "")));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isPromptBasis(value: unknown): value is string {
  return typeof value === "string" && BASIS_PATTERN.test(value);
}

/** An append starts after a blank line, so the session reads it as a note of its own. */
export function appendToPrompt(prompt: string | undefined, text: string): string {
  return prompt === undefined || prompt === "" ? text : `${prompt}\n\n${text}`;
}

/**
 * The bound an amended prompt meets: a create's (`TASK_REQUEST_LIMITS.prompt`, or
 * `ATTACHMENT_LIMITS.prompt` beside attachments) in UTF-16 units, and `SUCCESSOR_PROMPT_BYTES` in UTF-8
 * bytes, the size a create is built for. The leader writes the amended record over the create, so a
 * prompt within both keeps the record within what the store took at enqueue.
 */
export function amendedPromptFits(prompt: string, spec: Pick<TaskSpec, "attachments">): boolean {
  const units = spec.attachments === undefined ? TASK_REQUEST_LIMITS.prompt : ATTACHMENT_LIMITS.prompt;
  return prompt.length <= units && utf8Length(prompt) <= SUCCESSOR_PROMPT_BYTES;
}

export type AmendRefusal = "prompt_too_long" | "append_only" | "tags_full";

/**
 * `spec` with `amend` applied, or why not. A successor's prompt is the leader's (its preamble resets
 * the branch), so it takes `append` only. Every other field is kept as it is, sentinel-bearing ones
 * included: the leader's write seals the spec through the one task sealer. `ownerTags` merge into the task's
 * `owner.*` keys alone (`""` clears one), refused `tags_full` past `TASK_TAG_BUDGET.owner`.
 */
export function amendSpec(spec: TaskSpec, amend: AmendRequest): TaskSpec | AmendRefusal {
  let prompt = spec.prompt;
  if (amend.prompt !== undefined) {
    if (amend.prompt.mode === "replace" && spec.succeeds !== undefined) return "append_only";
    prompt = amend.prompt.mode === "append" ? appendToPrompt(spec.prompt, amend.prompt.text) : amend.prompt.text;
    if (!amendedPromptFits(prompt, spec)) return "prompt_too_long";
  }
  const title = amend.title === undefined ? spec.title : (amend.title ?? undefined);
  const model = amend.model === undefined ? spec.model : (amend.model ?? undefined);
  const effort = amend.effort === undefined ? spec.effort : (amend.effort ?? undefined);
  const notBefore = amend.notBefore === undefined ? spec.notBefore : (amend.notBefore ?? undefined);
  let tags = spec.tags;
  if (amend.ownerTags !== undefined) {
    const owner = writeTags("owner", amend.ownerTags, "task", ownerTagsOf(spec.tags));
    // `parseAmendRequest` held the map to the same rules, so only the budget can refuse here.
    if (!owner.ok) return "tags_full";
    tags = withOwnerTags(spec.tags, owner.tags);
  }
  const {
    prompt: _prompt,
    title: _title,
    model: _model,
    effort: _effort,
    notBefore: _notBefore,
    tags: _tags,
    ...rest
  } = spec;
  return {
    ...rest,
    ...(tags === undefined ? {} : { tags }),
    ...(prompt === undefined || prompt === "" ? {} : { prompt }),
    ...(title === undefined ? {} : { title }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(notBefore === undefined ? {} : { notBefore }),
  };
}

/** The fields an amendment names, for an audit line: names only, never a value. */
export function amendedFields(amend: AmendRequest): readonly string[] {
  return (["prompt", "title", "model", "effort", "notBefore", "ownerTags"] as const).filter(
    (f) => amend[f] !== undefined,
  );
}
