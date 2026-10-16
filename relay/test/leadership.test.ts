import { describe, expect, test } from "bun:test";
import { nominate, parseLeaders, type Candidate } from "../src/leadership.ts";

const SCHEDULER = ["scheduler"];

function daemon(deviceId: string, connectedAt: number, roles: readonly string[] = SCHEDULER): Candidate {
  return { deviceId, roles, connectedAt };
}

/** Every id the suites below use, so the allowlist stays out of the way of the rules it does not decide. */
const ALL = new Set(["a", "b", "c", "k", "m", "Z", "old", "new", "other", "early", "leader"]);

describe("nominate", () => {
  test("the earliest-connected capable daemon leads, wherever it sits in the list", () => {
    expect(nominate([daemon("b", 300), daemon("c", 100), daemon("a", 200)], null, ALL)).toBe("c");
  });

  test("a tie on connectedAt goes to the lowest deviceId", () => {
    expect(nominate([daemon("m", 100), daemon("Z", 100), daemon("k", 100)], null, ALL)).toBe("Z");
    expect(nominate([daemon("k", 100), daemon("m", 100)], null, ALL)).toBe("k");
  });

  // A v1 register, or a v2 one without the role, is never nominated — however
  // long it has been connected.
  test("a daemon without the scheduler role is never nominated", () => {
    expect(nominate([daemon("old", 1, []), daemon("new", 500)], null, ALL)).toBe("new");
    expect(nominate([daemon("old", 1, []), daemon("other", 2, ["something-later"])], null, ALL)).toBeNull();
    expect(nominate([], null, ALL)).toBeNull();
  });

  test("a current leader keeps the role while it is still a capable candidate, even if someone connected earlier", () => {
    // Its own reconnect reset its connectedAt; the role stays rather than moving.
    expect(nominate([daemon("early", 100), daemon("leader", 900)], "leader", ALL)).toBe("leader");
  });

  test("re-nomination: a leader that is gone, or lost its role, hands over to the earliest remaining", () => {
    expect(nominate([daemon("b", 300), daemon("a", 200)], "gone", ALL)).toBe("a");
    expect(nominate([daemon("leader", 100, []), daemon("b", 300)], "leader", ALL)).toBe("b");
    expect(nominate([daemon("leader", 100, [])], "leader", ALL)).toBeNull();
  });
});

describe("nominate, allowlisted", () => {
  // The squatter: a self-minted id with signed roles, holding the oldest socket.
  test("a capable candidate off the list is never nominated, even connected earliest", () => {
    const listed = new Set(["b"]);
    expect(nominate([daemon("squatter", 1), daemon("b", 300)], null, listed)).toBe("b");
    expect(nominate([daemon("squatter", 1)], null, listed)).toBeNull();
  });

  test("an empty list nominates nobody", () => {
    expect(nominate([daemon("a", 1), daemon("b", 2)], null, new Set())).toBeNull();
  });

  test("a current leader taken off the list loses the role to the earliest listed one", () => {
    expect(nominate([daemon("leader", 1), daemon("a", 200), daemon("b", 100)], "leader", new Set(["a", "b"]))).toBe(
      "b",
    );
    expect(nominate([daemon("leader", 1)], "leader", new Set(["a"]))).toBeNull();
  });
});

describe("parseLeaders", () => {
  test("unset or empty is the empty set, never everyone", () => {
    for (const raw of [undefined, "", " ", ",, ,"]) expect(parseLeaders(raw)).toEqual({ ids: new Set(), invalid: [] });
  });

  test("entries are trimmed and blanks dropped; anything outside the deviceId bounds is set aside, not fatal", () => {
    const id = "lJ3Ff2wXx5P0b9Q_-a.b";
    const { ids, invalid } = parseLeaders(` ${id}\t, ,other-id,not an id!,${"x".repeat(65)},scheduler,app,machines`);
    expect([...ids]).toEqual([id, "other-id"]);
    expect(invalid).toEqual(["not an id!", "x".repeat(65), "scheduler", "app", "machines"]);
  });
});
