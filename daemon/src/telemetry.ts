import { readFile, stat as statFile, statfs } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import {
  isRecord,
  METRIC_NAMES,
  type MachineStatus,
  type QuotaObservation,
  type ScopedWindow,
  type SessionEntry,
} from "@seance/shared";
import { exclaveOf, type ExclaveScan } from "./exclaves.ts";
import { exec } from "./exec.ts";
import type { MetricsStore, Sample } from "./metrics-store.ts";

/**
 * What a `status` tick measures (DESIGN.md, "Telemetry"): cpu, memory and disk
 * pressure as whole percent, each smoothed over ~SMOOTHING_MS daemon-side so no
 * reader keeps a window of its own; disk free and I/O rates; running sessions
 * per exclave; and the newest quota observation per exclave — what Claude Code
 * cached in each exclave's `.claude.json`, or a running session's own
 * `rate_limits` report (`session-events.ts`) when that is newer.
 * Every sample also lands in the metrics store under `METRIC_NAMES`.
 *
 * A field the host can't answer is absent, never a guess: the first tick has
 * no cpu or I/O delta, a cpu delta too short or spanning a sleep is no reading,
 * macOS has no exec-free I/O counters, and a tmux outage drops `sess` for the
 * tick. A collector that fails drops its field for the
 * tick, never repeating its last average.
 */
export type Snapshot = MachineStatus;

export const SMOOTHING_MS = 120_000;

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

/**
 * How far past now a cached `fetchedAtMs` may sit. Readers take the newest
 * observation per account, so one far-future stamp would pin that account's
 * quota until the clock caught up.
 */
export const QUOTA_CLOCK_SKEW_MS = 60_000;

/**
 * The last register blob's `scannedAt` and the exclave list that blob carries,
 * as one value: a status's `scan` and every index in it come from one read, so
 * no tick can pair one scan's indexes with another scan's stamp.
 */
export interface Registered {
  readonly scan: number;
  readonly exclaves: ExclaveScan;
}

/** Cumulative counters and totals read off the host; the OS is the one boundary a test replaces. */
export interface HostProbe {
  /** Milliseconds summed over `cores`, cumulative since boot. */
  readonly cpu: () => CpuTimes | null;
  readonly memory: () => Promise<{ readonly total: number; readonly available: number } | null>;
  /** Bytes; one entry per path that answered. */
  readonly disks: (paths: readonly string[]) => Promise<readonly { readonly total: number; readonly free: number }[]>;
  /** Cumulative bytes since boot, or null where the host has no exec-free counter. */
  readonly diskIo: () => Promise<{ readonly read: number; readonly write: number } | null>;
}

export interface CpuTimes {
  readonly busy: number;
  readonly idle: number;
  readonly cores: number;
}

export interface TelemetrySources {
  readonly machine: string;
  /** Volumes a clone lands on; the worst one is reported. */
  readonly diskPaths: readonly string[];
  /** Read once at the start of each tick: the stamp and the list `sess` and `quota` index into. */
  readonly registered: () => Registered;
  readonly sessions: () => Promise<readonly SessionEntry[]>;
  /** The newest session-reported quota for an exclave id (`SessionQuota.get`); absent, the cache is the only source. */
  readonly sessionQuota?: (exclave: string) => Omit<QuotaObservation, "x"> | undefined;
  readonly probe?: HostProbe;
}

export interface Telemetry {
  /**
   * One sample: measures, smooths, stores, and returns the snapshot. An
   * overlapping call shares the one in flight when both read the same
   * `registered`; otherwise it runs after it, so a status sent after a
   * register carries that register's stamp.
   */
  readonly tick: (nowMs?: number) => Promise<Snapshot>;
  readonly latest: () => Snapshot | null;
}

