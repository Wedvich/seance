import {
  APP_ID,
  DAEMON_ROLES,
  ENVELOPE_MAX_CT_LENGTH,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PONG_TIMEOUT_MS,
  MACHINES_ID,
  ReplayError,
  ReplayGuard,
  open,
  quote,
  seal,
  signRegister,
  type DaemonFrame,
  type Envelope,
  type ErrorResponse,
  type Identity,
  type MachineStatus,
  type OpName,
  type Plain,
  type RelayToDaemonFrame,
} from "@seance/shared";
import { log } from "./log.ts";

export interface RelayClientOpts {
  readonly url: string;
  readonly bearerToken: string;
  /** Signs every register; `identity.deviceId` is this machine's wire address. */
  readonly identity: Identity;
  readonly key: CryptoKey;
  /** Fresh encrypted machine-info blob — called on every register. */
  readonly buildInfo: () => Promise<Envelope>;
  /** Op dispatch; a returned Plain is sealed and sent back to the requester. */
  readonly handle: (plain: Plain) => Promise<Plain | null>;
  readonly onConnect?: () => void;
  /** After every register frame leaves — connect and re-register alike — with the blob it carried. */
  readonly onRegister?: (info: Envelope) => void;
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
  readonly #opts: Required<
    Pick<RelayClientOpts, "pingIntervalMs" | "pongTimeoutMs" | "baseBackoffMs" | "maxBackoffMs">
  > &
    RelayClientOpts;
  readonly #guard = new ReplayGuard();
  #ws: WebSocket | null = null;
  /** Whether a register frame has left the current socket: the relay drops any other frame before one. */
  #registered = false;
  #attempt = 0;
  /** Whether the current socket reached `open` — a connect that failed outright must not reset backoff. */
  #opened = false;
  /**
   * Sign the next register v1, without roles. Flipped by each refusal, so a
   * daemon that updated ahead of its relay — which verifies v1 only and refuses
   * the v2 message — still registers, roleless, on the redial after; the one
   * after that tries v2 again. A refusal with some other cause (a skewed clock)
   * fails both alike, so alternating costs it nothing. Reset by any drop that
   * was not a refusal, or a daemon admitted v1 would stay roleless after its
   * relay is upgraded, until it restarted.
   */
  #signV1 = false;
  #stopped = false;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #pongDeadline: ReturnType<typeof setTimeout> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: RelayClientOpts) {
    this.#opts = {
      pingIntervalMs: HEARTBEAT_INTERVAL_MS,
      pongTimeoutMs: HEARTBEAT_PONG_TIMEOUT_MS,
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

