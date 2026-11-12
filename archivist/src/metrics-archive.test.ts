import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetricsSeries, MetricsStep } from "@seance/shared";
import { ARCHIVE_RETENTION, MetricsArchive, METRICS_ARCHIVE_SCHEMA_VERSION } from "./metrics-archive.ts";

const NOW = 1_800_000_000 - (1_800_000_000 % 3600); // on an hour, so bucket math reads plainly
const A = { machine: "dev-a" };

function series(points: readonly (readonly [number, number])[], labels: Record<string, string> = A): MetricsSeries {
  return { metric: "cpu_pct", labels, points };
}

function values(archive: MetricsArchive, step: MetricsStep, from: number, to: number): [number, number][] {
  return archive.query({ from, to, step }).flatMap((s) => s.points.map(([ts, v]) => [ts, v] as [number, number]));
}

describe("MetricsArchive", () => {
  test("a pulled sample wins over a live one at the same point, whichever arrives first", () => {
    const archive = MetricsArchive.memory();
    // Live first, then the pull: the pull replaces it.
    archive.ingest([{ metric: "cpu_pct", labels: A, ts: NOW, value: 10 }], NOW);
    archive.writePulled("dev-a", 30, [series([[NOW, 12.5]])], NOW);
    // The pull first, then live: live is ignored.
    archive.writePulled("dev-a", 30, [series([[NOW + 30, 20.25]])], NOW + 30);
    archive.ingest([{ metric: "cpu_pct", labels: A, ts: NOW + 30, value: 20 }], NOW + 30);
    // A point only live saw is kept.
    archive.ingest([{ metric: "cpu_pct", labels: A, ts: NOW + 60, value: 30 }], NOW + 60);
    expect(values(archive, 30, NOW, NOW + 60)).toEqual([
      [NOW, 12.5],
      [NOW + 30, 20.25],
      [NOW + 60, 30],
    ]);
    // And the 5-min bucket is the average of what raw holds after the pull won.
    expect(values(archive, 300, NOW, NOW)).toEqual([[NOW, (12.5 + 20.25 + 30) / 3]]);
    archive.close();
  });

  test("a pulled 5-min or hourly row is never re-averaged from a raw tier holding part of its bucket", () => {
    const archive = MetricsArchive.memory();
    // The daemon's averages for a bucket the archive saw only the end of.
    archive.writePulled("dev-a", 300, [series([[NOW, 40]])], NOW + 600);
    archive.writePulled("dev-a", 3600, [series([[NOW, 45]])], NOW + 600);
    // One late live sample inside both buckets, and a pulled raw one: both re-roll from NOW.
    archive.ingest([{ metric: "cpu_pct", labels: A, ts: NOW + 270, value: 90 }], NOW + 600);
    archive.writePulled("dev-a", 30, [series([[NOW + 240, 80]])], NOW + 600);
    expect(values(archive, 300, NOW, NOW)).toEqual([[NOW, 40]]);
    expect(values(archive, 3600, NOW, NOW)).toEqual([[NOW, 45]]);
    // A bucket no pull supplied still rolls up as the daemon's would.
    archive.ingest([{ metric: "cpu_pct", labels: A, ts: NOW + 300, value: 10 }], NOW + 600);
    expect(values(archive, 300, NOW + 300, NOW + 300)).toEqual([[NOW + 300, 10]]);
    // A later pull of the same bucket replaces the earlier one.
    archive.writePulled("dev-a", 300, [series([[NOW, 41]])], NOW + 600);
    expect(values(archive, 300, NOW, NOW)).toEqual([[NOW, 41]]);
    archive.close();
  });

  test("retention prunes raw past 48 h and 5-min past a year, and keeps every hourly row", () => {
    const archive = MetricsArchive.memory();
    const old = NOW - ARCHIVE_RETENTION.m5KeepS - 3600;
    const mid = NOW - ARCHIVE_RETENTION.rawKeepS - 3600;
    archive.writePulled("dev-a", 3600, [series([[old, 1]])], old);
    archive.writePulled("dev-a", 300, [series([[old, 2]])], old);
    archive.writePulled("dev-a", 300, [series([[mid, 3]])], mid);
    archive.ingest([{ metric: "cpu_pct", labels: A, ts: mid, value: 4 }], mid);
    archive.ingest([{ metric: "cpu_pct", labels: A, ts: NOW, value: 5 }], NOW);
    expect(values(archive, 30, 0, NOW)).toEqual([[NOW, 5]]);
    expect(values(archive, 300, 0, NOW)).toEqual([
      [mid, 3],
      [NOW, 5],
    ]);
    expect(values(archive, 3600, 0, NOW)).toEqual([
      [old, 1],
      [mid, 3],
      [NOW, 5],
    ]);
    // A pull older than a tier keeps is dropped at the door, as a live sample is.
    archive.writePulled("dev-a", 30, [series([[mid, 6]])], NOW);
    archive.writePulled("dev-a", 300, [series([[old, 7]])], NOW);
    expect(values(archive, 30, 0, NOW)).toEqual([[NOW, 5]]);
    expect(values(archive, 300, 0, mid - 1)).toEqual([]);
    archive.close();
  });

  test("series are per observer, unmerged", () => {
    const archive = MetricsArchive.memory();
    archive.writePulled("dev-a", 30, [series([[NOW, 1]], { machine: "dev-a" })], NOW);
    archive.writePulled("dev-b", 30, [series([[NOW, 2]], { machine: "dev-b" })], NOW);
    expect(archive.query({ from: NOW, to: NOW, step: 30, labels: { machine: "dev-b" } })).toEqual([
      series([[NOW, 2]], { machine: "dev-b" }),
    ]);
    expect(archive.query({ from: NOW, to: NOW, step: 30 })).toHaveLength(2);
    archive.close();
  });

  test("the watermark follows the laggiest series, but never more than lateS behind the newest", () => {
    const archive = MetricsArchive.memory();
    expect(archive.pullFrom("dev-a", 30, 900)).toBeNull();
    archive.writePulled(
      "dev-a",
      30,
      [series([[NOW, 1]]), { metric: "quota_5h_pct", labels: A, points: [[NOW - 600, 3]] }],
      NOW,
    );
    expect(archive.pullFrom("dev-a", 30, 900)).toBe(NOW - 600);
    expect(archive.pullFrom("dev-b", 30, 900)).toBeNull();
    expect(archive.pullFrom("dev-a", 300, 900)).toBeNull();
    // The quota series stops; the gauge moves on. The stopped one holds the start back only lateS.
    archive.writePulled("dev-a", 30, [series([[NOW + 3600, 2]])], NOW + 3600);
    expect(archive.pullFrom("dev-a", 30, 900)).toBe(NOW + 3600 - 900);
    // A mark never moves back.
    archive.writePulled("dev-a", 30, [series([[NOW, 1]])], NOW + 3600);
    expect(archive.pullFrom("dev-a", 30, 900)).toBe(NOW + 3600 - 900);
    archive.close();
  });

  test("the file is 0600 at the current schema, and one at a newer schema refuses to open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-archive-"));
    try {
      const path = join(dir, "metrics.sqlite");
      const archive = await MetricsArchive.open(path);
      archive.writePulled("dev-a", 3600, [series([[NOW, 1]])], NOW);
      archive.close();
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const reopened = await MetricsArchive.open(path);
      expect(values(reopened, 3600, NOW, NOW)).toEqual([[NOW, 1]]);
      reopened.close();
      const db = new Database(path);
      expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(
        METRICS_ARCHIVE_SCHEMA_VERSION,
      );
      db.exec(`PRAGMA user_version = ${METRICS_ARCHIVE_SCHEMA_VERSION + 1}`);
      db.close();
      await expect(MetricsArchive.open(path)).rejects.toThrow(/newer than this build/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("countSamples", () => {
  test("an empty archive has no rows and no oldest", async () => {
    const archive = MetricsArchive.memory();
    expect(await archive.countSamples()).toEqual({ rows: 0, oldest: null });
    archive.close();
  });

  test("sums the tiers across several ranges, oldest in ms, and yields between ranges", async () => {
    const archive = MetricsArchive.memory();
    archive.writePulled(
      "dev-a",
      30,
      [
        series([
          [NOW, 1],
          [NOW + 30, 2],
          [NOW + 3000, 3],
        ]),
      ],
      NOW + 3000,
    );
    archive.writePulled("dev-a", 3600, [series([[NOW - 7200, 4]])], NOW + 3000);
    // One bucket a range: the total must not depend on the range size.
    const held = ([30, 300, 3600] as const).reduce(
      (sum, step) => sum + values(archive, step, NOW - 100_000, NOW + 100_000).length,
      0,
    );
    const whole = await archive.countSamples();
    const chunked = await archive.countSamples(1);
    expect(chunked).toEqual(whole);
    expect(whole.oldest).toBe((NOW - 7200) * 1000);
    expect(whole.rows).toBe(held);
    // A macrotask runs between ranges: a timer set before the count fires before it ends.
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 0);
    await archive.countSamples(1);
    expect(fired).toBe(true);
    archive.close();
  });
});

describe("queryArchive", () => {
  const DAY0 = NOW - (NOW % 86_400);
  const KEY = `account:${"ab".repeat(32)}`;
  const OTHER = `account:${"cd".repeat(32)}`;

  function quota(
    machine: string,
    exclave: string,
    account: string,
    points: readonly (readonly [number, number])[],
  ): MetricsSeries {
    return { metric: "quota_5h_pct", labels: { machine, exclave, account }, points };
  }

  test("a machine gets only the series it observed, filtered by names and labels as metrics is", () => {
    const archive = MetricsArchive.memory();
    archive.writePulled("dev-a", 30, [series([[NOW, 1]], { machine: "dev-a" })], NOW);
    archive.writePulled(
      "dev-b",
      30,
      [series([[NOW, 2]], { machine: "dev-b" }), quota("dev-b", "default", KEY, [[NOW, 9]])],
      NOW,
    );
    expect(archive.queryArchive({ from: NOW, to: NOW, step: 30, machine: "dev-b", names: ["cpu_pct"] })).toEqual([
      series([[NOW, 2]], { machine: "dev-b" }),
    ]);
    expect(archive.queryArchive({ from: NOW, to: NOW, step: 30, machine: "dev-b" })).toHaveLength(2);
    expect(
      archive.queryArchive({ from: NOW, to: NOW, step: 30, machine: "dev-b", labels: { exclave: "default" } }),
    ).toEqual([quota("dev-b", "default", KEY, [[NOW, 9]])]);
    expect(archive.queryArchive({ from: NOW, to: NOW, step: 30, machine: "dev-c" })).toEqual([]);
    archive.close();
  });

  test("6 h and 1 d are the average of the hourly rows in each bucket", () => {
    const archive = MetricsArchive.memory();
    const hours = Array.from({ length: 12 }, (_, i) => [DAY0 + i * 3600, i] as const);
    archive.writePulled("dev-a", 3600, [series(hours)], NOW);
    const to = DAY0 + 11 * 3600;
    expect(archive.queryArchive({ from: DAY0, to, step: 21_600, machine: "dev-a" })).toEqual([
      series([
        [DAY0, 2.5],
        [DAY0 + 21_600, 8.5],
      ]),
    ]);
    expect(archive.queryArchive({ from: DAY0, to, step: 86_400, machine: "dev-a" })).toEqual([series([[DAY0, 5.5]])]);
    archive.close();
  });

  test("an account merges every observer: per bucket the newest reading, the larger at a tie", () => {
    const archive = MetricsArchive.memory();
    const at = (machine: string, exclave: string, account: string, ts: number, value: number) => ({
      metric: "quota_5h_pct",
      labels: { machine, exclave, account },
      ts,
      value,
    });
    archive.ingest(
      [
        at("dev-a", "default", KEY, NOW + 10, 20),
        at("dev-b", "work", KEY, NOW + 20, 15),
        at("dev-a", "default", KEY, NOW + 40, 22),
        at("dev-a", "other", OTHER, NOW + 40, 99),
      ],
      NOW + 60,
    );
    expect(archive.queryArchive({ from: NOW, to: NOW + 59, step: 30, account: KEY })).toEqual([
      {
        metric: "quota_5h_pct",
        labels: { account: KEY },
        points: [
          [NOW, 15],
          [NOW + 30, 22],
        ],
      },
    ]);

    // A day before the live rows above, whose own hourly roll-up would join the day's buckets.
    const day = DAY0 - 86_400;
    // On a rolled tier every row sits at its bucket's start: the larger wins.
    archive.writePulled("dev-a", 3600, [quota("dev-a", "default", KEY, [[day, 30]])], NOW);
    archive.writePulled("dev-b", 3600, [quota("dev-b", "work", KEY, [[day, 35]])], NOW);
    expect(archive.queryArchive({ from: day, to: day, step: 3600, account: KEY })[0]?.points).toEqual([[day, 35]]);

    // At a day each observer's hourly rows average, as its own machine chart reads (35 and 20), then the larger wins.
    archive.writePulled("dev-a", 3600, [quota("dev-a", "default", KEY, [[day + 3600, 40]])], NOW);
    archive.writePulled("dev-b", 3600, [quota("dev-b", "work", KEY, [[day + 3 * 3600, 5]])], NOW);
    expect(archive.queryArchive({ from: day, to: day + 23 * 3600, step: 86_400, account: KEY })).toEqual([
      { metric: "quota_5h_pct", labels: { account: KEY }, points: [[day, 35]] },
    ]);
    expect(archive.queryArchive({ from: day, to: day + 23 * 3600, step: 86_400, machine: "dev-a" })[0]?.points).toEqual(
      [[day, 35]],
    );
    archive.close();
  });

  test("an account's per-model windows stay one series per model", () => {
    const archive = MetricsArchive.memory();
    const at = (machine: string, model: string, ts: number, value: number) => ({
      metric: "quota_7d_model_pct",
      labels: { machine, exclave: "default", account: KEY, model },
      ts,
      value,
    });
    archive.ingest(
      [at("dev-a", "Opus", NOW, 1), at("dev-b", "Opus", NOW + 5, 2), at("dev-b", "Sonnet", NOW + 5, 3)],
      NOW + 30,
    );
    const merged = archive.queryArchive({ from: NOW, to: NOW + 29, step: 30, account: KEY });
    expect(merged.map((s) => s.labels["model"]).toSorted()).toEqual(["Opus", "Sonnet"]);
    expect(merged.find((s) => s.labels["model"] === "Opus")).toEqual({
      metric: "quota_7d_model_pct",
      labels: { account: KEY, model: "Opus" },
      points: [[NOW, 2]],
    });
    archive.close();
  });
});