export function createTelemetry(store: MetricsStore, sources: TelemetrySources): Telemetry {
  const probe = sources.probe ?? hostProbe;
  let previous: {
    readonly atMs: number;
    readonly io: Awaited<ReturnType<HostProbe["diskIo"]>>;
  } | null = null;
  // Apart from `previous`: a short delta keeps its baseline rather than moving it.
  let cpuBase: CpuBase | null = null;
  // Each average remembers when it last took a reading, so the weight after a
  // failed collector reflects the whole gap, not one tick.
  type Average = { readonly value: number; readonly atMs: number } | null;
  const smoothed: { cpu: Average; mem: Average; disk: Average } = { cpu: null, mem: null, disk: null };
  let latest: Snapshot | null = null;
  let inFlight: { readonly registered: Registered; readonly snapshot: Promise<Snapshot> } | null = null;
  const quotaReader = cachedQuotaReader();

  // Each collector fails alone: one field absent, never the tick.
  const sample = async (registered: Registered, nowMs: number): Promise<Snapshot> => {
    const scan = registered.exclaves;
    const [cpu, memory, disks, io, sessions, quota] = await Promise.all([
      Promise.try(probe.cpu).catch(() => null),
      probe.memory().catch(() => null),
      probe.disks(sources.diskPaths).catch(() => []),
      probe.diskIo().catch(() => null),
      sources.sessions().then(
        (list) => list,
        () => null,
      ),
      Promise.all(scan.exclaves.map((exclave, x) => quotaReader(exclave.configFile, x, nowMs))),
    ]);
    const dtMs = previous === null ? 0 : nowMs - previous.atMs;
    // Time-aware weight rather than a fixed alpha: a laptop back from sleep
    // sees one huge interval and resets to the new reading instead of
    // trusting a two-day-old average for the next four ticks.
    const smooth = (key: keyof typeof smoothed, value: number | null): number | null => {
      if (value === null) return null;
      const prior = smoothed[key];
      const gapMs = prior === null ? 0 : nowMs - prior.atMs;
      const alpha = gapMs <= 0 ? 1 : Math.min(1, gapMs / SMOOTHING_MS);
      const next = prior === null ? value : prior.value + alpha * (value - prior.value);
      smoothed[key] = { value: next, atMs: nowMs };
      return next;
    };

    const cpuNow = cpuReading(cpuBase, cpu, nowMs);
    cpuBase = cpuNow.base;
    const worst = worstDisk(disks);
    const cpuPct = smooth("cpu", cpuNow.pct);
    const memPct = smooth(
      "mem",
      memory === null || memory.total <= 0 ? null : pct(1 - memory.available / memory.total),
    );
    const diskPct = smooth("disk", worst === null ? null : pct(1 - worst.free / worst.total));
    const freeMib = worst === null ? null : worst.free / 2 ** 20;
    const rates = ioRates(previous?.io ?? null, io, dtMs);
    const sess = sessions === null ? null : countSessions(sessions, scan);
    previous = { atMs: nowMs, io };

    const at = Math.floor(nowMs / 1000);
    const reported = scan.exclaves.map((exclave, x) => {
      const observation = sources.sessionQuota?.(exclave.id);
      return observation === undefined ? null : { ...observation, x };
    });
    const observations = scan.exclaves
      .map((_, x) => newestQuota(quota[x] ?? null, reported[x] ?? null))
      .filter((q): q is QuotaObservation => q !== null);
    const snapshot: Snapshot = {
      at,
      scan: registered.scan,
      ...field("cpu", cpuPct),
      ...field("mem", memPct),
      ...field("disk", diskPct),
      ...field("free", freeMib),
      ...field("rd", rates?.rd ?? null),
      ...field("wr", rates?.wr ?? null),
      ...(sess === null ? {} : { sess }),
      ...(observations.length === 0 ? {} : { quota: observations }),
    };

    const machine = sources.machine;
    const samples: Sample[] = [];
    const gauge = (metric: string, value: number | null, labels: Record<string, string>): void => {
      if (value !== null) samples.push({ metric, labels, ts: at, value });
    };
    const host = { machine };
    gauge(METRIC_NAMES.cpu, cpuPct, host);
    gauge(METRIC_NAMES.mem, memPct, host);
    gauge(METRIC_NAMES.disk, diskPct, host);
    gauge(METRIC_NAMES.free, freeMib, host);
    gauge(METRIC_NAMES.rd, rates?.rd ?? null, host);
    gauge(METRIC_NAMES.wr, rates?.wr ?? null, host);
    sess?.forEach((count, x) => {
      const exclave = scan.exclaves[x];
      if (exclave !== undefined) gauge(METRIC_NAMES.sess, count, { machine, exclave: exclave.id });
    });
    // Each source at its own stamp, not the merged one: the cache's per-model
    // windows must not land in the history at a session report's time.
    const stored = [...quota, ...reported].filter((q): q is QuotaObservation => q !== null);
    for (const q of stored) {
      const exclave = scan.exclaves[q.x];
      if (exclave === undefined) continue;
      const account = scan.info[q.x]?.accountId ?? null;
      const labels = { machine, exclave: exclave.id, ...(account === null ? {} : { account }) };
      if (q.h !== undefined) samples.push({ metric: METRIC_NAMES.h, labels, ts: q.at, value: q.h });
      if (q.d !== undefined) samples.push({ metric: METRIC_NAMES.d, labels, ts: q.at, value: q.d });
      for (const window of q.w ?? []) {
        samples.push({ metric: METRIC_NAMES.w, labels: { ...labels, model: window.m }, ts: q.at, value: window.p });
      }
    }
    store.write(samples, at);
    latest = snapshot;
    return snapshot;
  };

  return {
    tick: (nowMs = Date.now()): Promise<Snapshot> => {
      const registered = sources.registered();
      if (inFlight?.registered === registered) return inFlight.snapshot;
      // Queued behind the one in flight, never beside it: the cpu and I/O
      // deltas and the averages assume one sample at a time.
      const before = inFlight?.snapshot.catch(() => null);
      const run = before === undefined ? sample(registered, nowMs) : before.then(() => sample(registered, nowMs));
      const current = {
        registered,
        snapshot: run.finally(() => {
          if (inFlight === current) inFlight = null;
        }),
      };
      inFlight = current;
      return current.snapshot;
    },
    latest: () => latest,
  };
}

