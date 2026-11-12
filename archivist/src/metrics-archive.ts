import { Database } from "bun:sqlite";
import { writeFile } from "node:fs/promises";
import {
  METRICS_STEPS,
  type ArchiveMetricsRequest,
  type ArchiveTableStatus,
  type MetricsRequest,
  type MetricsSeries,
  type MetricsStep,
} from "@seance/shared";
import {
  labelKey,
  matchesLabels,
  parseLabels,
  TIERS,
  tierSchema,
  TieredMetrics,
  type Retention,
  type Sample,
} from "../../daemon/src/metrics-tiers.ts";

const HOUR_S = 3_600;

/** Buckets of a tier per count range (see `countSamples`). */
const COUNT_CHUNK_BUCKETS = 2_000;

/** A22: 30 s for 48 h, 5 min for a year, hourly forever. */
export const ARCHIVE_RETENTION: Retention = { rawKeepS: 48 * HOUR_S, m5KeepS: 365 * 24 * HOUR_S };

/**
 * The label naming who observed a series: the machine's device id (A33). A
 * daemon's own series name no machine (its store is its own), so the archive
 * adds it; the id, not the name, since a rename must not split a series.
 */
export const OBSERVER_LABEL = "machine";

/** Labels an account's merged series drops (A33): who observed it, and through which exclave. */
const MERGED_AWAY: ReadonlySet<string> = new Set([OBSERVER_LABEL, "exclave"]);

/** The tier the archive's steps past `METRICS_STEPS` (6 h, 1 d) are computed from. */
const COARSE_FROM: MetricsStep = 3600;

interface TierRow {
  readonly series: number;
  readonly ts: number;
  readonly value: number;
}

