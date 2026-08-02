import {
  APP_ID,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PONG_TIMEOUT_MS,
  CLOSE_BAD_REQUEST,
  CLOSE_UNAUTHORIZED,
  open as openEnvelope,
  OP_TIMEOUT_MS,
  ReplayGuard,
  quote,
  seal,
  TOKEN_PARAM,
  type Envelope,
  type MachineInfo,
  type Plain,
  type RegistryView,
  type RelayToAppFrame,
  type RepoEntry,
  type RequestOp,
  type UndeliverableCode,
} from "@seance/shared";

export type RelayStatus = "connecting" | "open" | "retrying" | "rejected";

/**
 * Same shape the daemon and relay emit, so one grep spans all three tiers. The
 * `iv` is what the blind relay can name; the `id`/`re` beside it is what only
 * the two encrypting ends can read. Ships in production builds — a phone-only
 * failure is the one that cannot be reproduced at a desk. Never the payload.
 */
function wireLog(event: string, detail: string): void {
  console.log(`wire ${event} ${detail}`);
}

/** Why a request will never get an answer. */
export type FailureReason = UndeliverableCode | "timeout" | "disconnected";

export class RequestFailure extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
  ) {
    super(message);
    this.name = "RequestFailure";
  }
}

/** A registry entry whose `info` decrypted. Entries that don't are counted, not shown. */
export interface Machine {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  readonly repos: readonly RepoEntry[];
  readonly scannedAt: number;
  readonly lastSeen: number;
  readonly connected: boolean;
}

export interface RelayState {
  readonly status: RelayStatus;
  /** Set only for a permanent close; the client stops reconnecting. */
  readonly rejection: "unauthorized" | "bad-request" | null;
  /** Decrypting entries, minus any removed by hand while offline. */
  readonly machines: readonly Machine[];
  /** Total entries the relay holds, including any that did not decrypt. */
  readonly registrySize: number;
  /** deviceIds removed by hand; they come back the moment they connect again. */
  readonly hidden: readonly string[];
  /** registrySize minus machines.length and hidden.length — a stale PSK somewhere. */
  readonly ignored: number;
  /**
   * The socket is not open, but too briefly to be worth reporting yet. Set from the
   * moment `open` is left until SETTLE_MS later, and never re-armed by a retry that
   * follows one — once the drop has been shown it stays shown.
   */
  readonly settling: boolean;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 15_000;

/**
 * How long a gap in the socket is allowed to go unreported. A refresh dials from
 * scratch and a resume re-dials unconditionally (the socket dies silently while an
 * installed PWA is suspended), so the app is legitimately not open for a moment on
 * the way in — and rendering that immediately flashed "Relay unreachable" for a
 * frame or two every single time. Anything that recovers inside this window is
 * never shown at all; a real outage lasts far longer than it.
 */
const SETTLE_MS = 1_500;

const INITIAL_STATE: RelayState = {
  status: "connecting",
  rejection: null,
  machines: [],
  registrySize: 0,
  hidden: [],
  ignored: 0,
  settling: true,
};

interface Pending {
  readonly iv: string;
  readonly settle: (result: { ok: true; payload: unknown } | { ok: false; error: RequestFailure }) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function parseFrame(text: string): RelayToAppFrame | null {
  try {
    const frame = JSON.parse(text) as RelayToAppFrame;
    return typeof frame === "object" && frame !== null && typeof frame.t === "string" ? frame : null;
  } catch {
    return null;
  }
}

/**
 * Transport half of the app: one socket, envelope seal/open, and request
 * correlation. Deliberately knows nothing about the spawn form — that keeps it
 * testable against the real relay with no DOM in sight.
 */
export class RelayClient {
  readonly #url: string;
  readonly #token: string;
  readonly #key: CryptoKey;
  readonly #listeners = new Set<() => void>();
  readonly #pending = new Map<string, Pending>();
  /** `undeliverable` can only echo the IV, so responses and failures index differently. */
  readonly #idByIv = new Map<string, string>();
  readonly #guard = new ReplayGuard();
  /** Decrypted `info` by envelope IV; blobs are re-sent verbatim on every push. */
  readonly #infoCache = new Map<string, MachineInfo | null>();
  /**
   * deviceId -> the lastSeen we held when delivery failed (an `undeliverable`
   * refusal or a request timeout). `connected` is derived from live sockets and
   * can read true over an abruptly slept machine, so a failed delivery is the
   * better evidence — until the machine registers again, or answers, which any
   * decrypted message from it proves.
   */
  readonly #provenOffline = new Map<string, number>();
  /**
   * deviceId -> the repo list and scan time a `rescan` reply carried. The daemon
   * re-registers only when the set changed, so without this a scan that found
   * nothing new leaves the machine asserting the old `scannedAt` — and the app
   * looks like it did nothing. Spent by the register that overtakes it.
   */
  readonly #scans = new Map<string, { readonly repos: readonly RepoEntry[]; readonly scannedAt: number }>();
  /**
   * deviceIds removed from the list by hand. Held here rather than in the store so
   * `machines` stays "what to show" for every reader, and dropped again the moment
   * the machine connects — a removal hides an absence, it does not forget a machine.
   */
  readonly #hidden: Set<string>;

