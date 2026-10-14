import {
  isRecord,
  OP_TIMEOUT_MS,
  parseRepoList,
  REGISTRY_SETTLE_MS,
  type FailureReason,
  type Machine,
} from "@seance/shared";
import { CONNECT_TIMEOUT_MS } from "./app-relay.ts";

/**
 * The fleet broker's frames on the local op socket: what a keyless `seanced mcp`
 * sends the daemon to reach *other* machines, and what comes back. Shared by
 * both ends, so nothing here logs — the client end runs inside `seanced mcp`,
 * whose stdout is JSON-RPC.
 *
 * Deliberately not a `Plain` and not an `OpName`. A broker frame names an
 * action, never an op the relay handler routes, so no broker verb can arrive
 * from the relay, and no relay op can be smuggled in as a broker action. The
 * remote op rides in `remoteOp` rather than `op`, and there is no `ts`: a
 * daemon that predates the broker must see a malformed frame and drop it — were
 * it shaped like a `Plain`, an old daemon would run a *local* spawn for a
 * request meant for another machine.
 */

export const BROKER_VERSION = 1;

/** The remote ops a peer may ask the daemon to forward. The relay's other ops never cross this socket. */
export const BROKER_OPS = ["sessions", "spawn", "despawn"] as const;

export type BrokerOp = (typeof BROKER_OPS)[number];

export function isBrokerOp(value: unknown): value is BrokerOp {
  return BROKER_OPS.some((op) => op === value);
}

export type BrokerRequest =
  | { readonly v: typeof BROKER_VERSION; readonly kind: "broker"; readonly id: string; readonly action: "machines" }
  | {
      readonly v: typeof BROKER_VERSION;
      readonly kind: "broker";
      readonly id: string;
      readonly action: "request";
      /** An exact registry deviceId — never a name, a group address or this machine. */
      readonly deviceId: string;
      readonly remoteOp: BrokerOp;
      readonly payload: unknown;
    };

/**
 * Structured refusals, so the MCP side can tell "fix the request" from "the
 * relay is down" from "it may have landed" without matching message text.
 */
export const BROKER_ERROR_CODES = [
  /** A version or action this daemon does not broker. */
  "unsupported",
  /** A remote op off the allowlist: rescan, update-available, anything else. */
  "op_not_allowed",
  /** Missing or mistyped fields, or a payload not shaped like its op's request. */
  "invalid_request",
  /** A routing address rather than a machine: the app id or the group address. */
  "invalid_target",
  /** This daemon's own deviceId — the local op path serves it with no relay. */
  "self_target",
  /** No machine with that deviceId in the registry this daemon can decrypt. */
  "unknown_target",
  /** Too many brokered requests already in flight. */
  "busy",
  /** The daemon's app-role connection could not be opened. */
  "relay_unavailable",
  /** The relay declined or lost the request; `reason` carries the client's `FailureReason`. */
  "request_failed",
  /** The answer would not fit in one frame. */
  "reply_too_large",
  /** Refused because the daemon is stopping or reloading — before anything was sent. */
  "shutting_down",
  /** The daemon stopped with the request already out, so it may have landed. */
  "stopped_in_flight",
  "internal_error",
] as const;

export type BrokerErrorCode = (typeof BROKER_ERROR_CODES)[number];

export type BrokerReply =
  | {
      readonly v: typeof BROKER_VERSION;
      readonly kind: "broker-reply";
      readonly re: string;
      readonly ok: true;
      readonly data: unknown;
    }
  | {
      readonly v: typeof BROKER_VERSION;
      readonly kind: "broker-reply";
      readonly re: string;
      readonly ok: false;
      readonly code: BrokerErrorCode;
      readonly message: string;
      /** Set with `request_failed`, so the peer can rebuild the same `RequestFailure` the direct path would throw. */
      readonly reason?: FailureReason;
    };

/** How the local socket tells a broker frame from a `Plain` before validating either. */
export function isBrokerFrame(raw: unknown): boolean {
  return isRecord(raw) && raw["kind"] === "broker";
}

/** The id to correlate a reply against, or null when there is nothing to answer to. */
export function brokerFrameId(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const id = raw["id"];
  return typeof id === "string" && id !== "" ? id : null;
}

export function brokerOk(re: string, data: unknown): BrokerReply {
  return { v: BROKER_VERSION, kind: "broker-reply", re, ok: true, data };
}

export function brokerFail(re: string, code: BrokerErrorCode, message: string, reason?: FailureReason): BrokerReply {
  return {
    v: BROKER_VERSION,
    kind: "broker-reply",
    re,
    ok: false,
    code,
    message,
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * A `Record` over the shared union, not a list: adding a reason in shared leaves
 * a key missing here, which fails the typecheck instead of silently dropping
 * that reason from every brokered reply.
 */
const FAILURE_REASONS: Record<FailureReason, true> = {
  offline: true,
  unknown: true,
  refused: true,
  timeout: true,
  disconnected: true,
};

function isBrokerErrorCode(value: unknown): value is BrokerErrorCode {
  return BROKER_ERROR_CODES.some((code) => code === value);
}

function isFailureReason(value: unknown): value is FailureReason {
  return typeof value === "string" && Object.hasOwn(FAILURE_REASONS, value);
}

/**
 * Validates a reply on the client end. Null for anything that isn't one —
 * including a code minted by a newer daemon, which the caller reports as an
 * unreadable answer rather than guessing what it meant.
 */
export function parseBrokerReply(raw: unknown): BrokerReply | null {
  if (!isRecord(raw) || raw["kind"] !== "broker-reply" || raw["v"] !== BROKER_VERSION) return null;
  const re = raw["re"];
  if (typeof re !== "string") return null;
  if (raw["ok"] === true) return brokerOk(re, raw["data"]);
  if (raw["ok"] !== false) return null;
  const { code, message, reason } = raw;
  if (!isBrokerErrorCode(code) || typeof message !== "string") return null;
  return brokerFail(re, code, message, isFailureReason(reason) ? reason : undefined);
}

/** The `machines` answer, checked field by field: it feeds name resolution and the model's view of the fleet. */
export function parseMachines(data: unknown): readonly Machine[] | null {
  if (!Array.isArray(data)) return null;
  const machines: Machine[] = [];
  for (const candidate of data) {
    if (!isRecord(candidate)) return null;
    const { deviceId, name, platform, scannedAt, lastSeen, connected } = candidate;
    const repos = parseRepoList(candidate["repos"]);
    if (typeof deviceId !== "string" || typeof name !== "string" || typeof platform !== "string") return null;
    if (typeof scannedAt !== "number" || typeof lastSeen !== "number" || typeof connected !== "boolean") return null;
    if (repos === null) return null;
    machines.push({ deviceId, name, platform, repos, scannedAt, lastSeen, connected });
  }
  return machines;
}

/** Slack for sealing, the socket hop and the daemon's own scheduling. */
const BROKER_MARGIN_MS = 5_000;

/**
 * How long a peer waits for the daemon. The daemon may have to dial the relay
 * and settle its registry before it can even send — so the deadline is that
 * budget *plus* the op's own, never the op's alone: a spawn cut off at 90s by
 * the peer could still be on its way to the target.
 */
export function brokerDeadlineMs(op: BrokerOp | null): number {
  return CONNECT_TIMEOUT_MS + REGISTRY_SETTLE_MS + (op === null ? 0 : OP_TIMEOUT_MS[op]) + BROKER_MARGIN_MS;
}
