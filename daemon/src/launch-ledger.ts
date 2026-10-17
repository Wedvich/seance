import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BRANCH_MAX_LENGTH,
  httpsUrl,
  isRecord,
  isTaskId,
  parseTaskProgressList,
  type TaskProgress,
} from "@seance/shared";
import { log } from "./log.ts";
import { stateDir } from "./paths.ts";

/**
 * Task ids this daemon launched, on disk, recorded before each spawn runs
 * (DESIGN.md, "Session events"). What makes `SessionsResponse.ledgerSince` a
 * proof: from `since` on, every task launched here is in the file, so one in
 * neither a live pane nor the file was never launched here — across restarts,
 * which the in-memory `ended` events do not survive. Ids and times only; a
 * prompt never reaches it.
 *
 * It also keeps per-task progress — the launch's repo and worktree path, the
 * last-seen branch, sticky pushed and merged, the PR URL — for
 * `SessionsResponse.progress` and the branch-state emitter. That is not
 * write-ahead: noted after the fact, best-effort, and a failed write costs the
 * note, never the proof. It is v1 plus an optional top-level `progress` array,
 * which an older reader ignores (it keeps `since` and `tasks`, and its next
 * write drops `progress`). Paths and branch names carry the spawn's slug, as
 * the worktree directory and window name already do, never the prompt; the file
 * is 0600 in the state dir.
 *
 * Bounded by count and by age, and `since` moves past each entry evicted, so
 * the claim stays true as the file forgets. Count: eviction happens only
 * through this machine's own launches, and the task waiting on proof is one
 * whose machine was absent — so 128, sixteen times the scheduler's global
 * in-flight max, outlasts any absence by a wide margin, while the `sessions`
 * reply that lists every entry no live pane carries stays a few KiB. Age: a
 * week covers a laptop shut for one; a reservation older than that settles as
 * unprovable rather than holding entries forever.
 */
export const LEDGER_MAX = 128;
export const LEDGER_MAX_AGE_MS = 7 * 24 * 3_600_000;

const LEDGER_VERSION = 1;
const LEDGER_MODE = 0o600;

export function launchLedgerPath(): string {
  return join(stateDir(), "launched.json");
}

/** Where a worktree-mode launch landed: the main clone (`RepoEntry.path`) and its worktree. */
export interface LaunchSite {
  readonly repo: string;
  readonly worktree: string;
}

/** What is known of a task's branch. `tip` and `ahead` are internal: never in `TaskProgress`. */
export interface TaskNote {
  readonly repo?: string;
  /** Absolute worktree path. */
  readonly path?: string;
  readonly branch?: string;
  /** Last-seen tip sha, 40 or 64 hex. */
  readonly tip?: string;
  /** The tip once held a commit not reachable from `origin/<default>`: sticky, gates pushed and merged. */
  readonly ahead?: true;
  readonly pushed?: true;
  readonly merged?: true;
  readonly prUrl?: string;
}

export interface NotedTask extends TaskNote {
  readonly taskId: string;
  /** Last change, never refreshed by an unchanged pass. */
  readonly at: number;
}

interface LedgerFile {
  readonly v: typeof LEDGER_VERSION;
  readonly since: number;
  /** `[taskId, launchedAt]`, oldest first. */
  readonly tasks: readonly (readonly [string, number])[];
  /** Best-effort notes, outside the proof: an older reader ignores them. */
  readonly progress?: readonly NotedTask[];
}

const PATH_MAX_LENGTH = 4096;
const TIP_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/u;

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

