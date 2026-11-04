import { readFile, stat as statFile } from "node:fs/promises";
import {
  isRecord,
  METRIC_NAMES,
  QUOTA_CLOCK_SKEW_MS,
  type QuotaObservation,
  type ScopedWindow,
  type SessionEntry,
} from "@seance/shared";
import { exclaveOf, type ExclaveScan } from "./exclaves.ts";
import type { Sample } from "./metrics-store.ts";
import type { CpuTimes, HostProbe, Registered, Snapshot, TelemetrySources } from "./telemetry.ts";

/**
 * The collector registry: every source a `status` tick samples, as one entry
 * each, the way `leader.ts` hands its adapters and request handlers to their
 * own modules. `createTelemetry` owns what all entries share — the tick queue,
 * `at`, the time-aware smoothing, the one store write; an entry owns its read,
 * its state across ticks, and the fields and samples it contributes. A new
 * source (M4's auth health, a Proxmox cgroup/PSI reader) is one more entry
 * in `TELEMETRY_COLLECTORS`, plus a `TelemetrySources` field if it needs a dep
 * `run-collectors.ts` doesn't pass yet.
 */
export type TelemetryCollector = (sources: CollectorSources) => Collect;

/** One tick's sample from one collector. A rejection drops its contribution for the tick, never the tick. */
export type Collect = (tick: TickContext) => Promise<Contribution>;

export type CollectorSources = Omit<TelemetrySources, "probe"> & { readonly probe: HostProbe };

export interface TickContext {
  readonly registered: Registered;
  readonly nowMs: number;
  /** Seconds: the snapshot's stamp and every gauge sample's. */
  readonly at: number;
  /** The tick's time-aware average for `key`, scoped to this entry; null passes through and leaves the average where it was. */
  readonly smooth: (key: string, value: number | null) => number | null;
}

/** The snapshot's measured fields; `at` and `scan` are the tick's own, `tr` is `fitStatus`'s trim marker. */
export type StatusFields = Partial<Omit<Snapshot, "at" | "scan" | "tr">>;

export interface Contribution {
  readonly fields: StatusFields;
  readonly samples: readonly Sample[];
}

// Shared by every failing or empty entry, so frozen: one mutation would leak into all.
export const NO_CONTRIBUTION: Contribution = Object.freeze({
  fields: Object.freeze({}),
  samples: Object.freeze([]),
});

/**
 * A cpu delta shorter than this is not a reading: the tick a register forces
 * can land a second after the last one, and on a laptop just woken that second
 * is all wake-up work. The baseline stays, so the next tick measures across both.
 */
export const MIN_CPU_WINDOW_MS = 5_000;

/**
 * Neither macOS nor Linux counts suspended time, so across a sleep the delta
 * holds only the seconds awake: measured at 38–94% busy on a Mac whose steady
 * load was ~20%. A delta covering less than this share of the wall time since
 * its baseline slept through; it is dropped and the baseline restarts.
 */
const MIN_COUNTED_SHARE = 0.5;

export { QUOTA_CLOCK_SKEW_MS };

// Order is the snapshot's field order and the store's sample order.
export const TELEMETRY_COLLECTORS: readonly TelemetryCollector[] = [
  cpuCollector,
  memoryCollector,
  diskCollector,
  diskIoCollector,
  sessionsCollector,
  quotaCollector,
  drainCollector,
];

function cpuCollector(sources: CollectorSources): Collect {
  // Its own state, not the tick's: a short delta keeps its baseline rather than moving it.
  let base: CpuBase | null = null;
  return async (tick) => {
    const times = await Promise.try(sources.probe.cpu).catch(() => null);
    const reading = cpuReading(base, times, tick.nowMs);
    base = reading.base;
    return gauge(tick, "cpu", METRIC_NAMES.cpu, tick.smooth("cpu", reading.pct));
  };
}

function memoryCollector(sources: CollectorSources): Collect {
  return async (tick) => {
    const memory = await sources.probe.memory().catch(() => null);
    const used = memory === null || memory.total <= 0 ? null : pct(1 - memory.available / memory.total);
    return gauge(tick, "mem", METRIC_NAMES.mem, tick.smooth("mem", used));
  };
}

function diskCollector(sources: CollectorSources): Collect {
  return async (tick) => {
    const worst = worstDisk(await sources.probe.disks(sources.diskPaths).catch(() => []));
    const diskPct = tick.smooth("disk", worst === null ? null : pct(1 - worst.free / worst.total));
    const freeMib = worst === null ? null : worst.free / 2 ** 20;
    return mergeContributions([
      gauge(tick, "disk", METRIC_NAMES.disk, diskPct),
      gauge(tick, "free", METRIC_NAMES.free, freeMib),
    ]);
  };
}

