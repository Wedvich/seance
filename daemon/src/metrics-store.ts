import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { METRICS_STEPS, type MetricsRequest, type MetricsSeries, type MetricsStep } from "@seance/shared";
import { stateDir } from "./paths.ts";

/**
 * The daemon's local metrics history (DESIGN.md, "Telemetry"): Prometheus's
 * data model and nothing else — a series is a metric name plus a label set,
 * a sample a `(unix seconds, number)` on one — in three tiers that share the
 * `METRICS_STEPS` the `metrics` op requests by. Raw 30s samples live 48h,
 * 5-min averages 30d, hourly averages forever: one row per series per hour is
 * megabytes a decade. Rollups are recomputed from the tier below for every
 * bucket a write touches, so a late sample (a quota observation stamped at its
 * fetch time) still lands in the right hour. A sample older than the raw tier
 * keeps is dropped at the door: the same transaction would prune it, and a
 * cached quota stamp days old would otherwise re-enter and re-roll every tick.
 */
export interface Sample {
  readonly metric: string;
  readonly labels: Readonly<Record<string, string>>;
  /** Unix seconds. */
  readonly ts: number;
  readonly value: number;
}

const HOUR_S = 3_600;
export const RAW_KEEP_S = 48 * HOUR_S;
export const M5_KEEP_S = 30 * 24 * HOUR_S;

/** Table per tier; names are constants here and nowhere else, so the SQL below concatenates nothing wire-supplied. */
const TIERS: Readonly<Record<MetricsStep, string>> = { 30: "raw", 300: "m5", 3600: "h1" };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS series (
    id INTEGER PRIMARY KEY,
    metric TEXT NOT NULL,
    labels TEXT NOT NULL,
    UNIQUE (metric, labels)
  );
  ${METRICS_STEPS.map(
    (step) => `
  CREATE TABLE IF NOT EXISTS ${TIERS[step]} (
    series INTEGER NOT NULL REFERENCES series(id),
    ts INTEGER NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (series, ts)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS ${TIERS[step]}_ts ON ${TIERS[step]} (ts);`,
  ).join("")}
