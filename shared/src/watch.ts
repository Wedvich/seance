import { isMessageId } from "./messages.ts";
import { isRecord } from "./parse.ts";
import {
  PR_FAILING_LIMITS,
  WATCH_CONCLUSIONS,
  WATCH_EVENT_ERROR_CODES,
  WATCH_REFUSALS,
  WATCH_SUSPEND_REASONS,
  type WatchConclusion,
  type WatchEventBody,
  type WatchEventRequest,
  type WatchEventResponse,
  type WatchFailing,
  type WatchGeneration,
  type WatchRefusal,
} from "./types.ts";

/**
 * Fleet GitHub watches' shared half (docs/gh-watch.md; DESIGN.md, Scheduler, "PR status"): the one URL grammar for a
 * PR and a run, the event-key grammar, the bounds, and the parsers for `watch-set` (at the leader) and `watch-event`
 * (at the daemon, and its answer at the leader). Browser-safe: it imports nothing from Node and never logs, since the
 * PWA and Raycast load `shared/`. Every parser builds a fresh value field by field and checks its keys exactly.
 */

export interface GithubPr {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export interface GithubRun {
  readonly owner: string;
  readonly repo: string;
  /** A digit string: 20 digits exceed `Number.MAX_SAFE_INTEGER`. */
  readonly id: string;
}

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]{0,9})$/u;

/** GraphQL's `Int`: one variable past it fails the whole batch. */
const MAX_PR_NUMBER = 2_147_483_647;

/** The one URL shape read: anything else (another forge, `/files`, a fork's host) is skipped silently. */
export function parseGithubPr(url: string): GithubPr | null {
  const match = PR_URL.exec(url);
  if (match === null) return null;
  const [, owner, repo, digits] = match;
  const number = Number(digits);
  if (owner === undefined || repo === undefined || number > MAX_PR_NUMBER) return null;
  return { owner, repo, number };
}

const RUN_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/actions\/runs\/([1-9][0-9]{0,19})(?:\/attempts\/[1-9][0-9]{0,9})?$/u;

/** An Actions run's URL; the attempt is dropped, since the run query reads the latest one (docs/gh-watch.md W2). */
export function parseGithubRun(url: string): GithubRun | null {
  const match = RUN_URL.exec(url);
  if (match === null) return null;
  const [, owner, repo, id] = match;
  if (owner === undefined || repo === undefined || id === undefined) return null;
  return { owner, repo, id };
}

/** Rebuilt from parsed parts: the leader never forwards a session's own string. */
export function prUrlOf(pr: GithubPr): string {
  return `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
}

export function runUrlOf(run: GithubRun): string {
  return `https://github.com/${run.owner}/${run.repo}/actions/runs/${run.id}`;
}

export type WatchTarget =
  | { readonly kind: "pr"; readonly pr: GithubPr }
  | { readonly kind: "run"; readonly run: GithubRun };

/** Lowercased: GitHub names are case-insensitive. */
export function watchTargetKey(target: WatchTarget): string {
  return target.kind === "pr"
    ? `pr:${target.pr.owner}/${target.pr.repo}#${target.pr.number}`.toLowerCase()
    : `run:${target.run.owner}/${target.run.repo}/${target.run.id}`.toLowerCase();
}

/** The leader's per-device cap, equal to step 3's per-machine cap; a set's entries past it are refused `invalid`. */
export const WATCH_SET_MAX = 64;
/** A memory bound only: `parseWatchSet` nulls a set with more entries (the envelope bounds it lower). */
export const WATCH_SET_PARSE_MAX = 256;
/** Keys a watch carries as already delivered, so a new leader does not repeat them. */
export const WATCH_SEEN_MAX = 8;
export const WATCH_FAILING_MAX = 10;
/** The fleet-wide caps on distinct PRs and runs the leader polls. */
export const WATCH_FLEET_PRS = 100;
export const WATCH_FLEET_RUNS = 100;
/**
 * Bytes of a `watch-event` frame's JSON, UTF-8 encoded: under the envelope's ciphertext bound with the margin
 * `MESSAGE_ROUTE_MAX` keeps, and counted in the same unit.
 */
