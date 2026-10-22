import {
  APP_ID,
  isRecord,
  MACHINES_ID,
  quote,
  RequestFailure,
  type DespawnRequest,
  type FailureReason,
  type SpawnClient,
  type SpawnRequest,
} from "@seance/shared";
import { appRelayClient, LazyRelay, type AppRelay } from "./app-relay.ts";
import { brokerAudit, type AuditSink } from "./audit.ts";
import {
  BROKER_VERSION,
  brokerFail,
  brokerFrameId,
  brokerOk,
  isBrokerOp,
  type BrokerErrorCode,
  type BrokerReply,
  type BrokerRequest,
} from "./broker-protocol.ts";
import type { Config } from "./config.ts";
import { isDespawnRequest, isSpawnRequest } from "./handlers.ts";
import { log } from "./log.ts";

/**
 * The daemon side of the fleet broker: a keyless `seance mcp` on this box asks
 * for the registry, or for one of three ops on one other machine, and the daemon
 * makes that app-role request itself with the key it already holds.
 *
 * Why a separate app-role connection: the daemon's own relay socket is
 * daemon-role — it registers, receives ops and answers them, and the relay never
 * pushes it the registry or routes its envelopes to another daemon. Reaching
 * another machine means being an app, so the broker is a fourth app-role client
 * beside the PWA, Raycast and `seance mcp`, built over the shared one.
 *
 * What it is not: a crypto oracle, a relay forwarder or a key export. The peer
 * names an action and a deviceId; the daemon decides the address, builds the
 * payload from validated fields, seals with its own key and dials its own
 * configured relay. There is no frame that returns the key, seals or opens
 * arbitrary bytes, or addresses `"machines"`.
 *
 * Built only by a daemon whose key is service-delivered (`run-capabilities.ts`): elsewhere
 * `seance mcp` reads the key itself, and the broker would add authority, not reach.
 */

/**
 * Generous for one human's Claude sessions; small enough that a runaway local
 * process cannot pile up spawns behind a slow relay.
 */
const MAX_IN_FLIGHT = 16;

export interface BrokerOpts {
  /** This daemon's own deviceId. A request aimed here belongs on the local op path, not a relay round trip back to itself. */
  readonly selfDeviceId: string;
  readonly relay: LazyRelay;
  readonly auditSink: AuditSink;
  readonly maxInFlight?: number;
}

export interface Broker {
  /** Never rejects: every failure, a crash included, is a structured reply the peer can render. */
  readonly handle: (raw: unknown) => Promise<BrokerReply>;
  /** Hangs up the app-role socket; in-flight requests fail, new ones are refused as `shutting_down`. */
  readonly stop: () => void;
}

/**
 * The broker's relay connection: the daemon's already-imported key, never a
 * second store lookup — on a credential-delivered box nothing but this process can
 * read the key, and a second lookup would be a second chance to get it wrong.
 * Lazy and idle-closing like `seance mcp`'s, so a box nobody brokers through
 * holds no extra socket.
 */
export function brokerRelay(config: Pick<Config, "relayUrl" | "bearerToken">, key: CryptoKey): LazyRelay {
  return new LazyRelay({ create: () => appRelayClient(config, key, (line) => log.info(line)) });
}

type Parsed = { readonly request: BrokerRequest } | { readonly code: BrokerErrorCode; readonly message: string };

/**
 * Stamped by the broker, never copied from the peer: a same-uid process could
 * otherwise make the target's audit line read as the PWA. What reaches the
 * target is always `client="mcp"`, as for a direct MCP spawn.
 */
const BROKER_CLIENT: SpawnClient = "mcp";

/**
 * Rebuilt from validated fields rather than forwarded: whatever else a peer put
 * in the payload — its `client` included — never reaches the wire.
 */
function cleanSpawn(p: SpawnRequest): SpawnRequest {
  return {
    repo: p.repo,
    mode: p.mode,
    ...(p.prompt === undefined ? {} : { prompt: p.prompt }),
    ...(p.title === undefined ? {} : { title: p.title }),
    ...(p.model === undefined ? {} : { model: p.model }),
    ...(p.effort === undefined ? {} : { effort: p.effort }),
    ...(p.plan === undefined ? {} : { plan: p.plan }),
    client: BROKER_CLIENT,
  };
}

function cleanDespawn(p: DespawnRequest): DespawnRequest {
  return {
    id: p.id,
    ...(p.force === undefined ? {} : { force: p.force }),
    client: BROKER_CLIENT,
  };
}

