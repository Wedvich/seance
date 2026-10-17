import {
  APP_ID,
  DAEMON_ROLES,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISSES_TO_SWEEP,
  MACHINES_ID,
  SCHEDULER_ID,
  STATUS_MIN_INTERVAL_MS,
  STORE_TOMBSTONE_MS,
  quote,
  verifyRegister,
  type DaemonFrame,
  type DaemonRole,
  type Envelope,
  type RegistryEntry,
  type RegistryView,
  type RelayToAppFrame,
  type RelayToDaemonFrame,
  type SchedulerLeader,
  type StoreReplyFrame,
  type StoreRequestFrame,
  type UndeliverableCode,
} from "@seance/shared";
import { roleForPath, type Role } from "./auth.ts";
import type { Env } from "./env.ts";
import {
  holdsTerm,
  isCurrentTerm,
  knownRoles,
  LEADER_KEY,
  nextLeaderRecord,
  NO_LEADER,
  nominate,
  parseLeaders,
  type LeaderRecord,
  type LeaderSocket,
} from "./leadership.ts";
import { actOf, admitCreate, authorize, RelayStore, ruleFor, type CreateWindow, type WriteResult } from "./store.ts";
import { isStoreRequest, parseAppFrame, parseDaemonFrame } from "./wire.ts";

const ENTRY_PREFIX = "device:";

/**
 * One shape for every routing line. `iv` is the only per-message identifier a
 * blind relay can see — the request `id` is inside the ciphertext — so it is
 * what joins these lines to the daemon's and the app's, which log the `iv`
 * beside the plaintext `id` they alone can read.
 */
function wireLog(event: string, env: Envelope, extra = ""): void {
  console.log(`wire ${event} iv=${quote(env.iv)} to=${quote(env.to)} from=${quote(env.from)}${extra}`);
}

/**
 * A socket stays listed until its close handler runs, so writing to one that
 * has just gone throws — and a throw escaping `webSocketMessage` strands
 * whoever was waiting. Returns the error rather than swallowing it: a failure
 * that isn't that race (an oversized frame) must not go unlogged.
 */
function trySend(ws: WebSocket, text: string): string | null {
  try {
    ws.send(text);
    return null;
  } catch (err) {
    return String(err);
  }
}

function failSuffix(failures: readonly string[]): string {
  return failures.length === 0 ? "" : ` failed=${failures.length} err=${failures[0]}`;
}

/**
 * Four machines today. 32 leaves room for reinstalls — each one mints a new
 * deviceId — while keeping a bearer-token holder from growing storage without
 * bound. Reaching it is recoverable from the app: a retired machine's entry can
 * be forgotten.
 */
const MAX_DEVICES = 32;

/**
 * A daemon registers on connect and when its repo set changes (hourly scan at
 * most). Ten a minute is far above that and far below useful abuse. This
 * bounds writes per socket, which `MAX_DEVICES` does not: re-registering one
 * id is unbounded puts and a registry push to every app each time.
 */
const REGISTER_WINDOW_MS = 60_000;
const MAX_REGISTERS_PER_WINDOW = 10;

/**
 * Daemon pings are answered at the edge, so the object never sees them — but
 * each one stamps the socket's auto-response timestamp, which the sweep alarm
 * reads. The silence limit is derived from the shared beat: three missed
 * heartbeats is a dead peer, not a hiccup, and deriving it means slowing the
 * beat can never silently outpace the sweep. Env-overridable so tests need
 * not wait a minute.
 */
const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_SILENCE_LIMIT_MS = HEARTBEAT_MISSES_TO_SWEEP * HEARTBEAT_INTERVAL_MS;

