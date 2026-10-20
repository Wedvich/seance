import type { RepoEntry } from "@seance/shared";
import { daemonSink, reapAudit } from "./audit.ts";
import type { SessionBackend } from "./backend.ts";
import { createBranchStates, type BranchStateDeps } from "./branch-state.ts";
import { brokerRelay, createBroker } from "./broker.ts";
import { REAP_DEFAULTS, type Config, type ResolvedPsk } from "./config.ts";
import type { ExclaveScan } from "./exclaves.ts";
import type { Leader } from "./leader.ts";
import type { LocalSocketOpts } from "./local-socket.ts";
import { log } from "./log.ts";
import { pruneLogPath } from "./paths.ts";
import { peerPidSupported } from "./peer.ts";
import { DAY_MS, formatReport, ReapBusy, runReap, withReapLock } from "./reap.ts";
import type { RelayClient } from "./relay-client.ts";
import { createSessionEvents, listPanePids, peerBindingProblem, type EndedTasks } from "./session-events.ts";
import type { Fetch } from "./seams.ts";

const RESCAN_INTERVAL_MS = 3_600_000;
/**
 * The schedule asks whether a reap is due this often, against `lastReapAt`
 * in state.json — never on a bare interval from start, which the daemon's
 * frequent restarts (updates, config reloads) would keep resetting.
 */
const REAP_CHECK_INTERVAL_MS = 600_000;

/** What `startDaemon` has built by the time the capabilities start: the relay client and the leader among it. */
export interface WiringCtx {
  readonly config: Config;
  readonly resolved: ResolvedPsk;
  readonly key: CryptoKey;
  readonly deviceId: string;
  readonly client: RelayClient;
  readonly leader: Leader;
  readonly backend: SessionBackend;
  readonly endedTasks: EndedTasks;
  readonly repos: () => readonly RepoEntry[];
  readonly exclaveScan: () => ExclaveScan;
  readonly rescan: () => Promise<unknown>;
  readonly lastReapAt: () => number | undefined;
  /** Persists `lastReapAt` through the daemon's one `state`. */
  readonly reaped: (at: number) => Promise<void>;
  readonly stopped: () => boolean;
  readonly now: () => number;
  /** The outbound HTTP seam, for a capability that polls or pushes (M4). */
  readonly httpFetch: Fetch;
  readonly rescanIntervalMs?: number;
  readonly reapCheckIntervalMs?: number;
  readonly branchState?: Pick<BranchStateDeps, "intervalMs" | "fetchStaleMs">;
}

/** A local op socket surface a capability brings; the socket starts after every capability, with all of them. */
export type LocalSurfaces = Pick<LocalSocketOpts, "broker" | "sessionEvents">;

export interface Started {
  readonly stop: () => void;
  readonly local?: LocalSurfaces;
}

/** One optional subsystem `startDaemon` wires once the relay client exists. */
export type DaemonCapability = (ctx: WiringCtx) => Started;

/**
 * Only where the key is service-delivered: there `seanced mcp` cannot read it,
 * and the broker is its only way to other machines. Anywhere else it reads the
 * key itself, so a broker would only widen what a same-uid process can do
 * without touching the key store — and keep an app-role surface in the daemon.
 * Built over the key imported above — never a second lookup — and dials
 * nothing until a peer first asks it to reach another machine. Its app-role
 * socket and timers go with the daemon's handle: a reload builds a fresh
 * broker, and an orphaned one would hold a relay socket forever.
 */
const fleetBroker: DaemonCapability = (ctx) => {
  if (ctx.resolved.source !== "credential") return { stop: (): void => {} };
  const broker = createBroker({
    selfDeviceId: ctx.deviceId,
    relay: brokerRelay(ctx.config, ctx.key),
    auditSink: daemonSink,
  });
  return { stop: broker.stop, local: { broker: broker.handle } };
};

const sessionEvents: DaemonCapability = (ctx) => {
  // Where the kernel cannot name a socket's peer, an event's pane is its own
  // claim — said once, since it changes what an event can be trusted to mean.
  // Where it can, binding still rests on a field Bun leaves undocumented; a
  // failed probe means every event will be refused, and this line is why.
  if (!peerPidSupported()) {
    log.warn("local socket: this host reports no peer pid — session events are bound by the pane they name");
  } else {
    void peerBindingProblem().then((problem) => {
      if (problem === null) return;
      log.warn(`local socket: peer binding failed its probe (${problem}) — every session event will be refused`);
    });
  }
  const events = createSessionEvents({
    panes: listPanePids,
    exclaves: () => ctx.exclaveScan().exclaves,
    // The leader reaches itself in process, never by a relay round trip. A
    // daemon that just lost the role still sends to "scheduler", which the
    // relay routes to whoever leads now.
    forward: (event) => {
      if (ctx.leader.term() !== null) {
        void ctx.leader.onSession(
          event.taskId,
          event.state,
          { deviceId: ctx.deviceId, pane: event.session },
          event.prUrl,
        );
        return;
      }
      void ctx.client.sendToScheduler(event).catch((err: unknown) => log.warn(`session-event: ${String(err)}`));
    },
    ended: ctx.endedTasks,
  });
  return { stop: events.stop, local: { sessionEvents: events.handle } };
};

