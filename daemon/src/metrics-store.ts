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
 * about 5 MB a year at 16 series. Each write re-rolls every bucket from its
 * oldest new sample onward, across all series, from the tier below, so a late
 * sample (a quota observation stamped at its fetch time) still lands in the
 * right hour. A sample older than the raw tier
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
    PRIMARY KEY (ts, series)
  ) WITHOUT ROWID;`,
  ).join("")}
`;

const UPSERT_SERIES =
  "INSERT INTO series (metric, labels) VALUES (?, ?) ON CONFLICT DO UPDATE SET metric = metric RETURNING id";

/**
 * Entry `n` takes a store at `PRAGMA user_version` n to n + 1, all of them in
 * the one transaction that opens it, before `SCHEMA` runs; one that needs the
 * tables creates them itself. History is migrated, never dropped, from version
 * 1 on: the hourly tier is kept forever, and each drop would cost all of it.
 */
const MIGRATIONS: readonly ((db: Database) => void)[] = [
  // 0 → 1: tiers keyed time-first, since every rollup, prune and query is a
  // range on `ts`, and a series-first key turned each rollup into a full scan
  // plus a sort, ~3 ms and ~150 KiB of WAL a tick. Dropped, not migrated: their
  // history only began 2026-10-15, and `IF NOT EXISTS` would keep the old key.
  (db) => {
    for (const step of METRICS_STEPS) db.exec(`DROP TABLE IF EXISTS ${TIERS[step]}`);
  },
  // 1 → 2: no `machine` label. The store is its machine's alone, so the label
  // said nothing, and a rename split every series in two.
  (db) => foldLabel(db, "machine"),
];

const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Moves every series carrying `label` into the series without it, then
 * re-rolls each tier from the one below. Where two series held the same
 * bucket — the one a rename or the label's removal fell in — the merge can only
 * average the two averages, and the re-roll replaces that with the true one
 * wherever the tier below still holds the whole bucket.
 */
function foldLabel(db: Database, label: string): void {
  db.exec(SCHEMA);
  const labelled = db
    .query<{ id: number; metric: string; labels: string }, [string]>(
      "SELECT id, metric, labels FROM series WHERE json_extract(labels, ?) IS NOT NULL",
    )
    .all(`$.${label}`);
  if (labelled.length === 0) return;
  const upsert = db.query<{ id: number }, [string, string]>(UPSERT_SERIES);
  for (const { id, metric, labels } of labelled) {
    const { [label]: _, ...rest } = parseLabels(labels);
    const into = upsert.get(metric, labelKey(rest));
    if (into === null) continue;
    for (const step of METRICS_STEPS) {
      const tier = TIERS[step];
      db.query<void, [number, number]>(
        `INSERT INTO ${tier} (series, ts, value) SELECT ?1, ts, value FROM ${tier} WHERE series = ?2
         ON CONFLICT (ts, series) DO UPDATE SET value = (value + excluded.value) / 2`,
      ).run(into.id, id);
      db.query<void, [number]>(`DELETE FROM ${tier} WHERE series = ?`).run(id);
    }
    db.query<void, [number]>("DELETE FROM series WHERE id = ?").run(id);
  }
  for (const [from, to, step] of [
    ["raw", "m5", 300],
    ["m5", "h1", 3600],
  ] as const) {
    const oldest = db.query<{ ts: number | null }, []>(`SELECT min(ts) AS ts FROM ${from}`).get()?.ts ?? null;
    // From the first bucket the tier below holds whole, as `write` re-rolls.
    if (oldest !== null) db.query<void, [number]>(rollupSql(from, to, step)).run(bucketAfter(oldest, step));
  }
}

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
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
      for (const migrate of MIGRATIONS.slice(version)) migrate(db);
      if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec(SCHEMA);
    })();
    this.#seriesId = db.query<{ id: number }, [string, string]>(UPSERT_SERIES);
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
        // `names` arrives as one JSON array bound as text, so the filter is a
        // fixed statement however many names a request carries.
        db.query<PointRow, [number, number, string | null]>(
          `SELECT s.metric, s.labels, t.ts, t.value FROM ${TIERS[step]} t JOIN series s ON s.id = t.series
           WHERE t.ts >= ?1 AND t.ts <= ?2 AND (?3 IS NULL OR s.metric IN (SELECT value FROM json_each(?3)))
           ORDER BY s.id, t.ts`,
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

  /**
   * Every series with a point in the range, at the tier the step names, limited
   * to `names` and to series meeting every `labels` matcher when given; bounds
   * on the range are the caller's. Labels are matched here rather than in the
   * SQL, so the statement stays fixed however many matchers a request carries.
   */
  query(request: MetricsRequest): readonly MetricsSeries[] {
    const select = this.#select.get(request.step);
    if (select === undefined) return [];
    const out: MetricsSeries[] = [];
    // `points` is null for a series the matchers turned away: its rows are skipped, not collected.
    let current: {
      readonly metric: string;
      readonly labels: string;
      readonly points: [number, number][] | null;
    } | null = null;
    const names = request.names === undefined ? null : JSON.stringify(request.names);
    for (const row of select.all(request.from, request.to, names)) {
      if (!isPointRow(row)) continue;
      if (current === null || current.metric !== row.metric || current.labels !== row.labels) {
        const labels = parseLabels(row.labels);
        const points = request.labels === undefined || matchesLabels(labels, request.labels) ? [] : null;
        current = { metric: row.metric, labels: row.labels, points };
        if (points !== null) out.push({ metric: row.metric, labels, points });
      }
      current.points?.push([row.ts, row.value]);
    }
    return out;
  }

  close(): void {
    this.#db.close();
  }
}

/** Prometheus's `=`: a label the series lacks reads as `""`, so `{ model: "" }` keeps only the unmodelled. */
function matchesLabels(labels: Readonly<Record<string, string>>, matchers: Readonly<Record<string, string>>): boolean {
  return Object.entries(matchers).every(
    ([name, wanted]) => (Object.hasOwn(labels, name) ? labels[name] : "") === wanted,
  );
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
