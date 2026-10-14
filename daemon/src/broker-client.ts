import { RequestFailure, type Machine } from "@seance/shared";
import {
  BROKER_VERSION,
  brokerDeadlineMs,
  parseBrokerReply,
  parseMachines,
  type BrokerErrorCode,
  type BrokerOp,
  type BrokerRequest,
} from "./broker-protocol.ts";
import { exchange, LocalConnectionLost, LocalTimedOut, LocalUnavailable } from "./local-client.ts";
import { socketPath } from "./paths.ts";

/**
 * The peer side of the fleet broker — what a keyless `seanced mcp` uses to reach
 * other machines through the daemon on its own box. Nothing here logs: this runs
 * inside the MCP server, whose stdout is JSON-RPC.
 */

/** The daemon's own codes, plus what can go wrong between this process and the daemon. */
export type BrokerClientCode =
  | BrokerErrorCode
  /** Nothing listening: no daemon, or no socket. Nothing was sent. */
  | "daemon_unreachable"
  /** Connected, then lost without an answer — a daemon stopping, or one that predates the broker. */
  | "daemon_closed"
  | "daemon_timeout"
  /** An answer that was not a broker reply to this request. */
  | "bad_reply";

export class BrokerError extends Error {
  constructor(
    readonly code: BrokerClientCode,
    message: string,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

/**
 * Codes that can arrive after the daemon may already have sent the request on.
 * For a side-effecting op they must not read as "it did not happen", or the
 * model's natural next move is a duplicate spawn. `shutting_down` is not here:
 * it is only ever a refusal before anything was sent. The daemon's own messages
 * for these codes never claim it, so the line is added here exactly once.
 */
const UNCERTAIN: ReadonlySet<BrokerClientCode> = new Set<BrokerClientCode>([
  "daemon_closed",
  "daemon_timeout",
  "stopped_in_flight",
  "internal_error",
  "reply_too_large",
  "bad_reply",
]);

const MAY_HAVE_LANDED = " — the request may have landed anyway; check get_sessions before retrying";

export interface BrokerCallOpts {
  readonly path?: string;
  /** Defaults to `brokerDeadlineMs` for the op; tests shorten it. */
  readonly timeoutMs?: number;
}

/** Sends one broker frame and returns the reply's data, or throws a `BrokerError` / the `RequestFailure` the direct path would have. */
async function call(frame: BrokerRequest, op: BrokerOp | null, opts: BrokerCallOpts): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? brokerDeadlineMs(op);
  let raw: unknown;
  try {
    raw = await exchange(frame, {
      path: opts.path ?? socketPath(),
      timeoutMs,
      timeoutText: `the daemon did not answer within ${timeoutMs}ms`,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Order matters: LocalConnectionLost is a LocalUnavailable.
    if (err instanceof LocalConnectionLost) throw new BrokerError("daemon_closed", detail);
    if (err instanceof LocalUnavailable) throw new BrokerError("daemon_unreachable", detail);
    if (err instanceof LocalTimedOut) throw new BrokerError("daemon_timeout", detail);
    throw new BrokerError("bad_reply", detail);
  }
  const reply = parseBrokerReply(raw);
  if (reply === null || reply.re !== frame.id) {
    throw new BrokerError("bad_reply", "the daemon's answer was not a broker reply to this request");
  }
  if (reply.ok) return reply.data;
  // Rebuilt rather than wrapped, so a brokered failure renders through
  // `failureReasonText` exactly as the same failure on the direct path does.
  if (reply.code === "request_failed" && reply.reason !== undefined)
    throw new RequestFailure(reply.reason, reply.message);
  throw new BrokerError(reply.code, reply.message);
}

/**
 * The registry as the daemon's app-role connection sees it. Side-effect free,
 * which is why it is also the probe for "does this daemon broker at all": a
 * daemon older than the broker drops the frame and closes, and that reading is
 * safe only for a request that cannot have done anything.
 */
export async function brokerMachines(opts: BrokerCallOpts = {}): Promise<readonly Machine[]> {
  const frame: BrokerRequest = { v: BROKER_VERSION, kind: "broker", id: crypto.randomUUID(), action: "machines" };
  let data: unknown;
  try {
    data = await call(frame, null, opts);
  } catch (err) {
    if (err instanceof BrokerError && err.code === "daemon_closed") {
      throw new BrokerError(
        "daemon_closed",
        `${err.message} — a seanced older than the fleet broker answers this way; update it and \`seanced restart\``,
      );
    }
    throw err;
  }
  const machines = parseMachines(data);
  if (machines === null) throw new BrokerError("bad_reply", "the daemon's machine list was not readable");
  return machines;
}

/** One of the three allowlisted ops on one other machine, by exact deviceId. Never retried — not here, not by the caller. */
export async function brokerRequest<T>(
  deviceId: string,
  op: BrokerOp,
  payload: unknown,
  opts: BrokerCallOpts = {},
): Promise<T> {
  const frame: BrokerRequest = {
    v: BROKER_VERSION,
    kind: "broker",
    id: crypto.randomUUID(),
    action: "request",
    deviceId,
    remoteOp: op,
    payload,
  };
  try {
    // The reply's data is the target daemon's own response payload, typed by
    // the op exactly as the app-role client's `request<T>` types it.
    return (await call(frame, op, opts)) as T;
  } catch (err) {
    if (op !== "sessions" && err instanceof BrokerError && UNCERTAIN.has(err.code)) {
      throw new BrokerError(err.code, `${err.message}${MAY_HAVE_LANDED}`);
    }
    throw err;
  }
}
