import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BRANCH_MAX_LENGTH,
  EXIT_STATUS_MAX,
  httpsUrl,
  isRecord,
  isTaskId,
  LAUNCH_LEDGER_MAX_AGE_MS,
  parseTaskProgressList,
  SIGKILL_STATUS,
  type TaskProgress,
} from "@seance/shared";
import { writeDurable } from "./durable-write.ts";
import { log } from "./log.ts";
import { isOomSample, OOM_REFRESH_MS, type OomSample } from "./oom-kill.ts";
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
 * last-seen branch, sticky pushed and merged, the PR URL, the exit status — for
 * `SessionsResponse.progress` and the branch-state emitter. That is not
 * write-ahead: noted after the fact, best-effort, and a failed write costs the
 * note, never the proof. It is v1 plus an optional top-level `progress` array,
 * which an older reader ignores (it keeps `since` and `tasks`, and its next
 * write drops `progress`). Paths and branch names carry the spawn's slug, as
 * the worktree directory and window name already do, never the prompt; the file
 * is 0600 in the state dir.
 *
 * `pending` is the ids whose launch was recorded but has not yet settled
 * (landed, retracted, refused or crashed), written in the same durable write as
 * `tasks`. An id still pending when the file is opened is a launch the process
 * died in the middle of: it becomes `interrupted` (persisted, and kept in
 * `tasks`, so `since` and `ended` are untouched) until a listing carrying it, a
 * harvested exit, a bound session event or a later landing of it clears it.
 * Both are optional top-level arrays an older reader ignores, and neither may
 * ever make a file corrupt: that would reset `since`.
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
export const LEDGER_MAX_AGE_MS = LAUNCH_LEDGER_MAX_AGE_MS;

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
  /** The last tip that held own work (not in the default, and a net change from its fork), 40 or 64 hex: what merged and pushed are judged on once the branch is reset or gone. */
  readonly tip?: string;
  /** The tip once held own work, as `tip` says: sticky, gates pushed and merged. */
  readonly ahead?: true;
  readonly pushed?: true;
  readonly merged?: true;
  /** The session reported its task done (#21): sticky, and read by the leader only for `until: "reported"`. */
  readonly reported?: true;
  readonly prUrl?: string;
  /** The session's exit status, noted from its dead pane before the pane is closed (`exit-status.ts`). */
  readonly exit?: number;
  /**
   * The pid of the tmux server the task's pane was launched on, under `remain-on-exit on` with the
   * per-pane `pane-died` hook (`spawn.ts`): what makes the task one harvest may judge `vanished`, and
   * which server's listing may judge it. Sticky; internal, never in `TaskProgress`. A launch from
   * before this field, or on another backend, has none and is never judged.
   */
  readonly server?: number;
  /** This daemon closed the pane itself (despawn, reap, harvest): never judged `vanished`. Sticky; internal. */
  readonly closedHere?: true;
  /**
   * The pane went from tmux with no exit status and no close of this daemon's own (`exit-status.ts`):
   * `TaskProgress.vanished`, carried only while `exit` is absent. Sticky.
   */
  readonly vanished?: true;
  /**
   * Its pane's cgroup `oom_kill` count as last seen while the pane lived (`oom-kill.ts`), with the pane
   * it came from; internal, never in `TaskProgress`. Here so a restart keeps the baseline. Rewritten
   * on a change or once `OOM_REFRESH_MS` old, so it stands for a recent pass that saw the pane alive.
   */
  readonly oom?: OomSample;
  /** `judgeOomKill`'s verdict, noted with a SIGKILL `exit` (`TaskProgress.oomKill`). */
  readonly oomKill?: boolean;
}

/** How `LaunchLedger.apply` ended; see there. */
export type NoteOutcome = "refused" | "same" | "written" | "unwritten";

