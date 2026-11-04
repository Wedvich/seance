import {
  isRecord,
  OP_TIMEOUT_MS,
  parseMachineInfo,
  parseMachineStatus,
  REGISTRY_SETTLE_MS,
  STORE_LIST_TIMEOUT_MS,
  STORE_TIMEOUT_MS,
  type FailureReason,
  type Machine,
  type RequestFailureTarget,
  type SchedulerAvailability,
  type StoreRefusal,
  type TaskCreated,
  type TaskSpec,
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

/**
 * The scheduler ops a peer may ask the daemon to make as an app: what `auto`,
 * `queue_batch`, `get_queue`, `cancel_task`, `start_task`, `seanced spawn` and
 * `seanced start` need, and the account read that resolves an alias. `mark-done`,
 * `pause`, `resume`, `discard`, `route-preview` and every `account:` write stay off the list.
 */
export const BROKER_SCHEDULER_OPS = ["enqueue", "queue", "cancel", "run-now", "accounts"] as const;

export type BrokerSchedulerOp = (typeof BROKER_SCHEDULER_OPS)[number];

export function isBrokerSchedulerOp(value: unknown): value is BrokerSchedulerOp {
  return BROKER_SCHEDULER_OPS.some((op) => op === value);
}

/** The only clients a brokered enqueue may claim: the two surfaces that reach the broker. */
export const BROKER_ENQUEUE_CLIENTS = ["mcp", "cli"] as const;

export type BrokerEnqueueClient = (typeof BROKER_ENQUEUE_CLIENTS)[number];

export function isBrokerEnqueueClient(value: unknown): value is BrokerEnqueueClient {
  return BROKER_ENQUEUE_CLIENTS.some((client) => client === value);
}

type BrokerFrame = { readonly v: typeof BROKER_VERSION; readonly kind: "broker"; readonly id: string };

export type BrokerRequest =
  | (BrokerFrame & { readonly action: "machines" })
  | (BrokerFrame & { readonly action: "fleet" })
  | (BrokerFrame & {
      readonly action: "scheduler";
      readonly schedulerOp: "enqueue";
      /** Minted by the peer, which needs it to retry and to name `deps`; only ever a create at `expect: 0`. */
      readonly taskId: string;
      readonly spec: TaskSpec;
    })
  | (BrokerFrame & {
      readonly action: "scheduler";
      readonly schedulerOp: "cancel" | "run-now";
      readonly taskId: string;
    })
  | (BrokerFrame & { readonly action: "scheduler"; readonly schedulerOp: "queue" | "accounts" })
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
  /**
   * This daemon brokers nothing: its key is not service-delivered, so a keyless
   * peer's fix is to read the key itself. Its own code rather than
   * `unsupported`, so the peer can say so without matching message text.
   */
  "broker_disabled",
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
      /** With `reason`: what did not answer, so a relay timeout is not read back as a machine's. An older peer ignores it. */
      readonly target?: RelayFailureTarget;
    };

/** What a relay-side failure blames; the broker carries it, and a `daemon` target is only ever minted peer-side. */
export type RelayFailureTarget = Exclude<RequestFailureTarget, "daemon">;

function isRelayFailureTarget(value: unknown): value is RelayFailureTarget {
  return value === "machine" || value === "relay";
}

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

