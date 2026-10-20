import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METRIC_NAMES, type QuotaObservation, type SessionEntry } from "@seance/shared";
import type { ExclaveScan } from "./exclaves.ts";
import { MetricsStore } from "./metrics-store.ts";
import {
  createTelemetry,
  parseDiskstats,
  parseMeminfo,
  parseMemorystatusLevel,
  QUOTA_CLOCK_SKEW_MS,
  readCachedQuota,
  type HostProbe,
  type Registered,
} from "./telemetry.ts";

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

const GiB = 2 ** 30;
const T0 = 1_700_000_000_000;

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "seance-telemetry-"));
  cleanups.push(home);
  return home;
}

function scanOf(home: string): ExclaveScan {
  const exclaves = [
    { id: "default", root: home, configDir: join(home, ".claude"), configFile: join(home, ".claude.json") },
    {
      id: "work",
      root: join(home, "work"),
      configDir: join(home, ".claude-work"),
      configFile: join(home, ".claude-work", ".claude.json"),
    },
  ];
  const signedOut = { accountId: null, extraUsageEnabled: null, authOk: false, skills: [] };
  return {
    exclaves,
    info: [
      { id: "default", ...signedOut },
      { id: "work", accountId: "org:acct", extraUsageEnabled: true, authOk: true, skills: [] },
    ],
    rejected: [],
  };
}

const SCAN = T0 - 3_600_000;

/** One value per test, as run.ts holds one per register: a tick shares an in-flight sample only for the same one. */
function registeredOf(home: string, scan = SCAN): () => Registered {
  const registered = { scan, exclaves: scanOf(home) };
  return () => registered;
}

const cached = {
  fetchedAtMs: T0 - 60_000,
  utilization: {
    five_hour: { utilization: 84, resets_at: "2026-10-15T16:49:00+00:00" },
    seven_day: { utilization: 41.4, resets_at: "2026-10-21T07:59:00+00:00" },
    limits: [
      { kind: "session", group: "session", percent: 84, scope: null },
      { kind: "weekly_all", group: "weekly", percent: 41, scope: null },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 25,
        resets_at: "2026-10-21T07:59:00+00:00",
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
      },
      { kind: "weekly_scoped", group: "weekly", percent: 5, scope: { model: { id: null, display_name: "" } } },
    ],
    extra_usage: {
      is_enabled: true,
      monthly_limit: 5000,
      used_credits: 4104,
      utilization: 82.08,
      currency: "USD",
      decimal_places: 2,
    },
  },
};

/** A host whose counters advance by a fixed amount per call. */
function fakeProbe(): HostProbe & { readonly calls: { n: number } } {
  const calls = { n: 0 };
  return {
    calls,
    cpu: () => {
      calls.n += 1;
      // Each call: one 30s tick of one core, 25% busy.
      return { busy: 7_500 * calls.n, idle: 22_500 * calls.n, cores: 1 };
    },
    memory: async () => ({ total: 16 * GiB, available: 4 * GiB }),
    disks: async (paths) => paths.map((_, i) => ({ total: 100 * GiB, free: (i === 0 ? 50 : 10) * GiB })),
    diskIo: async () => ({ read: 1024 * 1024 * calls.n, write: 512 * 1024 * calls.n }),
  };
}

const session = (path: string): SessionEntry => ({ window: "@1", repo: null, path });

