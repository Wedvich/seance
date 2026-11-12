import { afterEach, describe, expect, test } from "bun:test";
import {
  accountStoreKey,
  CAPABILITIES,
  importAccountKey,
  isMetricsRequest,
  toBase64,
  type ExclaveInfo,
  type Machine,
  type MachineStatus,
  type MetricsReply,
  type MetricsRequest,
  type MetricsSeries,
  type MetricsStep,
  type RelayState,
} from "@seance/shared";
import { MetricsStore, RAW_KEEP_S } from "../../daemon/src/metrics-store.ts";
import { pollUntil } from "../../daemon/test/fixtures.ts";
import { MetricsArchive } from "./metrics-archive.ts";
import { startMetricsCollector, statusSamples, type MetricsCollector } from "./metrics-collect.ts";

/**
 * The collector over a scripted app leg whose `metrics` op answers from a real
 * daemon `MetricsStore`, held to the daemon's request bound (`isMetricsRequest`)
 * and to a reply budget small enough that pages must split. The relay client is
 * the external boundary here; archivist/test/relay.test.ts runs it end to end.
 */
const RAW_ACCOUNT = "11111111-2222-3333-4444-555555555555:66666666-7777-8888-9999-000000000000";
const DAY = 86_400;
const NOW = 1_800_000_000 - (1_800_000_000 % 3600);

const accountKey = await importAccountKey(toBase64(crypto.getRandomValues(new Uint8Array(32))));
const ACCOUNT = await accountStoreKey(accountKey, RAW_ACCOUNT);

const exclave: ExclaveInfo = {
  id: "default",
  accountId: RAW_ACCOUNT,
  extraUsageEnabled: null,
  authOk: true,
  skills: [],
};

function machine(over: Partial<Machine> = {}): Machine {
  return {
    deviceId: "dev-a",
    name: "alpha",
    platform: "linux",
    repos: [],
    scannedAt: 0,
    lastSeen: 0,
    connected: true,
    capabilities: [CAPABILITIES.metrics],
    exclaves: [exclave],
    ...over,
  };
}

function stateOf(machines: readonly Machine[]): RelayState {
  return {
    status: "open",
    rejection: null,
    machines,
    registrySize: machines.length,
    ignored: 0,
    unbound: 0,
    skewed: 0,
    settling: false,
    registrySettled: true,
    scheduler: { kind: "none" },
    fleetQuota: [],
  };
}

/** A daemon's history as its own ticks would write it: a cpu gauge and an account's 5h quota every `step` s. */
function daemonHistory(store: MetricsStore, from: number, to: number, step: number): void {
  for (let ts = from; ts <= to; ts += step) {
    store.write(
      [
        { metric: "cpu_pct", labels: {}, ts, value: (ts / 30) % 97 },
        { metric: "quota_5h_pct", labels: { exclave: "default", account: RAW_ACCOUNT }, ts, value: (ts / 300) % 101 },
      ],
      ts,
    );
  }
}

interface Fleet {
  readonly requests: MetricsRequest[];
  /** The device id each request went to. */
  readonly asked: string[];
  readonly source: Parameters<typeof startMetricsCollector>[0]["source"];
  push: (machines: readonly Machine[]) => void;
}

function fleet(daemon: MetricsStore, replyBudget: number, initial: readonly Machine[] = [machine()]): Fleet {
  let state = stateOf(initial);
  const listeners = new Set<() => void>();
  const requests: MetricsRequest[] = [];
  const asked: string[] = [];
  return {
    requests,
    asked,
    push: (machines) => {
      state = stateOf(machines);
      for (const listener of listeners) listener();
    },
    source: {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      metrics: (deviceId, request): Promise<MetricsReply> => {
        requests.push(request);
        asked.push(deviceId);
        if (!isMetricsRequest(request)) {
          return Promise.resolve({ ok: false, code: "invalid_request", message: "bad request" });
        }
        const series = daemon.query(request);
        // The daemon's transport refuses a reply that would not fit one envelope.
        if (JSON.stringify({ series }).length > replyBudget) {
          return Promise.resolve({ ok: false, code: "too_large", message: "too large" });
        }
        return Promise.resolve({ series });
      },
    },
  };
}

