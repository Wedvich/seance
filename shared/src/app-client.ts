import {
  APP_ID,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PONG_TIMEOUT_MS,
  CLOSE_BAD_REQUEST,
  CLOSE_UNAUTHORIZED,
  OP_TIMEOUT_MS,
  TOKEN_PARAM,
  type AppFrame,
  type Envelope,
  type MachineInfo,
  type Plain,
  type RegistryView,
  type RepoEntry,
  type RequestOp,
  type RescanResponse,
  type UndeliverableCode,
} from "./types.ts";
import { isRecord, parseEnvelope, parseMachineInfo, parseRescanResponse } from "./parse.ts";
import { open as openEnvelope, ReplayGuard, seal } from "./crypto.ts";
import { quote } from "./fmt.ts";

export type RelayStatus = "connecting" | "open" | "retrying" | "rejected";

/**
 * Why a request will never get an answer. "refused" is an `undeliverable` whose
 * code this build does not know: what it means is unknown, but that the relay
 * declined delivery is not — the request certainly did not land.
 */
export type FailureReason = UndeliverableCode | "refused" | "timeout" | "disconnected";

export class RequestFailure extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
  ) {
    super(message);
    this.name = "RequestFailure";
  }
}

/**
 * The one line per failure reason every surface shows, shared so `seanced mcp`,
 * the Raycast extension and any later app-role client explain a reason the same
 * way. Callers add their own op/title framing around it.
 */