export interface NotedTask extends TaskNote {
  readonly taskId: string;
  /** Last change, never refreshed by an unchanged pass. */
  readonly at: number;
  /**
   * When the note's site was set (`startNote`, or `note` with a new path), never moved by a later change:
   * of two tasks naming one path, the newer site owns it. Ledger order cannot say — a re-recorded id moves
   * to the end. Absent on a note from before this field: the oldest.
   */
  readonly siteAt?: number;
}

/**
 * The note that owns each path: of two tasks naming one, the newer site (`siteAt`, absent
 * as 0) wins, and a tie goes to the later in `notes`. One rule for branch-state's live read
 * and for continuation, so they cannot drift.
 */
export function pathOwners(notes: readonly NotedTask[]): ReadonlyMap<string, NotedTask> {
  const newest = new Map<string, NotedTask>();
  for (const note of notes) {
    if (note.path === undefined) continue;
    const held = newest.get(note.path);
    if (held === undefined || (note.siteAt ?? 0) >= (held.siteAt ?? 0)) newest.set(note.path, note);
  }
  return newest;
}

interface LedgerFile {
  readonly v: typeof LEDGER_VERSION;
  readonly since: number;
  /** `[taskId, launchedAt]`, oldest first. */
  readonly tasks: readonly (readonly [string, number])[];
  /** Best-effort notes, outside the proof: an older reader ignores them. */
  readonly progress?: readonly NotedTask[];
  /** Ids recorded whose launch had not settled when this was written. */
  readonly pending?: readonly string[];
  /** Ids a past process died launching: see the header. */
  readonly interrupted?: readonly string[];
}

const PATH_MAX_LENGTH = 4096;
const TIP_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/u;

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

/** One entry, field by field: a bad field is dropped, a bad entry is skipped, never the file. */
function parseNote(raw: unknown, ids: ReadonlySet<string>): NotedTask | null {
  if (!isRecord(raw)) return null;
  const {
    taskId,
    at,
    siteAt,
    repo,
    path,
    branch,
    tip,
    ahead,
    pushed,
    merged,
    reported,
    prUrl,
    exit,
    oom,
    oomKill,
    server,
    closedHere,
    vanished,
  } = raw;
  if (typeof taskId !== "string" || !ids.has(taskId) || typeof at !== "number" || !Number.isFinite(at)) return null;
  const repoText = boundedText(repo, PATH_MAX_LENGTH);
  const pathText = boundedText(path, PATH_MAX_LENGTH);
  const branchText = boundedText(branch, BRANCH_MAX_LENGTH);
  const tipText = typeof tip === "string" && TIP_PATTERN.test(tip) ? tip : undefined;
  const url = typeof prUrl === "string" && httpsUrl(prUrl) === prUrl ? prUrl : undefined;
  return {
    taskId,
    at,
    ...(typeof siteAt === "number" && Number.isFinite(siteAt) ? { siteAt } : {}),
    ...(repoText === undefined ? {} : { repo: repoText }),
    ...(pathText === undefined ? {} : { path: pathText }),
    ...(branchText === undefined ? {} : { branch: branchText }),
    ...(tipText === undefined ? {} : { tip: tipText }),
    ...(ahead === true ? { ahead: true as const } : {}),
    ...(pushed === true ? { pushed: true as const } : {}),
    ...(merged === true ? { merged: true as const } : {}),
    ...(reported === true ? { reported: true as const } : {}),
    ...(url === undefined ? {} : { prUrl: url }),
    ...(isExitStatus(exit) ? { exit } : {}),
    ...(isOomSample(oom) ? { oom } : {}),
    ...(typeof oomKill === "boolean" ? { oomKill } : {}),
    ...(isServerPid(server) ? { server } : {}),
    ...(closedHere === true ? { closedHere: true as const } : {}),
    ...(vanished === true ? { vanished: true as const } : {}),
  };
}

function isServerPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isUnaccounted(note: NotedTask): boolean {
  return note.exit === undefined && note.closedHere === undefined && note.vanished === undefined;
}

function isExitStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= EXIT_STATUS_MAX;
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
  return {
    v: LEDGER_VERSION,
    since,
    tasks: entries,
    progress,
    pending: knownIds(raw["pending"], ids),
    interrupted: knownIds(raw["interrupted"], ids),
  };
}

/** Lenient: a non-array is none, an entry that is no recorded task id is skipped. Never a reason to call the file corrupt. */
function knownIds(value: unknown, ids: ReadonlySet<string>): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => isTaskId(id) && ids.has(id));
}

async function freshSince(path: string, now: () => number): Promise<number> {
  const dirMtime = await stat(dirname(path)).then(
    (info) => Math.floor(info.mtimeMs) + 1,
    () => 0,
  );
  return Math.max(now(), dirMtime);
}

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
    ...(base?.siteAt === undefined ? {} : { siteAt: base.siteAt }),
    ...(patch.repo !== undefined ? { repo: patch.repo } : base?.repo !== undefined ? { repo: base.repo } : {}),
    ...(patch.path !== undefined ? { path: patch.path } : base?.path !== undefined ? { path: base.path } : {}),
    ...(patch.branch !== undefined
      ? { branch: patch.branch }
      : base?.branch !== undefined
        ? { branch: base.branch }
        : {}),
    ...(patch.tip !== undefined ? { tip: patch.tip } : base?.tip !== undefined ? { tip: base.tip } : {}),
    ...(patch.prUrl !== undefined ? { prUrl: patch.prUrl } : base?.prUrl !== undefined ? { prUrl: base.prUrl } : {}),
    ...(patch.exit !== undefined ? { exit: patch.exit } : base?.exit !== undefined ? { exit: base.exit } : {}),
    ...(patch.oom !== undefined ? { oom: patch.oom } : base?.oom !== undefined ? { oom: base.oom } : {}),
    // A verdict belongs to the exit it was judged with: another exit (or a new launch, whose base is gone)
    // drops it, but a re-note of the same exit keeps it, since a racing harvest pass whose judge read failed carries none.
    ...(patch.oomKill !== undefined
      ? { oomKill: patch.oomKill }
      : base?.oomKill !== undefined && (patch.exit === undefined || patch.exit === base.exit)
        ? { oomKill: base.oomKill }
        : {}),
    ...(patch.ahead === true || base?.ahead === true ? { ahead: true as const } : {}),
    ...(patch.pushed === true || base?.pushed === true ? { pushed: true as const } : {}),
    ...(patch.merged === true || base?.merged === true ? { merged: true as const } : {}),
    ...(patch.reported === true || base?.reported === true ? { reported: true as const } : {}),
    ...(patch.server !== undefined
      ? { server: patch.server }
      : base?.server !== undefined
        ? { server: base.server }
        : {}),
    ...(patch.closedHere === true || base?.closedHere === true ? { closedHere: true as const } : {}),
    ...(patch.vanished === true || base?.vanished === true ? { vanished: true as const } : {}),
  };
}

/** The same reading of the same pane, unless the old one is `OOM_REFRESH_MS` stale: a quiet pass is no write. */
function sameSample(a: OomSample | undefined, b: OomSample | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.cgroup === b.cgroup &&
    a.kills === b.kills &&
    a.paneId === b.paneId &&
    a.windowId === b.windowId &&
    b.at - a.at < OOM_REFRESH_MS
  );
}

/** Equal but for the OOM samples, which are no progress: a change there alone keeps `at`. */
function sameProgress(a: NotedTask, b: NotedTask): boolean {
  return (
    a.repo === b.repo &&
    a.path === b.path &&
    a.branch === b.branch &&
    a.tip === b.tip &&
    a.prUrl === b.prUrl &&
    a.exit === b.exit &&
    a.ahead === b.ahead &&
    a.pushed === b.pushed &&
    a.merged === b.merged &&
    a.reported === b.reported &&
    a.oomKill === b.oomKill &&
    a.vanished === b.vanished
  );
}

