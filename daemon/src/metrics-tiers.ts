import type { Database } from "bun:sqlite";
import {
  METRIC_NAMES,
  METRICS_STEPS,
  type MetricsRequest,
  type MetricsSeries,
  type MetricsStep,
  type QuotaObservation,
} from "@seance/shared";

/**
 * The tiered metrics store both the daemon's `metrics.sqlite` (`metrics-store.ts`)
 * and the archivist's (`archivist/src/metrics-archive.ts`) run on (DESIGN.md,
 * "Telemetry"): Prometheus's data model and nothing else — a series is a metric
 * name plus a label set, a sample a `(unix seconds, number)` on one — in three
 * tiers that share the `METRICS_STEPS` the `metrics` op requests by. Each tier
 * above raw is the average of the tier below per bucket. Each write re-rolls
 * every bucket from its oldest new sample onward, across all series, from the
 * tier below, so a late sample (a quota observation stamped at its fetch time)
 * still lands in the right hour. A sample older than the raw tier keeps is
 * dropped at the door: the same transaction would prune it, and a cached quota
 * stamp days old would otherwise re-enter and re-roll every tick.
 *
 * Here, not in `shared/`: the relay and the PWA bundle that, and `bun:sqlite`
 * must reach neither. Retention is the caller's.
 */
export interface Sample {
  readonly metric: string;
  readonly labels: Readonly<Record<string, string>>;
  /** Unix seconds. */
  readonly ts: number;
  readonly value: number;
}

/** How long the raw and 5-min tiers keep a sample, seconds; the hourly tier keeps every one. */
export interface Retention {
  readonly rawKeepS: number;
  readonly m5KeepS: number;
}

/** Table per tier; names are constants here and nowhere else, so the SQL below concatenates nothing wire-supplied. */
export const TIERS: Readonly<Record<MetricsStep, string>> = { 30: "raw", 300: "m5", 3600: "h1" };

/**
 * `pulled` adds a flag to the rolled tiers for a store that also takes another
 * store's rollups whole (the archivist's pulls): a flagged row is that store's
 * average and no rollup here replaces it. Without it the string is the daemon's
 * schema exactly.
 */
export function tierSchema(pulled: boolean): string {
  return `
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
    value REAL NOT NULL,${pulled && step !== 30 ? "\n    pulled INTEGER NOT NULL DEFAULT 0," : ""}
    PRIMARY KEY (ts, series)
  ) WITHOUT ROWID;`,
  ).join("")}
