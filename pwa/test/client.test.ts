// Guards shared/src/app-client.ts — the suite lives here because it boots the real
// relay via relay/test/harness.ts, an import direction shared/ must not take on.
import {
  APP_ID,
  DAEMON_ROLES,
  importPsk,
  isRecord,
  newestQuotaByAccount,
  open,
  SCHEDULER_ID,
  seal,
  toBase64,
  type Decision,
  type Envelope,
  type MachineInfo,
  type MachineStatus,
  type Plain,
  type QueueChanged,
  type SessionsResponse,
  type Task,
} from "@seance/shared";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  connectApp,
  connectDaemon,
  newDeviceId,
  register,
  startRelay,
  type TestRelay,
} from "../../relay/test/harness.ts";
import type { ServerWebSocket } from "bun";
import { pollUntil } from "./poll.ts";
import { RelayClient, RequestFailure, type RelayState } from "@seance/shared";
import { startFakeDaemon } from "./daemon.ts";
import { DEFAULT_FORM, RESCAN_IDLE, type PersistedForm } from "../src/state.ts";
import { Store } from "../src/store.ts";
import type { AppState } from "../src/view.ts";
import { fakeHistory, installBrowserGlobals } from "./stubs.ts";

installBrowserGlobals();

const TOKEN = "test-bearer-token";
const PSK = toBase64(new Uint8Array(32).fill(7));
const OTHER_PSK = toBase64(new Uint8Array(32).fill(9));

let relay: TestRelay;
let key: CryptoKey;
let otherKey: CryptoKey;
/**
 * The ids the scheduler suites nominate, minted before boot so the relay's
 * SCHEDULER_LEADERS can list them, as an operator lists real machines.
 */
let listed: { readonly legLeader: string; readonly stolenSeed: string; readonly autoLeader: string };

beforeAll(async () => {
  const [legLeader, stolenSeed, autoLeader] = await Promise.all([newDeviceId(), newDeviceId(), newDeviceId()]);
  listed = { legLeader, stolenSeed, autoLeader };
  relay = await startRelay(TOKEN, { leaders: [legLeader, stolenSeed, autoLeader] });
  key = await importPsk(PSK);
  otherKey = await importPsk(OTHER_PSK);
});

afterAll(async () => {
  await relay.dispose();
});

