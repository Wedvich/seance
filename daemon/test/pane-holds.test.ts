import { describe, expect, test } from "bun:test";
import { paneHolds, type PaneHoldSources } from "../src/pane-holds.ts";

const sources = (o: {
  readonly stopNote?: boolean;
  readonly marked?: boolean;
  readonly drain?: boolean;
  readonly watch?: boolean;
}): PaneHoldSources => ({
  events: () => ({ awaitsWake: () => o.stopNote === true, marked: () => o.marked === true }),
  drain: () => () => o.drain === true,
  watches: () => ({
    holds: (pane, taskId) => o.watch === true && pane === "%1" && (taskId === undefined || taskId === "t"),
  }),
});

describe("what holds a pane open", () => {
  test("a live watch makes the pane await a wake, so the custodian's close and the seat leave it", () => {
    const { awaitsWake } = paneHolds(sources({ watch: true }));
    expect(awaitsWake("%1")).toBe(true);
    expect(awaitsWake("%1", "t")).toBe(true);
    expect(awaitsWake("%1", "other")).toBe(false);
    expect(awaitsWake("%2")).toBe(false);
  });

  test("a watch is not untouchable: a hand-off, a pass or the drain's close is the session's or the owner's own act", () => {
    const { untouchable } = paneHolds(sources({ watch: true }));
    expect(untouchable("%1")).toBe(false);
  });

  test("a mark or a drain entry is untouchable, and a stop note awaits a wake, whatever the watches say", () => {
    expect(paneHolds(sources({ marked: true })).untouchable("%1")).toBe(true);
    expect(paneHolds(sources({ drain: true })).untouchable("%1")).toBe(true);
    expect(paneHolds(sources({ stopNote: true })).awaitsWake("%1")).toBe(true);
    expect(paneHolds(sources({ marked: true, drain: true })).awaitsWake("%1")).toBe(false);
  });

  test("a source that does not exist holds nothing", () => {
    const { untouchable, awaitsWake } = paneHolds({
      events: () => undefined,
      drain: () => undefined,
      watches: () => undefined,
    });
    expect(untouchable("%1")).toBe(false);
    expect(awaitsWake("%1")).toBe(false);
  });
});
