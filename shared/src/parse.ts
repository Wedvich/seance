import { REPLAY_WINDOW_MS } from "./crypto.ts";
import { isAutonomyLevel, withAutonomy } from "./autonomy.ts";
import { isTraitName, TRAIT_LIMITS } from "./traits.ts";
import { isPromptBasis } from "./amend.ts";
import {
  ACCOUNT_ALIAS_MAX_LENGTH,
  ATTACHMENT_HASH_PATTERN,
  ARCHIVE_INGEST_SOURCES,
  ARCHIVE_MACHINES_MAX,
  ARCHIVE_METRICS_STEPS,
  ARCHIVE_STATUS_ERROR_CODES,
  ARCHIVE_TASK_OUTCOMES,
  ARCHIVE_TASKS_ERROR_CODES,
  ARCHIVE_TASKS_MAX_PAGE,
  ATTACHMENT_ID_PATTERN,
  ATTACHMENT_LIMITS,
  ATTACHMENTS_DEP_SENTINEL,
  BRANCH_MAX_LENGTH,
  CANDIDATE_MAX_REASONS,
  CUSTODIAN_STATES,
  DECISION_MAX_CANDIDATES,
  DRAIN_REFUSALS,
  DEP_AFTER,
  DONE_SIGNALS,
  EXIT_STATUS_MAX,
  FLAG_NOTE_MAX,
  FLAG_REASONS,
  FLEET_QUOTA_MAX_ACCOUNTS,
  FLEET_QUOTA_MAX_WINDOWS,
  FLEET_QUOTA_WINDOW_MODEL_MAX_LENGTH,
  LINEAR_KEY_MAX_LENGTH,
  MAX_PAUSE_HOLDS,
  MAX_TASKS,
  PAUSE_UNTIL,
  PR_BLOCKED_REASONS,
  PR_CHECKS,
  PR_FAILING_LIMITS,
  PR_MERGE_STATES,
  PR_STATES,
  PUSH_ALERT_MAX_BYTES,
  PASS_CLOSE_ERROR_CODES,
  PUSH_BRANCH_ERROR_CODES,
  PUSH_ENDPOINT_MAX_LENGTH,
  PUSH_LABEL_MAX_LENGTH,
  PUSH_MAX_SUBSCRIPTIONS,
  AUTH_ALERTS_MAX,
  DISK_ALERTS_MAX,
  PUSH_SERVICE_HOSTS,
  PUSH_SERVICE_VENDORS,
  REPO_MAX_SKILLS,
  REQUIRES_DEP_SENTINEL,
  SKILL_NAME_MAX_LENGTH,
  STATUS_MAX_AUTH_EXPIRED,
  STATUS_MAX_TRAIT_PAIRS,
  TASK_UNTIL,
  QUEUE_MAX_TASKS,
  ROUTING_ID_MAX_LENGTH,
  ROUTING_ID_PATTERN,
  SESSIONS_MAX_PROGRESS,
  SIGKILL_STATUS,
  STORE_KEY_PATTERN,
  STORE_PREFIXES,
  SUCCESSOR_DEP_SENTINEL,
  SUCCESSOR_RECORD_MAX,
  SUCCESSOR_TRIGGERS,
  TARGET_LIMITS,
  TASK_FAILURE_LIMITS,
  TASK_PRS_MAX,
  TASK_PRS_MAX_LENGTH,
  TASK_SPEC_LIMITS,
  TOOL_NAME_MAX_LENGTH,
  type AccountRecord,
  type ArchiveIngestSource,
  type ArchiveMetricsRequest,
  type ArchiveRefusals,
  type ArchiveTasksCursor,
  type ArchiveTasksReply,
  type ArchiveTasksRequest,
  type ArchivedMachine,
  type ArchivedTask,
  type ArchiveStatusRequest,
  type ArchiveStatusReply,
  type ArchiveStatusResponse,
  type ArchiveTableStatus,
  type ArchivistInfo,
  type AttachmentRef,
  type BatchMembership,
  type FleetQuotaEntry,
  type FleetQuotaRecord,
  type PassCloseRequest,
  type PassCloseResponse,
  type PassReply,
  type PushAlert,
  type PushBranchRequest,
  type PushBranchResponse,
  type PushSubscribeReply,
  type PushSubscribeRequest,
  type PushSubscriptionEntry,
  type PushUnsubscribeReply,
  type PushUnsubscribeRequest,
  type QuotaReading,
  type SessionPass,
  type SettingsRecord,
  type ArchivistSilence,
  type AuthAlerted,
  type DiskAlerted,
  type SpillStamp,
  type TaskPr,
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
  type ContinuedBy,
  type CustodianEvent,
  type FlagReason,
  type TaskFlag,
  type DrainedStamp,
  type PrAlertStamp,
  type QuotaExhaustedStamp,
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
  AMEND_MODES,
  type AmendRequest,
  type UnreadableTaskRef,
  type IdleRelease,
  type IdleTaskRef,
  METRICS_ERROR_CODES,
  METRICS_MAX_FILTER_LENGTH,
  METRICS_MAX_FILTERS,
  METRICS_MAX_POINTS,
  METRICS_STEPS,
  NEEDS_INPUT_REASONS,
  QUOTA_ALERT_REASONS,
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
  type RoutePreviewRequest,
  type SchedulerError,
  type SchedulerOp,
  type Score,
  type Target,
  type Task,
  type TaskRequest,
  type Envelope,
  type ExclaveInfo,
  type MachineInfo,
  type CustodianStatus,
  type MachineStatus,
  type MetricsReply,
  type MetricsRequest,
  type MetricsResponse,
  type MetricsSeries,
  type NeedsInputReason,
  type QuotaObservation,
  type RepoEntry,
  type RescanResponse,
  type ScopedWindow,
  type SessionEvent,
  type SessionState,
  type SpawnErrorCode,
  type SpawnMode,
  type SourceInfo,
  type UpdateReport,
  AVAILABILITY_ERROR_CODES,
  type AvailabilityRequest,
  type AvailabilityResponse,
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
  const traits = parseExclaveTraits(value["traits"]);
  const keepFree = parseExclaveKeepFree(value["keepFree"], traits);
  return {
    id: value["id"],
    accountId,
    ...(email === undefined || email === "" ? {} : { email }),
    extraUsageEnabled,
    ...(seatTier === undefined || seatTier === "" ? {} : { seatTier }),
    authOk: value["authOk"],
    skills,
    ...(traits === undefined ? {} : { traits }),
    ...(keepFree === undefined ? {} : { keepFree }),
  };
}

/**
 * Lenient, as `parseRepoSkills` is: a list this build cannot read is read as no
 * traits, which only ever keeps a task off the exclave (the fail-closed direction),
 * and never costs the exclave or the machine its blob. Names failing the pattern are
 * dropped one by one, repeats collapse, and the list is cut at `TRAIT_LIMITS.perMachine`.
 */
function parseExclaveTraits(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = [...new Set(value.filter(isTraitName))].slice(0, TRAIT_LIMITS.perMachine);
  return names.length === 0 ? undefined : names;
}

/**
 * Lenient like `parseExclaveTraits`: a list this build cannot read is read as none (the
 * kept-free machine then scores as any other: a soft preference lost, never a task misplaced).
 * Only names also in the parsed `traits` survive, since a keepFree name without the trait means nothing.
 */
