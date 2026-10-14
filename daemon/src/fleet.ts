import type { Machine } from "@seance/shared";
import type { LazyRelay } from "./app-relay.ts";
import { BrokerError, brokerMachines, brokerRequest, type BrokerCallOpts } from "./broker-client.ts";
import type { BrokerOp } from "./broker-protocol.ts";
import type { Check } from "./check.ts";

/**
 * How `seanced mcp` reaches machines other than its own. Two transports behind
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

/** One tool call's view of the fleet: the registry it resolves names against, and the way to send. */
export interface FleetLease {
  readonly machines: readonly Machine[];
  readonly request: <T>(deviceId: string, op: BrokerOp, payload: unknown) => Promise<T>;
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
        request: <T>(deviceId: string, op: BrokerOp, payload: unknown): Promise<T> =>
          client.request<T>(deviceId, op, payload),
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
      request: <T>(deviceId: string, op: BrokerOp, payload: unknown): Promise<T> =>
        brokerRequest<T>(deviceId, op, payload, opts),
      release: (): void => {},
    }),
    stop: (): void => {},
  };
}

/** What a broker failure needs added for the reader to act on it. */
export function brokerFailureText(err: BrokerError): string {
  if (err.code === "daemon_unreachable") return `${err.message} — is seanced running? try \`seanced status\``;
  if (err.code === "relay_unavailable") return `the daemon could not reach the relay: ${err.message}`;
  return err.message;
}

const NO_KEY = "no PSK is readable by this process, so other machines are reached through the seanced daemon";
const LOCAL_STILL_WORKS = "Spawning on this machine needs neither.";

/** What the reader can do about this cause — each broker code fails for a different reason. */
function unreachableAdvice(cause: unknown): string {
  if (!(cause instanceof BrokerError))
    return `${NO_KEY}, which could not be used (${String(cause)}). ${LOCAL_STILL_WORKS}`;
  const { code, message } = cause;
  switch (code) {
    case "daemon_unreachable":
      return (
        `${NO_KEY}, and none is reachable: it is not running, or too old to have the socket (${message}). ` +
        "Check it with `seanced status` — is seanced running? Where only the seanced service can read the key it must be " +
        "running; elsewhere fill the psk field in config.json or run `seanced psk-import`. " +
        LOCAL_STILL_WORKS
      );
    case "relay_unavailable":
      return `${NO_KEY}. The daemon is running but could not reach the relay (${message}). ${LOCAL_STILL_WORKS}`;
    case "busy":
      return `${NO_KEY}. The daemon is busy (${message}) — try again in a moment. ${LOCAL_STILL_WORKS}`;
    case "daemon_timeout":
      return `${NO_KEY}. The daemon did not answer in time (${message}) — try again. ${LOCAL_STILL_WORKS}`;
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
  constructor(cause: unknown) {
    super(unreachableAdvice(cause));
    this.name = "FleetUnreachable";
  }
}

/**
 * Doctor's line on how `seanced mcp` would reach other machines from this
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
          message: `${prefix}and no daemon is listening; only this machine is reachable until seanced runs`,
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
