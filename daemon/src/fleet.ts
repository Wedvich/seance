import type {
  ErrorResponse,
  Machine,
  QueueReply,
  SchedulerAvailability,
  StoreRefusal,
  Task,
  TaskCreated,
  TaskReply,
} from "@seance/shared";
import type { LazyRelay } from "./app-relay.ts";
import { BrokerError, brokerMachines, brokerRequest, type BrokerCallOpts } from "./broker-client.ts";
import type { BrokerOp } from "./broker-protocol.ts";
import type { Check } from "./check.ts";

/**
 * How `seance mcp` reaches machines other than its own. Two transports behind
 * one shape, so the four tools — name resolution, repo pre-check, rendering,
 * `client: "mcp"` — exist once:
 *
 * - **direct**: this process resolved the PSK itself and dials the relay as an
 *   app, exactly as the PWA does. macOS, WSL and any Linux whose store this
 *   user can read.
 * - **broker**: it could not, so it asks the running daemon, which holds the key
 *   (`broker.ts`). A credential-delivered box, where only the unit sees the key.
 *
 * Self-targeted ops never come through here — the local op socket serves them
 * on every platform, relay or no relay.
 *
 * Nothing here logs: stdout is the MCP server's JSON-RPC channel.
 */

/**
 * The scheduler, asked as an app: `queue` and `cancel` as `RelayClient` has
 * them — refused before sending unless a verified leader is nominated
 * (`no_leader`, `leader_unverified`) — and `enqueue`, a store-put the relay
 * answers itself, which needs no leader (`availability` says whether one will
 * pick the task up).
 */
export interface SchedulerLeg {
  readonly enqueue: (task: Task) => Promise<TaskCreated | StoreRefusal | null>;
  readonly availability: () => SchedulerAvailability;
  readonly queue: () => Promise<QueueReply | null>;
  readonly cancel: (taskId: string) => Promise<TaskReply | null>;
}

/** One tool call's view of the fleet: the registry it resolves names against, and the way to send. */
export interface FleetLease {
  readonly machines: readonly Machine[];
  /** As `RelayClient.request`: any op may answer with an `ErrorResponse`. */
  readonly request: <T>(deviceId: string, op: BrokerOp, payload: unknown) => Promise<T | ErrorResponse>;
  /**
   * Null through the broker: its actions are fixed, and a scheduler one would
   * widen what a same-uid process can make the daemon send (DESIGN.md "Fleet broker").
   */
  readonly scheduler: SchedulerLeg | null;
  /** Ends the call; the direct transport's idle clock starts from here. */
  readonly release: () => void;
}

export interface Fleet {
  /** Throws when the fleet cannot be reached at all; a lease that opens must be released. */
  readonly open: () => Promise<FleetLease>;
  readonly stop: () => void;
}

export function relayFleet(relay: LazyRelay): Fleet {
  return {
    open: async (): Promise<FleetLease> => {
      const client = await relay.acquire();
      return {
        machines: client.getState().machines,
        request: <T>(deviceId: string, op: BrokerOp, payload: unknown): Promise<T | ErrorResponse> =>
          client.request<T>(deviceId, op, payload),
        scheduler: {
          enqueue: (task) => client.createTask(task),
          availability: () => client.getState().scheduler,
          queue: () => client.queue(),
          cancel: (taskId) => client.cancel(taskId),
        },
        release: (): void => relay.release(),
      };
    },
    stop: (): void => relay.stop(),
  };
}

/**
 * A fresh `machines` per call rather than a cached registry: the daemon's
 * connection is the one that stays warm, and asking it is a local round trip.
 * It is also what makes an MCP session that outlives a daemon restart recover
 * on its own — there is nothing here to go stale.
 */
export function brokerFleet(opts: BrokerCallOpts = {}): Fleet {
  return {
    open: async (): Promise<FleetLease> => ({
      machines: await brokerMachines(opts),
      request: <T>(deviceId: string, op: BrokerOp, payload: unknown): Promise<T | ErrorResponse> =>
        brokerRequest<T>(deviceId, op, payload, opts),
      scheduler: null,
      release: (): void => {},
    }),
    stop: (): void => {},
  };
}