export const WATCH_EVENT_JSON_MAX = 40_000;

export const WATCH_PASSING_CONCLUSIONS = ["success", "neutral", "skipped"] as const;

const encoder = new TextEncoder();

/** UTF-8 bytes of `value`'s JSON: what the envelope carries, where `.length` counts UTF-16 code units and undercounts. */
export function watchJsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

const HEAD = "(?:[0-9a-f]{40}|[0-9a-f]{64})";
const WATCH_KEY = new RegExp(
  `^(?:checks:${HEAD}:(?:pass|fail)|conflict:${HEAD}|merged|closed|completed:[1-9][0-9]{0,9}|unreadable|suspended:(?:${WATCH_SUSPEND_REASONS.join("|")}))$`,
  "u",
);

export function isWatchKey(value: unknown): value is string {
  return typeof value === "string" && WATCH_KEY.test(value);
}

export function isWatchHead(value: unknown): value is string {
  return typeof value === "string" && new RegExp(`^${HEAD}$`, "u").test(value);
}

/** The key an event body carries: what a daemon's `seen` and a leader's acknowledgement remember it by. */
export function watchKeyOf(body: WatchEventBody): string {
  switch (body.kind) {
    case "checks":
      return `checks:${body.head}:${body.outcome}`;
    case "conflict":
      return `conflict:${body.head}`;
    case "completed":
      return `completed:${body.attempt}`;
    case "suspended":
      return `suspended:${body.reason}`;
    case "merged":
    case "closed":
    case "unreadable":
      return body.kind;
  }
}

/** A watch with one of these is done: nothing more can happen to its target. */
export function isTerminalKey(key: string): boolean {
  return key === "merged" || key === "closed" || key === "unreadable" || key.startsWith("completed:");
}

export interface ParsedWatch {
  readonly id: string;
  readonly target: WatchTarget;
  readonly head?: string;
  readonly seen: readonly string[];
}

export interface ParsedWatchSet {
  readonly gen: WatchGeneration;
  readonly watches: readonly ParsedWatch[];
  /** Ids of entries with a good id and a bad body: refused `invalid`, never nulling the set. */
  readonly invalid: readonly string[];
}

function parseGeneration(value: unknown): WatchGeneration | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((k) => k !== "boot" && k !== "n")) return null;
  const { boot, n } = value;
  if (!isMessageId(boot) || typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
  return { boot, n };
}

const ENTRY_KEYS: ReadonlySet<string> = new Set(["id", "kind", "url", "head", "seen"]);

function parseEntry(id: string, entry: Record<string, unknown>): ParsedWatch | null {
  if (Object.keys(entry).some((k) => !ENTRY_KEYS.has(k))) return null;
  const { kind, url, head, seen } = entry;
  if (typeof url !== "string") return null;
  if (!Array.isArray(seen) || seen.length > WATCH_SEEN_MAX) return null;
  const keys: string[] = [];
  for (const key of seen) {
    if (!isWatchKey(key)) return null;
    keys.push(key);
  }
  if (kind === "run") {
    if (head !== undefined) return null;
    const run = parseGithubRun(url);
    return run === null ? null : { id, target: { kind: "run", run }, seen: keys };
  }
  if (kind !== "pr") return null;
  if (head !== undefined && !isWatchHead(head)) return null;
  const pr = parseGithubPr(url);
  if (pr === null) return null;
  return { id, target: { kind: "pr", pr }, ...(head === undefined ? {} : { head }), seen: keys };
}

/**
 * `watch-set` at the leader. Null drops the whole frame: not a record, other keys, a bad `gen`, too many entries, an
 * entry with no usable id (it could not be refused) or a duplicate id. A good id with a bad body is `invalid` instead.
 */
