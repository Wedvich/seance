import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Whether the kernel OOM-killed a session that died of SIGKILL (DESIGN.md,
 * Daemon, "Exit status"). Linux with cgroup v2 only: the kernel counts every
 * OOM kill — a memcg limit's or the global killer's — against the victim's
 * cgroup and each ancestor, as `oom_kill` in `memory.events`, readable without
 * root. The count names no pid, so a sample is taken while the pane's process
 * lives (`/proc/<pane_pid>/cgroup`: the pid is tmux's, the path the kernel's,
 * nothing from the wire) and compared once the pane is found dead.
 *
 * Only the pane's own (leaf) cgroup is read: a parent holds other sessions' and
 * other apps' processes, so its count says nothing about this one.
 *
 * Nothing here throws or logs: an unreadable file is no verdict, and harvest
 * runs in the daemon only, never under `seanced mcp`.
 */

/** A pane's cgroup `oom_kill` count when its session was last seen alive, and which pane that was. */
export interface OomSample {
  /** v2 path as `/proc/<pid>/cgroup` gives it, from the cgroup root. */
  readonly cgroup: string;
  readonly kills: number;
  /** Ms epoch of the sample, refreshed in the ledger once `OOM_REFRESH_MS` old. */
  readonly at: number;
  /** The pane and window it was taken from: a relaunch's pane never inherits it. */
  readonly paneId: string;
  readonly windowId: string;
}

/** The reads, injected so tests point them at a temp tree. */
export interface OomProbe {
  /** The pid's v2 cgroup; null off Linux, without a v2 line, or for a pid gone. */
  readonly cgroupOf: (pid: number) => Promise<string | null>;
  /** The cgroup's `oom_kill` count; null when its `memory.events` does not read (gone, v1, no memory controller). */
  readonly kills: (cgroup: string) => Promise<number | null>;
  /**
   * Whether the pid is on its way out: gone, a zombie, or with SIGKILL pending. The kernel counts the
   * kill when it sends the signal, so a count read in that gap already holds the death it would be compared to.
   */
  readonly exiting: (pid: number) => Promise<boolean>;
}

const CGROUP_PATH_MAX = 4096;
const PANE_ID = /^%\d{1,10}$/u;
const WINDOW_ID = /^@\d{1,10}$/u;
const SIGKILL_PENDING = 0x100n;
const PF_EXITING = 0x4;

/**
 * The most a verdict of `true` may span, either side of the death: from the last sample while alive to
 * the death, and from the death to the judge. The count is unattributed, so a wider window lets a kill
 * hours away read as this session's; ten minutes is five of the leader's two-minute sweeps, which are
 * what drive sampling. Past it the verdict is unknown. `false` has no bound: no kill at all in any window.
 */
export const OOM_WINDOW_MS = 10 * 60_000;

/** An unchanged sample is rewritten only once this old, so a quiet pass costs no ledger write but `at` stays within the window. */
export const OOM_REFRESH_MS = 2 * 60_000;

/** One pane's whole sample or one judge read: `/proc` and cgroup reads take kernel locks that can stall under memory pressure, and `sessions` waits on them. */
export const OOM_READ_TIMEOUT_MS = 1_000;

/** tmux's `pane_dead_time` has second resolution, truncated down; a sample this far past it can still precede the death. */
const DEAD_TIME_SLACK_MS = 1_000;

/** Absolute, bounded, no `.`/`..` step: what the kernel writes, and all the ledger may hand back to a read. */
export function isCgroupPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > CGROUP_PATH_MAX) return false;
  if (/[\0\n]/u.test(value)) return false;
  return value.split("/").every((step) => step !== "." && step !== "..");
}

