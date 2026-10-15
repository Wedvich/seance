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
 * per exclave; and the newest quota observation per exclave, which in M1 is
 * only what Claude Code itself cached in each exclave's `.claude.json`.
 * Every sample also lands in the metrics store under `METRIC_NAMES`.
 *
 * A field the host can't answer is absent, never a guess: the first tick has
 * no cpu or I/O delta, macOS has no exec-free I/O counters, and a tmux outage
 * drops `sess` for the tick. `scan` is the sender's to add — only it knows
 * which register blob the exclave indexes refer to.
 */
export type Snapshot = Omit<MachineStatus, "scan">;

export const SMOOTHING_MS = 120_000;

/** Cumulative counters and totals read off the host; the OS is the one boundary a test replaces. */
export interface HostProbe {
  /** Jiffies summed over cores, cumulative since boot. */
  readonly cpu: () => { readonly busy: number; readonly idle: number } | null;
  readonly memory: () => Promise<{ readonly total: number; readonly available: number } | null>;
  /** Bytes; one entry per path that answered. */
  readonly disks: (paths: readonly string[]) => Promise<readonly { readonly total: number; readonly free: number }[]>;
  /** Cumulative bytes since boot, or null where the host has no exec-free counter. */
  readonly diskIo: () => Promise<{ readonly read: number; readonly write: number } | null>;
}

export interface TelemetrySources {
  readonly machine: string;
  /** Volumes a clone lands on; the worst one is reported. */
  readonly diskPaths: readonly string[];
  /** Read each tick: the register blob's current list, which `sess` and `quota` index into. */
  readonly exclaves: () => ExclaveScan;
  readonly sessions: () => Promise<readonly SessionEntry[]>;
  readonly probe?: HostProbe;
}

export interface Telemetry {
  /** One sample: measures, smooths, stores, and returns the snapshot. Overlapping calls share one. */
  readonly tick: (nowMs?: number) => Promise<Snapshot>;
  readonly latest: () => Snapshot | null;
}

export function createTelemetry(store: MetricsStore, sources: TelemetrySources): Telemetry {
  const probe = sources.probe ?? hostProbe;
  let previous: {
    readonly atMs: number;
    readonly cpu: ReturnType<HostProbe["cpu"]>;
    readonly io: Awaited<ReturnType<HostProbe["diskIo"]>>;
  } | null = null;
  const smoothed = { cpu: null as number | null, mem: null as number | null, disk: null as number | null };
  let latest: Snapshot | null = null;
  let inFlight: Promise<Snapshot> | null = null;
  const quotaReader = cachedQuotaReader();

  // Each collector fails alone: one field absent, never the tick.
  const sample = async (nowMs: number): Promise<Snapshot> => {
    const scan = sources.exclaves();
    const [cpu, memory, disks, io, sessions, quota] = await Promise.all([
      Promise.try(probe.cpu).catch(() => null),
      probe.memory().catch(() => null),
      probe.disks(sources.diskPaths).catch(() => []),
      probe.diskIo().catch(() => null),
      sources.sessions().then(
        (list) => list,
        () => null,
      ),
      Promise.all(scan.exclaves.map((exclave, x) => quotaReader(exclave.configFile, x))),
    ]);
    const dtMs = previous === null ? 0 : nowMs - previous.atMs;
    // Time-aware weight rather than a fixed alpha: a laptop back from sleep
    // sees one huge interval and resets to the new reading instead of
    // trusting a two-day-old average for the next four ticks.
    const alpha = dtMs <= 0 ? 1 : Math.min(1, dtMs / SMOOTHING_MS);
    const smooth = (key: keyof typeof smoothed, value: number | null): number | null => {
      if (value === null) return smoothed[key];
      const prior = smoothed[key];
      smoothed[key] = prior === null ? value : prior + alpha * (value - prior);
      return smoothed[key];
    };

    const cpuNow = cpuPercent(previous?.cpu ?? null, cpu);
    const worst = worstDisk(disks);
    const cpuPct = smooth("cpu", cpuNow);
    const memPct = smooth(
      "mem",
      memory === null || memory.total <= 0 ? null : pct(1 - memory.available / memory.total),
    );
    const diskPct = smooth("disk", worst === null ? null : pct(1 - worst.free / worst.total));
    const freeMib = worst === null ? null : worst.free / 2 ** 20;
    const rates = ioRates(previous?.io ?? null, io, dtMs);
    const sess = sessions === null ? null : countSessions(sessions, scan);
    previous = { atMs: nowMs, cpu, io };

    const at = Math.floor(nowMs / 1000);
    const observations = quota.filter((q): q is QuotaObservation => q !== null);
    const snapshot: Snapshot = {
      at,
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
    for (const q of observations) {
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
      if (inFlight !== null) return inFlight;
      inFlight = sample(nowMs).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    latest: () => latest,
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

function cpuPercent(prev: ReturnType<HostProbe["cpu"]>, cur: ReturnType<HostProbe["cpu"]>): number | null {
  if (prev === null || cur === null) return null;
  const busy = cur.busy - prev.busy;
  const total = busy + (cur.idle - prev.idle);
  return total <= 0 ? null : pct(busy / total);
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
function cachedQuotaReader(): (file: string, x: number) => Promise<QuotaObservation | null> {
  const memo = new Map<string, { readonly key: string; readonly quota: QuotaObservation | null }>();
  return async (file, x) => {
    const info = await statFile(file).catch(() => null);
    if (info === null) {
      memo.delete(file);
      return null;
    }
    const key = `${info.mtimeMs}:${info.size}`;
    const hit = memo.get(file);
    const quota = hit?.key === key ? hit.quota : await readCachedQuota(file, x);
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
 * another daemon's view of the same account.
 */
export async function readCachedQuota(file: string, x: number): Promise<QuotaObservation | null> {
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
    at: Math.floor(fetched / 1000),
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

function cpuTimes(): { readonly busy: number; readonly idle: number } | null {
  let busy = 0;
  let idle = 0;
  for (const core of cpus()) {
    busy += core.times.user + core.times.nice + core.times.sys + core.times.irq;
    idle += core.times.idle;
  }
  return busy + idle > 0 ? { busy, idle } : null;
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
 * free + inactive reads 70% used on a box the kernel calls unpressured. Use the
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
    const result = await exec(["sysctl", "-n", "kern.memorystatus_level"], { timeoutMs: 5_000 });
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