/**
 * One exclave's observation for the status: the newer of the cache and a
 * session's report. A report carries no per-model windows, and may lack a
 * window the cache has, so the cache fills what the report leaves out, under
 * the report's stamp — safe because a quota reading is a lower bound (use only
 * raises it until reset, and a passed reset reads 0% whatever its age), so an
 * older window never understates the account.
 */
export function newestQuota(
  cached: QuotaObservation | null,
  reported: QuotaObservation | null,
): QuotaObservation | null {
  if (reported === null || (cached !== null && cached.at > reported.at)) return cached;
  if (cached === null) return reported;
  // Window and its reset travel as a pair: a report's `h` never takes the cache's `hr`.
  return {
    ...reported,
    ...(reported.h === undefined && cached.h !== undefined
      ? { h: cached.h, ...(cached.hr === undefined ? {} : { hr: cached.hr }) }
      : {}),
    ...(reported.d === undefined && cached.d !== undefined
      ? { d: cached.d, ...(cached.dr === undefined ? {} : { dr: cached.dr }) }
      : {}),
    ...(cached.w === undefined ? {} : { w: cached.w }),
  };
}

/** Wire integers: whole, never negative, and a percent never over 100. */
function field<K extends keyof Snapshot>(key: K, value: number | null): Partial<Snapshot> {
  if (value === null) return {};
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

function ioRates(
  prev: { readonly read: number; readonly write: number } | null,
  cur: { readonly read: number; readonly write: number } | null,
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
 * Claude Code refreshes it — not worth a parse per exclave per tick.
 */
function cachedQuotaReader(): (file: string, x: number, nowMs: number) => Promise<QuotaObservation | null> {
  const memo = new Map<string, { readonly key: string; readonly quota: QuotaObservation | null }>();
  return async (file, x, nowMs) => {
    const info = await statFile(file).catch(() => null);
    if (info === null) {
      memo.delete(file);
      return null;
    }
    const key = `${info.mtimeMs}:${info.size}`;
    const hit = memo.get(file);
    const quota = hit?.key === key ? hit.quota : await readCachedQuota(file, x, nowMs);
    memo.set(file, { key, quota });
    return quota === null ? null : { ...quota, x };
  };
}

/**
 * Claude Code's own cached utilization (`cachedUsageUtilization`), as it leaves
 * it in the config dir: whole-percent `utilization` and an ISO `resets_at` per
 * window, stamped `fetchedAtMs`, plus the `limits` list, whose `weekly_scoped`
 * entries are the per-model weekly caps (the "Current week (Fable)" bar; the
 * model id is not cached, only its display name). Nothing else in the file is
 * read, and M1 has
 * no other source (session reports are M2, the OAuth poll M4). An exclave no
 * session has run in has no observation — absent, so readers fall back to
 * another daemon's view of the same account. A stamp past `nowMs` is capped
 * at `QUOTA_CLOCK_SKEW_MS` ahead of it.
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
  const fetched = cached["fetchedAtMs"];
  if (typeof fetched !== "number" || !Number.isFinite(fetched) || fetched < 0) return null;
  const five = windowOf(cached["utilization"]["five_hour"]);
  const seven = windowOf(cached["utilization"]["seven_day"]);
  const scoped = scopedWindows(cached["utilization"]["limits"]);
  if (five === null && seven === null && scoped.length === 0) return null;
  return {
    x,
    s: "cache",
    at: Math.floor(Math.min(fetched, nowMs + QUOTA_CLOCK_SKEW_MS) / 1000),
    ...(five?.pct === undefined ? {} : { h: five.pct }),
    ...(seven?.pct === undefined ? {} : { d: seven.pct }),
    ...(five?.resetsAt === undefined ? {} : { hr: five.resetsAt }),
    ...(seven?.resetsAt === undefined ? {} : { dr: seven.resetsAt }),
    ...(scoped.length === 0 ? {} : { w: scoped }),
  };
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

// --- host probe -------------------------------------------------------------

function cpuTimes(): CpuTimes | null {
  let busy = 0;
  let idle = 0;
  const cores = cpus();
  for (const core of cores) {
    busy += core.times.user + core.times.nice + core.times.sys + core.times.irq;
    idle += core.times.idle;
  }
  return busy + idle > 0 ? { busy, idle, cores: cores.length } : null;
}

/** `MemAvailable` is the kernel's own estimate of what a new process can take without swapping. */
export function parseMeminfo(text: string): { readonly total: number; readonly available: number } | null {
  const kib = (key: string): number | null => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, "mu").exec(text);
    return match?.[1] === undefined ? null : Number(match[1]) * 1024;
  };
  const total = kib("MemTotal");
  const available = kib("MemAvailable");
  return total === null || available === null ? null : { total, available };
}