  #entries: readonly RegistryView[] = [];
  #state: RelayState = INITIAL_STATE;
  #socket: WebSocket | null = null;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #settleTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #pongDeadline: ReturnType<typeof setTimeout> | null = null;
  /** When the current socket last delivered anything — pong or frame. Uplink evidence for timeout blame. */
  #lastFrameAt = 0;
  #stopped = false;

  readonly #timeouts: Partial<Record<RequestOp, number>>;
  readonly #createSocket: (url: string) => WebSocket;
  readonly #settleMs: number;
  readonly #pingIntervalMs: number;
  readonly #pongTimeoutMs: number;

  constructor(opts: {
    readonly url: string;
    readonly token: string;
    readonly key: CryptoKey;
    /** Per-op overrides for OP_TIMEOUT_MS; tests use it to avoid real 10s waits. */
    readonly timeouts?: Partial<Record<RequestOp, number>>;
    /** Socket construction, injected so tests can pass runtime-specific options. */
    readonly createSocket?: (url: string) => WebSocket;
    /** Override for SETTLE_MS; tests use it to avoid a real 1.5s wait. */
    readonly settleMs?: number;
    /** Overrides for the shared heartbeat cadence; tests use them to avoid real 30s beats. */
    readonly pingIntervalMs?: number;
    readonly pongTimeoutMs?: number;
    /** deviceIds removed in an earlier run; a reload must not resurrect them. */
    readonly hidden?: readonly string[];
  }) {
    this.#url = opts.url;
    this.#token = opts.token;
    this.#key = opts.key;
    this.#timeouts = opts.timeouts ?? {};
    this.#createSocket = opts.createSocket ?? ((url) => new WebSocket(url));
    this.#settleMs = opts.settleMs ?? SETTLE_MS;
    this.#pingIntervalMs = opts.pingIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.#pongTimeoutMs = opts.pongTimeoutMs ?? HEARTBEAT_PONG_TIMEOUT_MS;
    this.#hidden = new Set(opts.hidden ?? []);
  }

  #timeoutFor(op: RequestOp): number {
    return this.#timeouts[op] ?? OP_TIMEOUT_MS[op];
  }

  getState = (): RelayState => this.#state;

