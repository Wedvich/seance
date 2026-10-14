import { appRelayUrl, RelayClient, type RelayState, type RequestOp } from "@seance/shared";
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
  readonly request: <T>(deviceId: string, op: RequestOp, payload: unknown) => Promise<T>;
}

/**
 * A Claude session can sit open for hours between tool calls, so the socket
 * dials on the first call and hangs up after this much silence rather than
 * holding an app socket per session. Comfortably past the longest op timeout
 * (spawn, 90s), so the line never drops under an in-flight call — and the
 * in-flight count below guards that anyway.
 */
const IDLE_MS = 5 * 60_000;

/** Bounds `acquire` when the relay is down; past it the call fails instead of riding the backoff forever. */
export const CONNECT_TIMEOUT_MS = 10_000;

export interface LazyRelayOpts {
  /**
   * Async because `seanced mcp` resolves the PSK here rather than at startup:
   * local ops need no key, so only a remote op pays for resolving it. The
   * daemon's broker passes a client built over the key it already holds.
   */
  readonly create: () => AppRelay | Promise<AppRelay>;
  readonly idleMs?: number;
  readonly connectTimeoutMs?: number;
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
      if (this.#client !== null) return this.#client;
      this.#connecting ??= this.#connect();
      return await this.#connecting;
    } catch (err) {
      this.#inFlight -= 1;
      throw err;
    } finally {
      this.#connecting = null;
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

  async #waitOpen(client: AppRelay): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`the relay did not answer within ${this.#opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS}ms`));
      }, this.#opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
      // Referenced from the closures above and below, assigned before either can run:
      // the timer is async and check() is only called after subscribe returns.
      const check = (): void => {
        const state = client.getState();
        if (state.status === "open") {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        } else if (state.status === "rejected") {
          clearTimeout(timer);
          unsubscribe();
          reject(
            new Error(
              state.rejection === "unauthorized"
                ? "the relay rejected the bearer token — check bearerToken in config.json"
                : "the relay rejected the connection as malformed",
            ),
          );
        }
      };
      const unsubscribe = client.subscribe(check);
      check();
    });
  }

  /**
   * Waits for the client to mark this socket's registry authoritative. Bounded
   * by the client itself: `registrySettled` flips within REGISTRY_SETTLE_MS of
   * `open` even if no registry frame ever arrives.
   */
  async #settleRegistry(client: AppRelay): Promise<void> {
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (!client.getState().registrySettled) return;
        unsubscribe();
        resolve();
      };
      const unsubscribe = client.subscribe(check);
      check();
    });
  }
}

/**
 * The shared app-role client, configured the way every daemon-side consumer
 * needs it. `log` is required rather than defaulted: the default is stdout,
 * which in `seanced mcp` is the protocol channel.
 */
export function appRelayClient(
  config: Pick<Config, "relayUrl" | "bearerToken">,
  key: CryptoKey,
  log: (line: string) => void,
): AppRelay {
  return new RelayClient({
    url: appRelayUrl(config.relayUrl),
    token: config.bearerToken,
    key,
    log,
    // Bun dialing workerd needs this or frames die with close code 1002.
    createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
  });
}
