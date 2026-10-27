import { STATUS_MIN_INTERVAL_MS, type MachineStatus, type SessionEntry } from "@seance/shared";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import type { MetricsStore } from "./metrics-store.ts";
import type { Fetch } from "./seams.ts";
import { fitStatus } from "./status.ts";
import { createTelemetry, type HostProbe, type Registered } from "./telemetry.ts";

/**
 * What the collector registry reads from the daemon: every dependency a `status`
 * tick's collectors use, named in one place rather than inline in `startDaemon`.
 * The collectors themselves are `TELEMETRY_COLLECTORS` (`telemetry-collectors.ts`),
 * which `createTelemetry` defaults to so its direct callers build the same set. A
 * field M4 adds to the status (auth health, a Proxmox node view) is one entry
 * there, plus its dependency here if it needs a new one.
 */
export interface CollectorDeps {
  readonly config: Config;
  readonly registered: () => Registered;
  readonly sessions: () => Promise<readonly SessionEntry[]>;
  readonly now: () => number;
  readonly httpFetch: Fetch;
  readonly probe?: HostProbe;
  /** `EndedTasks.draining`: the status's `drn`. */
  readonly draining?: () => boolean;
}

export interface StatusLoopDeps {
  readonly intervalMs: number;
  readonly connected: () => boolean;
  /** `RelayClient.sendStatus`: `current` is asked again after the seal. */
  readonly send: (status: MachineStatus, current: () => boolean) => Promise<boolean>;
  /** How long after a sent status the relay drops the next; `refresh` waits it out. Tests only. */
  readonly floorMs?: number;
  /** A sample against the current register blob resolved, sent or not. */
  readonly onSample?: () => void;
}

export interface StatusLoop {
  /**
   * Samples at once and re-arms the beat, so the next lands past the relay's floor.
   * Run on every register: it changed the blob a status indexes, and the registry
   * push an app got carries no snapshot until this one.
   */
  readonly sampleNow: () => void;
  /**
   * A field routing reads changed (the launch gate): samples as soon as the relay's floor lets the
   * status through, so neither the next beat nor a frame the relay would drop is the one that tells.
   */
  readonly refresh: () => void;
  /** The last sample whole — before `fitStatus` trims it for the wire — or null before the first. */
  readonly latest: () => MachineStatus | null;
  readonly stop: () => void;
}

/**
 * Telemetry over the registered collectors, sampled on a beat, each sample
 * going out as `status` while the socket is up — whether or not anyone is
 * watching, so a freshly opened app finds the latest on the relay instead of
 * waiting a beat.
 */
export function startStatusLoop(metrics: MetricsStore, collectors: CollectorDeps, loop: StatusLoopDeps): StatusLoop {
  const failureWarned = new Set<string>();
  const telemetry = createTelemetry(metrics, {
    diskPaths: collectors.config.repoRoots,
    registered: collectors.registered,
    sessions: collectors.sessions,
    now: collectors.now,
    httpFetch: collectors.httpFetch,
    // Once per collector: a persistent failure is structural, and every beat would repeat it.
    onCollectorError: (name, err) => {
      if (failureWarned.has(name)) return;
      failureWarned.add(name);
      log.warn(`telemetry: ${name} failed, its fields are left out of the status: ${String(err)}`);
    },
    ...(collectors.probe === undefined ? {} : { probe: collectors.probe }),
    ...(collectors.draining === undefined ? {} : { draining: collectors.draining }),
  });
  // Never past the next beat: a beat shorter than the relay's floor (tests only) is the floor that holds.
  // A twentieth over it, since the relay times the frames by their arrival, not by our send. It assumes
  // steady latency, and `send` resolves on handing the frame to the socket, not on the relay's accepting
  // it, so a refresh the relay still drops (a latency spike either side of the floor) is not retried:
  // the next beat carries the flag, at most one beat late.
  const floorMs = loop.floorMs ?? Math.min(STATUS_MIN_INTERVAL_MS, loop.intervalMs) * 1.05;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let trimWarned = false;
  let lastSentAt: number | null = null;
  let refreshPending = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  // Samples started and not yet resolved (tick and send both), and the latest of them: ticks queue in
  // order, so the last to start is the last to finish.
  let active = 0;
  let lastSample: Promise<unknown> = Promise.resolve();
  const sample = (fresh = false): void => {
    if (stopped) return;
    active += 1;
    lastSample = telemetry
      .tick(collectors.now(), fresh)
      .then((snapshot) => {
        if (stopped) return false;
        if (snapshot.scan === collectors.registered().scan) loop.onSample?.();
        if (!loop.connected()) return false;
        // A tick begun before the latest register names the blob before it —
        // at boot, none at all — and every reader would drop it. Sent anyway it
        // spends the relay's one-per-interval floor, and the tick the register
        // queued behind it, carrying the right stamp, is the one refused. Asked
        // again by `sendStatus` after its seal, since a register can leave meanwhile.
        const current = (): boolean => snapshot.scan === collectors.registered().scan;
        if (!current()) return false;
        const status = fitStatus(snapshot);
        if (status.tr !== undefined && !trimWarned) {
          // Once: the condition is structural (too many exclaves for the bound),
          // not transient, and the fix is a schema change rather than a retry.
          log.warn("status trimmed to fit the relay's bound — some quota detail is left out of the live view");
          trimWarned = true;
        }
        return loop.send(status, current).then((sent) => {
          if (sent) lastSentAt = collectors.now();
          return sent;
        });
      })
      .catch((err: unknown) => log.warn(`telemetry: ${String(err)}`))
      .finally(() => {
        active -= 1;
      });
  };
  const sampleNow = (fresh = false): void => {
    if (stopped) return;
    if (timer !== null) clearInterval(timer);
    timer = setInterval(() => sample(), loop.intervalMs);
    sample(fresh);
  };
  // Re-decided each time it wakes: a send in flight (a register's, just before the drain) lands later
  // than any wait computed before it, and the relay times the floor from that arrival.
  const attemptRefresh = (): void => {
    refreshTimer = null;
    if (stopped) return;
    if (active > 0) {
      void lastSample.then(attemptRefresh);
      return;
    }
    const waitMs = lastSentAt === null ? 0 : lastSentAt + floorMs - collectors.now();
    if (waitMs > 0) {
      refreshTimer = setTimeout(attemptRefresh, waitMs);
      return;
    }
    refreshPending = false;
    // Fresh: a sample that starts after the gate change, never a tick already reading the old gate.
    sampleNow(true);
  };
  return {
    sampleNow: () => sampleNow(),
    refresh: (): void => {
      // One pending is enough: the collectors read the gate when the tick runs, not when it was asked for.
      if (stopped || refreshPending) return;
      refreshPending = true;
      attemptRefresh();
    },
    latest: () => telemetry.latest(),
    stop: (): void => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      if (refreshTimer !== null) clearTimeout(refreshTimer);
    },
  };
}
