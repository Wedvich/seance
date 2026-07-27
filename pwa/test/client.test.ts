import { importPsk, toBase64, type MachineInfo, type SessionsResponse } from "@seance/shared";
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
