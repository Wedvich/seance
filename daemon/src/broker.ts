import {
  APP_ID,
  isRecord,
  isTaskId,
  MACHINES_ID,
  parseTaskRef,
  parseTaskSpec,
  queuedTask,
  quote,
  RequestFailure,
  type DespawnRequest,
  type FailureReason,
  type SpawnClient,
  type SpawnRequest,
} from "@seance/shared";
import { appRelayClient, importAppKeys, LazyRelay, type AppKeys, type AppRelay } from "./app-relay.ts";
import { accountCaches } from "./account-cache.ts";
import { brokerAudit, enqueueAudit, type AuditSink, type EnqueueOutcome } from "./audit.ts";
import {
  BROKER_VERSION,
  brokerFail,
  brokerFrameId,
  brokerOk,
  isBrokerEnqueueClient,
  isBrokerOp,
  isBrokerSchedulerOp,
  type BrokerErrorCode,
  type BrokerReply,
  type BrokerRequest,
  type RelayFailureTarget,
} from "./broker-protocol.ts";
import type { Config } from "./config.ts";
import { isDespawnRequest, isSpawnRequest } from "./handlers.ts";
import { log } from "./log.ts";

/**
 * The daemon side of the fleet broker: a keyless `seanced mcp` or `seanced spawn
 * --auto` on this box asks for the registry, for one of three ops on one other
 * machine, or for the scheduler's enqueue, queue, cancel and account read, and
 * the daemon makes that app-role request itself with the key it already holds.
 *
 * Why a separate app-role connection: the daemon's own relay socket is
 * daemon-role — it registers, receives ops and answers them, and the relay never
 * pushes it the registry or routes its envelopes to another daemon. Reaching
 * another machine means being an app, so the broker is a fourth app-role client
 * beside the PWA, Raycast and `seanced mcp`, built over the shared one.
 *
 * What it is not: a crypto oracle, a relay forwarder or a key export. The peer
 * names an action and a deviceId; the daemon decides the address, builds the
 * payload from validated fields, seals with its own key and dials its own
 * configured relay. There is no frame that returns the key, seals or opens
 * arbitrary bytes, addresses `"machines"`, or overwrites a record: an enqueue is
 * a create at `expect: 0` of a task the daemon builds from a parsed spec, with
 * its own `createdAt`.
 *
 * Built only by a daemon whose key is service-delivered (`run-capabilities.ts`): elsewhere
 * `seanced mcp` reads the key itself, and the broker would add authority, not reach.
 */

/**
 * Generous for one human's Claude sessions; small enough that a runaway local
 * process cannot pile up spawns behind a slow relay. Counts every action but
 * `machines` and `fleet`: those are answered from the connection's cached
 * registry, and every tool call of a keyless peer opens with one, so slow
 * scheduler calls (a cancel waits up to 25 s) filling this pool must not turn the
 * next call's lease open into `busy`. They take no slot at all — not even while
 * parked on a cold dial (up to the connect timeout plus the registry settle),
 * which every waiter shares, and which ends them all together — since a slot
 * counted there would turn a burst of lease opens into `busy`. Once the
 * connection is up a read is a map lookup and one audit line.
 */
const MAX_IN_FLIGHT = 16;

export interface BrokerOpts {
  /** This daemon's own deviceId. A request aimed here belongs on the local op path, not a relay round trip back to itself. */
  readonly selfDeviceId: string;
  readonly relay: LazyRelay;
  readonly auditSink: AuditSink;
  readonly maxInFlight?: number;
  /** Stamps a brokered task's `createdAt`, so a peer cannot back- or forward-date one; tests pin it. */
  readonly now?: () => number;
}

export interface Broker {
  /** Never rejects: every failure, a crash included, is a structured reply the peer can render. */
  readonly handle: (raw: unknown) => Promise<BrokerReply>;
  /** Hangs up the app-role socket; in-flight requests fail, new ones are refused as `shutting_down`. */
  readonly stop: () => void;
}

