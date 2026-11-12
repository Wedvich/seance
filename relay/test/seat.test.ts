import { describe, expect, test } from "bun:test";
import { isSeat, parseArchivist, roleRefusal } from "../src/seat.ts";

const SEAT = "lJ3Ff2wXx5P0b9Q_-a.b";

describe("parseArchivist", () => {
  test("unset or blank honours nobody, and is nothing to log", () => {
    for (const raw of [undefined, "", " ", "\t\n"]) expect(parseArchivist(raw)).toEqual({ id: null, invalid: null });
  });

  test("one id, padded as a hand-typed secret is, is the seat", () => {
    expect(parseArchivist(` ${SEAT}\t`)).toEqual({ id: SEAT, invalid: null });
  });

  // One seat, never a list, and no wildcard: anything else fails closed and is set aside for the log.
  test("a list, a wildcard, a reserved name or junk honours nobody", () => {
    for (const raw of [
      `${SEAT},other-id`,
      `${SEAT}, `,
      "*",
      "app",
      "machines",
      "scheduler",
      "not an id!",
      "x".repeat(65),
    ]) {
      expect(parseArchivist(raw)).toEqual({ id: null, invalid: raw.trim() });
    }
  });
});

describe("roleRefusal", () => {
  test("a register that does not claim the seat is never refused here", () => {
    expect(roleRefusal("any", [], null)).toBeNull();
    expect(roleRefusal("any", ["scheduler"], SEAT)).toBeNull();
    expect(roleRefusal("any", ["minted-later"], null)).toBeNull();
  });

  test("the seat's own id claiming the role alone is honoured", () => {
    expect(roleRefusal(SEAT, ["archivist"], SEAT)).toBeNull();
  });

  test("any other id, or any id while nobody is honoured, is refused", () => {
    expect(roleRefusal("other-id", ["archivist"], SEAT)).toBe("archivist-not-seat");
    expect(roleRefusal(SEAT, ["archivist"], null)).toBe("archivist-not-seat");
  });

  test("the seat claiming scheduler too is refused, so it can never be nominated", () => {
    expect(roleRefusal(SEAT, ["scheduler", "archivist"], SEAT)).toBe("archivist-with-scheduler");
  });
});

describe("isSeat", () => {
  test("only a stored claim from the id on the secret now is pushed as the seat", () => {
    expect(isSeat({ deviceId: SEAT, archivistClaim: true }, SEAT)).toBe(true);
  });

  // The secret moved or was unset after the claim was stored: the old entry reads as an ordinary one.
  test("a claim from an id the secret no longer names, or with no seat, is not", () => {
    expect(isSeat({ deviceId: SEAT, archivistClaim: true }, "new-seat")).toBe(false);
    expect(isSeat({ deviceId: SEAT, archivistClaim: true }, null)).toBe(false);
  });

  test("the seat's id without a stored claim is not", () => {
    expect(isSeat({ deviceId: SEAT }, SEAT)).toBe(false);
  });
});