function diskIoCollector(sources: CollectorSources): Collect {
  // Moved every tick, a failed read included: the next delta needs a reading on both ends.
  let previous: { readonly atMs: number; readonly io: IoCounters | null } | null = null;
  return async (tick) => {
    const io = await sources.probe.diskIo().catch(() => null);
    const dtMs = previous === null ? 0 : tick.nowMs - previous.atMs;
    const rates = ioRates(previous?.io ?? null, io, dtMs);
    previous = { atMs: tick.nowMs, io };
    return mergeContributions([
      gauge(tick, "rd", METRIC_NAMES.rd, rates?.rd ?? null),
      gauge(tick, "wr", METRIC_NAMES.wr, rates?.wr ?? null),
    ]);
  };
}

/** `drn` while the task-launch gate is closed: no metric, since routing reads it live and history has no use for it. */
function drainCollector(sources: CollectorSources): Collect {
  return () =>
    Promise.resolve(sources.draining?.() === true ? { fields: { drn: true }, samples: [] } : NO_CONTRIBUTION);
}

function sessionsCollector(sources: CollectorSources): Collect {
  return async (tick) => {
    const sessions = await sources.sessions().then(
      (list) => list,
      () => null,
    );
    if (sessions === null) return NO_CONTRIBUTION;
    const scan = tick.registered.exclaves;
    const sess = countSessions(sessions, scan);
    const samples: Sample[] = [];
    sess.forEach((count, x) => {
      const exclave = scan.exclaves[x];
      if (exclave !== undefined) {
        samples.push({ metric: METRIC_NAMES.sess, labels: { exclave: exclave.id }, ts: tick.at, value: count });
      }
    });
    return { fields: { sess }, samples };
  };
}

function quotaCollector(): Collect {
  const quotaReader = cachedQuotaReader();
  return async (tick) => {
    const scan = tick.registered.exclaves;
    const cached = await Promise.all(scan.exclaves.map((exclave, x) => quotaReader(exclave.configFile, x, tick.nowMs)));
    const observations = cached.filter((q): q is QuotaObservation => q !== null);
    // At the reading's own stamp, not the tick's: a cache an hour old is an hour-old point.
    const samples: Sample[] = [];
    for (const q of observations) {
      const exclave = scan.exclaves[q.x];
      if (exclave === undefined) continue;
      const account = scan.info[q.x]?.accountId ?? null;
      const labels = { exclave: exclave.id, ...(account === null ? {} : { account }) };
      if (q.h !== undefined) samples.push({ metric: METRIC_NAMES.h, labels, ts: q.at, value: q.h });
      if (q.d !== undefined) samples.push({ metric: METRIC_NAMES.d, labels, ts: q.at, value: q.d });
      for (const window of q.w ?? []) {
        samples.push({ metric: METRIC_NAMES.w, labels: { ...labels, model: window.m }, ts: q.at, value: window.p });
      }
      if (q.c !== undefined) samples.push({ metric: METRIC_NAMES.c, labels, ts: q.at, value: q.c });
    }
    return { fields: observations.length === 0 ? {} : { quota: observations }, samples };
  };
}

type GaugeKey = "cpu" | "mem" | "disk" | "free" | "rd" | "wr";

/**
 * A field rounded for the wire and its unrounded sample, or neither. No
 * `machine` label: the store is this machine's alone, and a rename would split every series.
 */
function gauge(tick: TickContext, key: GaugeKey, metric: string, value: number | null): Contribution {
  if (value === null) return NO_CONTRIBUTION;
  return { fields: field(key, value), samples: [{ metric, labels: {}, ts: tick.at, value }] };
}

/**
 * Fields in list order, samples concatenated. Entries own disjoint field keys:
 * a later one would silently overwrite an earlier, so the registry test asserts
 * the default set's keys never overlap — a new entry takes a new key.
 */
export function mergeContributions(contributions: readonly Contribution[]): Contribution {
  return {
    fields: contributions.reduce<StatusFields>((fields, c) => Object.assign(fields, c.fields), {}),
    samples: contributions.flatMap((c) => c.samples),
  };
}

/** Wire integers: whole, never negative, and a percent never over 100. */
function field(key: GaugeKey, value: number): StatusFields {
  const rounded = Math.max(0, Math.round(value));
  return { [key]: key === "cpu" || key === "mem" || key === "disk" ? Math.min(100, rounded) : rounded };
}

function pct(fraction: number): number {
  return Math.min(100, Math.max(0, fraction * 100));
}

interface CpuBase {
  readonly atMs: number;
  readonly times: CpuTimes;
}