export function brokerFail(
  re: string,
  code: BrokerErrorCode,
  message: string,
  reason?: FailureReason,
  target?: RelayFailureTarget,
): BrokerReply {
  return {
    v: BROKER_VERSION,
    kind: "broker-reply",
    re,
    ok: false,
    code,
    message,
    ...(reason === undefined ? {} : { reason }),
    ...(target === undefined ? {} : { target }),
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
  unsupported: true,
  timeout: true,
  disconnected: true,
  dropped: true,
  not_leader: true,
  no_leader: true,
  leader_unverified: true,
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
  const { code, message, reason, target } = raw;
  if (!isBrokerErrorCode(code) || typeof message !== "string") return null;
  return brokerFail(
    re,
    code,
    message,
    isFailureReason(reason) ? reason : undefined,
    isRelayFailureTarget(target) ? target : undefined,
  );
}

/**
 * The `machines` and `fleet` answer, checked field by field: it feeds name
 * resolution, the repo pre-check, `auto`'s placement (exclaves, capabilities)
 * and the model's view of the fleet. The sealed-blob fields go through the one
 * `parseMachineInfo`, whose per-field leniency applies: a malformed optional
 * field costs that field, never the list.
 */
export function parseMachines(data: unknown): readonly Machine[] | null {
  if (!Array.isArray(data)) return null;
  const machines: Machine[] = [];
  for (const candidate of data) {
    if (!isRecord(candidate)) return null;
    const { deviceId, lastSeen, connected } = candidate;
    const info = parseMachineInfo(candidate);
    if (info === null) return null;
    if (typeof deviceId !== "string" || typeof lastSeen !== "number" || typeof connected !== "boolean") return null;
    // Display-only and optional, so a malformed one costs the field.
    const status = parseMachineStatus(candidate["status"]);
    machines.push({
      deviceId,
      name: info.name,
      platform: info.platform,
      repos: info.repos,
      scannedAt: info.scannedAt,
      lastSeen,
      connected,
      ...(status === null ? {} : { status }),
      ...(info.capabilities === undefined ? {} : { capabilities: info.capabilities }),
      ...(info.exclaves === undefined ? {} : { exclaves: info.exclaves }),
      // `MachineInfo` allows null where `Machine` wants the field absent.
      ...(info.source === undefined || info.source === null ? {} : { source: info.source }),
      ...(info.lastUpdate === undefined || info.lastUpdate === null ? {} : { lastUpdate: info.lastUpdate }),
    });
  }
  return machines;
}

/**
 * Who would answer `auto`, as the daemon's connection sees it. Anything this
 * build cannot read — a kind a newer daemon minted — is "no verified leader",
 * the conservative gate: nothing is sent to a leader that cannot be named.
 */
export function parseSchedulerAvailability(value: unknown): SchedulerAvailability {
  if (!isRecord(value)) return { kind: "none" };
  const { kind, deviceId, term } = value;
  if (kind !== "unverified" && kind !== "ready") return { kind: "none" };
  if (typeof deviceId !== "string" || deviceId === "") return { kind: "none" };
  if (typeof term !== "number" || !Number.isInteger(term) || term < 0) return { kind: "none" };
  return { kind, deviceId, term };
}

/**
 * An enqueue's answer: stored (`landedEarlier` or not), refused with the
 * relay's code, or null for a lost reply. `undefined` is "not an answer at all",
 * which the caller turns into `bad_reply` — this file has no `BrokerError`.
 */
export function parseTaskCreated(value: unknown): TaskCreated | StoreRefusal | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (value["ok"] === true) {
    const { landedEarlier } = value;
    return typeof landedEarlier === "boolean" ? { ok: true, landedEarlier } : undefined;
  }
  if (value["ok"] !== false) return undefined;
  const { code } = value;
  return typeof code === "string" ? { ok: false, code } : undefined;
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

/** A `Record`, so a new scheduler op without a budget fails the typecheck. */
const SCHEDULER_OP_BUDGET_MS: Record<BrokerSchedulerOp, number> = {
  enqueue: STORE_TIMEOUT_MS,
  queue: OP_TIMEOUT_MS.queue,
  cancel: OP_TIMEOUT_MS.cancel,
  "run-now": OP_TIMEOUT_MS["run-now"],
  accounts: STORE_LIST_TIMEOUT_MS,
};

/** As `brokerDeadlineMs`: the peer outwaits the daemon's own dial, settle and op, never just the op. */
export function brokerSchedulerDeadlineMs(op: BrokerSchedulerOp): number {
  return CONNECT_TIMEOUT_MS + REGISTRY_SETTLE_MS + SCHEDULER_OP_BUDGET_MS[op] + BROKER_MARGIN_MS;
}