// The registry is permanent by design, so every test owns its own deviceId
// (minted with a key the relay will accept a register for) and asserts on its
// own entry rather than on the whole list.
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
    readonly pingIntervalMs?: number;
    readonly pongTimeoutMs?: number;
    /** Wire-log sink; the suites that assert on a frame the client only logs pass one. */
    readonly log?: (line: string) => void;
    /** Dials somewhere other than the real relay; only the hostile-peer suite does. */
    readonly url?: string;
    /** A scheduler leader's leg; only the scheduler suite builds one. */
    readonly scheduler?: { readonly term: number };
  } = {},
): {
  client: RelayClient;
  waitFor: (predicate: (state: RelayState) => boolean, label: string) => Promise<RelayState>;
} {
  const client = new RelayClient({
    url: opts.url ?? appUrl(),
    token: opts.token ?? TOKEN,
    key,
    // Bun's client and workerd disagree about permessage-deflate once a few
    // registry frames have gone by, and the socket dies with 1002 "Invalid
    // compressed data". Browsers handle the extension fine; suppressing the
    // offer keeps these tests measuring the relay instead of that bug.
    createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
    ...(opts.timeouts === undefined ? {} : { timeouts: opts.timeouts }),
    ...(opts.pingIntervalMs === undefined ? {} : { pingIntervalMs: opts.pingIntervalMs }),
    ...(opts.pongTimeoutMs === undefined ? {} : { pongTimeoutMs: opts.pongTimeoutMs }),
    ...(opts.log === undefined ? {} : { log: opts.log }),
    ...(opts.scheduler === undefined ? {} : { scheduler: opts.scheduler }),
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
      await pollUntil(() => !client.getState().settling, "the settle window to elapse");
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
    const deviceId = await newDeviceId();
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
    const deviceId = await newDeviceId();
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
    const deviceId = await newDeviceId();
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

  // The registry pairs a plaintext deviceId with a blob only the PSK holders can
  // read, so a bearer token alone is enough to re-file one machine's blob under
  // another's id — the picker would then show A's name and repos on an entry that
  // spawns on B. `from` is AAD-bound, which makes the pairing checkable.
  test("drops an entry whose info blob is sealed from a different deviceId", async () => {
    const real = await newDeviceId();
    const impostor = await newDeviceId();
    const plain: Plain = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      op: "machine-info",
      payload: machineInfo("Victim Laptop"),
    };
    const info = await seal(key, { to: APP_ID, from: real }, plain);

    const { client, waitFor } = startClient();
    const honest = await connectDaemon(relay);
    const thief = await connectDaemon(relay);
    try {
      const before = await waitFor((s) => s.registrySettled, "the first registry push");
      honest.send(await register(real, { info }));
      // Byte-identical, so a cache keyed on the envelope alone would serve the
      // machine the honest entry decrypted. The thief signs for an id of their
      // own — the relay checks who sent the register, not what it says.
      thief.send(await register(impostor, { info }));

      const state = await waitFor((s) => s.registrySize >= before.registrySize + 2, "both entries in the registry");
      expect(state.machines.map((m) => m.deviceId)).toContain(real);
      expect(state.machines.map((m) => m.deviceId)).not.toContain(impostor);
      // Its own count: "check the pre-shared key" is the wrong advice, since no
      // key rotation makes a re-filed blob belong to the id it sits under.
      expect(state.unbound).toBe(before.unbound + 1);
      expect(state.ignored).toBe(before.ignored);
    } finally {
      honest.close();
      thief.close();
      client.stop();
    }
  });

  test("forgets an offline machine at the relay, and gets it back only if it registers again", async () => {
    const deviceId = await newDeviceId();
    const { client, waitFor } = startClient();
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Gone Fishing"));
    try {
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && m.connected), "machine online");
      daemon.close();
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && !m.connected), "registry sees it gone");

      // The registry is shared across this file, so it is the delta that matters:
      // the entry left the registry, so it is neither listed nor counted as one
      // this key could not open.
      const before = client.getState();
      client.forget(deviceId);
      const removed = await waitFor((s) => !s.machines.some((m) => m.deviceId === deviceId), "entry is gone");
      expect(removed.registrySize).toBe(before.registrySize - 1);
      expect(removed.ignored).toBe(before.ignored);

      const back = await startFakeDaemon(relay, key, deviceId, machineInfo("Gone Fishing"));
      try {
        await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId), "machine is back");
      } finally {
        back.close();
      }
    } finally {
      client.stop();
    }
  });

  // The relay is blind, so connectedness is the one thing it can check before
  // deleting — and the app only offers removal on an offline row, which makes
  // this reachable as a race rather than as a button.
  test("leaves a connected machine's entry alone and logs the refusal", async () => {
    const deviceId = await newDeviceId();
    const lines: string[] = [];
    const { client, waitFor } = startClient({ log: (line) => lines.push(line) });
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Wide Awake"));
    try {
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && m.connected), "machine online");
      client.forget(deviceId);
      await pollUntil(() => lines.some((line) => line.startsWith("wire forget-refused")), "the refusal is logged");
      expect(client.getState().machines.some((m) => m.deviceId === deviceId)).toBe(true);
    } finally {
      daemon.close();
      client.stop();
    }
  });

  test("forgetting an id the registry never held changes nothing", async () => {
    const deviceId = await newDeviceId();
    const { client, waitFor } = startClient();
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Bystander"));
    try {
      const before = await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId), "registry arrived");
      client.forget(await newDeviceId());
      await Bun.sleep(100);
      expect(client.getState().registrySize).toBe(before.registrySize);
    } finally {
      daemon.close();
      client.stop();
    }
  });

  // Reference identity is the whole render bailout: `useState` skips when the
  // state object comes back the same, so a rebuild off an unchanged registry has
  // to hand the previous one back. A scan older than the register blob it would
  // override is the cheapest public way to force that rebuild — it is spent by
  // the very rebuild it triggers.
  test("a rebuild that changes nothing keeps the state object and notifies nobody", async () => {
    const deviceId = await newDeviceId();
    const { client, waitFor } = startClient();
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Steady"));
    try {
      const before = await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && m.connected), "online");
      let notifications = 0;
      // No await from here to the assertions, so no frame can land in between.
      const unsubscribe = client.subscribe(() => {
        notifications += 1;
      });
      client.applyScan(deviceId, { repos: [], scannedAt: 1 });
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
  // sorted here so the one registered second is the one that lands ahead.
  test("a registry push leaves the entries it did not change identical", async () => {
    const minted = [await newDeviceId(), await newDeviceId()].toSorted();
    const inserted = minted[0] ?? "";
    const settled = minted[1] ?? "";
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
});

async function statusEnvelope(deviceId: string, status: MachineStatus, withKey = key): Promise<unknown> {
  const plain: Plain = { id: crypto.randomUUID(), ts: Date.now(), op: "status", payload: status };
  return { t: "status", env: await seal(withKey, { to: APP_ID, from: deviceId }, plain) };
}

function machineOf(state: RelayState, deviceId: string): RelayState["machines"][number] | undefined {
  return state.machines.find((m) => m.deviceId === deviceId);
}

describe("status", () => {
  test("a status lands on its machine, reaches a late app in its first push, and is kept when the socket goes", async () => {
    const deviceId = await newDeviceId();
    const exclaves = [{ id: "default", accountId: "org:acct", extraUsageEnabled: null, authOk: true, skills: [] }];
    const info = { ...machineInfo("Mac Studio"), exclaves };
    const daemon = await startFakeDaemon(relay, key, deviceId, info);
    const { client, waitFor } = startClient();
    const late = startClient();
    try {
      await waitFor((s) => machineOf(s, deviceId)?.connected === true, "machine online");
      const snapshot: MachineStatus = {
        at: 1,
        scan: info.scannedAt,
        cpu: 12,
        sess: [1],
        quota: [{ x: 0, h: 84, s: "cache", at: 1 }],
      };
      daemon.client.send(await statusEnvelope(deviceId, snapshot));
      const state = await waitFor((s) => machineOf(s, deviceId)?.status !== undefined, "status rendered");
      expect(machineOf(state, deviceId)?.status).toEqual(snapshot);
      // What `quota[].x` and `sess` index, so the machines screen can name them.
      expect(machineOf(state, deviceId)?.exclaves).toEqual(exclaves);

      const lateState = await late.waitFor((s) => machineOf(s, deviceId)?.status !== undefined, "status from the push");
      expect(machineOf(lateState, deviceId)?.status).toEqual(snapshot);

      daemon.close();
      const offline = await late.waitFor((s) => machineOf(s, deviceId)?.connected === false, "machine offline");
      // Kept for its accounts' quota; `connected: false` is what keeps it from
      // reading as the asleep machine's pressure (`liveStatus`).
      expect(machineOf(offline, deviceId)?.status).toEqual(snapshot);
      expect(newestQuotaByAccount(offline.machines).get("org:acct")?.deviceId).toBe(deviceId);
    } finally {
      daemon.close();
      client.stop();
      late.client.stop();
    }
  });

  test("a status naming a blob this app does not hold stays hidden; the re-register and the status after it show", async () => {
    const deviceId = await newDeviceId();
    const info = machineInfo("Tower");
    const daemon = await startFakeDaemon(relay, key, deviceId, info);
    const { client, waitFor } = startClient();
    try {
      await waitFor((s) => machineOf(s, deviceId)?.connected === true, "machine online");
      const next = info.scannedAt + 1;
      daemon.client.send(await statusEnvelope(deviceId, { at: 2, scan: next, mem: 50 }));
      // A non-event: nothing to poll for. The relay forwards it either way.
      await Bun.sleep(300);
      expect(machineOf(client.getState(), deviceId)?.status).toBeUndefined();

      // The register clears the relay's snapshot and its floor, so the status
      // that follows it is accepted inside ten seconds of the last.
      const plain: Plain = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        op: "machine-info",
        payload: { ...info, scannedAt: next },
      };
      daemon.client.send(await register(deviceId, { info: await seal(key, { to: APP_ID, from: deviceId }, plain) }));
      await waitFor((s) => machineOf(s, deviceId)?.scannedAt === next, "the new blob lands");
      daemon.client.send(await statusEnvelope(deviceId, { at: 3, scan: next, mem: 60 }));
      const state = await waitFor((s) => machineOf(s, deviceId)?.status !== undefined, "status for the new blob");
      expect(machineOf(state, deviceId)).toMatchObject({ scannedAt: next, status: { at: 3, scan: next, mem: 60 } });
    } finally {
      daemon.close();
      client.stop();
    }
  });

  test("a status that opened clears a timeout's offline mark, like a reply does", async () => {
    const deviceId = await newDeviceId();
    const info = machineInfo("Sleeper");
    const daemon = await startFakeDaemon(relay, key, deviceId, info);
    const { client, waitFor } = startClient({ timeouts: { sessions: 200 } });
    try {
      await waitFor((s) => machineOf(s, deviceId)?.connected === true, "machine online");
      daemon.stop();
      await expect(client.request(deviceId, "sessions", {})).rejects.toMatchObject({ reason: "timeout" });
      await waitFor((s) => machineOf(s, deviceId)?.connected === false, "marked offline");
      daemon.client.send(await statusEnvelope(deviceId, { at: 3, scan: info.scannedAt }));
      await waitFor((s) => machineOf(s, deviceId)?.connected === true, "a snapshot is proof of life");
    } finally {
      daemon.close();
      client.stop();
    }
  });

  test("a status sealed with another key never renders, and costs nothing else", async () => {
    const deviceId = await newDeviceId();
    const info = machineInfo("Mixed");
    const daemon = await startFakeDaemon(relay, key, deviceId, info);
    const { client, waitFor } = startClient();
    try {
      await waitFor((s) => machineOf(s, deviceId)?.connected === true, "machine online");
      daemon.client.send(await statusEnvelope(deviceId, { at: 4, scan: info.scannedAt }, otherKey));
      await Bun.sleep(300);
      const machine = machineOf(client.getState(), deviceId);
      expect(machine?.status).toBeUndefined();
      expect(machine?.connected).toBe(true);
    } finally {
      daemon.close();
      client.stop();
    }
  });
});

