// The app's account aliases end to end through the real RelayClient and Store,
// against a relay double that holds `account:` records with the real CAS rule
// and fans a write out to the other sockets as `store-changed`. Not a
// reference for relay behaviour; DESIGN.md's wire protocol is.
import {
  accountStoreKey,
  APP_ID,
  importAccountKey,
  importPsk,
  isRecord,
  parseEnvelope,
  RelayClient,
  sealAccountRecord,
  toBase64,
  type StoreRecord,
} from "@seance/shared";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { LIST_RETRY_MS } from "../src/account-store.ts";
import { Store } from "../src/store.ts";
import { pollUntil } from "./poll.ts";
import { installBrowserGlobals } from "./stubs.ts";

installBrowserGlobals();

const TOKEN = "test-bearer-token";
const ACCOUNT = "org-1:acct-aaaaaaaa-1111";
const OTHER = "org-1:acct-bbbbbbbb-2222";

let key: CryptoKey;
let accountKey: CryptoKey;

beforeAll(async () => {
  const psk = toBase64(new Uint8Array(32).fill(7));
  key = await importPsk(psk);
  accountKey = await importAccountKey(psk);
});

type Frame = Record<string, unknown>;

interface Double {
  readonly url: string;
  readonly records: Map<string, StoreRecord>;
  readonly received: Frame[];
  readonly sockets: Set<ServerWebSocket<unknown>>;
  /** Replies to the next `store-list` this way instead of from `records`. */
  refuseLists: number;
  /** A write is not announced to the other sockets: a nudge lost to a drop. */
  muted: boolean;
  readonly stop: () => Promise<void>;
}

const doubles: Double[] = [];
const detach: (() => void)[] = [];
const clients: RelayClient[] = [];

afterEach(async () => {
  for (const off of detach.splice(0)) off();
  for (const client of clients.splice(0)) client.stop();
  await Promise.all(doubles.splice(0).map((double) => double.stop()));
});

function startDouble(): Double {
  const records = new Map<string, StoreRecord>();
  const received: Frame[] = [];
  const sockets = new Set<ServerWebSocket<unknown>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      return srv.upgrade(request) ? undefined : new Response("expected a websocket", { status: 400 });
    },
    websocket: {
      perMessageDeflate: false,
      open: (ws) => void sockets.add(ws),
      close: (ws) => void sockets.delete(ws),
      message(ws: ServerWebSocket<unknown>, message) {
        if (message === "ping") {
          ws.send("pong");
          return;
        }
        const frame: unknown = JSON.parse(String(message));
        if (!isRecord(frame)) return;
        received.push(frame);
        const re = frame["id"];
        const at = typeof frame["key"] === "string" ? records.get(frame["key"]) : undefined;
        switch (frame["t"]) {
          case "store-list":
            if (double.refuseLists > 0) {
              double.refuseLists -= 1;
              ws.send(JSON.stringify({ t: "store-refused", re, code: "rate_limited" }));
              return;
            }
            ws.send(JSON.stringify({ t: "store-listed", re, records: [...records.values()] }));
            return;
          case "store-get":
            ws.send(JSON.stringify({ t: "store-record", re, record: at ?? null }));
            return;
          case "store-put": {
            const env = parseEnvelope(frame["env"]);
            if (typeof frame["key"] !== "string" || env === null) {
              ws.send(JSON.stringify({ t: "store-refused", re, code: "invalid_request" }));
              return;
            }
            if ((at?.version ?? 0) !== frame["expect"]) {
              ws.send(JSON.stringify({ t: "store-refused", re, code: "version_conflict" }));
              return;
            }
            const version = (at?.version ?? 0) + 1;
            records.set(frame["key"], { key: frame["key"], version, env });
            ws.send(JSON.stringify({ t: "store-written", re, version }));
            if (double.muted) return;
            for (const other of sockets) {
              if (other !== ws) other.send(JSON.stringify({ t: "store-changed", key: frame["key"], version }));
            }
            return;
          }
          default:
            ws.send(JSON.stringify({ t: "store-refused", re, code: "invalid_request" }));
        }
      },
    },
  });
  // Read by the handler only once a frame arrives, by which time it is set.
  const double: Double = {
    url: `ws://127.0.0.1:${server.port}/app`,
    records,
    received,
    sockets,
    refuseLists: 0,
    muted: false,
    stop: () => server.stop(true),
  };
  doubles.push(double);
  return double;
}

