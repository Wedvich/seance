import {
  accountStoreKey,
  CAPABILITIES,
  METRIC_NAMES,
  METRICS_MAX_POINTS,
  type Machine,
  type MachineStatus,
  type MetricsReply,
  type MetricsRequest,
  type MetricsSeries,
  type MetricsStep,
  type RelayState,
} from "@seance/shared";
import { M5_KEEP_S, RAW_KEEP_S } from "../../daemon/src/metrics-store.ts";
import { quotaSamples, type Sample } from "../../daemon/src/metrics-tiers.ts";
import { OBSERVER_LABEL, type MetricsArchive } from "./metrics-archive.ts";

/**
 * The read slice of the app-role client metrics need: the registry (each
 * machine's latest `status`) and the `metrics` op, a read the daemon answers
 * from its own store. Nothing here writes the store or acts on a machine.
 */
export interface MetricsSource {
  readonly getState: () => RelayState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly metrics: (deviceId: string, request: MetricsRequest) => Promise<MetricsReply | null>;
}

export interface MetricsTimings {
  /**
   * Between pull rounds. Live `status` frames already land every 30 s; the pull
   * is what fills what they missed and replaces their rounded values (A17), so
   * it need not chase them. Five minutes keeps a steady round to one small
   * request per machine (ten raw points a series) and the archive's own 5-min
   * buckets re-rolled from the daemon's samples within a bucket of closing.
   */
  readonly pullMs: number;
  /**
   * How far behind its newest series a lagging one may hold a pull's start
   * (`MetricsArchive.pullFrom`): past the quota refresh's default 10 minutes, so
   * a reading stamped at its fetch time is re-read, while a series that stopped
   * costs at most this much re-reading per round.
   */
  readonly lateS: number;
  /** A 5-min or hourly bucket is pulled only once it closed this long ago: until then the daemon may still re-roll it. */
  readonly settleS: number;
}

export const METRICS_TIMINGS: MetricsTimings = { pullMs: 5 * 60_000, lateS: 15 * 60, settleS: 2 * 60 };

/**
 * No daemon holds history before this: its tiers were recreated on 2026-10-15
 * (`metrics-store.ts`, migration 0 → 1), so the first hourly import starts here.
 */
export const METRICS_HISTORY_START_S = Date.UTC(2026, 9, 15) / 1000;

/**
 * A gap this much short of a daemon's raw (or 5-min) keep is still caught up
 * from the coarser tier too: the daemon prunes by its own clock, which may run
 * ahead of this one.
 */
const CATCH_UP_MARGIN_S = 3_600;

const GAUGES = ["cpu", "mem", "disk", "free", "rd", "wr"] as const satisfies readonly (keyof typeof METRIC_NAMES &
  keyof MachineStatus)[];

export interface MetricsCollectorOpts {
  readonly source: MetricsSource;
  readonly archive: MetricsArchive;
  /** HMAC key an `account` label is filed under (A15): the raw id never enters the archive. */
  readonly accountKey: CryptoKey;
  /** The seat's own id: never a machine (A9). */
  readonly selfId: string;
  readonly log: { readonly info: (line: string) => void; readonly warn: (line: string) => void };
  readonly timings?: Partial<MetricsTimings>;
  /** Milliseconds; tests move it. */
  readonly now?: () => number;
  /** Where a first hourly import starts; tests may move it. */
  readonly historyStartS?: number;
}

export interface MetricsCollector {
  readonly stop: () => void;
}

/** The samples one `status` carries, as the daemon wrote them to its own store plus the observer label. */
export async function statusSamples(
  machine: Pick<Machine, "deviceId" | "exclaves">,
  status: MachineStatus,
  keyOf: (accountId: string) => Promise<string>,
): Promise<Sample[]> {
  const observer = { [OBSERVER_LABEL]: machine.deviceId };
  const samples: Sample[] = [];
  for (const key of GAUGES) {
    const value = status[key];
    if (value !== undefined) samples.push({ metric: METRIC_NAMES[key], labels: observer, ts: status.at, value });
  }
  const exclaves = machine.exclaves ?? [];
  status.sess?.forEach((count, x) => {
    const exclave = exclaves[x];
    if (exclave === undefined) return;
    samples.push({
      metric: METRIC_NAMES.sess,
      labels: { ...observer, exclave: exclave.id },
      ts: status.at,
      value: count,
    });
  });
  for (const q of status.quota ?? []) {
    const exclave = exclaves[q.x];
    if (exclave === undefined) continue;
    // oxlint-disable-next-line no-await-in-loop -- a handful of exclaves, each key memoized by the caller
    const account = exclave.accountId === null ? null : await keyOf(exclave.accountId);
    samples.push(...quotaSamples(q, { ...observer, exclave: exclave.id, ...(account === null ? {} : { account }) }));
  }
  return samples;
}

