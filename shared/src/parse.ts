import { REPLAY_WINDOW_MS } from "./crypto.ts";
import {
  ACCOUNT_ALIAS_MAX_LENGTH,
  BRANCH_MAX_LENGTH,
  CANDIDATE_MAX_REASONS,
  DECISION_MAX_CANDIDATES,
  DEP_AFTER,
  DONE_SIGNALS,
  EXIT_STATUS_MAX,
  FLEET_QUOTA_MAX_ACCOUNTS,
  FLEET_QUOTA_MAX_WINDOWS,
  FLEET_QUOTA_WINDOW_MODEL_MAX_LENGTH,
  LINEAR_KEY_MAX_LENGTH,
  MAX_PAUSE_HOLDS,
  MAX_TASKS,
  PAUSE_UNTIL,
  PR_CHECKS,
  PR_STATES,
  PUSH_ENDPOINT_MAX_LENGTH,
  PUSH_MAX_SUBSCRIPTIONS,
  PUSH_SERVICE_HOSTS,
  REPO_MAX_SKILLS,
  SKILL_NAME_MAX_LENGTH,
  STATUS_MAX_AUTH_EXPIRED,
  TASK_UNTIL,
  QUEUE_MAX_TASKS,
  ROUTING_ID_MAX_LENGTH,
  ROUTING_ID_PATTERN,
  SESSIONS_MAX_PROGRESS,
  SIGKILL_STATUS,
  STORE_KEY_PATTERN,
  STORE_PREFIXES,
  TARGET_LIMITS,
  TASK_FAILURE_LIMITS,
  TASK_SPEC_LIMITS,
  type AccountRecord,
  type BatchMembership,
  type BatchStrategy,
  type FleetQuotaEntry,
  type FleetQuotaRecord,
  type PushSubscribeReply,
  type PushSubscribeRequest,
  type QuotaReading,
  type SettingsRecord,
  type VapidKeys,
  type WebPushSubscription,
  type BranchState,
  type DiscardReply,
  type DiscardRequest,
  type LeadProof,
  type LinearLink,
  type PauseHold,
  type PauseRecord,
  type PauseReply,
  type PauseRequest,
  type PrStatus,
  type Placement,
  type QueueChanged,
  type QueueRequest,
  type RecordUnreadable,
  type ResumeRequest,
  type StoreChangedFrame,
  type StoreRecord,
  type StoreReplyFrame,
  type TaskDep,
  type TaskProgress,
  type TaskRecord,
  type TaskRef,
  type TaskReply,
  type TaskSpec,
  type UnreadableTaskRef,
  METRICS_ERROR_CODES,
  METRICS_MAX_FILTER_LENGTH,
  METRICS_MAX_FILTERS,
  METRICS_MAX_POINTS,
  METRICS_STEPS,
  QUOTA_SOURCES,
  SCHEDULER_OPS,
  SESSION_STATES,
  SPAWN_ERROR_CODES,
  TASK_ID_PATTERN,
  TASK_REQUEST_LIMITS,
  TASK_STATES,
  UPDATE_OUTCOMES,
  type Assignment,
  type Candidate,
  type Decision,
  type QueueReply,
  type QuotaBasis,
  type Reason,
  type Reservation,
  type RoutePreviewReply,
  type SchedulerError,
  type SchedulerOp,
  type Score,
  type Target,
  type Task,
  type TaskRequest,
  type Envelope,
  type ExclaveInfo,
  type MachineInfo,
  type MachineStatus,
  type MetricsReply,
  type MetricsRequest,
  type MetricsResponse,
  type MetricsSeries,
  type QuotaObservation,
  type RepoEntry,
  type RescanResponse,
  type ScopedWindow,
  type SessionEvent,
  type SessionState,
  type SpawnErrorCode,
  type SourceInfo,
  type UpdateReport,
} from "./types.ts";

/**
 * The one home for wire-shape checks every tier shares. The relay layers its
 * bounds on top (`relay/src/wire.ts`); the app-role client and the Raycast
 * cache consume these directly. One copy, so a field added to a type cannot be
 * missed by whichever hand-written duplicate a session forgot existed.
 */

/** Arrays are records to `typeof`; every shape below is a keyed object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape only — the PSK, not this, decides authenticity, and the relay never
 * opens an envelope anyway. `v`'s value is never checked: forwarding unknown
 * versions lets the protocol move without a relay deploy, and the endpoints
 * reject what they can't open.
 */
export function parseEnvelope(value: unknown): Envelope | null {
  if (!isRecord(value)) return null;
  if (typeof value["v"] !== "number") return null;
  if (typeof value["to"] !== "string" || typeof value["from"] !== "string") return null;
  if (typeof value["iv"] !== "string" || typeof value["ct"] !== "string") return null;
  return { v: value["v"], to: value["to"], from: value["from"], iv: value["iv"], ct: value["ct"] };
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/**
 * Wire integers are counts, percents and unix seconds — never negative, never
 * fractional, and exact: `Number.isInteger` alone accepts `1e308`, which no
 * counter reaches and on which arithmetic (`at * 1000`, a span) stops being exact.
 */
function isUint(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalUint(value: unknown): value is number | undefined {
  return value === undefined || isUint(value);
}

/**
 * A scheduler term: a counter only the relay mints, so anything but a safe
 * non-negative integer is malformed. One copy for every tier that reads one —
 * `msg.term`, `lead.term`, the registry push's `scheduler.term`.
 */
export function isTerm(value: unknown): value is number {
  return isUint(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** A fresh copy, never the caller's array: a parsed value must not alias its input. */
function parseUintList(value: unknown): readonly number[] | null {
  return Array.isArray(value) && value.every(isUint) ? [...value] : null;
}

/**
 * All or nothing: one unreadable element nulls the list rather than silently
 * shortening it. Every list below is either picked from (a repo missing is
 * worse than a machine unavailable) or indexed into (`MachineStatus` → `exclaves`,
 * where a gap shifts every account's quota onto its neighbour).
 */
function parseList<T>(value: unknown, parse: (candidate: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const candidate of value) {
    const item = parse(candidate);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

function parseLabels(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value)) return null;
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value)) {
    if (typeof label !== "string") return null;
    labels[key] = label;
  }
  return labels;
}

export function parseRepoEntry(value: unknown): RepoEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value["name"] !== "string" || typeof value["path"] !== "string") return null;
  const defaultBranch = value["defaultBranch"];
  if (defaultBranch !== null && typeof defaultBranch !== "string") return null;
  const exclave = value["exclave"];
  const origin = value["origin"];
  if (!isOptionalString(exclave) || !isOptionalString(origin)) return null;
  // Both are keys: an empty exclave matches no `ExclaveInfo.id` (which refuses
  // ""), and an empty origin would collide every remote-less repo across machines.
  if (exclave === "" || origin === "") return null;
  const skills = parseRepoSkills(value["skills"]);
  return {
    name: value["name"],
    path: value["path"],
    defaultBranch,
    ...(exclave === undefined ? {} : { exclave }),
    ...(origin === undefined ? {} : { origin }),
    ...(skills === undefined ? {} : { skills }),
  };
}

/**
 * Lenient, unlike the clone's own fields: a clone that fails nulls the whole
 * register blob, so a list this build cannot read costs the clone's project
 * skills — read as none, which the filter rejects when the name is known — never the machine.
 */
function parseRepoSkills(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > REPO_MAX_SKILLS || !value.every(isSkillName)) return undefined;
  return [...value];
}

/**
 * A skill name as a declaration or an inventory may carry it: what a directory
 * entry the scan lists (no `/`, no leading `.`) and a prompt's `/name` token (no
 * whitespace) can both be, under `SKILL_NAME_MAX_LENGTH`. `ExclaveInfo.skills`
 * stays a plain string list: tightening it would cost a machine its exclaves
 * over one odd directory name.
 */
export function isSkillName(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.length > SKILL_NAME_MAX_LENGTH) return false;
  if (value.startsWith(".") || value.includes("/")) return false;
  return ![...value].some((ch) => isControl(ch) || SKILL_FORBIDDEN.has(ch) || /\s/u.test(ch));
}

