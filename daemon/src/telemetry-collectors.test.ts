import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METRIC_NAMES } from "@seance/shared";
import { MetricsStore } from "./metrics-store.ts";
import {
  TELEMETRY_COLLECTORS,
  type CollectorSources,
  type Contribution,
  type TelemetryCollector,
} from "./telemetry-collectors.ts";
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

/** A new source as M4 adds one: a sample at the tick's stamp and state of its own across ticks; no field, so none of the real ones is overwritten. */
const counting: TelemetryCollector = () => {
  let calls = 0;
  return async (tick) => {
    calls += 1;
    return { fields: {}, samples: [{ metric: PROBE_METRIC, labels: {}, ts: tick.at, value: calls }] };
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

    expect(second).toEqual({ at: T0 / 1000 + 30, scan: 1, mem: 75, disk: 90, free: 10 * 1024, sess: [1] });
    const series = store.query({ from: 0, to: T0 / 1000 + 30, step: 30 });
    expect(series.find((s) => s.metric === PROBE_METRIC)?.points).toEqual([
      [T0 / 1000, 1],
      [T0 / 1000 + 30, 2],
    ]);
    expect(series.find((s) => s.metric === METRIC_NAMES.mem)?.points).toHaveLength(2);
  });

  test("a closed launch gate adds `drn` to the tick it is closed for, and nothing to the store", async () => {
    let draining = false;
    const store = MetricsStore.memory();
    const telemetry = createTelemetry(store, { ...sources, draining: () => draining });

    expect(await telemetry.tick(T0)).not.toHaveProperty("drn");
    draining = true;
    expect((await telemetry.tick(T0 + 30_000)).drn).toBe(true);
    draining = false;
    expect(await telemetry.tick(T0 + 60_000)).not.toHaveProperty("drn");
    const metrics = new Set(store.query({ from: 0, to: T0 / 1000 + 60, step: 30 }).map((s) => s.metric));
    expect(metrics).toEqual(new Set([METRIC_NAMES.mem, METRIC_NAMES.disk, METRIC_NAMES.free, METRIC_NAMES.sess]));
  });

  test("an entry that rejects or throws drops only its own contribution", async () => {
    const store = MetricsStore.memory();
    const telemetry = createTelemetry(store, sources, [rejects, ...TELEMETRY_COLLECTORS, throws, counting]);

    const snapshot = await telemetry.tick(T0);

    expect(snapshot).toEqual({ at: T0 / 1000, scan: 1, mem: 75, disk: 90, free: 10 * 1024, sess: [1] });
    const metrics = store.query({ from: 0, to: T0 / 1000, step: 30 }).map((s) => s.metric);
    expect(new Set(metrics)).toEqual(
      new Set([METRIC_NAMES.mem, METRIC_NAMES.disk, METRIC_NAMES.free, METRIC_NAMES.sess, PROBE_METRIC]),
    );
  });

  test("a real source that throws synchronously drops only its own fields, and the hook names it", async () => {
    const failures: { readonly collector: string; readonly err: unknown }[] = [];
    const telemetry = createTelemetry(MetricsStore.memory(), {
      ...sources,
      sessions: () => {
        throw new Error("sessions bug");
      },
      onCollectorError: (collector, err) => failures.push({ collector, err }),
    });

    const snapshot = await telemetry.tick(T0);

    expect(snapshot).toEqual({ at: T0 / 1000, scan: 1, mem: 75, disk: 90, free: 10 * 1024 });
    expect(failures.map((f) => f.collector)).toEqual(["sessionsCollector"]);
    expect(String(failures[0]?.err)).toContain("sessions bug");
  });

  test("a hook that throws does not fail the tick", async () => {
    const telemetry = createTelemetry(
      MetricsStore.memory(),
      {
        ...sources,
        onCollectorError: () => {
          throw new Error("hook bug");
        },
      },
      [rejects, ...TELEMETRY_COLLECTORS],
    );

    expect((await telemetry.tick(T0)).mem).toBe(75);
  });

  test("two instances over the default set keep their own cpu baseline and averages", async () => {
    const probeAt = (busyShare: number): HostProbe => {
      let busy = 0;
      let idle = 0;
      return {
        ...probe,
        cpu: () => {
          busy += 30_000 * busyShare;
          idle += 30_000 * (1 - busyShare);
          return { busy, idle, cores: 1 };
        },
      };
    };
    const hot = createTelemetry(MetricsStore.memory(), { ...sources, probe: probeAt(0.5) });
    const cold = createTelemetry(MetricsStore.memory(), { ...sources, probe: probeAt(0.1) });

    await hot.tick(T0);
    await cold.tick(T0);
    const [h, c] = [await hot.tick(T0 + 30_000), await cold.tick(T0 + 30_000)];

    expect([h.cpu, c.cpu]).toEqual([50, 10]);
  });

  test("the default entries contribute disjoint field keys", async () => {
    // Fake sources that make every entry contribute: a cpu delta, an I/O delta, a cached quota.
    const dir = await mkdtemp(join(tmpdir(), "seance-collectors-"));
    const configFile = join(dir, ".claude.json");
    await writeFile(
      configFile,
      JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: T0, utilization: { five_hour: { utilization: 10 } } } }),
    );
    const cached: Registered = {
      ...registered,
      exclaves: {
        ...registered.exclaves,
        exclaves: [{ id: "default", root: "/home/u", configDir: "/nonexistent/.claude", configFile }],
      },
    };
    let busy = 0;
    let idle = 0;
    let bytes = 0;
    const full: HostProbe = {
      ...probe,
      cpu: () => {
        busy += 15_000;
        idle += 15_000;
        return { busy, idle, cores: 1 };
      },
      diskIo: async () => {
        bytes += 1024 * 1024;
        return { read: bytes, write: bytes };
      },
    };
    const fullSources: CollectorSources = { ...sources, registered: () => cached, probe: full };
    let fieldSets: string[][];
    try {
      fieldSets = await Promise.all(
        TELEMETRY_COLLECTORS.map(async (entry) => {
          const collect = entry(fullSources);
          const contributions: Contribution[] = [];
          for (const nowMs of [T0, T0 + 30_000]) {
            contributions.push(await collect({ registered: cached, nowMs, at: nowMs / 1000, smooth: (_, v) => v }));
          }
          return Array.from(new Set(contributions.flatMap((c) => Object.keys(c.fields))));
        }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const all = fieldSets.flat();

    expect(new Set(all)).toEqual(new Set(["cpu", "mem", "disk", "free", "rd", "wr", "sess", "quota"]));
    // Each entry's keys are unique to it: no key appears in two entries' sets.
    expect(all).toHaveLength(new Set(all).size);
  });
});
