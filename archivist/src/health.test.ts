import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ID, parseArchiveStatusReply, type ArchiveTableStatus, type ArchiveStatusResponse } from "@seance/shared";
import { pollUntil } from "../../daemon/test/fixtures.ts";
import { answerArchiveStatus, createStatusAnswer, startCountRefresher, type Counted } from "./health.ts";
import { createIngestClock } from "./ingest-clock.ts";

const none: ArchiveTableStatus = { rows: 0, oldest: null };

describe("ingest clock", () => {
  test("holds one time per source, null until noted", () => {
    let now = 100;
    const clock = createIngestClock(() => now);
    expect(clock.snapshot()).toEqual({ store: null, registry: null, status: null, pull: null });
    clock.note("status");
    now = 200;
    clock.note("pull");
    expect(clock.snapshot()).toEqual({ store: null, registry: null, status: 100, pull: 200 });
  });
});

describe("count refresher", () => {
  test("a pass publishes the counts; a request-time read never waits on a pass in progress", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let samplesCalls = 0;
    const refresher = startCountRefresher({
      archive: { counts: () => ({ tasks: { rows: 2, oldest: 1 }, events: none }) },
      metrics: {
        countSamples: async () => {
          samplesCalls += 1;
          if (samplesCalls > 1) await gate;
          return { rows: samplesCalls, oldest: 5 };
        },
      },
      log: { warn: () => {} },
      intervalMs: 3_600_000,
      now: () => 42,
    });
    try {
      await pollUntil(
        () => refresher.snapshot()?.samples !== null && refresher.snapshot()?.samples !== undefined,
        "the first pass",
      );
      expect(refresher.snapshot()).toEqual({
        tasks: { rows: 2, oldest: 1 },
        events: none,
        samples: { rows: 1, oldest: 5 },
        countedAt: 42,
      });
      // The second pass is parked on the gate: the previous snapshot is still what a reader gets, at once.
      const second = refresher.refresh();
      await pollUntil(() => samplesCalls === 2, "the second pass started");
      expect(refresher.snapshot()?.samples).toEqual({ rows: 1, oldest: 5 });
      // A pass already running is joined, never doubled.
      const joined = refresher.refresh();
      release();
      await Promise.all([second, joined]);
      expect(samplesCalls).toBe(2);
      expect(refresher.snapshot()?.samples).toEqual({ rows: 2, oldest: 5 });
    } finally {
      refresher.stop();
    }
  });

  test("a failed pass logs its message and keeps the previous counts", async () => {
    const warnings: string[] = [];
    let fail = false;
    const refresher = startCountRefresher({
      archive: {
        counts: () => {
          if (fail) throw new Error("disk I/O error");
          return { tasks: { rows: 1, oldest: 1 }, events: none };
        },
      },
      metrics: { countSamples: () => Promise.resolve(none) },
      log: { warn: (line) => warnings.push(line) },
      intervalMs: 3_600_000,
    });
    try {
      await pollUntil(
        () => refresher.snapshot()?.samples !== null && refresher.snapshot()?.samples !== undefined,
        "the first pass",
      );
      const before = refresher.snapshot();
      fail = true;
      await refresher.refresh();
      expect(refresher.snapshot()).toBe(before);
      expect(warnings).toEqual(["archive counts: disk I/O error"]);
    } finally {
      refresher.stop();
    }
  });
  test("a sample count that fails midway leaves the earlier samples under their own countedAt", async () => {
    let clock = 100;
    let failSamples = false;
    const refresher = startCountRefresher({
      archive: { counts: () => ({ tasks: { rows: clock, oldest: 1 }, events: none }) },
      metrics: {
        countSamples: () => (failSamples ? Promise.reject(new Error("busy")) : Promise.resolve({ rows: 7, oldest: 1 })),
      },
      log: { warn: () => {} },
      intervalMs: 3_600_000,
      now: () => clock,
    });
    try {
      await pollUntil(
        () => refresher.snapshot()?.samples !== null && refresher.snapshot()?.samples !== undefined,
        "the first pass",
      );
      failSamples = true;
      clock = 200;
      await refresher.refresh();
      expect(refresher.snapshot()?.samples).toEqual({ rows: 7, oldest: 1 });
      expect(refresher.snapshot()?.countedAt).toBe(100);
    } finally {
      refresher.stop();
    }
  });
});