interface PickedSeries {
  readonly id: number;
  readonly metric: string;
  readonly labels: Readonly<Record<string, string>>;
}

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
  readonly #allSeries;

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
      this.#allSeries = db.query<{ id: number; metric: string; labels: string }, []>(
        "SELECT id, metric, labels FROM series",
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
        // Not `at(-1)`: a reply's order is the daemon's word, and the mark is the newest point.
        const newest = points.reduce((max, [ts]) => (Number.isInteger(ts) ? Math.max(max, ts) : max), -Infinity);
        if (newest === -Infinity) continue;
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

  /**
   * Rows over the three tiers, in bounded `ts` ranges with a macrotask between
   * them. `bun:sqlite` is synchronous on the one loop the seat socket and the
   * collectors share, and the tiers are `WITHOUT ROWID` with tens of millions
   * of rows on a mature fleet, so one `count(*)` would stall all of them. A
   * range is `COUNT_CHUNK_BUCKETS` buckets of its tier (30 s raw: about 17 h;
   * 5 min: about 7 d; hourly: about 83 d), a short primary-key range scan.
   * Rows written or pruned while a pass runs make the total approximate, which
   * a display tolerates. `oldest` is in ms; `ts` is seconds.
   */
  async countSamples(chunkBuckets: number = COUNT_CHUNK_BUCKETS): Promise<ArchiveTableStatus> {
    let rows = 0;
    let oldestS: number | null = null;
    for (const step of METRICS_STEPS) {
      const table = TIERS[step];
      const bounds = this.#db
        .query<{ lo: number | null; hi: number | null }, []>(`SELECT min(ts) AS lo, max(ts) AS hi FROM ${table}`)
        .get();
      if (bounds === null || bounds.lo === null || bounds.hi === null) continue;
      oldestS = oldestS === null ? bounds.lo : Math.min(oldestS, bounds.lo);
      const count = this.#db.query<{ n: number }, [number, number]>(
        `SELECT count(*) AS n FROM ${table} WHERE ts >= ? AND ts < ?`,
      );
      const span = step * chunkBuckets;
      for (let from = bounds.lo; from <= bounds.hi; from += span) {
        rows += count.get(from, from + span)?.n ?? 0;
        // oxlint-disable-next-line no-await-in-loop -- the yield between ranges is the point
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    }
    return { rows, oldest: oldestS === null ? null : oldestS * 1000 };
  }

  query(request: MetricsRequest): readonly MetricsSeries[] {
    return this.#tiers.query(request);
  }

  /**
   * `archive-metrics` (A31–A33); bounds on the range are the parser's. The
   * series are picked from the `series` table by label first, so a tier is
   * read only for those ids. A machine gets its own observed series as stored,
   * at the step's tier, or for 6 h and 1 d the average of its hourly rows per
   * bucket (each tier is the average of the one below). An account gets every
   * series labelled with it, from any observer and exclave, merged per bucket:
   * the newest observation in it wins, and rows at the same instant (always so
   * on a rolled tier, every row at its bucket's start) take the larger value,
   * since within a window usage only rises; `machine` and `exclave` are dropped.
   */
  queryArchive(request: ArchiveMetricsRequest): readonly MetricsSeries[] {
    const target: Readonly<Record<string, string>> =
      "machine" in request ? { [OBSERVER_LABEL]: request.machine } : { account: request.account };
    const names = request.names === undefined ? null : new Set(request.names);
    const picked: PickedSeries[] = [];
    for (const row of this.#allSeries.all()) {
      if (names !== null && !names.has(row.metric)) continue;
      const labels = parseLabels(row.labels);
      if (!matchesLabels(labels, target)) continue;
      if (request.labels !== undefined && !matchesLabels(labels, request.labels)) continue;
      picked.push({ id: row.id, metric: row.metric, labels });
    }
    if (picked.length === 0) return [];
    const native = METRICS_STEPS.find((step) => step === request.step);
    const tier = TIERS[native ?? COARSE_FROM];
    const ids = JSON.stringify(picked.map((series) => series.id));
    const inRange = `ts >= ?1 AND ts <= ?2 AND series IN (SELECT value FROM json_each(?3))`;
    const bucketOf = `(ts / CAST(?4 AS INTEGER)) * CAST(?4 AS INTEGER)`;
    const byId = new Map(picked.map((series) => [series.id, series]));
    if ("account" in request) {
      // SQLite's bare column beside max(): `value` is the row holding each series' newest `ts` in the bucket.
      const rows = this.#db
        .query<TierRow & { readonly bucket: number }, [number, number, string, number]>(
          `SELECT series, ${bucketOf} AS bucket, max(ts) AS ts, value FROM ${tier}
           WHERE ${inRange} GROUP BY series, bucket`,
        )
        .all(request.from, request.to, ids, request.step);
      return mergeAccount(rows, byId);
    }
    const rows =
      native === undefined
        ? this.#db
            .query<TierRow, [number, number, string, number]>(
              `SELECT series, ${bucketOf} AS ts, avg(value) AS value FROM ${tier}
               WHERE ${inRange} GROUP BY series, ts / CAST(?4 AS INTEGER) ORDER BY series, ts`,
            )
            .all(request.from, request.to, ids, request.step)
        : this.#db
            .query<TierRow, [number, number, string]>(
              `SELECT series, ts, value FROM ${tier} WHERE ${inRange} ORDER BY series, ts`,
            )
            .all(request.from, request.to, ids);
    const out = new Map<number, [number, number][]>();
    for (const row of rows) {
      const points = out.get(row.series) ?? [];
      points.push([row.ts, row.value]);
      out.set(row.series, points);
    }
    return [...out].flatMap(([id, points]) => {
      const series = byId.get(id);
      return series === undefined ? [] : [{ metric: series.metric, labels: series.labels, points }];
    });
  }

  close(): void {
    this.#db.close();
  }
}

/** A33's merge: one series per metric and remaining labels, per bucket the newest row, the larger at a tie. */
function mergeAccount(
  rows: readonly (TierRow & { readonly bucket: number })[],
  byId: ReadonlyMap<number, PickedSeries>,
): readonly MetricsSeries[] {
  const groups = new Map<
    string,
    {
      readonly metric: string;
      readonly labels: Readonly<Record<string, string>>;
      readonly buckets: Map<number, TierRow>;
    }
  >();
  for (const row of rows) {
    const series = byId.get(row.series);
    if (series === undefined) continue;
    const labels = Object.fromEntries(Object.entries(series.labels).filter(([name]) => !MERGED_AWAY.has(name)));
    const key = `${series.metric}\u0000${labelKey(labels)}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { metric: series.metric, labels, buckets: new Map() };
      groups.set(key, group);
    }
    const held = group.buckets.get(row.bucket);
    if (held === undefined || row.ts > held.ts || (row.ts === held.ts && row.value > held.value)) {
      group.buckets.set(row.bucket, row);
    }
  }
  return [...groups.values()].map(({ metric, labels, buckets }) => ({
    metric,
    labels,
    points: [...buckets].toSorted(([a], [b]) => a - b).map(([bucket, row]): [number, number] => [bucket, row.value]),
  }));
}