async function openStore(double: Double, withAccountKey = true): Promise<Store> {
  const client = new RelayClient({
    url: double.url,
    token: TOKEN,
    key,
    ...(withAccountKey ? { accountKey } : {}),
    createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
    log: () => {},
  });
  clients.push(client);
  const store = new Store(client);
  detach.push(store.attach());
  client.start();
  await pollUntil(() => client.getState().status === "open", "the socket to open");
  return store;
}

async function planted(
  double: Double,
  accountId: string,
  alias: string | null,
  version = 1,
  at?: string,
  /** What the relay holds the record at, when it is not the version sealed in it. */
  heldAt = version,
): Promise<string> {
  const storeKey = at ?? (await accountStoreKey(accountKey, accountId));
  double.records.set(storeKey, {
    key: storeKey,
    version: heldAt,
    env: await sealAccountRecord(key, APP_ID, { version, accountId, alias }),
  });
  return storeKey;
}

function nudge(double: Double, storeKey: string, version: number): void {
  for (const socket of double.sockets) socket.send(JSON.stringify({ t: "store-changed", key: storeKey, version }));
}

const gets = (double: Double): number => double.received.filter((frame) => frame["t"] === "store-get").length;
const lists = (double: Double): number => double.received.filter((frame) => frame["t"] === "store-list").length;