/**
 * The daemon reads its key from a store this user can read too, so it does not
 * broker — the fix is on this side, never "update seanced".
 */
const NOT_BROKERING =
  "this daemon's key is not service-delivered, so it does not broker — `seance mcp` has to read the PSK itself";
const WHY_KEYLESS =
  "run `seance doctor` from this shell to see why it cannot (a locked keychain, a refused TPM unseal, an empty psk field — fill the field or run `seance psk-import`)";

/** What a broker failure needs added for the reader to act on it. */
export function brokerFailureText(err: BrokerError): string {
  if (err.code === "daemon_unreachable") return `${err.message} — is seanced running? try \`seance status\``;
  if (err.code === "relay_unavailable") return `the daemon could not reach the relay: ${err.message}`;
  if (err.code === "broker_disabled") return `${NOT_BROKERING}; ${WHY_KEYLESS}`;
  return err.message;
}

const NO_KEY = "no PSK is readable by this process, so other machines are reached through the seanced daemon";
const LOCAL_STILL_WORKS = "Spawning on this machine needs neither.";
// Local ops ride the same daemon's op socket, so a daemon that is not there takes them down too.
const LOCAL_NEEDS_IT_TOO = "Ops on this machine go through that same daemon, so they fail too until it is running.";

/**
 * `up`: the daemon answered, so its op socket serves local ops. `down`: nothing
 * listens. `unknown`: it took the connection and then went silent or hung up.
 */
export type LocalOutlook = "up" | "down" | "unknown";

function localOutlook(cause: unknown): LocalOutlook {
  if (!(cause instanceof BrokerError)) return "up";
  if (cause.code === "daemon_unreachable") return "down";
  if (cause.code === "daemon_timeout" || cause.code === "daemon_closed") return "unknown";
  return "up";
}

/** What the reader can do about this cause — each broker code fails for a different reason. */
function unreachableAdvice(cause: unknown): string {
  if (!(cause instanceof BrokerError))
    return `${NO_KEY}, which could not be used (${String(cause)}). ${LOCAL_STILL_WORKS}`;
  const { code, message } = cause;
  switch (code) {
    case "daemon_unreachable":
      return (
        `${NO_KEY}, and none is reachable: it is not running, or too old to have the socket (${message}). ` +
        "Check it with `seance status` — is seanced running? Where only the seanced service can read the key it must be " +
        "running; elsewhere fill the psk field in config.json or run `seance psk-import`. " +
        LOCAL_NEEDS_IT_TOO
      );
    case "relay_unavailable":
      return `${NO_KEY}. The daemon is running but could not reach the relay (${message}). ${LOCAL_STILL_WORKS}`;
    case "broker_disabled":
      return `${NO_KEY}, but ${NOT_BROKERING}; ${WHY_KEYLESS}. ${LOCAL_STILL_WORKS}`;
    case "busy":
      return `${NO_KEY}. The daemon is busy (${message}) — try again in a moment. ${LOCAL_STILL_WORKS}`;
    case "daemon_timeout":
      // The peer's deadline outlasts the daemon's whole relay budget, so a slow
      // relay comes back as relay_unavailable; silence means the daemon itself.
      return (
        `${NO_KEY}. The daemon accepted the connection but never answered (${message}), and it answers even a ` +
        "relay failure well inside that time, so the daemon itself is stuck. Ops on this machine go through it too " +
        "and will likely hang the same way — check `seance status`, and `seance restart` if it stays stuck."
      );
    case "daemon_closed":
      // A stopping daemon and a pre-broker one both close; `brokerMachines` names the second in `message`.
      return (
        `${NO_KEY}. The daemon dropped the connection without answering (${message}). If it was stopping or ` +
        "restarting, ops on this machine fail too until it is back — check `seance status`."
      );
    case "bad_reply":
      return `${NO_KEY}. The daemon's answer was not readable (${message}) — a mismatched seanced version? ${LOCAL_STILL_WORKS}`;
    default:
      return `${NO_KEY}. The daemon refused (${code}: ${message}). ${LOCAL_STILL_WORKS}`;
  }
}