/** Path separators and glob/shell metacharacters; `:` stays, as plugin skills are `plugin:name`. */
const SKILL_FORBIDDEN = new Set(["\\", "*", "?", '"', "<", ">", "|"]);

/** C0, DEL and C1 controls (U+0080-U+009F, which `\s` only partly covers). */
function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** Characters `git check-ref-format` refuses anywhere in a ref, beside controls and space. */
const REF_FORBIDDEN = new Set(["~", "^", ":", "?", "*", "[", "\\", " "]);

/**
 * A branch name git would take, by `git check-ref-format` on `refs/heads/<name>`
 * (decided #15): no control character, space or any of `~^:?*[\`; no `..`,
 * `@{` or empty component (so no leading, trailing or doubled `/`); no
 * component starting `.` or ending `.lock`; not ending `.`; not `@`. Plus what
 * `--branch` refuses — a leading `-`, which would read as an option, and `HEAD`.
 * Bounded by `BRANCH_MAX_LENGTH` UTF-8 bytes, since git stores a loose ref as a
 * file and limits it by filename bytes, not UTF-16 units. The one copy, for every hop that hands a branch
 * to git: the leader, on the predecessor's `Task.branch` before it sends one
 * (decided #4: the base is that branch, never one an app names), and the daemon
 * on `SpawnRequest.baseBranch`.
 */
export function isBranchName(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || new TextEncoder().encode(value).length > BRANCH_MAX_LENGTH) {
    return false;
  }
  if (value === "@" || value === "HEAD" || value.startsWith("-") || value.endsWith(".")) return false;
  if (value.includes("..") || value.includes("@{")) return false;
  if ([...value].some((ch) => isControl(ch) || REF_FORBIDDEN.has(ch))) return false;
  return value.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function parseExclaveInfo(value: unknown): ExclaveInfo | null {
  if (!isRecord(value)) return null;
  if (typeof value["id"] !== "string" || value["id"] === "") return null;
  const accountId = value["accountId"];
  if (accountId !== null && typeof accountId !== "string") return null;
  const email = value["email"];
  if (!isOptionalString(email)) return null;
  const extraUsageEnabled = value["extraUsageEnabled"];
  if (extraUsageEnabled !== null && typeof extraUsageEnabled !== "boolean") return null;
  const seatTier = value["seatTier"];
  if (!isOptionalString(seatTier)) return null;
  if (typeof value["authOk"] !== "boolean") return null;
  const skills = value["skills"];
  if (!isStringArray(skills)) return null;
  return {
    id: value["id"],
    accountId,
    ...(email === undefined || email === "" ? {} : { email }),
    extraUsageEnabled,
    ...(seatTier === undefined || seatTier === "" ? {} : { seatTier }),
    authOk: value["authOk"],
    skills,
  };
}

export function parseExclaveList(value: unknown): readonly ExclaveInfo[] | null {
  return parseList(value, parseExclaveInfo);
}

export function parseRepoList(value: unknown): readonly RepoEntry[] | null {
  return parseList(value, parseRepoEntry);
}

/** The largest instant a `Date` holds; past it `toISOString()` throws, which would fail a reader's whole reply. */
const MAX_DATE_MS = 8.64e15;

/** Raw git/bun stderr rides `detail`; the outcome code carries the meaning, so a long one is cut, not refused. */
export const UPDATE_DETAIL_MAX = 200;

function isDateMs(value: unknown): value is number {
  return isUint(value) && value <= MAX_DATE_MS;
}

/** A daemon checkout's git identity, as `readSource` produces it. */
export function parseSourceInfo(value: unknown): SourceInfo | null {
  if (!isRecord(value)) return null;
  const { sha, commitTs, branch } = value;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/u.test(sha) || !isDateMs(commitTs)) return null;
  if (branch !== null && typeof branch !== "string") return null;
  return { sha, commitTs, branch };
}

export function parseUpdateReport(value: unknown): UpdateReport | null {
  if (!isRecord(value)) return null;
  const { at, outcome, detail } = value;
  if (!isDateMs(at) || !isOptionalString(detail)) return null;
  const known = UPDATE_OUTCOMES.find((candidate) => candidate === outcome);
  if (known === undefined) return null;
  return { at, outcome: known, ...(detail === undefined ? {} : { detail: detail.slice(0, UPDATE_DETAIL_MAX) }) };
}

/**
 * The decrypted register blob. Inside the PSK boundary, so this is skew
 * tolerance rather than defence: a daemon a version ahead or behind must cost
 * one machine tile, not the render — `machine.repos.map(…)` runs on every frame
 * of the spawn screen. A projection of the fields the app reads.
 */
export function parseMachineInfo(value: unknown): MachineInfo | null {
  if (!isRecord(value)) return null;
  if (typeof value["name"] !== "string" || typeof value["platform"] !== "string") return null;
  if (typeof value["scannedAt"] !== "number") return null;
  const repos = parseRepoList(value["repos"]);
  if (repos === null) return null;
  // All optional and skew-tolerant in the other direction from `repos`: a
  // malformed exclave list costs the exclaves (the machine reads as an old
  // daemon, ineligible for `auto`), never the tile; a malformed build or update
  // report costs that line. Unknown capability strings pass through — a reader
  // asks for the ones it knows.
  const exclaves = value["exclaves"] === undefined ? undefined : parseExclaveList(value["exclaves"]);
  const capabilities = value["capabilities"];
  const source = parseSourceInfo(value["source"]);
  const lastUpdate = parseUpdateReport(value["lastUpdate"]);
  return {
    name: value["name"],
    platform: value["platform"],
    repos,
    scannedAt: value["scannedAt"],
    ...(exclaves === undefined || exclaves === null ? {} : { exclaves }),
    ...(isStringArray(capabilities) ? { capabilities } : {}),
    ...(source === null ? {} : { source }),
    ...(lastUpdate === null ? {} : { lastUpdate }),
  };
}

function isQuotaSource(value: unknown): value is QuotaObservation["s"] {
  return QUOTA_SOURCES.some((source) => source === value);
}

function parseScopedWindow(value: unknown): ScopedWindow | null {
  if (!isRecord(value)) return null;
  if (typeof value["m"] !== "string" || value["m"] === "" || !isUint(value["p"])) return null;
  const r = value["r"];
  if (!isOptionalUint(r)) return null;
  return { m: value["m"], p: value["p"], ...(r === undefined ? {} : { r }) };
}

/** A quota observation without its exclave index. */
export function parseQuotaReading(value: unknown): QuotaReading | null {
  if (!isRecord(value)) return null;
  if (!isUint(value["at"]) || !isQuotaSource(value["s"])) return null;
  const { h, d, hr, dr, c } = value;
  if (!isOptionalUint(h) || !isOptionalUint(d) || !isOptionalUint(hr) || !isOptionalUint(dr)) return null;
  if (!isOptionalUint(c)) return null;
  const credits = parseCreditAmounts(value);
  if (credits === null || (c === undefined && credits.cu !== undefined)) return null;
  const w = value["w"] === undefined ? undefined : parseList(value["w"], parseScopedWindow);
  if (w === null) return null;
  return {
    s: value["s"],
    at: value["at"],
    ...(h === undefined ? {} : { h }),
    ...(d === undefined ? {} : { d }),
    ...(hr === undefined ? {} : { hr }),
    ...(dr === undefined ? {} : { dr }),
    ...(w === undefined ? {} : { w }),
    ...(c === undefined ? {} : { c }),
    ...credits,
  };
}

/** `cu` and `cl` together or not at all: spent without its cap reads as nothing. */
function parseCreditAmounts(value: Record<string, unknown>): Pick<QuotaObservation, "cu" | "cl"> | null {
  const { cu, cl } = value;
  if (cu === undefined && cl === undefined) return {};
  if (!isUint(cu) || !isUint(cl)) return null;
  return { cu, cl };
}