describe("createTelemetry", () => {
  test("first tick: pressure, the worst disk, sessions per exclave and cached quota; cpu and I/O wait for a delta", async () => {
    const home = await makeHome();
    await mkdir(join(home, ".claude-work"), { recursive: true });
    await writeFile(join(home, ".claude-work", ".claude.json"), JSON.stringify({ cachedUsageUtilization: cached }));
    const store = MetricsStore.memory();
    const sessions = [session(join(home, "work", "repo")), session(join(home, "work", "other")), session("/srv/x")];
    const telemetry = createTelemetry(store, {
      diskPaths: [join(home, "a"), join(home, "b")],
      registered: registeredOf(home),
      sessions: async () => sessions,
      probe: fakeProbe(),
    });

    const first = await telemetry.tick(T0);
    expect(first).toEqual({
      at: T0 / 1000,
      scan: SCAN,
      mem: 75,
      disk: 90,
      free: 10 * 1024,
      sess: [1, 2],
      quota: [
        {
          x: 1,
          s: "cache",
          at: (T0 - 60_000) / 1000,
          h: 84,
          d: 41,
          hr: Date.parse("2026-10-15T16:49:00+00:00") / 1000,
          dr: Date.parse("2026-10-21T07:59:00+00:00") / 1000,
          w: [{ m: "Fable", p: 25, r: Date.parse("2026-10-21T07:59:00+00:00") / 1000 }],
          c: 82,
          cu: 4104,
          cl: 5000,
          cc: "USD",
        },
      ],
    });
    expect(telemetry.latest()).toBe(first);

    const series = store.query({ from: 0, to: T0 / 1000, step: 30 });
    const named = (metric: string): typeof series => series.filter((s) => s.metric === metric);
    expect(named(METRIC_NAMES.cpu)).toEqual([]);
    // Unlabelled: renaming the machine must not split its history.
    expect(named(METRIC_NAMES.mem)).toEqual([{ metric: METRIC_NAMES.mem, labels: {}, points: [[T0 / 1000, 75]] }]);
    expect(named(METRIC_NAMES.sess).map((s) => [s.labels, s.points[0]?.[1]])).toEqual([
      [{ exclave: "default" }, 1],
      [{ exclave: "work" }, 2],
    ]);
    expect(named(METRIC_NAMES.w)).toEqual([
      {
        metric: METRIC_NAMES.w,
        labels: { account: "org:acct", exclave: "work", model: "Fable" },
        points: [[(T0 - 60_000) / 1000, 25]],
      },
    ]);
    expect(named(METRIC_NAMES.h)[0]?.labels).toEqual({ account: "org:acct", exclave: "work" });
    expect(named(METRIC_NAMES.c)).toEqual([
      {
        metric: METRIC_NAMES.c,
        labels: { account: "org:acct", exclave: "work" },
        points: [[(T0 - 60_000) / 1000, 82]],
      },
    ]);
    store.close();
  });

  test("later ticks: cpu from the counter delta, I/O as KiB/s, pressure smoothed over ~2 min", async () => {
    const home = await makeHome();
    const store = MetricsStore.memory();
    const probe = fakeProbe();
    let available = 4 * GiB;
    const telemetry = createTelemetry(store, {
      diskPaths: [home],
      registered: registeredOf(home),
      sessions: async () => [],
      probe: { ...probe, memory: async () => ({ total: 16 * GiB, available }) },
    });
    await telemetry.tick(T0);
    available = 16 * GiB; // memory freed: 75% → 0% raw, but the report eases toward it
    const second = await telemetry.tick(T0 + 30_000);
    expect(second.cpu).toBe(25);
    expect(second.rd).toBe(Math.round(1024 / 30));
    expect(second.wr).toBe(Math.round(512 / 30));
    expect(second.mem).toBe(Math.round(75 * (1 - 30 / 120)));
    // A long gap (sleep) trusts the new reading outright.
    const third = await telemetry.tick(T0 + 30_000 + 3_600_000);
    expect(third.mem).toBe(0);
    store.close();
  });

  test("what the host can't answer is absent, and a tmux outage drops only sess", async () => {
    const home = await makeHome();
    const store = MetricsStore.memory();
    const telemetry = createTelemetry(store, {
      diskPaths: [join(home, "missing")],
      registered: registeredOf(home),
      sessions: async () => {
        throw new Error("no server running");
      },
      probe: {
        cpu: () => null,
        memory: async () => null,
        disks: async () => [],
        diskIo: async () => {
          throw new Error("EACCES");
        },
      },
    });
    expect(await telemetry.tick(T0)).toEqual({ at: T0 / 1000, scan: SCAN });
    expect(store.query({ from: 0, to: T0 / 1000, step: 30 })).toEqual([]);
    store.close();
  });

  test("a rewritten config file is read on the next tick", async () => {
    const home = await makeHome();
    await mkdir(join(home, ".claude-work"), { recursive: true });
    const file = join(home, ".claude-work", ".claude.json");
    await writeFile(file, JSON.stringify({ cachedUsageUtilization: cached }));
    const store = MetricsStore.memory();
    const telemetry = createTelemetry(store, {
      diskPaths: [],
      registered: registeredOf(home),
      sessions: async () => [],
      probe: fakeProbe(),
    });
    expect((await telemetry.tick(T0)).quota?.[0]?.at).toBe((T0 - 60_000) / 1000);
    await writeFile(file, JSON.stringify({ cachedUsageUtilization: { ...cached, fetchedAtMs: T0 } }));
    const later = Date.now() / 1000 + 5;
    await utimes(file, later, later); // a same-ms rewrite of the same size would read as unchanged
    expect((await telemetry.tick(T0 + 30_000)).quota?.[0]?.at).toBe(T0 / 1000);
    await rm(file);
    expect((await telemetry.tick(T0 + 60_000)).quota).toBeUndefined();
    store.close();
  });

  test("overlapping ticks share one sample", async () => {
    const home = await makeHome();
    const store = MetricsStore.memory();
    const gate = Promise.withResolvers<readonly SessionEntry[]>();
    const telemetry = createTelemetry(store, {
      diskPaths: [],
      registered: registeredOf(home),
      sessions: () => gate.promise,
      probe: fakeProbe(),
    });
    const a = telemetry.tick(T0);
    const b = telemetry.tick(T0 + 1000);
    expect(b).toBe(a);
    gate.resolve([]);
    expect((await b).at).toBe(T0 / 1000);
    store.close();
  });

  test("a register mid-tick: the stamp and every index come from the read at tick start, and the next tick has the new one", async () => {
    const home = await makeHome();
    await mkdir(join(home, ".claude-work"), { recursive: true });
    await writeFile(join(home, ".claude-work", ".claude.json"), JSON.stringify({ cachedUsageUtilization: cached }));
    const store = MetricsStore.memory();
    const before = { scan: SCAN, exclaves: scanOf(home) };
    // The same exclaves in the other order: under this blob `work` is index 0.
    const reordered = scanOf(home);
    const after = {
      scan: SCAN + 1,
      exclaves: { ...reordered, exclaves: reordered.exclaves.toReversed(), info: reordered.info.toReversed() },
    };
    let registered = before;
    const gate = Promise.withResolvers<readonly SessionEntry[]>();
    const telemetry = createTelemetry(store, {
      diskPaths: [],
      registered: () => registered,
      sessions: () => gate.promise,
      probe: fakeProbe(),
    });
    const inFlight = telemetry.tick(T0);
    registered = after;
    const next = telemetry.tick(T0 + 1000);
    expect(next).not.toBe(inFlight);
    gate.resolve([session(join(home, "work", "repo"))]);
    const first = await inFlight;
    expect([first.scan, first.sess, first.quota?.map((q) => q.x)]).toEqual([SCAN, [0, 1], [1]]);
    const second = await next;
    expect([second.scan, second.sess, second.quota?.map((q) => q.x)]).toEqual([SCAN + 1, [1, 0], [0]]);
    store.close();
  });

  test("a cpu delta across a sleep or under MIN_CPU_WINDOW_MS is no reading; the next one starts fresh", async () => {
    const home = await makeHome();
    const store = MetricsStore.memory();
    const counters = { busy: 0, idle: 0 };
    // Two cores, so counted time runs at twice the wall clock while awake.
    const awake = (ms: number, busyShare: number): void => {
      counters.busy += 2 * ms * busyShare;
      counters.idle += 2 * ms * (1 - busyShare);
    };
    const telemetry = createTelemetry(store, {
      diskPaths: [],
      registered: registeredOf(home),
      sessions: async () => [],
      probe: { ...fakeProbe(), cpu: () => ({ ...counters, cores: 2 }) },
    });
    await telemetry.tick(T0);
    awake(30_000, 0.2);
    expect((await telemetry.tick(T0 + 30_000)).cpu).toBe(20);

    // Eighteen minutes asleep, two of its seconds awake and busy: what a dark wake leaves.
    const woke = T0 + 30_000 + 18 * 60_000;
    awake(2_000, 0.95);
    expect((await telemetry.tick(woke)).cpu).toBeUndefined();
    // The tick a register forces a second later is too short to read; its baseline stays.
    awake(1_000, 0.9);
    expect((await telemetry.tick(woke + 1_000)).cpu).toBeUndefined();
    awake(30_000, 0.2);
    // Measured across both (13.8s busy of 62s counted), not eased toward the pre-sleep average.
    expect((await telemetry.tick(woke + 31_000)).cpu).toBe(Math.round((100 * 13_800) / 62_000));

    const cpu = store.query({ from: 0, to: woke / 1000 + 31, step: 30 }).find((s) => s.metric === METRIC_NAMES.cpu);
    expect(cpu?.points.map(([ts]) => ts)).toEqual([T0 / 1000 + 30, woke / 1000 + 31]);
    store.close();
  });

  test("a failed reading is absent and stores nothing; the next one eases from the last good average over the whole gap", async () => {
    const home = await makeHome();
    const store = MetricsStore.memory();
    const readings: (number | Error)[] = [4 * GiB, new Error("EIO"), 16 * GiB];
    const telemetry = createTelemetry(store, {
      diskPaths: [],
      registered: registeredOf(home),
      sessions: async () => [],
      probe: {
        ...fakeProbe(),
        memory: async () => {
          const next = readings.shift();
          if (next === undefined || next instanceof Error) throw next ?? new Error("no reading");
          return { total: 16 * GiB, available: next };
        },
      },
    });
    expect((await telemetry.tick(T0)).mem).toBe(75);
    expect((await telemetry.tick(T0 + 30_000)).mem).toBeUndefined();
    // 90s since the last good reading, not the 60s since the failed one.
    expect((await telemetry.tick(T0 + 90_000)).mem).toBe(Math.round(75 * (1 - 90 / 120)));
    const mem = store.query({ from: 0, to: T0 / 1000 + 90, step: 30 }).find((s) => s.metric === METRIC_NAMES.mem);
    expect(mem?.points.map(([ts]) => ts)).toEqual([T0 / 1000, T0 / 1000 + 90]);
    store.close();
  });
});

