import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  fromBase64,
  generateIdentitySeed,
  identityFromSeed,
  toBase64,
  type Identity,
  type RepoEntry,
  type UpdateReport,
} from "@seance/shared";
import { log } from "./log.ts";
import { runtimePath, statePath } from "./paths.ts";

/**
 * Owner-only, like the audit log: state.json lists every repo path this machine
 * scanned, runtime.json the daemon's pid. Written at this mode rather than
 * chmod'd after, so no umask-mode window exists — the convention the sealed PSK
 * blobs already follow.
 */
const STATE_MODE = 0o600;

export interface State {
  /** SHA-256 of the identity's public key, base64url — never chosen, always derived. */
  readonly deviceId: string;
  /**
   * base64, 32 bytes: the ML-DSA-65 seed the daemon signs registers with
   * (`shared/src/identity.ts`). Lives here, 0600, rather than in the PSK store:
   * it proves which machine this is, not who may spawn on it — a thief gains a
   * squat on one id, and only with the bearer token too. Absent only on a state
   * file written before identities existed; `loadOrInitState` mints one.
   */
  readonly identitySeed?: string;
  readonly repos: readonly RepoEntry[];
  readonly scannedAt: number | null;
  /** HEAD sha of the checkout the last run started from — the self-update announce compares against it. */
  readonly lastRunSha?: string;
  readonly lastUpdate?: UpdateReport;
  /**
   * When the schedule last reaped, epoch ms. Persisted so the daemon's frequent
   * restarts (updates, config reloads) neither repeat a run nor keep deferring one.
   */
  readonly lastReapAt?: number;
}

async function mintIdentity(): Promise<{ readonly seed: string; readonly identity: Identity }> {
  const seed = generateIdentitySeed();
  return { seed: toBase64(seed), identity: await identityFromSeed(seed) };
}

async function freshState(): Promise<State> {
  const { seed, identity } = await mintIdentity();
  return { deviceId: identity.deviceId, identitySeed: seed, repos: [], scannedAt: null };
}

/**
 * The identity a loaded state's seed derives — what signs this machine's
 * registers. Only `loadOrInitState` output is a valid argument: it guarantees
 * the seed is present and derives the stored id, so either failing here is a
 * caller that read the file some other way.
 */
export async function identityOfState(state: State): Promise<Identity> {
  if (state.identitySeed === undefined) throw new Error("state has no identity seed — load it with loadOrInitState");
  const identity = await identityFromSeed(fromBase64(state.identitySeed));
  if (identity.deviceId !== state.deviceId) throw new Error("state's identity seed does not derive its deviceId");
  return identity;
}

function isState(raw: unknown): raw is State {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return typeof obj["deviceId"] === "string" && Array.isArray(obj["repos"]);
}

/**
 * Null when the file is absent; the problem string when it is there but unusable.
 *
 * `readFile` rather than `Bun.file(path).json()`: the writer is temp-plus-rename,
 * so the file on disk is always whole, but `Bun.file` is lazy by path and a read
 * that sizes itself before it opens can land on the far side of a rename and
 * come back short — read as corruption, which re-mints the deviceId. `readFile`
 * sizes from the descriptor it opened, so one open sees one whole file. Seen
 * once on a GitHub macOS runner, never reproduced locally.
 */
async function parseState(path: string): Promise<{ readonly state: State } | { readonly problem: string } | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { problem: `could not be read (${String(err)})` };
  }
  try {
    const raw: unknown = JSON.parse(text);
    return isState(raw) ? { state: raw } : { problem: "has unexpected shape" };
  } catch {
    return { problem: "is not valid JSON" };
  }
}

/**
 * State as it is on disk, or null — the probe for a reader that only wants to
 * know who this machine is. Two things it deliberately does not do, both of
 * which `loadOrInitState` does: it never mints a `deviceId`, so asking the
 * question on a box that has never run the daemon does not answer it by
 * inventing an identity; and it never logs, because `log.ts` writes to stdout
 * and `seanced mcp` — the caller this exists for — carries JSON-RPC frames
 * there.
 */
export async function readState(path: string = statePath()): Promise<State | null> {
  const result = await parseState(path);
  return result !== null && "state" in result ? result.state : null;
}

/**
 * Loads state or initializes it (the identity, and so the deviceId, is minted
 * exactly here, on first run). A corrupt file is replaced — losing the identity
 * only means the machine registers as a new entry; the stale one is
 * forgettable from the PWA. A state file from before identities existed gets
 * one the same way, and its deviceId changes with it: the id is the key's
 * hash, so a random UUID cannot be kept, and the old entry is likewise
 * forgettable. A seed that no longer derives the stored id is treated as the
 * same kind of damage rather than trusted.
 */
export async function loadOrInitState(path: string = statePath()): Promise<State> {
  const result = await parseState(path);
  if (result !== null) {
    if ("state" in result) {
      const { state } = result;
      if (state.identitySeed !== undefined) {
        const identity = await identityFromSeed(fromBase64(state.identitySeed)).catch(() => null);
        if (identity !== null && identity.deviceId === state.deviceId) return state;
        log.warn(`state at ${path} has an identity that does not derive its deviceId — reinitializing`);
      } else {
        const { seed, identity } = await mintIdentity();
        log.info(`minted an identity for state at ${path}: deviceId ${state.deviceId} becomes ${identity.deviceId}`);
        const upgraded: State = { ...state, deviceId: identity.deviceId, identitySeed: seed };
        await saveState(upgraded, path);
        return upgraded;
      }
    } else log.warn(`state at ${path} ${result.problem} — reinitializing`);
  }
  const state = await freshState();
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
 * Size doesn't save a small file: the truncate alone hands a reader an empty
 * one, so runtime.json comes through here too.
 */
async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Per call, not per process: overlapping writers would otherwise share a temp
  // name, and the loser would rename a file the winner already moved.
  const temp = `${path}.${process.pid}.${tempSeq++}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: STATE_MODE });
    await rename(temp, path);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
}

export async function saveState(state: State, path: string = statePath()): Promise<void> {
  await writeAtomic(path, state);
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

/**
 * Atomic like state.json: rewritten on every connect and drop, and read by each
 * CLI that asks `livePid` before touching the cache — where a torn read means
 * "no daemon running". The rename also replaces a runtime.json an older daemon
 * left 0644, since the temp is created at the right mode.
 */
export async function writeRuntime(runtime: Runtime, path: string = runtimePath()): Promise<void> {
  await writeAtomic(path, runtime);
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

/** Through `readFile`, as `parseState` is: one open sees one whole file. */
export async function readRuntime(path: string = runtimePath()): Promise<Runtime | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof raw === "object" && raw !== null && typeof (raw as Record<string, unknown>)["pid"] === "number") {
      return raw as Runtime;
    }
    return null;
  } catch {
    return null;
  }
}