function parseQuotaObservation(value: unknown): QuotaObservation | null {
  if (!isRecord(value) || !isUint(value["x"])) return null;
  const reading = parseQuotaReading(value);
  return reading === null ? null : { x: value["x"], ...reading };
}

/**
 * The decrypted `status` blob. Strict where `parseMachineInfo` is lenient: a
 * status is regenerated every tick and renders nothing on its own, so one bad
 * field costs one tick rather than a half-read snapshot.
 */
export function parseMachineStatus(value: unknown): MachineStatus | null {
  if (!isRecord(value)) return null;
  if (!isUint(value["at"]) || !isUint(value["scan"])) return null;
  const { cpu, mem, disk, free, rd, wr } = value;
  if (!isOptionalUint(cpu) || !isOptionalUint(mem) || !isOptionalUint(disk)) return null;
  if (!isOptionalUint(free) || !isOptionalUint(rd) || !isOptionalUint(wr)) return null;
  const sess = value["sess"] === undefined ? undefined : parseUintList(value["sess"]);
  if (sess === null) return null;
  const quota = value["quota"] === undefined ? undefined : parseList(value["quota"], parseQuotaObservation);
  if (quota === null) return null;
  const { tr } = value;
  if (!isOptionalUint(tr)) return null;
  const ax = value["ax"] === undefined ? undefined : parseUintList(value["ax"]);
  if (ax === null || (ax !== undefined && (ax.length > STATUS_MAX_AUTH_EXPIRED || new Set(ax).size !== ax.length))) {
    return null;
  }
  return {
    at: value["at"],
    scan: value["scan"],
    ...(cpu === undefined ? {} : { cpu }),
    ...(mem === undefined ? {} : { mem }),
    ...(disk === undefined ? {} : { disk }),
    ...(free === undefined ? {} : { free }),
    ...(rd === undefined ? {} : { rd }),
    ...(wr === undefined ? {} : { wr }),
    ...(sess === undefined ? {} : { sess }),
    ...(quota === undefined ? {} : { quota }),
    ...(tr === undefined ? {} : { tr }),
    ...(ax === undefined ? {} : { ax }),
  };
}

/**
 * Request shape for the daemon's `metrics` handler, span included: a range of
 * more than `METRICS_MAX_POINTS` per series is refused before the store reads
 * a row. An empty `names` asks for nothing, so it is malformed, not a filter.
 */
export function isMetricsRequest(value: unknown): value is MetricsRequest {
  if (!isRecord(value)) return false;
  const { from, to, step, names, labels } = value;
  if (!isUint(from) || !isUint(to) || from > to) return false;
  const known = METRICS_STEPS.find((s) => s === step);
  if (known === undefined || (to - from) / known + 1 > METRICS_MAX_POINTS) return false;
  if (names !== undefined && !isMetricNames(names)) return false;
  return labels === undefined || isLabelMatchers(labels);
}

function isMetricNames(value: unknown): boolean {
  if (!isStringArray(value) || value.length === 0 || value.length > METRICS_MAX_FILTERS) return false;
  return value.every((name) => name !== "" && name.length <= METRICS_MAX_FILTER_LENGTH);
}

function isLabelMatchers(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > METRICS_MAX_FILTERS) return false;
  return entries.every(
    ([name, wanted]) =>
      name !== "" &&
      name.length <= METRICS_MAX_FILTER_LENGTH &&
      typeof wanted === "string" &&
      wanted.length <= METRICS_MAX_FILTER_LENGTH,
  );
}

/** `Number.isFinite`, not `typeof`: JSON can't carry NaN/Infinity, but in-process callers can. */
function isPoint(value: unknown): value is readonly [number, number] {
  return Array.isArray(value) && value.length === 2 && isUint(value[0]) && Number.isFinite(value[1]);
}

function parseMetricsSeries(value: unknown): MetricsSeries | null {
  if (!isRecord(value)) return null;
  if (typeof value["metric"] !== "string" || value["metric"] === "") return null;
  const labels = parseLabels(value["labels"]);
  if (labels === null) return null;
  const points = value["points"];
  if (!Array.isArray(points) || !points.every(isPoint)) return null;
  return { metric: value["metric"], labels, points };
}

/** A `metrics` reply lands on a chart, so a daemon a version ahead must cost the chart, not the app. */
export function parseMetricsResponse(value: unknown): MetricsResponse | null {
  if (!isRecord(value)) return null;
  const series = parseList(value["series"], parseMetricsSeries);
  return series === null ? null : { series };
}

/** Either the history or the daemon's structured refusal; `too_large` is the one a chart acts on. */
export function parseMetricsReply(value: unknown): MetricsReply | null {
  if (!isRecord(value) || value["ok"] !== false) return parseMetricsResponse(value);
  const code = METRICS_ERROR_CODES.find((c) => c === value["code"]);
  if (code === undefined || typeof value["message"] !== "string") return null;
  return { ok: false, code, message: value["message"] };
}

/**
 * A `rescan` reply is the same repo walk as the register blob, and the same
 * skew story: the fields land on `machine.repos`/`scannedAt` and render every
 * frame, so an unchecked reply from a daemon a version ahead is the register
 * wedge by another door.
 */
export function parseRescanResponse(value: unknown): RescanResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value["scannedAt"] !== "number") return null;
  const repos = parseRepoList(value["repos"]);
  if (repos === null) return null;
  return { repos, scannedAt: value["scannedAt"] };
}

export function isTaskId(value: unknown): value is string {
  return typeof value === "string" && TASK_ID_PATTERN.test(value);
}

export function isSessionState(value: unknown): value is SessionState {
  return SESSION_STATES.some((state) => state === value);
}

/** A PR URL is kept only under this length; past it, it is no URL anyone typed. */
export const PR_URL_MAX_LENGTH = 2048;

/**
 * A PR URL as something the PWA may render as an `href` and a push may carry:
 * `https:` only, and no credentials in it. Null for anything else, so a
 * `javascript:` or `http:` value is dropped, never echoed. Returns the parsed
 * form, not the input, so what goes on is what was checked.
 */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > PR_URL_MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  return url.href;
}

/**
 * Remote Control's session id as Claude Code mints it (`session_` then base62).
 * The PWA splices it into a claude.ai path, so nothing but that alphabet passes:
 * no `/`, `?`, `#` or `..` can reach the URL.
 */
const REMOTE_SESSION_ID = /^session_[0-9A-Za-z]{1,64}$/u;

export function isRemoteSessionId(value: unknown): value is string {
  return typeof value === "string" && REMOTE_SESSION_ID.test(value);
}

/**
 * The leader's check on a forwarded event. The sender is a PSK holder, so this
 * is skew and bug hygiene rather than a trust boundary — the daemon already
 * bound the event to its pane — but a `prUrl` and a `remoteSession` are
 * re-checked all the same: they are the fields that reach an `href`. A bad
 * `remoteSession` is dropped rather than the event: a link is not worth losing
 * the state it rode with.
 */
