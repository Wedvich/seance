import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { MachineStatus } from "@seance/shared";
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

/** On a 500 ms slot, so a phase into the interval is an offset from it. */
const BASE_MS = 1_760_000_000_000;

// Every wait here is the loop's own timer against the floor or a slot: on a real clock each one
// raced the sample's async chain and a loaded runner. On this one a timer fires only when advanced.
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(BASE_MS);
});

afterEach(() => {
  running?.stop();
  running = null;
  jest.useRealTimers();
});

/** Lets a sample's promise chain land; no timer fires meanwhile, the clock being fake. */
async function settle(): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each round is one turn of the event loop
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await settle();
}

interface Holds {
  /** The first `sessions` read (so the first tick) waits for it. */
  readonly tick?: Promise<void>;
  /** The first send waits for it before it lands. */
  readonly send?: Promise<void>;
}

/** Long enough that the beat never fires within a test. */
const QUIET: Cadence = { intervalMs: 60_000, floorMs: FLOOR_MS };

interface Cadence {
  readonly intervalMs: number;
  readonly floorMs: number;
}

/** By default (`QUIET`) every send is `sampleNow` or `refresh`. */
function start(
  draining: () => boolean,
  holds: Holds = {},
  cadence: Cadence = QUIET,
  closed: () => number | null = () => null,
): { readonly loop: StatusLoop; readonly sent: Sent[] } {
  const sent: Sent[] = [];
  let reads = 0;
  let sends = 0;
  const loop = startStatusLoop(
    MetricsStore.memory(),
    {
      config,
      registered: () => registered,
      sessions: async () => {
        reads += 1;
        if (reads === 1) await holds.tick;
        return [];
      },
      now: Date.now,
      httpFetch: () => Promise.reject(new Error("no network in this test")),
      probe,
      draining,
      closed,
    },
    {
      ...cadence,
      connected: () => true,
      send: async (status) => {
        sends += 1;
        if (sends === 1) await holds.send;
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
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.status).not.toHaveProperty("drn");

    draining = true;
    loop.refresh();
    loop.refresh();
    await advance(FLOOR_MS - 1);
    expect(sent).toHaveLength(1);

    await advance(1);
    expect(sent).toHaveLength(2);
    const [first, second] = sent;
    expect(second?.status.drn).toBe(true);
    expect((second?.atMs ?? 0) - (first?.atMs ?? 0)).toBe(FLOOR_MS);
    await advance(FLOOR_MS * 2); // coalesced: no second refresh follows
    expect(sent).toHaveLength(2);
  });

  test("past the floor it samples at once, and a reopened gate goes out without the flag", async () => {
    let draining = true;
    const { loop, sent } = start(() => draining);
    loop.refresh();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.status.drn).toBe(true);

    await advance(FLOOR_MS * 1.5);
    draining = false;
    const asked = Date.now();
    loop.refresh();
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.status).not.toHaveProperty("drn");
    expect(sent[1]?.atMs).toBe(asked);
  });

  test("a refresh after a close sends `cl`, and a reopen sends none", async () => {
    let closedAt: number | null = null;
    const { loop, sent } = start(
      () => false,
      {},
      QUIET,
      () => closedAt,
    );
    loop.sampleNow();
    await settle();
    expect(sent[0]?.status).not.toHaveProperty("cl");

    await advance(FLOOR_MS * 1.5);
    closedAt = Date.now();
    loop.refresh();
    await settle();
    expect(sent[1]?.status.cl).toBe(closedAt);

    await advance(FLOOR_MS * 1.5);
    closedAt = null;
    loop.refresh();
    await settle();
    expect(sent[2]?.status).not.toHaveProperty("cl");
  });

  test("stop drops a pending refresh", async () => {
    const { loop, sent } = start(() => true);
    loop.sampleNow();
    await settle();
    expect(sent).toHaveLength(1);
    loop.refresh();
    loop.stop();
    await advance(FLOOR_MS * 2);
    expect(sent).toHaveLength(1);
  });

  // The register-then-drain ordering: the register's sample is under way when the gate closes.
  describe.each(["tick", "send"] as const)("a refresh while the register's %s is in flight", (held) => {
    test("sends a new sample with the gate, outside the relay's floor of the one in flight", async () => {
      let draining = false;
      const release = Promise.withResolvers<void>();
      const { loop, sent } = start(() => draining, { [held]: release.promise });
      loop.sampleNow();
      await settle();
      expect(sent).toHaveLength(0);
      draining = true;
      loop.refresh();
      release.resolve();
      await settle();
      await advance(FLOOR_MS);

      // The relay drops what lands within its floor of an accepted status, so what it keeps is what counts.
      const kept: Sent[] = [];
      for (const one of sent) {
        const last = kept.at(-1);
        if (last === undefined || one.atMs - last.atMs >= FLOOR_MS) kept.push(one);
      }
      expect(kept.at(-1)?.status.drn).toBe(true);
      expect(sent).toHaveLength(2);
      expect((sent[1]?.atMs ?? 0) - (sent[0]?.atMs ?? 0)).toBeGreaterThanOrEqual(FLOOR_MS);
    });
  });

  test("a send landing while the wait runs moves the wait past its own floor", async () => {
    let draining = false;
    const { loop, sent } = start(() => draining);
    loop.sampleNow();
    await settle();
    expect(sent).toHaveLength(1);
    loop.refresh(); // a timer armed against the first send
    await advance(FLOOR_MS * 0.6);
    loop.sampleNow(); // a register's sample: accepted meanwhile, since a register clears the relay's floor
    await settle();
    expect(sent).toHaveLength(2);
    draining = true;

    await advance(FLOOR_MS * 0.4); // the first send's floor: the timer re-arms against the second's
    expect(sent).toHaveLength(2);
    await advance(FLOOR_MS * 0.6);
    expect(sent).toHaveLength(3);
    expect(sent[2]?.status.drn).toBe(true);
    expect((sent[2]?.atMs ?? 0) - (sent[1]?.atMs ?? 0)).toBe(FLOOR_MS);
  });
});