/** Fails closed: every field is checked, and anything not named here is refused. */
export function parseBrokerRequest(raw: unknown, selfDeviceId: string): Parsed {
  if (!isRecord(raw)) return { code: "invalid_request", message: "not a broker frame" };
  const id = brokerFrameId(raw);
  if (id === null) return { code: "invalid_request", message: "missing id" };
  if (raw["v"] !== BROKER_VERSION) {
    return { code: "unsupported", message: `broker protocol version ${String(raw["v"])} is not spoken here` };
  }
  const action = raw["action"];
  if (action === "machines") return { request: { v: BROKER_VERSION, kind: "broker", id, action } };
  if (action !== "request") {
    return { code: "unsupported", message: `action ${quote(String(action))} is not brokered` };
  }

  const remoteOp = raw["remoteOp"];
  if (!isBrokerOp(remoteOp)) {
    return { code: "op_not_allowed", message: `op ${quote(String(remoteOp))} is not brokered to other machines` };
  }
  const deviceId = raw["deviceId"];
  if (typeof deviceId !== "string" || deviceId === "") {
    return { code: "invalid_request", message: "deviceId must be a non-empty string" };
  }
  if (deviceId === APP_ID || deviceId === MACHINES_ID) {
    return { code: "invalid_target", message: `${quote(deviceId)} is a routing address, not a machine` };
  }
  if (deviceId === selfDeviceId) {
    return { code: "self_target", message: "that is this machine — its ops go to the local op socket, not the relay" };
  }

  const payload = raw["payload"];
  let clean: unknown;
  if (remoteOp === "sessions") clean = {};
  else if (remoteOp === "spawn") {
    if (!isSpawnRequest(payload)) return { code: "invalid_request", message: "malformed spawn request" };
    clean = cleanSpawn(payload);
  } else {
    if (!isDespawnRequest(payload)) return { code: "invalid_request", message: "malformed despawn request" };
    clean = cleanDespawn(payload);
  }
  return { request: { v: BROKER_VERSION, kind: "broker", id, action, deviceId, remoteOp, payload: clean } };
}

function clientOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const client = payload["client"];
  return typeof client === "string" ? client : undefined;
}

export function createBroker(opts: BrokerOpts): Broker {
  const audit = brokerAudit(opts.auditSink);
  const maxInFlight = opts.maxInFlight ?? MAX_IN_FLIGHT;
  let inFlight = 0;
  let stopped = false;

  const fail = async (
    id: string,
    code: BrokerErrorCode,
    message: string,
    reason?: FailureReason,
  ): Promise<BrokerReply> => {
    await audit.failed(id, code, reason);
    return brokerFail(id, code, message, reason);
  };

  const serve = async (request: BrokerRequest): Promise<BrokerReply> => {
    const { id } = request;
    let client: AppRelay;
    try {
      client = await opts.relay.acquire();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return stopped ? fail(id, "shutting_down", "the daemon is stopping") : fail(id, "relay_unavailable", message);
    }
    try {
      if (request.action === "machines") {
        await audit.ok(id);
        return brokerOk(id, client.getState().machines);
      }
      // Only machines this daemon's key can read: a registry entry that did not
      // decrypt is not a machine this fleet owns, whatever its id says.
      if (!client.getState().machines.some((machine) => machine.deviceId === request.deviceId)) {
        return fail(id, "unknown_target", `no machine with deviceId ${quote(request.deviceId)} in the registry`);
      }
      try {
        const data = await client.request<unknown>(request.deviceId, request.remoteOp, request.payload);
        await audit.ok(id);
        return brokerOk(id, data);
      } catch (err) {
        if (!(err instanceof RequestFailure)) throw err;
        // A stop mid-request fails it as "dropped" — it was already on
        // the wire, so the peer must hear that it may have landed, not that it
        // never left. The peer's side words the "may have landed".
        if (stopped) return fail(id, "stopped_in_flight", "the daemon stopped while the request was out");
        return fail(id, "request_failed", err.message, err.reason);
      }
    } finally {
      opts.relay.release();
    }
  };

  const handle = async (raw: unknown): Promise<BrokerReply> => {
    const id = brokerFrameId(raw) ?? "";
    try {
      const parsed = parseBrokerRequest(raw, opts.selfDeviceId);
      if ("code" in parsed) {
        // Logged with what was asked for, quoted: a refusal is the line worth
        // having when something local starts probing what the broker will do.
        const action = isRecord(raw) ? String(raw["action"]) : "";
        const op = isRecord(raw) ? String(raw["remoteOp"]) : "";
        log.warn(`broker: refused action=${quote(action)} op=${quote(op)} id=${quote(id)} reason=${parsed.code}`);
        return await fail(id, parsed.code, parsed.message);
      }
      const { request } = parsed;
      if (request.action === "machines") await audit.machines(id);
      else await audit.request(id, request.remoteOp, request.deviceId, clientOf(request.payload));
      if (stopped) return await fail(id, "shutting_down", "the daemon is stopping");
      if (inFlight >= maxInFlight) return await fail(id, "busy", `${maxInFlight} brokered requests already in flight`);
      inFlight += 1;
      try {
        return await serve(request);
      } finally {
        inFlight -= 1;
      }
    } catch (err) {
      log.error(`broker: request ${quote(id)} crashed: ${String(err)}`);
      return brokerFail(id, "internal_error", String(err));
    }
  };

  return {
    handle,
    stop: (): void => {
      stopped = true;
      opts.relay.stop();
    },
  };
}