/**
 * Neither transport is available: no PSK in this process, and no daemon to
 * broker for it. Distinct from a direct-path failure, which is the relay's and
 * says so in its own words.
 */
export class FleetUnreachable extends Error {
  /** What the failure says about local ops, which ride the same daemon — so a caller never contradicts the message. */
  readonly localOps: LocalOutlook;
  constructor(cause: unknown) {
    super(unreachableAdvice(cause));
    this.name = "FleetUnreachable";
    this.localOps = localOutlook(cause);
  }
}

/**
 * Doctor's line on how `seance mcp` would reach other machines from this
 * shell. Never resolves a key of its own — the caller says whether its own
 * `loadPsk` found one — and probes the broker only where it would be used,
 * with `machines`, which cannot change anything.
 */
export async function mcpFleetChecks(keyReadable: boolean, opts: BrokerCallOpts = {}): Promise<readonly Check[]> {
  if (keyReadable) {
    return [{ level: "ok", message: "MCP reaches other machines directly — this user can read the PSK" }];
  }
  try {
    const machines = await brokerMachines(opts);
    return [
      {
        level: "ok",
        message: `MCP reaches other machines through the daemon's broker — no PSK readable here, ${machines.length} machine(s) in the registry`,
      },
    ];
  } catch (err) {
    const prefix = "no PSK readable here, so MCP reaches other machines through the daemon — ";
    if (!(err instanceof BrokerError)) return [{ level: "warn", message: `${prefix}${String(err)}` }];
    if (err.code === "daemon_unreachable") {
      return [
        {
          level: "warn",
          message: `${prefix}and no daemon is listening; nothing is reachable until seanced runs, this machine included — its ops ride the same daemon`,
        },
      ];
    }
    if (err.code === "broker_disabled") {
      return [
        {
          level: "warn",
          message: `no PSK readable here, and ${NOT_BROKERING} (the key-store lines above say why it cannot); only this machine is reachable until then`,
        },
      ];
    }
    return [{ level: "warn", message: `${prefix}but it could not: ${brokerFailureText(err)}` }];
  }
}

/**
 * Long enough that a keyless box does not re-run a refused TPM unseal on every
 * tool call; short enough that a keychain unlocked mid-session is picked up.
 */
const KEY_RETRY_MS = 60_000;

export interface SelectFleetOpts {
  /**
   * This process's own key, or null when nothing it can read holds one — the
   * typed signal for "use the daemon", never inferred from an error's text. A
   * key that exists but is unusable throws, and that error is the answer.
   */
  readonly key: () => Promise<CryptoKey | null>;
  readonly direct: (key: CryptoKey) => Fleet;
  readonly broker: Fleet;
  readonly keyRetryMs?: number;
  readonly now?: () => number;
}

/**
 * Direct when this process holds a key, the broker when it holds none. The
 * choice is made before anything is sent and never revisited for a call in
 * flight: a direct failure — a bad token, a dead relay — is surfaced as itself,
 * never retried through the daemon, since a spawn that may have landed must not
 * be fired twice.
 */
export function selectFleet(opts: SelectFleetOpts): Fleet {
  const now = opts.now ?? Date.now;
  const retryMs = opts.keyRetryMs ?? KEY_RETRY_MS;
  let direct: Fleet | null = null;
  let keylessUntil = 0;
  let resolving: Promise<CryptoKey | null> | null = null;

  const resolveKey = async (): Promise<void> => {
    if (direct !== null || now() < keylessUntil) return;
    // Concurrent tool calls share one lookup: a keychain prompt or a TPM
    // refusal once, not once per call.
    resolving ??= opts.key().finally(() => {
      resolving = null;
    });
    const key = await resolving;
    if (direct !== null) return;
    if (key === null) keylessUntil = now() + retryMs;
    else direct = opts.direct(key);
  };

  return {
    open: async (): Promise<FleetLease> => {
      await resolveKey();
      if (direct !== null) return direct.open();
      try {
        return await opts.broker.open();
      } catch (err) {
        throw new FleetUnreachable(err);
      }
    },
    stop: (): void => {
      direct?.stop();
      opts.broker.stop();
    },
  };
}