const branchStates: DaemonCapability = (ctx) =>
  createBranchStates({
    ledger: ctx.endedTasks.ledger,
    repos: ctx.repos,
    // The leader reaches itself in process, never by a relay round trip, as session events do.
    emit: (branch) => {
      if (ctx.leader.term() !== null) {
        ctx.leader.onBranchState(branch, ctx.deviceId);
        return Promise.resolve(true);
      }
      return ctx.client.sendBranchState(branch);
    },
    // The rule the `sessions` reply's `ended` uses: a task no live session carries has ended (so is one not yet
    // registered). `repos()`, not `[]`, is load-bearing: `resolveLive` prunes the shared `repoMemo` to each
    // call's keys, so an empty list would evict the entries every other caller relies on.
    liveTasks: async () =>
      new Set((await ctx.backend.sessions(ctx.repos())).flatMap((session) => session.taskId ?? [])),
    ...ctx.branchState,
  });

/** Cached repos registered at once; refresh in the background now, then hourly. Explicit rescans arrive as ops. */
const rescanSchedule: DaemonCapability = (ctx) => {
  void ctx.rescan();
  const timer = setInterval(() => void ctx.rescan(), ctx.rescanIntervalMs ?? RESCAN_INTERVAL_MS);
  return { stop: (): void => clearInterval(timer) };
};

/**
 * Off unless configured. The report goes to the log, one line each; what it
 * destroyed is in the audit trail as origin=schedule. A run the CLI already
 * holds the lock for is skipped and tried at the next check.
 */
const reapSchedule: DaemonCapability = (ctx) => {
  const settings = ctx.config.reap ?? REAP_DEFAULTS;
  const everyMs = settings.intervalHours * 3_600_000;
  const abort = new AbortController();
  let reaping = false;
  const reapIfDue = async (): Promise<void> => {
    if (reaping || ctx.stopped() || ctx.now() - (ctx.lastReapAt() ?? 0) < everyMs) return;
    reaping = true;
    try {
      const report = await withReapLock(() =>
        runReap({
          repos: ctx.repos(),
          dryRun: false,
          minAgeMs: settings.minAgeDays * DAY_MS,
          audit: reapAudit("schedule", daemonSink),
          signal: abort.signal,
          pruneLogPath: pruneLogPath(),
        }),
      );
      for (const line of formatReport(report)) log.info(`reap: ${line}`);
      // A run the stop cut short isn't the one the schedule promised.
      if (ctx.stopped()) return;
      await ctx.reaped(ctx.now());
    } catch (err) {
      log.warn(err instanceof ReapBusy ? `reap: skipped — ${err.message}` : `reap failed: ${String(err)}`);
    } finally {
      reaping = false;
    }
  };
  const timer =
    everyMs > 0 ? setInterval(() => void reapIfDue(), ctx.reapCheckIntervalMs ?? REAP_CHECK_INTERVAL_MS) : null;
  return {
    stop: (): void => {
      if (timer !== null) clearInterval(timer);
      abort.abort();
    },
  };
};

/**
 * The capabilities list: started in this order once the relay client exists,
 * stopped in reverse. A subsystem M4 adds (the OAuth poll, push) is one more
 * entry. The local op socket is not one: it is the surface the entries'
 * `local` handlers are served on, started after all of them.
 */
export const DAEMON_CAPABILITIES: readonly DaemonCapability[] = [
  fleetBroker,
  sessionEvents,
  branchStates,
  rescanSchedule,
  reapSchedule,
];

export interface StartedCapabilities {
  readonly local: LocalSurfaces;
  readonly stop: () => void;
}

export function startCapabilities(ctx: WiringCtx): StartedCapabilities {
  return startEach(ctx, DAEMON_CAPABILITIES);
}

/** Generic over the context so a test can start a fake list without building a `WiringCtx`. */
export function startEach<C>(ctx: C, capabilities: readonly ((ctx: C) => Started)[]): StartedCapabilities {
  const started: Started[] = [];
  const stop = (): void => {
    for (const entry of started.toReversed()) entry.stop();
  };
  try {
    let local: LocalSurfaces = {};
    for (const capability of capabilities) {
      const entry = capability(ctx);
      started.push(entry);
      local = mergeSurfaces(local, entry);
    }
    return { local, stop };
  } catch (err) {
    // Already-started ones hold timers and sockets nothing else will stop.
    stop();
    throw err;
  }
}

/** Throws on a duplicate: a second capability silently replacing a surface would widen the local socket unseen. */
function mergeSurfaces(surfaces: LocalSurfaces, entry: Started): LocalSurfaces {
  for (const name of Object.keys(entry.local ?? {})) {
    if (name in surfaces) throw new Error(`two capabilities serve the local socket's "${name}" surface`);
  }
  return { ...surfaces, ...entry.local };
}
