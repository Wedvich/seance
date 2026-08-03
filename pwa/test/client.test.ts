import { APP_ID, importPsk, seal, toBase64, type MachineInfo, type Plain, type SessionsResponse } from "@seance/shared";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRelay, type TestRelay } from "../../relay/test/harness.ts";
import { RelayClient, RequestFailure, type RelayState } from "@seance/shared";
import { startFakeDaemon } from "./daemon.ts";
import { DEFAULT_FORM, type PersistedForm } from "../src/state.ts";
import { Store } from "../src/store.ts";
import type { AppState } from "../src/view.ts";
import { installBrowserGlobals } from "./stubs.ts";

installBrowserGlobals();

const TOKEN = "test-bearer-token";
const PSK = toBase64(new Uint8Array(32).fill(7));
const OTHER_PSK = toBase64(new Uint8Array(32).fill(9));

let relay: TestRelay;
let key: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  relay = await startRelay(TOKEN);
  key = await importPsk(PSK);
  otherKey = await importPsk(OTHER_PSK);
});

afterAll(async () => {
  await relay.dispose();
});

let deviceCounter = 0;

// The registry is permanent by design, so every test owns its own deviceId and
// asserts on its own entry rather than on the whole list.
function nextDeviceId(): string {
  deviceCounter += 1;
  return `pwa-device-${deviceCounter}`;
}

function appUrl(): string {
  const url = new URL("/app", relay.url);
  url.protocol = "ws:";
  return url.href;
}

function machineInfo(name: string): MachineInfo {
  return {
    name,
    platform: "darwin",
    repos: [
      { name: "seance", path: "/Users/m/repos/seance", defaultBranch: "main" },
      { name: "pengefix", path: "/Users/m/pengefix", defaultBranch: "main" },
    ],
    scannedAt: Date.now(),
  };
}

function startClient(
  opts: {
    readonly token?: string;
    readonly timeouts?: { readonly sessions?: number; readonly rescan?: number };
    readonly hidden?: readonly string[];
    readonly pingIntervalMs?: number;
    readonly pongTimeoutMs?: number;
  } = {},
): {
  client: RelayClient;
  waitFor: (predicate: (state: RelayState) => boolean, label: string) => Promise<RelayState>;
} {
  const client = new RelayClient({
    url: appUrl(),
    token: opts.token ?? TOKEN,
    key,
    // Bun's client and workerd disagree about permessage-deflate once a few
    // registry frames have gone by, and the socket dies with 1002 "Invalid
    // compressed data". Browsers handle the extension fine; suppressing the
    // offer keeps these tests measuring the relay instead of that bug.
    createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
    ...(opts.timeouts === undefined ? {} : { timeouts: opts.timeouts }),
    ...(opts.hidden === undefined ? {} : { hidden: opts.hidden }),
    ...(opts.pingIntervalMs === undefined ? {} : { pingIntervalMs: opts.pingIntervalMs }),
    ...(opts.pongTimeoutMs === undefined ? {} : { pongTimeoutMs: opts.pongTimeoutMs }),
  });
  const waitFor = (predicate: (state: RelayState) => boolean, label: string): Promise<RelayState> =>
    new Promise((resolve, reject) => {
      const check = (): boolean => {
        if (!predicate(client.getState())) return false;
        clearTimeout(timer);
        unsubscribe();
        resolve(client.getState());
        return true;
      };
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`${label}: never satisfied; last state ${JSON.stringify(client.getState())}`));
      }, 5_000);
      const unsubscribe = client.subscribe(() => void check());
      check();
    });
  client.start();
  return { client, waitFor };
}

/**
 * Waits for a positive assertion's subject instead of sleeping a fixed span,
 * which has to outlast the slowest machine and still reports a timeout rather
 * than the line that never arrived. A copy of `daemon/test/fixtures.ts`'s, on
 * purpose: a pwa suite has no business importing the daemon's fixtures.
 */
async function pollUntil(ready: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (ready()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await Bun.sleep(10);
  }
}

