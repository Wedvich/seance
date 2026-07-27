import {
  ReplayError,
  ReplayGuard,
  open,
  seal,
  type DaemonFrame,
  type Envelope,
  type Plain,
  type RelayFrame,
} from "@seance/shared";
import { log } from "./log.ts";

export interface RelayClientOpts {
  readonly url: string;
  readonly bearerToken: string;
  readonly deviceId: string;
  readonly key: CryptoKey;
  /** Fresh encrypted machine-info blob — called on every register. */
  readonly buildInfo: () => Promise<Envelope>;
  /** Op dispatch; a returned Plain is sealed and sent back to the requester. */
  readonly handle: (plain: Plain) => Promise<Plain | null>;
  readonly onConnect?: () => void;
  readonly onDisconnect?: () => void;
  readonly pingIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

/**
 * Holds the one persistent WebSocket out to the relay. Heartbeats are the
 * literal strings "ping"/"pong" so the relay's DO auto-response can answer
 * without waking; a missed pong closes the socket and redials with jittered
 * exponential backoff.
 */
export class RelayClient {
  readonly #opts: Required<Pick<RelayClientOpts, "pingIntervalMs" | "pongTimeoutMs" | "baseBackoffMs" | "maxBackoffMs">> &
    RelayClientOpts;
  readonly #guard = new ReplayGuard();
  #ws: WebSocket | null = null;
  #attempt = 0;
  #stopped = false;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #pongDeadline: ReturnType<typeof setTimeout> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: RelayClientOpts) {
    this.#opts = {
      pingIntervalMs: 30_000,
      pongTimeoutMs: 10_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 60_000,
      ...opts,
    };
  }

  start(): void {
    this.#stopped = false;
    this.#dial();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#teardownHeartbeat();
    this.#ws?.close();
    this.#ws = null;
  }

  get connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /** Re-send the register frame (repo set changed). No-op while disconnected — reconnect registers anyway. */
  async reRegister(): Promise<void> {
    if (!this.connected) return;
    await this.#register();
  }

  async #register(): Promise<void> {
    const info = await this.#opts.buildInfo();
    const frame: DaemonFrame = { t: "register", deviceId: this.#opts.deviceId, info };
    this.#ws?.send(JSON.stringify(frame));
  }

  #dial(): void {
    if (this.#stopped) return;
    const ws = new WebSocket(this.#opts.url, {
      headers: { authorization: `Bearer ${this.#opts.bearerToken}` },
    });
    this.#ws = ws;

    ws.addEventListener("open", () => {
      this.#attempt = 0;
      log.info(`connected to ${this.#opts.url}`);
      void this.#register();
      this.#startHeartbeat();
      this.#opts.onConnect?.();
    });

    ws.addEventListener("message", (event) => {
      void this.#onMessage(typeof event.data === "string" ? event.data : "");
    });

    ws.addEventListener("close", () => this.#onDrop("closed"));
    ws.addEventListener("error", () => this.#onDrop("errored"));
  }

  #onDrop(why: string): void {
    if (this.#ws === null) return; // already handled (close after error)
    this.#ws = null;
    this.#teardownHeartbeat();
    this.#opts.onDisconnect?.();
    if (this.#stopped) return;
    const capped = Math.min(this.#opts.maxBackoffMs, this.#opts.baseBackoffMs * 2 ** this.#attempt);
    const delay = Math.random() * capped; // full jitter
    this.#attempt += 1;
    log.warn(`relay socket ${why} — reconnecting in ${Math.round(delay)}ms`);
    this.#reconnectTimer = setTimeout(() => this.#dial(), delay);
  }

  #startHeartbeat(): void {
    this.#pingTimer = setInterval(() => {
      if (!this.connected) return;
      this.#ws?.send("ping");
      this.#pongDeadline ??= setTimeout(() => {
        log.warn("pong deadline missed — closing socket");
        this.#ws?.close();
      }, this.#opts.pongTimeoutMs);
    }, this.#opts.pingIntervalMs);
  }

  #teardownHeartbeat(): void {
    if (this.#pingTimer !== null) clearInterval(this.#pingTimer);
    if (this.#pongDeadline !== null) clearTimeout(this.#pongDeadline);
    this.#pingTimer = null;
    this.#pongDeadline = null;
  }

  async #onMessage(data: string): Promise<void> {
    if (data === "pong") {
      if (this.#pongDeadline !== null) clearTimeout(this.#pongDeadline);
      this.#pongDeadline = null;
      return;
    }

    let frame: RelayFrame;
    try {
      frame = JSON.parse(data) as RelayFrame;
    } catch {
      log.warn("dropped non-JSON frame from relay");
      return;
    }
    if (frame.t !== "msg" || typeof frame.env !== "object") {
      log.warn(`dropped unexpected frame type from relay`);
      return;
    }
    await this.#onEnvelope(frame.env);
  }

  async #onEnvelope(env: Envelope): Promise<void> {
    if (env.to !== this.#opts.deviceId) {
      log.warn(`dropped envelope addressed to ${env.to}`);
      return;
    }
    let plain: Plain;
    try {
      plain = await open(this.#opts.key, env);
    } catch (err) {
      log.warn(`dropped envelope that failed to open: ${String(err)}`);
      return;
    }
    try {
      this.#guard.check(env.iv, plain.ts);
    } catch (err) {
      const reason = err instanceof ReplayError ? err.reason : String(err);
      log.warn(`dropped ${plain.op} message: replay check failed (${reason})`);
      return;
    }

    const response = await this.#opts.handle(plain);
    if (response === null || !this.connected) return;
    const sealed = await seal(this.#opts.key, { to: env.from, from: this.#opts.deviceId }, response);
    const frame: DaemonFrame = { t: "msg", env: sealed };
    this.#ws?.send(JSON.stringify(frame));
  }
}
