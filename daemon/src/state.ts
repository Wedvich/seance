import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { RepoEntry, UpdateReport } from "@seance/shared";
import { log } from "./log.ts";
import { runtimePath, statePath } from "./paths.ts";

export interface State {
  readonly deviceId: string;
  readonly repos: readonly RepoEntry[];
  readonly scannedAt: number | null;
  /** HEAD sha of the checkout the last run started from — the self-update announce compares against it. */
  readonly lastRunSha?: string;
  readonly lastUpdate?: UpdateReport;
}

function freshState(): State {
  return { deviceId: crypto.randomUUID(), repos: [], scannedAt: null };
}

function isState(raw: unknown): raw is State {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return typeof obj["deviceId"] === "string" && Array.isArray(obj["repos"]);
}

/**
 * Loads state or initializes it (deviceId is generated exactly here, on first
 * run). A corrupt file is replaced — losing deviceId only means the machine
 * registers as a new entry; the stale one is forgettable from the PWA.
 */
export async function loadOrInitState(path: string = statePath()): Promise<State> {
  const file = Bun.file(path);
  if (await file.exists()) {
    try {
      const raw: unknown = await file.json();
      if (isState(raw)) return raw;
      log.warn(`state at ${path} has unexpected shape — reinitializing`);
    } catch {
      log.warn(`state at ${path} is not valid JSON — reinitializing`);
    }
  }
  const state = freshState();
  await saveState(state, path);
  return state;
}

let tempSeq = 0;

/**
 * Temp-plus-rename, because state.json is read while a writer is mid-flight:
 * config hot reload restarts `startDaemon` in-process, so `loadOrInitState`
 * can land while the outgoing daemon's background rescan is still writing. An
 * in-place `Bun.write` truncates first, and a reader that catches the gap sees
 * a partial file — indistinguishable from corruption, so `loadOrInitState`
 * mints a new deviceId and the machine re-registers as a stranger.
 *
 * The tear needs a payload big enough to split across write syscalls (measured
 * at roughly half a megabyte on macOS, a few thousand repos), which is why
 * `writeRuntime` below stays a plain write.
 */
async function saveStateAtomic(path: string, state: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Per call, not per process: overlapping writers would otherwise share a temp
  // name, and the loser would rename a file the winner already moved.
  const temp = `${path}.${process.pid}.${tempSeq++}.tmp`;
  try {
    await Bun.write(temp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temp, path);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
}

export async function saveState(state: State, path: string = statePath()): Promise<void> {
  await saveStateAtomic(path, state);
}

/** Written by the running daemon; read by `seanced status`. */
export interface Runtime {
  readonly pid: number;
  readonly startedAt: number;
  readonly connected: boolean;
  readonly connectedSince: number | null;
  /** Sha this process started on — not whatever a later `git pull` left on disk. */
  readonly sha?: string | null;
}

/** Fixed-size and well under one write syscall, so an in-place write cannot be read torn. */
export async function writeRuntime(runtime: Runtime, path: string = runtimePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(runtime, null, 2)}\n`);
}

/** True while that pid is ours and alive — the liveness half of `readRuntime`. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // dead or not ours
    return false;
  }
}

/**
 * The running daemon's pid, or null when nothing live owns state.json. Anything
 * that writes the cache has to ask first: the daemon rewrites it from memory.
 */
export async function livePid(path: string = runtimePath()): Promise<number | null> {
  const runtime = await readRuntime(path);
  if (runtime === null) return null;
  return pidAlive(runtime.pid) ? runtime.pid : null;
}

export async function readRuntime(path: string = runtimePath()): Promise<Runtime | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const raw: unknown = await file.json();
    if (typeof raw === "object" && raw !== null && typeof (raw as Record<string, unknown>)["pid"] === "number") {
      return raw as Runtime;
    }
    return null;
  } catch {
    return null;
  }
}
