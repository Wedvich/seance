import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Whether the kernel OOM-killed a session that died of SIGKILL (DESIGN.md,
 * Daemon, "Exit status"). Linux with cgroup v2 only: the kernel counts every
 * OOM kill — a memcg limit's or the global killer's — against the victim's
 * cgroup and each ancestor, as `oom_kill` in `memory.events`, readable without
 * root. The count names no pid, so a sample is taken while the pane's process
 * lives (`/proc/<pane_pid>/cgroup`: the pid is tmux's, the path the kernel's,
 * nothing from the wire) and compared once the pane is found dead.
 *
 * Nothing here throws or logs: an unreadable file is no verdict, and harvest
 * runs in the daemon only, never under `seanced mcp`.
 */

/** A cgroup's `oom_kill` count when the session was last seen alive in it. */
export interface OomSample {
  /** v2 path as `/proc/<pid>/cgroup` gives it, from the cgroup root. */
  readonly cgroup: string;
  readonly kills: number;
}

/** The two reads, injected so tests point them at a temp tree. */
export interface OomProbe {
  /** The pid's v2 cgroup; null off Linux, without a v2 line, or for a pid gone. */
  readonly cgroupOf: (pid: number) => Promise<string | null>;
  /** The cgroup's `oom_kill` count; null when its `memory.events` does not read (gone, v1, no memory controller). */
  readonly kills: (cgroup: string) => Promise<number | null>;
}

const CGROUP_PATH_MAX = 4096;

/**
 * The session's own cgroup, then its parent. A per-pane `tmux-spawn-*.scope`
 * is removed once its last process exits, taking its `memory.events` with it;
 * the parent (a long-lived slice) outlives it and counts its kills too.
 */
export const OOM_SAMPLE_DEPTH = 2;

/** Absolute, bounded, no `.`/`..` step: what the kernel writes, and all the ledger may hand back to a read. */
export function isCgroupPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > CGROUP_PATH_MAX) return false;
  if (/[\0\n]/u.test(value)) return false;
  return value.split("/").every((step) => step !== "." && step !== "..");
}

/** For the ledger's parser: a bad list is no sample, never a bad file. */
export function isOomSamples(value: unknown): value is readonly OomSample[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= OOM_SAMPLE_DEPTH &&
    value.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "cgroup" in entry &&
        "kills" in entry &&
        isCgroupPath(entry.cgroup) &&
        typeof entry.kills === "number" &&
        Number.isSafeInteger(entry.kills) &&
        entry.kills >= 0,
    )
  );
}

/** The unified hierarchy's line (`0::/path`); a v1-only host has none. */
export function parseProcCgroup(text: string): string | null {
  for (const line of text.split("\n")) {
    if (!line.startsWith("0::")) continue;
    const path = line.slice(3);
    return isCgroupPath(path) ? path : null;
  }
  return null;
}

export function parseOomKills(text: string): number | null {
  for (const line of text.split("\n")) {
    const match = /^oom_kill (\d{1,15})$/u.exec(line);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return null;
}

export interface ProcOomProbeOptions {
  readonly proc?: string;
  readonly cgroupRoot?: string;
  readonly platform?: NodeJS.Platform;
}

/** The host's `/proc` and cgroup v2 mount; none anywhere but Linux, so no pass lists panes for it. */
export function procOomProbe(opts: ProcOomProbeOptions = {}): OomProbe | undefined {
  if ((opts.platform ?? process.platform) !== "linux") return undefined;
  const proc = opts.proc ?? "/proc";
  const root = opts.cgroupRoot ?? "/sys/fs/cgroup";
  const read = (path: string): Promise<string | null> => readFile(path, "utf8").catch(() => null);
  return {
    cgroupOf: async (pid) => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      const text = await read(join(proc, String(pid), "cgroup"));
      return text === null ? null : parseProcCgroup(text);
    },
    kills: async (cgroup) => {
      if (!isCgroupPath(cgroup)) return null;
      const text = await read(join(root, cgroup, "memory.events"));
      return text === null ? null : parseOomKills(text);
    },
  };
}

/** One pass's reads: every pane of a shared unit cgroup reads its `memory.events` once. */
export function perPass(probe: OomProbe): OomProbe {
  const counts = new Map<string, Promise<number | null>>();
  return {
    cgroupOf: probe.cgroupOf,
    kills: (cgroup) => {
      const known = counts.get(cgroup);
      if (known !== undefined) return known;
      const read = probe.kills(cgroup).catch(() => null);
      counts.set(cgroup, read);
      return read;
    },
  };
}

/** A live pid's samples, nearest cgroup first, the unreadable left out; none off Linux or on failure. */
export async function sampleOom(pid: number, probe: OomProbe): Promise<readonly OomSample[]> {
  try {
    const leaf = await probe.cgroupOf(pid);
    if (leaf === null) return [];
    const chain = [leaf];
    while (chain.length < OOM_SAMPLE_DEPTH && chain.at(-1) !== "/") chain.push(dirname(chain.at(-1) ?? "/"));
    const samples: OomSample[] = [];
    for (const cgroup of chain) {
      // oxlint-disable-next-line no-await-in-loop -- at most two small reads, in order
      const kills = await probe.kills(cgroup);
      if (kills !== null) samples.push({ cgroup, kills });
    }
    return samples;
  } catch {
    return [];
  }
}

/**
 * The verdict for a pane found dead of SIGKILL, from the samples taken while it
 * lived. The nearest sampled cgroup decides both ways: a rise is an OOM kill
 * counted there between then and now; no change is none, since the count is
 * hierarchical and covers global kills. A drop means the cgroup was made anew,
 * which proves nothing. Once the nearest no longer reads, a farther one can
 * only confirm: under the `memory_localevents` mount option a parent counts
 * none of its children's kills, so its silence is no negative.
 * Undefined: unknown.
 */
export async function judgeOomKill(samples: readonly OomSample[], probe: OomProbe): Promise<boolean | undefined> {
  try {
    const [nearest, ...farther] = samples;
    if (nearest === undefined) return undefined;
    const now = await probe.kills(nearest.cgroup);
    if (now !== null) return now > nearest.kills ? true : now === nearest.kills ? false : undefined;
    for (const sample of farther) {
      // oxlint-disable-next-line no-await-in-loop -- at most one more read
      const later = await probe.kills(sample.cgroup);
      if (later !== null && later > sample.kills) return true;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
