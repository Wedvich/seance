import type { MachineStatus, SessionEntry } from "@seance/shared";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import type { MetricsStore } from "./metrics-store.ts";
import type { Fetch } from "./seams.ts";
import type { SessionQuota } from "./session-quota.ts";
import { fitStatus } from "./status.ts";
import { createTelemetry, type HostProbe, type Registered } from "./telemetry.ts";

/**
 * What the collector registry reads from the daemon: every dependency a `status`
 * tick's collectors use, named in one place rather than inline in `startDaemon`.
 * The collectors themselves are `TELEMETRY_COLLECTORS` (`telemetry-collectors.ts`),
 * which `createTelemetry` defaults to so its direct callers build the same set. A
 * field M4 adds to the status (auth health, the OAuth quota poll, a Proxmox node
 * view) is one entry there, plus its dependency here if it needs a new one.
 */
export interface CollectorDeps {
  readonly config: Config;
  readonly registered: () => Registered;
  readonly sessions: () => Promise<readonly SessionEntry[]>;
  readonly sessionQuota: SessionQuota;
  readonly now: () => number;
  readonly httpFetch: Fetch;
  readonly probe?: HostProbe;
}

export interface StatusLoopDeps {
  readonly intervalMs: number;
  readonly connected: () => boolean;
  /** `RelayClient.sendStatus`: `current` is asked again after the seal. */
  readonly send: (status: MachineStatus, current: () => boolean) => Promise<boolean>;
}

export interface StatusLoop {
  /**
   * Samples at once and re-arms the beat, so the next lands past the relay's floor.
   * Run on every register: it changed the blob a status indexes, and the registry
   * push an app got carries no snapshot until this one.
   */
  readonly sampleNow: () => void;
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
    sessionQuota: (exclave, account) => collectors.sessionQuota.get(exclave, account),
    now: collectors.now,
    httpFetch: collectors.httpFetch,
    // Once per collector: a persistent failure is structural, and every beat would repeat it.
    onCollectorError: (name, err) => {
      if (failureWarned.has(name)) return;
      failureWarned.add(name);
      log.warn(`telemetry: ${name} failed, its fields are left out of the status: ${String(err)}`);
    },
    ...(collectors.probe === undefined ? {} : { probe: collectors.probe }),
  });
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let trimWarned = false;
  const sample = (): void => {
    if (stopped) return;
    telemetry
      .tick()
      .then((snapshot) => {
        if (stopped || !loop.connected()) return false;
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
        return loop.send(status, current);
      })
      .catch((err: unknown) => log.warn(`telemetry: ${String(err)}`));
  };
  return {
    sampleNow: (): void => {
      if (timer !== null) clearInterval(timer);
      timer = setInterval(sample, loop.intervalMs);
      sample();
    },
    stop: (): void => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
    },
  };
}
