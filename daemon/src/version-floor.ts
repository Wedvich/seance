import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, isTaskId, STORE_TOMBSTONE_MS } from "@seance/shared";
import { writeDurable } from "./durable-write.ts";
import { log } from "./log.ts";
import { stateDir } from "./paths.ts";

/**
 * The leader's version floor (DESIGN.md, threat model, "Relay compromise"):
 * the highest version this process has seen or written at each `task:` key and
 * at `queue:pause`. Version binding stops a token holder putting an old blob
 * back, because the relay counts versions; it cannot stop the relay itself
 * answering a read with an authentic old blob at that blob's own version. Below
 * the floor such a record reads `version_regressed` (`flooredStore` in
 * `queue-store.ts`), so a task rolled back is never admitted or dispatched
 * again, and a pause rolled back holds the whole queue.
 *
 * One per process, like `schedulerGuard` in `run.ts`: the relay chooses which
 * term a read reaches, so a floor per term would let it roll back under the
 * next one. On disk, 0600 in the state dir, so a restart keeps it. Ids and
 * versions only.
 *
 * Bounded to keys seen within `STORE_TOMBSTONE_MS`, and to `FLOOR_MAX` of them,
 * the least recently seen going first: every takeover's listing sees again what
 * the store still holds, and a deleted key's tombstone lasts no longer.
 */
export const FLOOR_MAX = 4096;

const FLOOR_VERSION = 1;
const FLOOR_MODE = 0o600;

/** A sighting refreshes `at` on disk no more often than this; a version change always writes. */
const SEEN_SLACK_MS = 24 * 3_600_000;

export function versionFloorPath(): string {
  return join(stateDir(), "version-floor.json");
}

/**
 * `deleting`: this leader sent a delete whose answer was lost, so a read that
 * finds no record is that delete having landed. `gone`: the delete landed, and
 * the relay's tombstone refuses any record there — so `version` is one past the
 * deleted one, and any record at the key reads regressed.
 */
type Mark = "deleting" | "gone";

interface TaskFloor {
  readonly version: number;
  /** Last seen, written or deleted, ms. */
  readonly at: number;
  /** `at` as last written to disk. */
  readonly savedAt: number;
  readonly mark?: Mark;
}

interface FloorFile {
  readonly v: typeof FLOOR_VERSION;
  readonly pause: number;
  /** `[taskId, version, at, mark?]`. */
  readonly tasks: readonly (readonly [string, number, number, Mark?])[];
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** All or nothing: a floor half read could lower a key it dropped. */
function parseFloor(raw: unknown): FloorFile | null {
  if (!isRecord(raw) || raw["v"] !== FLOOR_VERSION || !isVersion(raw["pause"]) || !Array.isArray(raw["tasks"])) {
    return null;
  }
  const tasks: (readonly [string, number, number, Mark?])[] = [];
  for (const entry of raw["tasks"]) {
    if (!Array.isArray(entry) || entry.length < 3 || entry.length > 4) return null;
    const [id, version, at, mark]: unknown[] = entry;
    if (!isTaskId(id) || !isVersion(version) || typeof at !== "number" || !Number.isFinite(at)) return null;
    if (mark !== undefined && mark !== "deleting" && mark !== "gone") return null;
    tasks.push(mark === undefined ? [id, version, at] : [id, version, at, mark]);
  }
  return { v: FLOOR_VERSION, pause: raw["pause"], tasks };
}

export class VersionFloor {
  readonly #path: string | null;
  readonly #now: () => number;
  /** Insertion order is sighting order: a key seen again moves to the end. */
  readonly #tasks = new Map<string, TaskFloor>();
  #pause: number;
  #writing: Promise<void> = Promise.resolve();
  #queued = false;

  private constructor(path: string | null, now: () => number, file: FloorFile | null) {
    this.#path = path;
    this.#now = now;
    this.#pause = file?.pause ?? 0;
    const ordered = (file?.tasks ?? []).toSorted((a, b) => a[2] - b[2]);
    for (const [id, version, at, mark] of ordered) {
      this.#tasks.set(id, { version, at, savedAt: at, ...(mark === undefined ? {} : { mark }) });
    }
  }

