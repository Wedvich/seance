import { describe, expect, test } from "bun:test";
import { continuePreamble } from "./spawn.ts";

describe("continuePreamble", () => {
  test("a nonzero exit reads as a death", () => {
    for (const exit of [1, 137]) {
      const text = continuePreamble("/w", exit);
      expect(text).toContain("ended unexpectedly");
      expect(text).toContain("only claude itself was killed");
    }
  });

  test("no exit with a vanished window reads as a closed window, and a status outranks it", () => {
    const text = continuePreamble("/w", undefined, true);
    expect(text).toContain("ended when its window was closed");
    expect(text).toContain("processes it started in the background may still be running");
    expect(text).not.toContain("cancelled from séance");
    expect(continuePreamble("/w", 0, true)).toContain("cancelled from séance");
    expect(continuePreamble("/w", 3, true)).toContain("ended unexpectedly");
  });

  test("a hand-off reads as one, not a stop, for exit 0 or none; a status outranks it", () => {
    for (const exit of [0, undefined]) {
      const text = continuePreamble("/w", exit, undefined, true);
      expect(text).toContain("handing its pull request off");
      expect(text).toContain("hand_off_task");
      expect(text).toContain("Nothing it started was interrupted");
      expect(text).not.toContain("was stopped before it finished");
    }
    expect(continuePreamble("/w", 0, true, true)).toContain("handing its pull request off");
    expect(continuePreamble("/w", 137, false, true)).toContain("ended unexpectedly");
    expect(continuePreamble("/w", 0, false, false)).toContain("was stopped before it finished");
  });

  test("exit 0, or none noted, reads as a cancel", () => {
    for (const exit of [0, undefined]) {
      const text = continuePreamble("/w", exit);
      expect(text).toContain("was stopped before it finished");
      expect(text).toContain("only claude itself was stopped");
      expect(text).not.toContain("ended unexpectedly");
    }
  });
});