function parseExclaveKeepFree(value: unknown, traits: readonly string[] | undefined): readonly string[] | undefined {
  if (!Array.isArray(value) || traits === undefined) return undefined;
  const names = [...new Set(value.filter((name) => isTraitName(name) && traits.includes(name)))];
  return names.length === 0 ? undefined : names;
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

/** A daemon mints a UUID; the bound only keeps a skewed blob from carrying a large one around. */
const MAX_INSTANCE_LENGTH = 64;

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
  const instance = value["instance"];
  return {
    name: value["name"],
    platform: value["platform"],
    repos,
    scannedAt: value["scannedAt"],
    ...(exclaves === undefined || exclaves === null ? {} : { exclaves }),
    ...(isStringArray(capabilities) ? { capabilities } : {}),
    ...(source === null ? {} : { source }),
    ...(lastUpdate === null ? {} : { lastUpdate }),
    ...(typeof instance === "string" && instance !== "" && instance.length <= MAX_INSTANCE_LENGTH ? { instance } : {}),
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

function parseUintPair(value: unknown): readonly [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [index, at] = value;
  return isUint(index) && isUint(at) ? [index, at] : null;
}

/**
 * `MachineStatus.cu`. Null for anything off: the caller drops `cu` alone and keeps the status, since `cu` is a display
 * row and a newer daemon may add a state this one does not know.
 */
export function parseCustodianStatus(value: unknown): CustodianStatus | null {
  if (!isRecord(value)) return null;
  const { s, e, n, rc } = value;
  const state = CUSTODIAN_STATES.find((candidate) => candidate === s);
  if (state === undefined) return null;
  if (e !== undefined && !(isUint(e) && e > 0)) return null;
  let counts: readonly [number, number, number] | undefined;
  if (n !== undefined) {
    if (!Array.isArray(n) || n.length !== 3) return null;
    const [closed, nudged, flagged] = n;
    const inRange = (x: unknown): x is number => isUint(x) && x <= 999;
    if (!inRange(closed) || !inRange(nudged) || !inRange(flagged)) return null;
    counts = [closed, nudged, flagged];
  }
  if (rc !== undefined && !(state === "running" && isRemoteSessionId(rc))) return null;
  return {
    s: state,
    ...(e === undefined ? {} : { e }),
    ...(counts === undefined ? {} : { n: counts }),
    ...(rc === undefined ? {} : { rc }),
  };
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
  const ae = value["ae"] === undefined ? undefined : parseList(value["ae"], parseUintPair);
  const au = value["au"] === undefined ? undefined : parseUintList(value["au"]);
  if (ax === null || ae === null || au === null) return null;
  // Disjoint and bounded together: one exclave is in at most one list.
  const authIndices = [...(ax ?? []), ...(ae ?? []).map(([index]) => index), ...(au ?? [])];
  if (authIndices.length > STATUS_MAX_AUTH_EXPIRED || new Set(authIndices).size !== authIndices.length) return null;
  const tf = value["tf"] === undefined ? undefined : parseList(value["tf"], parseUintPair);
  const tu = value["tu"] === undefined ? undefined : parseList(value["tu"], parseUintPair);
  if (tf === null || tu === null) return null;
  const traitPairs = [...(tf ?? []), ...(tu ?? [])].map(([x, t]) => `${x}:${t}`);
  if (traitPairs.length > STATUS_MAX_TRAIT_PAIRS || new Set(traitPairs).size !== traitPairs.length) return null;
  const { drn } = value;
  if (drn !== undefined && drn !== true) return null;
  const { cl } = value;
  if (cl !== undefined && !(isFiniteNumber(cl) && cl > 0)) return null;
  // Unlike `drn` and `cl`, a bad `cu` is dropped alone: losing a machine's quota and auth over a display row is worse.
  const cu = value["cu"] === undefined ? null : parseCustodianStatus(value["cu"]);
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
    ...(ae === undefined ? {} : { ae }),
    ...(au === undefined ? {} : { au }),
    ...(tf === undefined ? {} : { tf }),
    ...(tu === undefined ? {} : { tu }),
    ...(drn === undefined ? {} : { drn }),
    ...(cl === undefined ? {} : { cl }),
    ...(cu === null ? {} : { cu }),
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

function isMetricNames(value: unknown): value is readonly string[] {
  if (!isStringArray(value) || value.length === 0 || value.length > METRICS_MAX_FILTERS) return false;
  return value.every((name) => name !== "" && name.length <= METRICS_MAX_FILTER_LENGTH);
}

function isLabelMatchers(value: unknown): value is Readonly<Record<string, string>> {
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

/** Any record: the request carries nothing, and a later one may add a field. */
export function parseArchiveStatusRequest(value: unknown): ArchiveStatusRequest | null {
  return isRecord(value) ? {} : null;
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function parseArchiveTable(value: unknown): ArchiveTableStatus | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isUint(value["rows"]) || !isFiniteOrNull(value["oldest"])) return undefined;
  return { rows: value["rows"], oldest: value["oldest"] };
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Unreadable is undefined, never null: a bad `refused` costs that line of the card, not the reply. */
function parseArchiveRefusals(value: unknown): ArchiveRefusals | undefined {
  if (!isRecord(value) || !isUint(value["tasks"]) || !isFiniteOrNull(value["since"])) return undefined;
  return { tasks: value["tasks"], since: value["since"] };
}

/** The card's numbers: an archivist a version ahead must cost the rows, not the app. */
export function parseArchiveStatusResponse(value: unknown): ArchiveStatusResponse | null {
  if (!isRecord(value)) return null;
  const { onlineSince, lastIngest, database, countedAt } = value;
  if (!isFiniteOrNull(onlineSince) || !isFiniteOrNull(countedAt) || !isRecord(lastIngest) || !isRecord(database)) {
    return null;
  }
  const ingest: Partial<Record<ArchiveIngestSource, number | null>> = {};
  for (const source of ARCHIVE_INGEST_SOURCES) {
    const at = lastIngest[source] ?? null;
    if (!isFiniteOrNull(at)) return null;
    ingest[source] = at;
  }
  const tasks = parseArchiveTable(value["tasks"]);
  const samples = parseArchiveTable(value["samples"]);
  const events = parseArchiveTable(value["events"]);
  if (tasks === undefined || samples === undefined || events === undefined) return null;
  const { archiveBytes, metricsBytes } = database;
  if (!isFiniteNonNegative(archiveBytes) || !isFiniteNonNegative(metricsBytes)) return null;
  const refused = parseArchiveRefusals(value["refused"]);
  return {
    ok: true,
    onlineSince,
    lastIngest: {
      store: ingest.store ?? null,
      registry: ingest.registry ?? null,
      status: ingest.status ?? null,
      pull: ingest.pull ?? null,
    },
    tasks,
    samples,
    events,
    database: { archiveBytes, metricsBytes },
    countedAt,
    ...(refused === undefined ? {} : { refused }),
  };
}

export function parseArchiveStatusReply(value: unknown): ArchiveStatusReply | null {
  if (!isRecord(value) || value["ok"] !== false) return parseArchiveStatusResponse(value);
  const code = ARCHIVE_STATUS_ERROR_CODES.find((c) => c === value["code"]);
  if (code === undefined || typeof value["message"] !== "string") return null;
  return { ok: false, code, message: value["message"] };
}

/**
 * The archivist's register blob. An invalid `source` drops the build line, not
 * the blob, so the card still shows.
 */
export function parseArchivistInfo(value: unknown): ArchivistInfo | null {
  if (!isRecord(value) || value["archivist"] !== true) return null;
  const { name, platform } = value;
  if (typeof name !== "string" || typeof platform !== "string") return null;
  const source = parseSourceInfo(value["source"]);
  return { archivist: true, name, platform, ...(source === null ? {} : { source }) };
}

/** An `account:<hex>` store key: how the archive names an account, never by its raw id (A15). */
function isAccountStoreKey(value: unknown): value is string {
  return isStoreKey(value) && value.startsWith(STORE_PREFIXES.account.prefix);
}

/**
 * The archivist's `archive-metrics` request, as a fresh value: `metrics`'s
 * range, step and filter bounds over the archive's steps, and exactly one
 * target. A span past `METRICS_MAX_POINTS` per series is refused before the
 * archive reads a row.
 */
export function parseArchiveMetricsRequest(value: unknown): ArchiveMetricsRequest | null {
  if (!isRecord(value)) return null;
  const { from, to, step, names, labels, machine, account } = value;
  if (!isUint(from) || !isUint(to) || from > to) return null;
  const known = ARCHIVE_METRICS_STEPS.find((s) => s === step);
  if (known === undefined || (to - from) / known + 1 > METRICS_MAX_POINTS) return null;
  if (names !== undefined && !isMetricNames(names)) return null;
  if (labels !== undefined && !isLabelMatchers(labels)) return null;
  const range = {
    from,
    to,
    step: known,
    ...(names === undefined ? {} : { names: [...names] }),
    ...(labels === undefined ? {} : { labels: { ...labels } }),
  };
  if (account === undefined && isRoutingId(machine)) return { ...range, machine };
  if (machine === undefined && isAccountStoreKey(account)) return { ...range, account };
  return null;
}

function parseArchiveTasksCursor(value: unknown): ArchiveTasksCursor | null {
  if (!isRecord(value)) return null;
  const { endedAt, createdAt, id } = value;
  return isUint(endedAt) && isUint(createdAt) && isTaskId(id) ? { endedAt, createdAt, id } : null;
}

/** The archivist's `archive-tasks` request, as a fresh value; any bound broken refuses the whole request. */
export function parseArchiveTasksRequest(value: unknown): ArchiveTasksRequest | null {
  if (!isRecord(value)) return null;
  const { limit, before, repo, outcome, machine, account, since, until, title } = value;
  if (limit !== undefined && !(isUint(limit) && limit >= 1 && limit <= ARCHIVE_TASKS_MAX_PAGE)) return null;
  const cursor = before === undefined ? undefined : parseArchiveTasksCursor(before);
  const known = outcome === undefined ? undefined : ARCHIVE_TASK_OUTCOMES.find((o) => o === outcome);
  if (cursor === null || (outcome !== undefined && known === undefined)) return null;
  if (repo !== undefined && !isName(repo, TASK_REQUEST_LIMITS.repo)) return null;
  if (machine !== undefined && !isRoutingId(machine)) return null;
  if (account !== undefined && !isAccountStoreKey(account)) return null;
  if (!isOptionalUint(since) || !isOptionalUint(until)) return null;
  if (title !== undefined && !isName(title, TASK_REQUEST_LIMITS.title)) return null;
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { before: cursor }),
    ...(repo === undefined ? {} : { repo }),
    ...(known === undefined ? {} : { outcome: known }),
    ...(machine === undefined ? {} : { machine }),
    ...(account === undefined ? {} : { account }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    ...(title === undefined ? {} : { title }),
  };
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseArchivedTask(value: unknown): ArchivedTask | null {
  if (!isRecord(value)) return null;
  const task = parseTask(value["task"]);
  const { endedAt, machine, account, alias } = value;
  if (task === null || !isUint(endedAt) || !isStringOrNull(machine)) return null;
  if (!isStringOrNull(account) || !isStringOrNull(alias)) return null;
  return { task, endedAt, machine, account, alias };
}

function parseArchivedMachine(value: unknown): ArchivedMachine | null {
  if (!isRecord(value)) return null;
  const { deviceId, name, lastSeen } = value;
  return isRoutingId(deviceId) && isStringOrNull(name) && isUint(lastSeen) ? { deviceId, name, lastSeen } : null;
}

/**
 * Lenient per entry, as `queue`'s tasks are: a row or machine an archivist a
 * version ahead writes in a shape this build cannot read costs that entry, not
 * the page. `machines` absent (an older archivist) or not an array stays absent.
 */
export function parseArchiveTasksReply(value: unknown): ArchiveTasksReply | null {
  if (!isRecord(value)) return null;
  if (value["ok"] === false) {
    const code = ARCHIVE_TASKS_ERROR_CODES.find((c) => c === value["code"]);
    if (code === undefined || typeof value["message"] !== "string") return null;
    return { ok: false, code, message: value["message"] };
  }
  const { ok, tasks, total, next, machines } = value;
  if (ok !== true || !Array.isArray(tasks) || !isUint(total)) return null;
  const cursor = next === null ? null : parseArchiveTasksCursor(next);
  if (cursor === null && next !== null) return null;
  return {
    ok: true,
    tasks: tasks.map(parseArchivedTask).filter((task) => task !== null),
    total,
    next: cursor,
    // Display only: a listing this build cannot read as an array is absent, a longer one cut to what it bounds.
    ...(Array.isArray(machines)
      ? {
          machines: machines
            .slice(0, ARCHIVE_MACHINES_MAX)
            .map(parseArchivedMachine)
            .filter((machine) => machine !== null),
        }
      : {}),
  };
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

export function isNeedsInputReason(value: unknown): value is NeedsInputReason {
  return NEEDS_INPUT_REASONS.some((reason) => reason === value);
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

const TOOL_NAME = new RegExp(`^[A-Za-z0-9_-]{1,${TOOL_NAME_MAX_LENGTH}}$`, "u");

/** A tool name as Claude Code mints one; nothing that could carry a command line passes. */
export function isToolName(value: unknown): value is string {
  return typeof value === "string" && TOOL_NAME.test(value);
}

/**
 * The leader's check on a forwarded event. The sender is a PSK holder, so this
 * is skew and bug hygiene rather than a trust boundary — the daemon already
 * bound the event to its pane — but a `prUrl` and a `remoteSession` are
 * re-checked all the same: they are the fields that reach an `href`. A bad
 * `remoteSession` is dropped rather than the event: a link is not worth losing
 * the state it rode with. A `reason` is kept only when known and beside
 * `needs-input`, and dropped otherwise, never the event: a newer daemon's
 * reason costs this leader only the debounce it would have waited anyway. A
 * `tool` is kept only beside `permission` and only as `isToolName` passes it,
 * dropped otherwise, never the event.
 */
export function parseSessionEvent(value: unknown): SessionEvent | null {
  if (!isRecord(value)) return null;
  const { session, taskId, exclave, state, prUrl, remoteSession, reason, tool, at } = value;
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
    ...(state === "needs-input" && isNeedsInputReason(reason) ? { reason } : {}),
    ...(state === "needs-input" && reason === "permission" && isToolName(tool) ? { tool } : {}),
  };
}

/**
 * The leader's check on a forwarded `session-pass`, as `parseSessionEvent` is: the sealer is a PSK holder
 * that bound the task id and pane itself, so this is skew and bug hygiene, plus the two values the leader
 * acts on, which are held as hard as a `push-branch` answer's: `remoteBranch` is compared to a PR head and
 * named in a prompt (`isBranchName`), `tip` is named in it too (a commit id). A `record` over
 * `SUCCESSOR_RECORD_MAX` UTF-16 units, or one that is empty or not a string, nulls the event: cutting
 * it here would hide a daemon that did not enforce its own bound.
 */
export function parseSessionPass(value: unknown): SessionPass | null {
  if (!isRecord(value)) return null;
  const { session, taskId, exclave, remoteBranch, tip, record, drain, at } = value;
  if (typeof session !== "string" || session === "" || session.length > ROUTING_ID_MAX_LENGTH) return null;
  if (!isTaskId(taskId) || typeof exclave !== "string" || exclave.length > ROUTING_ID_MAX_LENGTH) return null;
  if (!isBranchName(remoteBranch) || typeof tip !== "string" || !COMMIT_OID.test(tip)) return null;
  if (!isFiniteNumber(at)) return null;
  if (record !== undefined && (typeof record !== "string" || record === "" || record.length > SUCCESSOR_RECORD_MAX)) {
    return null;
  }
  return {
    session,
    taskId,
    exclave,
    remoteBranch,
    tip,
    at,
    ...(record === undefined ? {} : { record }),
    ...(drain === true ? { drain: true as const } : {}),
  };
}

/**
 * A flag note: one short line of printable text. The refused set (control, format, surrogate, line and
 * paragraph separator) is the one the owner CLI's `printable` replaces, so a note that passes here
 * reaches a terminal and a card unchanged; it also refuses a newline and a bidi or zero-width mark.
 * Model-written from untrusted pane text, so display-only everywhere (never logged, pushed or archived).
 */
export function isFlagNote(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value.length <= FLAG_NOTE_MAX &&
    !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)
  );
}

export function isFlagReason(value: unknown): value is FlagReason {
  return FLAG_REASONS.some((reason) => reason === value);
}

/** A stored flag, built field by field: null for an unknown key, reason, a bad `at` or a bad note. */
export function parseTaskFlag(value: unknown): TaskFlag | null {
  if (!isRecord(value) || !Object.keys(value).every((key) => key === "reason" || key === "note" || key === "at")) {
    return null;
  }
  const { reason, note, at } = value;
  if (!isFlagReason(reason) || !isFiniteNumber(at)) return null;
  if (note !== undefined && !isFlagNote(note)) return null;
  return { reason, at, ...(note === undefined ? {} : { note }) };
}

const CUSTODIAN_EVENT_KEYS = {
  flag: ["kind", "taskId", "reason", "note", "at"],
  unflag: ["kind", "taskId", "at"],
  failing: ["kind", "at"],
} as const;

/**
 * The leader's check on a forwarded `custodian-event`, as `parseSessionPass` is: exact keys per kind and
 * built field by field. The `reason` and `note` are the round's claim, so both are held to the same
 * rule as a stored flag, and a note that fails nulls the event rather than being cut.
 */
export function parseCustodianEvent(value: unknown): CustodianEvent | null {
  if (!isRecord(value)) return null;
  const { kind, taskId, reason, note, at } = value;
  if (kind !== "flag" && kind !== "unflag" && kind !== "failing") return null;
  if (!Object.keys(value).every((key) => (CUSTODIAN_EVENT_KEYS[kind] as readonly string[]).includes(key))) return null;
  if (!isFiniteNumber(at)) return null;
  if (kind === "failing") return { kind, at };
  if (!isTaskId(taskId)) return null;
  if (kind === "unflag") return { kind, taskId, at };
  if (!isFlagReason(reason) || (note !== undefined && !isFlagNote(note))) return null;
  return { kind, taskId, reason, at, ...(note === undefined ? {} : { note }) };
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
  return parseRequestFields(value, ["worktree", "here"]);
}

/** `parseTaskRequest`, plus route-preview's `attachments` flag (`true` or absent) and `requires`. */
export function parseRoutePreviewRequest(value: unknown): RoutePreviewRequest | null {
  const request = parseTaskRequest(value);
  if (request === null || !isRecord(value)) return null;
  const { attachments } = value;
  if (attachments !== undefined && attachments !== true) return null;
  const requires = value["requires"] === undefined ? undefined : parseRequires(value["requires"]);
  if (requires === null) return null;
  return {
    ...request,
    ...(attachments === undefined ? {} : { attachments }),
    ...(requires === undefined ? {} : { requires }),
  };
}

/**
 * `modes` is what the caller admits: route-preview takes no `continue` (it
 * routes by skills and has no target to preview), a stored spec does.
 */
function parseRequestFields(value: unknown, modes: readonly SpawnMode[]): TaskRequest | null {
  if (!isRecord(value)) return null;
  const { repo, mode, prompt, title, model, effort, plan, autonomy, skill } = value;
  const limits = TASK_REQUEST_LIMITS;
  if (!isBoundedString(repo, limits.repo) || repo === "") return null;
  const admitted = modes.find((m) => m === mode);
  if (admitted === undefined) return null;
  if (prompt !== undefined && !isBoundedString(prompt, limits.prompt)) return null;
  if (title !== undefined && !isBoundedString(title, limits.title)) return null;
  // Empty would reach the spawn as a flag with no value; absent is how a default is asked for.
  if (model !== undefined && (!isBoundedString(model, limits.model) || model === "")) return null;
  if (effort !== undefined && (!isBoundedString(effort, limits.effort) || effort === "")) return null;
  if (plan !== undefined && typeof plan !== "boolean") return null;
  if (autonomy !== undefined && !isAutonomyLevel(autonomy)) return null;
  if (skill !== undefined && !isSkillName(skill)) return null;
  // Normalised, not just checked: `steer` gains `plan: true`, so an older leader that drops
  // `autonomy` from the record still dispatches plan mode; `plan` beside another level is refused.
  return withAutonomy({
    repo,
    mode: admitted,
    ...(prompt === undefined ? {} : { prompt }),
    ...(title === undefined ? {} : { title }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(plan === undefined ? {} : { plan }),
    ...(autonomy === undefined ? {} : { autonomy }),
    ...(skill === undefined ? {} : { skill }),
  });
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

/** A spec's `requires`: 1 to `TASK_SPEC_LIMITS.requires` unique trait names, nothing else. */
function parseRequires(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > TASK_SPEC_LIMITS.requires) return null;
  if (!value.every(isTraitName) || new Set(value).size !== value.length) return null;
  return [...value];
}

/**
 * Any `strategy` an older writer stored (`sequential`, `parallel`, `auto`,
 * malformed) is ignored and dropped: no batch schedules, so a live record from before must
 * still read rather than null its spec.
 */
function parseBatch(value: unknown): BatchMembership | null {
  if (!isRecord(value)) return null;
  const { id, index } = value;
  if (!isTaskId(id) || !isUint(index) || index > TASK_SPEC_LIMITS.batchIndex) return null;
  return { id, index };
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
  const request = parseRequestFields(value, ["worktree", "here", "continue"]);
  if (request === null || !isRecord(value)) return null;
  const { pin, avoid, lineage, base, batch, deps, linear, client, until, continues } = value;
  const pinned = pin === undefined ? undefined : parsePin(pin);
  const avoids = avoid === undefined ? undefined : parseAvoid(avoid);
  const lineal = lineage === undefined ? undefined : parsePlacement(lineage);
  const resumes = continues === undefined ? undefined : parseContinues(continues);
  const follows = value["succeeds"] === undefined ? undefined : parseSucceeds(value["succeeds"]);
  const builds = base === undefined ? undefined : parsePlacement(base);
  const member = batch === undefined ? undefined : parseBatch(batch);
  const files = value["attachments"] === undefined ? undefined : parseAttachmentManifest(value["attachments"]);
  const needs = value["requires"] === undefined ? undefined : parseRequires(value["requires"]);
  const edges =
    deps === undefined
      ? undefined
      : parseDeps(deps, {
          attached: files !== undefined,
          required: needs !== undefined,
          succeeding: follows !== undefined,
        });
  const issue = linear === undefined ? undefined : parseLinear(linear);
  if (pinned === null || avoids === null || lineal === null || builds === null || member === null) return null;
  if (issue === null || resumes === null || files === null || needs === null || follows === null) return null;
  // A successor is a plain worktree spawn that resets its own branch: a resumed session or files would contradict that.
  if (follows !== undefined && (request.mode !== "worktree" || resumes !== undefined || files !== undefined)) {
    return null;
  }
  if (files !== undefined && (request.mode === "continue" || (request.prompt?.length ?? 0) > ATTACHMENT_LIMITS.prompt))
    return null;
  // The mode is what an older leader refuses, so the field never travels without it.
  if ((request.mode === "continue") !== (resumes !== undefined)) return null;
  if (edges === null) return null;
  if (client !== undefined && !isName(client, TASK_SPEC_LIMITS.client)) return null;
  const settles = until === undefined ? undefined : TASK_UNTIL.find((u) => u === until);
  if (until !== undefined && settles === undefined) return null;
  return {
    ...request,
    ...(pinned === undefined ? {} : { pin: pinned }),
    ...(avoids === undefined ? {} : { avoid: avoids }),
    ...(lineal === undefined ? {} : { lineage: lineal }),
    ...(builds === undefined ? {} : { base: builds }),
    ...(member === undefined ? {} : { batch: member }),
    ...(edges === undefined ? {} : { deps: edges }),
    ...(issue === undefined ? {} : { linear: issue }),
    ...(client === undefined ? {} : { client }),
    ...(settles === undefined ? {} : { until: settles }),
    ...(resumes === undefined ? {} : { continues: resumes }),
    ...(files === undefined ? {} : { attachments: files }),
    ...(needs === undefined ? {} : { requires: needs }),
    ...(follows === undefined ? {} : { succeeds: follows }),
  };
}

/**
 * Each sentinel (`ATTACHMENTS_DEP_SENTINEL`, `REQUIRES_DEP_SENTINEL`, `SUCCESSOR_DEP_SENTINEL`) is
 * dropped before the bound applies, and only beside its field: one without it is a record
 * something stripped the field from — or a sentinel with nothing it guards — and fails
 * `isTaskId`, nulling the spec. A requirement stripped is the reverse, `requires` without its
 * sentinel, and reads fine: no leader older than this one wrote it. Deps that were
 * sentinels alone read as none, as the spec was before sealing.
 */
type DepGuards = { readonly attached: boolean; readonly required: boolean; readonly succeeding: boolean };

function parseDeps(value: unknown, guards: DepGuards): readonly TaskDep[] | null | undefined {
  if (!Array.isArray(value)) return null;
  const real = value.filter(
    (dep) =>
      !(guards.attached && isAttachmentsSentinel(dep)) &&
      !(guards.required && isRequiresSentinel(dep)) &&
      !(guards.succeeding && isSuccessorSentinel(dep)),
  );
  if (real.length === 0 && value.length > 0) return undefined;
  const edges = parseList(real, parseDep);
  return edges === null || edges.length > TASK_SPEC_LIMITS.deps ? null : edges;
}

function isSuccessorSentinel(value: unknown): boolean {
  return (
    isRecord(value) && value["task"] === SUCCESSOR_DEP_SENTINEL.task && value["after"] === SUCCESSOR_DEP_SENTINEL.after
  );
}

function isAttachmentsSentinel(value: unknown): boolean {
  return (
    isRecord(value) &&
    value["task"] === ATTACHMENTS_DEP_SENTINEL.task &&
    value["after"] === ATTACHMENTS_DEP_SENTINEL.after
  );
}

function isRequiresSentinel(value: unknown): boolean {
  return (
    isRecord(value) && value["task"] === REQUIRES_DEP_SENTINEL.task && value["after"] === REQUIRES_DEP_SENTINEL.after
  );
}

// C0, DEL, C1, and the line and paragraph separators: a name stays one line in the seed.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
export const ATTACHMENT_NAME_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;
// The type is ASCII by this pattern, so its length is its byte count.
export const ATTACHMENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;

/**
 * A task spec's or spawn request's `attachments`, every entry checked and bounded and
 * built field by field. Null for anything malformed, an empty list included: the caller
 * nulls its spec or request rather than drop the field, since a task without the files
 * it was given must not run.
 */
export function parseAttachmentManifest(value: unknown): readonly AttachmentRef[] | null {
  const refs = parseList(value, parseAttachmentRef);
  if (refs === null || refs.length === 0 || refs.length > ATTACHMENT_LIMITS.files) return null;
  if (new Set(refs.map((ref) => ref.id)).size !== refs.length) return null;
  const total = refs.reduce((sum, ref) => sum + ref.size, 0);
  return total <= ATTACHMENT_LIMITS.totalBytes ? refs : null;
}

function parseAttachmentRef(value: unknown): AttachmentRef | null {
  if (!isRecord(value)) return null;
  const { id, name, type, size, hash } = value;
  if (typeof id !== "string" || !ATTACHMENT_ID_PATTERN.test(id)) return null;
  if (!isName(name, ATTACHMENT_LIMITS.name) || ATTACHMENT_NAME_FORBIDDEN.test(name)) return null;
  if (!isBoundedString(type, ATTACHMENT_LIMITS.type) || !ATTACHMENT_TYPE_PATTERN.test(type)) return null;
  if (!isUint(size) || size > ATTACHMENT_LIMITS.fileBytes) return null;
  if (typeof hash !== "string" || !ATTACHMENT_HASH_PATTERN.test(hash)) return null;
  return { id, name, type, size, hash };
}

/** `account` is an exclave's `accountId` as the leader read it: held to the same bound as a pin's. */
function parseSucceeds(value: unknown): TaskSpec["succeeds"] | null {
  if (!isRecord(value)) return null;
  const { task, account } = value;
  const at = parseTarget(value["at"]);
  const trigger = SUCCESSOR_TRIGGERS.find((t) => t === value["trigger"]);
  if (!isTaskId(task) || !isAccountId(account) || at === null || trigger === undefined) return null;
  // Only a quota pass carries it: a reseal must neither drop nor invent the field.
  const since = value["since"];
  if (since !== undefined && (trigger !== "quota" || !isFiniteNumber(since) || since < 0)) return null;
  return { task, account, at, trigger, ...(since === undefined ? {} : { since }) };
}

function parseContinues(value: unknown): TaskSpec["continues"] | null {
  if (!isRecord(value)) return null;
  const { task } = value;
  const at = parseTarget(value["at"]);
  return isTaskId(task) && at !== null ? { task, at } : null;
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
    case "draining":
    case "closed":
    case "task_id_unsupported":
    case "exclaves_unknown":
    case "pressure_unknown":
    case "repo_absent":
    case "continue_elsewhere":
    case "predecessor_account":
    case "continue_unsupported":
    case "attachments_unsupported":
    case "auth_missing":
    case "auth_expired":
    case "base_unpushed":
      return { code };
    case "skill_absent": {
      const { skill } = value;
      return isSkillName(skill) ? { code, skill } : null;
    }
    case "trait_absent":
    case "trait_unhealthy": {
      const { trait } = value;
      return isTraitName(trait) ? { code, trait } : null;
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
      return scope === "global" || scope === "account" ? { code, inFlight, max, scope } : null;
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
  const { keepFree } = value["components"];
  const { sticky, total } = value;
  const numbers = [accountPressure, machinePressure, dependencyDistance, queuePressure, sticky, total];
  if (!numbers.every(isFiniteNumber)) return null;
  return {
    components: {
      accountPressure: Number(accountPressure),
      machinePressure: Number(machinePressure),
      dependencyDistance: Number(dependencyDistance),
      queuePressure: Number(queuePressure),
      // Display-only, and `total` already carries its effect: an unreadable one is dropped, never the score.
      ...(isFiniteNumber(keepFree) ? { keepFree: Number(keepFree) } : {}),
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
    const { window, projectedPct, spending } = spill;
    if (!isBoundedString(window, WINDOW_LABEL_MAX_LENGTH) || !isFiniteNumber(projectedPct)) return null;
    if (spending !== undefined && spending !== true) return null;
    spilled = { window, projectedPct, ...(spending === undefined ? {} : { spending }) };
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
  const { prUrl, branch, pushed, merged, doneBy, needsInputSince, escalated, inputAlerted, endedAt, spillAlert } =
    value;
  const url = prUrl === undefined ? undefined : httpsUrl(prUrl);
  if (url === null) return null;
  if (branch !== undefined && (!isBoundedString(branch, BRANCH_MAX_LENGTH) || branch === "")) return null;
  if ((pushed !== undefined && pushed !== true) || (merged !== undefined && merged !== true)) return null;
  const signal = doneBy === undefined ? undefined : DONE_SIGNALS.find((s) => s === doneBy);
  if (doneBy !== undefined && signal === undefined) return null;
  if (
    !isOptionalFinite(needsInputSince) ||
    !isOptionalFinite(endedAt) ||
    (escalated !== undefined && escalated !== true) ||
    (inputAlerted !== undefined && inputAlerted !== true)
  )
    return null;
  const stamp = spillAlert === undefined ? undefined : parseSpillStamp(spillAlert);
  if (stamp === null) return null;
  return {
    ...(url === undefined ? {} : { prUrl: url }),
    ...(branch === undefined ? {} : { branch }),
    ...(pushed === undefined ? {} : { pushed }),
    ...(merged === undefined ? {} : { merged }),
    ...(signal === undefined ? {} : { doneBy: signal }),
    ...(needsInputSince === undefined ? {} : { needsInputSince }),
    ...(escalated === undefined ? {} : { escalated }),
    ...(inputAlerted === undefined ? {} : { inputAlerted }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(stamp === undefined ? {} : { spillAlert: stamp }),
  };
}

/**
 * The window a spill alert fired for, built field by field. `reset` is ms, 0 when the reading had none.
 * Exported so the writer stamps only what this reads back: a stamp it refused would void the task record.
 */
export function parseSpillStamp(value: unknown): SpillStamp | null {
  if (!isRecord(value)) return null;
  const { accountId, window, reset, at, spending } = value;
  if (!isAccountId(accountId) || !isName(window, WINDOW_LABEL_MAX_LENGTH)) return null;
  if (!isFiniteNumber(reset) || reset < 0 || !isFiniteNumber(at) || at < 0) return null;
  if (spending !== undefined && spending !== true) return null;
  return { accountId, window, reset, at, ...(spending === undefined ? {} : { spending }) };
}

function parseTaskPr(value: unknown): TaskPr | null {
  if (!isRecord(value)) return null;
  const { url, closed } = value;
  const href = httpsUrl(url);
  if (href === null || (closed !== undefined && closed !== true)) return null;
  return { url: href, ...(closed === undefined ? {} : { closed }) };
}

/** `Task.prs`, or null when malformed: past its bounds, a URL twice, or no `prUrl` among them to be primary. */
function parseTaskPrs(value: unknown, prUrl: string): readonly TaskPr[] | null {
  const prs = parseList(value, parseTaskPr);
  if (prs === null || prs.length === 0 || prs.length > TASK_PRS_MAX) return null;
  const urls = new Set(prs.map((pr) => pr.url));
  if (urls.size !== prs.length || !urls.has(prUrl)) return null;
  return prs.reduce((sum, pr) => sum + pr.url.length, 0) > TASK_PRS_MAX_LENGTH ? null : prs;
}

const COMMIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/** The failing required names: 1..`PR_FAILING_LIMITS.names` non-empty names, none over `.length` or with a control character. */
function parseFailing(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > PR_FAILING_LIMITS.names) return null;
  const names: string[] = [];
  for (const name of value) {
    if (!isName(name, PR_FAILING_LIMITS.length) || [...name].some(isControl)) return null;
    names.push(name);
  }
  return names;
}

/** A forge reading, or null when any field is malformed. A fresh object, so nothing unvalidated rides along. */
export function parsePrStatus(value: unknown): PrStatus | null {
  if (!isRecord(value)) return null;
  const { state, checks, stacked, at, head, required, failing, merge, armed, reviewRequested } = value;
  const known = PR_STATES.find((s) => s === state);
  if (known === undefined || !isFiniteNumber(at)) return null;
  const rollup = checks === undefined ? undefined : PR_CHECKS.find((c) => c === checks);
  if (checks !== undefined && rollup === undefined) return null;
  if (stacked !== undefined && stacked !== true) return null;
  if (head !== undefined && (typeof head !== "string" || !COMMIT_OID.test(head))) return null;
  const requiredRollup = required === undefined ? undefined : PR_CHECKS.find((c) => c === required);
  if (required !== undefined && requiredRollup === undefined) return null;
  const names = failing === undefined ? undefined : parseFailing(failing);
  if (names === null || (names !== undefined && requiredRollup !== "failing")) return null;
  const mergeState = merge === undefined ? undefined : PR_MERGE_STATES.find((m) => m === merge);
  if (merge !== undefined && mergeState === undefined) return null;
  if ((armed !== undefined && armed !== true) || (reviewRequested !== undefined && reviewRequested !== true)) {
    return null;
  }
  return {
    state: known,
    ...(rollup === undefined ? {} : { checks: rollup }),
    ...(stacked === undefined ? {} : { stacked }),
    ...(head === undefined ? {} : { head }),
    ...(requiredRollup === undefined ? {} : { required: requiredRollup }),
    ...(names === undefined ? {} : { failing: names }),
    ...(mergeState === undefined ? {} : { merge: mergeState }),
    ...(armed === undefined ? {} : { armed }),
    ...(reviewRequested === undefined ? {} : { reviewRequested }),
    at,
  };
}

/**
 * The stamp of the last `pr-blocked` alert, built field by field; null when malformed. Exported so
 * the writer stamps only what this reads back.
 */
export function parsePrAlertStamp(value: unknown): PrAlertStamp | null {
  if (!isRecord(value) || !Object.keys(value).every((key) => key === "reason" || key === "head" || key === "at")) {
    return null;
  }
  const { reason, head, at } = value;
  const known = PR_BLOCKED_REASONS.find((r) => r === reason);
  if (known === undefined || typeof head !== "string" || !COMMIT_OID.test(head) || !isFiniteNumber(at)) return null;
  return { reason: known, head, at };
}

/** The stamp of the last automatic quota pass or alert, built field by field; null when malformed. */
export function parseQuotaExhaustedStamp(value: unknown): QuotaExhaustedStamp | null {
  const keys = new Set(["accountId", "window", "reset", "at", "since", "retry", "waiting"]);
  if (!isRecord(value) || !Object.keys(value).every((key) => keys.has(key))) return null;
  const { accountId, window, reset, at, since, retry, waiting } = value;
  if (!isAccountId(accountId) || !isName(window, WINDOW_LABEL_MAX_LENGTH)) return null;
  if (!isFiniteNumber(reset) || reset < 0 || !isFiniteNumber(at) || at < 0) return null;
  if (since !== undefined && (!isFiniteNumber(since) || since < 0)) return null;
  if ((retry !== undefined && retry !== true) || (waiting !== undefined && waiting !== true)) return null;
  return {
    accountId,
    window,
    reset,
    at,
    ...(since === undefined ? {} : { since }),
    ...(retry === undefined ? {} : { retry }),
    ...(waiting === undefined ? {} : { waiting }),
  };
}

/** The stamp of the leader's last drain pass, built field by field; null when malformed. */
export function parseDrainedStamp(value: unknown): DrainedStamp | null {
  const keys = new Set(["at", "tried", "refused", "held"]);
  if (!isRecord(value) || !Object.keys(value).every((key) => keys.has(key))) return null;
  const { at, tried, refused, held } = value;
  if (!isFiniteNumber(at) || at <= 0 || !isFiniteNumber(tried) || tried < 0) return null;
  if (held !== undefined && held !== true) return null;
  const known = DRAIN_REFUSALS.find((r) => r === refused);
  if (refused !== undefined && known === undefined) return null;
  return {
    at,
    tried,
    ...(known === undefined ? {} : { refused: known }),
    ...(held === undefined ? {} : { held }),
  };
}

/** The leader's pointer to a task's newest landed continuation, built field by field; null when malformed. */
export function parseContinuedBy(value: unknown): ContinuedBy | null {
  if (!isRecord(value) || !Object.keys(value).every((key) => key === "task" || key === "createdAt" || key === "live")) {
    return null;
  }
  const { task, createdAt, live } = value;
  if (!isTaskId(task) || !isFiniteNumber(createdAt) || (live !== undefined && live !== true)) return null;
  return { task, createdAt, ...(live === true ? { live } : {}) };
}

/** A task's idle release stamp, built field by field; null when absent or malformed. */
function parseIdleRelease(value: unknown): IdleRelease | null {
  if (!isRecord(value) || !Object.keys(value).every((key) => key === "since" || key === "deviceId")) return null;
  const { since, deviceId } = value;
  return isFiniteNumber(since) && isRoutingId(deviceId) ? { since, deviceId } : null;
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
    successor,
  } = value;
  if (!isTaskId(id) || !isFiniteNumber(createdAt)) return null;
  const known = TASK_STATES.find((s) => s === state);
  if (known === undefined) return null;
  // Held to the states a pass lives in, so no writer produces a record every reader would hold unreadable:
  // `advance` drops it elsewhere. A `superseded` task without it names nothing for its dependents to follow.
  const passing = known === "running" || known === "needs-input" || known === "lost";
  if (successor !== undefined && (!isTaskId(successor) || !(passing || known === "superseded"))) return null;
  if (known === "superseded" && successor === undefined) return null;
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
  // Dropped, never fatal, like `pr`: without it the task stands on `prUrl`, as under an older leader.
  const prs =
    value["prs"] === undefined || progress.prUrl === undefined ? null : parseTaskPrs(value["prs"], progress.prUrl);
  // Apart from `progress`, like `pr`: a lost stamp costs one repeated alert, a fatal parse would hide the task.
  const prAlert = value["prAlert"] === undefined ? null : parsePrAlertStamp(value["prAlert"]);
  // Dropped, never fatal, like `prAlert`: a lost stamp costs one repeated alert.
  const quotaExhausted =
    value["quotaExhausted"] === undefined ? null : parseQuotaExhaustedStamp(value["quotaExhausted"]);
  // Dropped, never fatal: a lost stamp costs one repeated drain attempt.
  const drained = value["drained"] === undefined ? null : parseDrainedStamp(value["drained"]);
  // Apart from `progress` too: the leader rewrites it on its next pass, so a lost one costs a pass.
  const continuedBy = value["continuedBy"] === undefined ? null : parseContinuedBy(value["continuedBy"]);
  // Dropped, never fatal, and only a `running` task's: a lost one costs a release until the next `idle`.
  const idleRelease = known === "running" ? parseIdleRelease(value["idleRelease"]) : null;
  // Dropped, never fatal, like `prAlert`: display-only.
  const flag = value["flag"] === undefined ? null : parseTaskFlag(value["flag"]);
  const { remoteSession, inputReason, inputTool } = value;
  const waiting = known === "needs-input" || known === "lost";
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
    ...(successor === undefined ? {} : { successor }),
    ...progress,
    ...(pr === null ? {} : { pr }),
    ...(prs === null ? {} : { prs }),
    ...(prAlert === null ? {} : { prAlert }),
    ...(quotaExhausted === null ? {} : { quotaExhausted }),
    ...(drained === null ? {} : { drained }),
    ...(continuedBy === null ? {} : { continuedBy }),
    ...(idleRelease === null ? {} : { idleRelease }),
    ...(flag === null ? {} : { flag }),
    // Dropped, never fatal, like `pr`: a link is display-only.
    ...(isRemoteSessionId(remoteSession) ? { remoteSession } : {}),
    // Dropped, never fatal, like `remoteSession`: display-only. Only on the states a wait lives in
    // (`inputClock` keeps it into `lost`): elsewhere it could only be a bug's, and the store bound
    // need not fit one beside a `failure`.
    ...(waiting && isNeedsInputReason(inputReason) ? { inputReason } : {}),
    ...(waiting && inputReason === "permission" && isToolName(inputTool) ? { inputTool } : {}),
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
  // A task that continues itself has no earlier launch to resume; the daemon would only refuse it, so it never dispatches.
  if (record.task.spec.continues?.task === record.task.id) return "malformed";
  // Likewise a successor of itself: it would wait on its own `superseded` for ever.
  if (record.task.spec.succeeds?.task === record.task.id) return "malformed";
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

/** `isBase64UrlBytes` without the padding form: what `generateVapidKeys` writes, so a padded VAPID key is not ours. */
function isUnpaddedBase64UrlBytes(value: unknown, bytes: number): value is string {
  return isBase64UrlBytes(value, bytes) && !value.includes("=");
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
  return serviceHostOf(host) === undefined ? null : href;
}

/** The `PUSH_SERVICE_HOSTS` entry a host matches: a `*.` entry any non-empty subdomain, never the bare host. */
function serviceHostOf(host: string): (typeof PUSH_SERVICE_HOSTS)[number] | undefined {
  return PUSH_SERVICE_HOSTS.find((entry) =>
    entry.startsWith("*.") ? host.length > entry.length - 1 && host.endsWith(entry.slice(1)) : host === entry,
  );
}

/** The browser family behind an allowed endpoint's push service, or null for an endpoint `pushEndpoint` refuses. */
export function pushServiceVendor(endpoint: string): string | null {
  const href = pushEndpoint(endpoint);
  if (href === null) return null;
  const entry = serviceHostOf(new URL(href).hostname);
  return entry === undefined ? null : PUSH_SERVICE_VENDORS[entry];
}

/**
 * No control (`Cc`), format (`Cf`: bidi, zero-width) or surrogate (`Cs`) character. `isName` alone
 * admits characters JSON escapes to six bytes, so a few crafted fields could seal the settings
 * record over the store's cap. `\p{Cs}` under `u` matches only a lone surrogate, and unlike
 * `isWellFormed()` it runs in the browsers `shared/` also ships to.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}]/u;
function isPrintableName(value: unknown, max: number): value is string {
  return isName(value, max) && !UNPRINTABLE.test(value);
}

/** A subscription label: printable and trimmed. Shown on other devices, where a bidi or zero-width character could disguise a row. */
function isPushLabel(value: unknown): value is string {
  return isPrintableName(value, PUSH_LABEL_MAX_LENGTH) && value === value.trim();
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

/** A record entry, leniently: a bad `label` or `addedAt` drops that field, never the subscription. */
function parsePushSubscriptionEntry(value: unknown): PushSubscriptionEntry | null {
  const sub = parseWebPushSubscription(value);
  if (sub === null || !isRecord(value)) return null;
  const { label, addedAt } = value;
  return {
    ...sub,
    ...(isPushLabel(label) ? { label } : {}),
    ...(isUint(addedAt) ? { addedAt } : {}),
  };
}

/**
 * `push-subscribe`, at the leader: the subscription built field by field, its
 * endpoint held to the push-service allowlist (decided #10), so a forged one
 * cannot aim the leader at an arbitrary URL. The optional `label` is strict
 * here, since the request is untrusted input: a bad one refuses the request.
 */
export function parsePushSubscribeRequest(value: unknown): PushSubscribeRequest | null {
  const sub = parseWebPushSubscription(value);
  if (sub === null || !isRecord(value)) return null;
  const { label } = value;
  if (label === undefined) return sub;
  return isPushLabel(label) ? { ...sub, label } : null;
}

export function parsePushSubscribeReply(value: unknown): PushSubscribeReply | null {
  if (isRecord(value) && value["ok"] === false) return parseSchedulerError(value);
  const endpoint = isRecord(value) ? pushEndpoint(value["endpoint"]) : null;
  return endpoint === null ? null : { endpoint };
}

/**
 * `push-unsubscribe`, at the leader: a fresh `{ endpoint }`, held to `pushEndpoint` as a
 * subscription's is. The record holds no endpoint that fails it, so nothing removable is
 * refused, and the normalized form is the one the record stores.
 */
export function parsePushUnsubscribeRequest(value: unknown): PushUnsubscribeRequest | null {
  const endpoint = isRecord(value) ? pushEndpoint(value["endpoint"]) : null;
  return endpoint === null ? null : { endpoint };
}

export function parsePushUnsubscribeReply(value: unknown): PushUnsubscribeReply | null {
  if (isRecord(value) && value["ok"] === false) return parseSchedulerError(value);
  const endpoint = isRecord(value) ? pushEndpoint(value["endpoint"]) : null;
  return endpoint === null ? null : { endpoint };
}

const PUSH_ALERT_KEYS = {
  spill: ["v", "kind", "at", "taskId", "window", "projectedPct", "spending"],
  "needs-input": ["v", "kind", "at", "taskId", "since", "escalated", "question"],
  disk: ["v", "kind", "at", "deviceId", "diskPct", "freeMib"],
  "pr-blocked": ["v", "kind", "at", "taskId", "reason"],
  "quota-exhausted": ["v", "kind", "at", "taskId", "window", "reason"],
  "pass-refused": ["v", "kind", "at", "taskId"],
  auth: ["v", "kind", "at", "deviceId", "exclave", "state"],
  archivist: ["v", "kind", "at", "since"],
  flag: ["v", "kind", "at", "taskId", "reason"],
  "custodian-failing": ["v", "kind", "at", "deviceId"],
} as const;

/**
 * A push payload as the daemon built it, read back where it is shown or tested: built field
 * by field and strict — a key it does not name, or a kind this build does not know, reads as
 * null, so free text can never ride along — and at most `PUSH_ALERT_MAX_BYTES` serialized.
 */
export function parsePushAlert(value: unknown): PushAlert | null {
  if (!isRecord(value) || value["v"] !== 1 || !isFiniteNumber(value["at"])) return null;
  if (new TextEncoder().encode(JSON.stringify(value)).length > PUSH_ALERT_MAX_BYTES) return null;
  const { kind, at } = value;
  const known = (keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
  if (kind === "spill") {
    const { taskId, window, projectedPct, spending } = value;
    if (!known(PUSH_ALERT_KEYS.spill) || !isTaskId(taskId)) return null;
    if (!isName(window, WINDOW_LABEL_MAX_LENGTH) || !isFiniteNumber(projectedPct)) return null;
    if (spending !== undefined && spending !== true) return null;
    return { v: 1, kind, at, taskId, window, projectedPct, ...(spending === undefined ? {} : { spending }) };
  }
  if (kind === "needs-input") {
    const { taskId, since, escalated, question } = value;
    if (!known(PUSH_ALERT_KEYS["needs-input"]) || !isTaskId(taskId)) return null;
    if (!isFiniteNumber(since) || typeof escalated !== "boolean") return null;
    if (question !== undefined && question !== true) return null;
    return { v: 1, kind, at, taskId, since, escalated, ...(question === undefined ? {} : { question }) };
  }
  if (kind === "disk") {
    const { deviceId, diskPct, freeMib } = value;
    if (!known(PUSH_ALERT_KEYS.disk) || !isRoutingId(deviceId)) return null;
    if ((diskPct !== undefined && !isFiniteNumber(diskPct)) || (freeMib !== undefined && !isFiniteNumber(freeMib))) {
      return null;
    }
    return {
      v: 1,
      kind,
      at,
      deviceId,
      ...(diskPct === undefined ? {} : { diskPct }),
      ...(freeMib === undefined ? {} : { freeMib }),
    };
  }
  if (kind === "pr-blocked") {
    const { taskId, reason } = value;
    const blockedReason = PR_BLOCKED_REASONS.find((r) => r === reason);
    if (!known(PUSH_ALERT_KEYS["pr-blocked"]) || !isTaskId(taskId) || blockedReason === undefined) return null;
    return { v: 1, kind, at, taskId, reason: blockedReason };
  }
  if (kind === "quota-exhausted") {
    const { taskId, window, reason } = value;
    if (!known(PUSH_ALERT_KEYS["quota-exhausted"]) || !isTaskId(taskId) || !isName(window, WINDOW_LABEL_MAX_LENGTH)) {
      return null;
    }
    const why = QUOTA_ALERT_REASONS.find((r) => r === reason);
    if (reason !== undefined && why === undefined) return null;
    return { v: 1, kind, at, taskId, window, ...(why === undefined ? {} : { reason: why }) };
  }
  if (kind === "pass-refused") {
    const { taskId } = value;
    if (!known(PUSH_ALERT_KEYS["pass-refused"]) || !isTaskId(taskId)) return null;
    return { v: 1, kind, at, taskId };
  }
  if (kind === "auth") {
    const { deviceId, exclave, state } = value;
    if (!known(PUSH_ALERT_KEYS.auth) || !isRoutingId(deviceId) || !isRoutingId(exclave)) return null;
    if (state !== "expired" && state !== "expiring") return null;
    return { v: 1, kind, at, deviceId, exclave, state };
  }
  if (kind === "archivist") {
    const { since } = value;
    if (!known(PUSH_ALERT_KEYS.archivist) || !isFiniteNumber(since)) return null;
    return { v: 1, kind, at, since };
  }
  if (kind === "flag") {
    const { taskId, reason } = value;
    if (!known(PUSH_ALERT_KEYS.flag) || !isTaskId(taskId) || !isFlagReason(reason)) return null;
    return { v: 1, kind, at, taskId, reason };
  }
  if (kind === "custodian-failing") {
    const { deviceId } = value;
    if (!known(PUSH_ALERT_KEYS["custodian-failing"]) || !isRoutingId(deviceId)) return null;
    return { v: 1, kind, at, deviceId };
  }
  return null;
}

const VAPID_PUBLIC_BYTES = 65;
const VAPID_PRIVATE_BYTES = 32;

function parseVapidKeys(value: unknown): VapidKeys | null {
  if (!isRecord(value)) return null;
  const { publicKey, privateKey } = value;
  if (
    !isUnpaddedBase64UrlBytes(publicKey, VAPID_PUBLIC_BYTES) ||
    !isUnpaddedBase64UrlBytes(privateKey, VAPID_PRIVATE_BYTES)
  ) {
    return null;
  }
  return { publicKey, privateKey };
}

/**
 * The opened body of the settings record. Strict, as the pause record is: the
 * leader writes it back whole, so a part dropped here — the VAPID key above
 * all, which every subscription is bound to — would be lost on the next write.
 * Subscriptions alone are read leniently: one that fails `parseWebPushSubscription`
 * (a host a later build no longer allows) is dropped and goes with the leader's next
 * write, rather than making the whole record — the VAPID key, the Linear key, every
 * other browser — unreadable. The cap and one-per-endpoint still refuse the record.
 * `label` and `addedAt` are read more leniently still: a bad one drops that field,
 * never the subscription.
 */
export function parseSettingsRecord(value: unknown): SettingsRecord | null {
  if (!isRecord(value) || !isVersion(value["version"])) return null;
  const { vapid, linearKey, subscriptions, diskAlerts, authAlerts, archivistSilence } = value;
  const keys = vapid === undefined ? undefined : parseVapidKeys(vapid);
  if (keys === null) return null;
  if (linearKey !== undefined && !isPrintableName(linearKey, LINEAR_KEY_MAX_LENGTH)) return null;
  let subscribed: readonly PushSubscriptionEntry[] | undefined;
  if (subscriptions !== undefined) {
    if (!Array.isArray(subscriptions) || subscriptions.length > PUSH_MAX_SUBSCRIPTIONS) return null;
    const parsed = subscriptions.flatMap((candidate) => parsePushSubscriptionEntry(candidate) ?? []);
    // One subscription per endpoint, as `parseFleetQuotaRecord` has one entry per account.
    if (new Set(parsed.map((sub) => sub.endpoint)).size !== parsed.length) return null;
    subscribed = parsed;
  }
  const disk = diskAlerts === undefined ? undefined : parseDiskAlerts(diskAlerts);
  if (disk === null) return null;
  const auth = authAlerts === undefined ? undefined : parseAuthAlerts(authAlerts);
  if (auth === null) return null;
  const silence = archivistSilence === undefined ? undefined : parseArchivistSilence(archivistSilence);
  if (silence === null) return null;
  return {
    version: value["version"],
    ...(keys === undefined ? {} : { vapid: keys }),
    ...(linearKey === undefined ? {} : { linearKey }),
    ...(subscribed === undefined ? {} : { subscriptions: subscribed }),
    ...(disk === undefined ? {} : { diskAlerts: disk }),
    ...(auth === undefined ? {} : { authAlerts: auth }),
    ...(silence === undefined ? {} : { archivistSilence: silence }),
  };
}

function parseArchivistSilence(value: unknown): ArchivistSilence | null {
  if (!isRecord(value)) return null;
  const { state, since } = value;
  if (state === "present") return Object.keys(value).length === 1 ? { state } : null;
  if (state !== "absent" && state !== "alerted") return null;
  if (Object.keys(value).length !== 2) return null;
  // A valid Date, since the leader formats it for its log line.
  if (typeof since !== "number" || !Number.isSafeInteger(since) || since < 0 || since > MAX_DATE_MS) return null;
  return { state, since };
}

/** One entry per device and exclave. */
function parseAuthAlerts(value: unknown): readonly AuthAlerted[] | null {
  if (!Array.isArray(value) || value.length > AUTH_ALERTS_MAX) return null;
  const parsed = parseList(value, (entry): AuthAlerted | null => {
    if (!isRecord(entry)) return null;
    const { deviceId, exclave, state, at } = entry;
    if (!isRoutingId(deviceId) || !isRoutingId(exclave) || !isFiniteNumber(at)) return null;
    if (state !== "expired" && state !== "expiring") return null;
    return { deviceId, exclave, state, at };
  });
  if (parsed === null) return null;
  if (new Set(parsed.map((e) => `${e.deviceId}\n${e.exclave}`)).size !== parsed.length) return null;
  return parsed;
}

/** One entry per machine, as `subscriptions` has one per endpoint. */
function parseDiskAlerts(value: unknown): readonly DiskAlerted[] | null {
  if (!Array.isArray(value) || value.length > DISK_ALERTS_MAX) return null;
  const parsed = parseList(value, (entry): DiskAlerted | null => {
    if (!isRecord(entry) || !isRoutingId(entry["deviceId"]) || !isFiniteNumber(entry["at"])) return null;
    return { deviceId: entry["deviceId"], at: entry["at"] };
  });
  if (parsed === null || new Set(parsed.map((e) => e.deviceId)).size !== parsed.length) return null;
  return parsed;
}

/** `cancel`, `mark-done` and `run-now`, at the leader: the one field, nothing else carried on. */
export function parseTaskRef(value: unknown): TaskRef | null {
  return isRecord(value) && isTaskId(value["taskId"]) ? { taskId: value["taskId"] } : null;
}

const AMEND_REQUEST_KEYS: ReadonlySet<string> = new Set(["taskId", "prompt", "basis", "title", "model", "effort"]);
const AMEND_PROMPT_KEYS: ReadonlySet<string> = new Set(["mode", "text"]);

function onlyKeys(value: Record<string, unknown>, known: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => known.has(key));
}

/** A field an amendment sets, or `null` to drop it; `undefined` when the value is neither. */
function amendField(value: unknown, max: number, empty: boolean): string | null | undefined {
  if (value === null) return null;
  return isBoundedString(value, max) && (empty || value !== "") ? value : undefined;
}

/**
 * `amend`, at the leader, which rewrites a task from it: built field by field, each held to
 * `TASK_REQUEST_LIMITS` as a create's is (an empty model or effort would reach the spawn as a flag
 * with no value; `null` drops one). `basis` comes exactly with `prompt`; an append of nothing, or an
 * amendment of nothing, is malformed. The amended prompt's own bound is the leader's (`amendSpec`),
 * since it depends on the task.
 *
 * Unlike most parsers here, a key it does not know refuses the whole request rather than being
 * dropped: an amendment is a set of changes, and a leader that applied some and ignored a field a
 * newer client added (deps, planned) would answer `ok` for a change it never made.
 */
export function parseAmendRequest(value: unknown): AmendRequest | null {
  if (!isRecord(value) || !isTaskId(value["taskId"])) return null;
  if (!onlyKeys(value, AMEND_REQUEST_KEYS)) return null;
  const { prompt, basis } = value;
  const limits = TASK_REQUEST_LIMITS;
  let amended: AmendRequest["prompt"];
  if (prompt !== undefined) {
    if (!isRecord(prompt) || !onlyKeys(prompt, AMEND_PROMPT_KEYS) || !isPromptBasis(basis)) return null;
    const mode = AMEND_MODES.find((m) => m === prompt["mode"]);
    const text = prompt["text"];
    if (mode === undefined || !isBoundedString(text, limits.prompt)) return null;
    if (mode === "append" && text.trim() === "") return null;
    amended = { mode, text };
  } else if (basis !== undefined) return null;
  const { title, model, effort } = value;
  const titled = title === undefined ? undefined : amendField(title, limits.title, true);
  const modelled = model === undefined ? undefined : amendField(model, limits.model, false);
  const efforted = effort === undefined ? undefined : amendField(effort, limits.effort, false);
  if ((title !== undefined && titled === undefined) || (model !== undefined && modelled === undefined)) return null;
  if (effort !== undefined && efforted === undefined) return null;
  if (amended === undefined && titled === undefined && modelled === undefined && efforted === undefined) return null;
  return {
    taskId: value["taskId"],
    ...(amended === undefined || !isPromptBasis(basis) ? {} : { prompt: amended, basis }),
    ...(titled === undefined ? {} : { title: titled }),
    ...(modelled === undefined ? {} : { model: modelled }),
    ...(efforted === undefined ? {} : { effort: efforted }),
  };
}

/**
 * `push-branch`, at the daemon holding the task. `expect`, when given, is a branch name the daemon
 * will hand to git, so it is held to `isBranchName` here, once, for every route in.
 */
export function parsePushBranchRequest(value: unknown): PushBranchRequest | null {
  if (!isRecord(value) || !isTaskId(value["taskId"])) return null;
  const { expect } = value;
  if (expect === undefined) return { taskId: value["taskId"] };
  return isBranchName(expect) ? { taskId: value["taskId"], expect } : null;
}

/** A `push-branch` answer at the leader: `remoteBranch` is validated before it is compared or named in a prompt. */
export function parsePushBranchResponse(value: unknown): PushBranchResponse | null {
  if (!isRecord(value)) return null;
  if (value["ok"] === false) {
    const code = PUSH_BRANCH_ERROR_CODES.find((c) => c === value["code"]);
    return code === undefined || typeof value["message"] !== "string"
      ? null
      : { ok: false, code, message: value["message"] };
  }
  const { remoteBranch, tip, pushed } = value;
  if (value["ok"] !== true || !isBranchName(remoteBranch) || typeof tip !== "string" || !COMMIT_OID.test(tip)) {
    return null;
  }
  return typeof pushed === "boolean" ? { ok: true, remoteBranch, tip, pushed } : null;
}

/** `availability`, at the daemon: `now` is kept only as `true` (the drain's no-wait); a non-boolean refuses the request. */
export function parseAvailabilityRequest(value: unknown): AvailabilityRequest | null {
  if (!isRecord(value) || typeof value["open"] !== "boolean") return null;
  const { now } = value;
  if (now !== undefined && typeof now !== "boolean") return null;
  return { open: value["open"], ...(now === true ? { now: true as const } : {}) };
}

/** An `availability` answer at a client: a code it does not know reads as a failure. */
export function parseAvailabilityResponse(value: unknown): AvailabilityResponse | null {
  if (!isRecord(value)) return null;
  if (value["ok"] === true) {
    const { closed } = value;
    if (closed === null) return { ok: true, closed: null };
    return isFiniteNumber(closed) && closed > 0 ? { ok: true, closed } : null;
  }
  const code = AVAILABILITY_ERROR_CODES.find((c) => c === value["code"]);
  if (value["ok"] !== false || code === undefined || typeof value["message"] !== "string") return null;
  return { ok: false, code, message: value["message"] };
}

/** `pass-close`, at the daemon holding the task. */
export function parsePassCloseRequest(value: unknown): PassCloseRequest | null {
  return isRecord(value) && isTaskId(value["taskId"]) ? { taskId: value["taskId"] } : null;
}

/** A `pass-close` answer at the leader: only the fields it acts on, a code it does not know reading as a failure to arm. */
export function parsePassCloseResponse(value: unknown): PassCloseResponse | null {
  if (!isRecord(value)) return null;
  if (value["ok"] === true) return { ok: true };
  const code = PASS_CLOSE_ERROR_CODES.find((c) => c === value["code"]);
  if (value["ok"] !== false || code === undefined || typeof value["message"] !== "string") return null;
  return { ok: false, code, message: value["message"] };
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
  const listedIdle = value["idle"];
  if (listedIdle !== undefined && (!Array.isArray(listedIdle) || listedIdle.length > MAX_TASKS)) return null;
  // Lenient per entry too: a bad one shows its task as running, which it is.
  const idle = listedIdle?.map(parseIdleTaskRef).filter((entry) => entry !== null);
  // Lenient: a cap that is not a positive integer only costs the header its denominator.
  const globalMax = value["globalMax"];
  const cap = typeof globalMax === "number" && Number.isInteger(globalMax) && globalMax > 0 ? globalMax : undefined;
  return {
    tasks,
    at: value["at"],
    ...(holds === undefined ? {} : { holds }),
    ...(unreadable === undefined || unreadable.length === 0 ? {} : { unreadable }),
    ...(idle === undefined || idle.length === 0 ? {} : { idle }),
    ...(cap === undefined ? {} : { globalMax: cap }),
  };
}

function parseIdleTaskRef(value: unknown): IdleTaskRef | null {
  if (!isRecord(value) || !isTaskId(value["taskId"]) || !isFiniteNumber(value["since"])) return null;
  return { taskId: value["taskId"], since: value["since"] };
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

/** `cancel`, `mark-done` and `run-now` replies. */
export function parseTaskReply(value: unknown): TaskReply | null {
  if (isRecord(value) && value["ok"] === false) return parseSchedulerError(value);
  const task = isRecord(value) ? parseTask(value["task"]) : null;
  return task === null ? null : { task };
}

/** `pass` replies. The successor is display-only, so one this build cannot read costs the field, not the reply. */
export function parsePassReply(value: unknown): PassReply | null {
  if (isRecord(value) && value["ok"] === false) return parseSchedulerError(value);
  if (!isRecord(value) || !isTaskId(value["successorId"])) return null;
  const task = parseTask(value["task"]);
  if (task === null) return null;
  const successor = value["successor"] === null ? null : parseTask(value["successor"]);
  return { task, successorId: value["successorId"], successor };
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

/**
 * `SessionsResponse.interrupted`, at the leader: only task ids that are also in
 * `ended`. The reply comes from a remote PSK holder, so a bad entry falls back
 * to today's behaviour (`done`), never to a re-dispatch.
 */
export function parseInterrupted(value: unknown, ended: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !Array.isArray(ended) || value.length > SESSIONS_MAX_PROGRESS) return undefined;
  const kept = value.filter((id): id is string => isTaskId(id) && ended.includes(id));
  return kept.length === 0 ? undefined : kept;
}

function parseTaskProgress(value: unknown): TaskProgress | null {
  if (!isRecord(value)) return null;
  const { taskId, prUrl, branch, pushed, merged, reported, exit, oomKill, vanished, at } = value;
  if (!isTaskId(taskId) || !isFiniteNumber(at)) return null;
  if (exit !== undefined && (!isUint(exit) || exit > EXIT_STATUS_MAX)) return null;
  const url = prUrl === undefined ? undefined : httpsUrl(prUrl);
  if (url === null) return null;
  if (branch !== undefined && !isName(branch, BRANCH_MAX_LENGTH)) return null;
  if ((pushed !== undefined && pushed !== true) || (merged !== undefined && merged !== true)) return null;
  if (reported !== undefined && reported !== true) return null;
  if (vanished !== undefined && vanished !== true) return null;
  return {
    taskId,
    at,
    ...(url === undefined ? {} : { prUrl: url }),
    ...(branch === undefined ? {} : { branch }),
    ...(pushed === undefined ? {} : { pushed }),
    ...(merged === undefined ? {} : { merged }),
    ...(reported === undefined ? {} : { reported }),
    ...(exit === undefined ? {} : { exit }),
    ...(vanished === undefined ? {} : { vanished }),
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