`;

interface PointRow {
  readonly metric: string;
  readonly labels: string;
  readonly ts: number;
  readonly value: number;
}

/** Sorted keys, so the same label set is one series however a caller built the object. */
function labelKey(labels: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(labels).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

function parseLabels(text: string): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") labels[key] = value;
  return labels;
}

export function metricsPath(): string {
  return join(stateDir(), "metrics.sqlite");
}

export class MetricsStore {
  readonly #db: Database;
  readonly #seriesId;
  /** metric + sorted labels → id: a series never changes id, so one lookup per process is enough. */
  readonly #seriesIds = new Map<string, number>();
  readonly #insertRaw;
  readonly #rollupM5;
  readonly #rollupH1;
  readonly #pruneRaw;
  readonly #pruneM5;
  readonly #select: ReadonlyMap<MetricsStep, ReturnType<Database["query"]>>;

  private constructor(db: Database) {
    this.#db = db;
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(SCHEMA);
    this.#seriesId = db.query<{ id: number }, [string, string]>(
      "INSERT INTO series (metric, labels) VALUES (?, ?) ON CONFLICT DO UPDATE SET metric = metric RETURNING id",
    );
    // OR IGNORE: a quota observation is stamped at its fetch time, and the
    // same cached reading comes back every tick until Claude Code refreshes it.
    this.#insertRaw = db.query<void, [number, number, number]>(
      "INSERT OR IGNORE INTO raw (series, ts, value) VALUES (?, ?, ?)",
    );
    // Each tier averages the one below over the buckets from `since` on.
    this.#rollupM5 = db.query<void, [number]>(rollupSql("raw", "m5", 300));
    this.#rollupH1 = db.query<void, [number]>(rollupSql("m5", "h1", 3600));
    this.#pruneRaw = db.query<void, [number]>("DELETE FROM raw WHERE ts < ?");
    this.#pruneM5 = db.query<void, [number]>("DELETE FROM m5 WHERE ts < ?");
    this.#select = new Map(
      METRICS_STEPS.map((step) => [
        step,
        db.query<PointRow, [number, number]>(
          `SELECT s.metric, s.labels, t.ts, t.value FROM ${TIERS[step]} t JOIN series s ON s.id = t.series
           WHERE t.ts >= ? AND t.ts <= ? ORDER BY s.id, t.ts`,
        ),
      ]),
    );
  }

  /**
   * Owner-only like the other state files, and created at that mode rather than
   * chmod'd after: SQLite gives the WAL and journal the database file's mode, so
   * an empty 0600 file first makes every file it spawns 0600 too.
   */
  static async open(path: string = metricsPath()): Promise<MetricsStore> {
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, "", { mode: 0o600, flag: "wx" });
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
    }
    return new MetricsStore(new Database(path, { create: false, strict: true }));
  }

  /** In-memory, for tests and a daemon whose state dir refuses the file. */
  static memory(): MetricsStore {
    return new MetricsStore(new Database(":memory:", { strict: true }));
  }

  /** Writes the batch, refreshes every rollup bucket it touched, and prunes by `now` (unix seconds). */
  write(samples: readonly Sample[], now: number): void {
    if (samples.length === 0) return;
    const rawHorizon = now - RAW_KEEP_S;
    const m5Horizon = now - M5_KEEP_S;
    let oldest = Number.POSITIVE_INFINITY;
    this.#db.transaction(() => {
      for (const sample of samples) {
        if (!Number.isFinite(sample.value) || !Number.isInteger(sample.ts) || sample.ts < rawHorizon) continue;
        const id = this.#seriesIdOf(sample.metric, sample.labels);
        if (id === null) continue;
        // Only a row that landed widens the rollup: the same stamp re-read every tick is ignored above.
        if (this.#insertRaw.run(id, sample.ts, sample.value).changes === 0) continue;
        oldest = Math.min(oldest, sample.ts);
      }
      if (oldest === Number.POSITIVE_INFINITY) return;
      // From the first whole bucket the lower tier still holds entirely: a
      // bucket the prune horizon cuts through would otherwise be re-averaged
      // from its surviving rows and overwrite the full average already there.
      this.#rollupM5.run(Math.max(bucket(oldest, 300), bucketAfter(rawHorizon, 300)));
      this.#rollupH1.run(Math.max(bucket(oldest, 3600), bucketAfter(m5Horizon, 3600)));
      this.#pruneRaw.run(rawHorizon);
      this.#pruneM5.run(m5Horizon);
    })();
  }

  #seriesIdOf(metric: string, labels: Readonly<Record<string, string>>): number | null {
    const key = `${metric}\u0000${labelKey(labels)}`;
    const cached = this.#seriesIds.get(key);
    if (cached !== undefined) return cached;
    const row = this.#seriesId.get(metric, labelKey(labels));
    if (row === null) return null;
    this.#seriesIds.set(key, row.id);
    return row.id;
  }

  /** Every series with a point in the range, at the tier the step names; bounds on the range are the caller's. */
  query(request: MetricsRequest): readonly MetricsSeries[] {
    const select = this.#select.get(request.step);
    if (select === undefined) return [];
    const out: MetricsSeries[] = [];
    let current: { readonly metric: string; readonly labels: string; readonly points: [number, number][] } | null =
      null;
    for (const row of select.all(request.from, request.to)) {
      if (!isPointRow(row)) continue;
      if (current === null || current.metric !== row.metric || current.labels !== row.labels) {
        current = { metric: row.metric, labels: row.labels, points: [] };
        out.push({ metric: row.metric, labels: parseLabels(row.labels), points: current.points });
      }
      current.points.push([row.ts, row.value]);
    }
    return out;
  }

  close(): void {
    this.#db.close();
  }
}

function bucket(ts: number, step: number): number {
  return Math.floor(ts / step) * step;
}

/** First bucket starting at or after `ts`. */
function bucketAfter(ts: number, step: number): number {
  return Math.ceil(ts / step) * step;
}

function rollupSql(from: string, to: string, step: number): string {
  return `INSERT OR REPLACE INTO ${to} (series, ts, value)
    SELECT series, (ts / ${step}) * ${step}, avg(value) FROM ${from} WHERE ts >= ?1 GROUP BY series, ts / ${step}`;
}

function isPointRow(row: unknown): row is PointRow {
  return (
    typeof row === "object" &&
    row !== null &&
    "metric" in row &&
    typeof row.metric === "string" &&
    "labels" in row &&
    typeof row.labels === "string" &&
    "ts" in row &&
    typeof row.ts === "number" &&
    "value" in row &&
    typeof row.value === "number"
  );
}