describe("requests", () => {
  // The request is the daemon's to bound; what the client owns is that a reply
  // reaches the chart only once parsed — a refusal as its code, junk as null —
  // and that it never asks a daemon that doesn't advertise the op.
  test("metrics carries the request through and hands back only a parsed reply", async () => {
    const deviceId = await newDeviceId();
    const lines: string[] = [];
    const { client, waitFor } = startClient({ log: (line) => lines.push(line) });
    const seen: unknown[] = [];
    const info = { ...machineInfo("MacBook Pro"), capabilities: ["metrics"] };
    const daemon = await startFakeDaemon(relay, key, deviceId, info, {
      metrics: (payload) => {
        seen.push(payload);
        const names = isRecord(payload) ? payload["names"] : undefined;
        if (Array.isArray(names) && names.includes("junk")) return { series: [{ metric: "cpu_pct", points: "no" }] };
        if (Array.isArray(names) && names.includes("huge")) {
          return { ok: false, code: "too_large", message: "ask fewer names" };
        }
        return { series: [{ metric: "cpu_pct", labels: { machine: "mac" }, points: [[1, 12.5]] }] };
      },
    });
    try {
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && m.connected), "machine online");
      const range = { from: 0, to: 30, step: 30 } as const;

      expect(await client.metrics(deviceId, { ...range, names: ["cpu_pct"] })).toEqual({
        series: [{ metric: "cpu_pct", labels: { machine: "mac" }, points: [[1, 12.5]] }],
      });
      expect(seen[0]).toEqual({ ...range, names: ["cpu_pct"] });

      expect(await client.metrics(deviceId, { ...range, names: ["huge"] })).toEqual({
        ok: false,
        code: "too_large",
        message: "ask fewer names",
      });

      expect(await client.metrics(deviceId, { ...range, names: ["junk"] })).toBeNull();
      expect(lines).toContain(`wire dropped from=${JSON.stringify(deviceId)} reason=metrics-shape`);

      // A daemon that predates the op drops it unanswered, so the client refuses
      // up front rather than let the timeout mark a live machine offline.
      daemon.close();
      const older = await startFakeDaemon(relay, key, deviceId, machineInfo("MacBook Pro"), {
        metrics: (payload) => {
          seen.push(payload);
          return { series: [] };
        },
      });
      try {
        await waitFor(
          (s) => s.machines.some((m) => m.deviceId === deviceId && m.connected && m.capabilities === undefined),
          "re-registered without the capability",
        );
        const refused: unknown = await client.metrics(deviceId, range).then(
          () => null,
          (err: unknown) => err,
        );
        expect(refused instanceof RequestFailure && refused.reason).toBe("unsupported");
        expect(seen).toHaveLength(3);
      } finally {
        older.close();
      }

      // The relay this file shares holds 32 entries and the suite sits at that
      // cap, so a test that adds a machine nothing later needs gives it back.
      daemon.close();
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && !m.connected), "registry sees it gone");
      client.forget(deviceId);
      await waitFor((s) => !s.machines.some((m) => m.deviceId === deviceId), "entry is gone");
    } finally {
      daemon.close();
      client.stop();
    }
  });

  test("round-trips a sessions request through the real relay", async () => {
    const deviceId = await newDeviceId();
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
      if ("ok" in reply) throw new Error(reply.message);
      expect(reply.sessions[0]?.window).toBe("port-the-pane-20260727-093214");
    } finally {
      daemon.close();
      client.stop();
    }
  });

  // The app holds the `id`; the relay can only ever name the `iv`. Logging both
  // on each side of a round trip is what makes a relay line joinable to an op.
  test("logs the iv beside the id on the way out and the re on the way back", async () => {
    const deviceId = await newDeviceId();
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
    const deviceId = await newDeviceId();
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
    const deviceId = await newDeviceId();
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
    const deviceId = await newDeviceId();
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
    const deviceId = await newDeviceId();
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
    const deviceId = await newDeviceId();
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

  test("fails in-flight requests when the socket drops: unsent never left, sent may have landed", async () => {
    const deviceId = await newDeviceId();
    const lines: string[] = [];
    const { client, waitFor } = startClient({ log: (line) => lines.push(line) });
    // No `spawn` handler: a request that reaches it is never answered.
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Dropper"));
    try {
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId && m.connected), "machine online");
      // Stopped while still sealing: it never reached the socket.
      const unsent = client.request(deviceId, "spawn", { repo: "seance", mode: "worktree" });
      client.stop();
      await expect(unsent).rejects.toBeInstanceOf(RequestFailure);
      await expect(unsent).rejects.toMatchObject({ reason: "disconnected" });

      client.reconnect();
      await waitFor((s) => s.status === "open", "reconnected");
      const sent = client.request(deviceId, "spawn", { repo: "seance", mode: "worktree" });
      await pollUntil(() => lines.some((line) => line.startsWith("wire send ")), "the request to go out");
      client.stop();
      await expect(sent).rejects.toMatchObject({ reason: "dropped" });
    } finally {
      daemon.close();
    }
  });
});