/**
 * The broker's relay connection, over the PSK the daemon already resolved —
 * never a second store lookup: on a credential-delivered box nothing but this
 * process can read the key, and a second lookup would be a second chance to get
 * it wrong. Both keys derive here (`importAppKeys`), on the first dial, so the
 * account HMAC key exists only in a daemon that brokers. Lazy and idle-closing
 * like `seanced mcp`'s, so a box nobody brokers through holds no extra socket.
 */
export function brokerRelay(config: Pick<Config, "relayUrl" | "bearerToken">, psk: string): LazyRelay {
  let keys: Promise<AppKeys> | undefined;
  // A rejected derivation is not cached: the next dial tries again instead of failing the same way for good.
  const appKeys = (): Promise<AppKeys> => {
    keys ??= importAppKeys(psk).catch((err: unknown) => {
      keys = undefined;
      throw err;
    });
    return keys;
  };
  return new LazyRelay({
    create: async () => appRelayClient(config, await appKeys(), (line) => log.info(line)),
  });
}

type Parsed = { readonly request: BrokerRequest } | { readonly code: BrokerErrorCode; readonly message: string };

/**
 * Stamped by the broker, never copied from the peer, for `request` ops: a
 * same-uid process could otherwise make the target's audit line read as the
 * PWA. What reaches the target is always `client="mcp"`, as for a direct MCP
 * spawn. (A scheduler enqueue keeps the peer's `mcp` or `cli` instead — see
 * `parseSchedulerRequest`.)
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

/**
 * What a scheduler frame may carry. An enqueue's spec is parsed into a fresh
 * value of known fields and bounded as the leader's own parser bounds it; it may
 * not set `lineage` or `base` (neither client sends them), and its `client` is
 * `mcp` or `cli` — the peer's unverifiable claim, since the daemon cannot tell
 * the two apart, kept in the record and audited as `claimed_client`. Never
 * `pwa`, `raycast` or `scheduler`. `queue` and `accounts` take no payload, and
 * whatever else the frame carries is never forwarded.
 */
