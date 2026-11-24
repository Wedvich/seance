import { httpsUrl, isRecord, isRemoteSessionId } from "./parse.ts";
import {
  SESSION_TAG_ERROR_CODES,
  TASK_REQUEST_LIMITS,
  type LinearLink,
  type SessionTagRequest,
  type SessionTagResponse,
} from "./types.ts";

/**
 * Tags: one vocabulary for every writer and reader (DESIGN.md, "Tags and session identity"). A tag is a key in a writer's namespace and a
 * short printable value. The namespace is the access rule: the path a write arrives on decides it, so every write
 * carries bare suffixes (`writeTags`), and only what a writer builds itself, and every read-side view, holds full
 * keys. No tag binds, routes, places, settles, alerts, authorizes or moves anything ("What every tag is not"); the one exception, a
 * verified `agent.session` addressing adapter delivery, is the daemon's ("Adapters", "The subscription"), never a reader's of this module.
 */

/** A key's suffix, and an adapter's name (#486's pattern). */
export const TAG_SUFFIX_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const SUFFIX = TAG_SUFFIX_PATTERN;

/** The fixed namespaces; `adapter.<name>` is the one family besides them. */
export const TAG_NAMESPACES = ["agent", "seance", "self", "owner", "creator", "scheduler"] as const;
export type FixedTagNamespace = (typeof TAG_NAMESPACES)[number];
/** A fixed namespace or `adapter.<name>`. */
export type TagNamespace = FixedTagNamespace | `adapter.${string}`;

/** Where a tag is stored: a task's record, or the daemon's memory for a conversation or a `claude` process. */
export const TAG_SCOPES = ["task", "conversation", "process"] as const;
export type TagScope = (typeof TAG_SCOPES)[number];
/** The scopes a session's tags live at (daemon memory); a task's are in its record. */
export type SessionTagScope = Exclude<TagScope, "task">;

/** UTF-8 bytes of one value, cut on a code point boundary (#526's). */
export const TAG_VALUE_MAX = 256;
/** Keys per writer's namespace at session scope. */
export const TAGS_PER_WRITER_MAX = 4;
/** Keys over a session's process and conversation tags outside `adapter.*` (#526's). */
export const TAGS_PER_PANE_MAX = 16;
/** Keys per task record, budgeted per writer by `TASK_TAG_BUDGET` so one writer cannot starve another. */
export const TASK_TAGS_MAX = 6;
export const TASK_TAG_BUDGET = { creator: 3, owner: 2, scheduler: 1 } as const satisfies Partial<
  Record<FixedTagNamespace, number>
>;

/** Agents séance knows; an `agent.kind` value is one of them. */
export const AGENT_KINDS = ["claude", "codex"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Claude's conversation id is a lowercase UUID; Codex's thread id joins with its spike (docs/agents.md). */
const AGENT_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isAgentSessionId(value: unknown): value is string {
  return typeof value === "string" && AGENT_SESSION_ID.test(value);
}

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
}

const utf8 = new TextEncoder();

/** Control, format, surrogate and private-use characters, and line and paragraph separators. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

/**
 * The printable-text rule every tag value passes (#526's, moved here: one implementation): one line, each
 * unprintable character a space, whitespace runs one space, trimmed, then cut to `max` UTF-8 bytes on a code point
 * boundary. Empty means nothing printable was there.
 */
export function displayLine(text: string, max: number = TAG_VALUE_MAX): string {
  const flat = text.replace(UNPRINTABLE, " ").replaceAll(/\s+/gu, " ").trim();
  if (utf8.encode(flat).length <= max) return flat;
  let bytes = 0;
  let out = "";
  for (const char of flat) {
    const size = utf8.encode(char).length;
    if (bytes + size > max) break;
    bytes += size;
    out += char;
  }
  return out.trimEnd();
}

function isFixedNamespace(value: string): value is FixedTagNamespace {
  return (TAG_NAMESPACES as readonly string[]).includes(value);
}

