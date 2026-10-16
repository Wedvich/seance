import {
  SCHEDULER_ID,
  TOKEN_PARAM,
  type AppFrame,
  type DaemonFrame,
  type Envelope,
  type RegistryView,
  type RelayToAppFrame,
} from "@seance/shared";

/**
 * Throwaway in-process relay for integration tests — NOT the real relay, and
 * NOT a reference for building it. This doubles only the daemon-facing subset
 * of the Durable Object: bearer-header gate on upgrade, register tracking, msg
 * routing by `env.to`, optional "pong" auto-response. DESIGN.md's wire
 * protocol section is the spec.
 *
 * The app side exists only for the scheduler leader's leg: a `?t=` socket
 * gets whatever registry the test sets (`setRegistry`), its `msg` frames are
 * queued on `appFrames` and handed to a registered daemon, and one sent
 * `from: "scheduler"` under a term other than `schedulerTerm` is answered
 * `not_leader`. A daemon's envelope `to: "scheduler"` goes to whichever
 * daemon `lead` last named. Nomination itself is the test's: `lead`/`follow`
 * only send the frames.
 *
 * Absent here: `/daemon` vs `/app` path roles (the token's carrier decides),
 * a registry derived from registers, broadcast to app sockets. Three
 * behaviours are outright inverted from the real DO, so do not copy them —
 * the registry is ephemeral socket state dropped on close (the DO persists
 * entries with `lastSeen` and derives `connected` at read), an unroutable
 * daemon envelope throws in-process (the DO replies `undeliverable`), and an
 * app envelope to an unregistered id waits for the test to answer it (the DO
 * replies `offline` or `unknown`).
 */

export class AsyncQueue<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((value: T) => void)[] = [];

  /** Named in the timeout error: a stack that stops in this file can't say which queue starved. */
  constructor(readonly name: string) {}

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter(item);
    else this.#items.push(item);
  }

  async next(timeoutMs = 2_000): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return item;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`AsyncQueue(${this.name}): nothing arrived in ${timeoutMs}ms`)),
        timeoutMs,
      );
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
type AppMsg = Extract<AppFrame, { t: "msg" }>;
type Role = "daemon" | "app";

export interface TestRelay {
  readonly url: string;
  readonly port: number;
  readonly registers: AsyncQueue<RegisterFrame>;
  /** Per `registers` entry, in push order: which connection (1-based) sent it — a redial apart from a re-register. */
  readonly registerConnections: readonly number[];
  readonly messages: AsyncQueue<Envelope>;
  /** `status` envelopes, apart from `messages` so a reply assertion never meets a snapshot first. */
  readonly statuses: AsyncQueue<Envelope>;
  autoPong: boolean;
  /** Close every register the way the real DO refuses an id another live socket holds. */
  refuseRegisters: boolean;
  /** Refuse this many registers as `refuseRegisters` does, then admit — no race with a redial. */
  refuseNextRegisters: number;
  rejectedCount: () => number;
  /** Daemon connections only; app sockets count in `appConnectionCount`. */
  connectionCount: () => number;
  sendToDaemon: (env: Envelope) => void;
  /** Raw text, for the frame shapes the wire types forbid but a byte stream allows. */
  sendRawToDaemon: (deviceId: string, text: string) => void;
  /** Every `msg` an app socket sent, the term it claimed included — fenced or not. */
  readonly appFrames: AsyncQueue<AppMsg>;
  /** One entry per app socket opening or closing, so a test can wait on either without polling. */
  readonly appEvents: AsyncQueue<"open" | "close">;
  appConnectionCount: () => number;
  openAppCount: () => number;
  /** Replaces the registry and pushes it to every open app socket, as every app connect is pushed it too. */
  setRegistry: (entries: readonly RegistryView[]) => void;
  /** Raw frame to every open app socket — a reply the test answers on a daemon's behalf, an `undeliverable`. */
  sendToApps: (frame: RelayToAppFrame) => void;
  /** Names `deviceId` the leader, fences on `term`, and sends it `lead`. */
  lead: (deviceId: string, term: number) => void;
  /** Sends `follow`; the fence moves only when the test sets `schedulerTerm`. */
  follow: (deviceId: string) => void;
  /** The term an envelope `from: "scheduler"` must carry; null refuses every one. */
  schedulerTerm: number | null;
  stop: () => void;
}