describe("connection", () => {
  test("reaches open and receives the registry", async () => {
    const { client, waitFor } = startClient();
    try {
      await waitFor((state) => state.status === "open", "open");
    } finally {
      client.stop();
    }
  });

  // 4401 is permanent: retrying would leave the app on "relay unreachable" forever.
  test("stops on a rejected token and reports unauthorized", async () => {
    const { client, waitFor } = startClient({ token: `${TOKEN}x` });
    try {
      const state = await waitFor((s) => s.status === "rejected", "rejected");
      expect(state.rejection).toBe("unauthorized");
      await Bun.sleep(200);
      expect(client.getState().status).toBe("rejected");
    } finally {
      client.stop();
    }
  });

  // Every resume re-dials, so the gap it opens must not surface as an outage —
  // this is what used to flash "Relay unreachable" on foregrounding.
  test("a re-dial that recovers is never reported as a drop", async () => {
    const { client, waitFor } = startClient();
    try {
      await waitFor((s) => s.status === "open", "open");
      client.reconnect();
      expect(client.getState()).toMatchObject({ status: "connecting", settling: true });
      await waitFor((s) => s.status === "open", "open again");
      expect(client.getState().settling).toBe(false);
    } finally {
      client.stop();
    }
  });

  // The window excuses a re-dial, not an outage: a socket that never arrives has to
  // stop being excused.
  test("reports the drop once the settle window elapses", async () => {
    // Port 1 is never listening, so this client cannot reach open.
    const client = new RelayClient({ url: "ws://127.0.0.1:1/app", token: TOKEN, key, settleMs: 30 });
    try {
      expect(client.getState().settling).toBe(true);
      client.start();
      for (let waited = 0; waited < 2_000 && client.getState().settling; waited += 10) await Bun.sleep(10);
      expect(client.getState().settling).toBe(false);
      expect(client.getState().status).not.toBe("open");
    } finally {
      client.stop();
    }
  });

  // Otherwise the screen sits on "connecting…" for a client that has stopped trying.
  test("stopping mid-connect ends the settle window", () => {
    const client = new RelayClient({ url: "ws://127.0.0.1:1/app", token: TOKEN, key });
    client.start();
    expect(client.getState().settling).toBe(true);
    client.stop();
    expect(client.getState().settling).toBe(false);
  });

  test("refuses to send with no socket", async () => {
    const client = new RelayClient({ url: appUrl(), token: TOKEN, key });
    await expect(client.request("whoever", "sessions", {})).rejects.toMatchObject({ reason: "disconnected" });
  });
});