/** The daemon's series as the archive files them: the observer added, the account keyed by its HMAC. */
function archived(series: readonly MetricsSeries[]): MetricsSeries[] {
  return series.map(({ metric, labels, points }) => {
    const out: Record<string, string> = { ...labels, machine: "dev-a" };
    if (labels["account"] !== undefined) out["account"] = ACCOUNT;
    return { metric, labels: out, points };
  });
}

function sorted(series: readonly MetricsSeries[]): MetricsSeries[] {
  return series.toSorted((a, b) => (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0));
}

function tier(store: { query: (r: MetricsRequest) => readonly MetricsSeries[] }, step: MetricsStep): MetricsSeries[] {
  return sorted(store.query({ from: 0, to: NOW + 30 * DAY, step }));
}

const log = { info: (): void => {}, warn: (): void => {} };
const running: { collector: MetricsCollector; archive: MetricsArchive; daemon: MetricsStore }[] = [];
afterEach(() => {
  for (const { collector, archive, daemon } of running.splice(0)) {
    collector.stop();
    archive.close();
    daemon.close();
  }
});

function start(
  daemon: MetricsStore,
  source: Fleet["source"],
  clock: { ms: number },
  pullMs = 60 * 60_000,
): { collector: MetricsCollector; archive: MetricsArchive } {
  const archive = MetricsArchive.memory();
  const collector = startMetricsCollector({
    source,
    archive,
    accountKey,
    selfId: "seat",
    log,
    timings: { pullMs },
    now: () => clock.ms,
  });
  running.push({ collector, archive, daemon });
  return { collector, archive };
}

describe("metrics collection", () => {
  test("a first start imports the daemon's hourly, 5-min and raw history, split to fit, keyed and labelled", async () => {
    const daemon = MetricsStore.memory();
    daemonHistory(daemon, NOW - 40 * DAY, NOW - 3 * DAY, 3600);
    daemonHistory(daemon, NOW - 3 * DAY + 300, NOW, 300);
    daemonHistory(daemon, NOW - 3600 + 30, NOW, 30);
    const { requests, source } = fleet(daemon, 12_000);
    const { archive } = start(daemon, source, { ms: NOW * 1000 });

    await pollUntil(
      () => JSON.stringify(tier(archive, 30)) === JSON.stringify(archived(tier(daemon, 30))),
      "the raw tier imported",
    );
    expect(tier(archive, 3600)).toEqual(archived(tier(daemon, 3600)));
    expect(tier(archive, 300)).toEqual(archived(tier(daemon, 300)));
    // Every page within the daemon's bound; some had to be asked one metric at a time.
    expect(requests.every(isMetricsRequest)).toBe(true);
    expect(requests.some((request) => request.names !== undefined)).toBe(true);
    // The hourly history reached back past the 5-min keep.
    expect(tier(archive, 3600)[0]?.points[0]?.[0]).toBe(NOW - 40 * DAY);
    expect(JSON.stringify(tier(archive, 300))).not.toContain(RAW_ACCOUNT);
  });

  test("a pull continues from the watermark, and its sample replaces the live one", async () => {
    const daemon = MetricsStore.memory();
    daemonHistory(daemon, NOW - 3600, NOW, 30);
    const clock = { ms: NOW * 1000 };
    const { requests, source, push } = fleet(daemon, 1_000_000);
    const { archive } = start(daemon, source, clock, 50);
    await pollUntil(() => archive.pullFrom("dev-a", 30, 900) === NOW, "the first import");
    const imported = requests.length;

    // The next tick: the daemon stores the unrounded value, the status frame carries it rounded.
    daemon.write([{ metric: "cpu_pct", labels: {}, ts: NOW + 30, value: 12.25 }], NOW + 30);
    const status: MachineStatus = { at: NOW + 30, scan: 0, cpu: 12 };
    push([machine({ status })]);
    await pollUntil(() => archive.query({ from: NOW + 30, to: NOW + 30, step: 30 }).length === 1, "the live sample");
    clock.ms = (NOW + 60) * 1000;
    await pollUntil(
      () => archive.query({ from: NOW + 30, to: NOW + 30, step: 30 })[0]?.points[0]?.[1] === 12.25,
      "the pulled sample replacing it",
    );
    // Steady rounds ask raw only, from the watermark, never the whole history again.
    const later = requests.slice(imported);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((request) => request.step === 30 && request.from >= NOW - 900)).toBe(true);
  });

  test("a machine back from three days asleep catches up from the 5-min tier, at its reconnect", async () => {
    const daemon = MetricsStore.memory();
    daemonHistory(daemon, NOW - 3600, NOW, 300);
    const clock = { ms: NOW * 1000 };
    const { requests, source, push } = fleet(daemon, 1_000_000);
    const { archive } = start(daemon, source, clock);
    await pollUntil(() => archive.pullFrom("dev-a", 30, 900) === NOW, "the first import");

    // It sleeps; the archive's clock moves on; it wakes and writes three more days before reconnecting.
    push([machine({ connected: false })]);
    const later = NOW + 3 * DAY;
    daemonHistory(daemon, NOW + 300, later, 300);
    clock.ms = later * 1000;
    const before = requests.length;
    push([machine()]);
    await pollUntil(() => archive.pullFrom("dev-a", 30, 900) === later, "the catch-up");
    const caughtUp = requests.slice(before);
    // Raw reaches back only 48 h, so the 5-min tier covered the rest; the hourly tier was not needed.
    expect(caughtUp.some((request) => request.step === 300 && request.from <= NOW + 300)).toBe(true);
    expect(caughtUp.some((request) => request.step === 3600)).toBe(false);
    expect(caughtUp.every((request) => request.step !== 30 || request.from >= later - RAW_KEEP_S)).toBe(true);
    const gap = { from: NOW, to: later - 3 * 3600, step: 300 } as const;
    expect(sorted(archive.query(gap))).toEqual(archived(sorted(daemon.query(gap))));
    expect(sorted(archive.query({ ...gap, step: 3600 }))).toEqual(
      archived(sorted(daemon.query({ ...gap, step: 3600 }))),
    );
  });

  test("a machine without the metrics op, or offline, or the seat itself, is never asked", async () => {
    const daemon = MetricsStore.memory();
    daemonHistory(daemon, NOW - 3600, NOW, 300);
    const { asked, source } = fleet(daemon, 1_000_000, [
      machine({ deviceId: "old", capabilities: [] }),
      machine({ deviceId: "asleep", connected: false }),
      machine({ deviceId: "seat" }),
      machine({ deviceId: "dev-a" }),
    ]);
    const { archive } = start(daemon, source, { ms: NOW * 1000 });
    await pollUntil(() => archive.pullFrom("dev-a", 30, 900) !== null, "dev-a's pull");
    // A negative assertion: the other machines' non-requests cannot be polled.
    await Bun.sleep(50);
    expect(new Set(asked)).toEqual(new Set(["dev-a"]));
  });
});

