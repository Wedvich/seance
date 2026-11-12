import { Database } from "bun:sqlite";
import { writeFile } from "node:fs/promises";
import type { MetricsRequest, MetricsSeries, MetricsStep } from "@seance/shared";
import { tierSchema, TieredMetrics, type Retention, type Sample } from "../../daemon/src/metrics-tiers.ts";

const HOUR_S = 3_600;

/** A22: 30 s for 48 h, 5 min for a year, hourly forever. */
export const ARCHIVE_RETENTION: Retention = { rawKeepS: 48 * HOUR_S, m5KeepS: 365 * 24 * HOUR_S };

/**
 * The label naming who observed a series: the machine's device id (A33). A
 * daemon's own series name no machine (its store is its own), so the archive
 * adds it; the id, not the name, since a rename must not split a series.
 */
export const OBSERVER_LABEL = "machine";

/**
 * Entry `n` takes the file from `PRAGMA user_version` n to n + 1, in the
 * transaction that opens it. `pull_marks` is the newest point pulled per
 * observer, tier and series: the watermark a pull continues from (A17).
 */
const MIGRATIONS: readonly ((db: Database) => void)[] = [
  (db) => {
    db.exec(tierSchema(true));
    db.exec(`
      CREATE TABLE pull_marks (
        machine TEXT NOT NULL,
        step INTEGER NOT NULL,
        series INTEGER NOT NULL REFERENCES series(id),
        ts INTEGER NOT NULL,
        PRIMARY KEY (machine, step, series)
      ) WITHOUT ROWID;`);
  },
];

export const METRICS_ARCHIVE_SCHEMA_VERSION = MIGRATIONS.length;

/**
 * The archivist's `metrics.sqlite` (docs/archivist.md, A17, A22): the daemon's
 * own tiered store (`daemon/src/metrics-tiers.ts`) at the archive's retention,
 * series per observer and unmerged. Its own file, not tables in
 * `archive.sqlite`: retention prunes these tiers while that file is
 * append-only (A23), and each file's schema moves alone. Live samples never
 * replace a row; a pulled one replaces live, and a pulled 5-min or hourly row
 * is the daemon's own average, which no rollup here re-averages from a raw tier
 * that may hold only part of the bucket.
 */
export class MetricsArchive {
  readonly #db: Database;
  readonly #tiers: TieredMetrics;
  readonly #mark;
  readonly #marks;

  private constructor(db: Database) {
    this.#db = db;
    try {
      // As archive.sqlite: a read-write shell on the file waits briefly rather than failing a write at once.
      db.exec("PRAGMA busy_timeout = 2000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      db.transaction(() => {
        const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
        if (version > METRICS_ARCHIVE_SCHEMA_VERSION) {
          throw new Error(
            `metrics.sqlite is at schema ${version}, newer than this build's ${METRICS_ARCHIVE_SCHEMA_VERSION} — update the archivist`,
          );
        }
        for (const migrate of MIGRATIONS.slice(version)) migrate(db);
        if (version < METRICS_ARCHIVE_SCHEMA_VERSION) {
          db.exec(`PRAGMA user_version = ${METRICS_ARCHIVE_SCHEMA_VERSION}`);
        }
      })();
      this.#tiers = new TieredMetrics(db, { retention: ARCHIVE_RETENTION, pulled: true });
      this.#mark = db.query<void, [string, number, number, number]>(
        `INSERT INTO pull_marks (machine, step, series, ts) VALUES (?, ?, ?, ?)
         ON CONFLICT (machine, step, series) DO UPDATE SET ts = max(ts, excluded.ts)`,
      );
      this.#marks = db.query<{ lo: number | null; hi: number | null }, [string, number]>(
        "SELECT min(ts) AS lo, max(ts) AS hi FROM pull_marks WHERE machine = ? AND step = ?",
      );
    } catch (err) {
      db.close();
      throw err;
    }
  }

  /** Owner-only, created at that mode before SQLite opens it, so the WAL and shared-memory files take it too. */
  static async open(path: string): Promise<MetricsArchive> {
    try {
      await writeFile(path, "", { mode: 0o600, flag: "wx" });
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
    }
    return new MetricsArchive(new Database(path, { create: false, strict: true }));
  }

  static memory(): MetricsArchive {
    return new MetricsArchive(new Database(":memory:", { strict: true }));
  }

  /** Live samples (a `status` frame): kept only where no row is held, as the daemon writes its own. */
  ingest(samples: readonly Sample[], now: number): void {
    this.#tiers.write(samples, now);
  }

  /**
   * One pulled page from `machine` at `step`, each series already carrying its
   * archive labels. Replaces what is held at the same points, and moves each
   * series' watermark to its newest point (never back), whether or not the
   * point was recent enough to keep.
   */
  writePulled(machine: string, step: MetricsStep, series: readonly MetricsSeries[], now: number): void {
    const samples = series.flatMap(({ metric, labels, points }) =>
      points.map(([ts, value]) => ({ metric, labels, ts, value })),
    );
    this.#db.transaction(() => {
      this.#tiers.writePulled(step, samples, now);
      for (const { metric, labels, points } of series) {
        const newest = points.at(-1)?.[0];
        if (newest === undefined || !Number.isInteger(newest)) continue;
        const id = this.#tiers.seriesIdOf(metric, labels);
        if (id !== null) this.#mark.run(machine, step, id, newest);
      }
    })();
  }

  /**
   * Where the next pull of `machine` at `step` starts: the oldest series
   * watermark, so a series that lags (a quota reading stamped at its fetch
   * time) is re-read from its own, but never more than `lateS` behind the
   * newest, so a series that stopped (an exclave removed) cannot hold every
   * later pull back. Null when nothing was ever pulled there.
   */
  pullFrom(machine: string, step: MetricsStep, lateS: number): number | null {
    const row = this.#marks.get(machine, step);
    if (row === null || row.lo === null || row.hi === null) return null;
    return Math.max(row.lo, row.hi - lateS);
  }

  query(request: MetricsRequest): readonly MetricsSeries[] {
    return this.#tiers.query(request);
  }

  close(): void {
    this.#db.close();
  }
}