// The relay pushes presence rather than being polled, so a dead app socket
// freezes the machine list with no other symptom — the pings below bound that.
// The leader's leg (daemon/src/leader.ts) against the real DO: nomination, the
// term fence, and the reply the relay routes to the leader's daemon socket.
describe("scheduler leg", () => {
  type Msg = { t: "msg"; env: Envelope };

  test("a request goes out as the scheduler under its term, and the reply is correlated through deliver", async () => {
    const leaderId = listed.legLeader;
    const targetId = await newDeviceId();
    // Sealed blobs, so both show as machines and can be forgotten after: the
    // registry is capped and permanent, and this file runs close to the cap.
    const info = async (deviceId: string): Promise<Envelope> =>
      seal(
        key,
        { to: APP_ID, from: deviceId },
        { id: deviceId, ts: Date.now(), op: "machine-info", payload: machineInfo(deviceId) },
      );
    const leader = await connectDaemon(relay);
    leader.send(await register(leaderId, { roles: [DAEMON_ROLES.scheduler], info: await info(leaderId) }));
    const { term } = await leader.waitFor<{ t: "lead"; term: number }>("lead");
    const target = await connectDaemon(relay);
    target.send(await register(targetId, { info: await info(targetId) }));
    const { client, waitFor } = startClient({ scheduler: { term } });
    const stale = startClient({ scheduler: { term: term - 1 } });
    try {
      await waitFor((s) => s.status === "open" && s.registrySettled, "open");
      await stale.waitFor((s) => s.status === "open", "stale open");

      const reply = client.request<SessionsResponse>(targetId, "sessions", {});
      const { env } = await target.waitFor<Msg>("msg");
      expect(env.from).toBe(SCHEDULER_ID);
      const request = await open(key, env);
      // The target answers `env.from`, as a real daemon does.
      const payload: SessionsResponse = { sessions: [], at: Date.now() };
      const answer: Plain = { id: crypto.randomUUID(), ts: Date.now(), op: "sessions", re: request.id, payload };
      target.send({ t: "msg", env: await seal(key, { to: SCHEDULER_ID, from: targetId }, answer) });
      // Routed to the leader's daemon socket, never to an app one.
      const routed = await leader.waitFor<Msg>("msg");
      await client.deliver(routed.env);
      expect(await reply).toEqual(payload);

      await expect(stale.client.request(targetId, "sessions", {})).rejects.toMatchObject({ reason: "not_leader" });
      await target.expectNo("msg");
    } finally {
      stale.client.stop();
      target.close();
      leader.close();
      const ids = [leaderId, targetId];
      await waitFor((s) => s.machines.every((m) => !ids.includes(m.deviceId) || !m.connected), "both gone");
      for (const id of ids) client.forget(id);
      await waitFor((s) => s.machines.every((m) => !ids.includes(m.deviceId)), "both forgotten");
      client.stop();
    }
  });
});

// The queue ops and the nudge, against the real DO and a leader's two legs: its daemon
// socket (where requests arrive and replies leave) and its app-role leg under the term.
describe("queue ops", () => {
  type Msg = { t: "msg"; env: Envelope };

  test("mark-done, pause, resume, discard and a filtered queue round-trip; a leader's queue-changed reaches apps and nothing forged does", async () => {
    const leaderId = listed.legLeader;
    const info = await seal(
      key,
      { to: APP_ID, from: leaderId },
      { id: leaderId, ts: Date.now(), op: "machine-info", payload: machineInfo(leaderId) },
    );
    const leader = await connectDaemon(relay);
    leader.send(await register(leaderId, { roles: [DAEMON_ROLES.scheduler], info }));
    const { term } = await leader.waitFor<{ t: "lead"; term: number }>("lead");
    const proof = await seal(
      key,
      { to: APP_ID, from: leaderId },
      { id: crypto.randomUUID(), ts: Date.now(), op: "lead-proof", payload: { term } },
    );
    leader.send({ t: "lead-proof", term, env: proof });
    const { client, waitFor } = startClient();
    const leg = startClient({ scheduler: { term } });
    const raw = await connectApp(relay);
    const heard: QueueChanged[] = [];
    const legHeard: QueueChanged[] = [];
    const stopHearing = client.onQueueChanged((change) => heard.push(change));
    const stopLeg = leg.client.onQueueChanged((change) => legHeard.push(change));

    // The leader's side of one request: what arrived, then the reply it sends.
    const answer = async (payload: unknown): Promise<Plain> => {
      const plain = await open(key, (await leader.waitFor<Msg>("msg")).env);
      const reply: Plain = { id: crypto.randomUUID(), ts: Date.now(), op: plain.op, re: plain.id, payload };
      leader.send({ t: "msg", env: await seal(key, { to: APP_ID, from: leaderId }, reply) });
      return plain;
    };
    const task: Task = {
      id: "t",
      spec: { repo: "github.com/acme/app", mode: "worktree" },
      state: "done",
      createdAt: 1,
    };

    try {
      await waitFor((s) => s.scheduler.kind === "ready", "the leader verified");
      await leg.waitFor((s) => s.status === "open", "the leg open");

      const marked = client.markDone("t");
      const sent = await answer({ task: { ...task, doneBy: "manual" } });
      expect(sent).toMatchObject({ op: "mark-done", payload: { taskId: "t" } });
      expect(await marked).toEqual({ task: { ...task, doneBy: "manual" } });

      const paused = client.pause({ until: "resume" });
      expect(await answer({ holds: [{ until: "resume", at: 1 }] })).toMatchObject({
        op: "pause",
        payload: { until: "resume" },
      });
      expect(await paused).toEqual({ holds: [{ until: "resume", at: 1 }] });

      const resumed = client.resume({ account: "acct" });
      expect(await answer({ holds: [] })).toMatchObject({ op: "resume", payload: { account: "acct" } });
      expect(await resumed).toEqual({ holds: [] });

      const discarded = client.discard({ taskId: "t", version: 3 });
      expect(await answer({ taskId: "t" })).toMatchObject({ op: "discard", payload: { taskId: "t", version: 3 } });
      expect(await discarded).toEqual({ taskId: "t" });

      const filtered = client.queue({ tasks: ["t"] });
      expect(await answer({ tasks: [], at: 1 })).toMatchObject({ op: "queue", payload: { tasks: ["t"] } });
      expect(await filtered).toEqual({ tasks: [], at: 1 });

      // A nudge sealed from the app address is anyone-with-the-key's, not the leader's: not heard.
      const forged: Plain = { id: crypto.randomUUID(), ts: Date.now(), op: "queue-changed", payload: { at: 2 } };
      raw.send({ t: "msg", env: await seal(key, { to: APP_ID, from: APP_ID }, forged) });
      // Sent after, so by the time it is heard the forged one has been seen and dropped.
      expect(await leg.client.queueChanged({ at: 3, tasks: ["t"] })).toBe(true);
      await pollUntil(() => heard.length > 0, "the leader's nudge");
      expect(heard).toEqual([{ at: 3, tasks: ["t"] }]);
      // Only an app's client listens: the leader's own leg ignores the fan-out of its nudge.
      expect(legHeard).toEqual([]);
      // An app's client has no term, so it cannot send one.
      expect(await client.queueChanged({ at: 4 })).toBe(false);
    } finally {
      stopHearing();
      stopLeg();
      raw.close();
      leg.client.stop();
      leader.close();
      await waitFor((s) => s.machines.every((m) => m.deviceId !== leaderId || !m.connected), "the leader gone");
      client.forget(leaderId);
      await waitFor((s) => s.machines.every((m) => m.deviceId !== leaderId), "the leader forgotten");
      client.stop();
    }
  });
});