describe("registry", () => {
  test("decrypts a machine and reports it online", async () => {
    const deviceId = nextDeviceId();
    const { client, waitFor } = startClient();
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Mac Studio"));
    try {
      const state = await waitFor(
        (s) => s.machines.some((m) => m.deviceId === deviceId && m.connected),
        "machine online",
      );
      const machine = state.machines.find((m) => m.deviceId === deviceId);
      expect(machine?.name).toBe("Mac Studio");
      expect(machine?.repos.map((r) => r.name)).toEqual(["seance", "pengefix"]);
    } finally {
      daemon.close();
      client.stop();
    }
  });

  // machine-info is data at rest: scannedAt can be days old and the same envelope
  // arrives on every push, so running it through the replay guard would hide the
  // machine permanently.
  test("accepts an info blob far outside the replay window", async () => {
    const deviceId = nextDeviceId();
    const { client, waitFor } = startClient();
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Old Tower"), {}, { infoTs: tenDaysAgo });
    try {
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId), "stale info still decrypts");
    } finally {
      daemon.close();
      client.stop();
    }
  });

  test("counts an entry sealed with another key as ignored, not as a machine", async () => {
    const deviceId = nextDeviceId();
    const { client, waitFor } = startClient();
    const daemon = await startFakeDaemon(relay, otherKey, deviceId, machineInfo("Stranger"));
    try {
      const state = await waitFor((s) => s.ignored > 0, "ignored entry");
      expect(state.machines.some((m) => m.deviceId === deviceId)).toBe(false);
      expect(state.registrySize).toBeGreaterThan(state.machines.length);
    } finally {
      daemon.close();
      client.stop();
    }
  });

  test("drops a removed offline machine from the list and brings it back when it connects", async () => {
    const deviceId = nextDeviceId();
    const { client, waitFor } = startClient();
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Gone Fishing"));
    try {
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && m.connected), "machine online");
      daemon.close();
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && !m.connected), "registry sees it gone");

      // The registry is shared across this file, so it is the delta that matters:
      // a removal is not a key mismatch and must never be counted as one.
      const ignoredBefore = client.getState().ignored;
      client.hide(deviceId);
      const removed = client.getState();
      expect(removed.machines.some((m) => m.deviceId === deviceId)).toBe(false);
      expect(removed.hidden).toContain(deviceId);
      expect(removed.ignored).toBe(ignoredBefore);

      const back = await startFakeDaemon(relay, key, deviceId, machineInfo("Gone Fishing"));
      try {
        const state = await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId), "machine is back");
        expect(state.hidden).not.toContain(deviceId);
      } finally {
        back.close();
      }
    } finally {
      client.stop();
    }
  });

  // Reference identity is the whole render bailout: `useState` skips when the
  // state object comes back the same, so a rebuild off an unchanged registry has
  // to hand the previous one back. Hiding a *connected* machine is the one public
  // way to force that rebuild — it is undone by the very rebuild it triggers.
  test("a rebuild that changes nothing keeps the state object and notifies nobody", async () => {
    const deviceId = nextDeviceId();
    const { client, waitFor } = startClient();
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Steady"));
    try {
      const before = await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && m.connected), "online");
      let notifications = 0;
      // No await from here to the assertions, so no frame can land in between.
      const unsubscribe = client.subscribe(() => {
        notifications += 1;
      });
      client.hide(deviceId);
      unsubscribe();
      expect(notifications).toBe(0);
      expect(client.getState()).toBe(before);
      expect(client.getState().machines).toBe(before.machines);
    } finally {
      daemon.close();
      client.stop();
    }
  });

  // What the above rides on, and with it every resume: the relay re-sends the
  // whole registry on each app connect, and an entry that did not change has to
  // survive the rebuild by identity or the list is a fresh array every time.
  //
  // The newcomer deliberately sorts *ahead* of the machine under test: the relay
  // lists entries by deviceId (storage.list over a "device:" prefix), so a first
  // registration lands anywhere in the list, and matching the previous entries by
  // position would re-allocate every machine behind the insertion point. Ids are
  // minted here rather than from nextDeviceId(), whose counter puts their relative
  // order at the mercy of how many tests run before this one ("…-10" < "…-9").
  test("a registry push leaves the entries it did not change identical", async () => {
    const run = crypto.randomUUID();
    const inserted = `pwa-device-a-${run}`;
    const settled = `pwa-device-b-${run}`;
    expect(inserted < settled).toBe(true);

    const { client, waitFor } = startClient();
    const one = await startFakeDaemon(relay, key, settled, machineInfo("Settled"));
    try {
      const before = await waitFor((s) => s.machines.some((m) => m.deviceId === settled && m.connected), "online");
      const entry = before.machines.find((m) => m.deviceId === settled);
      expect(entry).toBeDefined();

      const two = await startFakeDaemon(relay, key, inserted, machineInfo("Inserted"));
      try {
        const after = await waitFor((s) => s.machines.some((m) => m.deviceId === inserted), "newcomer online");
        const shown = after.machines.map((m) => m.deviceId);
        // The point of the fixed ids: without an insertion ahead of it, this
        // would only ever exercise the append case.
        expect(shown.indexOf(inserted)).toBeLessThan(shown.indexOf(settled));
        expect(after.machines).not.toBe(before.machines);
        expect(after.machines.find((m) => m.deviceId === settled)).toBe(entry);
      } finally {
        two.close();
      }
    } finally {
      one.close();
      client.stop();
    }
  });

  test("keeps a machine removed in an earlier run removed", async () => {
    const deviceId = nextDeviceId();
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Stale"));
    daemon.close();
    const { client, waitFor } = startClient({ hidden: [deviceId] });
    try {
      await waitFor((s) => s.registrySize > 0, "registry arrived");
      expect(client.getState().machines.some((m) => m.deviceId === deviceId)).toBe(false);
    } finally {
      client.stop();
    }
  });
});

