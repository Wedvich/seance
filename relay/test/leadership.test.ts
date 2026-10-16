import { describe, expect, test } from "bun:test";
import { nominate, type Candidate } from "../src/leadership.ts";

const SCHEDULER = ["scheduler"];

function daemon(deviceId: string, connectedAt: number, roles: readonly string[] = SCHEDULER): Candidate {
  return { deviceId, roles, connectedAt };
}

describe("nominate", () => {
  test("the earliest-connected capable daemon leads, wherever it sits in the list", () => {
    expect(nominate([daemon("b", 300), daemon("c", 100), daemon("a", 200)], null)).toBe("c");
  });

  test("a tie on connectedAt goes to the lowest deviceId", () => {
    expect(nominate([daemon("m", 100), daemon("Z", 100), daemon("k", 100)], null)).toBe("Z");
    expect(nominate([daemon("k", 100), daemon("m", 100)], null)).toBe("k");
  });

  // A v1 register, or a v2 one without the role, is never nominated — however
  // long it has been connected.
  test("a daemon without the scheduler role is never nominated", () => {
    expect(nominate([daemon("old", 1, []), daemon("new", 500)], null)).toBe("new");
    expect(nominate([daemon("old", 1, []), daemon("other", 2, ["something-later"])], null)).toBeNull();
    expect(nominate([], null)).toBeNull();
  });

  test("a current leader keeps the role while it is still a capable candidate, even if someone connected earlier", () => {
    // Its own reconnect reset its connectedAt; the role stays rather than moving.
    expect(nominate([daemon("early", 100), daemon("leader", 900)], "leader")).toBe("leader");
  });

  test("re-nomination: a leader that is gone, or lost its role, hands over to the earliest remaining", () => {
    expect(nominate([daemon("b", 300), daemon("a", 200)], "gone")).toBe("a");
    expect(nominate([daemon("leader", 100, []), daemon("b", 300)], "leader")).toBe("b");
    expect(nominate([daemon("leader", 100, [])], "leader")).toBeNull();
  });
});
