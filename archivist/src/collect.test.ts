import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine, QueueChanged, RelayState, Task, TaskListing, TaskLookup } from "@seance/shared";
import { pollUntil } from "../../daemon/test/fixtures.ts";
import { Archive } from "./archive.ts";
import { Paced, startCollector, type ArchiveSource } from "./collect.ts";
import { createIngestClock } from "./ingest-clock.ts";

/**
 * `Paced` on its own, and the collector over a scripted source: the relay
 * client is the external boundary here, and archivist/test/relay.test.ts runs
 * the same collection against the real relay.
 */
describe("Paced", () => {
  test("runs at most once per gap, coalesces kicks that land meanwhile, and retries a failed read", async () => {
    const starts: number[] = [];
    const outcomes = [true, false, true];
    const pacer = new Paced(60, 40, () => {
      starts.push(Date.now());
      return Promise.resolve(outcomes.shift() ?? true);
    });
    pacer.kick();
    pacer.kick();
    pacer.kick();
    await pollUntil(() => starts.length === 1, "the first read");
    // A kick inside the gap waits it out rather than reading now.
    pacer.kick();
    await pollUntil(() => starts.length === 2, "the second read, after the gap");
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(55);
    // The second reported failure: the pacer tries again on its own, no kick.
    await pollUntil(() => starts.length === 3, "the retry");
    pacer.stop();
    pacer.kick();
    // A negative assertion: a stopped pacer's non-event cannot be polled.
    await Bun.sleep(150);
    expect(starts).toHaveLength(3);
  });
});

function machine(over: Partial<Machine> = {}): Machine {
  return {
    deviceId: "dev-a",
    name: "alpha",
    platform: "linux",
    repos: [],
    scannedAt: 0,
    lastSeen: 0,
    connected: true,
    ...over,
  };
}

function stateOf(machines: readonly Machine[]): RelayState {
  return {
    status: "open",
    rejection: null,
    archivist: null,
    machines,
    registrySize: machines.length,
    ignored: 0,
    unbound: 0,
    skewed: 0,
    settling: false,
    registrySettled: true,
    scheduler: { kind: "none" },
    fleetQuota: [],
  };
}

function finished(id: string): Task {
  return { id, spec: { repo: "seance", mode: "worktree", title: id }, state: "done", createdAt: 1 };
}

interface Script {
  readonly source: ArchiveSource;
  readonly gets: string[];
  lists: number;
  /** Lets every get through; until then each waits. */
  release: () => void;
  push: (machines: readonly Machine[]) => void;
  nudge: (change: QueueChanged) => void;
}

function script(): Script {
  let state = stateOf([]);
  let release = (): void => {};
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const listeners = new Set<() => void>();
  const queueListeners = new Set<(change: QueueChanged) => void>();
  const self: Script = {
    gets: [],
    lists: 0,
    release,
    push: (machines) => {
      state = stateOf(machines);
      for (const listener of listeners) listener();
    },
    nudge: (change) => {
      for (const listener of queueListeners) listener(change);
    },
    source: {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      listTasks: (): Promise<TaskListing> => {
        self.lists += 1;
        return Promise.resolve({ ok: true, tasks: [], unreadable: [] });
      },
      getTask: async (id): Promise<TaskLookup> => {
        self.gets.push(id);
        await open;
        return { ok: true, task: { task: finished(id), version: 2 } };
      },
      listAccounts: () => Promise.resolve({ ok: true, accounts: [], unreadable: [] }),
      getAccountRecord: () => Promise.resolve({ ok: true, key: "k", version: 0, entry: null }),
      onQueueChanged: (listener) => {
        queueListeners.add(listener);
        return () => queueListeners.delete(listener);
      },
      onStoreChanged: () => () => {},
    },
  };
  return self;
}