export function startTestRelay(bearerToken: string, port = 0): TestRelay {
  const registers = new AsyncQueue<RegisterFrame>("registers");
  const messages = new AsyncQueue<Envelope>("messages");
  const statuses = new AsyncQueue<Envelope>("statuses");
  const appFrames = new AsyncQueue<AppMsg>("appFrames");
  const appEvents = new AsyncQueue<"open" | "close">("appEvents");
  const daemons = new Map<string, Bun.ServerWebSocket<Role>>();
  const socketDevices = new Map<Bun.ServerWebSocket<Role>, string>();
  const apps = new Set<Bun.ServerWebSocket<Role>>();
  let rejected = 0;
  let connections = 0;
  let appConnections = 0;
  const ordinals = new Map<Bun.ServerWebSocket<Role>, number>();
  const registerConnections: number[] = [];
  let registry: readonly RegistryView[] = [];
  let leader: string | null = null;

  const relay: {
    autoPong: boolean;
    refuseRegisters: boolean;
    refuseNextRegisters: number;
    schedulerTerm: number | null;
  } = {
    autoPong: true,
    refuseRegisters: false,
    refuseNextRegisters: 0,
    schedulerTerm: null,
  };

  const registryFrame = (): string =>
    JSON.stringify({
      t: "registry",
      entries: registry,
      scheduler:
        leader === null || relay.schedulerTerm === null ? null : { deviceId: leader, term: relay.schedulerTerm },
    } satisfies RelayToAppFrame);

  const onAppMessage = (ws: Bun.ServerWebSocket<Role>, text: string): void => {
    const frame = JSON.parse(text) as AppFrame;
    if (frame.t !== "msg") return;
    appFrames.push(frame);
    const { env } = frame;
    if (env.from === SCHEDULER_ID && (frame.term === undefined || frame.term !== relay.schedulerTerm)) {
      ws.send(
        JSON.stringify({ t: "undeliverable", to: env.to, iv: env.iv, code: "not_leader" } satisfies RelayToAppFrame),
      );
      return;
    }
    daemons.get(env.to)?.send(JSON.stringify({ t: "msg", env }));
  };

  const onDaemonMessage = (ws: Bun.ServerWebSocket<Role>, text: string): void => {
    const frame = JSON.parse(text) as DaemonFrame;
    if (frame.t === "register") {
      registerConnections.push(ordinals.get(ws) ?? 0);
      if (relay.refuseRegisters || relay.refuseNextRegisters > 0) {
        if (relay.refuseNextRegisters > 0) relay.refuseNextRegisters -= 1;
        registers.push(frame);
        ws.close(1000, "register unverified");
        return;
      }
      daemons.set(frame.deviceId, ws);
      socketDevices.set(ws, frame.deviceId);
      registers.push(frame);
    } else if (frame.t === "status") {
      statuses.push(frame.env);
    } else if (frame.env.to === SCHEDULER_ID) {
      if (leader !== null) daemons.get(leader)?.send(JSON.stringify({ t: "msg", env: frame.env }));
    } else {
      messages.push(frame.env);
    }
  };

  const server = Bun.serve<Role>({
    port,
    fetch(req, srv) {
      // The app carries the token in the query (a browser cannot set a header on a WebSocket).
      const app = new URL(req.url).searchParams.get(TOKEN_PARAM) === bearerToken;
      if (!app && req.headers.get("authorization") !== `Bearer ${bearerToken}`) {
        rejected += 1;
        return new Response("unauthorized", { status: 401 });
      }
      if (srv.upgrade(req, { data: app ? "app" : "daemon" })) return undefined;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      // Bun dialing Bun negotiates it, and the daemon side never offers it to workerd.
      perMessageDeflate: false,
      open(ws) {
        if (ws.data === "app") {
          appConnections += 1;
          apps.add(ws);
          ws.send(registryFrame());
          appEvents.push("open");
          return;
        }
        connections += 1;
        ordinals.set(ws, connections);
      },
      message(ws, raw) {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        if (text === "ping") {
          if (relay.autoPong) ws.send("pong");
          return;
        }
        if (ws.data === "app") onAppMessage(ws, text);
        else onDaemonMessage(ws, text);
      },
      close(ws) {
        if (ws.data === "app") {
          apps.delete(ws);
          appEvents.push("close");
          return;
        }
        const deviceId = socketDevices.get(ws);
        if (deviceId !== undefined && daemons.get(deviceId) === ws) daemons.delete(deviceId);
        socketDevices.delete(ws);
        ordinals.delete(ws);
      },
    },
  });

  const sendRawToDaemon = (deviceId: string, text: string): void => {
    const ws = daemons.get(deviceId);
    if (ws === undefined) throw new Error(`no daemon registered as ${deviceId}`);
    ws.send(text);
  };

  return {
    url: `ws://127.0.0.1:${server.port}`,
    port: Number(server.port),
    registers,
    registerConnections,
    messages,
    statuses,
    appFrames,
    appEvents,
    get autoPong() {
      return relay.autoPong;
    },
    set autoPong(value: boolean) {
      relay.autoPong = value;
    },
    get refuseRegisters() {
      return relay.refuseRegisters;
    },
    set refuseRegisters(value: boolean) {
      relay.refuseRegisters = value;
    },
    get refuseNextRegisters() {
      return relay.refuseNextRegisters;
    },
    set refuseNextRegisters(value: number) {
      relay.refuseNextRegisters = value;
    },
    get schedulerTerm() {
      return relay.schedulerTerm;
    },
    set schedulerTerm(value: number | null) {
      relay.schedulerTerm = value;
    },
    rejectedCount: () => rejected,
    connectionCount: () => connections,
    appConnectionCount: () => appConnections,
    openAppCount: () => apps.size,
    sendToDaemon: (env: Envelope): void => {
      const ws = daemons.get(env.to);
      if (ws === undefined) throw new Error(`no daemon registered as ${env.to}`);
      ws.send(JSON.stringify({ t: "msg", env }));
    },
    sendRawToDaemon,
    setRegistry: (entries): void => {
      registry = entries;
      const text = registryFrame();
      for (const app of apps) app.send(text);
    },
    sendToApps: (frame): void => {
      const text = JSON.stringify(frame);
      for (const app of apps) app.send(text);
    },
    lead: (deviceId, term): void => {
      leader = deviceId;
      relay.schedulerTerm = term;
      sendRawToDaemon(deviceId, JSON.stringify({ t: "lead", term }));
    },
    follow: (deviceId): void => {
      sendRawToDaemon(deviceId, JSON.stringify({ t: "follow" }));
    },
    stop: (): void => {
      server.stop(true);
    },
  };
}