describe("requests", () => {
  test("round-trips a sessions request through the real relay", async () => {
    const deviceId = nextDeviceId();
    const sessions: SessionsResponse = {
      sessions: [{ window: "port-the-pane-20260727-093214", repo: "seance", path: "/Users/m/repos/seance" }],
      at: Date.now(),
    };
    const { client, waitFor } = startClient();
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("MacBook Pro"), {
      sessions: () => sessions,
    });
    try {
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && m.connected), "machine online");
      const reply = await client.request<SessionsResponse>(deviceId, "sessions", {});
      expect(reply.sessions[0]?.window).toBe("port-the-pane-20260727-093214");
    } finally {
      daemon.close();
      client.stop();
    }
  });

  // The app holds the `id`; the relay can only ever name the `iv`. Logging both
  // on each side of a round trip is what makes a relay line joinable to an op.
  test("logs the iv beside the id on the way out and the re on the way back", async () => {
    const deviceId = nextDeviceId();
    const secret = "port-the-pane-20260727-093214";
    const sessions: SessionsResponse = {
      sessions: [{ window: secret, repo: "seance", path: "/Users/m/repos/seance" }],
      at: Date.now(),
    };
    const lines: string[] = [];
    const realLog = console.log;
    // Restored in an outer finally: a throw from startClient or startFakeDaemon
    // would otherwise leave console.log patched for every later test in the file.
    try {
      const { client, waitFor } = startClient();
      const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("MacBook Pro"), {
        sessions: () => sessions,
      });
      try {
        await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && m.connected), "machine online");
        console.log = (...args: unknown[]): void => {
          lines.push(args.map(String).join(" "));
        };
        await client.request<SessionsResponse>(deviceId, "sessions", {});
        console.log = realLog;

        const sent = lines.find((line) => line.startsWith("wire send "));
        const received = lines.find((line) => line.startsWith("wire recv "));
        const id = /id="([^"]+)"/u.exec(sent ?? "")?.[1];
        expect(id).toBeDefined();
        expect(sent).toContain(`op="sessions" to=${JSON.stringify(deviceId)}`);
        // The reply's own iv differs, so `re` is what closes the loop back to the request.
        expect(received).toContain(`re=${JSON.stringify(id)} op="sessions" pending=yes`);
        expect(lines.join("\n")).not.toContain(secret);
      } finally {
        daemon.close();
        client.stop();
      }
    } finally {
      console.log = realLog;
    }
  });

  // "The reply arrived, just too late" and "no reply ever came" are the two
  // stories behind one `timed out`, and only the log can tell them apart. A reply
  // whose `re` matches nothing pending is that case (and another tab's reply).
  test("logs a reply matching no pending request, marked unmatched", async () => {
    const deviceId = nextDeviceId();
    const orphanId = crypto.randomUUID();
    const lines: string[] = [];
    const realLog = console.log;
    try {
      const { client, waitFor } = startClient();
      const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Late Mac"));
      try {
        await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && m.connected), "machine online");
        console.log = (...args: unknown[]): void => {
          lines.push(args.map(String).join(" "));
        };
        const reply: Plain = {
          id: crypto.randomUUID(),
          ts: Date.now(),
          op: "sessions",
          re: orphanId,
          payload: { sessions: [], at: Date.now() },
        };
        daemon.client.send({ t: "msg", env: await seal(key, { to: APP_ID, from: deviceId }, reply) });
        await pollUntil(() => lines.some((line) => line.startsWith("wire recv ")), "the orphan reply to be logged");
        console.log = realLog;

        const received = lines.find((line) => line.startsWith("wire recv "));
        expect(received).toContain(`re=${JSON.stringify(orphanId)} op="sessions" pending=no`);
      } finally {
        daemon.close();
        client.stop();
      }
    } finally {
      console.log = realLog;
    }
  });

  test("reports an unknown deviceId as undeliverable/unknown", async () => {
    const { client, waitFor } = startClient();
    try {
      await waitFor((s) => s.status === "open", "open");
      await expect(client.request("never-registered", "sessions", {})).rejects.toMatchObject({ reason: "unknown" });
    } finally {
      client.stop();
    }
  });

  // The relay derives `connected` from live sockets, so it can read true over a
  // machine that vanished. A refused delivery is better evidence than the flag.
  test("a refused delivery marks the machine offline despite a stale connected flag", async () => {
    const deviceId = nextDeviceId();
    const { client, waitFor } = startClient();
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("MacBook Air"));
    try {
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && m.connected), "machine online");
      daemon.close();
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && !m.connected), "registry sees it gone");

      await expect(client.request(deviceId, "sessions", {})).rejects.toMatchObject({ reason: "offline" });
      expect(client.getState().machines.find((m) => m.deviceId === deviceId)?.connected).toBe(false);
    } finally {
      client.stop();
    }
  });

  test("times out when the daemon never answers", async () => {
    const deviceId = nextDeviceId();
    const { client, waitFor } = startClient({ timeouts: { sessions: 300 } });
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Silent"));
    try {
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && m.connected), "machine online");
      await expect(client.request(deviceId, "sessions", {})).rejects.toMatchObject({ reason: "timeout" });
      // The request's probe ping was ponged, so the uplink provably worked while
      // the machine stayed silent — a timeout is then evidence about the machine,
      // same as a relay refusal, and the connected flag is the staler claim.
      expect(client.getState().machines.find((m) => m.deviceId === deviceId)?.connected).toBe(false);
    } finally {
      daemon.close();
      client.stop();
    }
  });

  // The inverse of the timeout mark: any decrypted message from the machine is
  // proof of life, so a slow answer must not strand it offline until it happens
  // to re-register.
  test("a decrypted message from the machine clears a timeout's offline mark", async () => {
    const deviceId = nextDeviceId();
    const { client, waitFor } = startClient({ timeouts: { sessions: 250 } });
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Slow Mac"));
    try {
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && m.connected), "machine online");
      await expect(client.request(deviceId, "sessions", {})).rejects.toMatchObject({ reason: "timeout" });
      expect(client.getState().machines.find((m) => m.deviceId === deviceId)?.connected).toBe(false);

      const late: Plain = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        op: "sessions",
        re: crypto.randomUUID(),
        payload: { sessions: [], at: Date.now() },
      };
      daemon.client.send({ t: "msg", env: await seal(key, { to: APP_ID, from: deviceId }, late) });
      await waitFor(
        (s) => s.machines.find((m) => m.deviceId === deviceId)?.connected === true,
        "the late answer proves it alive",
      );
    } finally {
      daemon.close();
      client.stop();
    }
  });

  // The clear sits ahead of the replay guard on purpose: decryption alone
  // authenticates the sender, and a reply outside the ±60s window (skewed phone
  // clock, very late answer) still proves the machine alive. Gating it on the
  // guard would turn "every request times out" into "every machine sticks asleep".
  test("a reply outside the replay window still clears the offline mark", async () => {
    const deviceId = nextDeviceId();
    const { client, waitFor } = startClient({ timeouts: { sessions: 250 } });
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Skewed"));
    try {
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && m.connected), "machine online");
      await expect(client.request(deviceId, "sessions", {})).rejects.toMatchObject({ reason: "timeout" });
      expect(client.getState().machines.find((m) => m.deviceId === deviceId)?.connected).toBe(false);

      const stale: Plain = {
        id: crypto.randomUUID(),
        ts: Date.now() - 10 * 60 * 1000,
        op: "sessions",
        re: crypto.randomUUID(),
        payload: { sessions: [], at: Date.now() },
      };
      daemon.client.send({ t: "msg", env: await seal(key, { to: APP_ID, from: deviceId }, stale) });
      await waitFor(
        (s) => s.machines.find((m) => m.deviceId === deviceId)?.connected === true,
        "the out-of-window reply still proves it alive",
      );
    } finally {
      daemon.close();
      client.stop();
    }
  });

  test("fails in-flight requests when the socket drops", async () => {
    const deviceId = nextDeviceId();
    const { client, waitFor } = startClient();
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Dropper"));
    try {
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && m.connected), "machine online");
      const inFlight = client.request(deviceId, "spawn", { repo: "seance", mode: "worktree" });
      client.stop();
      await expect(inFlight).rejects.toBeInstanceOf(RequestFailure);
      await expect(inFlight).rejects.toMatchObject({ reason: "disconnected" });
    } finally {
      daemon.close();
    }
  });
});