describe("readCachedQuota", () => {
  test("a stamp from the future is capped a small skew past now", async () => {
    const home = await makeHome();
    const file = join(home, "future.json");
    await writeFile(
      file,
      JSON.stringify({
        cachedUsageUtilization: { fetchedAtMs: T0 + 86_400_000, utilization: { five_hour: { utilization: 5 } } },
      }),
    );
    expect((await readCachedQuota(file, 0, T0))?.at).toBe(Math.floor((T0 + QUOTA_CLOCK_SKEW_MS) / 1000));
  });

  test("nothing cached, or no file, is no observation", async () => {
    const home = await makeHome();
    expect(await readCachedQuota(join(home, "missing.json"), 0)).toBeNull();
    await writeFile(join(home, "a.json"), JSON.stringify({ oauthAccount: {} }));
    expect(await readCachedQuota(join(home, "a.json"), 0)).toBeNull();
    await writeFile(join(home, "b.json"), JSON.stringify({ cachedUsageUtilization: { utilization: {} } }));
    expect(await readCachedQuota(join(home, "b.json"), 0)).toBeNull();
  });

  test("a window with only a percent, clamped; a stamp without any window is nothing", async () => {
    const home = await makeHome();
    const file = join(home, "c.json");
    await writeFile(
      file,
      JSON.stringify({
        cachedUsageUtilization: { fetchedAtMs: 5_000, utilization: { five_hour: { utilization: 140, resets_at: 7 } } },
      }),
    );
    expect(await readCachedQuota(file, 3)).toEqual({ x: 3, s: "cache", at: 5, h: 100 });
    await writeFile(
      file,
      JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: 5_000, utilization: { limits: [] } } }),
    );
    expect(await readCachedQuota(file, 3)).toBeNull();
  });

  test("credits are a percent of the monthly cap with its amounts, absent when off or uncapped", async () => {
    const home = await makeHome();
    const file = join(home, "credits.json");
    const credits = async (extra: object): Promise<Partial<QuotaObservation> | undefined> => {
      await writeFile(
        file,
        JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: 5_000, utilization: { extra_usage: extra } } }),
      );
      const q = await readCachedQuota(file, 0);
      return q === null ? undefined : { c: q.c, cu: q.cu, cl: q.cl, cc: q.cc };
    };
    const on = { is_enabled: true, monthly_limit: 5000, currency: "USD", decimal_places: 2 };
    // Zero spent leaves the cache's `utilization` null; the amounts still say 0%.
    const usd = { cl: 5000, cc: "USD" };
    expect(await credits({ ...on, used_credits: 0, utilization: null })).toEqual({ c: 0, cu: 0, ...usd });
    // The percent rounds; the amounts stay exact, so $49.99 reads as such beside 100%.
    expect(await credits({ ...on, used_credits: 4999 })).toEqual({ c: 100, cu: 4999, ...usd });
    expect(await credits({ ...on, used_credits: 10, spend_limit_reached: true })).toMatchObject({ c: 100 });
    // Another exponent is rescaled to hundredths, spent rounding down.
    expect(await credits({ ...on, used_credits: 41_049, monthly_limit: 50_000, decimal_places: 3 })).toEqual({
      c: 82,
      cu: 4104,
      ...usd,
    });
    expect(await credits({ ...on, used_credits: 41, monthly_limit: 50, decimal_places: 0 })).toEqual({
      c: 82,
      cu: 4100,
      ...usd,
    });
    // A currency or exponent the cache doesn't name leaves the percent alone.
    expect(await credits({ ...on, used_credits: 2500, currency: null })).toEqual({ c: 50 });
    expect(await credits({ ...on, used_credits: 2500, decimal_places: undefined })).toEqual({ c: 50 });
    expect(await credits({ ...on, used_credits: 4104, is_enabled: false })).toBeUndefined();
    expect(await credits({ ...on, used_credits: 4104, monthly_limit: null })).toBeUndefined();
  });
});