/** A full key split at its last dot: `adapter.x.y` is namespace `adapter.x`, suffix `y`. Null for any other shape. */
export function splitTagKey(key: string): { readonly namespace: TagNamespace; readonly suffix: string } | null {
  const dot = key.lastIndexOf(".");
  if (dot <= 0) return null;
  const namespace = key.slice(0, dot);
  const suffix = key.slice(dot + 1);
  if (!SUFFIX.test(suffix)) return null;
  if (isFixedNamespace(namespace)) return { namespace, suffix };
  const adapter = /^adapter\.(.+)$/u.exec(namespace)?.[1];
  return adapter !== undefined && SUFFIX.test(adapter) ? { namespace: `adapter.${adapter}`, suffix } : null;
}

const refValue = (value: string): string | null => {
  const match = /^([a-z][a-z0-9-]{0,31}):([A-Za-z0-9._#/-]{1,64})$/u.exec(value);
  return match === null ? null : value;
};
const nameCap = (value: string): string | null =>
  Array.from(value).length <= TASK_REQUEST_LIMITS.title ? value : null;

/**
 * Known keys, each with its strict parser over a value already through `displayLine`: a value that fails is dropped
 * on a read and refused on a write. A namespace marked known-only here accepts no other suffix.
 */
const KNOWN: Readonly<Record<string, (value: string) => string | null>> = {
  "agent.kind": (value) => (isAgentKind(value) ? value : null),
  "agent.session": (value) => (isAgentSessionId(value) ? value : null),
  "agent.remote": (value) => (isRemoteSessionId(value) ? value : null),
  "self.doing": (value) => value,
  "self.name": nameCap,
  "owner.label": nameCap,
  "creator.ref": refValue,
  "creator.ref-url": (value) => httpsUrl(value),
};

/** Keys whose value is refused, not cut, past `TAG_VALUE_MAX`: a cut of the value is a different value. */
const REFUSED_PAST_CAP: ReadonlySet<string> = new Set(["creator.ref-url"]);

/** Namespaces that accept their known keys alone (`seance.*` and `scheduler.*` have none in v1: reserved). */
const KNOWN_ONLY: ReadonlySet<TagNamespace> = new Set(["agent", "seance", "self", "scheduler"]);

/** The scopes each namespace's keys live at; `agent.remote` is the process's (one bridge per process, "Three levels and the task"). */
function scopesOf(namespace: TagNamespace, suffix: string): readonly TagScope[] {
  switch (namespace) {
    case "agent":
      return suffix === "remote" ? ["process"] : ["conversation"];
    case "seance":
    case "self":
      return ["process"];
    case "owner":
      return ["conversation", "task"];
    case "creator":
    case "scheduler":
      return ["task"];
    default:
      return ["conversation"];
  }
}

export function isKnownTagKey(key: string): boolean {
  return Object.hasOwn(KNOWN, key);
}

/**
 * One value for a full key: the printable rule, the cap, then the key's own parser when it has one. Null when the key
 * is not one of `scope`'s, is unknown in a known-only namespace, or its value fails; `""` when nothing printable was
 * there (a write's clear).
 */
export function parseTagValue(key: string, raw: unknown, scope: TagScope): string | null {
  const split = splitTagKey(key);
  if (split === null || typeof raw !== "string") return null;
  if (!scopesOf(split.namespace, split.suffix).includes(scope)) return null;
  const known = Object.hasOwn(KNOWN, key) ? KNOWN[key] : undefined;
  if (known === undefined && KNOWN_ONLY.has(split.namespace)) return null;
  // A key whose parser rewrites the value (a URL's normalised `href`) is refused past the cap, never cut: a cut
  // URL opens another page, and the cut of a rewritten form is no fixed point of this parse.
  const value = displayLine(raw, REFUSED_PAST_CAP.has(key) ? Number.POSITIVE_INFINITY : TAG_VALUE_MAX);
  if (value === "") return "";
  if (known === undefined) return value;
  const parsed = known(value);
  return parsed !== null && utf8.encode(parsed).length > TAG_VALUE_MAX ? null : parsed;
}

export type TagWriteRefusal = "invalid" | "unknown_key" | "full";

/**
 * A writer's bare-suffix write into `namespace`, applied over what it already holds there (`current`, bare suffixes):
 * a `""` value clears its key. Refused, never partly applied: `invalid` for a key that is not a bare suffix (a full key
 * included: never re-homed) or a value that fails its parser, `unknown_key` for a suffix a known-only namespace does
 * not know, `full` past `TAGS_PER_WRITER_MAX`, or past a task writer's `TASK_TAG_BUDGET` at `scope: "task"`.
 */
export function writeTags(
  namespace: TagNamespace,
  bare: unknown,
  scope: TagScope,
  current: Readonly<Record<string, string>> = {},
):
  | { readonly ok: true; readonly tags: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly code: TagWriteRefusal } {
  if (!isRecord(bare)) return { ok: false, code: "invalid" };
  const next: Record<string, string> = { ...current };
  for (const [suffix, raw] of Object.entries(bare)) {
    if (!SUFFIX.test(suffix) || typeof raw !== "string") return { ok: false, code: "invalid" };
    const key = `${namespace}.${suffix}`;
    if (KNOWN_ONLY.has(namespace) && !Object.hasOwn(KNOWN, key)) return { ok: false, code: "unknown_key" };
    const value = parseTagValue(key, raw, scope);
    if (value === null) return { ok: false, code: "invalid" };
    if (value === "") delete next[suffix];
    else next[suffix] = value;
  }
  const budget = scope === "task" ? taskBudget(namespace) : TAGS_PER_WRITER_MAX;
  return Object.keys(next).length > budget ? { ok: false, code: "full" } : { ok: true, tags: next };
}

function taskBudget(namespace: TagNamespace): number {
  return namespace === "creator" || namespace === "owner" || namespace === "scheduler" ? TASK_TAG_BUDGET[namespace] : 0;
}

/**
 * Whether a session's tags fit: `TAGS_PER_PANE_MAX` over every key outside `adapter.*`, and `TAGS_PER_WRITER_MAX` per
 * namespace (each adapter its own). Full keys.
 */
export function sessionTagsFit(keys: readonly string[]): boolean {
  const per = new Map<string, number>();
  let outside = 0;
  for (const key of keys) {
    const split = splitTagKey(key);
    if (split === null) return false;
    per.set(split.namespace, (per.get(split.namespace) ?? 0) + 1);
    if (!split.namespace.startsWith("adapter.")) outside += 1;
  }
  return outside <= TAGS_PER_PANE_MAX && [...per.values()].every((count) => count <= TAGS_PER_WRITER_MAX);
}

/**
 * The keys another agent's context may see (MCP's `get_sessions` and `get_queue`, "Another agent's context"): by writer, and narrow. Never
 * `agent.session` (no reader needs another session's conversation id, and it only helps one claim another's), and
 * never a tag a session or a tool chose (`self.*`, `adapter.*`, an opaque `creator.*` suffix, `creator.ref-url`).
 */
export const AGENT_VISIBLE_TAG_KEYS: ReadonlySet<string> = new Set(["agent.kind", "creator.ref", "owner.label"]);

/** `tags` cut to `AGENT_VISIBLE_TAG_KEYS`; undefined when nothing is left. */
export function agentVisibleTags<T extends TagEntry>(
  tags: Readonly<Record<string, T>> | undefined,
): Readonly<Record<string, T>> | undefined {
  if (tags === undefined) return undefined;
  const kept = Object.entries(tags).filter(([key]) => AGENT_VISIBLE_TAG_KEYS.has(key));
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

/** One tag as a reader's map holds it. */
export interface TagEntry {
  readonly value: string;
  readonly at: number;
  readonly verified?: true;
}

/** A session tag as `SessionEntry.tags` carries it: #526's `{ value, at }` plus its scope. */
export interface SessionTag extends TagEntry {
  readonly scope: SessionTagScope;
}

/** A joined tag, from whichever scope holds it (`joinTags`). */
export interface JoinedTag extends TagEntry {
  readonly scope: TagScope;
}

/**
 * A tag map off the wire, full keys, at `scope` (`"session"`: a `SessionEntry.tags`, each entry carrying its own
 * scope). Strict in shape, lenient in membership: null for anything but a record, and a key it does not know, at a
 * scope its namespace does not live at, or whose value fails, is dropped, never the map, so a newer writer never breaks
 * an older reader. `known`: keep only the known keys (an allowlisted view).
 */
export function parseTags(
  raw: unknown,
  options: { readonly scope: "session"; readonly known?: boolean },
): Readonly<Record<string, SessionTag>> | null;
export function parseTags(
  raw: unknown,
  options: { readonly scope: TagScope; readonly known?: boolean },
): Readonly<Record<string, TagEntry>> | null;
export function parseTags(
  raw: unknown,
  options: { readonly scope: TagScope | "session"; readonly known?: boolean },
): Readonly<Record<string, TagEntry | SessionTag>> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, TagEntry | SessionTag> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (options.known === true && !isKnownTagKey(key)) continue;
    if (!isRecord(entry)) continue;
    const { value, at, verified, scope } = entry;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    let atScope: TagScope;
    if (options.scope === "session") {
      if (scope !== "conversation" && scope !== "process") continue;
      atScope = scope;
    } else atScope = options.scope;
    const parsed = parseTagValue(key, value, atScope);
    if (parsed === null || parsed === "") continue;
    // Only an `agent.session` is ever verified: the daemon's word that its own source names that conversation.
    const isVerified = verified === true && key === "agent.session";
    out[key] = {
      value: parsed,
      at,
      ...(isVerified ? { verified: true as const } : {}),
      ...(options.scope === "session" ? { scope: atScope } : {}),
    };
  }
  return out;
}

/**
 * The one place precedence lives (DESIGN.md, "Tags and session identity"): a task's, a conversation's and a process's tags, each a map of
 * full keys, as one view with each key's scope. A key lives at one scope by construction, bar `owner.label`, where the
 * task's wins over the conversation's; any other overlap goes the same way, task over conversation over process.
 */
export function joinTags(
  task?: Readonly<Record<string, TagEntry>> | null,
  conversation?: Readonly<Record<string, TagEntry>> | null,
  process?: Readonly<Record<string, TagEntry>> | null,
): Readonly<Record<string, JoinedTag>> {
  const out: Record<string, JoinedTag> = {};
  const layers: readonly [TagScope, Readonly<Record<string, TagEntry>> | null | undefined][] = [
    ["process", process],
    ["conversation", conversation],
    ["task", task],
  ];
  for (const [scope, tags] of layers) {
    for (const [key, entry] of Object.entries(tags ?? {})) out[key] = { ...entry, scope };
  }
  return out;
}

export type DisplayNameSource = "owner" | "task" | "self" | "window";

/**
 * A session's name (T2): `owner.label` > the task's title > `self.name` > the window name. Only the owner's own
 * surfaces and an adapter's `Session` use it, showing `source` when it is `self` or `window`; anything that puts a name
 * in another agent's context keeps the task's title or the window (`self.name` is session-chosen text).
 */
export function displayName(
  joined: Readonly<Record<string, JoinedTag>>,
  task: { readonly title?: string } | null | undefined,
  window: string,
): { readonly text: string; readonly source: DisplayNameSource } {
  const owner = joined["owner.label"]?.value;
  if (owner !== undefined) return { text: owner, source: "owner" };
  const title = task?.title === undefined ? "" : displayLine(task.title);
  if (title !== "") return { text: title, source: "task" };
  const self = joined["self.name"]?.value;
  if (self !== undefined) return { text: self, source: "self" };
  return { text: displayLine(window), source: "window" };
}

/** The namespaces a task's record holds, each with its own `TASK_TAG_BUDGET`. */
export const TASK_TAG_NAMESPACES = ["creator", "owner", "scheduler"] as const;
export type TaskTagNamespace = (typeof TASK_TAG_NAMESPACES)[number];

/** The two keys that name where a task came from: what the archivist keeps and what a spawn carries ("Task tags"). */
export const REF_TAG_KEYS = ["creator.ref", "creator.ref-url"] as const;

function isTaskNamespace(value: string): value is TaskTagNamespace {
  return (TASK_TAG_NAMESPACES as readonly string[]).includes(value);
}

function taskNamespaceOf(key: string): TaskTagNamespace | null {
  const namespace = splitTagKey(key)?.namespace;
  return namespace !== undefined && isTaskNamespace(namespace) ? namespace : null;
}

/**
 * A task record's tags off the wire (full keys): undefined when absent, null for a value that is no record, for more
 * than `TASK_TAGS_MAX` keys or for a namespace over its `TASK_TAG_BUDGET` (the spec nulls), otherwise each key in a
 * task namespace whose value passes `parseTagValue` at `task` scope. Anything else is dropped, never the map, so a
 * newer writer's key never breaks an older reader; undefined when nothing is left.
 */
export function parseTaskTags(raw: unknown): Readonly<Record<string, string>> | null | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > TASK_TAGS_MAX) return null;
  const kept: Record<string, string> = {};
  const per: Record<TaskTagNamespace, number> = { creator: 0, owner: 0, scheduler: 0 };
  for (const [key, value] of entries) {
    const namespace = taskNamespaceOf(key);
    if (namespace === null) continue;
    const parsed = parseTagValue(key, value, "task");
    if (parsed === null || parsed === "") continue;
    kept[key] = parsed;
    per[namespace] += 1;
  }
  if (TASK_TAG_NAMESPACES.some((namespace) => per[namespace] > TASK_TAG_BUDGET[namespace])) return null;
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/**
 * A creator's bare-suffix write (`writeTags` at task scope), as full `creator.<suffix>` keys: the one validator every
 * enqueue surface runs, so none spells the namespace or the bounds itself.
 */