  /**
   * Drops an offline machine from the list until it connects again. Connected ones
   * are unhidden by the very next rebuild, so calling this on one is a no-op.
   */
  hide(deviceId: string): void {
    if (this.#hidden.has(deviceId)) return;
    this.#hidden.add(deviceId);
    this.#rebuildMachines();
  }

  /**
   * Folds a `rescan` reply into the machine it came from. Sealed with the same
   * key as the `machine-info` blob and strictly fresher than it, so it stands in
   * for that blob's repo list until a register carries the scan itself.
   */
  applyScan(deviceId: string, repos: readonly RepoEntry[], scannedAt: number): void {
    this.#scans.set(deviceId, { repos, scannedAt });
    this.#rebuildMachines();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#clearSettle();
    this.#teardownHeartbeat();
    // Leaving the settle window set would strand the screen on "connecting…" for as
    // long as the client stays stopped, which is the one thing it is certainly not.
    this.#patch({ settling: false });
    this.#socket?.close();
    this.#socket = null;
    this.#failAllPending(new RequestFailure("disconnected", "client stopped"));
  }

  /** Reconnects now, skipping any pending backoff. */
  reconnect(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#attempt = 0;
    this.#teardownHeartbeat();
    // Detached before closing, or a close dispatched synchronously still passes the
    // identity guard and runs the backoff path — arming a second retry chain and
    // reporting the deliberate swap as a drop.
    const previous = this.#socket;
    this.#socket = null;
    previous?.close();
    this.#stopped = false;
    this.#connect();
  }

  async request<T>(deviceId: string, op: RequestOp, payload: unknown): Promise<T> {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      throw new RequestFailure("disconnected", "no socket to the relay");
    }
    const id = crypto.randomUUID();
    const plain: Plain = { id, ts: Date.now(), op, payload };
    const env = await seal(this.#key, { to: deviceId, from: APP_ID }, plain);
    // Sealing is async, so the socket can die in the gap. Without this the request
    // would sit in #pending until its own timeout — 90s for a spawn.
    if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) {
      throw new RequestFailure("disconnected", "the relay socket closed while the request was being sealed");
    }

    return new Promise<T>((resolve, reject) => {
      const limit = this.#timeoutFor(op);
      const sentAt = Date.now();
      const timer = setTimeout(() => {
        wireLog("timeout", `iv=${quote(env.iv)} id=${quote(id)} op=${quote(op)} after=${limit}ms`);
        this.#discard(id);
        // Blame the machine only when the uplink demonstrably worked while the
        // request was out: same socket, and at least one frame (a pong counts)
        // received since the send. A silently dead app socket looks exactly like
        // a silent machine from here, and marking on that guess paints every
        // polled machine asleep at once.
        if (this.#socket === socket && this.#lastFrameAt >= sentAt) this.#markProvenOffline(deviceId);
        reject(new RequestFailure("timeout", `${op} timed out after ${limit}ms`));
      }, limit);

      this.#pending.set(id, {
        iv: env.iv,
        timer,
        settle: (result) => {
          this.#discard(id);
          if (result.ok) resolve(result.payload as T);
          else reject(result.error);
        },
      });
      this.#idByIv.set(env.iv, id);
      socket.send(JSON.stringify({ t: "msg", env }));
      // A probe: its pong (answered at the edge) is the uplink evidence the blame
      // check above needs, without waiting for the next 30s heartbeat beat. A
      // healthy socket produces it within an RTT; a dead one produces nothing.
      socket.send("ping");
      wireLog("send", `iv=${quote(env.iv)} id=${quote(id)} op=${quote(op)} to=${quote(deviceId)}`);
    });
  }

