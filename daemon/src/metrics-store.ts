import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { METRICS_STEPS, type MetricsRequest, type MetricsSeries } from "@seance/shared";
import {
  bucketAfter,
  labelKey,
  parseLabels,
  rollupSql,
  TIERS,
  tierSchema,
  TieredMetrics,
  UPSERT_SERIES,
  type Sample,
} from "./metrics-tiers.ts";
import { stateDir } from "./paths.ts";

export type { Sample } from "./metrics-tiers.ts";

/**
 * The daemon's local metrics history (DESIGN.md, "Telemetry"), on the tiered
 * store in `metrics-tiers.ts`, which the archivist runs on too: this file is
 * the daemon's retention, path and migrations. Raw 30s samples live 48h, 5-min
 * averages 30d, hourly averages forever: one row per series per hour is about
 * 5 MB a year at 16 series.
 */
const HOUR_S = 3_600;
export const RAW_KEEP_S = 48 * HOUR_S;
export const M5_KEEP_S = 30 * 24 * HOUR_S;

const SCHEMA = tierSchema(false);

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

export function metricsPath(): string {
  return join(stateDir(), "metrics.sqlite");
}

export class MetricsStore {
  readonly #db: Database;
  readonly #tiers: TieredMetrics;

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
    this.#tiers = new TieredMetrics(db, { retention: { rawKeepS: RAW_KEEP_S, m5KeepS: M5_KEEP_S } });
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
    this.#tiers.write(samples, now);
  }

  /** `TieredMetrics.query`: every series with a point in the range at the step's tier, filtered. */
  query(request: MetricsRequest): readonly MetricsSeries[] {
    return this.#tiers.query(request);
  }

  close(): void {
    this.#db.close();
  }
}
