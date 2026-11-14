import { describe, expect, test } from "bun:test";
import { createRefusalTally } from "./refusal-tally.ts";

describe("createRefusalTally", () => {
  test("empty reads as none", () => {
    expect(createRefusalTally().snapshot()).toEqual({ tasks: 0, since: null });
  });

  test("counts each task once, keeps its first refusal, and since is the oldest held", () => {
    let at = 100;
    const tally = createRefusalTally(() => at);
    tally.refused("t-a");
    at = 200;
    tally.refused("t-b");
    at = 300;
    tally.refused("t-a");
    expect(tally.snapshot()).toEqual({ tasks: 2, since: 100 });
    tally.cleared("t-a");
    expect(tally.snapshot()).toEqual({ tasks: 1, since: 200 });
    tally.cleared("t-b");
    tally.cleared("t-never");
    expect(tally.snapshot()).toEqual({ tasks: 0, since: null });
  });
});