describe("auto", () => {
  type Msg = { t: "msg"; env: Envelope };
  const decision: Decision = { at: 1, chosen: null, candidates: [] };

  test("a nominee whose entry does not open is unverified and is sent nothing; one whose entry opens answers", async () => {
    const squatterId = listed.stolenSeed;
    const leaderId = listed.autoLeader;
    const { client, waitFor } = startClient();
    // The reader check as the allowlist's tripwire: a listed machine's seed
    // copied out of state.json without the PSK — a signed register with roles,
    // and an info blob it could not seal under the PSK.
    const squatter = await connectDaemon(relay);
    squatter.send(await register(squatterId, { roles: [DAEMON_ROLES.scheduler] }));
    await squatter.waitFor("lead");
    let leader: Awaited<ReturnType<typeof connectDaemon>> | null = null;
    try {
      const unverified = await waitFor((s) => s.scheduler.kind === "unverified", "the squatter nominated");
      expect(unverified.scheduler).toMatchObject({ kind: "unverified", deviceId: squatterId });
      const request = { repo: "github.com/acme/app", mode: "worktree" } as const;
      await expect(client.routePreview(request)).rejects.toMatchObject({ reason: "leader_unverified" });
      await expect(client.markDone("t")).rejects.toMatchObject({ reason: "leader_unverified" });
      await squatter.expectNo("msg");

      squatter.close();
      await waitFor((s) => s.scheduler.kind === "none", "no leader once the squatter goes");
      await expect(client.queue()).rejects.toMatchObject({ reason: "no_leader" });

      leader = await connectDaemon(relay);
      const info = await seal(
        key,
        { to: APP_ID, from: leaderId },
        { id: leaderId, ts: Date.now(), op: "machine-info", payload: machineInfo(leaderId) },
      );
      leader.send(await register(leaderId, { roles: [DAEMON_ROLES.scheduler], info }));
      // Its entry opens, but only the term sealed under the key makes it a leader.
      const { term } = await leader.waitFor<{ t: "lead"; term: number }>("lead");
      await waitFor(
        (s) => s.scheduler.kind === "unverified" && s.machines.some((m) => m.deviceId === leaderId),
        "proofless",
      );
      const proof = await seal(
        key,
        { to: APP_ID, from: leaderId },
        { id: crypto.randomUUID(), ts: Date.now(), op: "lead-proof", payload: { term } },
      );
      leader.send({ t: "lead-proof", term, env: proof });
      await waitFor((s) => s.scheduler.kind === "ready", "the real leader verified");
      const asked = client.routePreview(request);
      const { env } = await leader.waitFor<Msg>("msg");
      expect({ to: env.to, from: env.from }).toEqual({ to: SCHEDULER_ID, from: APP_ID });
      const plain = await open(key, env);
      expect(plain).toMatchObject({ op: "route-preview", payload: request });
      const reply: Plain = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        op: "route-preview",
        re: plain.id,
        payload: { decision },
      };
      leader.send({ t: "msg", env: await seal(key, { to: APP_ID, from: leaderId }, reply) });
      expect(await asked).toEqual({ decision });

      // A reply this build cannot read is null, never half a decision.
      const garbled = client.routePreview(request);
      const second = await open(key, (await leader.waitFor<Msg>("msg")).env);
      const bad: Plain = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        op: "route-preview",
        re: second.id,
        payload: { decision: { at: "x" } },
      };
      leader.send({ t: "msg", env: await seal(key, { to: APP_ID, from: leaderId }, bad) });
      expect(await garbled).toBeNull();
    } finally {
      squatter.close();
      leader?.close();
      const ids = [squatterId, leaderId];
      await pollUntil(() => client.getState().scheduler.kind === "none", "both gone");
      for (const id of ids) client.forget(id);
      await waitFor((s) => s.registrySize === 0 || s.machines.every((m) => !ids.includes(m.deviceId)), "forgotten");
      client.stop();
    }
  });
});

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
      hostname: "127.0.0.1",
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

  test("a rescan that changes nothing still moves the scan time the row shows", async () => {
    const deviceId = await newDeviceId();
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
    const { store, waitForApp, stop } = startStore({ machine: deviceId });
    try {
      await waitForApp(online(deviceId), "machine online");
      expect(scanTime()).toBe(info.scannedAt);
      await store.rescan(deviceId);
      expect(store.getState().rescan).toEqual(RESCAN_IDLE);
      expect(scanTime()).toBe(scannedAt);
    } finally {
      stop();
      daemon.close();
    }
  });

  test("a rescan failure survives another sheet and is cleared once its own closes", async () => {
    const deviceId = await newDeviceId();
    // No rescan handler: the request can only time out.
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Mute"), {
      sessions: () => ({ sessions: [], at: Date.now() }),
    });
    const { store, waitForApp, stop } = startStore({ machine: deviceId }, { timeouts: { rescan: 300 } });
    try {
      await waitForApp(online(deviceId), "machine online");
      store.openSheet("machine");
      void store.rescan(deviceId);
      expect(store.getState().rescan).toEqual({ kind: "scanning", deviceId });
      // Backing out into another sheet mid-scan: the failure lands with no Machine
      // sheet to show it, so it has to still be there on the next open.
      store.onPopState();
      store.openSheet("model");
      await waitForApp((state) => state.rescan.kind === "failed", "rescan failure surfaced");
      store.onPopState();
      store.openSheet("machine");
      expect(store.getState().rescan).toEqual({ kind: "failed", deviceId });
      store.onPopState();
      expect(store.getState().rescan).toEqual(RESCAN_IDLE);
    } finally {
      stop();
      daemon.close();
    }
  });

  test("a confirmed forget takes the machine's pin and session list with it", async () => {
    const deviceId = await newDeviceId();
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Retired"), {
      sessions: () => ({ sessions: [], at: Date.now() }),
    });
    const { store, waitForApp, stop } = startStore({ machine: deviceId });
    try {
      await waitForApp((s) => s.sessions[deviceId] !== undefined, "sessions fetched");
      daemon.close();
      await waitForApp(
        (s) => s.relay.machines.some((m) => m.deviceId === deviceId && !m.connected),
        "registry sees it gone",
      );

      store.removeMachine(deviceId);
      const state = await waitForApp(
        (s) => !s.relay.machines.some((m) => m.deviceId === deviceId),
        "entry left the registry",
      );
      expect(state.form.machine).toBeNull();
      expect(state.sessions[deviceId]).toBeUndefined();
    } finally {
      stop();
    }
  });

  // The bin is only offered on an offline row, so this is a race: the daemon
  // reconnected between the render and the tap. The relay refuses, and the app
  // must not have thrown the selection away on the way there.
  test("a refused forget leaves the pin where it was", async () => {
    const deviceId = await newDeviceId();
    const daemon = await startFakeDaemon(relay, key, deviceId, machineInfo("Wide Awake Too"), {
      sessions: () => ({ sessions: [], at: Date.now() }),
    });
    const { store, waitForApp, stop } = startStore({ machine: deviceId });
    try {
      await waitForApp(online(deviceId), "machine online");
      store.removeMachine(deviceId);
      // A negative assertion: nothing to poll for, only a deletion that must not land.
      await Bun.sleep(250);

      const state = store.getState();
      expect(state.relay.machines.some((m) => m.deviceId === deviceId)).toBe(true);
      expect(state.form.machine).toBe(deviceId);
    } finally {
      stop();
      daemon.close();
    }
  });
});

