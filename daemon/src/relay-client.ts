import {
  APP_ID,
  AT_REST_OPS,
  DAEMON_ROLES,
  ENVELOPE_MAX_CT_LENGTH,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PONG_TIMEOUT_MS,
  isSchedulerOp,
  isTerm,
  MACHINES_ID,
  parseStoreChanged,
  parseStoreReply,
  ReplayError,
  ReplayGuard,
  RequestFailure,
  SCHEDULER_ID,
  STORE_LIST_TIMEOUT_MS,
  STORE_TIMEOUT_MS,
  open,
  quote,
  seal,
  signRegister,
  type BranchState,
  type DaemonFrame,
  type Envelope,
  type ErrorResponse,
  type Identity,
  type LeadProof,
  type MachineStatus,
  type OpName,
  type Plain,
  type RelayToDaemonFrame,
  type SchedulerError,
  type SessionEvent,
  type StoreReplyFrame,
  type StoreRequestFrame,
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
  /** Op dispatch, with the envelope's AAD-bound sealer; a returned Plain is sealed and sent back to it. */
  readonly handle: (plain: Plain, from: string) => Promise<Plain | null>;
  /** Once per socket, after its first register frame has left. */
  readonly onConnect?: () => void;
  /**
   * The relay closed the socket over its register. Whatever left behind that
   * register was dropped with it, so a one-shot send must be re-armed.
   */
  readonly onRefused?: () => void;
  /** After every register frame leaves — connect and re-register alike — with the blob it carried. */
  readonly onRegister?: (info: Envelope) => void;
  readonly onDisconnect?: () => void;
  /** The relay nominated this daemon scheduler leader under `term`. */
  readonly onLead?: (term: number) => void;
  /** The relay moved the role elsewhere. */
  readonly onFollow?: () => void;
  /**
   * An envelope `to: "scheduler"`, unopened; true when a running term took it.
   * One nobody took is opened here only to answer an app's request
   * `not_leader`; anything else is dropped. Absent, every one is dropped as
   * misaddressed.
   */
  readonly onScheduler?: (env: Envelope) => boolean;
  /**
   * The guard every term's leg checks scheduler envelopes against, which the
   * `not_leader` answer must share: an envelope one term took must not be
   * answered again after it, nor one answered here be taken by the next term.
   * Absent, this leg's own guard.
   */
  readonly schedulerGuard?: ReplayGuard;
  /**
   * The relay's nudge after an app-leg write to the store (`store-changed`).
   * Only the leader's socket receives it; `leader.ts` turns it into a refresh.
   */
  readonly onStoreChanged?: (key: string, version: number) => void;
  /** Tests only; defaults to `STORE_TIMEOUT_MS`. */
  readonly storeTimeoutMs?: number;
  /** Tests only; defaults to `STORE_LIST_TIMEOUT_MS`. */
  readonly storeListTimeoutMs?: number;
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
    Pick<
      RelayClientOpts,
      "pingIntervalMs" | "pongTimeoutMs" | "baseBackoffMs" | "maxBackoffMs" | "storeTimeoutMs" | "storeListTimeoutMs"
    >
  > &
    RelayClientOpts;
  readonly #guard = new ReplayGuard();
  /** Store requests awaiting their reply, by id; each is bound to the socket it left on. */
  readonly #storePending = new Map<
    string,
    {
      readonly socket: WebSocket;
      readonly timer: ReturnType<typeof setTimeout>;
      readonly settle: (
        result:
          | { readonly ok: true; readonly reply: StoreReplyFrame | null }
          | { readonly ok: false; readonly error: RequestFailure },
      ) => void;
    }
  >();
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
  /**
   * The scheduler role was handed back (`resign`): registers on this socket
   * sign `roles: []`. Cleared by the next dial, whose register asks for the
   * role again — a redial is where the daemon re-proves the bearer token whose
   * rejection is the one reason it resigns.
   */
  #resigned = false;
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
      storeTimeoutMs: STORE_TIMEOUT_MS,
      storeListTimeoutMs: STORE_LIST_TIMEOUT_MS,
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
    for (const pending of [...this.#storePending.values()]) {
      pending.settle({ ok: false, error: new RequestFailure("dropped", "the client stopped before the store reply") });
    }
  }

  get connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Connected, and this socket's register frame has left. No ack follows one:
   * the relay settles a pending register before it answers any later frame on
   * the socket, so a store frame sent now is judged against it.
   */
  get registered(): boolean {
    return this.connected && this.#registered;
  }

  /** Re-send the register frame (repo set changed). No-op while disconnected — reconnect registers anyway. */
  async reRegister(): Promise<void> {
    if (!this.connected) return;
    await this.#register();
  }

  /**
   * Hands the scheduler role back to the relay after this daemon ended its own
   * term (DESIGN.md, Scheduler, "The leader"): a signed v2 register over no
   * roles on this same socket, so the relay re-nominates at once instead of
   * keeping an idle leader until the socket drops. The signature and the
   * socket are what bind it: only this machine's key signs for its id, and a
   * register moves only the socket it arrives on. The role is asked for again
   * by the next dial's register. No-op while disconnected: the drop already
   * told the relay.
   */
  async resign(): Promise<void> {
    if (this.#resigned) return;
    this.#resigned = true;
    if (!this.connected || !this.#registered) return;
    log.info("scheduler: handing the role back to the relay");
    await this.#register();
  }

  /**
   * One reply to an envelope another part of the daemon opened — the leader
   * answering an app's scheduler request. Sealed from this machine's id, as
   * every daemon reply is, and sized like one (`#sealReply`). Whether it left.
   */
  async reply(to: string, response: Plain): Promise<boolean> {
    if (!this.connected || !this.#registered) return false;
    const sealed = await this.#sealReply(to, response);
    const ws = this.#ws;
    if (ws === null || !this.connected || !this.#registered) {
      log.warn(`wire unsent re=${quote(response.re ?? "")} op=${quote(response.op)} reason=disconnected`);
      return false;
    }
    ws.send(JSON.stringify({ t: "msg", env: sealed } satisfies DaemonFrame));
    log.info(`wire send iv=${quote(sealed.iv)} re=${quote(response.re ?? "")} to=${quote(to)}`);
    return true;
  }

  /**
   * Fire-and-forget group send — no reply ever comes back, so nothing
   * correlates it. Returns whether the frame actually left the socket: the one
   * announce a process makes must not be marked spent when it never went out.
   */
  async broadcast(op: OpName, payload: unknown): Promise<boolean> {
    if (!this.connected || !this.#registered) return false;
    const plain: Plain = { id: crypto.randomUUID(), ts: Date.now(), op, payload };
    const sealed = await seal(this.#opts.key, { to: MACHINES_ID, from: this.#opts.identity.deviceId }, plain);
    // Re-checked after the await: sealing is async, and a socket that dropped
    // meanwhile would swallow the frame silently.
    const ws = this.#ws;
    if (ws === null || !this.connected || !this.#registered) return false;
    ws.send(JSON.stringify({ t: "msg", env: sealed } satisfies DaemonFrame));
    log.info(`wire send iv=${quote(sealed.iv)} id=${quote(plain.id)} op=${quote(op)} to=${quote(MACHINES_ID)}`);
    return true;
  }

  /**
   * A fire-and-forget report to whichever daemon leads (`session-event`). The
   * relay drops it when no leader is nominated — every event is also in the
   * `sessions` reply a new leader reconciles against, so nothing is retried.
   */
  sendToScheduler(event: SessionEvent): Promise<boolean> {
    return this.#toScheduler("session-event", event);
  }

  /** Fire-and-forget like `sendToScheduler`, for the `branch-state` op; false when it was not sent. */
  sendBranchState(state: BranchState): Promise<boolean> {
    return this.#toScheduler("branch-state", state);
  }

  async #toScheduler(op: "session-event" | "branch-state", payload: SessionEvent | BranchState): Promise<boolean> {
    if (!this.connected || !this.#registered) return false;
    const plain: Plain = { id: crypto.randomUUID(), ts: Date.now(), op, payload };
    const sealed = await seal(this.#opts.key, { to: SCHEDULER_ID, from: this.#opts.identity.deviceId }, plain);
    // Re-checked after the seal: a redial meanwhile leaves a socket that is open
    // but not yet registered, and the relay drops anything sent on it before one.
    const ws = this.#ws;
    if (ws === null || !this.connected || !this.#registered) return false;
    ws.send(JSON.stringify({ t: "msg", env: sealed } satisfies DaemonFrame));
    log.info(`wire send iv=${quote(sealed.iv)} id=${quote(plain.id)} op=${quote(plain.op)} to=${quote(SCHEDULER_ID)}`);
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
    if (ws === null || !this.connected || !this.#registered || !current()) return false;
    ws.send(JSON.stringify({ t: "status", env: sealed } satisfies DaemonFrame));
    return true;
  }

  /**
   * One store frame to the relay, which answers it itself (no envelope). The
   * leader's writes leave on this socket because the term fence is `holdsTerm(term,
   * socket)`: the socket the term was issued to. Null is a reply this build
   * cannot read. Rejects `RequestFailure`: `disconnected` when nothing was sent
   * (no open socket, or a send that threw), `timeout` or `dropped` when it was and no answer came —
   * so the write may have landed. Logs only a timeout, and never a key, `env`
   * or `ct`: no line per accepted op (DESIGN.md, "The store").
   */
  store(frame: StoreRequestFrame): Promise<StoreReplyFrame | null> {
    const socket = this.#ws;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RequestFailure("disconnected", "no socket to the relay"));
    }
    return new Promise<StoreReplyFrame | null>((resolve, reject) => {
      const limit = frame.t === "store-list" ? this.#opts.storeListTimeoutMs : this.#opts.storeTimeoutMs;
      const timer = setTimeout(() => {
        log.warn(`store timeout id=${quote(frame.id)} t=${frame.t} after=${limit}ms`);
        this.#storePending.delete(frame.id);
        reject(new RequestFailure("timeout", `${frame.t} timed out after ${limit}ms`));
      }, limit);
      this.#storePending.set(frame.id, {
        socket,
        timer,
        settle: (result) => {
          clearTimeout(timer);
          this.#storePending.delete(frame.id);
          if (result.ok) resolve(result.reply);
          else reject(result.error);
        },
      });
      try {
        socket.send(JSON.stringify(frame));
      } catch (err) {
        // Nothing left: no reply or timeout may fire for a frame that was never sent, and the
        // adapter reads `disconnected` as the term's end rather than a write that may have landed.
        // The socket may still read OPEN, so close it: the redial re-registers, which is what
        // lets the relay nominate a leader that can write instead of keeping this daemon named.
        clearTimeout(timer);
        this.#storePending.delete(frame.id);
        socket.close();
        reject(new RequestFailure("disconnected", `${frame.t} could not be sent: ${String(err)}`));
      }
    });
  }

  /** The relay answers a store frame only on the socket that sent it, so a close after the send may have committed. */
  #failStorePending(socket: WebSocket, message: string): void {
    for (const pending of [...this.#storePending.values()]) {
      if (pending.socket === socket) pending.settle({ ok: false, error: new RequestFailure("dropped", message) });
    }
  }

  /** Whether `frame` was a store frame, handled here: a reply settles its request, a nudge goes to the leader. */
  #onStoreFrame(ws: WebSocket, frame: { readonly t?: unknown; readonly re?: unknown }): boolean {
    if (typeof frame.t !== "string" || !frame.t.startsWith("store-")) return false;
    if (frame.t === "store-changed") {
      const changed = parseStoreChanged(frame);
      if (changed === null) log.warn("dropped malformed store-changed");
      else this.#opts.onStoreChanged?.(changed.key, changed.version);
      return true;
    }
    const reply = parseStoreReply(frame);
    const re = reply?.re ?? (typeof frame.re === "string" ? frame.re : null);
    if (re === null) {
      log.warn("dropped store frame without a reply id");
      return true;
    }
    const pending = this.#storePending.get(re);
    if (pending === undefined || pending.socket !== ws) {
      log.warn(`dropped stale store reply re=${quote(re)}`);
      return true;
    }
    // Unparseable settles at once with null: the request is answered, only unreadably.
    pending.settle({ ok: true, reply });
    return true;
  }

  /** Whether the frame left on the socket it was built for. */
  async #register(): Promise<boolean> {
    // Bound before the awaits: a redial meanwhile must not get this socket's
    // register, nor `#registered` before its own one has left.
    const ws = this.#ws;
    const { identity } = this.#opts;
    const info = await this.#opts.buildInfo();
    // Signed fresh each time: the relay bounds the timestamp, so a frame built
    // once at start would stop verifying after a minute.
    const ts = Date.now();
    // Every daemon may lead: the relay nominates among those that say so. A
    // resigned one still signs v2, over no roles — explicit, not merely absent.
    const roles = this.#signV1 ? undefined : this.#resigned ? [] : [DAEMON_ROLES.scheduler];
    const frame: DaemonFrame = {
      t: "register",
      deviceId: identity.deviceId,
      info,
      key: identity.publicKey,
      ts,
      sig: await signRegister(identity, ts, roles),
      ...(roles === undefined ? {} : { roles }),
    };
    if (ws === null || this.#ws !== ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    this.#registered = true;
    this.#opts.onRegister?.(info);
    return true;
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
    this.#resigned = false;

    ws.addEventListener("open", () => {
      this.#opened = true;
      log.info(`connected to ${this.#opts.url}`);
      this.#startHeartbeat();
      // After the register has left, never alongside it: the relay drops any
      // msg a socket sends before its register, and signing one is slower than
      // sealing the announce `onConnect` sends — which raced ahead and reached
      // no machine.
      this.#register().then(
        (sent) => {
          if (sent) this.#opts.onConnect?.();
        },
        (err: unknown) => log.warn(`register not sent: ${String(err)}`),
      );
    });

    ws.addEventListener("message", (event) => {
      void this.#onMessage(ws, typeof event.data === "string" ? event.data : "");
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
    const dropped = this.#ws;
    if (dropped === null) return; // already handled (close after error)
    this.#ws = null;
    this.#failStorePending(dropped, "socket closed before the store reply");
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
    if (refused) this.#opts.onRefused?.();
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

  async #onMessage(ws: WebSocket, data: string): Promise<void> {
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
    if (this.#onStoreFrame(ws, frame)) return;
    // Plaintext relay assertions, acted on by `leader.ts`; the term it runs
    // under is what the relay fences every scheduler send on.
    if (frame.t === "lead") {
      if (!isTerm(frame.term)) {
        log.warn("dropped lead frame without a term");
        return;
      }
      log.info(`relay says lead term=${frame.term}`);
      void this.#proveLead(frame.term);
      this.#opts.onLead?.(frame.term);
      return;
    }
    if (frame.t === "follow") {
      log.info("relay says follow");
      this.#opts.onFollow?.();
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

  /**
   * Answers `lead` with the term sealed under the PSK, which the relay carries
   * to apps beside the nomination. It is what makes a nominee verifiable: a
   * token holder with this machine's seed can register its `info` blob, but
   * the relay mints a new term when it takes this socket's route, and only a
   * PSK holder can seal one (DESIGN.md, Scheduler, "Leadership"). Sent on the
   * socket that heard `lead`, since the relay keeps a proof only from the
   * leader's own socket under the current term.
   */
  async #proveLead(term: number): Promise<void> {
    const ws = this.#ws;
    const payload: LeadProof = { term };
    const plain: Plain = { id: crypto.randomUUID(), ts: Date.now(), op: AT_REST_OPS.leadProof, payload };
    const env = await seal(this.#opts.key, { to: APP_ID, from: this.#opts.identity.deviceId }, plain);
    if (ws === null || this.#ws !== ws || !this.connected) {
      log.warn(`scheduler: lead proof for term=${term} unsent — the socket that heard lead is gone`);
      return;
    }
    ws.send(JSON.stringify({ t: "lead-proof", term, env } satisfies DaemonFrame));
  }

  async #onEnvelope(env: Envelope): Promise<void> {
    // Replies to the leader's app-role requests, routed here because a daemon
    // answers `env.from`. Not opened on this leg: the leader's own client
    // opens, replay-checks and correlates them, so one guard sees them once.
    if (env.to === SCHEDULER_ID && this.#opts.onScheduler !== undefined) {
      if (!this.#opts.onScheduler(env)) await this.#refuseScheduler(env);
      return;
    }
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
    const response = await this.#opts.handle(plain, env.from);
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
   * An envelope to the scheduler that no running term took. An app's request
   * is answered `not_leader` rather than left to time out — the relay routed
   * it here because its record still names this daemon (a term ended on its
   * own, a relay restart), and silence would read as a dead machine. Checked
   * against the scheduler guard every term's leg shares, so the relay cannot
   * have one envelope both answered here and taken by a term. Anything else —
   * a reply or event for a term that ended — opens nothing that acts.
   */
  async #refuseScheduler(env: Envelope): Promise<void> {
    let plain: Plain;
    try {
      plain = await open(this.#opts.key, env);
    } catch {
      log.warn(`wire dropped iv=${quote(env.iv)} from=${quote(env.from)} reason=not-leading`);
      return;
    }
    try {
      (this.#opts.schedulerGuard ?? this.#guard).check(env.iv, plain.ts);
    } catch (err) {
      const reason = err instanceof ReplayError ? err.reason : String(err);
      log.warn(`wire dropped iv=${quote(env.iv)} from=${quote(env.from)} reason=replay detail=${quote(reason)}`);
      return;
    }
    if (plain.re !== undefined || env.from !== APP_ID || !isSchedulerOp(plain.op)) {
      log.warn(`wire dropped iv=${quote(env.iv)} from=${quote(env.from)} reason=not-leading`);
      return;
    }
    const payload: SchedulerError = { ok: false, code: "not_leader", message: "this daemon is not leading" };
    await this.reply(env.from, { id: crypto.randomUUID(), ts: Date.now(), op: plain.op, re: plain.id, payload });
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
