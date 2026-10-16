import {
  METRICS_ERROR_CODES,
  METRICS_MAX_FILTER_LENGTH,
  METRICS_MAX_FILTERS,
  METRICS_MAX_POINTS,
  METRICS_STEPS,
  QUOTA_SOURCES,
  SPAWN_ERROR_CODES,
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

/** Receivers never reject on this — display routing only; the wire keeps `string`. */
export function isSpawnErrorCode(value: unknown): value is SpawnErrorCode {
  return SPAWN_ERROR_CODES.some((code) => code === value);
}