export function parseWatchSet(value: unknown): ParsedWatchSet | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((k) => k !== "gen" && k !== "watches")) return null;
  const gen = parseGeneration(value["gen"]);
  const raw = value["watches"];
  if (gen === null || !Array.isArray(raw) || raw.length > WATCH_SET_PARSE_MAX) return null;
  const ids = new Set<string>();
  const watches: ParsedWatch[] = [];
  const invalid: string[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const id = entry["id"];
    if (!isMessageId(id) || ids.has(id)) return null;
    ids.add(id);
    const parsed = parseEntry(id, entry);
    if (parsed === null) invalid.push(id);
    else watches.push(parsed);
  }
  return { gen, watches, invalid };
}

const DIGITS_1_20 = /^[0-9]{1,20}$/u;

/** C0, DEL and C1: a check name is a repo's text, and it reaches a pane's inbox. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function parseFailing(value: unknown): readonly WatchFailing[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > WATCH_FAILING_MAX) return null;
  const out: WatchFailing[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    if (Object.keys(raw).some((k) => k !== "name" && k !== "required" && k !== "job")) return null;
    const { name, required, job } = raw;
    if (typeof name !== "string" || name === "" || name.length > PR_FAILING_LIMITS.length) return null;
    if (hasControl(name)) return null;
    if (required !== undefined && required !== true) return null;
    let jobOut: { readonly run: string; readonly job: string } | undefined;
    if (job !== undefined) {
      if (!isRecord(job) || Object.keys(job).some((k) => k !== "run" && k !== "job")) return null;
      const { run, job: jobId } = job;
      if (typeof run !== "string" || typeof jobId !== "string") return null;
      if (!DIGITS_1_20.test(run) || !DIGITS_1_20.test(jobId)) return null;
      jobOut = { run, job: jobId };
    }
    out.push({
      name,
      ...(required === true ? { required: true as const } : {}),
      ...(jobOut === undefined ? {} : { job: jobOut }),
    });
  }
  return out;
}

function isConclusion(value: unknown): value is WatchConclusion {
  return WATCH_CONCLUSIONS.some((c) => c === value);
}

function isPassing(conclusion: WatchConclusion): boolean {
  return WATCH_PASSING_CONCLUSIONS.some((c) => c === conclusion);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((k) => allowed.includes(k));
}

function parseBody(value: unknown): WatchEventBody | null {
  if (!isRecord(value)) return null;
  const { kind } = value;
  switch (kind) {
    case "checks": {
      if (!exactKeys(value, ["kind", "outcome", "head", "headMoved", "failing"])) return null;
      const { outcome, head, headMoved, failing } = value;
      if ((outcome !== "pass" && outcome !== "fail") || !isWatchHead(head)) return null;
      if (headMoved !== undefined && headMoved !== true) return null;
      if (failing !== undefined && outcome !== "fail") return null;
      const list = failing === undefined ? undefined : parseFailing(failing);
      if (list === null) return null;
      return {
        kind,
        outcome,
        head,
        ...(headMoved === true ? { headMoved: true as const } : {}),
        ...(list === undefined ? {} : { failing: list }),
      };
    }
    case "conflict": {
      if (!exactKeys(value, ["kind", "head", "headMoved"])) return null;
      const { head, headMoved } = value;
      if (!isWatchHead(head) || (headMoved !== undefined && headMoved !== true)) return null;
      return { kind, head, ...(headMoved === true ? { headMoved: true as const } : {}) };
    }
    case "merged": {
      if (!exactKeys(value, ["kind", "stacked"])) return null;
      const { stacked } = value;
      if (stacked !== undefined && stacked !== true) return null;
      return { kind, ...(stacked === true ? { stacked: true as const } : {}) };
    }
    case "closed":
    case "unreadable":
      return exactKeys(value, ["kind"]) ? { kind } : null;
    case "completed": {
      if (!exactKeys(value, ["kind", "attempt", "conclusion", "failing"])) return null;
      const { attempt, conclusion, failing } = value;
      if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) return null;
      if (!isConclusion(conclusion)) return null;
      if (failing !== undefined && isPassing(conclusion)) return null;
      const list = failing === undefined ? undefined : parseFailing(failing);
      if (list === null) return null;
      return { kind, attempt, conclusion, ...(list === undefined ? {} : { failing: list }) };
    }
    case "suspended": {
      if (!exactKeys(value, ["kind", "reason", "since", "resetAt"])) return null;
      const { reason, since, resetAt } = value;
      const why = WATCH_SUSPEND_REASONS.find((r) => r === reason);
      if (why === undefined || typeof since !== "number" || !Number.isSafeInteger(since) || since < 0) return null;
      if (resetAt !== undefined) {
        if (why !== "limited" && why !== "reserve") return null;
        if (typeof resetAt !== "number" || !Number.isSafeInteger(resetAt) || resetAt < 0) return null;
      }
      return { kind, reason: why, since, ...(resetAt === undefined ? {} : { resetAt }) };
    }
    default:
      return null;
  }
}

function parseRefusal(value: unknown): { readonly id: string; readonly code: WatchRefusal } | null {
  if (!isRecord(value) || Object.keys(value).some((k) => k !== "id" && k !== "code")) return null;
  const code = WATCH_REFUSALS.find((c) => c === value["code"]);
  const id = value["id"];
  return isMessageId(id) && code !== undefined ? { id, code } : null;
}

/** The sender's margin over `WATCH_EVENT_JSON_MAX`: the frame's own keys and the set answer are not counted by the fill. */
const WATCH_EVENT_MARGIN = 4096;

