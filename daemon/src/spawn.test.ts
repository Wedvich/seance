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

  test("exit 0, or none noted, reads as a cancel", () => {
    for (const exit of [0, undefined]) {
      const text = continuePreamble("/w", exit);
      expect(text).toContain("was stopped before it finished");
      expect(text).toContain("only claude itself was stopped");
      expect(text).not.toContain("ended unexpectedly");
    }
  });
});
