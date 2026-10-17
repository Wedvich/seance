import {
  APP_ID,
  DAEMON_ROLES,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISSES_TO_SWEEP,
  MACHINES_ID,
  SCHEDULER_ID,
  STATUS_MIN_INTERVAL_MS,
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
  type UndeliverableCode,
} from "@seance/shared";
import { roleForPath, type Role } from "./auth.ts";
import type { Env } from "./env.ts";
import { knownRoles, nominate, parseLeaders } from "./leadership.ts";
import { parseAppFrame, parseDaemonFrame } from "./wire.ts";

const ENTRY_PREFIX = "device:";

/**
 * The scheduler leader record. In storage rather than on an attachment because
 * `term` must outlive every socket — it is monotonic for the life of the DO, so
 * a term a demoted leader holds can never come round again.
 */
const LEADER_KEY = "scheduler:term";

interface LeaderRecord {
  readonly term: number;
  readonly deviceId: string | null;
  /** The leader socket's accept time: a new socket under the same id is a new term. */
  readonly connectedAt: number | null;
  /** The first `lead-proof` that socket sent under this term; a new term starts without one. */
  readonly proof?: Envelope;
}

const NO_LEADER: LeaderRecord = { term: 0, deviceId: null, connectedAt: null };

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

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#sweepIntervalMs = msOverride(env.SWEEP_INTERVAL_MS) ?? SWEEP_INTERVAL_MS;
    this.#silenceLimitMs = msOverride(env.SWEEP_SILENCE_LIMIT_MS) ?? SWEEP_SILENCE_LIMIT_MS;
    const leaders = parseLeaders(env.SCHEDULER_LEADERS);
    this.#leaders = leaders.ids;
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
    if (entry !== undefined) await this.#put(key, this.#leftBy(ws, entry, lastAlive));
  }

  #roleOf(ws: WebSocket): Role {
    return this.#ctx.getTags(ws).includes("daemon") ? "daemon" : "app";
  }

  #deviceIdOf(ws: WebSocket): string | null {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    return attachment?.identity?.deviceId ?? null;
  }

  async #onDaemonMessage(ws: WebSocket, text: string): Promise<void> {
    const frame = parseDaemonFrame(text);
    if (frame === null) {
      console.log("wire dropped reason=malformed-daemon-frame");
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
      await this.#leadProof(ws, deviceId, frame.term, frame.env);
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
  async #leadProof(ws: WebSocket, deviceId: string, term: number, env: Envelope): Promise<void> {
    if (env.to !== APP_ID) {
      wireLog("dropped", env, " reason=lead-proof-not-app");
      return;
    }
    const record = await this.#leaderRecord();
    const socketAt = (ws.deserializeAttachment() as SocketAttachment | null)?.connectedAt;
    if (record.deviceId !== deviceId || record.connectedAt !== socketAt || record.term !== term) {
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
    if (frame.t === "forget") {
      await this.#forget(ws, frame.deviceId);
      return;
    }
    if (frame.env.from === SCHEDULER_ID) {
      if (!(await this.#holdsTerm(frame.term))) {
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
      if (other !== ws && this.#deviceIdOf(other) === deviceId) other.close(1000, "superseded");
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
    const text = JSON.stringify({ t: "msg", env } satisfies RelayToDaemonFrame);
    for (const { ws: target } of targets) {
      // A failure falls through to the next candidate and, past the last, to
      // the notice below — throwing here would strand the app, which is waiting
      // for one or the other. Logged with the error because that fallthrough
      // reports `offline`, which the app promotes to *proven* offline.
      const err = trySend(target, text);
      if (err === null) {
        wireLog("deliver", env, ` role=${senderRole}`);
        return;
      }
      wireLog("dropped", env, ` reason=send-failed err=${err}`);
    }

    // Only an app can act on the notice, and `env.to === APP_ID` was handled
    // above — so reaching here means a daemon addressed a device that is neither
    // the app nor currently connected. Nobody is waiting for it either way.
    if (senderRole !== "app") {
      wireLog("dropped", env, " reason=unroutable");
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
    if (entry !== undefined) {
      await this.#put(key, this.#leftBy(ws, entry, Date.now()));
    }
    await this.#renominate([ws]);
    await this.#pushRegistry(undefined, [ws]);
  }

  /**
   * The entry a departing socket leaves: its last `status` kept, or none — a
   * register cleared any older one, since it indexes the blob that register
   * replaced. Only the verified socket's own sealed env can get here, so it
   * needs no signature. A superseded socket keeps nothing: its snapshot indexes
   * the blob its successor's register replaced, and writing it back would undo
   * that register's clear for as long as the successor's own close never runs
   * (a relay restart drops sockets without one).
   */
  #leftBy(ws: WebSocket, entry: RegistryEntry, lastSeen: number): RegistryEntry {
    const { status: _kept, ...rest } = entry;
    const newest = this.#daemonsNewestFirst([]).find(
      ({ attachment }) => attachment?.identity?.deviceId === entry.deviceId,
    );
    if (newest !== undefined && newest.ws !== ws) return { ...rest, lastSeen };
    const status = (ws.deserializeAttachment() as SocketAttachment | null)?.status?.env;
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
    if (next === record.deviceId && connectedAt === record.connectedAt) return;
    const updated: LeaderRecord = { term: record.term + 1, deviceId: next, connectedAt };
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
   * The fence on an envelope sent as the scheduler. The term is no credential —
   * every registry push carries it — so this stops a leader that was demoted
   * without noticing, not a stranger; who may lead at all is nomination's
   * allowlist, not this.
   */
  async #holdsTerm(term: number | undefined): Promise<boolean> {
    if (term === undefined) return false;
    return (await this.#schedulerView(this.#liveSockets([])))?.term === term;
  }

  /**
   * Daemon sockets by accept time, newest first — the order that breaks a tie
   * between two sockets on one deviceId across a reconnect. Each attachment is
   * deserialized once, up front: it carries the ~1 KiB `status`, and a sort
   * comparator would decode it on every comparison.
   */
  #daemonsNewestFirst(exclude: readonly WebSocket[]): readonly DaemonSocket[] {
    return this.#ctx
      .getWebSockets("daemon")
      .filter((ws) => !exclude.includes(ws))
      .map((ws) => ({ ws, attachment: ws.deserializeAttachment() as SocketAttachment | null }))
      .toSorted((a, b) => (b.attachment?.connectedAt ?? 0) - (a.attachment?.connectedAt ?? 0));
  }
}