describe("statusSamples", () => {
  test("gauges, sessions and quota per exclave, under the observer, the account by its HMAC", async () => {
    const status: MachineStatus = {
      at: NOW,
      scan: 0,
      cpu: 40,
      free: 1024,
      sess: [2, 5],
      quota: [
        { x: 0, h: 30, d: 60, w: [{ m: "Fable", p: 70 }], c: 5, s: "cache", at: NOW - 120 },
        { x: 9, h: 99, s: "cache", at: NOW },
      ],
    };
    const keyOf = (accountId: string): Promise<string> => accountStoreKey(accountKey, accountId);
    const samples = await statusSamples(machine(), status, keyOf);
    const quota = { machine: "dev-a", exclave: "default", account: ACCOUNT };
    expect(samples).toEqual([
      { metric: "cpu_pct", labels: { machine: "dev-a" }, ts: NOW, value: 40 },
      { metric: "disk_free_mib", labels: { machine: "dev-a" }, ts: NOW, value: 1024 },
      // Index 1 names no exclave this machine registered: dropped, as the quota at x 9 is.
      { metric: "sessions", labels: { machine: "dev-a", exclave: "default" }, ts: NOW, value: 2 },
      { metric: "quota_5h_pct", labels: quota, ts: NOW - 120, value: 30 },
      { metric: "quota_7d_pct", labels: quota, ts: NOW - 120, value: 60 },
      { metric: "quota_7d_model_pct", labels: { ...quota, model: "Fable" }, ts: NOW - 120, value: 70 },
      { metric: "quota_credits_pct", labels: quota, ts: NOW - 120, value: 5 },
    ]);
    // Signed out: no account label at all.
    const signedOut = await statusSamples(machine({ exclaves: [{ ...exclave, accountId: null }] }), status, keyOf);
    expect(signedOut.find((s) => s.metric === "quota_5h_pct")?.labels).toEqual({
      machine: "dev-a",
      exclave: "default",
    });
  });
});