/** For the ledger's parser: a bad sample is no sample, never a bad file. */
export function isOomSample(value: unknown): value is OomSample {
  return (
    typeof value === "object" &&
    value !== null &&
    "cgroup" in value &&
    "kills" in value &&
    "at" in value &&
    "paneId" in value &&
    "windowId" in value &&
    isCgroupPath(value.cgroup) &&
    typeof value.kills === "number" &&
    Number.isSafeInteger(value.kills) &&
    value.kills >= 0 &&
    typeof value.at === "number" &&
    Number.isSafeInteger(value.at) &&
    value.at >= 0 &&
    typeof value.paneId === "string" &&
    PANE_ID.test(value.paneId) &&
    typeof value.windowId === "string" &&
    WINDOW_ID.test(value.windowId)
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

/** `/proc/<pid>/status`: a zombie or dead state, or SIGKILL pending (thread- or process-directed). Unparseable counts as exiting: no sample beats a wrong one. */
export function isExiting(status: string): boolean {
  let stated = false;
  for (const line of status.split("\n")) {
    const [key, value = ""] = line.split(":", 2);
    const field = value.trim();
    if (key === "State") {
      if (/^[ZXx]/u.test(field)) return true;
      stated = true;
    } else if (key === "SigPnd" || key === "ShdPnd") {
      if (!/^[0-9a-f]{1,16}$/iu.test(field)) return true;
      if ((BigInt(`0x${field}`) & SIGKILL_PENDING) !== 0n) return true;
    }
  }
  return !stated;
}

/**
 * `/proc/<pid>/stat`: PF_EXITING in the flags, set once the task starts exiting whatever signals remain visible.
 * Flags are field 9, counted after the last `)`: comm may hold spaces and parens. Unparseable counts as exiting.
 */
export function isExitingStat(stat: string): boolean {
  const end = stat.lastIndexOf(")");
  if (end < 0) return true;
  // After comm: state, ppid, pgrp, session, tty_nr, tpgid, flags.
  const flags = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/u)[6];
  if (flags === undefined || !/^\d{1,20}$/u.test(flags)) return true;
  return (BigInt(flags) & BigInt(PF_EXITING)) !== 0n;
}

export interface ProcOomProbeOptions {
  readonly proc?: string;
  readonly cgroupRoot?: string;
  readonly platform?: NodeJS.Platform;
}

/**
 * The cgroup namespace may root `/proc/<pid>/cgroup` somewhere other than the
 * mount at `cgroupRoot`, and then every path would read another cgroup's counter.
 * The daemon's own cgroup must resolve under the mount to a `memory.events`.
 */
function mountMatchesNamespace(proc: string, root: string): boolean {
  try {
    const own = parseProcCgroup(readFileSync(join(proc, "self", "cgroup"), "utf8"));
    return own !== null && existsSync(join(root, own, "memory.events"));
  } catch {
    return false;
  }
}

/** The host's `/proc` and cgroup v2 mount; none anywhere but Linux, nor where the mount is not this namespace's, so no pass lists panes for it. */
export function procOomProbe(opts: ProcOomProbeOptions = {}): OomProbe | undefined {
  if ((opts.platform ?? process.platform) !== "linux") return undefined;
  const proc = opts.proc ?? "/proc";
  const root = opts.cgroupRoot ?? "/sys/fs/cgroup";
  if (!mountMatchesNamespace(proc, root)) return undefined;
  const read = (path: string): Promise<string | null> => readFile(path, "utf8").catch(() => null);
  const validPid = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 0;
  return {
    cgroupOf: async (pid) => {
      if (!validPid(pid)) return null;
      const text = await read(join(proc, String(pid), "cgroup"));
      return text === null ? null : parseProcCgroup(text);
    },
    kills: async (cgroup) => {
      if (!isCgroupPath(cgroup)) return null;
      const text = await read(join(root, cgroup, "memory.events"));
      return text === null ? null : parseOomKills(text);
    },
    exiting: async (pid) => {
      if (!validPid(pid)) return true;
      const [status, stat] = await Promise.all([
        read(join(proc, String(pid), "status")),
        read(join(proc, String(pid), "stat")),
      ]);
      return status === null || stat === null || isExiting(status) || isExitingStat(stat);
    },
  };
}

/** One pass's reads: every pane of a shared unit cgroup reads its `memory.events` once. */
export function perPass(probe: OomProbe): OomProbe {
  const counts = new Map<string, Promise<number | null>>();
  return {
    cgroupOf: probe.cgroupOf,
    exiting: probe.exiting,
    kills: (cgroup) => {
      const known = counts.get(cgroup);
      if (known !== undefined) return known;
      const read = probe.kills(cgroup).catch(() => null);
      counts.set(cgroup, read);
      return read;
    },
  };
}

/** The read's value, or null when it fails or outlasts `ms`; the timer never outlives it. */
async function bounded<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([read(), timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The live pane a sample is taken from. */
export interface OomPane {
  readonly pid: number;
  readonly paneId: string;
  readonly windowId: string;
}

/**
 * A live pane's own cgroup and its count; null off Linux, on any failure or
 * timeout, for a cgroup that does not read, and for a pid on its way out — the
 * previous sample then stands, which is the one taken before the kill.
 *
 * Accepted: a pid reused between the pane listing and these reads would sample another process's cgroup.
 * Pids are allocated sequentially and the reads follow the listing within moments.
 */
export function sampleOom(
  pane: OomPane,
  probe: OomProbe,
  now: () => number = Date.now,
  timeoutMs: number = OOM_READ_TIMEOUT_MS,
): Promise<OomSample | null> {
  return bounded(async () => {
    // Before the reads, so `at` is never later than the count it stamps.
    const at = now();
    const cgroup = await probe.cgroupOf(pane.pid);
    if (cgroup === null) return null;
    const kills = await probe.kills(cgroup);
    if (kills === null) return null;
    // After the counts: a kill already counted has SIGKILL pending by now.
    if (await probe.exiting(pane.pid)) return null;
    return { cgroup, kills, at, paneId: pane.paneId, windowId: pane.windowId };
  }, timeoutMs);
}

/** The dead pane a verdict is for; `deadAt` is `pane_dead_time` in ms, null when tmux gave none. */
export interface OomDeath {
  readonly paneId: string;
  readonly windowId: string;
  readonly deadAt: number | null;
}

/**
 * The verdict for a pane found dead of SIGKILL, from the sample taken while it
 * lived — its own, never another launch's pane's. Only the pane's own cgroup
 * speaks: unchanged is `false` (the count is hierarchical and covers global
 * kills), a rise is `true` only inside `OOM_WINDOW_MS` of the death on both
 * sides and with a known death time; a drop means the cgroup was made anew,
 * and a cgroup that no longer reads (a per-pane scope, removed once empty) says
 * nothing either way. Undefined: unknown.
 */
export async function judgeOomKill(
  sample: OomSample | undefined,
  death: OomDeath,
  probe: OomProbe,
  now: () => number = Date.now,
  timeoutMs: number = OOM_READ_TIMEOUT_MS,
): Promise<boolean | undefined> {
  if (sample?.paneId !== death.paneId || sample.windowId !== death.windowId) return undefined;
  const { deadAt } = death;
  // A sample after the death already holds its kill.
  if (deadAt !== null && sample.at > deadAt + DEAD_TIME_SLACK_MS) return undefined;
  const current = await bounded(() => probe.kills(sample.cgroup), timeoutMs);
  if (current === null || current < sample.kills) return undefined;
  if (current === sample.kills) return false;
  if (deadAt === null) return undefined;
  if (deadAt - sample.at > OOM_WINDOW_MS || now() - deadAt > OOM_WINDOW_MS) return undefined;
  return true;
}
