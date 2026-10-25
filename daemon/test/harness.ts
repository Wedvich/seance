import {
  APP_ID,
  isStoreKey,
  SCHEDULER_ID,
  STORE_PREFIXES,
  TOKEN_PARAM,
  type AppFrame,
  type DaemonFrame,
  type Envelope,
  type RegistryView,
  type RelayToAppFrame,
  type StoreReplyFrame,
  type StoreRequestFrame,
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
 * The store ops (scheduler M3) are doubled on the daemon leg, with the rules
 * a leader's adapter depends on: a write needs the current term from the
 * leader's own socket (`not_leader` otherwise), `expect` is compared to the
 * stored version, a delete under `task:` leaves a tombstone that never expires
 * (a put there is `version_conflict`, a get reads null), a delete under
 * `queue:` is `forbidden`, a list is ascending by key. `appWrite` stands in
 * for an app's create, and sends `store-changed` to the leader's socket.
 * Absent from the store double, against the DO: the size caps and the create
 * floor, tombstone expiry, every app-leg store frame over a socket but a get
 * (the leader's leg reads the fleet quota record at takeover), and the refusal
 * log. A test that needs an answer the rules would not give uses
 * `replyNextStore`.
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

/**
 * The next frame the leader sent a machine. Its `queue-changed` nudges ride the
 * same queue but are addressed to apps, so a test waiting on a request skips them.
 */
export async function nextRequest(relay: TestRelay, timeoutMs = 2_000): Promise<AppMsg> {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- frames arrive one at a time
    const frame = await relay.appFrames.next(timeoutMs);
    if (frame.env.to !== APP_ID) return frame;
  }
}

/** Every request frame already queued, nudges skipped: what a test asserting "nothing was sent" reads. */
export async function queuedRequests(relay: TestRelay): Promise<AppMsg[]> {
  const found: AppMsg[] = [];
  while (relay.appFrames.size > 0) {
    // oxlint-disable-next-line no-await-in-loop -- drains what is already there
    const frame = await relay.appFrames.next();
    if (frame.env.to !== APP_ID) found.push(frame);
  }
  return found;
}

export interface TestRelay {
  readonly url: string;
  readonly port: number;
  readonly registers: AsyncQueue<RegisterFrame>;
  /** Per `registers` entry, in push order: which connection (1-based) sent it — a redial apart from a re-register. */
  readonly registerConnections: readonly number[];
  readonly messages: AsyncQueue<Envelope>;
  /** `status` envelopes, apart from `messages` so a reply assertion never meets a snapshot first. */
  readonly statuses: AsyncQueue<Envelope>;
  /** Envelopes `to: "scheduler"` while no leader is named, which the real DO would refuse instead. */
  readonly toScheduler: AsyncQueue<Envelope>;
  autoPong: boolean;
  /** Close every register the way the real DO refuses an id another live socket holds. */
  refuseRegisters: boolean;
  /** Refuse this many registers as `refuseRegisters` does, then admit — no race with a redial. */
  refuseNextRegisters: number;
  /** Close every app socket on open with 4401, as the real relay answers a bad `?t=` token. */
  rejectApps: boolean;
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
  /** Every store frame a daemon sent, in order — held or answered. */
  readonly storeFrames: AsyncQueue<StoreRequestFrame>;
  /** Answer no store frame, an app's get included: a timeout for the sender. */
  holdStoreReplies: boolean;
  /**
   * The next store frame gets this raw reply instead of the rules' answer — a
   * page (`next`), the wrong kind, an unknown code, a wrong version. One-shot;
   * several queue.
   */
  replyNextStore: (make: (frame: StoreRequestFrame) => unknown) => void;
  storeRecords: () => ReadonlyMap<string, { readonly version: number; readonly env: Envelope }>;
  /** A record as the store would hold it, bypassing every rule: junk a token holder could plant. */
  plantRecord: (key: string, version: number, env: Envelope) => void;
  /**
   * An app's create (`expect: 0`, with the tombstone and version rules), then
   * `store-changed` to the leader's socket if one is named.
   */
  appWrite: (key: string, env: Envelope) => { ok: true; version: number } | { ok: false; code: string };
  /** Closes the daemon's socket from the relay's side, as a drop after a send. */
  dropDaemon: (deviceId: string) => void;
  stop: () => void;
}

const refused = (re: string, code: string): StoreReplyFrame => ({ t: "store-refused", re, code });

export function startTestRelay(bearerToken: string, port = 0): TestRelay {
  const registers = new AsyncQueue<RegisterFrame>("registers");
  const messages = new AsyncQueue<Envelope>("messages");
  const statuses = new AsyncQueue<Envelope>("statuses");
  const toScheduler = new AsyncQueue<Envelope>("toScheduler");
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
  const storeFrames = new AsyncQueue<StoreRequestFrame>("storeFrames");
  const records = new Map<string, { version: number; env: Envelope }>();
  /** Key → the version it was deleted at. Never expires here, unlike the DO's. */
  const tombstones = new Map<string, number>();
  const storeOverrides: ((frame: StoreRequestFrame) => unknown)[] = [];

  const relay: {
    autoPong: boolean;
    refuseRegisters: boolean;
    refuseNextRegisters: number;
    rejectApps: boolean;
    schedulerTerm: number | null;
    holdStoreReplies: boolean;
  } = {
    autoPong: true,
    refuseRegisters: false,
    refuseNextRegisters: 0,
    rejectApps: false,
    schedulerTerm: null,
    holdStoreReplies: false,
  };

  const answerStore = (ws: Bun.ServerWebSocket<Role>, frame: StoreRequestFrame): StoreReplyFrame => {
    const { id: re } = frame;
    if (frame.t === "store-list") {
      const prefix = Object.values(STORE_PREFIXES).find((rule) => rule.prefix === frame.prefix)?.prefix;
      if (prefix === undefined) return refused(re, "invalid_request");
      const listed = [...records]
        .filter(([key]) => key.startsWith(prefix))
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, held]) => ({ key, version: held.version, env: held.env }));
      return { t: "store-listed", re, records: listed };
    }
    if (!isStoreKey(frame.key)) return refused(re, "invalid_request");
    const { key } = frame;
    if (frame.t === "store-get") {
      const held = records.get(key);
      return {
        t: "store-record",
        re,
        record: held === undefined ? null : { key, version: held.version, env: held.env },
      };
    }
    if (frame.t === "store-delete" && key.startsWith(STORE_PREFIXES.queue.prefix)) return refused(re, "forbidden");
    // Every prefix here is term-fenced; the term holds only from the socket it was issued to.
    const holdsTerm =
      frame.term !== undefined && frame.term === relay.schedulerTerm && leader !== null && daemons.get(leader) === ws;
    if (!holdsTerm) return refused(re, "not_leader");
    const stored = records.get(key)?.version ?? 0;
    if (frame.t === "store-put") {
      if (tombstones.has(key) || frame.expect !== stored) return refused(re, "version_conflict");
      records.set(key, { version: frame.expect + 1, env: frame.env });
      return { t: "store-written", re, version: frame.expect + 1 };
    }
    if (stored === 0 || frame.expect !== stored) return refused(re, "version_conflict");
    records.delete(key);
    if (key.startsWith(STORE_PREFIXES.task.prefix)) tombstones.set(key, stored);
    return { t: "store-written", re, version: stored };
  };

  const onStoreFrame = (ws: Bun.ServerWebSocket<Role>, frame: StoreRequestFrame): void => {
    storeFrames.push(frame);
    if (relay.holdStoreReplies) return;
    const override = storeOverrides.shift();
    ws.send(JSON.stringify(override === undefined ? answerStore(ws, frame) : override(frame)));
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
    if (frame.t === "store-get") {
      if (relay.holdStoreReplies) return;
      const held = isStoreKey(frame.key) ? records.get(frame.key) : undefined;
      const record = held === undefined ? null : { key: frame.key, version: held.version, env: held.env };
      ws.send(JSON.stringify({ t: "store-record", re: frame.id, record } satisfies StoreReplyFrame));
      return;
    }
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
    } else if (
      frame.t === "store-list" ||
      frame.t === "store-get" ||
      frame.t === "store-put" ||
      frame.t === "store-delete"
    ) {
      onStoreFrame(ws, frame);
    } else if (frame.t !== "msg") {
      // `lead-proof`: nothing here reads it.
    } else if (frame.env.to === SCHEDULER_ID) {
      if (leader === null) toScheduler.push(frame.env);
      else daemons.get(leader)?.send(JSON.stringify({ t: "msg", env: frame.env }));
    } else {
      messages.push(frame.env);
    }
  };

  const server = Bun.serve<Role>({
    // The address every client dials. Bun's default is the dual-stack [::], and
    // on macOS another process's SO_REUSEADDR bind of 127.0.0.1 on the same port
    // (a VS Code helper, a dev server) is allowed on top of it and wins every
    // 127.0.0.1 dial; an exact bind makes that second bind fail instead.
    hostname: "127.0.0.1",
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
          if (relay.rejectApps) {
            ws.close(4401, "unauthorized");
            return;
          }
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
    toScheduler,
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
    get rejectApps() {
      return relay.rejectApps;
    },
    set rejectApps(value: boolean) {
      relay.rejectApps = value;
    },
    get schedulerTerm() {
      return relay.schedulerTerm;
    },
    set schedulerTerm(value: number | null) {
      relay.schedulerTerm = value;
    },
    storeFrames,
    get holdStoreReplies() {
      return relay.holdStoreReplies;
    },
    set holdStoreReplies(value: boolean) {
      relay.holdStoreReplies = value;
    },
    replyNextStore: (make): void => {
      storeOverrides.push(make);
    },
    storeRecords: () => records,
    plantRecord: (key, version, env): void => {
      records.set(key, { version, env });
    },
    appWrite: (key, env) => {
      if (!isStoreKey(key)) return { ok: false, code: "invalid_request" };
      if (tombstones.has(key) || records.has(key)) return { ok: false, code: "version_conflict" };
      records.set(key, { version: 1, env });
      if (leader !== null) {
        daemons.get(leader)?.send(JSON.stringify({ t: "store-changed", key, version: 1 }));
      }
      return { ok: true, version: 1 };
    },
    dropDaemon: (deviceId): void => {
      daemons.get(deviceId)?.close(1000, "dropped by the test relay");
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
