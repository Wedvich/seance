import {
  METRICS_ERROR_CODES,
  METRICS_MAX_FILTER_LENGTH,
  METRICS_MAX_FILTERS,
  METRICS_MAX_POINTS,
  METRICS_STEPS,
  QUOTA_SOURCES,
  SCHEDULER_ERROR_CODES,
  SCHEDULER_OPS,
  SESSION_STATES,
  SPAWN_ERROR_CODES,
  TASK_ID_PATTERN,
  TASK_REQUEST_LIMITS,
  TASK_STATES,
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
  type SubmitReply,
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

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseUintList(value: unknown): readonly number[] | null {
  return Array.isArray(value) && value.every(isUint) ? value : null;
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
  return {
    name: value["name"],
    path: value["path"],
    defaultBranch,
    ...(exclave === undefined ? {} : { exclave }),
    ...(origin === undefined ? {} : { origin }),
  };
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
  if (typeof value["authOk"] !== "boolean") return null;
  const skills = value["skills"];
  if (!isStringArray(skills)) return null;
  return {
    id: value["id"],
    accountId,
    ...(email === undefined || email === "" ? {} : { email }),
    extraUsageEnabled,
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

/**
 * The decrypted register blob. Inside the PSK boundary, so this is skew
 * tolerance rather than defence: a daemon a version ahead or behind must cost
 * one machine tile, not the render — `machine.repos.map(…)` runs on every frame
 * of the spawn screen. A projection of the fields the app reads:
 * `source`/`lastUpdate` back the daemon's own doctor/status surfaces and no
 * app-role client renders them.
 */
export function parseMachineInfo(value: unknown): MachineInfo | null {
  if (!isRecord(value)) return null;
  if (typeof value["name"] !== "string" || typeof value["platform"] !== "string") return null;
  if (typeof value["scannedAt"] !== "number") return null;
  const repos = parseRepoList(value["repos"]);
  if (repos === null) return null;
  // Both optional and both skew-tolerant in the other direction from `repos`: a
  // malformed exclave list costs the exclaves (the machine reads as an old
  // daemon, ineligible for `auto`), never the tile. Unknown capability strings
  // pass through — a reader asks for the ones it knows.
  const exclaves = value["exclaves"] === undefined ? undefined : parseExclaveList(value["exclaves"]);
  const capabilities = value["capabilities"];
  return {
    name: value["name"],
    platform: value["platform"],
    repos,
    scannedAt: value["scannedAt"],
    ...(exclaves === undefined || exclaves === null ? {} : { exclaves }),
    ...(isStringArray(capabilities) ? { capabilities } : {}),
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

function parseQuotaObservation(value: unknown): QuotaObservation | null {
  if (!isRecord(value)) return null;
  if (!isUint(value["x"]) || !isUint(value["at"]) || !isQuotaSource(value["s"])) return null;
  const { h, d, hr, dr } = value;
  if (!isOptionalUint(h) || !isOptionalUint(d) || !isOptionalUint(hr) || !isOptionalUint(dr)) return null;
  const w = value["w"] === undefined ? undefined : parseList(value["w"], parseScopedWindow);
  if (w === null) return null;
  return {
    x: value["x"],
    s: value["s"],
    at: value["at"],
    ...(h === undefined ? {} : { h }),
    ...(d === undefined ? {} : { d }),
    ...(hr === undefined ? {} : { hr }),
    ...(dr === undefined ? {} : { dr }),
    ...(w === undefined ? {} : { w }),
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
 * The leader's check on a forwarded event. The sender is a PSK holder, so this
 * is skew and bug hygiene rather than a trust boundary — the daemon already
 * bound the event to its pane — but a `prUrl` is re-checked all the same: it is
 * the one field that reaches an `href`.
 */
export function parseSessionEvent(value: unknown): SessionEvent | null {
  if (!isRecord(value)) return null;
  const { session, taskId, exclave, state, prUrl, at } = value;
  if (typeof session !== "string" || session === "" || session.length > 64) return null;
  if (!isTaskId(taskId) || typeof exclave !== "string" || exclave.length > 64) return null;
  if (!isSessionState(state) || typeof at !== "number" || !Number.isFinite(at)) return null;
  const url = prUrl === undefined ? null : httpsUrl(prUrl);
  if (prUrl !== undefined && url === null) return null;
  return { session, taskId, exclave, state, at, ...(url === null ? {} : { prUrl: url }) };
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
  const { repo, mode, prompt, title, model, effort, plan } = value;
  const limits = TASK_REQUEST_LIMITS;
  if (!isBoundedString(repo, limits.repo) || repo === "") return null;
  if (mode !== "worktree" && mode !== "here") return null;
  if (prompt !== undefined && !isBoundedString(prompt, limits.prompt)) return null;
  if (title !== undefined && !isBoundedString(title, limits.title)) return null;
  // Empty would reach the spawn as a flag with no value; absent is how a default is asked for.
  if (model !== undefined && (!isBoundedString(model, limits.model) || model === "")) return null;
  if (effort !== undefined && (!isBoundedString(effort, limits.effort) || effort === "")) return null;
  if (plan !== undefined && typeof plan !== "boolean") return null;
  return {
    repo,
    mode,
    ...(prompt === undefined ? {} : { prompt }),
    ...(title === undefined ? {} : { title }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(plan === undefined ? {} : { plan }),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseTarget(value: unknown): Target | null {
  if (!isRecord(value)) return null;
  const { deviceId, exclave, clone } = value;
  if (typeof deviceId !== "string" || typeof exclave !== "string" || typeof clone !== "string") return null;
  return { deviceId, exclave, clone };
}

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
      return { code };
    case "disk_low":
      return isFiniteNumber(value["freeMib"]) ? { code, freeMib: value["freeMib"] } : null;
    case "pin_mismatch": {
      const field = value["field"];
      return field === "deviceId" || field === "exclave" ? { code, field } : null;
    }
    case "quota_unknown": {
      const why = value["why"];
      return why === "unobserved" || why === "trimmed" ? { code, why } : null;
    }
    case "quota_over_line": {
      const { window, projectedPct } = value;
      return typeof window === "string" && isFiniteNumber(projectedPct) ? { code, window, projectedPct } : null;
    }
    case "cap_reached": {
      const { inFlight, max } = value;
      return isUint(inFlight) && isUint(max) ? { code, inFlight, max } : null;
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
  if (typeof deviceId !== "string" || typeof machine !== "string") return null;
  if (exclave !== null && typeof exclave !== "string") return null;
  if (!isOptionalString(clone) || !Array.isArray(rejected)) return null;
  const reasons = rejected.map(parseReason).filter((reason) => reason !== null);
  const parsedScore = score === undefined ? undefined : parseScore(score);
  if (parsedScore === null) return null;
  let basis: QuotaBasis | undefined;
  if (quota !== undefined) {
    if (!isRecord(quota) || !isUint(quota["observedAt"]) || typeof quota["observer"] !== "string") return null;
    const source = QUOTA_SOURCES.find((s) => s === quota["source"]);
    if (source === undefined) return null;
    basis = { observedAt: quota["observedAt"], observer: quota["observer"], source };
  }
  let spilled: Candidate["spill"];
  if (spill !== undefined) {
    if (!isRecord(spill) || typeof spill["window"] !== "string" || !isFiniteNumber(spill["projectedPct"])) return null;
    spilled = { window: spill["window"], projectedPct: spill["projectedPct"] };
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
 * missing loser would misstate why the winner won.
 */
export function parseDecision(value: unknown): Decision | null {
  if (!isRecord(value) || !isFiniteNumber(value["at"])) return null;
  const chosen = value["chosen"] === null ? null : parseTarget(value["chosen"]);
  if (value["chosen"] !== null && chosen === null) return null;
  const candidates = parseList(value["candidates"], parseCandidate);
  if (candidates === null) return null;
  return { at: value["at"], chosen, candidates };
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
  if (!isOptionalString(window) || !isOptionalString(pane)) return null;
  return { ...target, ...(window === undefined ? {} : { window }), ...(pane === undefined ? {} : { pane }) };
}

/**
 * A task as `queue` and `submit` carry it — the fields the app shows. A state
 * this build does not know nulls the task: it cannot say what the task is
 * doing, and guessing would be worse than leaving it out.
 */
export function parseTask(value: unknown): Task | null {
  if (!isRecord(value)) return null;
  const { id, state, createdAt, spec, assignment, reservation, decision, failure, absentSince } = value;
  if (typeof id !== "string" || !isFiniteNumber(createdAt)) return null;
  const known = TASK_STATES.find((s) => s === state);
  if (known === undefined || !isRecord(spec)) return null;
  const request = parseTaskRequest(spec);
  if (request === null) return null;
  const placed = assignment === undefined ? undefined : parseAssignment(assignment);
  const reserved = reservation === undefined ? undefined : parseReservation(reservation);
  const record = decision === undefined ? undefined : parseDecision(decision);
  if (placed === null || reserved === null || record === null) return null;
  if (absentSince !== undefined && !isFiniteNumber(absentSince)) return null;
  let failed: Task["failure"];
  if (failure !== undefined) {
    if (!isRecord(failure) || typeof failure["code"] !== "string" || typeof failure["message"] !== "string")
      return null;
    failed = { code: failure["code"], message: failure["message"] };
  }
  return {
    id,
    state: known,
    createdAt,
    spec: request,
    ...(placed === undefined ? {} : { assignment: placed }),
    ...(reserved === undefined ? {} : { reservation: reserved }),
    ...(record === undefined ? {} : { decision: record }),
    ...(failed === undefined ? {} : { failure: failed }),
    ...(absentSince === undefined ? {} : { absentSince }),
  };
}

/** A scheduler refusal; an unknown code is no refusal this build can word, so the reply is unreadable. */
function parseSchedulerError(value: unknown): SchedulerError | null {
  if (!isRecord(value) || value["ok"] !== false || typeof value["message"] !== "string") return null;
  const code = SCHEDULER_ERROR_CODES.find((c) => c === value["code"]);
  return code === undefined ? null : { ok: false, code, message: value["message"] };
}

export function parseQueueReply(value: unknown): QueueReply | null {
  if (isRecord(value) && value["ok"] === false) return parseSchedulerError(value);
  if (!isRecord(value) || !isFiniteNumber(value["at"]) || !Array.isArray(value["tasks"])) return null;
  // Lenient per task, as the registry is per entry: one a leader ahead wrote must not hide the rest.
  const tasks = value["tasks"].map(parseTask).filter((task) => task !== null);
  return { tasks, at: value["at"] };
}

export function parseRoutePreviewReply(value: unknown): RoutePreviewReply | null {
  if (isRecord(value) && value["ok"] === false) return parseSchedulerError(value);
  const decision = isRecord(value) ? parseDecision(value["decision"]) : null;
  return decision === null ? null : { decision };
}

export function parseSubmitReply(value: unknown): SubmitReply | null {
  if (isRecord(value) && value["ok"] === false) return parseSchedulerError(value);
  const task = isRecord(value) ? parseTask(value["task"]) : null;
  return task === null ? null : { task };
}

export function isSchedulerOp(value: unknown): value is SchedulerOp {
  return SCHEDULER_OPS.some((op) => op === value);
}

/** Receivers never reject on this — display routing only; the wire keeps `string`. */
export function isSpawnErrorCode(value: unknown): value is SpawnErrorCode {
  return SPAWN_ERROR_CODES.some((code) => code === value);
}
