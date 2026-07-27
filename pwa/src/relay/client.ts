import {
  APP_ID,
  CLOSE_BAD_REQUEST,
  CLOSE_UNAUTHORIZED,
  open as openEnvelope,
  OP_TIMEOUT_MS,
  ReplayGuard,
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
  readonly machines: readonly Machine[];
  /** Total entries the relay holds, including any that did not decrypt. */
  readonly registrySize: number;
  /** registrySize minus machines.length — a stale PSK somewhere. */
  readonly ignored: number;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 15_000;

const INITIAL_STATE: RelayState = {
  status: "connecting",
  rejection: null,
  machines: [],
  registrySize: 0,
  ignored: 0,
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
   * deviceId -> the lastSeen we held when the relay called it undeliverable.
   * `connected` is derived from live sockets and can read true over an abruptly
   * slept machine, so a refused delivery is the better evidence until that
   * machine registers again.
   */
  readonly #provenOffline = new Map<string, number>();

  #entries: readonly RegistryView[] = [];
  #state: RelayState = INITIAL_STATE;
  #socket: WebSocket | null = null;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  readonly #timeouts: Partial<Record<RequestOp, number>>;
  readonly #createSocket: (url: string) => WebSocket;

  constructor(opts: {
    readonly url: string;
    readonly token: string;
    readonly key: CryptoKey;
    /** Per-op overrides for OP_TIMEOUT_MS; tests use it to avoid real 10s waits. */
    readonly timeouts?: Partial<Record<RequestOp, number>>;
    /** Socket construction, injected so tests can pass runtime-specific options. */
    readonly createSocket?: (url: string) => WebSocket;
  }) {
    this.#url = opts.url;
    this.#token = opts.token;
    this.#key = opts.key;
    this.#timeouts = opts.timeouts ?? {};
    this.#createSocket = opts.createSocket ?? ((url) => new WebSocket(url));
  }

  #timeoutFor(op: RequestOp): number {
    return this.#timeouts[op] ?? OP_TIMEOUT_MS[op];
  }

  getState = (): RelayState => this.#state;

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
    this.#socket?.close();
    this.#socket = null;
    this.#failAllPending(new RequestFailure("disconnected", "client stopped"));
  }

  /** Reconnects now, skipping any pending backoff. */
  reconnect(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#attempt = 0;
    this.#socket?.close();
    this.#socket = null;
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
      const timer = setTimeout(() => {
        this.#discard(id);
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
    this.#patch({ status: this.#attempt === 0 ? "connecting" : "retrying" });

    socket.addEventListener("open", () => {
      this.#attempt = 0;
      this.#patch({ status: "open", rejection: null });
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") void this.#onFrame(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#failAllPending(new RequestFailure("disconnected", "the relay socket closed"));
      this.#onClose(event.code);
    });
  }

  #onClose(code: number): void {
    // A rejected token is permanent: retrying forever would only hide the reason.
    if (code === CLOSE_UNAUTHORIZED || code === CLOSE_BAD_REQUEST) {
      this.#stopped = true;
      this.#patch({
        status: "rejected",
        rejection: code === CLOSE_UNAUTHORIZED ? "unauthorized" : "bad-request",
      });
      return;
    }
    if (this.#stopped) return;
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.#attempt);
    this.#attempt += 1;
    this.#patch({ status: "retrying" });
    this.#retryTimer = setTimeout(() => this.#connect(), delay * (0.5 + Math.random() / 2));
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
    if (code === "offline") {
      const entry = this.#entries.find((candidate) => candidate.deviceId === to);
      this.#provenOffline.set(to, entry?.lastSeen ?? 0);
      this.#rebuildMachines();
    }
    const id = this.#idByIv.get(iv);
    if (id === undefined) return;
    this.#pending.get(id)?.settle({
      ok: false,
      error: new RequestFailure(code, code === "offline" ? "that machine is not connected" : "unknown machine"),
    });
  }

  async #onMessage(env: Envelope): Promise<void> {
    let plain: Plain;
    try {
      plain = await openEnvelope(this.#key, env);
    } catch {
      // Not ours to read: a stale PSK somewhere, or traffic for another key.
      return;
    }
    try {
      this.#guard.check(env.iv, plain.ts);
    } catch {
      return;
    }
    // Replies fan out to every open app socket, so another tab's are expected here.
    if (plain.re === undefined) return;
    this.#pending.get(plain.re)?.settle({ ok: true, payload: plain.payload });
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
    for (const entry of this.#entries) {
      const info = this.#infoCache.get(entry.info.iv) ?? null;
      if (info === null) continue;
      const markedAt = this.#provenOffline.get(entry.deviceId);
      // Cleared by a later register, which is the one event that moves lastSeen up.
      const stillProvenOffline = markedAt !== undefined && entry.lastSeen <= markedAt;
      if (!stillProvenOffline) this.#provenOffline.delete(entry.deviceId);
      machines.push({
        deviceId: entry.deviceId,
        name: info.name,
        platform: info.platform,
        repos: info.repos,
        scannedAt: info.scannedAt,
        lastSeen: entry.lastSeen,
        connected: entry.connected && !stillProvenOffline,
      });
    }
    this.#patch({
      machines,
      registrySize: this.#entries.length,
      ignored: this.#entries.length - machines.length,
    });
  }

  #patch(next: Partial<RelayState>): void {
    this.#state = { ...this.#state, ...next };
    for (const listener of this.#listeners) listener();
  }
}
