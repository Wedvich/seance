import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { M5_KEEP_S, MetricsStore, RAW_KEEP_S } from "./metrics-store.ts";

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

const NOW = 1_700_000_000 - (1_700_000_000 % 3600); // on an hour, so bucket math reads plainly
const machine = { machine: "mac" };

describe("MetricsStore", () => {
  test("a series is its metric plus its label set, whatever order the labels came in", () => {
    const store = MetricsStore.memory();
    store.write(
      [
        { metric: "sessions", labels: { machine: "mac", exclave: "work" }, ts: NOW, value: 2 },
        { metric: "sessions", labels: { exclave: "work", machine: "mac" }, ts: NOW + 30, value: 3 },
        { metric: "sessions", labels: { machine: "mac", exclave: "default" }, ts: NOW, value: 0 },
      ],
      NOW + 30,
    );
    expect(store.query({ from: NOW, to: NOW + 30, step: 30 })).toEqual([
      {
        metric: "sessions",
        labels: { exclave: "work", machine: "mac" },
        points: [
          [NOW, 2],
          [NOW + 30, 3],
        ],
      },
      { metric: "sessions", labels: { exclave: "default", machine: "mac" }, points: [[NOW, 0]] },
    ]);
    store.close();
  });

  test("the same stamp on a series is one sample — a cached quota re-read every tick is not a new observation", () => {
    const store = MetricsStore.memory();
    store.write([{ metric: "quota_5h_pct", labels: machine, ts: NOW, value: 41 }], NOW);
    store.write([{ metric: "quota_5h_pct", labels: machine, ts: NOW, value: 99 }], NOW + 30);
    expect(store.query({ from: NOW, to: NOW + 30, step: 30 })[0]?.points).toEqual([[NOW, 41]]);
    store.close();
  });

  test("rollups average the tier below per bucket, and a late sample lands in its own hour", () => {
    const store = MetricsStore.memory();
    const raw = Array.from({ length: 20 }, (_, i) => ({
      metric: "cpu_pct",
      labels: machine,
      ts: NOW + i * 30,
      value: i,
    }));
    store.write(raw, NOW + 600);
    expect(store.query({ from: NOW, to: NOW + 600, step: 300 })).toEqual([
      {
        metric: "cpu_pct",
        labels: machine,
        points: [
          [NOW, 4.5],
          [NOW + 300, 14.5],
        ],
      },
    ]);
    expect(store.query({ from: NOW, to: NOW + 600, step: 3600 })[0]?.points).toEqual([[NOW, 9.5]]);
    // Stamped two hours back: its own hourly bucket, and the current one untouched.
    store.write([{ metric: "cpu_pct", labels: machine, ts: NOW - 7200, value: 80 }], NOW + 630);
    expect(store.query({ from: NOW - 7200, to: NOW + 600, step: 3600 })[0]?.points).toEqual([
      [NOW - 7200, 80],
      [NOW, 9.5],
    ]);
    store.close();
  });

  test("raw lives 48h and 5-min 30d; the hourly tier keeps what they drop", () => {
    const store = MetricsStore.memory();
    const old = NOW - M5_KEEP_S - 3600;
    const mid = NOW - RAW_KEEP_S - 3600;
    store.write([{ metric: "mem_pct", labels: machine, ts: old, value: 10 }], old);
    store.write([{ metric: "mem_pct", labels: machine, ts: mid, value: 20 }], mid);
    store.write([{ metric: "mem_pct", labels: machine, ts: NOW, value: 30 }], NOW);
    const range = { from: old, to: NOW };
    expect(store.query({ ...range, step: 30 })[0]?.points).toEqual([[NOW, 30]]);
    expect(store.query({ ...range, step: 300 })[0]?.points).toEqual([
      [mid, 20],
      [NOW, 30],
    ]);
    expect(store.query({ ...range, step: 3600 })[0]?.points).toEqual([
      [old, 10],
      [mid, 20],
      [NOW, 30],
    ]);
    store.close();
  });

  test("a non-finite value or fractional stamp is dropped, not stored", () => {
    const store = MetricsStore.memory();
    store.write(
      [
        { metric: "cpu_pct", labels: machine, ts: NOW, value: Number.NaN },
        { metric: "cpu_pct", labels: machine, ts: NOW + 0.5, value: 1 },
      ],
      NOW,
    );
    expect(store.query({ from: 0, to: NOW + 1, step: 30 })).toEqual([]);
    store.close();
  });

  test("the file and everything SQLite spawns beside it are owner-only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seance-metrics-"));
    cleanups.push(dir);
    const path = join(dir, "metrics.sqlite");
    const store = await MetricsStore.open(path);
    store.write([{ metric: "cpu_pct", labels: machine, ts: NOW, value: 1 }], NOW);
    const names = await readdir(dir);
    expect(names).toContain("metrics.sqlite");
    for (const name of names) expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);
    store.close();
    // Reopening reads what was written.
    const again = await MetricsStore.open(path);
    expect(again.query({ from: NOW, to: NOW, step: 30 })[0]?.points).toEqual([[NOW, 1]]);
    again.close();
  });
});