/** One entry, field by field: a bad field is dropped, a bad entry is skipped, never the file. */
function parseNote(raw: unknown, ids: ReadonlySet<string>): NotedTask | null {
  if (!isRecord(raw)) return null;
  const { taskId, at, repo, path, branch, tip, ahead, pushed, merged, prUrl } = raw;
  if (typeof taskId !== "string" || !ids.has(taskId) || typeof at !== "number" || !Number.isFinite(at)) return null;
  const repoText = boundedText(repo, PATH_MAX_LENGTH);
  const pathText = boundedText(path, PATH_MAX_LENGTH);
  const branchText = boundedText(branch, BRANCH_MAX_LENGTH);
  const tipText = typeof tip === "string" && TIP_PATTERN.test(tip) ? tip : undefined;
  const url = typeof prUrl === "string" && httpsUrl(prUrl) === prUrl ? prUrl : undefined;
  return {
    taskId,
    at,
    ...(repoText === undefined ? {} : { repo: repoText }),
    ...(pathText === undefined ? {} : { path: pathText }),
    ...(branchText === undefined ? {} : { branch: branchText }),
    ...(tipText === undefined ? {} : { tip: tipText }),
    ...(ahead === true ? { ahead: true as const } : {}),
    ...(pushed === true ? { pushed: true as const } : {}),
    ...(merged === true ? { merged: true as const } : {}),
    ...(url === undefined ? {} : { prUrl: url }),
  };
}

function parseLedger(raw: unknown): LedgerFile | null {
  if (!isRecord(raw) || raw["v"] !== LEDGER_VERSION) return null;
  const { since, tasks } = raw;
  if (typeof since !== "number" || !Number.isFinite(since) || !Array.isArray(tasks)) return null;
  const entries: (readonly [string, number])[] = [];
  for (const entry of tasks) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [id, at]: unknown[] = entry;
    if (!isTaskId(id) || typeof at !== "number" || !Number.isFinite(at)) return null;
    entries.push([id, at]);
  }
  const ids = new Set(entries.map(([id]) => id));
  const progress: NotedTask[] = [];
  if (Array.isArray(raw["progress"])) {
    for (const item of raw["progress"]) {
      const note = parseNote(item, ids);
      if (note !== null) progress.push(note);
    }
  }
  return { v: LEDGER_VERSION, since, tasks: entries, progress };
}

async function freshSince(path: string, now: () => number): Promise<number> {
  const dirMtime = await stat(dirname(path)).then(
    (info) => Math.floor(info.mtimeMs) + 1,
    () => 0,
  );
  return Math.max(now(), dirMtime);
}

let tempSeq = 0;
let warnedDropped = false;

function warnProgressDropped(): void {
  if (warnedDropped) return;
  warnedDropped = true;
  log.warn("launch ledger: a progress note failed the wire parser and was left out of `sessions`");
}

function mergeNote(taskId: string, base: NotedTask | undefined, patch: TaskNote): NotedTask {
  return {
    taskId,
    at: base?.at ?? 0,
    ...(patch.repo !== undefined ? { repo: patch.repo } : base?.repo !== undefined ? { repo: base.repo } : {}),
    ...(patch.path !== undefined ? { path: patch.path } : base?.path !== undefined ? { path: base.path } : {}),
    ...(patch.branch !== undefined
      ? { branch: patch.branch }
      : base?.branch !== undefined
        ? { branch: base.branch }
        : {}),
    ...(patch.tip !== undefined ? { tip: patch.tip } : base?.tip !== undefined ? { tip: base.tip } : {}),
    ...(patch.prUrl !== undefined ? { prUrl: patch.prUrl } : base?.prUrl !== undefined ? { prUrl: base.prUrl } : {}),
    ...(patch.ahead === true || base?.ahead === true ? { ahead: true as const } : {}),
    ...(patch.pushed === true || base?.pushed === true ? { pushed: true as const } : {}),
    ...(patch.merged === true || base?.merged === true ? { merged: true as const } : {}),
  };
}

function sameNote(a: NotedTask, b: NotedTask): boolean {
  return (
    a.repo === b.repo &&
    a.path === b.path &&
    a.branch === b.branch &&
    a.tip === b.tip &&
    a.prUrl === b.prUrl &&
    a.ahead === b.ahead &&
    a.pushed === b.pushed &&
    a.merged === b.merged
  );
}

