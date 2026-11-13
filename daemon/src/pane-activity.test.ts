import { describe, expect, test } from "bun:test";
import { createPaneActivity, type TrackedPane } from "./pane-activity.ts";

const pane = (id: string, extra: Partial<TrackedPane> = {}): TrackedPane => ({
  id,
  pid: 100,
  dead: false,
  ours: true,
  ...extra,
});

function setup(initial: readonly TrackedPane[] = []) {
  let clock = 1_000;
  let panes: readonly TrackedPane[] | Error = initial;
  const screens = new Map<string, string | null>();
  const captured: string[] = [];
  const tracker = createPaneActivity({
    panes: () => (panes instanceof Error ? Promise.reject(panes) : Promise.resolve(panes)),
    capture: (id) => {
      captured.push(id);
      return Promise.resolve(screens.get(id) ?? null);
    },
    now: () => clock,
  });
  return {
    tracker,
    screens,
    captured,
    advance: (ms: number): void => {
      clock += ms;
    },
    setPanes: (next: readonly TrackedPane[] | Error): void => {
      panes = next;
    },
  };
}

describe("observed state", () => {
  test("a pane heard from carries its last state and when that run began; a repeat keeps the start", () => {
    const { tracker, advance } = setup();
    tracker.observe(pane("%1"), "busy", false);
    advance(5_000);
    tracker.observe(pane("%1"), "busy", false);
    expect(tracker.activity("%1")).toEqual({
      state: "busy",
      stateSince: 1_000,
      turnEnded: false,
      screenSince: null,
      sampledAt: null,
    });
    advance(5_000);
    tracker.observe(pane("%1"), "idle", false);
    expect(tracker.activity("%1")).toMatchObject({ state: "idle", stateSince: 11_000, turnEnded: false });
    // The turn's own end is a new run even on the same state: C24's grace counts from it.
    advance(5_000);
    tracker.observe(pane("%1"), "idle", true);
    expect(tracker.activity("%1")).toMatchObject({ state: "idle", stateSince: 16_000, turnEnded: true });
    // A respawn's plain idle after it is the last frame, and no longer a turn-ended one.
    advance(5_000);
    tracker.observe(pane("%1"), "idle", false);
    expect(tracker.activity("%1")).toMatchObject({ state: "idle", stateSince: 21_000, turnEnded: false });
  });

  test("a foreign or dead pane is never tracked", () => {
    const { tracker } = setup();
    tracker.observe(pane("%1", { ours: false }), "busy", false);
    tracker.observe(pane("%2", { dead: true }), "busy", false);
    expect(tracker.activity("%1")).toBeNull();
    expect(tracker.activity("%2")).toBeNull();
  });

  test("a new pid under the same pane id (a tmux server restart) starts afresh", () => {
    const { tracker, advance } = setup();
    tracker.observe(pane("%1"), "needs-input", false);
    advance(1_000);
    tracker.observe(pane("%1", { pid: 200 }), "busy", false);
    expect(tracker.activity("%1")).toMatchObject({ state: "busy", stateSince: 2_000 });
  });
});

describe("the screen sampler", () => {
  test("a sampled pane with no frames is unobserved; its screen time moves only when the screen does", async () => {
    const { tracker, screens, advance } = setup([pane("%1")]);
    screens.set("%1", "prompt >");
    await tracker.sample();
    expect(tracker.activity("%1")).toEqual({
      state: null,
      stateSince: null,
      turnEnded: false,
      screenSince: 1_000,
      sampledAt: 1_000,
    });
    advance(60_000);
    await tracker.sample();
    expect(tracker.activity("%1")).toMatchObject({ screenSince: 1_000, sampledAt: 61_000 });
    screens.set("%1", "prompt > typing");
    advance(60_000);
    await tracker.sample();
    expect(tracker.activity("%1")).toMatchObject({ screenSince: 121_000, sampledAt: 121_000 });
  });

  test("events and samples fill one entry", async () => {
    const { tracker, screens, advance } = setup([pane("%1")]);
    tracker.observe(pane("%1"), "busy", false);
    advance(1_000);
    screens.set("%1", "x");
    await tracker.sample();
    expect(tracker.activity("%1")).toEqual({
      state: "busy",
      stateSince: 1_000,
      turnEnded: false,
      screenSince: 2_000,
      sampledAt: 2_000,
    });
  });

  test("only live ours panes are captured, and none when there are none", async () => {
    const { tracker, screens, captured, setPanes } = setup();
    await tracker.sample();
    expect(captured).toEqual([]);
    setPanes([pane("%1", { ours: false }), pane("%2", { dead: true }), pane("%3")]);
    for (const id of ["%1", "%2", "%3"]) screens.set(id, "s");
    await tracker.sample();
    expect(captured).toEqual(["%3"]);
    expect(tracker.activity("%1")).toBeNull();
    expect(tracker.activity("%2")).toBeNull();
  });

  test("a failed capture leaves the entry as it was", async () => {
    const { tracker, screens, advance } = setup([pane("%1")]);
    screens.set("%1", "a");
    await tracker.sample();
    screens.set("%1", null);
    advance(60_000);
    await tracker.sample();
    expect(tracker.activity("%1")).toMatchObject({ screenSince: 1_000, sampledAt: 1_000 });
  });

  test("a failed listing keeps every entry; a pane gone from a listing goes, and so does one that died", async () => {
    const { tracker, screens, advance, setPanes } = setup([pane("%1"), pane("%2")]);
    screens.set("%1", "a");
    screens.set("%2", "b");
    await tracker.sample();
    advance(60_000);
    setPanes(new Error("tmux timed out"));
    await tracker.sample();
    expect(tracker.activity("%1")).not.toBeNull();
    expect(tracker.activity("%2")).not.toBeNull();
    advance(60_000);
    setPanes([pane("%2", { dead: true })]);
    await tracker.sample();
    expect(tracker.activity("%1")).toBeNull();
    expect(tracker.activity("%2")).toBeNull();
  });

  test("an entry made while a listing was in flight is not pruned by it", async () => {
    let release: (panes: readonly TrackedPane[]) => void = () => {};
    let clock = 1_000;
    const tracker = createPaneActivity({
      panes: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      capture: () => Promise.resolve("s"),
      now: () => clock,
    });
    const run = tracker.sample();
    clock += 10;
    // A pane spawned after tmux answered: its first frame lands before the pass prunes.
    tracker.observe(pane("%9"), "busy", false);
    release([]);
    await run;
    expect(tracker.activity("%9")).toMatchObject({ state: "busy" });
  });

  test("a sample asked for while one runs joins it rather than stacking a second", async () => {
    let lists = 0;
    let release: () => void = () => {};
    const tracker = createPaneActivity({
      panes: () => {
        lists += 1;
        return new Promise((resolve) => {
          release = () => resolve([]);
        });
      },
      capture: () => Promise.resolve("s"),
    });
    const first = tracker.sample();
    const second = tracker.sample();
    expect(second).toBe(first);
    release();
    await first;
    expect(lists).toBe(1);
    // Once it settled, the next minute's pass is a pass of its own.
    const third = tracker.sample();
    expect(third).not.toBe(first);
    release();
    await third;
    expect(lists).toBe(2);
  });

  test("stop forgets every entry, observes nothing more and samples nothing", async () => {
    const { tracker, screens, captured } = setup([pane("%1")]);
    screens.set("%1", "a");
    tracker.observe(pane("%1"), "busy", false);
    tracker.stop();
    tracker.observe(pane("%1"), "idle", true);
    await tracker.sample();
    expect(tracker.activity("%1")).toBeNull();
    expect(captured).toEqual([]);
  });
});