  /**
   * Never throws. A missing file is an empty floor; so is an unreadable or
   * corrupt one, with a warning, replaced on the next write: a floor that
   * cannot be read protects nothing, and the launch ledger's refusal
   * (`task_launched`) still stands behind it.
   */
  static async open(path: string = versionFloorPath(), now: () => number = Date.now): Promise<VersionFloor> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      const code = err instanceof Error && "code" in err ? err.code : undefined;
      if (code !== "ENOENT") log.warn(`version floor at ${path} unreadable (${String(err)}) — starting it afresh`);
      return new VersionFloor(path, now, null);
    }
    let parsed: FloorFile | null = null;
    try {
      parsed = parseFloor(JSON.parse(text));
    } catch {
      // Falls through to the warning below.
    }
    if (parsed === null) log.warn(`version floor at ${path} is corrupt — starting it afresh`);
    return new VersionFloor(path, now, parsed);
  }

  /** No file: for tests, and a host that keeps none. */
  static memory(now: () => number = Date.now): VersionFloor {
    return new VersionFloor(null, now, null);
  }

  /** The lowest version a record at `task:<id>` may have; 0 for a key never seen. */
  task(id: string): number {
    this.#evict();
    return this.#tasks.get(id)?.version ?? 0;
  }

  /**
   * A read found a record at `version`, at or above the floor. True when the
   * floor changed enough to be written before the leader acts on the read.
   */
  sawTask(id: string, version: number): boolean {
    const old = this.#tasks.get(id);
    const at = this.#now();
    // A record at or past the version a lost delete aimed at is the delete not having landed.
    const raised = old === undefined || version > old.version || old.mark === "deleting";
    const savedAt = raised ? at : old.savedAt;
    this.#tasks.delete(id);
    this.#tasks.set(id, { version: Math.max(version, old?.version ?? 0), at, savedAt });
    this.#evict();
    return raised || at - savedAt > SEEN_SLACK_MS;
  }

  /** This leader's write landed at `version`. */
  wroteTask(id: string, version: number): boolean {
    return this.sawTask(id, version);
  }

  /** This leader's delete at `version` landed, or (`landed: false`) its answer was lost. */
  deletedTask(id: string, version: number, landed: boolean): void {
    const at = this.#now();
    this.#tasks.delete(id);
    this.#tasks.set(
      id,
      landed ? { version: version + 1, at, savedAt: at, mark: "gone" } : { version, at, savedAt: at, mark: "deleting" },
    );
    this.#evict();
  }

  /**
   * A read found no record at `task:<id>`. True when that is this leader's own
   * delete, or a key it never saw; false when the record vanished without one,
   * which a reader must not take for gone.
   */
  vanished(id: string): boolean {
    this.#evict();
    const old = this.#tasks.get(id);
    if (old === undefined || old.mark === "gone") return true;
    if (old.mark !== "deleting") return false;
    this.deletedTask(id, old.version, true);
    return true;
  }

  /** The lowest version `queue:pause` may have; 0 before any was seen. */
  pause(): number {
    return this.#pause;
  }

  /** A read found the pause at `version`, at or above the floor. True when that raised it. */
  sawPause(version: number): boolean {
    if (version <= this.#pause) return false;
    this.#pause = version;
    return true;
  }

  /**
   * This leader's own pause write landed at `version` — set, not raised. A
   * `pause` or `resume` is a person's request, sealed past the replay guard, so
   * it is how a queue held by a regressed or missing pause is let go again: a
   * relay whose storage was lost answers every read below the floor until one
   * is written.
   */
  wrotePause(version: number): void {
    this.#pause = version;
  }

  /**
   * Writes the floor as it stands, behind any write in flight, coalesced:
   * concurrent callers share one write. Never rejects — a floor that could not
   * be saved still holds in memory, and the failure is logged.
   */
  save(): Promise<void> {
    const path = this.#path;
    if (path === null) return Promise.resolve();
    if (this.#queued) return this.#writing;
    this.#queued = true;
    this.#writing = this.#writing.then(() => this.#write(path));
    return this.#writing;
  }

  async #write(path: string): Promise<void> {
    this.#queued = false;
    this.#evict();
    const tasks = [...this.#tasks].map(([id, floor]) => {
      this.#tasks.set(id, { ...floor, savedAt: floor.at });
      return floor.mark === undefined
        ? ([id, floor.version, floor.at] as const)
        : ([id, floor.version, floor.at, floor.mark] as const);
    });
    const file: FloorFile = { v: FLOOR_VERSION, pause: this.#pause, tasks };
    try {
      await writeDurable(path, `${JSON.stringify(file)}\n`, FLOOR_MODE);
    } catch (err) {
      log.warn(`version floor: could not save (${String(err)}) — it holds in memory until the next write`);
    }
  }

  #evict(): void {
    const cutoff = this.#now() - STORE_TOMBSTONE_MS;
    for (const [id, floor] of this.#tasks) {
      if (floor.at >= cutoff && this.#tasks.size <= FLOOR_MAX) break;
      this.#tasks.delete(id);
    }
  }
}