`;
}

export const UPSERT_SERIES =
  "INSERT INTO series (metric, labels) VALUES (?, ?) ON CONFLICT DO UPDATE SET metric = metric RETURNING id";

/** Sorted keys, so the same label set is one series however a caller built the object. */
export function labelKey(labels: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(labels).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

export function parseLabels(text: string): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") labels[key] = value;
  return labels;
}

/**
 * One quota observation's samples, at the reading's own stamp, not the tick's:
 * a cache an hour old is an hour-old point. `labels` is the exclave's (and its
 * account's); each per-model window adds `model`.
 */
export function quotaSamples(q: QuotaObservation, labels: Readonly<Record<string, string>>): Sample[] {
  const samples: Sample[] = [];
  if (q.h !== undefined) samples.push({ metric: METRIC_NAMES.h, labels, ts: q.at, value: q.h });
  if (q.d !== undefined) samples.push({ metric: METRIC_NAMES.d, labels, ts: q.at, value: q.d });
  for (const window of q.w ?? []) {
    samples.push({ metric: METRIC_NAMES.w, labels: { ...labels, model: window.m }, ts: q.at, value: window.p });
  }
  if (q.c !== undefined) samples.push({ metric: METRIC_NAMES.c, labels, ts: q.at, value: q.c });
  return samples;
}

interface PointRow {
  readonly metric: string;
  readonly labels: string;
  readonly ts: number;
  readonly value: number;
}

export class TieredMetrics {
  readonly #db: Database;
  readonly #retention: Retention;
  readonly #seriesId;
  /** metric + sorted labels → id: a series never changes id, so one lookup per process is enough. */
  readonly #seriesIds = new Map<string, number>();
  readonly #insertRaw;
  readonly #rollupM5;
  readonly #rollupH1;
  readonly #pruneRaw;
  readonly #pruneM5;
  readonly #pulledInsert: ReadonlyMap<MetricsStep, ReturnType<Database["query"]>> | null;
  readonly #select: ReadonlyMap<MetricsStep, ReturnType<Database["query"]>>;

  /** `db` already holds `tierSchema(pulled)`'s tables: the caller owns migrations and pragmas. */
  constructor(db: Database, opts: { readonly retention: Retention; readonly pulled?: boolean }) {
    this.#db = db;
    this.#retention = opts.retention;
    const pulled = opts.pulled === true;
    this.#seriesId = db.query<{ id: number }, [string, string]>(UPSERT_SERIES);
    // OR IGNORE: a quota observation is stamped at its fetch time, and the
    // same cached reading comes back every tick until Claude Code refreshes it.
    this.#insertRaw = db.query<void, [number, number, number]>(
      "INSERT OR IGNORE INTO raw (series, ts, value) VALUES (?, ?, ?)",
    );
    // Each tier averages the one below over the buckets from `since` on.
    this.#rollupM5 = db.query<void, [number]>(rollupSql("raw", "m5", 300, pulled));
    this.#rollupH1 = db.query<void, [number]>(rollupSql("m5", "h1", 3600, pulled));
    this.#pruneRaw = db.query<void, [number]>("DELETE FROM raw WHERE ts < ?");
    this.#pruneM5 = db.query<void, [number]>("DELETE FROM m5 WHERE ts < ?");
    this.#pulledInsert = pulled
      ? new Map([
          [
            30,
            db.query<void, [number, number, number]>(
              "INSERT INTO raw (series, ts, value) VALUES (?, ?, ?) ON CONFLICT (ts, series) DO UPDATE SET value = excluded.value",
            ),
          ],
          ...([300, 3600] as const).map(
            (step) =>
              [
                step,
                db.query<void, [number, number, number]>(
                  `INSERT INTO ${TIERS[step]} (series, ts, value, pulled) VALUES (?, ?, ?, 1)
                   ON CONFLICT (ts, series) DO UPDATE SET value = excluded.value, pulled = 1`,
                ),
              ] as const,
          ),
        ])
      : null;
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

  /** Writes the batch, refreshes every rollup bucket it touched, and prunes by `now` (unix seconds). */
  write(samples: readonly Sample[], now: number): void {
    if (samples.length === 0) return;
    const rawHorizon = now - this.#retention.rawKeepS;
    let oldest = Number.POSITIVE_INFINITY;
    this.#db.transaction(() => {
      for (const sample of samples) {
        if (!Number.isFinite(sample.value) || !Number.isInteger(sample.ts) || sample.ts < rawHorizon) continue;
        const id = this.seriesIdOf(sample.metric, sample.labels);
        if (id === null) continue;
        // Only a row that landed widens the rollup: the same stamp re-read every tick is ignored above.
        if (this.#insertRaw.run(id, sample.ts, sample.value).changes === 0) continue;
        oldest = Math.min(oldest, sample.ts);
      }
      if (oldest === Number.POSITIVE_INFINITY) return;
      this.#rollFrom(30, oldest, now);
    })();
  }

  /**
   * Another store's samples at one tier, replacing what this one holds at the
   * same `(series, ts)`: raw over a live sample, and a 5-min or hourly row as
   * that store's own average, which no rollup here replaces afterwards (only
   * on a store opened with `pulled`). Rolls upward from the tier written and
   * prunes as `write` does. Returns the series ids that received a point.
   */
  writePulled(step: MetricsStep, samples: readonly Sample[], now: number): ReadonlySet<number> {
    const insert = this.#pulledInsert?.get(step);
    if (insert === undefined) throw new Error("writePulled needs a store opened with pulled");
    const landed = new Set<number>();
    if (samples.length === 0) return landed;
    const horizon =
      step === 30
        ? now - this.#retention.rawKeepS
        : step === 300
          ? now - this.#retention.m5KeepS
          : Number.NEGATIVE_INFINITY;
    let oldest = Number.POSITIVE_INFINITY;
    this.#db.transaction(() => {
      for (const sample of samples) {
        const { ts, value } = sample;
        if (!Number.isFinite(value) || !Number.isInteger(ts) || ts % step !== 0 || ts < horizon) continue;
        const id = this.seriesIdOf(sample.metric, sample.labels);
        if (id === null) continue;
        insert.run(id, ts, value);
        landed.add(id);
        oldest = Math.min(oldest, ts);
      }
      if (oldest === Number.POSITIVE_INFINITY) return;
      this.#rollFrom(step, oldest, now);
    })();
    return landed;
  }

  /** Re-rolls every tier above `step` from `oldest`'s bucket, then prunes. Inside the caller's transaction. */
  #rollFrom(step: MetricsStep, oldest: number, now: number): void {
    const rawHorizon = now - this.#retention.rawKeepS;
    const m5Horizon = now - this.#retention.m5KeepS;
    // From the first whole bucket the lower tier still holds entirely: a
    // bucket the prune horizon cuts through would otherwise be re-averaged
    // from its surviving rows and overwrite the full average already there.
    if (step === 30) this.#rollupM5.run(Math.max(bucket(oldest, 300), bucketAfter(rawHorizon, 300)));
    if (step !== 3600) this.#rollupH1.run(Math.max(bucket(oldest, 3600), bucketAfter(m5Horizon, 3600)));
    this.#pruneRaw.run(rawHorizon);
    this.#pruneM5.run(m5Horizon);
  }

  seriesIdOf(metric: string, labels: Readonly<Record<string, string>>): number | null {
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
}

/** Prometheus's `=`: a label the series lacks reads as `""`, so `{ model: "" }` keeps only the unmodelled. */
export function matchesLabels(
  labels: Readonly<Record<string, string>>,
  matchers: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(matchers).every(
    ([name, wanted]) => (Object.hasOwn(labels, name) ? labels[name] : "") === wanted,
  );
}

export function bucket(ts: number, step: number): number {
  return Math.floor(ts / step) * step;
}

/** First bucket starting at or after `ts`. */
export function bucketAfter(ts: number, step: number): number {
  return Math.ceil(ts / step) * step;
}

/**
 * Each bucket from `?1` on, re-averaged from the tier below. `guarded` leaves
 * a `pulled` row alone (a store opened with `pulled`); unguarded is the daemon's
 * statement.
 */
export function rollupSql(from: string, to: string, step: number, guarded = false): string {
  const select = `SELECT series, (ts / ${step}) * ${step}, avg(value) FROM ${from} WHERE ts >= ?1 GROUP BY series, ts / ${step}`;
  if (!guarded) return `INSERT OR REPLACE INTO ${to} (series, ts, value)\n    ${select}`;
  return `INSERT INTO ${to} (series, ts, value)
    ${select}
    ON CONFLICT (ts, series) DO UPDATE SET value = excluded.value WHERE ${to}.pulled = 0`;
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