export function parseSessionEvent(value: unknown): SessionEvent | null {
  if (!isRecord(value)) return null;
  const { session, taskId, exclave, state, prUrl, remoteSession, at } = value;
  if (typeof session !== "string" || session === "" || session.length > ROUTING_ID_MAX_LENGTH) return null;
  if (!isTaskId(taskId) || typeof exclave !== "string" || exclave.length > ROUTING_ID_MAX_LENGTH) return null;
  if (!isSessionState(state) || typeof at !== "number" || !Number.isFinite(at)) return null;
  const url = prUrl === undefined ? null : httpsUrl(prUrl);
  if (prUrl !== undefined && url === null) return null;
  return {
    session,
    taskId,
    exclave,
    state,
    at,
    ...(url === null ? {} : { prUrl: url }),
    ...(isRemoteSessionId(remoteSession) ? { remoteSession } : {}),
  };
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

/**
 * The leader's check on what an app asks it to route. The leader is a PSK
 * holder that acts on this — it reserves, holds the task, and spawns from it on
 * another machine — so every field is checked and bounded, and the result is
 * built field by field: nothing the request carries beyond these reaches a
 * task. Null for anything malformed or past `TASK_REQUEST_LIMITS`.
 */
export function parseTaskRequest(value: unknown): TaskRequest | null {
  if (!isRecord(value)) return null;
  const { repo, mode, prompt, title, model, effort, plan, skill } = value;
  const limits = TASK_REQUEST_LIMITS;
  if (!isBoundedString(repo, limits.repo) || repo === "") return null;
  if (mode !== "worktree" && mode !== "here") return null;
  if (prompt !== undefined && !isBoundedString(prompt, limits.prompt)) return null;
  if (title !== undefined && !isBoundedString(title, limits.title)) return null;
  // Empty would reach the spawn as a flag with no value; absent is how a default is asked for.
  if (model !== undefined && (!isBoundedString(model, limits.model) || model === "")) return null;
  if (effort !== undefined && (!isBoundedString(effort, limits.effort) || effort === "")) return null;
  if (plan !== undefined && typeof plan !== "boolean") return null;
  if (skill !== undefined && !isSkillName(skill)) return null;
  return {
    repo,
    mode,
    ...(prompt === undefined ? {} : { prompt }),
    ...(title === undefined ? {} : { title }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(plan === undefined ? {} : { plan }),
    ...(skill === undefined ? {} : { skill }),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A machine or exclave name as a spec carries it: a key, so non-empty. */
function isPlacementField(value: unknown): value is string {
  return isBoundedString(value, TASK_SPEC_LIMITS.placement) && value !== "";
}

function parsePlacement(value: unknown): Placement | null {
  if (!isRecord(value)) return null;
  const { deviceId, exclave } = value;
  return isRoutingId(deviceId) && isPlacementField(exclave) ? { deviceId, exclave } : null;
}

/**
 * Undefined for a pin with nothing left to restrict. `exclave` is read by no
 * one: an older record's exclave pin is dropped (exclave pins are gone), and
 * `PIN_SENTINEL` is there only for older leaders to refuse.
 */
function parsePin(value: unknown): TaskSpec["pin"] | null | undefined {
  if (!isRecord(value)) return null;
  const { deviceId, account } = value;
  if (deviceId !== undefined && !isRoutingId(deviceId)) return null;
  if (account !== undefined && !isAccountId(account)) return null;
  if (deviceId === undefined && account === undefined) return undefined;
  return { ...(deviceId === undefined ? {} : { deviceId }), ...(account === undefined ? {} : { account }) };
}

function parseAvoid(value: unknown): readonly string[] | null {
  const ids = parseList(value, (id) => (isRoutingId(id) ? id : null));
  if (ids === null || ids.length > TASK_SPEC_LIMITS.avoid || new Set(ids).size !== ids.length) return null;
  return ids;
}

export function parseBatchStrategy(value: unknown): BatchStrategy | null {
  if (!isRecord(value)) return null;
  const { mode, max } = value;
  if (mode === "sequential" || mode === "auto") return { mode };
  if (mode !== "parallel" || !isUint(max) || max < 1 || max > TASK_SPEC_LIMITS.parallel) return null;
  return { mode, max };
}

function parseBatch(value: unknown): BatchMembership | null {
  if (!isRecord(value)) return null;
  const { id, index } = value;
  const strategy = parseBatchStrategy(value["strategy"]);
  if (!isTaskId(id) || !isUint(index) || index > TASK_SPEC_LIMITS.batchIndex || strategy === null) return null;
  return { id, index, strategy };
}

function parseDep(value: unknown): TaskDep | null {
  if (!isRecord(value) || !isTaskId(value["task"])) return null;
  const after = DEP_AFTER.find((a) => a === value["after"]);
  return after === undefined ? null : { task: value["task"], after };
}

function parseLinear(value: unknown): LinearLink | null {
  if (!isRecord(value)) return null;
  const { issue } = value;
  if (!isBoundedString(issue, TASK_SPEC_LIMITS.linearIssue) || issue === "") return null;
  if (value["url"] === undefined) return { issue };
  const url = httpsUrl(value["url"]);
  return url === null ? null : { issue, url };
}

/**
 * A whole spec, as a task record carries it at rest. An app seals it, and the
 * leader acts on it — routes, spawns, holds dependents on it — so it is held to
 * `parseTaskRequest`'s rule: every field checked and bounded, the result built
 * field by field. A malformed optional field nulls the spec, never drops
 * silently: a task without the pin or deps it was given would run where, or
 * before, it must not.
 */
export function parseTaskSpec(value: unknown): TaskSpec | null {
  const request = parseTaskRequest(value);
  if (request === null || !isRecord(value)) return null;
  const { pin, avoid, lineage, base, batch, deps, linear, client, until } = value;
  const pinned = pin === undefined ? undefined : parsePin(pin);
  const avoids = avoid === undefined ? undefined : parseAvoid(avoid);
  const continues = lineage === undefined ? undefined : parsePlacement(lineage);
  const builds = base === undefined ? undefined : parsePlacement(base);
  const member = batch === undefined ? undefined : parseBatch(batch);
  const edges = deps === undefined ? undefined : parseList(deps, parseDep);
  const issue = linear === undefined ? undefined : parseLinear(linear);
  if (pinned === null || avoids === null || continues === null || builds === null || member === null) return null;
  if (issue === null) return null;
  if (edges === null || (edges !== undefined && edges.length > TASK_SPEC_LIMITS.deps)) return null;
  if (client !== undefined && !isName(client, TASK_SPEC_LIMITS.client)) return null;
  const settles = until === undefined ? undefined : TASK_UNTIL.find((u) => u === until);
  if (until !== undefined && settles === undefined) return null;
  return {
    ...request,
    ...(pinned === undefined ? {} : { pin: pinned }),
    ...(avoids === undefined ? {} : { avoid: avoids }),
    ...(continues === undefined ? {} : { lineage: continues }),
    ...(builds === undefined ? {} : { base: builds }),
    ...(member === undefined ? {} : { batch: member }),
    ...(edges === undefined ? {} : { deps: edges }),
    ...(issue === undefined ? {} : { linear: issue }),
    ...(client === undefined ? {} : { client }),
    ...(settles === undefined ? {} : { until: settles }),
  };
}

function isRoutingId(value: unknown): value is string {
  return typeof value === "string" && ROUTING_ID_PATTERN.test(value);
}

/** A non-empty name under `max` — what every name a leader writes into a task is held to. */
function isName(value: unknown, max: number): value is string {
  return isBoundedString(value, max) && value !== "";
}

/** Bounded, as everything a leader adds to a record is: only the decision may grow, and it is trimmed first. */
function parseTarget(value: unknown): Target | null {
  if (!isRecord(value)) return null;
  const { deviceId, exclave, clone } = value;
  if (!isRoutingId(deviceId) || !isPlacementField(exclave) || !isName(clone, TARGET_LIMITS.clone)) return null;
  return { deviceId, exclave, clone };
}

/** A quota window's label in a reason: `5h`, `7d`, or a model's display name. */
const WINDOW_LABEL_MAX_LENGTH = 64;

/**
 * A reason this build knows, with the fields its line reads; null for one it
 * does not. The caller drops those rather than the decision: a leader a
 * version ahead may reject for a reason minted after this app, and the
 * candidate still reads as rejected.
 */
function parseReason(value: unknown): Reason | null {
  if (!isRecord(value)) return null;
  const { code } = value;
  switch (code) {
    case "offline":
    case "status_stale":
    case "task_id_unsupported":
    case "exclaves_unknown":
    case "pressure_unknown":
    case "repo_absent":
    case "auth_missing":
    case "auth_expired":
    case "base_unpushed":
      return { code };
    case "skill_absent": {
      const { skill } = value;
      return isSkillName(skill) ? { code, skill } : null;
    }
    case "disk_low":
      return isFiniteNumber(value["freeMib"]) ? { code, freeMib: value["freeMib"] } : null;
    case "pin_mismatch": {
      const field = value["field"];
      return field === "deviceId" || field === "account" ? { code, field } : null;
    }
    case "avoided":
      return { code };
    case "quota_unknown": {
      const why = value["why"];
      return why === "unobserved" || why === "trimmed" ? { code, why } : null;
    }
    case "quota_over_line": {
      const { window, projectedPct, creditsSpent } = value;
      if (!isBoundedString(window, WINDOW_LABEL_MAX_LENGTH) || !isFiniteNumber(projectedPct)) return null;
      if (creditsSpent !== undefined && creditsSpent !== true) return null;
      return { code, window, projectedPct, ...(creditsSpent === undefined ? {} : { creditsSpent }) };
    }
    case "model_not_included": {
      const { model } = value;
      return isName(model, TASK_REQUEST_LIMITS.model) ? { code, model } : null;
    }
    case "cap_reached": {
      const { inFlight, max, scope } = value;
      if (!isUint(inFlight) || !isUint(max)) return null;
      if (scope === undefined) return { code, inFlight, max };
      return scope === "global" || scope === "account" || scope === "batch" ? { code, inFlight, max, scope } : null;
    }
    case "batch_order": {
      const { index } = value;
      return isUint(index) && index <= TASK_SPEC_LIMITS.batchIndex ? { code, index } : null;
    }
    case "paused": {
      const until = PAUSE_UNTIL.find((u) => u === value["until"]);
      const { scope } = value;
      return until !== undefined && (scope === "queue" || scope === "account") ? { code, until, scope } : null;
    }
    default:
      return null;
  }
}

function parseScore(value: unknown): Score | null {
  if (!isRecord(value) || !isRecord(value["components"])) return null;
  const { accountPressure, machinePressure, dependencyDistance, queuePressure } = value["components"];
  const { sticky, total } = value;
  const numbers = [accountPressure, machinePressure, dependencyDistance, queuePressure, sticky, total];
  if (!numbers.every(isFiniteNumber)) return null;
  return {
    components: {
      accountPressure: Number(accountPressure),
      machinePressure: Number(machinePressure),
      dependencyDistance: Number(dependencyDistance),
      queuePressure: Number(queuePressure),
    },
    sticky: Number(sticky),
    total: Number(total),
  };
}

function parseCandidate(value: unknown): Candidate | null {
  if (!isRecord(value)) return null;
  const { deviceId, machine, exclave, clone, rejected, score, quota, spill } = value;
  if (!isRoutingId(deviceId) || !isBoundedString(machine, TARGET_LIMITS.machine)) return null;
  if (exclave !== null && !isPlacementField(exclave)) return null;
  if (clone !== undefined && !isName(clone, TARGET_LIMITS.clone)) return null;
  if (!Array.isArray(rejected) || rejected.length > CANDIDATE_MAX_REASONS) return null;
  const reasons = rejected.map(parseReason).filter((reason) => reason !== null);
  const parsedScore = score === undefined ? undefined : parseScore(score);
  if (parsedScore === null) return null;
  let basis: QuotaBasis | undefined;
  if (quota !== undefined) {
    if (!isRecord(quota) || !isUint(quota["observedAt"]) || !isRoutingId(quota["observer"])) return null;
    const source = QUOTA_SOURCES.find((s) => s === quota["source"]);
    if (source === undefined) return null;
    basis = { observedAt: quota["observedAt"], observer: quota["observer"], source };
  }
  let spilled: Candidate["spill"];
  if (spill !== undefined) {
    if (!isRecord(spill)) return null;
    const { window, projectedPct } = spill;
    if (!isBoundedString(window, WINDOW_LABEL_MAX_LENGTH) || !isFiniteNumber(projectedPct)) return null;
    spilled = { window, projectedPct };
  }
  return {
    deviceId,
    machine,
    exclave,
    rejected: reasons,
    ...(clone === undefined ? {} : { clone }),
    ...(parsedScore === undefined ? {} : { score: parsedScore }),
    ...(basis === undefined ? {} : { quota: basis }),
    ...(spilled === undefined ? {} : { spill: spilled }),
  };
}

/**
 * The decision record as the app renders it. Checked like any reply that
 * lands on the render path (DESIGN.md, threat model, relay compromise): one
 * unreadable candidate nulls the record rather than shortening it, since a
 * missing loser would misstate why the winner won — a list the leader cut says
 * so in `trimmed`.
 */
export function parseDecision(value: unknown): Decision | null {
  if (!isRecord(value) || !isFiniteNumber(value["at"])) return null;
  const chosen = value["chosen"] === null ? null : parseTarget(value["chosen"]);
  if (value["chosen"] !== null && chosen === null) return null;
  const listed = value["candidates"];
  if (!Array.isArray(listed) || listed.length > DECISION_MAX_CANDIDATES) return null;
  const candidates = parseList(listed, parseCandidate);
  const { trimmed } = value;
  if (candidates === null || !isOptionalUint(trimmed)) return null;
  return { at: value["at"], chosen, candidates, ...(trimmed === undefined ? {} : { trimmed }) };
}

function parseReservation(value: unknown): Reservation | null {
  const target = parseTarget(value);
  if (target === null || !isRecord(value) || !isFiniteNumber(value["expiresAt"])) return null;
  return { ...target, expiresAt: value["expiresAt"] };
}

function parseAssignment(value: unknown): Assignment | null {
  const target = parseTarget(value);
  if (target === null || !isRecord(value)) return null;
  const { window, pane } = value;
  // Empty is a window: a spawn titled "" names its window "".
  if (window !== undefined && !isBoundedString(window, TARGET_LIMITS.window)) return null;
  if (pane !== undefined && !isName(pane, ROUTING_ID_MAX_LENGTH)) return null;
  return { ...target, ...(window === undefined ? {} : { window }), ...(pane === undefined ? {} : { pane }) };
}

function isOptionalFinite(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

/** The PR, branch, done and clock (`needsInputSince`, `endedAt`) fields M3 adds, checked as one group; null when any is malformed. */
function parseProgressFields(value: Record<string, unknown>): Partial<Task> | null {
  const { prUrl, branch, pushed, merged, doneBy, needsInputSince, escalated, endedAt } = value;
  const url = prUrl === undefined ? undefined : httpsUrl(prUrl);
  if (url === null) return null;
  if (branch !== undefined && (!isBoundedString(branch, BRANCH_MAX_LENGTH) || branch === "")) return null;
  if ((pushed !== undefined && pushed !== true) || (merged !== undefined && merged !== true)) return null;
  const signal = doneBy === undefined ? undefined : DONE_SIGNALS.find((s) => s === doneBy);
  if (doneBy !== undefined && signal === undefined) return null;
  if (
    !isOptionalFinite(needsInputSince) ||
    !isOptionalFinite(endedAt) ||
    (escalated !== undefined && escalated !== true)
  )
    return null;
  return {
    ...(url === undefined ? {} : { prUrl: url }),
    ...(branch === undefined ? {} : { branch }),
    ...(pushed === undefined ? {} : { pushed }),
    ...(merged === undefined ? {} : { merged }),
    ...(signal === undefined ? {} : { doneBy: signal }),
    ...(needsInputSince === undefined ? {} : { needsInputSince }),
    ...(escalated === undefined ? {} : { escalated }),
    ...(endedAt === undefined ? {} : { endedAt }),
  };
}

/** A forge reading, or null when any field is malformed. A fresh object, so nothing unvalidated rides along. */
export function parsePrStatus(value: unknown): PrStatus | null {
  if (!isRecord(value)) return null;
  const { state, checks, stacked, at } = value;
  const known = PR_STATES.find((s) => s === state);
  if (known === undefined || !isFiniteNumber(at)) return null;
  const rollup = checks === undefined ? undefined : PR_CHECKS.find((c) => c === checks);
  if (checks !== undefined && rollup === undefined) return null;
  if (stacked !== undefined && stacked !== true) return null;
  return {
    state: known,
    ...(rollup === undefined ? {} : { checks: rollup }),
    ...(stacked === undefined ? {} : { stacked }),
    at,
  };
}

/**
 * A task as `queue`, `cancel` and `mark-done` carry it, and as its
 * record holds it at rest. A state this build does not know nulls the task: it
 * cannot say what the task is doing, and guessing would be worse than leaving
 * it out.
 */
export function parseTask(value: unknown): Task | null {
  if (!isRecord(value)) return null;
  const {
    id,
    state,
    createdAt,
    spec,
    assignment,
    reservation,
    decision,
    failure,
    absentSince,
    reservedAt,
    leftRunning,
  } = value;
  if (!isTaskId(id) || !isFiniteNumber(createdAt)) return null;
  const known = TASK_STATES.find((s) => s === state);
  if (known === undefined) return null;
  const parsedSpec = parseTaskSpec(spec);
  if (parsedSpec === null) return null;
  const placed = assignment === undefined ? undefined : parseAssignment(assignment);
  const reserved = reservation === undefined ? undefined : parseReservation(reservation);
  const record = decision === undefined ? undefined : parseDecision(decision);
  if (placed === null || reserved === null || record === null) return null;
  if (!isOptionalFinite(absentSince) || !isOptionalFinite(reservedAt)) return null;
  if (leftRunning !== undefined && leftRunning !== true) return null;
  let failed: Task["failure"];
  if (failure !== undefined) {
    if (!isRecord(failure) || !isName(failure["code"], TASK_FAILURE_LIMITS.code)) return null;
    const { message, exit } = failure;
    if (typeof message !== "string") return null;
    // Display-only, so a bad one costs the field, never the failure.
    const sessionFailed = failure["code"] === "session_failed" && isUint(exit) && exit >= 1 && exit <= EXIT_STATUS_MAX;
    const status = sessionFailed ? { exit } : {};
    const { oomKill } = failure;
    const oom = sessionFailed && exit === SIGKILL_STATUS && typeof oomKill === "boolean" ? { oomKill } : {};
    // Cut rather than refused: an M2 leader stored a daemon's message whole, and its tail must not cost the task.
    failed = { code: failure["code"], message: message.slice(0, TASK_FAILURE_LIMITS.message), ...status, ...oom };
  }
  const progress = parseProgressFields(value);
  if (progress === null) return null;
  // Apart from `progress`: a display cache must not make a task unreadable when a later build adds a state.
  const pr = value["pr"] === undefined ? null : parsePrStatus(value["pr"]);
  const { remoteSession } = value;
  return {
    id,
    state: known,
    createdAt,
    spec: parsedSpec,
    ...(placed === undefined ? {} : { assignment: placed }),
    ...(reserved === undefined ? {} : { reservation: reserved }),
    ...(record === undefined ? {} : { decision: record }),
    ...(failed === undefined ? {} : { failure: failed }),
    ...(absentSince === undefined ? {} : { absentSince }),
    ...(reservedAt === undefined ? {} : { reservedAt }),
    ...(leftRunning === undefined ? {} : { leftRunning }),
    ...progress,
    ...(pr === null ? {} : { pr }),
    // Dropped, never fatal, like `pr`: a link is display-only.
    ...(isRemoteSessionId(remoteSession) ? { remoteSession } : {}),
  };
}

/** A version `store-put` can produce: creates are 1, so 0 is no record's. */
function isVersion(value: unknown): value is number {
  return isUint(value) && value >= 1;
}

/**
 * The opened body of a `task:<id>` record — shape only. Binding it to its key
 * (the relay's version, the key's id) is the reader's, beside `openAtRest`
 * (`TaskRecord`).
 */
export function parseTaskRecord(value: unknown): TaskRecord | null {
  if (!isRecord(value) || !isVersion(value["version"])) return null;
  const task = parseTask(value["task"]);
  return task === null ? null : { version: value["version"], task };
}

/**
 * Every reader's rules for an opened `task:<id>` record (`TaskRecord`): its
 * shape, then its binding to the key and version the relay listed it under,
 * then the create rules. `now` is the reader's clock. The one copy, so the app,
 * the leader and any later reader skip the same records for the same reasons.
 */
export function bindTaskRecord(
  payload: unknown,
  stored: { readonly key: string; readonly version: number },
  now: number,
): TaskRecord | RecordUnreadable {
  const record = parseTaskRecord(payload);
  if (record === null) return "malformed";
  if (record.version !== stored.version) return "version_mismatch";
  if (stored.key !== `${STORE_PREFIXES.task.prefix}${record.task.id}`) return "key_mismatch";
  if (record.version === 1 && record.task.state !== "queued") return "created_unqueued";
  if (record.task.createdAt > now + REPLAY_WINDOW_MS) return "created_ahead";
  return record;
}

function isAccountId(value: unknown): value is string {
  return isBoundedString(value, TASK_SPEC_LIMITS.account) && value !== "";
}

function parsePauseHold(value: unknown): PauseHold | null {
  if (!isRecord(value) || !isFiniteNumber(value["at"])) return null;
  const { account, resumeAt } = value;
  const until = PAUSE_UNTIL.find((u) => u === value["until"]);
  if (until === undefined || (account !== undefined && !isAccountId(account))) return null;
  const hold = { until, at: value["at"], ...(account === undefined ? {} : { account }) };
  // A reset hold lifts at a time, on an account; a resume hold has neither clock nor need of one.
  if (until === "resume") return resumeAt === undefined ? hold : null;
  return account !== undefined && isFiniteNumber(resumeAt) ? { ...hold, resumeAt } : null;
}

function parseHolds(value: unknown): readonly PauseHold[] | null {
  const holds = parseList(value, parsePauseHold);
  return holds === null || holds.length > MAX_PAUSE_HOLDS ? null : holds;
}

/** The opened body of `queue:pause` — shape only, as `parseTaskRecord`. */
export function parsePauseRecord(value: unknown): PauseRecord | null {
  if (!isRecord(value) || !isVersion(value["version"])) return null;
  const holds = parseHolds(value["holds"]);
  return holds === null ? null : { version: value["version"], holds };
}

/**
 * The opened body of an `account:<hmac>` record — shape only. Whether its
 * `accountId` hashes to the key it was listed under is the reader's, beside
 * `openAtRest`, as a task's binding is.
 */
export function parseAccountRecord(value: unknown): AccountRecord | null {
  if (!isRecord(value) || !isVersion(value["version"]) || !isAccountId(value["accountId"])) return null;
  const { alias } = value;
  if (alias !== null && !isName(alias, ACCOUNT_ALIAS_MAX_LENGTH)) return null;
  // Only the writer trims; a record that is not what it would have written is not one of ours.
  if (alias !== null && alias !== alias.trim()) return null;
  return { version: value["version"], accountId: value["accountId"], alias };
}

export function parseFleetQuotaEntry(value: unknown): FleetQuotaEntry | null {
  if (!isRecord(value) || !isAccountId(value["accountId"]) || !isRoutingId(value["observer"])) return null;
  const reading = parseQuotaReading(value["reading"]);
  // Bounded here, not in `parseQuotaReading`: a status from an older daemon parses as before.
  const windows = reading?.w;
  if (windows !== undefined && (windows.length > FLEET_QUOTA_MAX_WINDOWS || !windows.every(boundedWindow))) return null;
  return reading === null ? null : { accountId: value["accountId"], observer: value["observer"], reading };
}

function boundedWindow(window: ScopedWindow): boolean {
  return window.m.length <= FLEET_QUOTA_WINDOW_MODEL_MAX_LENGTH;
}

/**
 * The opened body of the fleet quota record. Strict, like a store page: its
 * writers read, compare and write it back, so an entry dropped here would be
 * an account's reading lost from the fleet. One entry per account.
 */
export function parseFleetQuotaRecord(value: unknown): FleetQuotaRecord | null {
  if (!isRecord(value) || !isVersion(value["version"])) return null;
  const listed = value["accounts"];
  if (!Array.isArray(listed) || listed.length > FLEET_QUOTA_MAX_ACCOUNTS) return null;
  const accounts = parseList(listed, parseFleetQuotaEntry);
  if (accounts === null || new Set(accounts.map((entry) => entry.accountId)).size !== accounts.length) return null;
  return { version: value["version"], accounts };
}

/** base64url of exactly `bytes` bytes, unpadded or fully padded — browsers differ, and both decode alike. */
function isBase64UrlBytes(value: unknown, bytes: number): value is string {
  if (typeof value !== "string") return false;
  const unpadded = Math.ceil((bytes * 4) / 3);
  const padded = Math.ceil(bytes / 3) * 4;
  if (value.length !== unpadded && value.length !== padded) return false;
  return /^[A-Za-z0-9_-]+$/u.test(value.slice(0, unpadded)) && /^=*$/u.test(value.slice(unpadded));
}

/**
 * A push endpoint a leader may send to: `https:` (`httpsUrl`), on the default
 * port, on a `PUSH_SERVICE_HOSTS` host — for a `*.` entry any subdomain, never
 * the bare host, and no empty label. Returns the normalized href (`URL`'s
 * form), or null; at most `PUSH_ENDPOINT_MAX_LENGTH`. Checked where the request is parsed,
 * so a refused host never reaches the record, and exported so a sender can
 * check a stored one again.
 */
export function pushEndpoint(value: unknown): string | null {
  const href = httpsUrl(value);
  if (href === null || href.length > PUSH_ENDPOINT_MAX_LENGTH) return null;
  const url = new URL(href);
  if (url.port !== "") return null;
  const host = url.hostname;
  if (host.split(".").some((label) => label === "")) return null;
  const allowed = PUSH_SERVICE_HOSTS.some((entry) =>
    entry.startsWith("*.") ? host.length > entry.length - 1 && host.endsWith(entry.slice(1)) : host === entry,
  );
  return allowed ? href : null;
}

/** An uncompressed P-256 point, and RFC 8291's auth secret. */
const PUSH_P256DH_BYTES = 65;
const PUSH_AUTH_BYTES = 16;

function parseWebPushSubscription(value: unknown): WebPushSubscription | null {
  if (!isRecord(value) || !isRecord(value["keys"])) return null;
  const endpoint = pushEndpoint(value["endpoint"]);
  const { p256dh, auth } = value["keys"];
  if (endpoint === null || !isBase64UrlBytes(p256dh, PUSH_P256DH_BYTES)) return null;
  return isBase64UrlBytes(auth, PUSH_AUTH_BYTES) ? { endpoint, keys: { p256dh, auth } } : null;
}

/**
 * `push-subscribe`, at the leader: the subscription built field by field, its
 * endpoint held to the push-service allowlist (decided #10), so a forged one
 * cannot aim the leader at an arbitrary URL.
 */
export function parsePushSubscribeRequest(value: unknown): PushSubscribeRequest | null {
  return parseWebPushSubscription(value);
}

export function parsePushSubscribeReply(value: unknown): PushSubscribeReply | null {
  if (isRecord(value) && value["ok"] === false) return parseSchedulerError(value);
  const endpoint = isRecord(value) ? pushEndpoint(value["endpoint"]) : null;
  return endpoint === null ? null : { endpoint };
}

const VAPID_PUBLIC_BYTES = 65;
const VAPID_PRIVATE_BYTES = 32;

function parseVapidKeys(value: unknown): VapidKeys | null {
  if (!isRecord(value)) return null;
  const { publicKey, privateKey } = value;
  if (!isBase64UrlBytes(publicKey, VAPID_PUBLIC_BYTES) || !isBase64UrlBytes(privateKey, VAPID_PRIVATE_BYTES)) {
    return null;
  }
  return { publicKey, privateKey };
}

/**
 * The opened body of the settings record. Strict, as the pause record is: the
 * leader writes it back whole, so a part dropped here — the VAPID key above
 * all, which every subscription is bound to — would be lost on the next write.
 */
export function parseSettingsRecord(value: unknown): SettingsRecord | null {
  if (!isRecord(value) || !isVersion(value["version"])) return null;
  const { vapid, linearKey, subscriptions } = value;
  const keys = vapid === undefined ? undefined : parseVapidKeys(vapid);
  if (keys === null) return null;
  if (linearKey !== undefined && !isName(linearKey, LINEAR_KEY_MAX_LENGTH)) return null;
  let subscribed: readonly WebPushSubscription[] | undefined;
  if (subscriptions !== undefined) {
    if (!Array.isArray(subscriptions) || subscriptions.length > PUSH_MAX_SUBSCRIPTIONS) return null;
    const parsed = parseList(subscriptions, parseWebPushSubscription);
    // One subscription per endpoint, as `parseFleetQuotaRecord` has one entry per account.
    if (parsed === null || new Set(parsed.map((sub) => sub.endpoint)).size !== parsed.length) return null;
    subscribed = parsed;
  }
  return {
    version: value["version"],
    ...(keys === undefined ? {} : { vapid: keys }),
    ...(linearKey === undefined ? {} : { linearKey }),
    ...(subscribed === undefined ? {} : { subscriptions: subscribed }),
  };
}

/** `cancel` and `mark-done`, at the leader: the one field, nothing else carried on. */
export function parseTaskRef(value: unknown): TaskRef | null {
  return isRecord(value) && isTaskId(value["taskId"]) ? { taskId: value["taskId"] } : null;
}

/** `pause`, at the leader. `reset` without an account is malformed: it would be no account's reset. */
export function parsePauseRequest(value: unknown): PauseRequest | null {
  if (!isRecord(value)) return null;
  const until = PAUSE_UNTIL.find((u) => u === value["until"]);
  const { account } = value;
  if (until === undefined || (account !== undefined && !isAccountId(account))) return null;
  if (until === "reset" && account === undefined) return null;
  return { until, ...(account === undefined ? {} : { account }) };
}

/** `resume`, at the leader. */
export function parseResumeRequest(value: unknown): ResumeRequest | null {
  if (!isRecord(value)) return null;
  const { account } = value;
  if (account === undefined) return {};
  return isAccountId(account) ? { account } : null;
}

/** `discard`, at the leader: the id and the version a `queue` reply listed the record under. */
export function parseDiscardRequest(value: unknown): DiscardRequest | null {
  if (!isRecord(value) || !isTaskId(value["taskId"]) || !isVersion(value["version"])) return null;
  return { taskId: value["taskId"], version: value["version"] };
}

/** A scheduler refusal, its code kept raw: a leader a version ahead still refuses, rather than answers nothing. */
function parseSchedulerError(value: unknown): SchedulerError | null {
  if (!isRecord(value) || value["ok"] !== false || typeof value["message"] !== "string") return null;
  const { code } = value;
  return isName(code, TASK_FAILURE_LIMITS.code) ? { ok: false, code, message: value["message"] } : null;
}

export function parseQueueReply(value: unknown): QueueReply | null {
  if (isRecord(value) && value["ok"] === false) return parseSchedulerError(value);
  if (!isRecord(value) || !isFiniteNumber(value["at"])) return null;
  const listed = value["tasks"];
  if (!Array.isArray(listed) || listed.length > QUEUE_MAX_TASKS) return null;
  // Lenient per task, as the registry is per entry: one a leader ahead wrote must not hide the rest.
  const tasks = listed.map(parseTask).filter((task) => task !== null);
  // Strict, unlike a task: an unread hold would show a paused queue as running.
  const holds = value["holds"] === undefined ? undefined : parseHolds(value["holds"]);
  if (holds === null) return null;
  const listedUnreadable = value["unreadable"];
  if (listedUnreadable !== undefined && (!Array.isArray(listedUnreadable) || listedUnreadable.length > MAX_TASKS)) {
    return null;
  }
  // Lenient per entry, as tasks are: a bad one costs its own discard, not the queue.
  const unreadable = listedUnreadable?.map(parseUnreadableTaskRef).filter((entry) => entry !== null);
  return {
    tasks,
    at: value["at"],
    ...(holds === undefined ? {} : { holds }),
    ...(unreadable === undefined || unreadable.length === 0 ? {} : { unreadable }),
  };
}

function parseUnreadableTaskRef(value: unknown): UnreadableTaskRef | null {
  if (!isRecord(value) || !isTaskId(value["taskId"]) || !isVersion(value["version"])) return null;
  const { reason } = value;
  return isName(reason, TASK_FAILURE_LIMITS.code)
    ? { taskId: value["taskId"], version: value["version"], reason }
    : null;
}

/** `discard` replies. */
export function parseDiscardReply(value: unknown): DiscardReply | null {
  if (isRecord(value) && value["ok"] === false) return parseSchedulerError(value);
  return isRecord(value) && isTaskId(value["taskId"]) ? { taskId: value["taskId"] } : null;
}

/** `cancel` and `mark-done` replies. */
export function parseTaskReply(value: unknown): TaskReply | null {
  if (isRecord(value) && value["ok"] === false) return parseSchedulerError(value);
  const task = isRecord(value) ? parseTask(value["task"]) : null;
  return task === null ? null : { task };
}

/** `pause` and `resume` replies. */
export function parsePauseReply(value: unknown): PauseReply | null {
  if (isRecord(value) && value["ok"] === false) return parseSchedulerError(value);
  const holds = isRecord(value) ? parseHolds(value["holds"]) : null;
  return holds === null ? null : { holds };
}

/** A `lead-proof` payload. The term is the relay's counter, so never negative. */
export function parseLeadProof(value: unknown): LeadProof | null {
  if (!isRecord(value)) return null;
  const { term } = value;
  return isTerm(term) ? { term } : null;
}

/** Task ids, as `queue` asks for and `queue-changed` names them: at most `QUEUE_MAX_TASKS`, all or nothing. */
function parseTaskIds(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.length <= QUEUE_MAX_TASKS && value.every(isTaskId) ? value : null;
}

/** `queue`, at the leader. An unreadable filter is a malformed request, never "everything". */
export function parseQueueRequest(value: unknown): QueueRequest | null {
  if (!isRecord(value)) return null;
  if (value["tasks"] === undefined) return {};
  const tasks = parseTaskIds(value["tasks"]);
  return tasks === null ? null : { tasks };
}

/**
 * The leader's nudge: a stamp and which tasks changed. Nothing in it is acted
 * on but a re-fetch, so an unreadable list costs the list — the app re-fetches
 * the whole queue, as for one that named none.
 */
export function parseQueueChanged(value: unknown): QueueChanged | null {
  if (!isRecord(value) || !isFiniteNumber(value["at"])) return null;
  const tasks = value["tasks"] === undefined ? null : parseTaskIds(value["tasks"]);
  return { at: value["at"], ...(tasks === null ? {} : { tasks }) };
}

/**
 * `SessionsResponse.progress`, at the leader. Strict, like a store page: an
 * entry dropped would read as a task with no PR, which a takeover settles as
 * `done`. A caller reads null as it reads `progressTrimmed` — every task's
 * progress unknown.
 */
export function parseTaskProgressList(value: unknown): readonly TaskProgress[] | null {
  if (!Array.isArray(value) || value.length > SESSIONS_MAX_PROGRESS) return null;
  return parseList(value, parseTaskProgress);
}

function parseTaskProgress(value: unknown): TaskProgress | null {
  if (!isRecord(value)) return null;
  const { taskId, prUrl, branch, pushed, merged, reported, exit, oomKill, at } = value;
  if (!isTaskId(taskId) || !isFiniteNumber(at)) return null;
  if (exit !== undefined && (!isUint(exit) || exit > EXIT_STATUS_MAX)) return null;
  const url = prUrl === undefined ? undefined : httpsUrl(prUrl);
  if (url === null) return null;
  if (branch !== undefined && !isName(branch, BRANCH_MAX_LENGTH)) return null;
  if ((pushed !== undefined && pushed !== true) || (merged !== undefined && merged !== true)) return null;
  if (reported !== undefined && reported !== true) return null;
  return {
    taskId,
    at,
    ...(url === undefined ? {} : { prUrl: url }),
    ...(branch === undefined ? {} : { branch }),
    ...(pushed === undefined ? {} : { pushed }),
    ...(merged === undefined ? {} : { merged }),
    ...(reported === undefined ? {} : { reported }),
    ...(exit === undefined ? {} : { exit }),
    // Display-only: a bad one, or one beside another status, costs the field — never the entry, which would null the list.
    ...(exit === SIGKILL_STATUS && typeof oomKill === "boolean" ? { oomKill } : {}),
  };
}

/**
 * The leader's check on a forwarded `branch-state`, as `parseSessionEvent` is:
 * the sealer is a PSK holder that bound the task id itself, so this is skew and
 * bug hygiene. `merged` moves a task to `done` and releases its dependents, so
 * both booleans must be booleans, never truthy.
 */
export function parseBranchState(value: unknown): BranchState | null {
  if (!isRecord(value)) return null;
  const { taskId, repo, branch, pushed, merged, at } = value;
  if (!isTaskId(taskId) || !isBoundedString(repo, TASK_REQUEST_LIMITS.repo) || repo === "") return null;
  if (!isBoundedString(branch, BRANCH_MAX_LENGTH) || branch === "") return null;
  if (typeof pushed !== "boolean" || typeof merged !== "boolean" || !isFiniteNumber(at)) return null;
  return { taskId, repo, branch, pushed, merged, at };
}

export function isStoreKey(value: unknown): value is string {
  return typeof value === "string" && STORE_KEY_PATTERN.test(value);
}

function parseStoreRecord(value: unknown): StoreRecord | null {
  if (!isRecord(value) || !isStoreKey(value["key"]) || !isVersion(value["version"])) return null;
  const env = parseEnvelope(value["env"]);
  return env === null ? null : { key: value["key"], version: value["version"], env };
}

/**
 * A relay's answer to a store frame, on either leg. The relay is untrusted
 * (DESIGN.md, threat model, relay compromise) and a page it sends lands in a
 * reconcile, so a malformed record nulls the page rather than shortening it — a
 * task missing from a takeover's list is a task the new leader never runs.
 * A refusal keeps its code raw (`StoreReplyFrame`).
 */
export function parseStoreReply(value: unknown): StoreReplyFrame | null {
  if (!isRecord(value) || typeof value["re"] !== "string") return null;
  const re = value["re"];
  switch (value["t"]) {
    case "store-listed": {
      // A `next` would mean a page, which this build cannot continue: unreadable, never a short queue.
      if (value["next"] !== undefined) return null;
      const records = parseList(value["records"], parseStoreRecord);
      return records === null ? null : { t: "store-listed", re, records };
    }
    case "store-record": {
      if (value["record"] === null) return { t: "store-record", re, record: null };
      const record = parseStoreRecord(value["record"]);
      return record === null ? null : { t: "store-record", re, record };
    }
    case "store-written":
      return isUint(value["version"]) ? { t: "store-written", re, version: value["version"] } : null;
    case "store-refused":
      return typeof value["code"] === "string" ? { t: "store-refused", re, code: value["code"] } : null;
    default:
      return null;
  }
}

export function parseStoreChanged(value: unknown): StoreChangedFrame | null {
  if (!isRecord(value) || value["t"] !== "store-changed") return null;
  const { key, version } = value;
  return isStoreKey(key) && isUint(version) ? { t: "store-changed", key, version } : null;
}

export function parseRoutePreviewReply(value: unknown): RoutePreviewReply | null {
  if (isRecord(value) && value["ok"] === false) return parseSchedulerError(value);
  const decision = isRecord(value) ? parseDecision(value["decision"]) : null;
  return decision === null ? null : { decision };
}

export function isSchedulerOp(value: unknown): value is SchedulerOp {
  return SCHEDULER_OPS.some((op) => op === value);
}

/** Receivers never reject on this — display routing only; the wire keeps `string`. */
export function isSpawnErrorCode(value: unknown): value is SpawnErrorCode {
  return SPAWN_ERROR_CODES.some((code) => code === value);
}