export function failureReasonText(failure: RequestFailure): string {
  switch (failure.reason) {
    case "offline":
      return "that machine is not connected to the relay";
    case "unknown":
      return "the relay has never seen that machine";
    case "disconnected":
      return "lost the relay connection before the request went out";
    // The message already names the code the relay sent; no fixed line could.
    case "refused":
      return failure.message;
    // The one outcome that is genuinely unknown: the request went out and no
    // answer came back, so it may have landed anyway. Saying "failed" flatly
    // would be a lie — and an invitation to fire a duplicate.
    case "timeout":
      return `${failure.message} — the machine may be asleep, or the request may have landed anyway`;
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
  /** Entries whose `info` decrypted; the list the app shows. */
  readonly machines: readonly Machine[];
  /** Total entries the relay holds, including any that did not decrypt. */
  readonly registrySize: number;
  /** Entries whose info blob did not decrypt with this key — a stale PSK somewhere. */
  readonly ignored: number;
  /**
   * Entries this build cannot read for a reason no key rotation fixes: a blob
   * that opened but was not shaped like a MachineInfo, or a registry entry that
   * did not parse at all — version skew, surfaced apart from `ignored` so the
   * UI never sends anyone to check a correct key.
   */
  readonly skewed: number;
  /**
   * The socket is not open, but too briefly to be worth reporting yet. Set from the
   * moment `open` is left until SETTLE_MS later, and never re-armed by a retry that
   * follows one — once the drop has been shown it stays shown.
   */
  readonly settling: boolean;
  /**
   * True once this socket's registry is authoritative: its first registry frame
   * has landed, or REGISTRY_SETTLE_MS passed after `open` without one. While
   * false under an open socket, an empty `machines` means "no push yet", never
   * "every machine vanished". Reset whenever the socket leaves `open`.
   */
  readonly registrySettled: boolean;
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

/**
 * How long after `open` to wait for the registry push before declaring the
 * (possibly empty) machine list authoritative anyway. The relay pushes the
 * registry on every app connect, so the timer is a bound for the abnormal case,
 * not the expected path. Lives here, not in consumers: the client sees every
 * registry frame — including an empty one, which pushes no state change a
 * subscriber could await.
 */
const REGISTRY_SETTLE_MS = 1_500;

const INITIAL_STATE: RelayState = {
  status: "connecting",
  rejection: null,
  machines: [],
  registrySize: 0,
  ignored: 0,
  skewed: 0,
  settling: true,
  registrySettled: false,
};

interface Pending {
  readonly iv: string;
  readonly settle: (result: { ok: true; payload: unknown } | { ok: false; error: RequestFailure }) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function isUndeliverableCode(value: unknown): value is UndeliverableCode {
  return value === "offline" || value === "unknown";
}

function parseRegistryView(value: unknown): RegistryView | null {
  if (!isRecord(value)) return null;
  const info = parseEnvelope(value["info"]);
  if (info === null) return null;
  if (typeof value["deviceId"] !== "string" || typeof value["lastSeen"] !== "number") return null;
  if (typeof value["connected"] !== "boolean") return null;
  return { deviceId: value["deviceId"], info, lastSeen: value["lastSeen"], connected: value["connected"] };
}

/**
 * `RelayToAppFrame`, loosened where forward compatibility needs it: a registry
 * push carries how many entries were skipped instead of failing whole, and
 * `undeliverable.code` stays the raw string so a code minted after this build
 * can still fail its request fast.
 */
type ParsedFrame =
  | { readonly t: "registry"; readonly entries: readonly RegistryView[]; readonly skipped: number }
  | { readonly t: "msg"; readonly env: Envelope }
  | { readonly t: "undeliverable"; readonly to: string; readonly iv: string; readonly code: string }
  | { readonly t: "forget-refused"; readonly deviceId: string; readonly code: string };

/**
 * Every field the handlers below touch, checked here — bounds stay the relay's
 * job (`relay/src/wire.ts`), because what this side is defending is the tab.
 * The types are a promise the peer makes, and a peer that breaks it used to
 * wedge the app: a `registry` without `entries` threw mid-assignment and left
 * every later rebuild throwing on the same undefined list, dead until reload.
 * Unhandleable frames are dropped whole, never half-applied.
 */
function parseFrame(text: string): ParsedFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value["t"] === "registry") {
    const raw = value["entries"];
    if (!Array.isArray(raw)) return null;
    const entries: RegistryView[] = [];
    let skipped = 0;
    for (const candidate of raw) {
      const entry = parseRegistryView(candidate);
      // Skipped, not fatal: every push carries the full stored registry, so one
      // persistently unreadable entry would otherwise drop every push for as
      // long as it stays stored — an authoritative "no machines" out of one bad
      // machine. Counted so the skipped entry surfaces as skew, never vanishes.
      if (entry === null) {
        skipped += 1;
        continue;
      }
      entries.push(entry);
    }
    return { t: "registry", entries, skipped };
  }
  if (value["t"] === "msg") {
    const env = parseEnvelope(value["env"]);
    return env === null ? null : { t: "msg", env };
  }
  if (value["t"] === "undeliverable") {
    if (typeof value["to"] !== "string" || typeof value["iv"] !== "string") return null;
    // Carried raw rather than narrowed to the known set: the frame's two facts —
    // this request failed, that machine may be gone — hold whatever the code
    // says, and dropping an unrecognized one left the request riding its full
    // timeout (90s for a spawn) the relay had already answered.
    if (typeof value["code"] !== "string") return null;
    return { t: "undeliverable", to: value["to"], iv: value["iv"], code: value["code"] };
  }
  if (value["t"] === "forget-refused") {
    // Raw code for the same reason as `undeliverable`: a refusal minted after
    // this build still says the entry is still there, which is the whole fact.
    if (typeof value["deviceId"] !== "string" || typeof value["code"] !== "string") return null;
    return { t: "forget-refused", deviceId: value["deviceId"], code: value["code"] };
  }
  return null;
}

/** No deep walk needed: `repos` comes off the IV-keyed info cache, so it compares by identity. */
function sameMachine(a: Machine, b: Machine): boolean {
  return (
    a.deviceId === b.deviceId &&
    a.name === b.name &&
    a.platform === b.platform &&
    a.repos === b.repos &&
    a.scannedAt === b.scannedAt &&
    a.lastSeen === b.lastSeen &&
    a.connected === b.connected
  );
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
  /**
   * Decrypted `info` by envelope IV; blobs are re-sent verbatim on every push.
   * "unopenable" is a blob sealed with a key this app doesn't hold (`ignored`);
   * "skewed" one that opened but was not shaped like a MachineInfo. Rebuilt from
   * each push's own IVs in `#onRegistry`, so cache ⊆ registry holds by
   * construction — every register mints a fresh IV, and an installed PWA left
   * open for weeks would otherwise hold every blob it ever saw.
   */
  #infoCache = new Map<string, MachineInfo | "unopenable" | "skewed">();
  /**
   * Entries the last accepted push carried that did not parse. Folded into
   * `registrySize` and `skewed`, so a machine a version ahead reads as skew on
   * screen rather than as a machine that was never installed.
   */
  #skippedEntries = 0;
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
  readonly #scans = new Map<string, RescanResponse>();
  #entries: readonly RegistryView[] = [];
  #state: RelayState = INITIAL_STATE;
  #socket: WebSocket | null = null;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #settleTimer: ReturnType<typeof setTimeout> | null = null;
  #registrySettleTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #pongDeadline: ReturnType<typeof setTimeout> | null = null;
  /** When the current socket last delivered anything — pong or frame. Uplink evidence for timeout blame. */
  #lastFrameAt = 0;
  #stopped = false;

  readonly #timeouts: Partial<Record<RequestOp, number>>;
  readonly #createSocket: (url: string) => WebSocket;
  readonly #settleMs: number;
  readonly #registrySettleMs: number;
  readonly #pingIntervalMs: number;
  readonly #pongTimeoutMs: number;
  readonly #log: (line: string) => void;

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
    /** Override for REGISTRY_SETTLE_MS; tests use it to avoid a real 1.5s wait. */
    readonly registrySettleMs?: number;
    /** Overrides for the shared heartbeat cadence; tests use them to avoid real 30s beats. */
    readonly pingIntervalMs?: number;
    readonly pongTimeoutMs?: number;
    /** Wire-log sink. Defaults to stdout; a consumer whose stdout is spoken for (the MCP server's JSON-RPC) passes its own. */
    readonly log?: (line: string) => void;
  }) {
    this.#url = opts.url;
    this.#token = opts.token;
    this.#key = opts.key;
    this.#timeouts = opts.timeouts ?? {};
    this.#createSocket = opts.createSocket ?? ((url) => new WebSocket(url));
    this.#settleMs = opts.settleMs ?? SETTLE_MS;
    this.#registrySettleMs = opts.registrySettleMs ?? REGISTRY_SETTLE_MS;
    this.#pingIntervalMs = opts.pingIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.#pongTimeoutMs = opts.pongTimeoutMs ?? HEARTBEAT_PONG_TIMEOUT_MS;
    this.#log = opts.log ?? ((line) => console.log(line));
  }

  /**
   * Same shape the daemon and relay emit, so one grep spans all three tiers. The
   * `iv` is what the blind relay can name; the `id`/`re` beside it is what only
   * the two encrypting ends can read. Ships in production builds — a phone-only
   * failure is the one that cannot be reproduced at a desk. Never the payload.
   */
  #wireLog(event: string, detail: string): void {
    this.#log(`wire ${event} ${detail}`);
  }

  #timeoutFor(op: RequestOp): number {
    return this.#timeouts[op] ?? OP_TIMEOUT_MS[op];
  }

  getState = (): RelayState => this.#state;

  /**
   * Deletes a machine's registry entry at the relay, for every app rather than
   * just this one. Fire-and-forget: the registry push the relay sends back is
   * the acknowledgement, and a refusal (the machine turned out to be connected)
   * arrives as its own frame and is logged, not modelled — the entry the caller
   * can see is what says whether it worked. Nothing happens with no socket; the
   * relay is the only place the list lives.
   */
  forget(deviceId: string): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      this.#wireLog("dropped", `forget=${quote(deviceId)} reason=disconnected`);
      return;
    }
    const frame: AppFrame = { t: "forget", deviceId };
    socket.send(JSON.stringify(frame));
    this.#wireLog("forget", `to=${quote(deviceId)}`);
  }

  /**
   * Folds a `rescan` reply into the machine it came from. Sealed with the same
   * key as the `machine-info` blob and strictly fresher than it, so it stands in
   * for that blob's repo list until a register carries the scan itself. Takes
   * the raw reply and validates it here rather than trusting the request's type
   * parameter: the fields land on `machine.repos`/`scannedAt` and render every
   * frame, so an unchecked reply from a daemon a version ahead is the register
   * wedge by another door. Null means the reply was unreadable and nothing was
   * applied — callers report it as a failed rescan.
   */
  applyScan(deviceId: string, reply: unknown): RescanResponse | null {
    const parsed = parseRescanResponse(reply);
    if (parsed === null) {
      this.#wireLog("dropped", `from=${quote(deviceId)} reason=rescan-shape`);
      return null;
    }
    this.#scans.set(deviceId, parsed);
    this.#rebuildMachines();
    return parsed;
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
    this.#clearRegistrySettle();
    this.#teardownHeartbeat();
    // Leaving the settle window set would strand the screen on "connecting…" for as
    // long as the client stays stopped, which is the one thing it is certainly not.
    this.#patch({ settling: false, registrySettled: false });
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
        this.#wireLog("timeout", `iv=${quote(env.iv)} id=${quote(id)} op=${quote(op)} after=${limit}ms`);
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
      this.#wireLog("send", `iv=${quote(env.iv)} id=${quote(id)} op=${quote(op)} to=${quote(deviceId)}`);
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
      this.#patch({ status: "open", rejection: null, settling: false, registrySettled: false });
      this.#armRegistrySettle(socket);
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
      this.#clearRegistrySettle();
      this.#patch({
        status: "rejected",
        rejection: code === CLOSE_UNAUTHORIZED ? "unauthorized" : "bad-request",
        settling: false,
        registrySettled: false,
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
    this.#clearRegistrySettle();
    const settling = this.#state.settling || this.#state.status === "open";
    this.#patch({ status, settling, registrySettled: false });
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

  #armRegistrySettle(socket: WebSocket): void {
    this.#clearRegistrySettle();
    this.#registrySettleTimer = setTimeout(() => {
      this.#registrySettleTimer = null;
      if (this.#socket !== socket) return;
      this.#patch({ registrySettled: true });
    }, this.#registrySettleMs);
  }

  #clearRegistrySettle(): void {
    if (this.#registrySettleTimer !== null) clearTimeout(this.#registrySettleTimer);
    this.#registrySettleTimer = null;
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
        this.#wireLog("heartbeat", `no pong within ${this.#pongTimeoutMs}ms`);
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
    if (frame === null) {
      // Observable but contentless: the frame is peer-supplied text, so nothing
      // of it is echoed. One line per rejection is the only evidence a relay or
      // daemon that has moved past this build leaves behind.
      this.#wireLog("dropped", "reason=frame");
      return;
    }
    if (frame.t === "registry") {
      // The count is the only trace the skipped entries leave — parseFrame sees
      // peer-supplied text, so nothing of them is echoed.
      if (frame.skipped > 0) this.#wireLog("dropped", `reason=entry-shape count=${frame.skipped}`);
      await this.#onRegistry(frame.entries, frame.skipped);
      return;
    }
    if (frame.t === "undeliverable") {
      this.#onUndeliverable(frame.to, frame.iv, frame.code);
      return;
    }
    if (frame.t === "forget-refused") {
      // Only reachable as a race: the app offers removal for an offline machine
      // and this says the relay holds a live socket for it. Left to resolve
      // itself — either the machine really is up and the next push shows it, or
      // its socket is dead and the relay's sweep closes it within three beats.
      this.#wireLog("forget-refused", `to=${quote(frame.deviceId)} code=${quote(frame.code)}`);
      return;
    }
    await this.#onMessage(frame.env);
  }

  #onUndeliverable(to: string, iv: string, code: string): void {
    if (code === "offline") this.#markProvenOffline(to);
    const id = this.#idByIv.get(iv);
    // Quoted like every other wire value: `to`, `iv` and `code` are all relay-supplied text.
    this.#wireLog("undeliverable", `iv=${quote(iv)} id=${quote(id ?? "")} to=${quote(to)} code=${quote(code)}`);
    if (id === undefined) return;
    const error = isUndeliverableCode(code)
      ? new RequestFailure(code, code === "offline" ? "that machine is not connected" : "unknown machine")
      : new RequestFailure("refused", `the relay refused to deliver the request (code ${quote(code)})`);
    this.#pending.get(id)?.settle({ ok: false, error });
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
      this.#wireLog("dropped", `iv=${quote(env.iv)} reason=unopenable`);
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
      this.#wireLog("dropped", `iv=${quote(env.iv)} re=${quote(plain.re ?? "")} reason=replay`);
      return;
    }
    // Replies fan out to every open app socket, so another tab's are expected here.
    if (plain.re === undefined) return;
    // Logged before the lookup: an unmatched `re` is the late reply to a request
    // that already timed out, and "arrived late" vs "never came" is the whole
    // point of the ids. Another tab's reply lands here too, hence `pending`.
    const pending = this.#pending.get(plain.re);
    this.#wireLog(
      "recv",
      `iv=${quote(env.iv)} re=${quote(plain.re)} op=${quote(plain.op)} pending=${pending === undefined ? "no" : "yes"}`,
    );
    pending?.settle({ ok: true, payload: plain.payload });
  }

  async #onRegistry(entries: readonly RegistryView[], skipped: number): Promise<void> {
    this.#clearRegistrySettle();
    this.#entries = entries;
    this.#skippedEntries = skipped;
    // Replaced, not pruned: seeding a fresh map from this push's own IVs makes
    // cache ⊆ registry hold by construction. A slow decrypt from an older push
    // can still land one dead IV in the current map; the next push evicts it.
    const next = new Map<string, MachineInfo | "unopenable" | "skewed">();
    for (const entry of entries) {
      const hit = this.#infoCache.get(entry.info.iv);
      if (hit !== undefined) next.set(entry.info.iv, hit);
    }
    this.#infoCache = next;
    await Promise.all(entries.map((entry) => this.#decryptInfo(entry.info)));
    // Settled in the same patch as the machines it vouches for, so a subscriber
    // never observes an authoritative flag beside a stale list.
    this.#rebuildMachines({ registrySettled: true });
  }

  /**
   * `machine-info` blobs are data at rest, not live messages: `scannedAt` can be
   * days old and the identical envelope arrives on every push, so the replay
   * guard must not see them.
   */
  async #decryptInfo(env: Envelope): Promise<void> {
    if (this.#infoCache.has(env.iv)) return;
    try {
      const plain = await openEnvelope(this.#key, env);
      const info = parseMachineInfo(plain.payload);
      // Logged where an unopenable blob is not: an entry sealed with a key this
      // app doesn't hold is an expected steady state — it is what `ignored`
      // counts — while a blob that opened and then failed the shape check is
      // skew worth seeing. Named by sender, not by iv: a `machine-info` iv
      // repeats across every push, so it is no message identity here, and the
      // machine is what an operator can act on. Cached either way, so it is one
      // line per blob rather than one per push.
      if (info === null) this.#wireLog("dropped", `from=${quote(env.from)} reason=info-shape`);
      this.#infoCache.set(env.iv, info ?? "skewed");
    } catch {
      this.#infoCache.set(env.iv, "unopenable");
    }
  }

  #rebuildMachines(extra: Partial<RelayState> = {}): void {
    const previous = this.#state.machines;
    // Keyed, not positional: the relay lists entries in lexicographic deviceId
    // order, so a machine registering for the first time can land anywhere in
    // the list and shift every one after it.
    const priorById = new Map(previous.map((machine) => [machine.deviceId, machine]));
    const machines: Machine[] = [];
    let reused = 0;
    let skewedHere = 0;
    for (const entry of this.#entries) {
      const info = this.#infoCache.get(entry.info.iv);
      if (info === "skewed") {
        skewedHere += 1;
        continue;
      }
      if (info === undefined || info === "unopenable") continue;
      const scan = this.#scans.get(entry.deviceId);
      // A register that carries the scan (or a later one) makes the override spent.
      if (scan !== undefined && scan.scannedAt <= info.scannedAt) this.#scans.delete(entry.deviceId);
      const scanned = scan !== undefined && scan.scannedAt > info.scannedAt ? scan : info;
      const markedAt = this.#provenOffline.get(entry.deviceId);
      // Cleared by a later register, which is the one event that moves lastSeen up.
      const stillProvenOffline = markedAt !== undefined && entry.lastSeen <= markedAt;
      if (!stillProvenOffline) this.#provenOffline.delete(entry.deviceId);
      const connected = entry.connected && !stillProvenOffline;
      const built: Machine = {
        deviceId: entry.deviceId,
        name: info.name,
        platform: info.platform,
        repos: scanned.repos,
        scannedAt: scanned.scannedAt,
        lastSeen: entry.lastSeen,
        connected,
      };
      const prior = priorById.get(entry.deviceId);
      if (prior !== undefined && sameMachine(prior, built)) {
        // Counted only where it also lands on its old index, so the array below
        // is reused for an unchanged list and never for a merely reordered one.
        if (prior === previous[machines.length]) reused += 1;
        machines.push(prior);
      } else machines.push(built);
    }
    this.#patch({
      // Every push re-derives the whole list, and the app connect behind every
      // resume re-sends a registry that is usually identical. Handing back the
      // previous array is what lets #patch — and Preact — skip the render.
      machines: reused === machines.length && reused === previous.length ? previous : machines,
      registrySize: this.#entries.length + this.#skippedEntries,
      // Counted off entries the registry actually holds, so skew never reads as
      // a key mismatch.
      ignored: this.#entries.length - machines.length - skewedHere,
      skewed: skewedHere + this.#skippedEntries,
      ...extra,
    });
  }

  /** Same object back when nothing moved: `useState` bails out on reference equality. */
  #patch(next: Partial<RelayState>): void {
    const keys = Object.keys(next) as readonly (keyof RelayState)[];
    if (keys.every((key) => Object.is(this.#state[key], next[key]))) return;
    this.#state = { ...this.#state, ...next };
    for (const listener of this.#listeners) listener();
  }
}