export class LaunchLedger {
  readonly #path: string | null;
  readonly #now: () => number;
  /** Insertion order is age order: a re-recorded id moves to the end. */
  readonly #tasks: Map<string, number>;
  /** Progress notes by task id; each lives and dies with its launch. */
  readonly #notes: Map<string, NotedTask>;
  /** Records of each id not yet on disk or failed: a failure deletes the id only when it is the last. */
  readonly #recording = new Map<string, number>();
  #since: number;
  #writing: Promise<unknown> = Promise.resolve();

  private constructor(path: string | null, now: () => number, since: number, file: LedgerFile | null) {
    this.#path = path;
    this.#now = now;
    this.#since = file?.since ?? since;
    this.#tasks = new Map(file?.tasks ?? []);
    this.#notes = new Map((file?.progress ?? []).map((note) => [note.taskId, note]));
  }

  /**
   * Never throws. A missing file is a fresh ledger, complete from now; so is a
   * corrupt one, which can prove nothing about what came before — it is
   * replaced on the next write.
   *
   * "Now" is never earlier than the state directory's mtime: every write
   * renames into it, so the mtime is at or after the last launch the lost
   * ledger held, by the clock that recorded it. A clock still behind at boot (no
   * RTC, NTP not yet synced) would otherwise date a fresh ledger before
   * launches it never saw, and its `since` would prove them never happened.
   */
  static async open(path: string = launchLedgerPath(), now: () => number = Date.now): Promise<LaunchLedger> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      const code = err instanceof Error && "code" in err ? err.code : undefined;
      if (code !== "ENOENT") {
        log.warn(`launch ledger at ${path} unreadable (${String(err)}) — starting it afresh`);
      }
      return new LaunchLedger(path, now, await freshSince(path, now), null);
    }
    let parsed: LedgerFile | null = null;
    try {
      parsed = parseLedger(JSON.parse(text));
    } catch {
      // Falls through to the warning below.
    }
    if (parsed === null) log.warn(`launch ledger at ${path} is corrupt — starting it afresh`);
    return new LaunchLedger(path, now, parsed === null ? await freshSince(path, now) : 0, parsed);
  }

  /** No file: for tests and a host that keeps none. Proves only what this process saw. */
  static memory(now: () => number = Date.now): LaunchLedger {
    return new LaunchLedger(null, now, now(), null);
  }

  /** From here on the ledger lists every launch. */
  since(): number {
    this.#evict();
    return this.#since;
  }

  ids(): readonly string[] {
    this.#evict();
    return [...this.#tasks.keys()];
  }

  /**
   * Write-ahead: resolves once the id is on disk, and throws if it cannot be
   * written — the caller must then not launch. True when the id was not already
   * recorded, which is what lets a launch that never happened be retracted.
   */
  async record(taskId: string): Promise<boolean> {
    const fresh = !this.#tasks.has(taskId);
    this.#tasks.delete(taskId);
    this.#tasks.set(taskId, this.#now());
    this.#evict();
    this.#recording.set(taskId, (this.#recording.get(taskId) ?? 0) + 1);
    try {
      await this.#persist();
    } catch (err) {
      // Not while another record of the id waits on its own write, which would
      // then put the ledger on disk without it and report success. If that one
      // fails too, the id stays in memory with nothing launched: it reads as
      // ran-and-ended, never as never-started.
      if (fresh && this.#recording.get(taskId) === 1) this.#tasks.delete(taskId);
      throw err;
    } finally {
      const left = (this.#recording.get(taskId) ?? 1) - 1;
      if (left === 0) this.#recording.delete(taskId);
      else this.#recording.set(taskId, left);
    }
    return fresh;
  }

  /**
   * A launch that never happened leaves the ledger. Not an eviction: the ledger
   * stays complete, since nothing launched. A failed write only costs the
   * retraction — the task reads as ran-and-ended, never as never-started.
   */
  async retract(taskId: string): Promise<void> {
    if (!this.#tasks.delete(taskId)) return;
    this.#notes.delete(taskId);
    await this.#persist().catch((err: unknown) => {
      log.warn(`launch ledger: could not retract a launch that never ran (${String(err)})`);
    });
  }

  /**
   * Best-effort, unlike `record`: never throws, and memory keeps the change
   * when the write fails — the next write carries it. A new `path` is a
   * relaunch under the same id and starts the note afresh; otherwise `ahead`,
   * `pushed` and `merged` never clear. `at` moves only on a change, so an
   * unchanged pass costs no write. Never touches `since` or the ids.
   */
  async note(taskId: string, patch: TaskNote): Promise<void> {
    if (!this.#tasks.has(taskId)) return;
    const old = this.#notes.get(taskId);
    const base = patch.path !== undefined && patch.path !== old?.path ? undefined : old;
    const next = mergeNote(taskId, base, patch);
    if (old !== undefined && base !== undefined && sameNote(old, next)) return;
    this.#notes.set(taskId, { ...next, at: this.#now() });
    try {
      await this.#persist();
    } catch (err) {
      log.warn(`launch ledger: could not record task progress (${String(err)})`);
    }
  }

  /** Notes in launch order, for the emitter. */
  notes(): readonly NotedTask[] {
    this.#evict();
    const noted: NotedTask[] = [];
    for (const id of this.#tasks.keys()) {
      const note = this.#notes.get(id);
      if (note !== undefined) noted.push(note);
    }
    return noted;
  }

  /**
   * What `SessionsResponse.progress` carries. The leader's parser nulls the
   * whole list on one bad entry, so an entry that would not pass it is left
   * out here rather than blinding a takeover.
   */
  progress(): readonly TaskProgress[] {
    const out: TaskProgress[] = [];
    for (const note of this.notes()) {
      if (
        note.prUrl === undefined &&
        note.branch === undefined &&
        note.pushed === undefined &&
        note.merged === undefined
      )
        continue;
      const entry: TaskProgress = {
        taskId: note.taskId,
        at: note.at,
        ...(note.prUrl === undefined ? {} : { prUrl: note.prUrl }),
        ...(note.branch === undefined ? {} : { branch: note.branch }),
        ...(note.pushed === undefined ? {} : { pushed: note.pushed }),
        ...(note.merged === undefined ? {} : { merged: note.merged }),
      };
      if (parseTaskProgressList([entry]) === null) {
        warnProgressDropped();
        continue;
      }
      out.push(entry);
    }
    return out;
  }

  #evict(): void {
    const cutoff = this.#now() - LEDGER_MAX_AGE_MS;
    for (const [id, at] of this.#tasks) {
      if (at >= cutoff && this.#tasks.size <= LEDGER_MAX) break;
      this.#tasks.delete(id);
      this.#notes.delete(id);
      this.#since = Math.max(this.#since, at + 1);
    }
  }

  /** Serialized, each write the whole ledger as it stands then; temp, fsync, rename. */
  #persist(): Promise<void> {
    const path = this.#path;
    if (path === null) return Promise.resolve();
    const run = this.#writing
      .catch(() => undefined)
      .then(async () => {
        // Only when there are notes, so an untouched ledger stays byte-identical to the old v1.
        const progress = [...this.#notes.values()];
        const file: LedgerFile = {
          v: LEDGER_VERSION,
          since: this.#since,
          tasks: [...this.#tasks],
          ...(progress.length === 0 ? {} : { progress }),
        };
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.${process.pid}.${tempSeq++}.tmp`;
        try {
          const handle = await open(temp, "w", LEDGER_MODE);
          try {
            await handle.writeFile(`${JSON.stringify(file)}\n`);
            // Write-ahead means on disk before the launch, not in a page cache a power cut drops.
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temp, path);
        } catch (err) {
          await unlink(temp).catch(() => {});
          throw err;
        }
      });
    this.#writing = run;
    return run;
  }
}