describe("account aliases in the store", () => {
  test("opening lists the account records, and a record that does not belong shows no alias", async () => {
    const double = startDouble();
    await planted(double, ACCOUNT, "work");
    await planted(double, OTHER, "forged", 1, `account:${"0".repeat(64)}`);
    const store = await openStore(double);
    await pollUntil(() => store.getState().accounts.aliases[ACCOUNT] === "work", "the listing to land");
    expect(store.getState().accounts.aliases).toEqual({ [ACCOUNT]: "work" });
    expect(store.getState().accounts.nameable).toBe(true);
  });

  test("a rename in one client reaches another through the nudge alone, one get, no re-list", async () => {
    const double = startDouble();
    const a = await openStore(double);
    const b = await openStore(double);
    await pollUntil(() => lists(double) === 2, "both clients to list");

    await a.renameAccount(ACCOUNT, "  work ");
    expect(a.getState().accounts.aliases).toEqual({ [ACCOUNT]: "work" });
    await pollUntil(() => b.getState().accounts.aliases[ACCOUNT] === "work", "B to show the rename");
    expect(gets(double)).toBe(1);
    expect(lists(double)).toBe(2);

    await b.renameAccount(ACCOUNT, "");
    await pollUntil(() => a.getState().accounts.aliases[ACCOUNT] === undefined, "A to show the clear");
    expect(double.records.get(await accountStoreKey(accountKey, ACCOUNT))?.version).toBe(2);
  });

  test("a nudge that is no newer than what is held, or names no account key, reads nothing", async () => {
    const double = startDouble();
    const storeKey = await planted(double, ACCOUNT, "work");
    const store = await openStore(double);
    await pollUntil(() => store.getState().accounts.aliases[ACCOUNT] === "work", "the listing to land");

    nudge(double, storeKey, 1);
    nudge(double, storeKey, 0);
    nudge(double, "task:abc", 9);
    nudge(double, "account:not a key", 9);
    // The one that does read is the proof the ones before it were seen and dropped.
    const fresh = await planted(double, OTHER, "home");
    nudge(double, fresh, 1);
    await pollUntil(() => store.getState().accounts.aliases[OTHER] === "home", "the newer key to be read");
    expect(gets(double)).toBe(1);
  });

  test("a rename that lost a race re-reads, shows the latest name and says so; the next one replaces it", async () => {
    const double = startDouble();
    const a = await openStore(double);
    const b = await openStore(double);
    await pollUntil(() => lists(double) === 2, "both clients to list");
    double.muted = true;
    await b.renameAccount(ACCOUNT, "from-b");

    await a.renameAccount(ACCOUNT, "from-a");
    expect(a.getState().accounts.notice).toStartWith("Renamed elsewhere");
    expect(a.getState().accounts.aliases).toEqual({ [ACCOUNT]: "from-b" });
    expect(a.getState().accounts.saving).toBeNull();

    await a.renameAccount(ACCOUNT, "from-a");
    expect(a.getState().accounts.notice).toBeNull();
    expect(a.getState().accounts.aliases).toEqual({ [ACCOUNT]: "from-a" });
    expect(double.records.get(await accountStoreKey(accountKey, ACCOUNT))?.version).toBe(2);
  });

  test("a version-1 blob put back reads unreadable: the alias is gone, and the next rename overwrites at the relay's version", async () => {
    const double = startDouble();
    const storeKey = await planted(double, ACCOUNT, "work");
    const store = await openStore(double);
    await pollUntil(() => store.getState().accounts.aliases[ACCOUNT] === "work", "the listing to land");
    await store.renameAccount(ACCOUNT, "home");
    expect(store.getState().accounts.aliases[ACCOUNT]).toBe("home");

    // The genuine v1 blob, put back by overwrite: the relay now holds it at version 3.
    await planted(double, ACCOUNT, "work", 1, undefined, 3);
    nudge(double, storeKey, 3);
    await pollUntil(() => store.getState().accounts.aliases[ACCOUNT] === undefined, "the rollback to be read");

    await store.renameAccount(ACCOUNT, "again");
    expect(store.getState().accounts.notice).toBeNull();
    expect(store.getState().accounts.aliases[ACCOUNT]).toBe("again");
    expect(double.records.get(storeKey)?.version).toBe(4);
  });

  test("a rename past the bound is refused before anything is sent", async () => {
    const double = startDouble();
    const store = await openStore(double);
    await pollUntil(() => lists(double) === 1, "the listing");
    await store.renameAccount(ACCOUNT, "x".repeat(65));
    expect(store.getState().accounts.notice).toBe("Names are at most 64 characters");
    expect(double.received.some((frame) => frame["t"] === "store-put")).toBe(false);
    store.dismissAccountNotice();
    expect(store.getState().accounts.notice).toBeNull();
  });

  test("a refused first listing is tried once more, and a rename before it reads the key first", async () => {
    const realSet = globalThis.setTimeout;
    const armed: { fire: (() => void) | null } = { fire: null };
    Object.defineProperty(globalThis, "setTimeout", {
      value: (callback: () => void, ms: number) => {
        if (ms !== LIST_RETRY_MS) return realSet(callback, ms);
        armed.fire = callback;
        return 0;
      },
      configurable: true,
    });
    try {
      const double = startDouble();
      await planted(double, ACCOUNT, "work");
      double.refuseLists = 1;
      const store = await openStore(double);
      await pollUntil(() => armed.fire !== null, "the retry to be armed");
      expect(store.getState().accounts.aliases).toEqual({});

      // No listing yet, so the held version is 0: without the read first this would conflict.
      await store.renameAccount(ACCOUNT, "home");
      expect(store.getState().accounts.notice).toBeNull();
      expect(store.getState().accounts.aliases[ACCOUNT]).toBe("home");

      await planted(double, OTHER, "other");
      armed.fire?.();
      await pollUntil(() => store.getState().accounts.aliases[OTHER] === "other", "the retry's listing");
    } finally {
      Object.defineProperty(globalThis, "setTimeout", { value: realSet, configurable: true });
    }
  });

  test("an install without an account key works, names nothing and sends no account frame", async () => {
    const double = startDouble();
    await planted(double, ACCOUNT, "work");
    const store = await openStore(double, false);
    expect(store.getState().accounts.nameable).toBe(false);
    await store.renameAccount(ACCOUNT, "home");
    nudge(double, await accountStoreKey(accountKey, ACCOUNT), 5);
    await Bun.sleep(50);
    expect(store.getState().accounts.aliases).toEqual({});
    expect(store.getState().accounts.notice).toBeNull();
    expect(double.received).toEqual([]);
  });
});
