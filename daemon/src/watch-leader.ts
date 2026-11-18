import { CAPABILITIES, parseWatchSet, type ParsedWatchSet, type WatchSet } from "@seance/shared";
import type { AppRelay, LazyRelay } from "./app-relay.ts";
import { advertises } from "./auto.ts";

/**
 * How the daemon reaches the fleet's leader for watches (docs/gh-watch.md W9; DESIGN.md, "Watches"). The daemon-role
 * relay client receives no registry pushes, and a leader is *verified* only by an app-role client's view
 * (`RelayState.scheduler`: a nominee whose `lead-proof` opened, in the registry), with the capabilities its own
 * registry entry advertises. So this holds one app-role `LazyRelay` while the table is non-empty, to read who leads and
 * whether it advertises `watches`, and to hear a new nominee at once; a daemon with no watches holds no extra socket
 * (the lazy client closes itself 5 minutes after the last release).
 *
 * The set itself never goes on that leg: the leader honours a `watch-set` only sealed from a registered machine's own
 * device id (never `from: "app"`), so it goes in process when this daemon leads and else on the daemon leg
 * (`RelayClient.sendWatchSet`). Nothing here logs, and nothing names a URL.
 */

export type LeaderVerdict = "ready" | "unsupported" | "none";

export interface WatchLeader {
  /** Whether a verified leader that advertises `watches` is there now. `ready` for this daemon when it leads. */
  readonly check: () => Promise<LeaderVerdict>;
  /** Keeps the app-role leg open and watches for a new nominee; idempotent, and retried at each call after a failure. */
  readonly hold: () => void;
  /** Lets the leg close: the table is empty. */
  readonly release: () => void;
  /** False when the set was not handed on (no leader, a leg that is down, no running term in process). */
  readonly send: (set: WatchSet) => Promise<boolean>;
  readonly stop: () => void;
}

export interface WatchLeaderDeps {
  /** This daemon holds the scheduler term: it needs no registry to know the leader, and advertises `watches` itself. */
  readonly selfLeads: () => boolean;
  /** The leader's own intake, with the set parsed as the relay's leg would parse it; false when it did not take it. */
  readonly inProcess: (set: ParsedWatchSet) => boolean;
  readonly sendRelay: (set: WatchSet) => Promise<boolean>;
  readonly relay: Pick<LazyRelay, "acquire" | "release" | "stop">;
  /** A new verified nominee appeared: restate the set at once, since the new leader holds none. */
  readonly onNominee: () => void;
  /** How long `check` waits for an `unverified` nominee to turn `ready`. */
  readonly settleMs?: number;
}

export function createWatchLeader(deps: WatchLeaderDeps): WatchLeader {
  const settleMs = deps.settleMs ?? 3_000;
  let stopped = false;
  let wanted = false;
  let held: AppRelay | null = null;
  let unsubscribe: (() => void) | null = null;
  let acquiring = false;
  /** `<device id>:<term>` of the last verified nominee seen on the held leg. */
  let lastNominee: string | null = null;

  const nomineeOf = (client: AppRelay): string | null => {
    const { scheduler } = client.getState();
    return scheduler.kind === "ready" ? `${scheduler.deviceId}:${scheduler.term}` : null;
  };

  /** Only a change to a non-null nominee after the baseline calls out: a repeat state push, or a dip to none, does not. */
  const onState = (client: AppRelay): void => {
    const nominee = nomineeOf(client);
    if (nominee === null || nominee === lastNominee) return;
    lastNominee = nominee;
    deps.onNominee();
  };

  const settle = (client: AppRelay): Promise<void> =>
    new Promise<void>((resolve) => {
      if (client.getState().scheduler.kind !== "unverified") {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(done, settleMs);
      const off = client.subscribe(() => {
        if (client.getState().scheduler.kind !== "unverified") done();
      });
    });

  const check: WatchLeader["check"] = async () => {
    if (deps.selfLeads()) return "ready";
    let client: AppRelay;
    try {
      client = await deps.relay.acquire();
    } catch {
      return "none";
    }
    try {
      await settle(client);
      const state = client.getState();
      if (state.scheduler.kind !== "ready") return "none";
      return advertises(state.machines, state.scheduler, CAPABILITIES.watches) ? "ready" : "unsupported";
    } finally {
      // Balanced with the acquire above: a held leg has its own.
      deps.relay.release();
    }
  };

  const drop = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    if (held !== null) deps.relay.release();
    held = null;
  };

  const hold: WatchLeader["hold"] = () => {
    if (stopped) return;
    wanted = true;
    if (held !== null) {
      if (held.getState().status !== "rejected") return;
      // Rejected for good: `LazyRelay.acquire` redials a rejected client, so give the old hold back and take a new one.
      drop();
    }
    if (acquiring) return;
    acquiring = true;
    void deps.relay
      .acquire()
      .then((client) => {
        if (stopped || !wanted) {
          deps.relay.release();
          return;
        }
        held = client;
        // The first nominee seen is the baseline: the set that caused this hold is being sent already.
        lastNominee = nomineeOf(client);
        unsubscribe = client.subscribe(() => onState(client));
      })
      .catch(() => {
        // Retried at the next `hold()`, which the tick calls while the table is non-empty.
      })
      .finally(() => {
        acquiring = false;
      });
  };

  return {
    check,
    hold,
    release: () => {
      wanted = false;
      lastNominee = null;
      drop();
    },
    send: async (set) => {
      if (deps.selfLeads()) {
        const parsed = parseWatchSet(set);
        return parsed !== null && deps.inProcess(parsed);
      }
      return deps.sendRelay(set);
    },
    stop: () => {
      stopped = true;
      wanted = false;
      drop();
      deps.relay.stop();
    },
  };
}
