import { describe, expect, test } from "bun:test";
import { METRIC_NAMES } from "@seance/shared";
import { MetricsStore } from "./metrics-store.ts";
import { TELEMETRY_COLLECTORS, type TelemetryCollector } from "./telemetry-collectors.ts";
import { createTelemetry, type HostProbe, type Registered, type TelemetrySources } from "./telemetry.ts";

const GiB = 2 ** 30;
const T0 = 1_700_000_000_000;
const PROBE_METRIC = "seance_test_probe";

const registered: Registered = {
  scan: 1,
  exclaves: {
    exclaves: [
      { id: "default", root: "/home/u", configDir: "/nonexistent/.claude", configFile: "/nonexistent/.claude.json" },
    ],
    info: [{ id: "default", accountId: null, extraUsageEnabled: null, authOk: false, skills: [] }],
    rejected: [],
  },
};

const probe: HostProbe = {
  cpu: () => null,
  memory: async () => ({ total: 16 * GiB, available: 4 * GiB }),
  disks: async (paths) => paths.map(() => ({ total: 100 * GiB, free: 10 * GiB })),
  diskIo: async () => null,
};

const sources: TelemetrySources = {
  diskPaths: ["/"],
  registered: () => registered,
  sessions: async () => [{ window: "@1", repo: null, path: "/home/u/repo" }],
  probe,
};

/** A new source as M4 adds one: a field, a sample at the tick's stamp, and state of its own across ticks. */
const counting: TelemetryCollector = () => {
  let calls = 0;
  return async (tick) => {
    calls += 1;
    return {
      fields: { rd: calls },
      samples: [{ metric: PROBE_METRIC, labels: {}, ts: tick.at, value: calls }],
    };
  };
};

const rejects: TelemetryCollector = () => async () => {
  throw new Error("endpoint down");
};

// Synchronously, before any promise exists: still that entry's failure alone.
const throws: TelemetryCollector = () => () => {
  throw new Error("bug");
};

describe("the collector registry", () => {
  test("one more entry adds its field to the snapshot and its sample to the store", async () => {
    const store = MetricsStore.memory();
    const telemetry = createTelemetry(store, sources, [...TELEMETRY_COLLECTORS, counting]);

    await telemetry.tick(T0);
    const second = await telemetry.tick(T0 + 30_000);

    expect(second).toEqual({ at: T0 / 1000 + 30, scan: 1, mem: 75, disk: 90, free: 10 * 1024, sess: [1], rd: 2 });
    const series = store.query({ from: 0, to: T0 / 1000 + 30, step: 30 });
    expect(series.find((s) => s.metric === PROBE_METRIC)?.points).toEqual([
      [T0 / 1000, 1],
      [T0 / 1000 + 30, 2],
    ]);
    expect(series.find((s) => s.metric === METRIC_NAMES.mem)?.points).toHaveLength(2);
  });

  test("an entry that rejects or throws drops only its own contribution", async () => {
    const store = MetricsStore.memory();
    const telemetry = createTelemetry(store, sources, [rejects, ...TELEMETRY_COLLECTORS, throws, counting]);

    const snapshot = await telemetry.tick(T0);

    expect(snapshot).toEqual({ at: T0 / 1000, scan: 1, mem: 75, disk: 90, free: 10 * 1024, sess: [1], rd: 1 });
    const metrics = store.query({ from: 0, to: T0 / 1000, step: 30 }).map((s) => s.metric);
    expect(metrics).toEqual(
      expect.arrayContaining([METRIC_NAMES.mem, METRIC_NAMES.disk, METRIC_NAMES.free, METRIC_NAMES.sess, PROBE_METRIC]),
    );
  });
});
