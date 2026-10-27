import { readFile, statfs } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import type { MachineStatus, SessionEntry } from "@seance/shared";
import type { ExclaveScan } from "./exclaves.ts";
import { exec } from "./exec.ts";
import type { MetricsStore } from "./metrics-store.ts";
import type { Fetch } from "./seams.ts";
import {
  mergeContributions,
  NO_CONTRIBUTION,
  TELEMETRY_COLLECTORS,
  type TelemetryCollector,
  type TickContext,
} from "./telemetry-collectors.ts";

export { MIN_CPU_WINDOW_MS, QUOTA_CLOCK_SKEW_MS, readCachedQuota } from "./telemetry-collectors.ts";

/**
 * What a `status` tick measures (DESIGN.md, "Telemetry"): cpu, memory and disk
 * pressure as whole percent, each smoothed over ~SMOOTHING_MS daemon-side so no
 * reader keeps a window of its own; disk free and I/O rates; running sessions
 * per exclave; and each exclave's quota observation — what Claude Code cached
 * in its `.claude.json`, which the `/usage` refresh (`usage-refresh.ts`) keeps
 * from going stale.
 * Every sample also lands in the metrics store under `METRIC_NAMES`.
 * Each is one entry in `TELEMETRY_COLLECTORS` (`telemetry-collectors.ts`).
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
  /** Volumes a clone lands on; the worst one is reported. */
  readonly diskPaths: readonly string[];
  /** Read once at the start of each tick: the stamp and the list `sess` and `quota` index into. */
  readonly registered: () => Registered;
  readonly sessions: () => Promise<readonly SessionEntry[]>;
  readonly probe?: HostProbe;
  /** The clock a `tick` without an explicit time reads; defaults to `Date.now`. */
  readonly now?: () => number;
  /** True while the daemon refuses task launches (`EndedTasks.draining`); absent reads as never. */
  readonly draining?: () => boolean;
  /** Outbound HTTP for a collector that polls an endpoint; defaults to the global `fetch`. */
  readonly httpFetch?: Fetch;
  /**
   * A collector's failure, by its registry name. It drops only that entry's
   * contribution; this is the one place the cause surfaces, and it is called on
   * every failing tick — the caller rate-limits, not `createTelemetry`.
   */
  readonly onCollectorError?: (collector: string, err: unknown) => void;
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

/** `registry` is a parameter so a test can add an entry; the daemon runs `TELEMETRY_COLLECTORS`. */
export function createTelemetry(
  store: MetricsStore,
  sources: TelemetrySources,
  registry: readonly TelemetryCollector[] = TELEMETRY_COLLECTORS,
): Telemetry {
  const now = sources.now ?? Date.now;
  // A throwing hook must not turn a contained failure into a failed tick.
  const reportFailure = (name: string, err: unknown): void => {
    try {
      sources.onCollectorError?.(name, err);
    } catch {
      // nothing left to tell
    }
  };
  const collectors = registry.map((collector) => collector({ ...sources, probe: sources.probe ?? hostProbe }));
  // Each average remembers when it last took a reading, so the weight after a
  // failed collector reflects the whole gap, not one tick. Keyed by entry index
  // too: a key is free text, and two entries must not share an average by accident.
  const smoothed = new Map<string, { readonly value: number; readonly atMs: number }>();
  let latest: Snapshot | null = null;
  let inFlight: { readonly registered: Registered; readonly snapshot: Promise<Snapshot> } | null = null;

  const sample = async (registered: Registered, nowMs: number): Promise<Snapshot> => {
    const at = Math.floor(nowMs / 1000);
    // Time-aware weight rather than a fixed alpha: a laptop back from sleep
    // sees one huge interval and resets to the new reading instead of
    // trusting a two-day-old average for the next four ticks.
    const smoothFor =
      (index: number) =>
      (key: string, value: number | null): number | null => {
        if (value === null) return null;
        const slot = `${index}:${key}`;
        const prior = smoothed.get(slot);
        const gapMs = prior === undefined ? 0 : nowMs - prior.atMs;
        const alpha = gapMs <= 0 ? 1 : Math.min(1, gapMs / SMOOTHING_MS);
        const next = prior === undefined ? value : prior.value + alpha * (value - prior.value);
        smoothed.set(slot, { value: next, atMs: nowMs });
        return next;
      };
    // Each collector fails alone: one field absent, never the tick.
    const contributions = await Promise.all(
      collectors.map((collect, index) => {
        const tick: TickContext = { registered, nowMs, at, smooth: smoothFor(index) };
        return Promise.try(collect, tick).catch((err: unknown) => {
          reportFailure(registry[index]?.name ?? `#${index}`, err);
          return NO_CONTRIBUTION;
        });
      }),
    );
    const { fields, samples } = mergeContributions(contributions);
    const snapshot: Snapshot = { at, scan: registered.scan, ...fields };
    store.write(samples, at);
    latest = snapshot;
    return snapshot;
  };

  return {
    tick: (nowMs = now()): Promise<Snapshot> => {
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
