import {
  APP_ID,
  type Envelope,
  type RegistryEntry,
  type RegistryView,
  type RelayToAppFrame,
  type RelayToDaemonFrame,
  type UndeliverableCode,
} from "@seance/shared";
import { roleForPath, type Role } from "./auth.ts";
import { parseAppFrame, parseDaemonFrame } from "./wire.ts";

const ENTRY_PREFIX = "device:";

/**
 * Attached to a daemon socket at register time. Survives hibernation, which is
 * why routing needs no class fields: `getWebSockets()` plus storage are truth.
 */
interface SocketIdentity {
  readonly deviceId: string;
}

/**
 * The one relay hub: routes opaque envelopes app↔daemon and persists the machine
 * registry. Blind by construction — it never holds the PSK, so `info` blobs and
 * op payloads are unreadable here.
 */
export class Hub implements DurableObject {
  readonly #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.#ctx = ctx;
    // Re-applied on every wake. Heartbeats are answered without waking the object,
    // which is also why `lastSeen` can only move on register and on close.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    const role = roleForPath(new URL(req.url).pathname);
    if (role === null) return new Response("not found", { status: 404 });

    const pair = new WebSocketPair();
    this.#ctx.acceptWebSocket(pair[1], [role]);
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

  #roleOf(ws: WebSocket): Role {
    return this.#ctx.getTags(ws).includes("daemon") ? "daemon" : "app";
  }

  #deviceIdOf(ws: WebSocket): string | null {
    const identity = ws.deserializeAttachment() as SocketIdentity | null;
    return identity?.deviceId ?? null;
  }

  async #onDaemonMessage(ws: WebSocket, text: string): Promise<void> {
    const frame = parseDaemonFrame(text);
    if (frame === null) {
      console.log("dropped malformed daemon frame");
      return;
    }
    if (frame.t === "register") {
      await this.#register(ws, frame.deviceId, frame.info);
      return;
    }
    const deviceId = this.#deviceIdOf(ws);
    if (deviceId === null) {
      console.log("dropped msg from a daemon socket that has not registered");
      return;
    }
    if (frame.env.from !== deviceId) {
      console.log(`dropped msg from ${deviceId} claiming from=${frame.env.from}`);
      return;
    }
    await this.#route(frame.env, ws, "daemon");
  }

  async #onAppMessage(ws: WebSocket, text: string): Promise<void> {
    const frame = parseAppFrame(text);
    if (frame === null) {
      console.log("dropped malformed app frame");
      return;
    }
    if (frame.env.from !== APP_ID) {
      console.log(`dropped app msg claiming from=${frame.env.from}`);
      return;
    }
    await this.#route(frame.env, ws, "app");
  }

  async #register(ws: WebSocket, deviceId: string, info: Envelope): Promise<void> {
    ws.serializeAttachment({ deviceId } satisfies SocketIdentity);
    // Two open sockets for one machine would deliver a spawn twice, so the older
    // one loses. Attaching first keeps the loser's close handler from reporting
    // the machine as disconnected.
    for (const other of this.#ctx.getWebSockets("daemon")) {
      if (other !== ws && this.#deviceIdOf(other) === deviceId) other.close(1000, "superseded");
    }
    const entry: RegistryEntry = { deviceId, info, lastSeen: Date.now() };
    await this.#ctx.storage.put(ENTRY_PREFIX + deviceId, entry);
    console.log(`registered ${deviceId}`);
    await this.#pushRegistry();
  }

  async #route(env: Envelope, sender: WebSocket, senderRole: Role): Promise<void> {
    if (env.to === APP_ID) {
      // Phone and laptop tabs share one wire address; both get it and drop what
      // matches no pending `re`.
      const frame: RelayToAppFrame = { t: "msg", env };
      const text = JSON.stringify(frame);
      for (const app of this.#ctx.getWebSockets("app")) app.send(text);
      return;
    }

    const target = this.#ctx.getWebSockets("daemon").find((ws) => this.#deviceIdOf(ws) === env.to);
    if (target !== undefined) {
      const frame: RelayToDaemonFrame = { t: "msg", env };
      target.send(JSON.stringify(frame));
      return;
    }

    // Only an app can act on the notice. A daemon reply that finds no app socket
    // is a response nobody is waiting for.
    if (senderRole !== "app") return;
    const known = await this.#ctx.storage.get<RegistryEntry>(ENTRY_PREFIX + env.to);
    const code: UndeliverableCode = known === undefined ? "unknown" : "offline";
    // Correlated by `iv`: the request `id` is inside the ciphertext.
    const notice: RelayToAppFrame = { t: "undeliverable", to: env.to, iv: env.iv, code };
    sender.send(JSON.stringify(notice));
  }

  /** Only daemon sockets carry an identity, so an app socket closing is a no-op. */
  async #onSocketGone(ws: WebSocket): Promise<void> {
    const deviceId = this.#deviceIdOf(ws);
    if (deviceId === null) return;
    const key = ENTRY_PREFIX + deviceId;
    const entry = await this.#ctx.storage.get<RegistryEntry>(key);
    if (entry !== undefined) {
      await this.#ctx.storage.put(key, { ...entry, lastSeen: Date.now() } satisfies RegistryEntry);
    }
    await this.#pushRegistry(undefined, ws);
  }

  /**
   * `exclude` is the socket whose loss triggered the push — it may still appear
   * in `getWebSockets()` while its close handler runs, and counting it would
   * report a machine online moments after it went away.
   */
  async #pushRegistry(targets?: readonly WebSocket[], exclude: WebSocket | null = null): Promise<void> {
    const apps = targets ?? this.#ctx.getWebSockets("app");
    if (apps.length === 0) return;
    const frame: RelayToAppFrame = { t: "registry", entries: await this.#views(exclude) };
    const text = JSON.stringify(frame);
    for (const app of apps) app.send(text);
  }

  async #views(exclude: WebSocket | null): Promise<RegistryView[]> {
    const stored = await this.#ctx.storage.list<RegistryEntry>({ prefix: ENTRY_PREFIX });
    const connected = this.#connectedIds(exclude);
    // Spelled out rather than spread: this is the wire projection of an entry.
    return [...stored.values()].map((entry) => ({
      deviceId: entry.deviceId,
      info: entry.info,
      lastSeen: entry.lastSeen,
      connected: connected.has(entry.deviceId),
    }));
  }

  /** Derived at read time and never persisted, so an eviction cannot leave a stale `true` on disk. */
  #connectedIds(exclude: WebSocket | null): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const ws of this.#ctx.getWebSockets("daemon")) {
      if (ws === exclude) continue;
      const deviceId = this.#deviceIdOf(ws);
      if (deviceId !== null) ids.add(deviceId);
    }
    return ids;
  }
}
