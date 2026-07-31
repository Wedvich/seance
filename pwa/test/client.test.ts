import { APP_ID, importPsk, seal, toBase64, type MachineInfo, type Plain, type SessionsResponse } from "@seance/shared";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRelay, type TestRelay } from "../../relay/test/harness.ts";
import { RelayClient, RequestFailure, type RelayState } from "../src/relay/client.ts";
import { startFakeDaemon } from "./daemon.ts";

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

function startClient(opts: { readonly token?: string; readonly timeouts?: { readonly sessions?: number } } = {}): {
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