describe("status answer", () => {
  let dir: string;
  let withWal: { archive: string; metrics: string };
  let noWal: { archive: string; metrics: string };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "health-"));
    withWal = { archive: join(dir, "a.sqlite"), metrics: join(dir, "m.sqlite") };
    noWal = { archive: join(dir, "b.sqlite"), metrics: join(dir, "n.sqlite") };
    await writeFile(withWal.archive, "x".repeat(100));
    await writeFile(`${withWal.archive}-wal`, "x".repeat(10));
    await writeFile(withWal.metrics, "x".repeat(200));
    await writeFile(`${withWal.metrics}-wal`, "x".repeat(20));
    await writeFile(noWal.archive, "x".repeat(7));
    await writeFile(noWal.metrics, "x".repeat(9));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const counted: Counted = { tasks: none, events: none, samples: { rows: 3, oldest: 9 }, countedAt: 77 };
  const answerFor = (paths: { archive: string; metrics: string }, counts: Counted | null) =>
    createStatusAnswer({
      counts: () => counts,
      clock: createIngestClock(() => 5),
      onlineSince: () => 11,
      archivePath: paths.archive,
      metricsPath: paths.metrics,
    });

  test("sizes add the -wal file when present, and a missing one counts as nothing", async () => {
    expect((await answerFor(withWal, counted)()).database).toEqual({ archiveBytes: 110, metricsBytes: 220 });
    expect((await answerFor(noWal, counted)()).database).toEqual({ archiveBytes: 7, metricsBytes: 9 });
  });

  test("carries the snapshot, the clock and onlineSince; null tables before a first pass", async () => {
    const answer = await answerFor(noWal, counted)();
    expect(answer).toMatchObject({ ok: true, onlineSince: 11, samples: { rows: 3, oldest: 9 }, countedAt: 77 });
    expect(answer.lastIngest).toEqual({ store: null, registry: null, status: null, pull: null });
    expect(await answerFor(noWal, null)()).toMatchObject({ tasks: null, samples: null, events: null, countedAt: null });
  });

  test("a missing database file is an error, not a zero", async () => {
    await expect(answerFor({ archive: join(dir, "gone"), metrics: noWal.metrics }, counted)()).rejects.toThrow();
  });
});

describe("answerArchiveStatus", () => {
  const response: ArchiveStatusResponse = {
    ok: true,
    onlineSince: 1,
    lastIngest: { store: null, registry: null, status: null, pull: null },
    tasks: null,
    samples: null,
    events: null,
    database: { archiveBytes: 1, metricsBytes: 2 },
    countedAt: null,
  };
  const request = (payload: unknown, re?: string) => ({
    id: "req-1",
    ts: Date.now(),
    op: "archive-status" as const,
    payload,
    ...(re === undefined ? {} : { re }),
  });

  test("an app-sealed request gets the answer, correlated to the request", async () => {
    const warnings: string[] = [];
    const reply = await answerArchiveStatus(request({}), APP_ID, () => Promise.resolve(response), {
      warn: (line) => warnings.push(line),
    });
    expect(reply).toMatchObject({ op: "archive-status", re: "req-1" });
    expect(parseArchiveStatusReply(reply?.payload)).toEqual(response);
    expect(warnings).toEqual([]);
  });

  test("a request from anyone but the app, or carrying re, is dropped with a warning", async () => {
    const warnings: string[] = [];
    const log = { warn: (line: string) => warnings.push(line) };
    expect(await answerArchiveStatus(request({}), "some-device", () => Promise.resolve(response), log)).toBeNull();
    expect(await answerArchiveStatus(request({}, "x"), APP_ID, () => Promise.resolve(response), log)).toBeNull();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("not sealed from the app");
  });

  test("a payload that is not a record is invalid_request", async () => {
    const reply = await answerArchiveStatus(request("nope"), APP_ID, () => Promise.resolve(response), {
      warn: () => {},
    });
    expect(reply?.payload).toMatchObject({ ok: false, code: "invalid_request" });
  });

  test("a throwing answer is internal_error with no stack in the reply", async () => {
    const reply = await answerArchiveStatus(
      request({}),
      APP_ID,
      () => Promise.reject(new Error("boom at /secret/path")),
      { warn: () => {} },
    );
    expect(reply?.payload).toEqual({ ok: false, code: "internal_error", message: "archive status failed" });
  });
});