/**
 * macOS has no `MemAvailable`, and no page arithmetic over `vm_stat` stands in
 * for it: file cache and the compressor hold most of an idle Mac's RAM, so
 * free + inactive + speculative reads ~70% used on a box the kernel calls unpressured. Use the
 * kernel's own figure instead — `kern.memorystatus_level`, the free percentage
 * jetsam acts on and `memory_pressure` prints — scaled to bytes so both
 * platforms answer the same shape.
 */
export function parseMemorystatusLevel(
  text: string,
  total: number,
): { readonly total: number; readonly available: number } | null {
  const level = /^\s*(\d+)\s*$/u.exec(text)?.[1];
  if (level === undefined) return null;
  return { total, available: (Math.min(100, Number(level)) / 100) * total };
}

/** Whole devices only — a partition's sectors are its disk's counted twice, and loop/dm/md devices re-count real ones. */
const WHOLE_DISK = /^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/u;

export function parseDiskstats(text: string): { readonly read: number; readonly write: number } | null {
  let read = 0;
  let write = 0;
  let seen = false;
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/u);
    // major minor name reads merged sectors_read ms writes merged sectors_written …
    if (fields.length < 10 || !WHOLE_DISK.test(fields[2] ?? "")) continue;
    read += Number(fields[5]) * 512;
    write += Number(fields[9]) * 512;
    seen = true;
  }
  return seen && Number.isFinite(read) && Number.isFinite(write) ? { read, write } : null;
}

async function statfsBytes(path: string): Promise<{ readonly total: number; readonly free: number } | null> {
  try {
    const stat = await statfs(path);
    return { total: stat.blocks * stat.bsize, free: stat.bavail * stat.bsize };
  } catch {
    return null;
  }
}

export const hostProbe: HostProbe = {
  cpu: cpuTimes,
  memory: async () => {
    if (process.platform === "linux") return parseMeminfo(await readFile("/proc/meminfo", "utf8"));
    if (process.platform !== "darwin") return null;
    // Absolute: sysctl is in /usr/sbin, which the PATH a plist captured at install need not carry.
    const result = await exec(["/usr/sbin/sysctl", "-n", "kern.memorystatus_level"], { timeoutMs: 5_000 });
    return result.exitCode === 0 ? parseMemorystatusLevel(result.stdout, totalmem()) : null;
  },
  disks: async (paths) => {
    const stats = await Promise.all(paths.map(statfsBytes));
    return stats.filter((stat): stat is { readonly total: number; readonly free: number } => stat !== null);
  },
  diskIo: async () => {
    if (process.platform !== "linux") return null;
    return parseDiskstats(await readFile("/proc/diskstats", "utf8"));
  },
};