/** `server` and `closedHere` write but are no progress: they never move `at`. */
function sameNote(a: NotedTask, b: NotedTask): boolean {
  return sameProgress(a, b) && sameSample(a.oom, b.oom) && a.server === b.server && a.closedHere === b.closedHere;
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
  /** Recorded, launch not yet settled: written with `tasks`, so a process that dies mid-spawn leaves the id here. */
  readonly #pending = new Set<string>();
  /** Ids a previous process died launching; always a subset of `#tasks`. */
  readonly #interrupted: Set<string>;
  #since: number;
  #writing: Promise<unknown> = Promise.resolve();

  private constructor(path: string | null, now: () => number, since: number, file: LedgerFile | null) {
    this.#path = path;
    this.#now = now;
    this.#since = file?.since ?? since;
    this.#tasks = new Map(file?.tasks ?? []);
    this.#notes = new Map((file?.progress ?? []).map((note) => [note.taskId, note]));
    this.#interrupted = new Set([...(file?.interrupted ?? []), ...(file?.pending ?? [])]);
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
    const ledger = new LaunchLedger(path, now, parsed === null ? await freshSince(path, now) : 0, parsed);
    const promoted = parsed?.pending ?? [];
    if (promoted.length > 0) {
      log.warn(
        `launch ledger: the previous process exited while launching ${promoted.join(", ")} — reporting them interrupted`,
      );
    }
    return ledger;
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
    this.#pending.add(taskId);
    try {
      await this.#persist();
    } catch (err) {
      // Not while another record of the id waits on its own write, which would
      // then put the ledger on disk without it and report success. If that one
      // fails too, the id stays in memory with nothing launched: it reads as
      // ran-and-ended, never as never-started.
      if (fresh && this.#recording.get(taskId) === 1) {
        this.#tasks.delete(taskId);
        this.#pending.delete(taskId);
      }
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
    this.#pending.delete(taskId);
    this.#interrupted.delete(taskId);
    await this.#persist().catch((err: unknown) => {
      log.warn(`launch ledger: could not retract a launch that never ran (${String(err)})`);
    });
  }

  /**
   * The launch recorded for this id settled: it left `pending`, so a restart no
   * longer reads it as interrupted. Best-effort — a failed write costs only
   * that, and the id is then reported interrupted after a restart, which is the
   * safe side. Nothing to write when it was not pending.
   */
  async clearPending(taskId: string): Promise<void> {
    if (!this.#pending.delete(taskId)) return;
    await this.#persist().catch((err: unknown) => {
      log.warn(`launch ledger: could not clear a settled launch's pending mark (${String(err)})`);
    });
  }

  /**
   * Ids a previous process died launching, still in the ledger: what
   * `SessionsResponse.interrupted` carries.
   */
  interrupted(): readonly string[] {
    this.#evict();
    return [...this.#interrupted].filter((id) => this.#tasks.has(id));
  }

  /**
   * The ids are accounted for (listed live, exited, bound to a pane, landed):
   * no longer interrupted. Memory changes before the first await, so a reply
   * built right after never repeats them; the write is best-effort and never
   * rejects.
   */
  async clearInterrupted(ids: Iterable<string>): Promise<void> {
    let removed = false;
    for (const id of ids) if (this.#interrupted.delete(id)) removed = true;
    if (!removed) return;
    await this.#persist().catch((err: unknown) => {
      log.warn(`launch ledger: could not clear an interrupted mark (${String(err)})`);
    });
  }

  /**
   * Best-effort, unlike `record`: never throws, and memory keeps the change
   * when the write fails — the next write carries it. A new `path` is a
   * relaunch under the same id and starts the note afresh; otherwise `ahead`,
   * `pushed` and `merged` never clear. `at` moves only on a change, so an
   * unchanged pass costs no write. Never touches `since` or the ids.
   *
   * `under` pins the launch the patch was computed for: a relaunch that landed
   * meanwhile moved `siteAt`, and the old launch's state must not seed the new
   * note. False when the patch was refused (unknown id, or stale `under`).
   */
  async note(taskId: string, patch: TaskNote, under?: { readonly siteAt: number | undefined }): Promise<boolean> {
    return (await this.apply(taskId, patch, under)) !== "refused";
  }

  /**
   * `note` saying how it went, for the one caller whose reply promises the
   * note is on disk: `same` when the patch changed nothing (a report already
   * held), `unwritten` when memory has it and the write failed.
   */
  async apply(taskId: string, patch: TaskNote, under?: { readonly siteAt: number | undefined }): Promise<NoteOutcome> {
    const staged = this.#stage(taskId, patch, under);
    if (staged !== "written") return staged;
    try {
      await this.#persist();
    } catch (err) {
      log.warn(`launch ledger: could not record task progress (${String(err)})`);
      return "unwritten";
    }
    return "written";
  }

  /**
   * `note` for several tasks, persisted once: a pass that samples every live
   * pane would otherwise write the ledger once per pane. A pass that changes
   * no note costs no write.
   */
  async noteBatch(entries: readonly { readonly taskId: string; readonly patch: TaskNote }[]): Promise<void> {
    let changed = false;
    for (const { taskId, patch } of entries) if (this.#stage(taskId, patch) === "written") changed = true;
    if (!changed) return;
    try {
      await this.#persist();
    } catch (err) {
      log.warn(`launch ledger: could not record task progress (${String(err)})`);
    }
  }

  /** The in-memory half of `apply`: "written" here means staged, not yet on disk. */
  #stage(taskId: string, patch: TaskNote, under?: { readonly siteAt: number | undefined }): NoteOutcome {
    if (!this.#tasks.has(taskId)) return "refused";
    const old = this.#notes.get(taskId);
    if (under !== undefined && old?.siteAt !== under.siteAt) return "refused";
    const resited = patch.path !== undefined && patch.path !== old?.path;
    const base = resited ? undefined : old;
    const next = mergeNote(taskId, base, patch);
    if (old !== undefined && base !== undefined && sameNote(old, next)) return "same";
    const stamp = this.#now();
    const at = old !== undefined && base !== undefined && sameProgress(old, next) ? old.at : stamp;
    this.#notes.set(taskId, { ...next, at, ...(resited ? { siteAt: stamp } : {}) });
    return "written";
  }

  /**
   * A new launch of this id landed — never a refused or crashed one, whose
   * earlier note stays: its note starts afresh — `{repo, path}` for a
   * worktree launch, nothing for `here` — whatever an earlier launch of the id
   * left. Sticky `ahead`/`pushed`/`merged` and the PR URL describe a worktree
   * that no longer is this task's; carried over, they could settle it merged.
   * `prUrl` is one the new session reported while its spawn was still in
   * flight, which the mod sends once: it belongs to the new launch.
   * Best-effort like `note`.
   */
  async startNote(
    taskId: string,
    site?: { readonly repo: string; readonly path: string },
    prUrl?: string,
    server?: number,
  ): Promise<void> {
    if (!this.#tasks.has(taskId)) return;
    // The launch landed: both marks go with it, even where no note is written (a `here` launch with no PR).
    const wasPending = this.#pending.delete(taskId);
    const wasInterrupted = this.#interrupted.delete(taskId);
    const unmarked = wasPending || wasInterrupted;
    if (site === undefined && prUrl === undefined && server === undefined) {
      if (!this.#notes.delete(taskId) && !unmarked) return;
    } else {
      const at = this.#now();
      this.#notes.set(taskId, {
        taskId,
        at,
        ...(site === undefined ? {} : { siteAt: at, repo: site.repo, path: site.path }),
        ...(prUrl === undefined ? {} : { prUrl }),
        ...(server === undefined ? {} : { server }),
      });
    }
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
        note.merged === undefined &&
        note.reported === undefined &&
        note.exit === undefined &&
        note.vanished === undefined
      )
        continue;
      const entry: TaskProgress = {
        taskId: note.taskId,
        at: note.at,
        ...(note.prUrl === undefined ? {} : { prUrl: note.prUrl }),
        ...(note.branch === undefined ? {} : { branch: note.branch }),
        ...(note.pushed === undefined ? {} : { pushed: note.pushed }),
        ...(note.merged === undefined ? {} : { merged: note.merged }),
        ...(note.reported === undefined ? {} : { reported: note.reported }),
        ...(note.exit === undefined ? {} : { exit: note.exit }),
        ...(note.oomKill === undefined || note.exit !== SIGKILL_STATUS ? {} : { oomKill: note.oomKill }),
        // An exit always outranks it: a pane that left a status was not closed from outside.
        ...(note.vanished === true && note.exit === undefined ? { vanished: true as const } : {}),
      };
      if (parseTaskProgressList([entry]) === null) {
        warnProgressDropped();
        continue;
      }
      out.push(entry);
    }
    return out;
  }

  /**
   * Launches whose pane was kept under a known tmux server and that nothing has accounted for yet:
   * no exit, no close of this daemon's own, not already vanished. `recordedAt` is the launch's
   * `record` time, which `noteVanished` re-checks so a relaunch is never judged on its predecessor.
   */
  unaccounted(): readonly { readonly taskId: string; readonly recordedAt: number; readonly server: number }[] {
    this.#evict();
    const out: { taskId: string; recordedAt: number; server: number }[] = [];
    for (const [taskId, recordedAt] of this.#tasks) {
      const note = this.#notes.get(taskId);
      if (note?.server === undefined || !isUnaccounted(note)) continue;
      out.push({ taskId, recordedAt, server: note.server });
    }
    return out;
  }

  /**
   * Notes `vanished` when the launch `recordedAt` still stands and nothing accounted for it meanwhile.
   * The check and the staging are one synchronous span, so a despawn or reap that noted `closedHere`
   * (or a relaunch) first always wins. False when it refused.
   */
  async noteVanished(taskId: string, recordedAt: number): Promise<boolean> {
    if (this.#tasks.get(taskId) !== recordedAt) return false;
    const note = this.#notes.get(taskId);
    if (note?.server === undefined || !isUnaccounted(note)) return false;
    if (this.#stage(taskId, { vanished: true }) !== "written") return false;
    log.info(`launch ledger: task ${taskId}'s window closed with no exit status (vanished)`);
    try {
      await this.#persist();
    } catch (err) {
      log.warn(`launch ledger: could not record task progress (${String(err)})`);
    }
    return true;
  }

  #evict(): void {
    const cutoff = this.#now() - LEDGER_MAX_AGE_MS;
    for (const [id, at] of this.#tasks) {
      if (at >= cutoff && this.#tasks.size <= LEDGER_MAX) break;
      this.#tasks.delete(id);
      this.#notes.delete(id);
      this.#pending.delete(id);
      this.#interrupted.delete(id);
      this.#since = Math.max(this.#since, at + 1);
    }
  }

  /** Serialized, each write the whole ledger as it stands then, durably (`writeDurable`). */
  #persist(): Promise<void> {
    const path = this.#path;
    if (path === null) return Promise.resolve();
    const run = this.#writing
      .catch(() => undefined)
      .then(() => {
        // Only when there are notes or marks, so a settled ledger stays byte-identical to the old v1.
        const progress = [...this.#notes.values()];
        const pending = [...this.#pending];
        const interrupted = [...this.#interrupted];
        const file: LedgerFile = {
          v: LEDGER_VERSION,
          since: this.#since,
          tasks: [...this.#tasks],
          ...(progress.length === 0 ? {} : { progress }),
          ...(pending.length === 0 ? {} : { pending }),
          ...(interrupted.length === 0 ? {} : { interrupted }),
        };
        // Write-ahead means on disk before the launch, the rename included: synced without its
        // directory, a power cut can bring back the file before it, and `since` then "proves"
        // the launch it lacks never happened.
        return writeDurable(path, `${JSON.stringify(file)}\n`, LEDGER_MODE);
      });
    this.#writing = run;
    return run;
  }
}
