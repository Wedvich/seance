import { afterEach, describe, expect, test } from "bun:test";
import type { MachineStatus } from "@seance/shared";
import { pollUntil } from "../test/fixtures.ts";
import type { Config } from "./config.ts";
import { MetricsStore } from "./metrics-store.ts";
import { startStatusLoop, type StatusLoop } from "./run-collectors.ts";
import type { HostProbe, Registered } from "./telemetry.ts";

const GiB = 2 ** 30;
const FLOOR_MS = 300;

const config: Config = {
  name: "Box",
  relayUrl: "ws://127.0.0.1:1",
  bearerToken: "t",
  psk: "",
  repoRoots: ["/"],
  tmuxSession: "main",
};

const registered: Registered = {
  scan: 1,
  exclaves: { exclaves: [], info: [], rejected: [] },
};

const probe: HostProbe = {
  cpu: () => null,
  memory: async () => ({ total: 16 * GiB, available: 4 * GiB }),
  disks: async (paths) => paths.map(() => ({ total: 100 * GiB, free: 10 * GiB })),
  diskIo: async () => null,
};

interface Sent {
  readonly status: MachineStatus;
  readonly atMs: number;
}

let running: StatusLoop | null = null;

afterEach(() => {
  running?.stop();
  running = null;
});

/** A loop whose beat never fires within a test, so every send is `sampleNow` or `refresh`. */
function start(draining: () => boolean): { readonly loop: StatusLoop; readonly sent: Sent[] } {
  const sent: Sent[] = [];
  const loop = startStatusLoop(
    MetricsStore.memory(),
    {
      config,
      registered: () => registered,
      sessions: async () => [],
      now: Date.now,
      httpFetch: () => Promise.reject(new Error("no network in this test")),
      probe,
      draining,
    },
    {
      intervalMs: 60_000,
      floorMs: FLOOR_MS,
      connected: () => true,
      send: async (status) => {
        sent.push({ status, atMs: Date.now() });
        return true;
      },
    },
  );
  running = loop;
  return { loop, sent };
}

describe("startStatusLoop refresh", () => {
  test("waits out the floor after a sent status, then sends once with the gate as it is then", async () => {
    let draining = false;
    const { loop, sent } = start(() => draining);
    loop.sampleNow();
    await pollUntil(() => sent.length === 1, "the first status");
    expect(sent[0]?.status).not.toHaveProperty("drn");

    draining = true;
    loop.refresh();
    loop.refresh();
    await Bun.sleep(100); // a non-event can't be polled
    expect(sent).toHaveLength(1);

    await pollUntil(() => sent.length === 2, "the refreshed status");
    const [first, second] = sent;
    expect(second?.status.drn).toBe(true);
    expect((second?.atMs ?? 0) - (first?.atMs ?? 0)).toBeGreaterThanOrEqual(FLOOR_MS);
    await Bun.sleep(FLOOR_MS * 2); // coalesced: no second refresh follows
    expect(sent).toHaveLength(2);
  });

  test("past the floor it samples at once, and a reopened gate goes out without the flag", async () => {
    let draining = true;
    const { loop, sent } = start(() => draining);
    loop.refresh();
    await pollUntil(() => sent.length === 1, "a refresh with nothing sent before it");
    expect(sent[0]?.status.drn).toBe(true);

    await Bun.sleep(FLOOR_MS * 1.5);
    draining = false;
    const asked = Date.now();
    loop.refresh();
    await pollUntil(() => sent.length === 2, "the refresh past the floor");
    expect(sent[1]?.status).not.toHaveProperty("drn");
    expect((sent[1]?.atMs ?? Infinity) - asked).toBeLessThan(FLOOR_MS);
  });

  test("stop drops a pending refresh", async () => {
    const { loop, sent } = start(() => true);
    loop.sampleNow();
    await pollUntil(() => sent.length === 1, "the first status");
    loop.refresh();
    loop.stop();
    await Bun.sleep(FLOOR_MS * 2); // a non-event can't be polled
    expect(sent).toHaveLength(1);
  });
});
