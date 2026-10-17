import {
  appRelayUrl,
  RelayClient,
  REGISTRY_SETTLE_MS,
  type ErrorResponse,
  type QueueReply,
  type SchedulerEventHandler,
  type RelayState,
  type RequestOp,
  type SubmitReply,
  type TaskRequest,
} from "@seance/shared";
import type { Config } from "./config.ts";

/**
 * The app-role relay connection, lazily dialled and shared — neutral ground
 * between `seanced mcp`, which dials with a key it resolved itself, and the
 * daemon's broker, which dials with the key it already imported at start.
 *
 * Nothing here logs on its own: the MCP server's stdout is its JSON-RPC
 * channel, so the wire-log sink is always the caller's choice.
 */

/**
 * The slice of the shared app-role RelayClient the consumers use — injectable
 * so tests can drive them without a socket. The relay is a network boundary;
 * the client itself is exercised against the real one in e2e.
 */
export interface AppRelay {
  readonly start: () => void;
  readonly stop: () => void;
  readonly getState: () => RelayState;
  readonly subscribe: (listener: () => void) => () => void;
  /** As `RelayClient.request`: any op may answer with an `ErrorResponse`. */
  readonly request: <T>(deviceId: string, op: RequestOp, payload: unknown) => Promise<T | ErrorResponse>;
  /** As `RelayClient.submit`: refused before sending unless a verified leader is nominated. */
  readonly submit: (request: TaskRequest) => Promise<SubmitReply | null>;
  readonly queue: () => Promise<QueueReply | null>;
}

/**
 * A Claude session can sit open for hours between tool calls, so the socket
 * dials on the first call and hangs up after this much silence rather than
 * holding an app socket per session. Comfortably past the longest op timeout
 * (spawn, 90s), so the line never drops under an in-flight call — and the
 * in-flight count below guards that anyway.
 */
export const IDLE_MS = 5 * 60_000;

/** Bounds `acquire` when the relay is down; past it the call fails instead of riding the backoff forever. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** Over the client's own settle window, for the socket hop and scheduling. */
const SETTLE_MARGIN_MS = 1_000;

export interface LazyRelayOpts {
  /**
   * Async because `seanced mcp` resolves the PSK here rather than at startup:
   * local ops need no key, so only a remote op pays for resolving it. The
   * daemon's broker passes a client built over the key it already holds.
   */
  readonly create: () => AppRelay | Promise<AppRelay>;
  readonly idleMs?: number;
  readonly connectTimeoutMs?: number;
  /** Bounds the registry wait after open; tests shorten it. */
  readonly registrySettleMs?: number;
}

/**
 * Lazy-connect wrapper: `acquire` before a call, `release` after. The client
 * connects on first use, is shared by concurrent calls, and is stopped once
 * idle — the next call redials and gets a fresh registry push.
 */
export class LazyRelay {
  readonly #opts: LazyRelayOpts;
  #client: AppRelay | null = null;
  #connecting: Promise<AppRelay> | null = null;
  #inFlight = 0;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(opts: LazyRelayOpts) {
    this.#opts = opts;
  }

  async acquire(): Promise<AppRelay> {
    if (this.#stopped) throw new Error("the relay client is stopped");
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.#inFlight += 1;
    try {
      // A 4401/4400 after open leaves the client rejected for good: it never
      // redials by itself, and steady use would keep the idle timer from ever
      // dropping it, so every call would fail until the daemon restarted.
      if (this.#client?.getState().status === "rejected") {
        this.#client.stop();
        this.#client = null;
      }
      if (this.#client !== null) return this.#client;
      // Cleared by the connect itself, so a failure never leaves later callers
      // joining a dead attempt.
      this.#connecting ??= this.#connect().finally(() => {
        this.#connecting = null;
      });
      return await this.#connecting;
    } catch (err) {
      this.#inFlight -= 1;
      throw err;
    }
  }

  release(): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    if (this.#inFlight > 0 || this.#client === null) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (this.#inFlight > 0) return;
      this.#client?.stop();
      this.#client = null;
    }, this.#opts.idleMs ?? IDLE_MS);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.#client?.stop();
    this.#client = null;
  }

  async #connect(): Promise<AppRelay> {
    // Awaited before `start()`, so a create that throws — an unresolvable PSK —
    // propagates with nothing to tear down.
    const client = await this.#opts.create();
    client.start();
    try {
      await this.#waitOpen(client);
      await this.#settleRegistry(client);
      // stop() may have raced this connect; adopting the client now would
      // leak its socket and heartbeat with no owner left to stop them.
      if (this.#stopped) throw new Error("stopped while connecting to the relay");
    } catch (err) {
      client.stop();
      throw err;
    }
    this.#client = client;
    return client;
  }

  /**
   * Resolves once `ready` holds. A rejection is terminal and the relay delivers
   * it by accepting the upgrade and then closing 4401, so a wait that only
   * watches for its success state would sit through open → rejected forever.
   */
  async #until(
    client: AppRelay,
    ready: (state: RelayState) => boolean,
    timeoutMs: number,
    timeoutText: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(timeoutText));
      }, timeoutMs);
      // Referenced from the closures above and below, assigned before either can run:
      // the timer is async and check() is only called after subscribe returns.
      const check = (): void => {
        const state = client.getState();
        if (state.status === "rejected") {
          clearTimeout(timer);
          unsubscribe();
          reject(
            new Error(
              state.rejection === "unauthorized"
                ? "the relay rejected the bearer token — check bearerToken in config.json"
                : "the relay rejected the connection as malformed",
            ),
          );
        } else if (ready(state)) {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      };
      const unsubscribe = client.subscribe(check);
      check();
    });
  }

  async #waitOpen(client: AppRelay): Promise<void> {
    const ms = this.#opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    await this.#until(client, (state) => state.status === "open", ms, `the relay did not answer within ${ms}ms`);
  }

  /**
   * Waits for the client to mark this socket's registry authoritative. The
   * client flips `registrySettled` within REGISTRY_SETTLE_MS of `open`, but a
   * socket that drops in between never settles, so this carries its own bound.
   */
  async #settleRegistry(client: AppRelay): Promise<void> {
    const ms = this.#opts.registrySettleMs ?? REGISTRY_SETTLE_MS + SETTLE_MARGIN_MS;
    await this.#until(
      client,
      (state) => state.registrySettled,
      ms,
      `the relay did not settle its registry within ${ms}ms`,
    );
  }
}

/**
 * The shared app-role client, configured the way every daemon-side consumer
 * needs it. `log` is required rather than defaulted: the default is stdout,
 * which in `seanced mcp` is the protocol channel. `scheduler` makes it the
 * leader's leg for one term (`leader.ts`).
 */
export function appRelayClient(
  config: Pick<Config, "relayUrl" | "bearerToken">,
  key: CryptoKey,
  log: (line: string) => void,
  scheduler?: { readonly term: number; readonly onEvent?: SchedulerEventHandler },
): RelayClient {
  return new RelayClient({
    url: appRelayUrl(config.relayUrl),
    token: config.bearerToken,
    key,
    log,
    // Bun dialing workerd needs this or frames die with close code 1002.
    createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
    ...(scheduler === undefined ? {} : { scheduler }),
  });
}