  /**
   * Fire-and-forget group send — no reply ever comes back, so nothing
   * correlates it. Returns whether the frame actually left the socket: the one
   * announce a process makes must not be marked spent when it never went out.
   */
  async broadcast(op: OpName, payload: unknown): Promise<boolean> {
    if (!this.connected) return false;
    const plain: Plain = { id: crypto.randomUUID(), ts: Date.now(), op, payload };
    const sealed = await seal(this.#opts.key, { to: MACHINES_ID, from: this.#opts.identity.deviceId }, plain);
    // Re-checked after the await: sealing is async, and a socket that dropped
    // meanwhile would swallow the frame silently.
    const ws = this.#ws;
    if (ws === null || !this.connected) return false;
    ws.send(JSON.stringify({ t: "msg", env: sealed } satisfies DaemonFrame));
    log.info(`wire send iv=${quote(sealed.iv)} id=${quote(plain.id)} op=${quote(op)} to=${quote(MACHINES_ID)}`);
    return true;
  }

  /**
   * The current snapshot, sealed to the app like the register blob but sent as
   * its own frame: the relay keeps the latest on this socket and forwards it,
   * never storing it. Fire-and-forget like `broadcast` — nothing answers — and
   * not logged per frame: one every 30s is the daemon's steadiest traffic, and
   * the relay's log carries each `iv` for the rare one worth chasing.
   *
   * `current` is asked after the seal, in the same turn as the send: a
   * register can leave while the seal is awaited, and a status that lands
   * behind it is the one the relay keeps until the next beat.
   */
  async sendStatus(status: MachineStatus, current: () => boolean = () => true): Promise<boolean> {
    if (!this.connected || !this.#registered) return false;
    const plain: Plain = { id: crypto.randomUUID(), ts: Date.now(), op: "status", payload: status };
    const sealed = await seal(this.#opts.key, { to: APP_ID, from: this.#opts.identity.deviceId }, plain);
    const ws = this.#ws;
    if (ws === null || !this.connected || !current()) return false;
    ws.send(JSON.stringify({ t: "status", env: sealed } satisfies DaemonFrame));
    return true;
  }

  async #register(): Promise<void> {
    const { identity } = this.#opts;
    const info = await this.#opts.buildInfo();
    // Signed fresh each time: the relay bounds the timestamp, so a frame built
    // once at start would stop verifying after a minute.
    const ts = Date.now();
    // Every daemon may lead: the relay nominates among those that say so.
    const roles = this.#signV1 ? undefined : [DAEMON_ROLES.scheduler];
    const frame: DaemonFrame = {
      t: "register",
      deviceId: identity.deviceId,
      info,
      key: identity.publicKey,
      ts,
      sig: await signRegister(identity, ts, roles),
      ...(roles === undefined ? {} : { roles }),
    };
    const ws = this.#ws;
    if (ws === null) return;
    ws.send(JSON.stringify(frame));
    this.#registered = true;
    this.#opts.onRegister?.(info);
  }

  #dial(): void {
    if (this.#stopped) return;
    const ws = new WebSocket(this.#opts.url, {
      headers: { authorization: `Bearer ${this.#opts.bearerToken}` },
      // Bun's client and workerd disagree about permessage-deflate and the
      // socket dies with 1002 after a few frames (see pwa/test/client.test.ts).
      // Cloudflare never negotiates the extension on incoming Worker sockets,
      // so in production this only removes an offer that was always declined.
      perMessageDeflate: false,
    });
    this.#ws = ws;
    this.#opened = false;
    this.#registered = false;

    ws.addEventListener("open", () => {
      this.#opened = true;
      log.info(`connected to ${this.#opts.url}`);
      void this.#register();
      this.#startHeartbeat();
      this.#opts.onConnect?.();
    });

    ws.addEventListener("message", (event) => {
      void this.#onMessage(typeof event.data === "string" ? event.data : "");
    });

    ws.addEventListener("close", (event) => this.#onDrop("closed", event.code, event.reason));
    // The error fires first and claims the drop, so the close that follows — the
    // only other place Bun puts the reason — is swallowed by #onDrop's guard.
    // Bun's ErrorEvent says what failed ("Failed to connect", "Expected 101
    // status code", "TLS handshake failed"); without it every failure reads the same.
    ws.addEventListener("error", (event) =>
      this.#onDrop("errored", undefined, event instanceof ErrorEvent ? event.message : undefined),
    );
  }

  #onDrop(why: string, code?: number, reason?: string): void {
    if (this.#ws === null) return; // already handled (close after error)
    this.#ws = null;
    this.#teardownHeartbeat();
    this.#opts.onDisconnect?.();
    if (this.#stopped) return;
    // The relay refuses a register it cannot verify by closing the socket — so
    // a socket that opened is not proof the register was accepted. Backoff
    // resets only on the drop of a socket that was not refused: a refusal keeps
    // it growing, so a daemon the relay will not admit (a clock a minute off, a
    // relay without the algorithm) redials at the capped rate rather than once
    // per base interval, and the reason is logged because the close is the only
    // word the relay sends about it.
    const refused = reason === "register unverified";
    this.#signV1 = refused ? !this.#signV1 : false;
    if (this.#opened && !refused) this.#attempt = 0;
    const capped = Math.min(this.#opts.maxBackoffMs, this.#opts.baseBackoffMs * 2 ** this.#attempt);
    const delay = Math.random() * capped; // full jitter
    this.#attempt += 1;
    const detail = `${code === undefined ? "" : ` code=${code}`}${reason ? ` reason=${quote(reason)}` : ""}`;
    log.warn(`relay socket ${why}${detail} — reconnecting in ${Math.round(delay)}ms`);
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

    let frame: RelayToDaemonFrame;
    try {
      frame = JSON.parse(data) as RelayToDaemonFrame;
    } catch {
      log.warn("dropped non-JSON frame from relay");
      return;
    }
    if (frame === null || typeof frame !== "object") {
      log.warn("dropped non-object frame from relay");
      return;
    }
    // Leadership is logged and nothing more until the scheduler runs here
    // (docs/scheduler.md, M2 item 3); nothing in this process acts on it yet.
    if (frame.t === "lead" || frame.t === "follow") {
      const term = frame.t === "lead" && typeof frame.term === "number" ? ` term=${frame.term}` : "";
      log.info(`relay says ${frame.t}${term}`);
      return;
    }
    // `typeof null === "object"`, so null has to be named: it would otherwise reach
    // #onEnvelope and throw on the first dereference, and the caller voids this promise
    // — an unhandled rejection and no log line, which is the opposite of dropping it.
    if (frame.t !== "msg" || frame.env === null || typeof frame.env !== "object") {
      log.warn(`dropped unexpected frame type from relay`);
      return;
    }
    await this.#onEnvelope(frame.env);
  }

  async #onEnvelope(env: Envelope): Promise<void> {
    const broadcast = env.to === MACHINES_ID;
    if (!broadcast && env.to !== this.#opts.identity.deviceId) {
      log.warn(`wire dropped iv=${quote(env.iv)} to=${quote(env.to)} reason=misaddressed`);
      return;
    }
    let plain: Plain;
    try {
      plain = await open(this.#opts.key, env);
    } catch (err) {
      log.warn(`wire dropped iv=${quote(env.iv)} reason=unopenable detail=${quote(String(err))}`);
      return;
    }
    try {
      this.#guard.check(env.iv, plain.ts);
    } catch (err) {
      const reason = err instanceof ReplayError ? err.reason : String(err);
      log.warn(
        `wire dropped iv=${quote(env.iv)} id=${quote(plain.id)} op=${quote(plain.op)} ` +
          `reason=replay detail=${quote(reason)}`,
      );
      return;
    }

    // The broadcast allowlist lives here at the transport, not in the handler
    // map: a group-addressed `spawn` must be structurally impossible, and a
    // handler bug must not widen what one seal can make every machine do.
    if (broadcast && plain.op !== "update-available") {
      log.warn(`wire dropped iv=${quote(env.iv)} op=${quote(plain.op)} reason=broadcast-op-not-allowed`);
      return;
    }
    // The one point where the envelope `iv` and the plaintext `id` are both in
    // scope. Logging the pair here is what lets a relay line — which can only
    // ever name the `iv` — be joined to an op end to end. Never the payload.
    log.info(`wire recv iv=${quote(env.iv)} id=${quote(plain.id)} op=${quote(plain.op)}`);
    const response = await this.#opts.handle(plain);
    // A broadcast is never answered: the sender is not waiting, and the reply
    // would be daemon→daemon traffic no route is meant to carry.
    if (broadcast || response === null) return;
    if (!this.connected) {
      // The socket died while the handler ran. The op did happen — a spawn is
      // already spawned — so this line is the only record that its reply is lost.
      log.warn(`wire unsent id=${quote(plain.id)} op=${quote(plain.op)} reason=disconnected`);
      return;
    }
    const sealed = await this.#sealReply(env.from, response);
    const frame: DaemonFrame = { t: "msg", env: sealed };
    const ws = this.#ws;
    if (ws === null) {
      log.warn(`wire unsent id=${quote(plain.id)} op=${quote(plain.op)} reason=socket-gone`);
      return;
    }
    ws.send(JSON.stringify(frame));
    // Logged after the send, so the line never claims a frame that never left.
    // A reply carries a fresh iv, so the two directions join through `re`, not the iv.
    log.info(`wire send iv=${quote(sealed.iv)} re=${quote(response.re ?? "")} to=${quote(env.from)}`);
  }

  /**
   * Checked on the sealed `ct`, so the reply is encoded once: the relay drops
   * an envelope past its bound unseen, which the app could only report as a
   * timeout. Any op whose reply grows with data — `metrics`, `sessions` and
   * `rescan` on a large machine — gets `too_large` in its place instead.
   */
  async #sealReply(to: string, response: Plain): Promise<Envelope> {
    const route = { to, from: this.#opts.identity.deviceId };
    const sealed = await seal(this.#opts.key, route, response);
    if (sealed.ct.length <= ENVELOPE_MAX_CT_LENGTH) return sealed;
    log.warn(`wire oversized re=${quote(response.re ?? "")} op=${quote(response.op)} ct=${sealed.ct.length}`);
    const payload: ErrorResponse = {
      ok: false,
      code: "too_large",
      message: `reply would seal to ${sealed.ct.length} chars, over ${ENVELOPE_MAX_CT_LENGTH}`,
    };
    return seal(this.#opts.key, route, { ...response, payload });
  }
}