// The relay pushes presence rather than being polled, so a dead app socket
// freezes the machine list with no other symptom — the pings below bound that.
describe("heartbeat", () => {
  test("relay pongs keep a healthy socket open across many beats", async () => {
    const { client, waitFor } = startClient({ pingIntervalMs: 30, pongTimeoutMs: 500 });
    try {
      await waitFor((s) => s.status === "open", "open");
      const drops: string[] = [];
      const unsubscribe = client.subscribe(() => {
        const { status } = client.getState();
        if (status !== "open") drops.push(status);
      });
      // Negative assertion: a spurious re-dial cannot be polled for, so several
      // beats get room to misfire before the check.
      await Bun.sleep(300);
      unsubscribe();
      expect(drops).toEqual([]);
    } finally {
      client.stop();
    }
  });

  test("a missed pong re-dials instead of trusting the dead socket", async () => {
    // A bare websocket server that never answers pings stands in for a dead
    // relay path; the real relay always pongs at the edge.
    let dials = 0;
    const mute = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("expected websocket upgrade", { status: 426 });
      },
      websocket: {
        open() {
          dials += 1;
        },
        message() {},
      },
    });
    const client = new RelayClient({
      url: `ws://127.0.0.1:${mute.port}/app`,
      token: TOKEN,
      key,
      pingIntervalMs: 40,
      pongTimeoutMs: 80,
    });
    try {
      client.start();
      await pollUntil(() => dials >= 2, "a second dial after the missed pong");
    } finally {
      client.stop();
      mute.stop(true);
    }
  });
});