  #discard(id: string): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    this.#idByIv.delete(pending.iv);
  }

  #failAllPending(error: RequestFailure): void {
    for (const [id, pending] of [...this.#pending]) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      this.#idByIv.delete(pending.iv);
      pending.settle({ ok: false, error });
    }
  }

  #connect(): void {
    if (this.#stopped) return;
    const url = new URL(this.#url);
    url.searchParams.set(TOKEN_PARAM, this.#token);
    const socket = this.#createSocket(url.href);
    this.#socket = socket;
    this.#patchDown(this.#attempt === 0 ? "connecting" : "retrying");

    socket.addEventListener("open", () => {
      this.#attempt = 0;
      this.#clearSettle();
      this.#startHeartbeat(socket);
      this.#patch({ status: "open", rejection: null, settling: false });
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      // Stale sockets don't count: their late frames say nothing about this one.
      if (this.#socket === socket) this.#lastFrameAt = Date.now();
      if (event.data === "pong") {
        if (this.#pongDeadline !== null) clearTimeout(this.#pongDeadline);
        this.#pongDeadline = null;
        return;
      }
      void this.#onFrame(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#teardownHeartbeat();
      this.#failAllPending(new RequestFailure("disconnected", "the relay socket closed"));
      this.#onClose(event.code);
    });
  }

  #onClose(code: number): void {
    // A rejected token is permanent: retrying forever would only hide the reason.
    if (code === CLOSE_UNAUTHORIZED || code === CLOSE_BAD_REQUEST) {
      this.#stopped = true;
      this.#clearSettle();
      this.#patch({
        status: "rejected",
        rejection: code === CLOSE_UNAUTHORIZED ? "unauthorized" : "bad-request",
        settling: false,
      });
      return;
    }
    if (this.#stopped) return;
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.#attempt);
    this.#attempt += 1;
    this.#patchDown("retrying");
    this.#retryTimer = setTimeout(() => this.#connect(), delay * (0.5 + Math.random() / 2));
  }

  /**
   * Reports a status other than `open`, holding it back for SETTLE_MS if this is the
   * moment the socket went away. A retry inside a window already declared over is
   * shown at once, so backoff never makes the banner blink.
   */
  #patchDown(status: "connecting" | "retrying"): void {
    const settling = this.#state.settling || this.#state.status === "open";
    this.#patch({ status, settling });
    if (!settling || this.#settleTimer !== null) return;
    this.#settleTimer = setTimeout(() => {
      this.#settleTimer = null;
      this.#patch({ settling: false });
    }, this.#settleMs);
  }

  #clearSettle(): void {
    if (this.#settleTimer !== null) clearTimeout(this.#settleTimer);
    this.#settleTimer = null;
  }

  /**
   * The relay pushes presence rather than being polled, so a silently dead app
   * socket freezes the machine list with no other symptom. Pings bound that: a
   * missed pong re-dials, and the fresh socket gets a fresh registry.
   */
  #startHeartbeat(socket: WebSocket): void {
    this.#teardownHeartbeat();
    this.#pingTimer = setInterval(() => {
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send("ping");
      this.#pongDeadline ??= setTimeout(() => {
        this.#pongDeadline = null;
        if (this.#socket !== socket) return;
        wireLog("heartbeat", `no pong within ${this.#pongTimeoutMs}ms`);
        // reconnect() rather than close(): closing a dead peer waits out the
        // closing handshake, and pending requests can still complete over the
        // new socket — replies fan out to every open app socket.
        this.reconnect();
      }, this.#pongTimeoutMs);
    }, this.#pingIntervalMs);
  }

  #teardownHeartbeat(): void {
    if (this.#pingTimer !== null) clearInterval(this.#pingTimer);
    if (this.#pongDeadline !== null) clearTimeout(this.#pongDeadline);
    this.#pingTimer = null;
    this.#pongDeadline = null;
  }

  async #onFrame(text: string): Promise<void> {
    const frame = parseFrame(text);
    if (frame === null) return;
    if (frame.t === "registry") {
      await this.#onRegistry(frame.entries);
      return;
    }
    if (frame.t === "undeliverable") {
      this.#onUndeliverable(frame.to, frame.iv, frame.code);
      return;
    }
    await this.#onMessage(frame.env);
  }

  #onUndeliverable(to: string, iv: string, code: UndeliverableCode): void {
    if (code === "offline") this.#markProvenOffline(to);
    const id = this.#idByIv.get(iv);
    // `code` is relay-supplied and `parseFrame` does not narrow it, so it is quoted
    // like every other wire value rather than trusted to be one of the two codes.
    wireLog("undeliverable", `iv=${quote(iv)} id=${quote(id ?? "")} to=${quote(to)} code=${quote(code)}`);
    if (id === undefined) return;
    this.#pending.get(id)?.settle({
      ok: false,
      error: new RequestFailure(code, code === "offline" ? "that machine is not connected" : "unknown machine"),
    });
  }

  #markProvenOffline(deviceId: string): void {
    const entry = this.#entries.find((candidate) => candidate.deviceId === deviceId);
    this.#provenOffline.set(deviceId, entry?.lastSeen ?? 0);
    this.#rebuildMachines();
  }

  async #onMessage(env: Envelope): Promise<void> {
    let plain: Plain;
    try {
      plain = await openEnvelope(this.#key, env);
    } catch {
      // Not ours to read: a stale PSK somewhere, or traffic for another key.
      wireLog("dropped", `iv=${quote(env.iv)} reason=unopenable`);
      return;
    }
    // Decryption authenticates the sender — `from` is AAD-bound — so this alone
    // proves the machine is alive: fresher evidence than any mark a timeout left.
    // Deliberately ahead of the replay guard. A phone off NTP rejects every reply
    // below as replay; gating the clear on that check would strand every machine
    // it touches offline instead of merely timing out. A replayed frame can at
    // worst fake presence for a moment, and the next failed delivery re-marks it.
    if (this.#provenOffline.delete(env.from)) this.#rebuildMachines();
    try {
      this.#guard.check(env.iv, plain.ts);
    } catch {
      // A phone more than REPLAY_WINDOW_MS off NTP lands here for every reply
      // while the registry still renders every machine online, so every request
      // ends in `wire timeout`. Without this line that has no other symptom.
      wireLog("dropped", `iv=${quote(env.iv)} re=${quote(plain.re ?? "")} reason=replay`);
      return;
    }
    // Replies fan out to every open app socket, so another tab's are expected here.
    if (plain.re === undefined) return;
    // Logged before the lookup: an unmatched `re` is the late reply to a request
    // that already timed out, and "arrived late" vs "never came" is the whole
    // point of the ids. Another tab's reply lands here too, hence `pending`.
    const pending = this.#pending.get(plain.re);
    wireLog(
      "recv",
      `iv=${quote(env.iv)} re=${quote(plain.re)} op=${quote(plain.op)} pending=${pending === undefined ? "no" : "yes"}`,
    );
    pending?.settle({ ok: true, payload: plain.payload });
  }

  async #onRegistry(entries: readonly RegistryView[]): Promise<void> {
    this.#entries = entries;
    await Promise.all(entries.map((entry) => this.#decryptInfo(entry.info)));
    this.#rebuildMachines();
  }

  /**
   * `machine-info` blobs are data at rest, not live messages: `scannedAt` can be
   * days old and the identical envelope arrives on every push, so the replay
   * guard must not see them.
   */
  async #decryptInfo(env: Envelope): Promise<MachineInfo | null> {
    const cached = this.#infoCache.get(env.iv);
    if (cached !== undefined) return cached;
    try {
      const plain = await openEnvelope(this.#key, env);
      const info = plain.payload as MachineInfo;
      this.#infoCache.set(env.iv, info);
      return info;
    } catch {
      this.#infoCache.set(env.iv, null);
      return null;
    }
  }

  #rebuildMachines(): void {
    const machines: Machine[] = [];
    let hiddenHere = 0;
    for (const entry of this.#entries) {
      const info = this.#infoCache.get(entry.info.iv) ?? null;
      if (info === null) continue;
      const scan = this.#scans.get(entry.deviceId);
      // A register that carries the scan (or a later one) makes the override spent.
      if (scan !== undefined && scan.scannedAt <= info.scannedAt) this.#scans.delete(entry.deviceId);
      const scanned = scan !== undefined && scan.scannedAt > info.scannedAt ? scan : info;
      const markedAt = this.#provenOffline.get(entry.deviceId);
      // Cleared by a later register, which is the one event that moves lastSeen up.
      const stillProvenOffline = markedAt !== undefined && entry.lastSeen <= markedAt;
      if (!stillProvenOffline) this.#provenOffline.delete(entry.deviceId);
      const connected = entry.connected && !stillProvenOffline;
      if (connected) this.#hidden.delete(entry.deviceId);
      else if (this.#hidden.has(entry.deviceId)) {
        hiddenHere += 1;
        continue;
      }
      machines.push({
        deviceId: entry.deviceId,
        name: info.name,
        platform: info.platform,
        repos: scanned.repos,
        scannedAt: scanned.scannedAt,
        lastSeen: entry.lastSeen,
        connected,
      });
    }
    this.#patch({
      machines,
      registrySize: this.#entries.length,
      hidden: [...this.#hidden],
      // Counted off entries the registry actually holds, so a removal never reads as a key mismatch.
      ignored: this.#entries.length - machines.length - hiddenHere,
    });
  }

  #patch(next: Partial<RelayState>): void {
    this.#state = { ...this.#state, ...next };
    for (const listener of this.#listeners) listener();
  }
}