/**
 * Metrics into `metrics.sqlite` (docs/archivist.md, A17, A19, A20, A33): every
 * `status` the app leg holds, as it arrives, and a pull of each connected
 * machine's `metrics` op every `pullMs`, on its connect and on the leg's
 * ready. A pull continues each tier from its watermark; a machine whose raw
 * watermark is older than the daemon's raw keep (asleep, or this archivist
 * down) — or that was never pulled — also gets its 5-min history, and its
 * hourly history past the 5-min keep, so the first start and every catch-up
 * are one rule. Pages stay within `METRICS_MAX_POINTS`; a reply too large for
 * an envelope is asked again one metric at a time, then in halves.
 */
export function startMetricsCollector(opts: MetricsCollectorOpts): MetricsCollector {
  const { source, archive, accountKey, selfId, log } = opts;
  const timings = { ...METRICS_TIMINGS, ...opts.timings };
  const now = opts.now ?? Date.now;
  const historyStartS = opts.historyStartS ?? METRICS_HISTORY_START_S;
  const nowS = (): number => Math.floor(now() / 1000);
  let stopped = false;

  const accountKeys = new Map<string, Promise<string>>();
  const keyOf = (accountId: string): Promise<string> => {
    let key = accountKeys.get(accountId);
    if (key === undefined) {
      key = accountStoreKey(accountKey, accountId);
      accountKeys.set(accountId, key);
    }
    return key;
  };

  // --- live ----------------------------------------------------------------
  const lastAt = new Map<string, number>();
  let live: Promise<void> = Promise.resolve();
  const ingestLive = (machines: readonly Machine[]): void => {
    const fresh = machines.filter(
      (machine) =>
        machine.deviceId !== selfId &&
        machine.status !== undefined &&
        machine.status.at > (lastAt.get(machine.deviceId) ?? Number.NEGATIVE_INFINITY),
    );
    if (fresh.length === 0) return;
    for (const machine of fresh) if (machine.status !== undefined) lastAt.set(machine.deviceId, machine.status.at);
    // Chained: one write at a time, in arrival order.
    live = live.then(() => writeLive(fresh));
  };
  const writeLive = async (fresh: readonly Machine[]): Promise<void> => {
    try {
      const batches = await Promise.all(
        fresh.flatMap((machine) =>
          machine.status === undefined ? [] : [statusSamples(machine, machine.status, keyOf)],
        ),
      );
      // Checked after the await: a stop in between closes the database.
      if (!stopped) archive.ingest(batches.flat(), nowS());
    } catch (err) {
      if (!stopped) log.warn(`metrics: live write: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // --- pulls ---------------------------------------------------------------
  const failing = new Set<string>();

  const relabel = async (deviceId: string, series: readonly MetricsSeries[]): Promise<MetricsSeries[]> =>
    Promise.all(
      series.map(async ({ metric, labels, points }): Promise<MetricsSeries> => {
        // The daemon labels quota by the raw account id; the archive keys it by its HMAC (A15).
        const { account, ...rest } = labels;
        const out: Record<string, string> = { ...rest, [OBSERVER_LABEL]: deviceId };
        if (account !== undefined) out["account"] = await keyOf(account);
        return { metric, labels: out, points };
      }),
    );

  /** One range at one tier; false once anything in it failed, so the caller stops and the marks hold. */
  const fetchRange = async (
    machine: Machine,
    step: MetricsStep,
    from: number,
    to: number,
    names?: readonly string[],
  ): Promise<boolean> => {
    if (stopped) return false;
    const request: MetricsRequest = names === undefined ? { from, to, step } : { from, to, step, names };
    let reply: MetricsReply | null;
    try {
      reply = await source.metrics(machine.deviceId, request);
    } catch (err) {
      return failed(machine, err instanceof Error ? err.message : String(err));
    }
    if (stopped) return false;
    if (reply === null) return failed(machine, "a reply this build cannot read");
    if ("series" in reply) {
      const series = await relabel(machine.deviceId, reply.series);
      if (stopped) return false;
      archive.writePulled(machine.deviceId, step, series, nowS());
      return true;
    }
    if (reply.code !== "too_large") return failed(machine, reply.code);
    if (names === undefined) {
      for (const name of Object.values(METRIC_NAMES)) {
        // oxlint-disable-next-line no-await-in-loop -- one request at a time, in order, by design
        if (!(await fetchRange(machine, step, from, to, [name]))) return false;
      }
      return true;
    }
    if (to <= from) return failed(machine, "one point too large for an envelope");
    const mid = from + Math.floor((to - from) / step / 2) * step;
    return (await fetchRange(machine, step, from, mid, names)) && fetchRange(machine, step, mid + step, to, names);
  };

  const failed = (machine: Machine, why: string): false => {
    if (!stopped && !failing.has(machine.deviceId)) {
      failing.add(machine.deviceId);
      log.warn(`metrics: pull from ${machine.deviceId} failed: ${why}; retrying each round`);
    }
    return false;
  };

  /** `[from, to]` in pages of at most `METRICS_MAX_POINTS` points, oldest first. */
  const pullTier = async (machine: Machine, step: MetricsStep, from: number, to: number): Promise<boolean> => {
    const first = Math.ceil(from / step) * step;
    for (let start = first; start <= to; start += METRICS_MAX_POINTS * step) {
      const end = Math.min(to, start + (METRICS_MAX_POINTS - 1) * step);
      // oxlint-disable-next-line no-await-in-loop -- pages in order: a failed one stops the rest, so marks hold
      if (!(await fetchRange(machine, step, start, end))) return false;
    }
    return true;
  };

  const pullMachine = async (machine: Machine): Promise<void> => {
    const id = machine.deviceId;
    const at = nowS();
    const closed = (step: MetricsStep): number => Math.floor((at - timings.settleS) / step) * step - step;
    const rawFrom = archive.pullFrom(id, 30, timings.lateS) ?? Number.NEGATIVE_INFINITY;
    const plan: [MetricsStep, number, number][] = [];
    if (rawFrom < at - RAW_KEEP_S + CATCH_UP_MARGIN_S) {
      // Raw cannot reach back to where this archive's coverage of the machine ends: the coarser tiers fill the gap.
      const m5From = Math.max(rawFrom, archive.pullFrom(id, 300, timings.lateS) ?? Number.NEGATIVE_INFINITY);
      if (m5From < at - M5_KEEP_S + CATCH_UP_MARGIN_S) {
        const h1From = Math.max(m5From, archive.pullFrom(id, 3600, timings.lateS) ?? Number.NEGATIVE_INFINITY);
        plan.push([3600, Math.max(h1From, historyStartS), closed(3600)]);
      }
      plan.push([300, Math.max(m5From, at - M5_KEEP_S), closed(300)]);
    }
    plan.push([30, Math.max(rawFrom, at - RAW_KEEP_S), at]);
    for (const [step, from, to] of plan) {
      // oxlint-disable-next-line no-await-in-loop -- coarse to fine, one machine's requests one at a time
      if (from <= to && !(await pullTier(machine, step, from, to))) return;
    }
    if (failing.delete(id)) log.info(`metrics: pull from ${id} recovered`);
  };

  const pullable = (machine: Machine): boolean =>
    machine.deviceId !== selfId && machine.connected && machine.capabilities?.includes(CAPABILITIES.metrics) === true;

  let round: Promise<void> | null = null;
  let again = false;
  const pullRound = async (): Promise<void> => {
    for (const machine of source.getState().machines.filter(pullable)) {
      if (stopped) return;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one machine at a time keeps the fleet's load to one request
        await pullMachine(machine);
      } catch (err) {
        // A local write that threw (a locked or full disk): the marks hold, and the next round retries.
        if (!stopped)
          log.warn(`metrics: pull from ${machine.deviceId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  const kickPull = (): void => {
    if (stopped) return;
    if (round !== null) {
      again = true;
      return;
    }
    round = pullRound().finally(() => {
      round = null;
      if (again) {
        again = false;
        kickPull();
      }
    });
  };

  // --- wiring --------------------------------------------------------------
  let ready = false;
  let connected = new Set<string>();
  const onState = (): void => {
    if (stopped) return;
    const state = source.getState();
    ingestLive(state.machines);
    // Before the registry settles an empty list means "no push yet".
    const nowReady = state.status === "open" && state.registrySettled;
    if (!nowReady) {
      ready = false;
      return;
    }
    const up = new Set(state.machines.filter(pullable).map((machine) => machine.deviceId));
    // A machine back from sleep catches up at once, not at the next round.
    const arrived = [...up].some((id) => !connected.has(id));
    connected = up;
    if (!ready || arrived) kickPull();
    ready = true;
  };

  const unsubscribe = source.subscribe(onState);
  const timer = setInterval(() => {
    if (ready) kickPull();
  }, timings.pullMs);
  onState();

  return {
    stop: (): void => {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
    },
  };
}