export function creatorTaskTags(
  bare: unknown,
):
  | { readonly ok: true; readonly tags: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly code: TagWriteRefusal } {
  const written = writeTags("creator", bare, "task");
  if (!written.ok) return written;
  return {
    ok: true,
    tags: Object.fromEntries(Object.entries(written.tags).map(([suffix, value]) => [`creator.${suffix}`, value])),
  };
}

/** The bare map of a ref, for `creatorTaskTags`: surfaces never spell the suffixes. */
export function refTags(ref: string, url?: string): Readonly<Record<string, string>> {
  return url === undefined ? { ref } : { ref, "ref-url": url };
}

/**
 * A legacy `linear` as the `creator.*` tags that replace it (full keys), or null when the issue or its URL fails the
 * ref's rules: a writer then keeps writing `linear` ("Task tags").
 */
export function linearRefTags(linear: LinearLink): Readonly<Record<string, string>> | null {
  const written = creatorTaskTags(refTags(`linear:${linear.issue}`, linear.url));
  return written.ok ? written.tags : null;
}

/** The `owner.*` keys of a task's tags as bare suffixes (`writeTags`' `current`). */
export function ownerTagsOf(tags: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (key.startsWith("owner.")) out[key.slice("owner.".length)] = value;
  }
  return out;
}