/** `watch-event` at the daemon. Bounded in bytes before any field is read. */
export function parseWatchEvent(value: unknown): WatchEventRequest | null {
  if (!isRecord(value)) return null;
  if (watchJsonBytes(value) > WATCH_EVENT_JSON_MAX + WATCH_EVENT_MARGIN) return null;
  if (Object.keys(value).some((k) => k !== "set" && k !== "events")) return null;
  const { set, events } = value;
  let setOut: WatchEventRequest["set"];
  if (set !== undefined) {
    if (!isRecord(set) || Object.keys(set).some((k) => k !== "gen" && k !== "refused")) return null;
    const gen = parseGeneration(set["gen"]);
    const rawRefused = set["refused"];
    if (gen === null || !Array.isArray(rawRefused) || rawRefused.length > WATCH_SET_PARSE_MAX) return null;
    const refused: { readonly id: string; readonly code: WatchRefusal }[] = [];
    for (const raw of rawRefused) {
      const one = parseRefusal(raw);
      if (one === null) return null;
      refused.push(one);
    }
    setOut = { gen, refused };
  }
  if (!Array.isArray(events)) return null;
  const out: WatchEventRequest["events"][number][] = [];
  for (const raw of events) {
    if (!isRecord(raw) || Object.keys(raw).some((k) => k !== "id" && k !== "key" && k !== "event")) return null;
    const { id, key } = raw;
    const event = parseBody(raw["event"]);
    if (!isMessageId(id) || event === null || key !== watchKeyOf(event)) return null;
    out.push({ id, key, event });
  }
  return { ...(setOut === undefined ? {} : { set: setOut }), events: out };
}

/** A `watch-event` answer at the leader: the ids the daemon placed, or a failure it words. */
export function parseWatchEventResponse(value: unknown): WatchEventResponse | null {
  if (!isRecord(value)) return null;
  if (value["ok"] === true) {
    const { delivered } = value;
    if (!Array.isArray(delivered) || delivered.length > WATCH_SET_PARSE_MAX) return null;
    const ids: string[] = [];
    for (const id of delivered) {
      if (!isMessageId(id)) return null;
      ids.push(id);
    }
    return { ok: true, delivered: ids };
  }
  const code = WATCH_EVENT_ERROR_CODES.find((c) => c === value["code"]);
  const { message } = value;
  if (value["ok"] !== false || code === undefined || typeof message !== "string") return null;
  return { ok: false, code, message };
}
