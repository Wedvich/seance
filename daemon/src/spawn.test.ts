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

  test("exit 0, or none noted, reads as a cancel", () => {
    for (const exit of [0, undefined]) {
      const text = continuePreamble("/w", exit);
      expect(text).toContain("was stopped before it finished");
      expect(text).toContain("only claude itself was stopped");
      expect(text).not.toContain("ended unexpectedly");
    }
  });
});