/** A failed read keeps the baseline too, so the next tick still has a delta. */
function cpuReading(
  base: CpuBase | null,
  cur: CpuTimes | null,
  nowMs: number,
): { readonly pct: number | null; readonly base: CpuBase | null } {
  if (cur === null) return { pct: null, base };
  const next = { atMs: nowMs, times: cur };
  if (base === null) return { pct: null, base: next };
  const wallMs = nowMs - base.atMs;
  // A clock stepped back would otherwise hold the baseline in the future, reading nothing until it caught up.
  if (wallMs < 0) return { pct: null, base: next };
  if (wallMs < MIN_CPU_WINDOW_MS) return { pct: null, base };
  const busy = cur.busy - base.times.busy;
  const total = busy + (cur.idle - base.times.idle);
  if (total <= 0 || total / cur.cores < wallMs * MIN_COUNTED_SHARE) return { pct: null, base: next };
  return { pct: pct(busy / total), base: next };
}

function worstDisk(
  disks: readonly { readonly total: number; readonly free: number }[],
): { readonly total: number; readonly free: number } | null {
  let worst: { readonly total: number; readonly free: number } | null = null;
  for (const disk of disks) {
    if (disk.total <= 0) continue;
    if (worst === null || disk.free / disk.total < worst.free / worst.total) worst = disk;
  }
  return worst;
}

type IoCounters = NonNullable<Awaited<ReturnType<HostProbe["diskIo"]>>>;

function ioRates(
  prev: IoCounters | null,
  cur: IoCounters | null,
  dtMs: number,
): { readonly rd: number; readonly wr: number } | null {
  if (prev === null || cur === null || dtMs <= 0) return null;
  const seconds = dtMs / 1000;
  return {
    rd: Math.max(0, cur.read - prev.read) / 1024 / seconds,
    wr: Math.max(0, cur.write - prev.write) / 1024 / seconds,
  };
}

/** By pane path, not repo name: a session outside every registered repo still sits in some exclave. */
function countSessions(sessions: readonly SessionEntry[], scan: ExclaveScan): readonly number[] {
  const index = new Map(scan.exclaves.map((exclave, i) => [exclave.id, i]));
  const counts = scan.exclaves.map(() => 0);
  for (const session of sessions) {
    const i = index.get(exclaveOf(session.path, scan.exclaves));
    if (i !== undefined) counts[i] = (counts[i] ?? 0) + 1;
  }
  return counts;
}

/**
 * `readCachedQuota` memoized on the file's stat: `.claude.json` carries project
 * history and runs to megabytes, while the block read from it changes only when
 * Claude Code refreshes it — not worth a parse per exclave per tick, nor per
 * session event in the `/usage` refresh's staleness check.
 */
export function cachedQuotaReader(): (file: string, x: number, nowMs: number) => Promise<QuotaObservation | null> {
  const memo = new Map<string, { readonly key: string; readonly quota: QuotaObservation | null }>();
  return async (file, x, nowMs) => {
    const key = await statKey(file);
    if (key === null) {
      memo.delete(file);
      return null;
    }
    const hit = memo.get(file);
    const quota = hit?.key === key ? hit.quota : await readCachedQuota(file, x, nowMs);
    memo.set(file, { key, quota });
    return quota === null ? null : { ...quota, x };
  };
}

async function statKey(file: string): Promise<string | null> {
  const info = await statFile(file).catch(() => null);
  return info === null ? null : `${info.mtimeMs}:${info.size}`;
}

/**
 * Just `cachedUsageUtilization.fetchedAtMs`, in seconds and capped like a
 * quota's `at`, memoized on the file's stat as `cachedQuotaReader` is. The
 * `/usage` refresh judges staleness and success on this stamp, not on a parsed
 * observation: a cache Claude Code wrote that holds no window we parse is still
 * a refresh, and re-running it would only cost another process.
 */
export function cachedStampReader(): (file: string, nowMs: number) => Promise<number | null> {
  const memo = new Map<string, { readonly key: string; readonly stamp: number | null }>();
  return async (file, nowMs) => {
    const key = await statKey(file);
    if (key === null) {
      memo.delete(file);
      return null;
    }
    const hit = memo.get(file);
    const stamp = hit?.key === key ? hit.stamp : await readCacheStamp(file);
    memo.set(file, { key, stamp });
    return stamp === null ? null : Math.floor(Math.min(stamp, nowMs + QUOTA_CLOCK_SKEW_MS) / 1000);
  };
}