describe("registry settle", () => {
  // The bit both `LazyRelay` and the Raycast view key on: false between `open`
  // and the first registry frame, true from that frame on, re-armed by a
  // re-dial — so a connection flap never reads as "every machine vanished".
  test("settles on the first registry frame and re-arms on a re-dial", async () => {
    const { client, waitFor } = startClient();
    try {
      expect(client.getState().registrySettled).toBe(false);
      const state = await waitFor((s) => s.registrySettled, "the registry to settle");
      expect(state.status).toBe("open");
      client.reconnect();
      expect(client.getState().registrySettled).toBe(false);
      await waitFor((s) => s.registrySettled, "the registry to settle again");
    } finally {
      client.stop();
    }
  });

  // The relay pushes the registry on every app connect, so the timer is the
  // bound for an abnormal peer that never does.
  test("declares an unpushed registry settled once the bound elapses", async () => {
    const silent = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request) ? undefined : new Response("expected a websocket", { status: 400 });
      },
      websocket: { message() {} },
    });
    const client = new RelayClient({
      url: `ws://127.0.0.1:${silent.port}/app`,
      token: TOKEN,
      key,
      registrySettleMs: 30,
      createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
    });
    try {
      client.start();
      await pollUntil(() => client.getState().registrySettled, "the settle bound to elapse");
      expect(client.getState().machines).toEqual([]);
    } finally {
      client.stop();
      await silent.stop(true);
    }
  });
});

/**
 * A peer that says exactly what a test tells it to. Not a relay double — it
 * models nothing and answers nothing — but the real relay cannot be made to
 * send a frame it would never send, and that is the case these tests pin: a
 * relay that is hostile, or simply a version ahead. `received` is there so a
 * test can read back the iv the client sent, which is all a blind relay ever
 * has to correlate with.
 */
interface HostilePeer {
  readonly url: string;
  readonly send: (frame: unknown) => void;
  readonly sendText: (text: string) => void;
  readonly received: readonly string[];
  readonly stop: () => Promise<void>;
}

function startHostilePeer(): HostilePeer {
  const received: string[] = [];
  let socket: ServerWebSocket<unknown> | null = null;
  const peerServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response("expected a websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        socket = ws;
      },
      message(ws, message) {
        // Every request carries a probe ping; an unanswered heartbeat would
        // re-dial mid-test and is not what any of this measures.
        if (message === "ping") {
          ws.send("pong");
          return;
        }
        received.push(String(message));
      },
      close() {
        socket = null;
      },
    },
  });
  const sendText = (text: string): void => {
    if (socket === null) throw new Error("the client has not connected to the peer yet");
    socket.send(text);
  };
  return {
    url: `ws://127.0.0.1:${peerServer.port}/app`,
    send: (frame) => sendText(JSON.stringify(frame)),
    sendText,
    received,
    stop: () => peerServer.stop(true),
  };
}

/** A sound push, so a test can prove the client still applies one afterwards. */
async function registryFrame(deviceId: string, info: MachineInfo): Promise<unknown> {
  const plain: Plain = { id: crypto.randomUUID(), ts: Date.now(), op: "machine-info", payload: info };
  return {
    t: "registry",
    entries: [
      {
        deviceId,
        info: await seal(key, { to: APP_ID, from: deviceId }, plain),
        lastSeen: Date.now(),
        connected: true,
      },
    ],
  };
}