describe("startStatusLoop beat", () => {
  const INTERVAL_MS = 500;
  const onSlot = (atMs: number): boolean => atMs % INTERVAL_MS === 0;

  test("beats on wall-clock slots, and a register between them does not move the next", async () => {
    const { loop, sent } = start(() => false, {}, { intervalMs: INTERVAL_MS, floorMs: 50 });
    jest.setSystemTime(BASE_MS + 100);
    loop.sampleNow();
    await settle();
    // A full interval before the first beat, then the slot.
    await advance(INTERVAL_MS * 2 - 100);
    expect(sent).toHaveLength(2);
    expect(onSlot(sent[1]?.atMs ?? 1)).toBe(true);

    await advance(INTERVAL_MS / 2);
    loop.sampleNow();
    await settle();
    await advance(INTERVAL_MS / 2);
    expect(sent).toHaveLength(4);
    expect(onSlot(sent[2]?.atMs ?? 0)).toBe(false);
    expect(onSlot(sent[3]?.atMs ?? 1)).toBe(true);
    expect((sent[3]?.atMs ?? 0) - (sent[2]?.atMs ?? 0)).toBe(INTERVAL_MS / 2);
  });

  test("skips a slot within the relay's floor of a register's status, keeping the next", async () => {
    const floorMs = 200;
    const { loop, sent } = start(() => false, {}, { intervalMs: INTERVAL_MS, floorMs });
    jest.setSystemTime(BASE_MS + 100);
    loop.sampleNow();
    await settle();
    await advance(INTERVAL_MS * 2 - 100);
    expect(sent).toHaveLength(2);

    await advance(INTERVAL_MS - 150);
    loop.sampleNow();
    await settle();
    await advance(150); // the slot inside the floor
    expect(sent).toHaveLength(3);
    await advance(INTERVAL_MS);
    expect(sent).toHaveLength(4);
    expect((sent[3]?.atMs ?? 0) - (sent[2]?.atMs ?? 0)).toBe(INTERVAL_MS + 150);
    expect(onSlot(sent[3]?.atMs ?? 1)).toBe(true);
  });
});