/** Vars arrive as strings; anything unparsable falls back to the default. */
function msOverride(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Attached to every daemon socket at accept. Survives hibernation, which is
 * why routing needs no class fields: `getWebSockets()` plus storage are truth.
 * The register counter rides along for the same reason.
 */
interface SocketAttachment {
  /** Accept time, ms — the sweep's liveness floor until the first heartbeat lands. */
  readonly connectedAt: number;
  /** Present once the socket has registered. */
  readonly identity?: SocketIdentity;
  /**
   * The daemon's latest `status`, here rather than in storage: no write per
   * sample. When the socket goes, `#leftBy` keeps it in the entry with the
   * `lastSeen` put the relay makes anyway, for its accounts' quota — never as
   * pressure (DESIGN.md, Presence & identity). Bounded by
   * `STATUS_MAX_CT_LENGTH` so it and the identity fit the attachment's 2 KiB together.
   */
  readonly status?: SocketStatus;
  /**
   * Set when a register on another socket took this one's route. The entry is
   * the registering socket's from then on: this one's close or sweep writes
   * nothing back into it, and it keeps no status (`#leftBy`).
   */
  readonly superseded?: true;
}

/**
 * What an app socket carries: only the create floor's window, written on its
 * first create. On the attachment rather than a field so it survives hibernation.
 */
interface AppAttachment {
  readonly createWindow?: CreateWindow;
}

interface DaemonSocket {
  readonly ws: WebSocket;
  readonly attachment: SocketAttachment | null;
}

interface SocketStatus {
  readonly env: Envelope;
  /** Accept time, ms — the per-socket floor below counts from it. */
  readonly at: number;
}

interface SocketIdentity {
  readonly deviceId: string;
  /** Known roles a verified v2 register signed; absent on attachments from before roles existed. */
  readonly roles?: readonly DaemonRole[];
  /** Start of the current register-rate window, ms. */
  readonly windowStart: number;
  readonly registers: number;
}

/**
 * The one relay hub: routes opaque envelopes app↔daemon and persists the machine
 * registry. Blind by construction — it never holds the PSK, so `info` blobs and
 * op payloads are unreadable here.
 */
export class Hub implements DurableObject {
  readonly #ctx: DurableObjectState;
  readonly #sweepIntervalMs: number;
  readonly #silenceLimitMs: number;
  /** Who may be nominated. Parsed per wake: a secret change rolls a new version, so it cannot change under one. */
  readonly #leaders: ReadonlySet<string>;
  readonly #store: RelayStore;

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#sweepIntervalMs = msOverride(env.SWEEP_INTERVAL_MS) ?? SWEEP_INTERVAL_MS;
    this.#silenceLimitMs = msOverride(env.SWEEP_SILENCE_LIMIT_MS) ?? SWEEP_SILENCE_LIMIT_MS;
    const leaders = parseLeaders(env.SCHEDULER_LEADERS);
    this.#leaders = leaders.ids;
    this.#store = new RelayStore(ctx.storage, msOverride(env.STORE_TOMBSTONE_MS) ?? STORE_TOMBSTONE_MS);
    for (const entry of leaders.invalid) console.log(`SCHEDULER_LEADERS: ignored ${quote(entry)}, not a deviceId`);
    // Re-applied on every wake. Heartbeats are answered without waking the object;
    // only the sweep alarm reads their timestamps.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    const role = roleForPath(new URL(req.url).pathname);
    if (role === null) return new Response("not found", { status: 404 });

    const pair = new WebSocketPair();
    this.#ctx.acceptWebSocket(pair[1], [role]);
    if (role === "daemon") {
      pair[1].serializeAttachment({ connectedAt: Date.now() } satisfies SocketAttachment);
      await this.#armSweep();
    }
    // Presence needs no polling: the app gets the registry before its first send.
    if (role === "app") await this.#pushRegistry([pair[1]]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // The wire protocol is JSON text plus the bare strings "ping"/"pong", and
    // "ping" is answered by auto-response without reaching this handler.
    if (typeof message !== "string") return;
    if (this.#roleOf(ws) === "daemon") await this.#onDaemonMessage(ws, message);
    else await this.#onAppMessage(ws, message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.#onSocketGone(ws);
    // Complete the closing handshake; 1005/1006 are not valid to echo back.
    const echoable = code >= 1000 && code < 5000 && code !== 1005 && code !== 1006;
    ws.close(echoable ? code : 1000, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.#onSocketGone(ws);
  }

  /**
   * The 30s daemon heartbeat protects the daemon from a dead relay; this alarm
   * is the reverse. An abruptly slept machine sends no close frame, so its
   * socket stays in `getWebSockets()` — reading as online — until Cloudflare
   * notices the dead TCP peer, which is unbounded. Sweeping bounds it: silence
   * past the limit is closed and reported offline. Armed only while daemon
   * sockets exist, so an idle hub never wakes.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    const swept = new Map<WebSocket, number>();
    for (const ws of this.#ctx.getWebSockets("daemon")) {
      const lastAlive = this.#lastAliveOf(ws, now);
      if (now - lastAlive > this.#silenceLimitMs) swept.set(ws, lastAlive);
    }
    await Promise.all([...swept].map(([ws, lastAlive]) => this.#sweep(ws, lastAlive, now)));
    if (swept.size > 0) {
      await this.#renominate([...swept.keys()]);
      await this.#pushRegistry(undefined, [...swept.keys()]);
    }
    if (this.#ctx.getWebSockets("daemon").some((ws) => !swept.has(ws))) {
      await this.#ctx.storage.setAlarm(now + this.#sweepIntervalMs);
    }
  }

  async #armSweep(): Promise<void> {
    if ((await this.#ctx.storage.getAlarm()) === null) {
      await this.#ctx.storage.setAlarm(Date.now() + this.#sweepIntervalMs);
    }
  }

  /** Heartbeats are the liveness signal; routed traffic doesn't count and needn't — a live daemon always pings. */
  #lastAliveOf(ws: WebSocket, fallback: number): number {
    const pinged = this.#ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    return Math.max(pinged, attachment?.connectedAt ?? fallback);
  }

  async #sweep(ws: WebSocket, lastAlive: number, now: number): Promise<void> {
    const deviceId = this.#deviceIdOf(ws);
    console.log(`swept ${deviceId ?? "unregistered daemon"}: no heartbeat for ${now - lastAlive}ms`);
    ws.close(1000, "no heartbeat");
    if (deviceId === null) return;
    const key = ENTRY_PREFIX + deviceId;
    const entry = await this.#ctx.storage.get<RegistryEntry>(key);
    // Stamped with the last heartbeat, not sweep time: the machine has been gone since then.
    const left = entry === undefined ? null : this.#leftBy(ws, entry, lastAlive);
    if (left !== null) await this.#put(key, left);
  }

  #roleOf(ws: WebSocket): Role {
    return this.#ctx.getTags(ws).includes("daemon") ? "daemon" : "app";
  }

  #deviceIdOf(ws: WebSocket): string | null {
    // An app socket's attachment is an `AppAttachment`, never read as a `SocketAttachment`.
    if (this.#roleOf(ws) !== "daemon") return null;
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    return attachment?.identity?.deviceId ?? null;
  }

  async #onDaemonMessage(ws: WebSocket, text: string): Promise<void> {
    const frame = parseDaemonFrame(text);
    if (frame === null) {
      console.log("wire dropped reason=malformed-daemon-frame");
      return;
    }
    // Before the register and registration checks: reads are anyone's, and an
    // unregistered socket's write fails `holdsTerm` (no identity) and is
    // answered `not_leader` rather than dropped. A put's `env.from` is not
    // compared with the socket's id: the relay is blind, and the seal's
    // addressing is the clients' to decide.
    if (frame.t === "store-rejected") {
      this.#refuseStore(ws, "daemon", frame.id, frame.t, undefined, frame.code);
      return;
    }
    if (isStoreRequest(frame)) {
      await this.#onStoreFrame(ws, "daemon", frame);
      return;
    }
    if (frame.t === "register") {
      await this.#register(ws, frame);
      return;
    }
    const deviceId = this.#deviceIdOf(ws);
    if (deviceId === null) {
      console.log("wire dropped reason=unregistered-daemon");
      return;
    }
    if (frame.env.from !== deviceId) {
      console.log(
        `wire dropped iv=${quote(frame.env.iv)} from=${quote(frame.env.from)} ` +
          `socket=${quote(deviceId)} reason=from-mismatch`,
      );
      return;
    }
    if (frame.t === "status") {
      this.#status(ws, deviceId, frame.env);
      return;
    }
    if (frame.t === "lead-proof") {
      await this.#leadProof(ws, frame.term, frame.env);
      return;
    }
    await this.#route(frame.env, ws, "daemon");
  }

  /**
   * Latest-wins on the socket's attachment, then one small frame to every app.
   * Floored per socket as `register` is rate-limited, and for the same reason:
   * the attachment write and the fan-out are what a sender could otherwise make
   * the hub pay for without bound. A frame under the floor is dropped, not
   * closed — a daemon re-sending after a re-register is not misbehaving. The
   * relay stays blind: it holds ciphertext and routing only, as with `info`.
   */
  #status(ws: WebSocket, deviceId: string, env: Envelope): void {
    if (env.to !== APP_ID) {
      wireLog("dropped", env, " reason=status-not-app");
      return;
    }
    const now = Date.now();
    const attachment = (ws.deserializeAttachment() ?? { connectedAt: now }) as SocketAttachment;
    if (attachment.superseded === true) {
      wireLog("dropped", env, " reason=status-superseded");
      return;
    }
    if (attachment.status !== undefined && now - attachment.status.at < STATUS_MIN_INTERVAL_MS) {
      wireLog("dropped", env, " reason=status-rate");
      return;
    }
    ws.serializeAttachment({ ...attachment, status: { env, at: now } } satisfies SocketAttachment);
    const frame: RelayToAppFrame = { t: "status", deviceId, env };
    const text = JSON.stringify(frame);
    const failures: string[] = [];
    for (const app of this.#ctx.getWebSockets("app")) {
      const err = trySend(app, text);
      if (err !== null) failures.push(err);
    }
    // No line per accepted beat: with an app count on it, every 30s per
    // machine, the logs would be a timeline of when an app was open — the
    // activity record the blind relay exists not to keep (DESIGN.md, threat
    // model item 3). Failures alone carry no such clock.
    if (failures.length > 0) wireLog("status", env, failSuffix(failures));
  }

  /**
   * Keeps the nominee's sealed answer to `lead` beside the record, for apps to
   * check (DESIGN.md, Scheduler, "Leadership"). The relay cannot read it, so
   * what it checks is only what it can: the frame comes from the leader's own
   * socket under the current term. The first one per term is kept — one write
   * and one push per term, however often a socket sends — and a later term
   * starts without one, since `#renominate` writes a fresh record.
   */
  async #leadProof(ws: WebSocket, term: number, env: Envelope): Promise<void> {
    if (env.to !== APP_ID) {
      wireLog("dropped", env, " reason=lead-proof-not-app");
      return;
    }
    const record = await this.#leaderRecord();
    if (!holdsTerm(record, term, this.#leaderSocketOf(ws))) {
      wireLog("dropped", env, ` reason=lead-proof-not-leader term=${term}`);
      return;
    }
    if (record.proof !== undefined) {
      wireLog("dropped", env, ` reason=lead-proof-held term=${term}`);
      return;
    }
    try {
      await this.#ctx.storage.put(LEADER_KEY, { ...record, proof: env } satisfies LeaderRecord);
    } catch (err) {
      console.log(`failed to persist ${LEADER_KEY}: ${String(err)}`);
      return;
    }
    await this.#pushRegistry();
  }

  async #onAppMessage(ws: WebSocket, text: string): Promise<void> {
    const frame = parseAppFrame(text);
    if (frame === null) {
      console.log("wire dropped reason=malformed-app-frame");
      return;
    }
    if (frame.t === "store-rejected") {
      this.#refuseStore(ws, "app", frame.id, frame.t, undefined, frame.code);
      return;
    }
    if (isStoreRequest(frame)) {
      await this.#onStoreFrame(ws, "app", frame);
      return;
    }
    if (frame.t === "forget") {
      await this.#forget(ws, frame.deviceId);
      return;
    }
    if (frame.env.from === SCHEDULER_ID) {
      if (!(await this.#isCurrentTerm(frame.term))) {
        const notice: RelayToAppFrame = { t: "undeliverable", to: frame.env.to, iv: frame.env.iv, code: "not_leader" };
        const err = trySend(ws, JSON.stringify(notice));
        wireLog(err === null ? "undeliverable" : "dropped", frame.env, ` code=not_leader term=${frame.term ?? "none"}`);
        return;
      }
    } else if (frame.env.from !== APP_ID) {
      console.log(`wire dropped iv=${quote(frame.env.iv)} from=${quote(frame.env.from)} reason=not-app-id`);
      return;
    }
    await this.#route(frame.env, ws, "app");
  }

  /**
   * Deletes a registry entry. Authorized by the bearer token alone, which is
   * sound because there is nothing here to destroy: the entry is derived state
   * — the machine re-registers on its next connect and rebuilds it — and a
   * token holder can already overwrite any entry's blob by registering over its
   * id. Refused for a connected machine, the one thing a blind relay can check:
   * it would come straight back and read as a broken button.
   *
   * Unbounded calls need no rate limiter either. An unknown id costs one read
   * and pushes nothing, and the deletes that do land are bounded by the
   * MAX_DEVICES entries that can exist — unlike a register, which can write the
   * same id forever.
   */
  async #forget(ws: WebSocket, deviceId: string): Promise<void> {
    if (this.#liveSockets([]).has(deviceId)) {
      const refusal: RelayToAppFrame = { t: "forget-refused", deviceId, code: "connected" };
      ws.send(JSON.stringify(refusal));
      console.log(`refused forget ${deviceId}: connected`);
      return;
    }
    const key = ENTRY_PREFIX + deviceId;
    if ((await this.#ctx.storage.get<RegistryEntry>(key)) === undefined) {
      // Idempotent, and silent on the wire: gone is what the caller asked for.
      console.log(`forget ${deviceId}: not in the registry`);
      return;
    }
    try {
      await this.#ctx.storage.delete(key);
    } catch (err) {
      // Same shape as a failed put: the entry stays, the app's next push shows it.
      console.log(`failed to delete ${key}: ${String(err)}`);
      return;
    }
    console.log(`forgot ${deviceId}`);
    await this.#pushRegistry();
  }

  /**
   * The refusals here make the bearer token's blast radius finite. Neither cap
   * defends *against* a token holder — rotating the token does — they only keep
   * what a holder can cost from being unbounded.
   */
  async #register(ws: WebSocket, frame: Extract<DaemonFrame, { t: "register" }>): Promise<void> {
    const { deviceId, info } = frame;
    const now = Date.now();
    const attachment = (ws.deserializeAttachment() ?? { connectedAt: now }) as SocketAttachment;
    const prior = attachment.identity;
    const rate =
      prior === undefined || now - prior.windowStart >= REGISTER_WINDOW_MS
        ? { windowStart: now, registers: 1 }
        : { windowStart: prior.windowStart, registers: prior.registers + 1 };
    if (rate.registers > MAX_REGISTERS_PER_WINDOW) {
      // The attachment is deliberately left untouched: the window has to expire
      // on its own clock, so refusing cannot hand the caller a way to reset it.
      console.log(`refused register from ${deviceId}: over ${MAX_REGISTERS_PER_WINDOW} per window`);
      return;
    }

    // Behind the rate limit, so a token holder pays for at most ten verifies a
    // minute per socket. The id is the hash of the key and the signature proves
    // the key, so passing this is proof the sender is the machine the id names —
    // the one thing a blind relay can know about a register.
    const verdict = await verifyRegister(
      { deviceId, publicKey: frame.key, ts: frame.ts, sig: frame.sig, roles: frame.roles },
      now,
    );
    if (verdict !== "ok") {
      console.log(`refused register from ${deviceId}: ${verdict}`);
      // Closed, not left open: a daemon re-registers on connect only, and the
      // reason is the one word it gets about why its identity was not accepted.
      ws.close(1000, "register unverified");
      return;
    }

    const key = ENTRY_PREFIX + deviceId;
    const known = (await this.#ctx.storage.get<RegistryEntry>(key)) !== undefined;
    if (!known && (await this.#entryCount()) >= MAX_DEVICES) {
      // Only unknown ids are turned away, so a full registry locks out machines
      // you have not added yet and never knocks a known one offline.
      console.log(`refused register from ${deviceId}: registry full at ${MAX_DEVICES}`);
      return;
    }

    // A verified register is the machine itself, so it always takes the route:
    // whatever else holds the id is a zombie this daemon left behind (a network
    // change, a sleep the relay has not swept yet), never a stranger, since a
    // stranger cannot sign for the id. Two open sockets for one machine would
    // deliver a spawn twice, so the older one loses. Attaching first keeps the
    // loser's close handler from reporting the machine as disconnected.
    // The snapshot goes too: it indexes the blob this register just replaced,
    // so every reader would hide it anyway — and with it goes the floor, so
    // the status a daemon sends right after registering is let through.
    ws.serializeAttachment({
      connectedAt: attachment.connectedAt,
      identity: { deviceId, roles: knownRoles(frame.roles ?? []), ...rate },
    } satisfies SocketAttachment);
    for (const other of this.#ctx.getWebSockets("daemon")) {
      if (other === ws || this.#deviceIdOf(other) !== deviceId) continue;
      // Marked before the close: a zombie (a slept machine) never completes the
      // handshake, so its close handler, or the sweep, can run long after this
      // register's successor has itself come and gone.
      const { status: _dropped, ...loser } = other.deserializeAttachment() as SocketAttachment;
      other.serializeAttachment({ ...loser, superseded: true } satisfies SocketAttachment);
      other.close(1000, "superseded");
    }
    // Ahead of the put: the socket routes from here on, so it can lead from here on.
    await this.#renominate([]);
    if (!(await this.#put(key, { deviceId, info, lastSeen: now }))) return;
    // The one hint an operator gets for "auto is unavailable": a capable daemon the list leaves out.
    const unlisted = frame.roles?.includes(DAEMON_ROLES.scheduler) === true && !this.#leaders.has(deviceId);
    console.log(`registered ${deviceId}${unlisted ? " (scheduler-capable, not in SCHEDULER_LEADERS)" : ""}`);
    await this.#pushRegistry();
  }

  async #entryCount(): Promise<number> {
    return (await this.#ctx.storage.list<RegistryEntry>({ prefix: ENTRY_PREFIX })).size;
  }

  /** A failed put must not take the socket down with it — the daemon re-registers on reconnect. */
  async #put(key: string, entry: RegistryEntry): Promise<boolean> {
    try {
      await this.#ctx.storage.put(key, entry);
      return true;
    } catch (err) {
      console.log(`failed to persist ${key}: ${String(err)}`);
      return false;
    }
  }

  /**
   * Answers one store frame. The order of checks is the contract: rule
   * (`forbidden` / `not_leader`), then tombstone and version, then the app
   * create floor, then the caps, then the write. The floor sits behind the
   * version check so an enqueue retried after it landed reads `version_conflict`,
   * not `rate_limited`, and only creates that land count toward it.
   *
   * No line for an accepted read or write — that would be the queue's activity
   * timeline — and never an `env`, a `ct` or its length.
   *
   * Two causes get no reply. A storage throw: a read's escapes
   * `webSocketMessage`, as does `#holdsTerm`'s (outside the try); a put's or
   * delete's is logged below, and a rejected write does not prove it never
   * committed. And a reply the socket refused (`#storeReply` logs it). The
   * client's `STORE_TIMEOUT_MS` reads either as indeterminate (DESIGN.md, "The store").
   */
  async #onStoreFrame(ws: WebSocket, leg: Role, frame: StoreRequestFrame): Promise<void> {
    if (frame.t === "store-list") {
      this.#storeReply(ws, { t: "store-listed", re: frame.id, records: await this.#store.list(frame.prefix) });
      return;
    }
    if (frame.t === "store-get") {
      this.#storeReply(ws, { t: "store-record", re: frame.id, record: await this.#store.get(frame.key) });
      return;
    }

    const rule = ruleFor(frame.key);
    if (rule === null) {
      this.#refuseStore(ws, leg, frame.id, frame.t, frame.key, "invalid_request");
      return;
    }
    const act = actOf(frame);
    const now = Date.now();
    const leader = leg === "daemon" ? await this.#holdsTerm(frame.term, ws) : false;
    const refusal = authorize(rule, act, leg, leader);
    if (refusal !== null) {
      this.#refuseStore(ws, leg, frame.id, frame.t, frame.key, refusal);
      return;
    }

    // Tentative: only a create that lands is written back to the attachment, so
    // a refusal of any kind leaves the window as it was. No floor on the daemon
    // leg: every write there is term-fenced, so only the leader writes, bounded
    // by `MAX_TASKS`. The attachment is an `AppAttachment` only on an app
    // socket, so it is read only when the floor applies.
    const floored = leg === "app" && act === "create";
    const attachment = floored ? (ws.deserializeAttachment() as AppAttachment | null) : null;
    const window = floored ? admitCreate(attachment?.createWindow, now) : null;
    let result: WriteResult;
    try {
      result =
        frame.t === "store-put"
          ? await this.#store.put(frame.key, frame.expect, frame.env, now, !floored || window !== null)
          : await this.#store.delete(frame.key, frame.expect, now);
    } catch (err) {
      // No reply: the client's `STORE_TIMEOUT_MS` reads it as indeterminate.
      console.log(`store ${frame.t} failed key=${quote(frame.key)} err=${String(err)}`);
      return;
    }
    if (!result.ok) {
      this.#refuseStore(ws, leg, frame.id, frame.t, frame.key, result.code);
      return;
    }
    if (window !== null) ws.serializeAttachment({ ...attachment, createWindow: window } satisfies AppAttachment);
    this.#storeReply(ws, { t: "store-written", re: frame.id, version: result.version });
    if (leg === "app") await this.#nudgeLeader(frame.key, frame.t === "store-put" ? result.version : 0);
  }

  #refuseStore(ws: WebSocket, leg: Role, re: string, t: string, key: string | undefined, code: string): void {
    // No key on a conflict: it is the normal answer to a retried enqueue and to
    // leader races, and a key with a time would link task ids to retries.
    const keyField = key === undefined || code === "version_conflict" ? "" : ` key=${quote(key)}`;
    console.log(`store refused t=${t}${keyField} leg=${leg} code=${code}`);
    this.#storeReply(ws, { t: "store-refused", re, code });
  }

  #storeReply(ws: WebSocket, frame: StoreReplyFrame): void {
    const err = trySend(ws, JSON.stringify(frame));
    if (err !== null) console.log(`store reply not sent t=${frame.t} err=${err}`);
  }

  /**
   * Tells the leader's daemon socket — the one its term was issued to — that an
   * app wrote a key. Daemon-leg writes are the leader's own, so any app-leg write
   * is one the leader did not make. With no such socket nothing is sent: the next
   * leader reconciles from `store-list` at takeover.
   */
  async #nudgeLeader(key: string, version: number): Promise<void> {
    const record = await this.#leaderRecord();
    if (record.deviceId === null) return;
    const leader = this.#daemonsNewestFirst([]).find(
      ({ attachment }) =>
        attachment?.identity?.deviceId === record.deviceId && attachment.connectedAt === record.connectedAt,
    );
    if (leader === undefined) return;
    const err = trySend(leader.ws, JSON.stringify({ t: "store-changed", key, version } satisfies RelayToDaemonFrame));
    if (err !== null) console.log(`store-changed not sent: ${err}`);
  }

  async #route(env: Envelope, sender: WebSocket, senderRole: Role): Promise<void> {
    if (env.to === APP_ID) {
      // Phone and laptop tabs share one wire address; both get it and drop what
      // matches no pending `re`.
      const frame: RelayToAppFrame = { t: "msg", env };
      const text = JSON.stringify(frame);
      const apps = this.#ctx.getWebSockets("app");
      // Per-socket: one dead tab must not swallow the rest of the tail.
      let fanned = 0;
      const failures: string[] = [];
      for (const app of apps) {
        const err = trySend(app, text);
        if (err === null) fanned += 1;
        else failures.push(err);
      }
      // Zero apps is the lost-reply case DESIGN.md reconciles from the session list.
      wireLog("fanout", env, ` apps=${fanned}${failSuffix(failures)}`);
      return;
    }

    if (env.to === MACHINES_ID) {
      // Fan to every registered daemon socket except the sender: echoing back
      // would make each announce a self-nudge. Exclusion is by deviceId, not
      // socket identity, so a socket superseded mid-flight cannot deliver the
      // machine its own announce. Fire-and-forget by design — no undeliverable
      // notice, because nothing correlates a broadcast and offline machines
      // converge from their own register-time self-check.
      const frame: RelayToDaemonFrame = { t: "msg", env };
      const text = JSON.stringify(frame);
      let fanned = 0;
      const failures: string[] = [];
      for (const daemon of this.#ctx.getWebSockets("daemon")) {
        const deviceId = this.#deviceIdOf(daemon);
        if (deviceId === null || deviceId === env.from) continue;
        // Per-socket: the sweep and `superseded` both leave one briefly listed,
        // and one dead socket must not swallow the whole tail.
        const err = trySend(daemon, text);
        if (err === null) fanned += 1;
        else failures.push(err);
      }
      wireLog("fanout", env, ` daemons=${fanned}${failSuffix(failures)}`);
      return;
    }

    // The scheduler address resolves to whoever leads now; the envelope keeps
    // `to: "scheduler"`, which the AAD binds.
    const addressee = env.to === SCHEDULER_ID ? (await this.#leaderRecord()).deviceId : env.to;
    // Newest first: a re-registering daemon briefly leaves two sockets on one
    // deviceId — `superseded` closes the loser, but it stays listed until its
    // close handler runs — and picking the first match can pick the dead one
    // while the live socket sits behind it.
    const targets =
      addressee === null
        ? []
        : this.#daemonsNewestFirst([]).filter(({ attachment }) => attachment?.identity?.deviceId === addressee);
    // A daemon's traffic to the scheduler is mostly its sessions' busy/idle
    // events, so a line per delivery would be a timeline of when each machine
    // was working — the activity record the blind relay keeps out of its logs
    // (DESIGN.md, threat model item 3), as `#status` does for beats. Only a
    // failed send is logged; with no leader the drop is the expected steady
    // state, and logging it would be the same timeline.
    const quiet = senderRole === "daemon" && env.to === SCHEDULER_ID;
    const text = JSON.stringify({ t: "msg", env } satisfies RelayToDaemonFrame);
    for (const { ws: target } of targets) {
      // A failure falls through to the next candidate and, past the last, to
      // the notice below — throwing here would strand the app, which is waiting
      // for one or the other. Logged with the error because that fallthrough
      // reports `offline`, which the app promotes to *proven* offline.
      const err = trySend(target, text);
      if (err === null) {
        if (!quiet) wireLog("deliver", env, ` role=${senderRole}`);
        return;
      }
      wireLog("dropped", env, ` reason=send-failed err=${err}`);
    }

    // Only an app can act on the notice, and `env.to === APP_ID` was handled
    // above — so reaching here means a daemon addressed a device that is neither
    // the app nor currently connected. Nobody is waiting for it either way.
    if (senderRole !== "app") {
      if (!quiet || targets.length > 0) wireLog("dropped", env, " reason=unroutable");
      return;
    }
    // No leader is `offline`, never `unknown`: the address is real, and one will be back.
    const known =
      env.to === SCHEDULER_ID || (await this.#ctx.storage.get<RegistryEntry>(ENTRY_PREFIX + env.to)) !== undefined;
    const code: UndeliverableCode = known ? "offline" : "unknown";
    // Correlated by `iv`: the request `id` is inside the ciphertext.
    const notice: RelayToAppFrame = { t: "undeliverable", to: env.to, iv: env.iv, code };
    // The `await` above yields the isolate — the window the app tab vanishes in.
    const noticeErr = trySend(sender, JSON.stringify(notice));
    if (noticeErr !== null) wireLog("dropped", env, ` reason=notice-send-failed err=${noticeErr}`);
    else wireLog("undeliverable", env, ` code=${code}`);
  }

  /** Only daemon sockets carry an identity, so an app socket closing is a no-op. */
  async #onSocketGone(ws: WebSocket): Promise<void> {
    const deviceId = this.#deviceIdOf(ws);
    if (deviceId === null) return;
    const key = ENTRY_PREFIX + deviceId;
    const entry = await this.#ctx.storage.get<RegistryEntry>(key);
    const left = entry === undefined ? null : this.#leftBy(ws, entry, Date.now());
    if (left !== null) await this.#put(key, left);
    await this.#renominate([ws]);
    await this.#pushRegistry(undefined, [ws]);
  }

  /**
   * The entry a departing socket leaves: its last `status` kept, or none — a
   * register cleared any older one, since it indexes the blob that register
   * replaced. Only the verified socket's own sealed env can get here, so it
   * needs no signature. Null for a superseded socket, which writes nothing: the
   * entry is its successor's, and anything written back — its snapshot, or the
   * absence of one — would undo the register's clear or the status the
   * successor's own close kept. That holds whichever closes first, which
   * newest-socket order cannot say once the successor has gone.
   */
  #leftBy(ws: WebSocket, entry: RegistryEntry, lastSeen: number): RegistryEntry | null {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.superseded === true) return null;
    const { status: _kept, ...rest } = entry;
    const status = attachment?.status?.env;
    return { ...rest, lastSeen, ...(status === undefined ? {} : { status }) };
  }

  /**
   * `exclude` holds sockets whose loss triggered the push — they may still
   * appear in `getWebSockets()` while their close handlers run, and counting
   * them would report a machine online moments after it went away.
   */
  async #pushRegistry(targets?: readonly WebSocket[], exclude: readonly WebSocket[] = []): Promise<void> {
    const apps = targets ?? this.#ctx.getWebSockets("app");
    if (apps.length === 0) return;
    // Once per push: every attachment carries a ~1 KiB `status` to decode.
    const live = this.#liveSockets(exclude);
    const frame: RelayToAppFrame = {
      t: "registry",
      entries: await this.#views(live),
      scheduler: await this.#schedulerView(live),
    };
    const text = JSON.stringify(frame);
    // Per-socket: a throw would escape the caller (`#register`, `alarm`,
    // `webSocketClose`) and starve every app behind it of its only presence signal.
    for (const app of apps) {
      const err = trySend(app, text);
      if (err !== null) console.log(`registry push failed: ${err}`);
    }
  }

  async #views(live: ReadonlyMap<string, SocketAttachment>): Promise<RegistryView[]> {
    const stored = await this.#ctx.storage.list<RegistryEntry>({ prefix: ENTRY_PREFIX });
    const views: RegistryView[] = [];
    // Spelled out rather than spread: this is the wire projection of an entry.
    for (const entry of stored.values()) {
      const socket = live.get(entry.deviceId);
      // A live socket's, else the one its last socket left. `connected` is
      // what tells readers which: a kept one is quota, never pressure.
      const status = socket === undefined ? entry.status : socket.status?.env;
      views.push({
        deviceId: entry.deviceId,
        info: entry.info,
        lastSeen: entry.lastSeen,
        connected: socket !== undefined,
        ...(status === undefined ? {} : { status }),
      });
    }
    return views;
  }

  /**
   * Derived at read time and never persisted, so an eviction cannot leave a
   * stale `true` on disk. Newest socket per id, as `#route` picks: across a
   * re-register the superseded socket stays listed until its close handler
   * runs, and its snapshot belongs to the connection that is ending.
   */
  #liveSockets(exclude: readonly WebSocket[]): ReadonlyMap<string, SocketAttachment> {
    const live = new Map<string, SocketAttachment>();
    for (const { attachment } of this.#daemonsNewestFirst(exclude)) {
      if (attachment === null || attachment.identity === undefined) continue;
      const { deviceId } = attachment.identity;
      if (!live.has(deviceId)) live.set(deviceId, attachment);
    }
    return live;
  }

  async #leaderRecord(): Promise<LeaderRecord> {
    return (await this.#ctx.storage.get<LeaderRecord>(LEADER_KEY)) ?? NO_LEADER;
  }

  /**
   * Re-runs nomination (`leadership.ts`) over the live sockets and applies the
   * answer. Writes only on a change — a new leader, none, or the leader's own
   * new socket — so a close or sweep that moves nothing costs a read. Every
   * change bumps the term, so whatever the previous holder still has in flight
   * is refused `not_leader`. `exclude` as for `#pushRegistry`.
   */
  async #renominate(exclude: readonly WebSocket[]): Promise<void> {
    const live = this.#liveSockets(exclude);
    const record = await this.#leaderRecord();
    const candidates = [...live].map(([deviceId, attachment]) => ({
      deviceId,
      roles: attachment.identity?.roles ?? [],
      connectedAt: attachment.connectedAt,
    }));
    const next = nominate(candidates, record.deviceId, this.#leaders);
    const connectedAt = next === null ? null : (live.get(next)?.connectedAt ?? null);
    const updated = nextLeaderRecord(record, next, connectedAt);
    if (updated === null) return;
    try {
      await this.#ctx.storage.put(LEADER_KEY, updated);
    } catch (err) {
      // Nothing sent: the next connect, close or sweep retries from the old record.
      console.log(`failed to persist ${LEADER_KEY}: ${String(err)}`);
      return;
    }
    console.log(`scheduler term=${updated.term} leader=${next ?? "none"}`);
    const socketOf = (deviceId: string): WebSocket | undefined =>
      this.#daemonsNewestFirst(exclude).find(({ attachment }) => attachment?.identity?.deviceId === deviceId)?.ws;
    if (next !== null) this.#tell(socketOf(next), { t: "lead", term: updated.term });
    // Same id on a new socket: the old one is closing as superseded and needs no word.
    if (record.deviceId !== null && record.deviceId !== next) this.#tell(socketOf(record.deviceId), { t: "follow" });
  }

  #tell(ws: WebSocket | undefined, frame: RelayToDaemonFrame): void {
    if (ws === undefined) return;
    const err = trySend(ws, JSON.stringify(frame));
    // A socket that just went: its close handler re-nominates.
    if (err !== null) console.log(`scheduler ${frame.t} not sent: ${err}`);
  }

  /** Only a connected leader is one: a record a relay restart left behind names nobody routable. */
  async #schedulerView(live: ReadonlyMap<string, SocketAttachment>): Promise<SchedulerLeader | null> {
    const { deviceId, term, proof } = await this.#leaderRecord();
    if (deviceId === null || !live.has(deviceId)) return null;
    return { deviceId, term, ...(proof === undefined ? {} : { proof }) };
  }

  /**
   * The fence on an envelope sent as the scheduler on the leader's app-role leg.
   * Term only (`isCurrentTerm`): an app socket has no identity to check.
   */
  async #isCurrentTerm(term: number | undefined): Promise<boolean> {
    const record = await this.#leaderRecord();
    return isCurrentTerm(record, term, record.deviceId !== null && this.#liveSockets([]).has(record.deviceId));
  }

  /** The daemon-leg fence: the term and the socket it was issued to (`holdsTerm`). */
  async #holdsTerm(term: number | undefined, ws: WebSocket): Promise<boolean> {
    return holdsTerm(await this.#leaderRecord(), term, this.#leaderSocketOf(ws));
  }

  /** Null for anything that cannot hold a term: an app socket, a superseded or unregistered daemon. */
  #leaderSocketOf(ws: WebSocket): LeaderSocket | null {
    if (this.#roleOf(ws) !== "daemon") return null;
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment === null || attachment.superseded === true) return null;
    const deviceId = attachment.identity?.deviceId;
    return deviceId === undefined ? null : { deviceId, connectedAt: attachment.connectedAt };
  }

  /**
   * Daemon sockets by accept time, newest first — the order that breaks a tie
   * between two sockets on one deviceId across a reconnect. Each attachment is
   * deserialized once, up front: it carries the ~1 KiB `status`, and a sort
   * comparator would decode it on every comparison. A superseded socket is no
   * route, presence or candidate, even once its successor has gone: it is
   * listed only until a zombie's close or sweep runs.
   */
  #daemonsNewestFirst(exclude: readonly WebSocket[]): readonly DaemonSocket[] {
    return this.#ctx
      .getWebSockets("daemon")
      .filter((ws) => !exclude.includes(ws))
      .map((ws) => ({ ws, attachment: ws.deserializeAttachment() as SocketAttachment | null }))
      .filter(({ attachment }) => attachment?.superseded !== true)
      .toSorted((a, b) => (b.attachment?.connectedAt ?? 0) - (a.attachment?.connectedAt ?? 0));
  }
}