/**
 * Store orchestration against the real relay. These live here rather than in
 * their own file: each file booting its own workerd trips the boot-after-dispose
 * stdio failure scripts/test.ts documents, and the relay above is already paid for.
 */
const online =
  (deviceId: string) =>
  (state: AppState): boolean =>
    state.relay.machines.some((machine) => machine.deviceId === deviceId && machine.connected);

describe("store", () => {
  function startStore(
    form: Partial<PersistedForm>,
    opts: Parameters<typeof startClient>[0] = {},
  ): {
    store: Store;
    waitForApp: (predicate: (state: AppState) => boolean, label: string) => Promise<AppState>;
    stop: () => void;
  } {
    const { client } = startClient(opts);
    const store = new Store(client, { ...DEFAULT_FORM, ...form });
    const detach = store.attach();
    const waitForApp = (predicate: (state: AppState) => boolean, label: string): Promise<AppState> =>
      new Promise((resolve, reject) => {
        const check = (): boolean => {
          if (!predicate(store.getState())) return false;
          clearTimeout(timer);
          unsubscribe();
          resolve(store.getState());
          return true;
        };
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error(`${label}: never satisfied; last verdict ${JSON.stringify(store.getState().verdict)}`));
        }, 5_000);
        const unsubscribe = store.subscribe(() => void check());
        check();
      });
    return {
      store,
      waitForApp,
      stop: (): void => {
        detach();
        client.stop();
      },
    };
  }

  test("a repo_not_found retry rescans before spawning again", async () => {
    const deviceId = nextDeviceId();
    const ops: string[] = [];
    // The daemon knows the repo again only once it has rescanned — the exact
    // stale-cache shape the retry exists for.
    let rescanned = false;
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Rescanner"), {
      sessions: () => ({ sessions: [], at: Date.now() }),
      rescan: () => {
        ops.push("rescan");
        rescanned = true;
        return { repos: machineInfo("Rescanner").repos, scannedAt: Date.now() };
      },
      spawn: () => {
        ops.push("spawn");
        return rescanned
          ? { ok: true, window: "port-the-pane", path: "/tmp/w", sessions: [] }
          : { ok: false, code: "repo_not_found", message: "no repo named seance" };
      },
    });
    const { store, waitForApp, stop } = startStore({
      machineId: deviceId,
      repos: { [deviceId]: "seance" },
      prompt: "port the pane",
    });
    try {
      await waitForApp(online(deviceId), "machine online");
      await store.spawn();
      const failed = store.getState().verdict;
      if (failed?.kind !== "failed") throw new Error(`expected failed verdict, got ${JSON.stringify(failed)}`);
      expect(failed.code).toBe("repo_not_found");

      store.retrySpawn(failed);
      await waitForApp((state) => state.verdict?.kind === "ok", "retry landed");
      expect(ops).toEqual(["spawn", "rescan", "spawn"]);
    } finally {
      stop();
      daemon.close();
    }
  });

  test("a repo the rescan still misses lands a conclusive verdict instead of looping", async () => {
    const deviceId = nextDeviceId();
    const ops: string[] = [];
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Gone"), {
      sessions: () => ({ sessions: [], at: Date.now() }),
      // The fresh scan no longer carries the repo the form remembers.
      rescan: () => ({
        repos: [{ name: "pengefix", path: "/Users/m/pengefix", defaultBranch: "main" }],
        scannedAt: Date.now(),
      }),
      spawn: () => {
        ops.push("spawn");
        return { ok: false, code: "repo_not_found", message: "no repo named seance" };
      },
    });
    const { store, waitForApp, stop } = startStore({ machineId: deviceId, repos: { [deviceId]: "seance" } });
    try {
      await waitForApp(online(deviceId), "machine online");
      await store.spawn();
      const failed = store.getState().verdict;
      if (failed?.kind !== "failed") throw new Error(`expected failed verdict, got ${JSON.stringify(failed)}`);
      store.retrySpawn(failed);
      const state = await waitForApp(
        (s) => s.verdict?.kind === "failed" && s.verdict.rescan === "missing",
        "conclusive verdict",
      );
      if (state.verdict?.kind !== "failed") throw new Error("unreachable");
      expect(state.verdict.code).toBe("repo_not_found");
      // The rescan answered — no second spawn was attempted.
      expect(ops).toEqual(["spawn"]);
      expect(state.spawning).toBe(false);
      expect(state.rescanning).toBe(false);
    } finally {
      stop();
      daemon.close();
    }
  });

  test("a retry whose rescan never lands says so instead of spawning into the stale cache", async () => {
    const deviceId = nextDeviceId();
    const ops: string[] = [];
    // Answers the spawn but not the rescan, which can then only time out.
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Deaf"), {
      sessions: () => ({ sessions: [], at: Date.now() }),
      spawn: () => {
        ops.push("spawn");
        return { ok: false, code: "repo_not_found", message: "no repo named seance" };
      },
    });
    const { store, waitForApp, stop } = startStore(
      { machineId: deviceId, repos: { [deviceId]: "seance" } },
      { timeouts: { rescan: 300 } },
    );
    try {
      await waitForApp(online(deviceId), "machine online");
      await store.spawn();
      const failed = store.getState().verdict;
      if (failed?.kind !== "failed") throw new Error(`expected failed verdict, got ${JSON.stringify(failed)}`);

      store.retrySpawn(failed);
      // The rescan is in flight and nothing has been sent to the daemon yet.
      expect(store.getState().rescanning).toBe(true);
      expect(store.getState().spawning).toBe(false);
      const state = await waitForApp(
        (s) => s.verdict?.kind === "failed" && s.verdict.rescan === "unreachable",
        "the failed rescan reported",
      );
      expect(state.rescanning).toBe(false);
      // Nothing was retried against the cache the rescan failed to refresh.
      expect(ops).toEqual(["spawn"]);
    } finally {
      stop();
      daemon.close();
    }
  });

  test("a rescan that changes nothing still moves the scan time the row shows", async () => {
    const deviceId = nextDeviceId();
    const info = { ...machineInfo("Unchanged"), scannedAt: Date.now() - 2 * 60 * 60 * 1000 };
    const scannedAt = Date.now();
    const daemon = await startFakeDaemon(relay, key, deviceId, info, {
      sessions: () => ({ sessions: [], at: Date.now() }),
      // The set is identical, so a real daemon would not re-register: the reply
      // is the only report this scan ever gets.
      rescan: () => ({ repos: info.repos, scannedAt }),
    });
    const scanTime = (): number | undefined =>
      store.getState().relay.machines.find((machine) => machine.deviceId === deviceId)?.scannedAt;
    const { store, waitForApp, stop } = startStore({ machineId: deviceId });
    try {
      await waitForApp(online(deviceId), "machine online");
      expect(scanTime()).toBe(info.scannedAt);
      await store.rescan();
      expect(store.getState().rescan).toBe("idle");
      expect(scanTime()).toBe(scannedAt);
    } finally {
      stop();
      daemon.close();
    }
  });

  test("a rescan failure survives another sheet and is cleared once its own closes", async () => {
    const deviceId = nextDeviceId();
    // No rescan handler: the request can only time out.
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Mute"), {
      sessions: () => ({ sessions: [], at: Date.now() }),
    });
    const { store, waitForApp, stop } = startStore({ machineId: deviceId }, { timeouts: { rescan: 300 } });
    try {
      await waitForApp(online(deviceId), "machine online");
      store.openSheet("repo");
      void store.rescan();
      expect(store.getState().rescan).toBe("scanning");
      // Backing out into another sheet mid-scan: the failure lands with no repo
      // sheet to show it, so it has to still be there on the next open.
      store.onPopState();
      store.openSheet("model");
      await waitForApp((state) => state.rescan === "failed", "rescan failure surfaced");
      store.onPopState();
      store.openSheet("repo");
      expect(store.getState().rescan).toBe("failed");
      store.onPopState();
      expect(store.getState().rescan).toBe("idle");
    } finally {
      stop();
      daemon.close();
    }
  });

  test("reusePrompt restores the prompt the success verdict stashed", async () => {
    const deviceId = nextDeviceId();
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Reuser"), {
      sessions: () => ({ sessions: [], at: Date.now() }),
      spawn: () => ({ ok: true, window: "resurrect-me", path: "/tmp/w", sessions: [] }),
    });
    const { store, waitForApp, stop } = startStore({
      machineId: deviceId,
      repos: { [deviceId]: "seance" },
      prompt: "resurrect me",
    });
    try {
      await waitForApp(online(deviceId), "machine online");
      await store.spawn();
      const state = store.getState();
      if (state.verdict?.kind !== "ok") throw new Error(`expected ok verdict, got ${JSON.stringify(state.verdict)}`);
      // Cleared on success as before; the verdict carries the copy to restore.
      expect(state.form.prompt).toBe("");
      expect(state.verdict.prompt).toBe("resurrect me");

      store.reusePrompt(state.verdict);
      expect(store.getState().form.prompt).toBe("resurrect me");
    } finally {
      stop();
      daemon.close();
    }
  });
});