/** `tags` with its `owner.*` keys replaced by `bareOwner`'s (bare suffixes); undefined when nothing is left. */
export function withOwnerTags(
  tags: Readonly<Record<string, string>> | undefined,
  bareOwner: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (!key.startsWith("owner.")) out[key] = value;
  }
  for (const [suffix, value] of Object.entries(bareOwner)) out[`owner.${suffix}`] = value;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The part of a task's tags a chain copies: one namespace's keys; undefined when it holds none. */
export function chainTags(
  tags: Readonly<Record<string, string>> | undefined,
  keep: "creator" | "owner",
): Readonly<Record<string, string>> | undefined {
  const kept = Object.entries(tags ?? {}).filter(([key]) => key.startsWith(`${keep}.`));
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

/**
 * A task's ref as a spawn carries it (`SpawnRequest.ref`): `creator.ref`, and `creator.ref-url` as `url` beside it;
 * undefined without a ref. Never a legacy `linear` (mapped at the join only, "The join and the name"), never another tag.
 */
export function taskRef(
  tags: Readonly<Record<string, string>> | undefined,
): { readonly ref: string; readonly url?: string } | undefined {
  const ref = tags?.["creator.ref"];
  if (ref === undefined) return undefined;
  const url = tags?.["creator.ref-url"];
  return url === undefined ? { ref } : { ref, url };
}

/**
 * A ref off the wire or a file (`SpawnRequest.ref`, a ledger note's `ref`), held to `creator.ref`'s and
 * `creator.ref-url`'s own rules: undefined for anything but a record with a valid `ref`, and a bad `url` drops alone.
 */
export function parseSpawnRef(raw: unknown): { readonly ref: string; readonly url?: string } | undefined {
  if (!isRecord(raw)) return undefined;
  const ref = parseTagValue("creator.ref", raw["ref"], "task");
  if (ref === null || ref === "") return undefined;
  const url = parseTagValue("creator.ref-url", raw["url"], "task");
  return url === null || url === "" ? { ref } : { ref, url };
}

/** A spec without its `tags`: what a client seals when the leader does not take them, and what `#reserve` compares. */
export function withoutTaskTags<T extends { readonly tags?: unknown }>(spec: T): Omit<T, "tags"> {
  const { tags: _tags, ...rest } = spec;
  return rest;
}

/**
 * A task's tags as the join's task layer: every entry of `spec.tags`, each at the task's creation time (a record holds
 * no per-key time, so an amended `owner.label` shows the task's age). A legacy `linear` with no `creator.ref` of its
 * own reads as `creator.ref` = `linear:<issue>` and, with a URL, `creator.ref-url`: mapped here only, never parsed
 * ("The join and the name") and never written back.
 */
export function taskTagEntries(
  spec: { readonly tags?: Readonly<Record<string, string>>; readonly linear?: LinearLink },
  at: number,
): Readonly<Record<string, TagEntry>> {
  const out: Record<string, TagEntry> = {};
  for (const [key, value] of Object.entries(spec.tags ?? {})) out[key] = { value, at };
  if (spec.linear === undefined || out["creator.ref"] !== undefined) return out;
  out["creator.ref"] = { value: `linear:${displayLine(spec.linear.issue)}`, at };
  if (spec.linear.url !== undefined) out["creator.ref-url"] = { value: spec.linear.url, at };
  return out;
}

/** A tmux pane id, as `SessionEntry.id` carries it. */
const PANE_ID = /^%\d{1,10}$/u;

const SESSION_TAG_FIELDS: ReadonlySet<string> = new Set(["pane", "session", "key", "value"]);

/**
 * `session-tag`, at the daemon (DESIGN.md, "Session identity", "The owner's label"): the pane, a conversation id, the bare suffix `label` (a full key,
 * or any other suffix, refuses the request: never re-homed) and a value through `owner.label`'s parser, `""` clearing
 * it. Null for anything else, an extra field included, and for a value too long to keep whole (never shortened).
 */
export function parseSessionTagRequest(value: unknown): SessionTagRequest | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((field) => !SESSION_TAG_FIELDS.has(field))) return null;
  const { pane, session, key, value: raw } = value;
  if (typeof pane !== "string" || !PANE_ID.test(pane) || !isAgentSessionId(session) || key !== "label") return null;
  const label = parseTagValue("owner.label", raw, "conversation");
  if (label === null) return null;
  // `displayLine` cuts at TAG_VALUE_MAX bytes, which would shorten a long multibyte name silently: refuse it instead.
  if (typeof raw === "string" && utf8.encode(displayLine(raw, Infinity)).length > TAG_VALUE_MAX) return null;
  return { pane, session, key, value: label };
}

/** A `session-tag` answer at a client: a code it does not know reads as a failure. */
export function parseSessionTagResponse(value: unknown): SessionTagResponse | null {
  if (!isRecord(value)) return null;
  if (value["ok"] === true) {
    const label = value["value"];
    return typeof label === "string" ? { ok: true, value: label } : null;
  }
  const code = SESSION_TAG_ERROR_CODES.find((c) => c === value["code"]);
  if (value["ok"] !== false || code === undefined || typeof value["message"] !== "string") return null;
  return { ok: false, code, message: value["message"] };
}
