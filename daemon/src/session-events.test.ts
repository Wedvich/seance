import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@seance/shared";
import { pollUntil } from "../test/fixtures.ts";
import { LaunchLedger } from "./launch-ledger.ts";
import { parseProcStatPpid, parsePsParents } from "./peer.ts";
import {
  createSessionEvents,
  ENDED_MAX,
  ENDED_TTL_MS,
  EndedTasks,
  parsePanePids,
  parseSessionEventFrame,
  quotaFromRateLimits,
  SessionQuota,
  type BoundPane,
} from "./session-events.ts";
import { newestQuota } from "./telemetry.ts";

const frame = (fields: object): object => ({ v: 1, kind: "session-event", ...fields });

describe("parseSessionEventFrame", () => {
  test("keeps the fields it knows, drops the rest, and refuses a frame with nothing to report", () => {
    expect(parseSessionEventFrame(frame({ state: "busy", taskId: "x", session: "%9", pane: "%1" }))).toEqual({
      v: 1,
      kind: "session-event",
      state: "busy",
      pane: "%1",
    });
    expect(parseSessionEventFrame(frame({}))).toBeNull();
    expect(parseSessionEventFrame(frame({ state: "asleep" }))).toBeNull();
    expect(parseSessionEventFrame({ v: 2, kind: "session-event", state: "busy" })).toBeNull();
    expect(parseSessionEventFrame(frame({ rateLimits: [{ kind: "five_hour", percentUsed: "50" }] }))).toBeNull();
    expect(
      parseSessionEventFrame(frame({ rateLimits: Array.from({ length: 9 }, () => ({ kind: "x", percentUsed: 1 })) })),
    ).toBeNull();
  });
});

test("parsePanePids dedupes grouped panes, validates the task, and keeps a separator in the path", () => {
  const raw = ["%1|100|0|task-1|/a|b", "%1|100|0|task-1|/a|b", "%2|200|1||/c", "%3|300|0|bad task|/d", "junk"].join(
    "\n",
  );
  expect(parsePanePids(raw)).toEqual([
    { id: "%1", pid: 100, dead: false, taskId: "task-1", path: "/a|b" },
    { id: "%2", pid: 200, dead: true, taskId: null, path: "/c" },
    { id: "%3", pid: 300, dead: false, taskId: null, path: "/d" },
  ]);
});

test("parent parsing survives a comm with spaces and parens", () => {
  expect(parseProcStatPpid("123 (my (odd) proc) S 45 123 123 0")).toBe(45);
  expect(parsePsParents("  10     1\n 11 10\n")).toEqual(
    new Map([
      [10, 1],
      [11, 10],
    ]),
  );
});

describe("quotaFromRateLimits", () => {
  test("rounds, clamps, stamps receive time, and skips kinds that are not quota windows", () => {
    expect(
      quotaFromRateLimits(
        [
          { kind: "five_hour", percentUsed: 23.5, resetsAt: "2026-10-16T18:00:00Z" },
          { kind: "seven_day", percentUsed: 104 },
          { kind: "spend_limit", percentUsed: 50 },
        ],
        1_000_999,
      ),
    ).toEqual({ s: "session", at: 1000, h: 24, d: 100, hr: Date.parse("2026-10-16T18:00:00Z") / 1000 });
    expect(quotaFromRateLimits([{ kind: "spend_limit", percentUsed: 50 }], 0)).toBeNull();
  });
});

test("SessionQuota keeps the newest per exclave", () => {
  const quota = new SessionQuota();
  quota.record("work", { s: "session", at: 10, h: 5 });
  quota.record("work", { s: "session", at: 9, h: 99 });
  expect(quota.get("work")?.h).toBe(5);
});

describe("newestQuota", () => {
  const cache = { x: 0, s: "cache" as const, at: 100, h: 50, d: 20, w: [{ m: "Fable", p: 30 }] };
  test("a newer report wins and the cache fills the windows it lacks; an older one loses", () => {
    expect(newestQuota(cache, { x: 0, s: "session", at: 200, h: 60 })).toEqual({
      x: 0,
      s: "session",
      at: 200,
      h: 60,
      d: 20,
      w: [{ m: "Fable", p: 30 }],
    });
    expect(newestQuota(cache, { x: 0, s: "session", at: 50, h: 1 })).toBe(cache);
    expect(newestQuota(null, null)).toBeNull();
  });
});