const row = (name: string, rd: number, wr: number): string => `   8       0 ${name} 10 0 ${rd} 5 10 0 ${wr} 5 0 1 1`;

describe("host parsers", () => {
  test("meminfo: MemAvailable, not MemFree", () => {
    expect(parseMeminfo("MemTotal:       16000 kB\nMemFree:          100 kB\nMemAvailable:    4000 kB\n")).toEqual({
      total: 16_000 * 1024,
      available: 4_000 * 1024,
    });
    expect(parseMeminfo("MemTotal:       16000 kB\n")).toBeNull();
  });

  test("memorystatus_level: the kernel's free percentage, scaled to bytes", () => {
    expect(parseMemorystatusLevel("62\n", 1000)).toEqual({ total: 1000, available: 620 });
    expect(parseMemorystatusLevel("0", 1000)).toEqual({ total: 1000, available: 0 });
    expect(parseMemorystatusLevel("", 1000)).toBeNull();
    expect(parseMemorystatusLevel("sysctl: unknown oid", 1000)).toBeNull();
  });

  test("diskstats: whole devices only, sectors of 512 bytes", () => {
    const text = [
      row("sda", 100, 10),
      row("sda1", 100, 10),
      row("nvme0n1", 50, 5),
      row("nvme0n1p1", 50, 5),
      row("loop0", 1000, 1000),
      row("dm-0", 1, 1),
    ].join("\n");
    expect(parseDiskstats(text)).toEqual({ read: 150 * 512, write: 15 * 512 });
    expect(parseDiskstats("")).toBeNull();
  });
});