describe("malformed frames", () => {
  // The wedge this suite exists for: the missing list was assigned before the
  // throw, so every later rebuild — a scan, a delivery failure — threw
  // on it too, and the tab was dead until reload.
  test("drops a registry frame with no entries instead of wedging every later rebuild", async () => {
    const peer = startHostilePeer();
    const deviceId = await newDeviceId();
    const { client, waitFor } = startClient({ url: peer.url });
    try {
      await waitFor((s) => s.status === "open", "open");
      peer.sendText(JSON.stringify({ t: "registry" }));
      // A non-event has nothing to poll for, so the sleep is the assertion's setup.
      await Bun.sleep(50);
      expect(client.getState().machines).toEqual([]);
      client.applyScan(deviceId, { repos: [], scannedAt: Date.now() });
      peer.send(await registryFrame(deviceId, machineInfo("Still Here")));
      const state = await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId), "a sound push still lands");
      expect(state.registrySize).toBe(1);
    } finally {
      client.stop();
      await peer.stop();
    }
  });

  // Its own handler's catch used to throw as well: the reason line quotes `env.iv`.
  test("drops a msg frame with no envelope", async () => {
    const peer = startHostilePeer();
    const deviceId = await newDeviceId();
    const { client, waitFor } = startClient({ url: peer.url });
    try {
      await waitFor((s) => s.status === "open", "open");
      peer.sendText(JSON.stringify({ t: "msg" }));
      await Bun.sleep(50);
      peer.send(await registryFrame(deviceId, machineInfo("Unbothered")));
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId), "a sound push still lands");
    } finally {
      client.stop();
      await peer.stop();
    }
  });

  // An unknown `t` fell through to the envelope branch, so it crashed exactly
  // the way a msg with no envelope did.
  test("drops a frame whose type this build does not know, and says so without echoing it", async () => {
    const peer = startHostilePeer();
    const deviceId = await newDeviceId();
    const lines: string[] = [];
    const realLog = console.log;
    try {
      const { client, waitFor } = startClient({ url: peer.url });
      try {
        await waitFor((s) => s.status === "open", "open");
        console.log = (...args: unknown[]): void => {
          lines.push(args.map(String).join(" "));
        };
        peer.send({ t: "from-a-later-relay", secret: "never-in-a-log-line" });
        await pollUntil(() => lines.some((line) => line.startsWith("wire dropped ")), "the drop to be logged");
        console.log = realLog;
        expect(lines).toContain("wire dropped reason=frame");
        expect(lines.join("\n")).not.toContain("never-in-a-log-line");

        peer.send(await registryFrame(deviceId, machineInfo("Unbothered")));
        await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId), "a sound push still lands");
      } finally {
        client.stop();
        await peer.stop();
      }
    } finally {
      console.log = realLog;
    }
  });

  test("hands a store-changed nudge to its listeners and drops a malformed one", async () => {
    const peer = startHostilePeer();
    const lines: string[] = [];
    const { client, waitFor } = startClient({ url: peer.url, log: (line) => lines.push(line) });
    // Its own peer: a hostile peer holds one socket.
    const legPeer = startHostilePeer();
    const leg = startClient({ url: legPeer.url, scheduler: { term: 1 } });
    try {
      await waitFor((s) => s.status === "open", "open");
      await leg.waitFor((s) => s.status === "open", "the term leg open");
      const heard: [string, number][] = [];
      const legHeard: string[] = [];
      const stop = client.onStoreChanged((changed, version) => heard.push([changed, version]));
      leg.client.onStoreChanged((changed) => legHeard.push(changed));
      peer.send({ t: "store-changed", key: "account:a-1", version: 3 });
      legPeer.send({ t: "store-changed", key: "account:a-1", version: 3 });
      await pollUntil(() => heard.length > 0, "the nudge to reach the listener");
      expect(heard).toEqual([["account:a-1", 3]]);
      expect(lines.some((line) => line.startsWith("wire dropped"))).toBe(false);

      peer.send({ t: "store-changed", key: "account:a-1", version: -1 });
      peer.send({ t: "store-changed", key: "no prefix", version: 5 });
      await pollUntil(
        () => lines.filter((line) => line === "wire dropped reason=frame").length === 2,
        "both malformed nudges to be dropped",
      );
      stop();
      peer.send({ t: "store-changed", key: "account:a-1", version: 4 });
      // A non-event has nothing to poll for.
      await Bun.sleep(50);
      expect(heard).toEqual([["account:a-1", 3]]);
      expect(legHeard).toEqual([]);
    } finally {
      client.stop();
      leg.client.stop();
      await peer.stop();
      await legPeer.stop();
    }
  });

  // Every push carries the full stored registry, so dropping a push over one
  // bad entry would drop every push for as long as that entry stays stored —
  // an authoritative "no machines" out of one machine a version ahead.
  test("skips the registry entries that do not parse, keeping the ones that do and counting the skew", async () => {
    const peer = startHostilePeer();
    const deviceId = await newDeviceId();
    const { client, waitFor } = startClient({ url: peer.url });
    try {
      await waitFor((s) => s.status === "open", "open");
      const sound = (await registryFrame(deviceId, machineInfo("Trusted"))) as { entries: unknown[] };
      peer.send({ t: "registry", entries: [...sound.entries, { deviceId: "half-written" }] });
      const state = await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId), "the sound entry lands");
      expect(state.registrySize).toBe(2);
      expect(state.skewed).toBe(1);
      expect(state.ignored).toBe(0);
    } finally {
      client.stop();
      await peer.stop();
    }
  });

  // The relay checks a status's `from` against the socket it came in on, so
  // only a peer that is not the relay can pair one machine's snapshot with
  // another's id — and `from` is AAD-bound, which makes the pairing checkable.
  test("drops a status whose envelope is sealed from another id than the frame names", async () => {
    const peer = startHostilePeer();
    const deviceId = await newDeviceId();
    const other = await newDeviceId();
    const lines: string[] = [];
    const { client, waitFor } = startClient({ url: peer.url, log: (line) => lines.push(line) });
    try {
      await waitFor((s) => s.status === "open", "open");
      const info = machineInfo("Victim");
      peer.send(await registryFrame(deviceId, info));
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId), "the machine lands");
      const plain: Plain = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        op: "status",
        payload: { at: 1, scan: info.scannedAt, cpu: 99 },
      };
      peer.send({ t: "status", deviceId, env: await seal(key, { to: APP_ID, from: other }, plain) });
      await pollUntil(
        () => lines.some((line) => line.includes("reason=status-from-mismatch")),
        "the drop to be logged",
      );
      expect(client.getState().machines.find((m) => m.deviceId === deviceId)?.status).toBeUndefined();
      // And one with no envelope at all is a frame drop, not a wedge.
      peer.sendText(JSON.stringify({ t: "status", deviceId }));
      await pollUntil(() => lines.includes("wire dropped reason=frame"), "the frame drop to be logged");
      peer.send({ t: "status", deviceId, env: await seal(key, { to: APP_ID, from: deviceId }, plain) });
      await waitFor(
        (s) => s.machines.find((m) => m.deviceId === deviceId)?.status?.cpu === 99,
        "a sound status still lands",
      );
    } finally {
      client.stop();
      await peer.stop();
    }
  });

  // Both blobs are opened outside the replay guard and bound to their machine
  // by `from` alone, so `op` is what says which blob a slot holds — each
  // payload here is shaped for the slot it is moved into, so shape cannot.
  test("opens a blob at rest only as the op its slot expects, both ways", async () => {
    const peer = startHostilePeer();
    const deviceId = await newDeviceId();
    const lines: string[] = [];
    const { client, waitFor } = startClient({ url: peer.url, log: (line) => lines.push(line) });
    const sealAs = async (op: Plain["op"], payload: unknown): Promise<unknown> =>
      seal(key, { to: APP_ID, from: deviceId }, { id: crypto.randomUUID(), ts: Date.now(), op, payload });
    try {
      await waitFor((s) => s.status === "open", "open");
      const info = machineInfo("Swapped");
      const entry = { deviceId, lastSeen: Date.now(), connected: true };
      peer.send({ t: "registry", entries: [{ ...entry, info: await sealAs("status", info) }] });
      await pollUntil(() => lines.some((line) => line.includes("reason=info-op")), "the info drop to be logged");
      expect(client.getState().machines).toEqual([]);

      peer.send(await registryFrame(deviceId, info));
      await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId), "a sound info lands");
      const status = { at: Math.floor(Date.now() / 1000), scan: info.scannedAt, cpu: 99 };
      peer.send({ t: "status", deviceId, env: await sealAs("machine-info", status) });
      await pollUntil(() => lines.some((line) => line.includes("reason=status-op")), "the status drop to be logged");
      expect(client.getState().machines.find((m) => m.deviceId === deviceId)?.status).toBeUndefined();
      peer.send({ t: "status", deviceId, env: await sealAs("status", status) });
      await waitFor(
        (s) => s.machines.find((m) => m.deviceId === deviceId)?.status?.cpu === 99,
        "a status sealed as one lands",
      );
    } finally {
      client.stop();
      await peer.stop();
    }
  });

  // A blob that opens but is not shaped like a MachineInfo used to reach the
  // spawn screen, where `machine.repos.map` runs on every render. It counts as
  // skew, not as ignored: "check the pre-shared key" is the wrong advice for a
  // blob this key just opened.
  test("counts a blob that opens but is not a MachineInfo as skewed, not as a machine", async () => {
    const peer = startHostilePeer();
    const deviceId = await newDeviceId();
    const { client, waitFor } = startClient({ url: peer.url });
    try {
      await waitFor((s) => s.status === "open", "open");
      const plain: Plain = { id: crypto.randomUUID(), ts: Date.now(), op: "machine-info", payload: { name: 7 } };
      peer.send({
        t: "registry",
        entries: [
          {
            deviceId,
            info: await seal(key, { to: APP_ID, from: deviceId }, plain),
            lastSeen: Date.now(),
            connected: true,
          },
        ],
      });
      const state = await waitFor((s) => s.registrySize === 1, "the push to land");
      expect(state.machines).toEqual([]);
      expect(state.skewed).toBe(1);
      expect(state.ignored).toBe(0);
    } finally {
      client.stop();
      await peer.stop();
    }
  });

  // The two facts an undeliverable carries — this request failed, and the relay
  // said so — hold whatever the code turns out to mean, so an unknown one fails
  // the request now instead of riding the full timeout (90s for a spawn).
  test("fails a request fast on an undeliverable whose code this build does not know", async () => {
    const peer = startHostilePeer();
    const deviceId = await newDeviceId();
    const { client, waitFor } = startClient({ url: peer.url });
    try {
      await waitFor((s) => s.status === "open", "open");
      const pending = client.request(deviceId, "sessions", {});
      await pollUntil(() => peer.received.length > 0, "the request to reach the peer");
      const sent = JSON.parse(peer.received[0] ?? "{}") as { readonly env?: { readonly iv?: string } };
      peer.send({ t: "undeliverable", to: deviceId, iv: sent.env?.iv ?? "", code: "from-a-later-relay" });
      await expect(pending).rejects.toMatchObject({
        reason: "refused",
        message: expect.stringContaining("from-a-later-relay"),
      });
    } finally {
      client.stop();
      await peer.stop();
    }
  });

  // The rescan reply lands on `machine.repos`/`scannedAt` and renders every
  // frame, exactly like the register blob — an unchecked one was the same
  // wedge by another door.
  test("applies nothing from a rescan reply that is not shaped like one", async () => {
    const peer = startHostilePeer();
    const deviceId = await newDeviceId();
    const { client, waitFor } = startClient({ url: peer.url });
    try {
      await waitFor((s) => s.status === "open", "open");
      peer.send(await registryFrame(deviceId, machineInfo("Steady")));
      const before = await waitFor((s) => s.machines.some((m) => m.deviceId === deviceId), "the machine to land");
      expect(client.applyScan(deviceId, { repos: null, scannedAt: Date.now() })).toBeNull();
      expect(client.applyScan(deviceId, { repos: [{ name: 7 }], scannedAt: "soon" })).toBeNull();
      expect(client.getState().machines).toBe(before.machines);
    } finally {
      client.stop();
      await peer.stop();
    }
  });
});
