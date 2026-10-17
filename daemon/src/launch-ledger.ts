import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isRecord, isTaskId } from "@seance/shared";
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

interface LedgerFile {
  readonly v: typeof LEDGER_VERSION;
  readonly since: number;
  /** `[taskId, launchedAt]`, oldest first. */
  readonly tasks: readonly (readonly [string, number])[];
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
  return { v: LEDGER_VERSION, since, tasks: entries };
}

async function freshSince(path: string, now: () => number): Promise<number> {
  const dirMtime = await stat(dirname(path)).then(
    (info) => Math.floor(info.mtimeMs) + 1,
    () => 0,
  );
  return Math.max(now(), dirMtime);
}

let tempSeq = 0;

export class LaunchLedger {
  readonly #path: string | null;
  readonly #now: () => number;
  /** Insertion order is age order: a re-recorded id moves to the end. */
  readonly #tasks: Map<string, number>;
  /** Records of each id not yet on disk or failed: a failure deletes the id only when it is the last. */
  readonly #recording = new Map<string, number>();
  #since: number;
  #writing: Promise<unknown> = Promise.resolve();

  private constructor(path: string | null, now: () => number, since: number, file: LedgerFile | null) {
    this.#path = path;
    this.#now = now;
    this.#since = file?.since ?? since;
    this.#tasks = new Map(file?.tasks ?? []);
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
    await this.#persist().catch((err: unknown) => {
      log.warn(`launch ledger: could not retract a launch that never ran (${String(err)})`);
    });
  }

  #evict(): void {
    const cutoff = this.#now() - LEDGER_MAX_AGE_MS;
    for (const [id, at] of this.#tasks) {
      if (at >= cutoff && this.#tasks.size <= LEDGER_MAX) break;
      this.#tasks.delete(id);
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
        const file: LedgerFile = { v: LEDGER_VERSION, since: this.#since, tasks: [...this.#tasks] };
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