describe("EndedTasks", () => {
  test("ended and launched-but-not-carried tasks report; one a session carries never does", async () => {
    const ended = new EndedTasks(
      LaunchLedger.memory(() => 5),
      () => 0,
    );
    ended.ended("a");
    for (const id of ["b", "c"]) await (await ended.launch(id))(true);
    expect(ended.report(new Set(["c"]))).toEqual({ ended: ["a", "b"], ledgerSince: 5 });
  });

  test("ended events are bounded by age and by count", () => {
    const clock = { now: 0 };
    const ended = new EndedTasks(LaunchLedger.memory(), () => clock.now);
    ended.ended("old");
    clock.now = ENDED_TTL_MS + 1;
    for (let i = 0; i <= ENDED_MAX; i++) ended.ended(`t${i}`);
    const report = ended.report(new Set()).ended;
    expect(report).toHaveLength(ENDED_MAX);
    expect(report).not.toContain("old");
    expect(report).not.toContain("t0");
  });

  test("a launch that never ran leaves the ledger; task_running's earlier launch stays", async () => {
    const ended = new EndedTasks(LaunchLedger.memory());
    await (
      await ended.launch("refused")
    )(false);
    await (
      await ended.launch("dup")
    )(true);
    await (
      await ended.launch("dup")
    )(false);
    expect(ended.report(new Set()).ended).toEqual(["dup"]);
  });

  test("settled waits for every launch in flight, one begun while waiting included", async () => {
    const ended = new EndedTasks(LaunchLedger.memory());
    const first = await ended.launch("a");
    let done = false;
    const waiting = (async () => {
      await ended.settled();
      done = true;
    })();
    const second = ended.launch("b");
    await first(true);
    await Bun.sleep(0);
    expect(done).toBe(false);
    await (
      await second
    )(true);
    await waiting;
    expect(done).toBe(true);
  });

  test("a ledger that cannot record refuses the launch and holds nothing back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seance-ledger-"));
    try {
      // A directory where the file should be: every write fails.
      const path = join(dir, "launched.json");
      await mkdir(join(path, "x"), { recursive: true });
      const ended = new EndedTasks(await LaunchLedger.open(path));
      await expect(ended.launch("t1")).rejects.toThrow();
      await ended.settled();
      expect(ended.report(new Set()).ended).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("coalescing", () => {
  const pane: BoundPane = { id: "%1", pid: 10, dead: false, taskId: "t1", path: "/home" };

  function setup(coalesceMs: number) {
    const forwarded: SessionEvent[] = [];
    const events = createSessionEvents({
      panes: () => Promise.resolve([pane]),
      exclaves: () => [],
      forward: (event) => void forwarded.push(event),
      quota: new SessionQuota(),
      ended: new EndedTasks(),
      coalesceMs,
    });
    // No peer pid: the fallback binding, by the frame's own pane.
    const send = (fields: object): Promise<unknown> => events.handle(frame({ pane: "%1", ...fields }), null);
    return { forwarded, events, send };
  }

  test("one event goes at once; a burst after it folds into one, newest state, earlier PR URL kept", async () => {
    const { forwarded, events, send } = setup(150);
    try {
      await send({ state: "busy" });
      expect(forwarded.map((e) => e.state)).toEqual(["busy"]);
      await send({ state: "idle", prUrl: "https://github.com/a/b/pull/1" });
      await send({ state: "busy" });
      await send({ state: "needs-input" });
      expect(forwarded).toHaveLength(1);
      await pollUntil(() => forwarded.length === 2, "the folded event");
      expect(forwarded.map((e) => [e.state, e.prUrl])).toEqual([
        ["busy", undefined],
        ["needs-input", "https://github.com/a/b/pull/1"],
      ]);
    } finally {
      events.stop();
    }
  });

  test("stop cancels a pending send", async () => {
    const { forwarded, events, send } = setup(100);
    await send({ state: "busy" });
    await send({ state: "idle" });
    events.stop();
    await Bun.sleep(200); // past the window: a non-event can't be polled
    expect(forwarded).toHaveLength(1);
  });
});
