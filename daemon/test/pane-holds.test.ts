import { describe, expect, test } from "bun:test";
import { paneHolds, type PaneHoldSources } from "../src/pane-holds.ts";

const sources = (o: {
  readonly stopNote?: boolean;
  readonly marked?: boolean;
  readonly drain?: boolean;
  readonly watch?: boolean;
  readonly kept?: boolean;
}): PaneHoldSources => ({
  events: () => ({ awaitsWake: () => o.stopNote === true, marked: () => o.marked === true }),
  drain: () => () => o.drain === true,
  watches: () => ({
    holds: (pane, taskId) => o.watch === true && pane === "%1" && (taskId === undefined || taskId === "t"),
  }),
  keepOpen: () => ({ holds: (pane) => o.kept === true && pane === "%1" }),
});

// The sources are doubles: this holds the composition (which source feeds which hold) and the seat's one expression.
// The real table as a source is in `watches.test.ts`, and the `close` verb's `busy` for `awaitsWake` in `custodian-verbs.test.ts`.
describe("what holds a pane open", () => {
  test("a source's watch hold is awaiting a wake, and the seat's due check leaves such a pane too", () => {
    const { awaitsWake, seatHolds } = paneHolds(sources({ watch: true }));
    expect(awaitsWake("%1")).toBe(true);
    expect(awaitsWake("%1", "t")).toBe(true);
    expect(awaitsWake("%1", "other")).toBe(false);
    expect(awaitsWake("%2")).toBe(false);
    expect(seatHolds("%1")).toBe(true);
    expect(seatHolds("%2")).toBe(false);
  });

  test("the seat's due check leaves a marked pane too", () => {
    expect(paneHolds(sources({ marked: true })).seatHolds("%1")).toBe(true);
    expect(paneHolds(sources({})).seatHolds("%1")).toBe(false);
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

  test("a keep-open hold is held open and leaves the seat's due check, and is neither untouchable nor a wake", () => {
    const { heldOpen, seatHolds, untouchable, awaitsWake } = paneHolds(sources({ kept: true }));
    expect(heldOpen("%1")).toBe(true);
    expect(heldOpen("%2")).toBe(false);
    expect(seatHolds("%1")).toBe(true);
    expect(untouchable("%1")).toBe(false);
    expect(awaitsWake("%1")).toBe(false);
    expect(paneHolds(sources({ watch: true, marked: true })).heldOpen("%1")).toBe(false);
  });

  test("a source that does not exist holds nothing", () => {
    const { untouchable, awaitsWake, heldOpen } = paneHolds({
      events: () => undefined,
      drain: () => undefined,
      watches: () => undefined,
      keepOpen: () => undefined,
    });
    expect(untouchable("%1")).toBe(false);
    expect(awaitsWake("%1")).toBe(false);
    expect(heldOpen("%1")).toBe(false);
  });
});
