import type { DaemonFrame, Envelope } from "@seance/shared";

/**
 * Throwaway in-process relay for integration tests — NOT the real relay, and
 * NOT a reference for building it. This doubles only the daemon-facing subset
 * of the Durable Object: bearer-header gate on upgrade, register tracking, msg
 * routing by `env.to`, optional "pong" auto-response. DESIGN.md's wire
 * protocol section is the spec.
 *
 * Absent here: `/daemon` vs `/app` path roles (this accepts any path), `?t=`
 * app auth, `registry` push, broadcast to app sockets. Two behaviours are
 * outright inverted from the real DO, so do not copy them — the registry is
 * ephemeral socket state dropped on close (the DO persists entries with
 * `lastSeen` and derives `connected` at read), and an unroutable envelope
 * throws in-process (the DO replies `undeliverable`).
 */

export class AsyncQueue<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((value: T) => void)[] = [];

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter(item);
    else this.#items.push(item);
  }

  async next(timeoutMs = 2_000): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return item;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`AsyncQueue: nothing arrived in ${timeoutMs}ms`)), timeoutMs);
      this.#waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  get size(): number {
    return this.#items.length;
  }
}

type RegisterFrame = Extract<DaemonFrame, { t: "register" }>;

export interface TestRelay {
  readonly url: string;
  readonly port: number;
  readonly registers: AsyncQueue<RegisterFrame>;
  readonly messages: AsyncQueue<Envelope>;
  autoPong: boolean;
  rejectedCount: () => number;
  connectionCount: () => number;
  sendToDaemon: (env: Envelope) => void;
  stop: () => void;
}

export function startTestRelay(bearerToken: string, port = 0): TestRelay {
  const registers = new AsyncQueue<RegisterFrame>();
  const messages = new AsyncQueue<Envelope>();
  const daemons = new Map<string, Bun.ServerWebSocket<unknown>>();
  const socketDevices = new Map<Bun.ServerWebSocket<unknown>, string>();
  let rejected = 0;
  let connections = 0;

  const relay: { autoPong: boolean } = { autoPong: true };

  const server = Bun.serve({
    port,
    fetch(req, srv) {
      if (req.headers.get("authorization") !== `Bearer ${bearerToken}`) {
        rejected += 1;
        return new Response("unauthorized", { status: 401 });
      }
      if (srv.upgrade(req)) return undefined;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open() {
        connections += 1;
      },
      message(ws, raw) {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        if (text === "ping") {
          if (relay.autoPong) ws.send("pong");
          return;
        }
        const frame = JSON.parse(text) as DaemonFrame;
        if (frame.t === "register") {
          daemons.set(frame.deviceId, ws);
          socketDevices.set(ws, frame.deviceId);
          registers.push(frame);
        } else {
          messages.push(frame.env);
        }
      },
      close(ws) {
        const deviceId = socketDevices.get(ws);
        if (deviceId !== undefined && daemons.get(deviceId) === ws) daemons.delete(deviceId);
        socketDevices.delete(ws);
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}`,
    port: Number(server.port),
    registers,
    messages,
    get autoPong() {
      return relay.autoPong;
    },
    set autoPong(value: boolean) {
      relay.autoPong = value;
    },
    rejectedCount: () => rejected,
    connectionCount: () => connections,
    sendToDaemon: (env: Envelope): void => {
      const ws = daemons.get(env.to);
      if (ws === undefined) throw new Error(`no daemon registered as ${env.to}`);
      ws.send(JSON.stringify({ t: "msg", env }));
    },
    stop: (): void => {
      server.stop(true);
    },
  };
}