async function readCacheStamp(file: string): Promise<number | null> {
  try {
    return cacheStamp(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return null;
  }
}

function cacheStamp(config: unknown): number | null {
  if (!isRecord(config)) return null;
  const cached = config["cachedUsageUtilization"];
  if (!isRecord(cached)) return null;
  const fetched = cached["fetchedAtMs"];
  return typeof fetched === "number" && Number.isFinite(fetched) && fetched >= 0 ? fetched : null;
}

/**
 * Claude Code's own cached utilization (`cachedUsageUtilization`), as it leaves
 * it in the config dir: whole-percent `utilization` and an ISO `resets_at` per
 * window, stamped `fetchedAtMs`, plus the `limits` list, whose `weekly_scoped`
 * entries are the per-model weekly caps (the "Current week (Fable)" bar; the
 * model id is not cached, only its display name), and `extra_usage` for the
 * credits spent (`creditsOf`). Nothing else in the file is read, and it is the
 * only source: the `/usage` refresh (`usage-refresh.ts`) has Claude Code
 * rewrite it once it is stale. An exclave with no cache yet has no
 * observation — absent, so readers fall back to another daemon's view of the
 * same account. A stamp past `nowMs` is capped at `QUOTA_CLOCK_SKEW_MS` ahead of it.
 */
export async function readCachedQuota(
  file: string,
  x: number,
  nowMs: number = Date.now(),
): Promise<QuotaObservation | null> {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(config)) return null;
  const cached = config["cachedUsageUtilization"];
  if (!isRecord(cached) || !isRecord(cached["utilization"])) return null;
  const fetched = cacheStamp(config);
  if (fetched === null) return null;
  const five = windowOf(cached["utilization"]["five_hour"]);
  const seven = windowOf(cached["utilization"]["seven_day"]);
  const scoped = scopedWindows(cached["utilization"]["limits"]);
  const credits = creditsOf(cached["utilization"]["extra_usage"]);
  if (five === null && seven === null && scoped.length === 0 && credits === null) return null;
  return {
    x,
    s: "cache",
    at: Math.floor(Math.min(fetched, nowMs + QUOTA_CLOCK_SKEW_MS) / 1000),
    ...(five?.pct === undefined ? {} : { h: five.pct }),
    ...(seven?.pct === undefined ? {} : { d: seven.pct }),
    ...(five?.resetsAt === undefined ? {} : { hr: five.resetsAt }),
    ...(seven?.resetsAt === undefined ? {} : { dr: seven.resetsAt }),
    ...(scoped.length === 0 ? {} : { w: scoped }),
    ...credits,
  };
}

/**
 * Credits spent as whole percent of the monthly cap, from the minor-unit
 * amounts rather than `utilization`, which the cache leaves null at zero spent;
 * the amounts beside it, rescaled from the cache's exponent to cents, when
 * the cache names the exponent. Credits are USD, so its `currency` goes unread. Null when credits are off or
 * uncapped: no cap, no percentage.
 */
function creditsOf(extra: unknown): Pick<QuotaObservation, "c" | "cu" | "cl"> | null {
  if (!isRecord(extra) || extra["is_enabled"] !== true) return null;
  const used = extra["used_credits"];
  const limit = extra["monthly_limit"];
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return null;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return null;
  const c = extra["spend_limit_reached"] === true ? 100 : Math.min(100, Math.round((used / limit) * 100));
  const places = extra["decimal_places"];
  if (typeof places !== "number" || !Number.isInteger(places) || places < 0 || places > 4) return { c };
  // Spent rounds down, so a finer exponent never reads as more spent than it was.
  const scale = 10 ** (2 - places);
  const cu = Math.floor(used * scale);
  const cl = Math.round(limit * scale);
  if (!Number.isSafeInteger(cu) || !Number.isSafeInteger(cl)) return { c };
  return { c, cu, cl };
}

function scopedWindows(limits: unknown): readonly ScopedWindow[] {
  if (!Array.isArray(limits)) return [];
  const out: ScopedWindow[] = [];
  for (const limit of limits) {
    if (!isRecord(limit) || limit["kind"] !== "weekly_scoped" || !isRecord(limit["scope"])) continue;
    const model = limit["scope"]["model"];
    if (!isRecord(model) || typeof model["display_name"] !== "string" || model["display_name"] === "") continue;
    const window = windowOf({ utilization: limit["percent"], resets_at: limit["resets_at"] });
    if (window?.pct === undefined) continue;
    out.push({
      m: model["display_name"],
      p: window.pct,
      ...(window.resetsAt === undefined ? {} : { r: window.resetsAt }),
    });
  }
  return out;
}

function windowOf(value: unknown): { readonly pct?: number; readonly resetsAt?: number } | null {
  if (!isRecord(value)) return null;
  const used = value["utilization"];
  const resets = value["resets_at"];
  const pctValue =
    typeof used === "number" && Number.isFinite(used) ? Math.min(100, Math.max(0, Math.round(used))) : undefined;
  const resetsMs = typeof resets === "string" ? Date.parse(resets) : Number.NaN;
  const resetsAt = Number.isFinite(resetsMs) && resetsMs >= 0 ? Math.floor(resetsMs / 1000) : undefined;
  if (pctValue === undefined && resetsAt === undefined) return null;
  return { ...(pctValue === undefined ? {} : { pct: pctValue }), ...(resetsAt === undefined ? {} : { resetsAt }) };
}