function parseSchedulerRequest(raw: Record<string, unknown>, id: string): Parsed {
  const schedulerOp = raw["schedulerOp"];
  if (!isBrokerSchedulerOp(schedulerOp)) {
    return { code: "op_not_allowed", message: `scheduler op ${quote(String(schedulerOp))} is not brokered` };
  }
  const head = { v: BROKER_VERSION, kind: "broker", id, action: "scheduler" } as const;
  if (schedulerOp === "queue" || schedulerOp === "accounts") return { request: { ...head, schedulerOp } };
  const { taskId } = raw;
  if (schedulerOp === "cancel") {
    const ref = parseTaskRef({ taskId });
    if (ref === null) return { code: "invalid_request", message: "taskId is not a task id" };
    return { request: { ...head, schedulerOp, taskId: ref.taskId } };
  }
  if (!isTaskId(taskId)) return { code: "invalid_request", message: "taskId is not a task id" };
  const spec = parseTaskSpec(raw["spec"]);
  if (spec === null) return { code: "invalid_request", message: "malformed task spec" };
  if (spec.lineage !== undefined || spec.base !== undefined) {
    return { code: "invalid_request", message: "lineage and base are not brokered" };
  }
  if (!isBrokerEnqueueClient(spec.client)) {
    return { code: "invalid_request", message: "a brokered task's client must be mcp or cli" };
  }
  return { request: { ...head, schedulerOp, taskId, spec } };
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
  if (action === "machines" || action === "fleet")
    return { request: { v: BROKER_VERSION, kind: "broker", id, action } };
  if (action === "scheduler") return parseSchedulerRequest(raw, id);
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
  const now = opts.now ?? Date.now;
  // One listing budget for every keyless process on the box: the relay allows each socket four a minute.
  const cacheOf = accountCaches();
  let inFlight = 0;
  let stopped = false;

  const fail = async (
    id: string,
    code: BrokerErrorCode,
    message: string,
    reason?: FailureReason,
    target?: RelayFailureTarget,
  ): Promise<BrokerReply> => {
    await audit.failed(id, code, reason);
    return brokerFail(id, code, message, reason, target);
  };

  /**
   * A relay-side failure as the peer can rebuild it. A stop mid-request fails it
   * as "dropped" — it was already on the wire, so the peer must hear that it may
   * have landed, not that it never left. The peer's side words the "may have landed".
   */
  const relayFailed = (id: string, err: unknown): Promise<BrokerReply> => {
    if (!(err instanceof RequestFailure)) throw err;
    if (stopped) return fail(id, "stopped_in_flight", "the daemon stopped while the request was out");
    // `daemon` is minted peer-side only; whatever this process's client blames, the wire carries machine or relay.
    return fail(id, "request_failed", err.message, err.reason, err.target === "relay" ? "relay" : "machine");
  };

  const serveScheduler = async (
    client: AppRelay,
    request: Extract<BrokerRequest, { readonly action: "scheduler" }>,
  ): Promise<BrokerReply> => {
    const { id } = request;
    try {
      if (request.schedulerOp === "enqueue") {
        const surface = request.spec.client;
        // Parsed already; this keeps the type honest without a cast.
        if (!isBrokerEnqueueClient(surface)) return await fail(id, "invalid_request", "client must be mcp or cli");
        // Built here, never taken from the peer: its id and spec, this daemon's clock.
        const task = queuedTask(request.spec, now(), request.taskId);
        const audited = enqueueAudit(opts.auditSink, "local-broker", surface);
        let reply: Awaited<ReturnType<AppRelay["createTask"]>>;
        try {
          reply = await client.createTask(task);
        } catch (err) {
          // A try that never left this daemon cannot have stored anything, so it is no line to audit (as `enqueueAuto`).
          if (!(err instanceof RequestFailure && err.reason === "disconnected")) {
            await audited(task, { kind: "unanswered" });
          }
          return await relayFailed(id, err);
        }
        const outcome: EnqueueOutcome =
          reply === null
            ? { kind: "unanswered" }
            : reply.ok
              ? { kind: "queued", landedEarlier: reply.landedEarlier }
              : { kind: "refused", code: reply.code };
        await audited(task, outcome);
        return brokerOk(id, reply);
      }
      const data =
        request.schedulerOp === "queue"
          ? await client.queue()
          : request.schedulerOp === "cancel"
            ? await client.cancel(request.taskId)
            : await cacheOf(client).read();
      await audit.ok(id);
      return brokerOk(id, data);
    } catch (err) {
      return relayFailed(id, err);
    }
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
      if (request.action === "fleet") {
        await audit.ok(id);
        const { machines, scheduler } = client.getState();
        return brokerOk(id, { machines, scheduler });
      }
      if (request.action === "scheduler") return await serveScheduler(client, request);
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
        return await relayFailed(id, err);
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
        const op = isRecord(raw) ? String(raw[action === "scheduler" ? "schedulerOp" : "remoteOp"]) : "";
        log.warn(`broker: refused action=${quote(action)} op=${quote(op)} id=${quote(id)} reason=${parsed.code}`);
        return await fail(id, parsed.code, parsed.message);
      }
      const { request } = parsed;
      if (request.action === "machines") await audit.machines(id);
      else if (request.action === "fleet") await audit.fleet(id);
      else if (request.action === "scheduler") {
        const task = request.schedulerOp === "enqueue" || request.schedulerOp === "cancel" ? request.taskId : undefined;
        await audit.scheduler(
          id,
          request.schedulerOp,
          task,
          request.schedulerOp === "enqueue" ? request.spec.client : undefined,
        );
      } else await audit.request(id, request.remoteOp, request.deviceId, clientOf(request.payload));
      if (stopped) return await fail(id, "shutting_down", "the daemon is stopping");
      // Reads take no slot (see MAX_IN_FLIGHT).
      if (request.action === "machines" || request.action === "fleet") return await serve(request);
      if (inFlight >= maxInFlight) {
        return await fail(id, "busy", `${maxInFlight} brokered requests already in flight`);
      }
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
