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
import { DEFAULT_EXCLAVE, EXCLAVE_NAME } from "./exclaves.ts";
import { log } from "./log.ts";
import { PANE_ID } from "./pane-id.ts";
import { runtimePath, statePath } from "./paths.ts";
import { ROUND_TMP, type SeatRecord } from "./seat-record.ts";

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
  /**
   * Set while closed to new scheduled work (docs/drain.md), absent while open. Sticky across
   * restarts and reboots until someone reopens it. An older daemon ignores the field.
   */
  readonly closed?: { readonly at: number };
  readonly scannedAt: number | null;
  /** HEAD sha of the checkout the last run started from — the self-update announce compares against it. */
  readonly lastRunSha?: string;
  readonly lastUpdate?: UpdateReport;
  /**
   * When the schedule last reaped, epoch ms. Persisted so the daemon's frequent
   * restarts (updates, config reloads) neither repeat a run nor keep deferring one.
   */
  readonly lastReapAt?: number;
  /**
   * The custodian seat's last round end and its running round (`SeatRecord`), so a restart or reload adopts the
   * round rather than starting a second. Read only through `custodianSeatOf`; an older daemon ignores the field.
   */
  readonly custodian?: SeatRecord;
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
export async function parseState(
  path: string,
): Promise<{ readonly state: State } | { readonly problem: string } | null> {
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

/** When this machine was closed (ms), or null while open or when the field is unreadable. */
export function closedOf(state: State): number | null {
  const closed: unknown = state.closed;
  if (typeof closed !== "object" || closed === null) return null;
  const at: unknown = (closed as { at?: unknown }).at;
  return typeof at === "number" && Number.isFinite(at) && at > 0 ? at : null;
}

const finiteMs = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * The seat's record, field by field: anything unreadable is dropped, so a damaged record reads as `{}` and the
 * next pass's stray sweep still closes an orphan round pane. Every value that reaches tmux or `rm` is held to its
 * own pattern here, since the file is the daemon's but is not a wire frame and need not be trusted whole.
 */
export function custodianSeatOf(state: State): SeatRecord {
  const raw: unknown = state.custodian;
  if (typeof raw !== "object" || raw === null) return {};
  const { lastEndedAt, round } = raw as { lastEndedAt?: unknown; round?: unknown };
  const ended = finiteMs(lastEndedAt) ? { lastEndedAt } : {};
  if (typeof round !== "object" || round === null) return ended;
  const { pane, startedAt, tmpDir, exclave } = round as Record<string, unknown>;
  if (
    !(pane === null || (typeof pane === "string" && PANE_ID.test(pane))) ||
    !finiteMs(startedAt) ||
    typeof tmpDir !== "string" ||
    !ROUND_TMP.test(tmpDir) ||
    typeof exclave !== "string" ||
    !(exclave === DEFAULT_EXCLAVE || EXCLAVE_NAME.test(exclave))
  ) {
    return ended;
  }
  return { ...ended, round: { pane, startedAt, tmpDir, exclave } };
}

/** State without its close, for a reopen. */
export function withoutClosed(state: State): State {
  const { closed: _closed, ...rest } = state;
  return rest;
}

/**
 * A `closed` that is present but unreadable loads as closed now: a damaged close must not
 * quietly put the box back in rotation. Only here, never in `readState`, which stays log-free.
 */
function failClosed(state: State, path: string): State {
  if (state.closed === undefined || closedOf(state) !== null) return state;
  log.warn(`state at ${path} has an unreadable closed field — staying closed`);
  return { ...state, closed: { at: Date.now() } };
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
        if (identity !== null && identity.deviceId === state.deviceId) return failClosed(state, path);
        log.warn(`state at ${path} has an identity that does not derive its deviceId — reinitializing`);
      } else {
        const { seed, identity } = await mintIdentity();
        log.info(`minted an identity for state at ${path}: deviceId ${state.deviceId} becomes ${identity.deviceId}`);
        const upgraded: State = failClosed({ ...state, deviceId: identity.deviceId, identitySeed: seed }, path);
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
export async function writeAtomic(path: string, value: unknown): Promise<void> {
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
  /**
   * Checkout this process runs from. `status` and `doctor` read it because the
   * CLI asking may be another clone; absent from a daemon older than the field.
   */
  readonly root?: string;
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