describe("collector", () => {
  let dir: string;
  let archive: Archive;
  let closed: boolean;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "collect-"));
    archive = await Archive.open(join(dir, "archive.sqlite"));
    closed = false;
  });

  afterEach(async () => {
    if (!closed) archive.close();
    await rm(dir, { recursive: true, force: true });
  });

  const start = async (
    source: ArchiveSource,
    warnings: string[] = [],
    clock = createIngestClock(),
  ): Promise<ReturnType<typeof startCollector>> =>
    startCollector({
      source,
      archive,
      accountKey: await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      selfId: "seat",
      log: { info: () => {}, warn: (line) => warnings.push(line) },
      clock,
      timings: { listGapMs: 10_000, retryMs: 10_000, pollMs: 60_000 },
    });

  test("a nudge naming tasks gets them, once each however many nudges name them; one without ids lists", async () => {
    const fake = script();
    const collector = await start(fake.source);
    try {
      // The catch-up listing at ready; nothing else lists while the gap holds.
      await pollUntil(() => fake.lists === 1, "the listing at ready");
      fake.nudge({ at: 1, tasks: ["t-1"] });
      await pollUntil(() => fake.gets.length === 1, "the first get");
      // Gets are held open: these land while t-1's is in flight and coalesce.
      fake.nudge({ at: 2, tasks: ["t-2", "t-3"] });
      fake.nudge({ at: 3, tasks: ["t-2"] });
      fake.nudge({ at: 4, tasks: ["t-3", "t-2"] });
      fake.release();
      await pollUntil(() => archive.taskVersion("t-3") === 2, "t-3 archived");
      expect(fake.gets.toSorted()).toEqual(["t-1", "t-2", "t-3"]);
      expect(fake.lists).toBe(1);
      fake.nudge({ at: 5 });
      // A negative assertion: inside the gap the listing is paced, and a non-event cannot be polled.
      await Bun.sleep(50);
      expect(fake.lists).toBe(1);
    } finally {
      collector.stop();
    }
  });

  test("one listing stamps every task it archives with the same end time, so created and id order a backfill", async () => {
    const fake = script();
    let tick = 5_000;
    const clockSpy = spyOn(Date, "now").mockImplementation(() => (tick += 7));
    const listing = ["t-a", "t-b", "t-c"].map((id, i) => ({
      task: { ...finished(id), createdAt: 10 + i },
      version: 1,
    }));
    const source: ArchiveSource = {
      ...fake.source,
      listTasks: () => Promise.resolve({ ok: true, tasks: listing, unreadable: [] }),
    };
    const collector = await start(source);
    try {
      await pollUntil(() => archive.taskVersion("t-c") === 1, "the listing archived");
      const { rows } = archive.queryTasks({}, 10);
      expect(new Set(rows.map((row) => row.endedAt)).size).toBe(1);
      expect(rows.map((row) => row.id)).toEqual(["t-c", "t-b", "t-a"]);
    } finally {
      collector.stop();
      clockSpy.mockRestore();
    }
  });

  test("a row SQLite refuses is skipped and counted; the rest of the listing is archived and the store noted", async () => {
    const fake = script();
    const warnings: string[] = [];
    const clock = createIngestClock();
    // A STRICT INTEGER column refuses a fractional `created_at`: one row refused, the rest writable.
    const listing = [
      { task: finished("t-a"), version: 1 },
      { task: { ...finished("t-b"), createdAt: 1.5 }, version: 1 },
      { task: finished("t-c"), version: 1 },
    ];
    const source: ArchiveSource = {
      ...fake.source,
      listTasks: () => Promise.resolve({ ok: true, tasks: listing, unreadable: [] }),
    };
    const collector = await start(source, warnings, clock);
    try {
      await pollUntil(() => archive.taskVersion("t-c") === 1, "the task after the refused one archived");
      expect(archive.taskVersion("t-a")).toBe(1);
      expect(archive.taskVersion("t-b")).toBeNull();
      // SQLite's wording of the datatype error differs by build (bundled vs a system library): pin the shape, not the text.
      const taskWarnings = warnings.filter((line) => line.startsWith("tasks: "));
      expect(taskWarnings).toHaveLength(1);
      expect(taskWarnings[0]).toMatch(/^tasks: 1 not archived: .*tasks\.created_at/u);
      expect(clock.snapshot().store).not.toBeNull();
    } finally {
      collector.stop();
    }
  });

  test("the ingest clock notes the store when a listing lands and the registry when a fleet is written", async () => {
    const fake = script();
    const clock = createIngestClock();
    const collector = await start(fake.source, [], clock);
    try {
      await pollUntil(() => clock.snapshot().store !== null, "the store noted after the listing");
      expect(clock.snapshot().status).toBeNull();
      await pollUntil(() => clock.snapshot().registry !== null, "the registry noted after the fleet write");
    } finally {
      collector.stop();
    }
  });

  test("a reply landing after stop() writes nothing to the closed archive", async () => {
    const fake = script();
    const warnings: string[] = [];
    const collector = await start(fake.source, warnings);
    await pollUntil(() => fake.lists === 1, "the listing at ready");
    fake.nudge({ at: 1, tasks: ["t-1"] });
    await pollUntil(() => fake.gets.length === 1, "the get in flight");
    collector.stop();
    archive.close();
    closed = true;
    fake.release();
    // A negative assertion: a write to the closed database would have warned by now.
    await Bun.sleep(50);
    expect(warnings).toEqual([]);
  });

  test("a failing fleet write is logged, not thrown, and tried again on the next change", async () => {
    const fake = script();
    const warnings: string[] = [];
    const collector = await start(fake.source, warnings);
    try {
      await pollUntil(() => fake.lists === 1, "the listing at ready");
      archive.close();
      closed = true;
      expect(() => fake.push([machine()])).not.toThrow();
      expect(warnings.some((line) => line.startsWith("fleet write:"))).toBe(true);
      // The baseline did not move: the same machines are written again on the next push.
      const before = warnings.length;
      fake.push([machine()]);
      expect(warnings.length).toBeGreaterThan(before);
    } finally {
      collector.stop();
    }
  });
});
