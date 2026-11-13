import { describe, expect, test } from "bun:test";
import { matchesFilter, splitMatch } from "../src/sheet-filter.ts";

describe("matchesFilter", () => {
  test("an empty or whitespace-only query matches everything", () => {
    expect(matchesFilter("", ["a"])).toBe(true);
    expect(matchesFilter("   ", ["a"])).toBe(true);
    expect(matchesFilter("", [])).toBe(true);
  });

  test("matches any field, ignoring case and surrounding spaces", () => {
    expect(matchesFilter("SEANCE", ["wedvich/seance", "github.com/wedvich/seance"])).toBe(true);
    expect(matchesFilter("  github ", ["seance", "github.com/wedvich/seance"])).toBe(true);
    expect(matchesFilter("nope", ["seance", "github.com/wedvich/seance"])).toBe(false);
  });

  test("regex metacharacters match literally", () => {
    expect(matchesFilter("a.b", ["axb"])).toBe(false);
    expect(matchesFilter("a.b", ["a.b"])).toBe(true);
    expect(matchesFilter("c++", ["c++lib"])).toBe(true);
    expect(matchesFilter("(", ["f(x)"])).toBe(true);
  });
});

describe("splitMatch", () => {
  test("is null for an empty query or no match", () => {
    expect(splitMatch("seance", "")).toBeNull();
    expect(splitMatch("seance", "  ")).toBeNull();
    expect(splitMatch("seance", "zzz")).toBeNull();
  });

  test("keeps the original casing around the hit", () => {
    expect(splitMatch("wedvich/seance", "SEANCE")).toEqual({ before: "wedvich/", hit: "seance", after: "" });
    expect(splitMatch("wedvich/seance", " ed ")).toEqual({ before: "w", hit: "ed", after: "vich/seance" });
  });

  test("a match only in another field leaves the label untinted", () => {
    expect(matchesFilter("github", ["seance", "github.com/x/seance"])).toBe(true);
    expect(splitMatch("seance", "github")).toBeNull();
  });

  test("the first occurrence wins", () => {
    expect(splitMatch("xabyab", "ab")).toEqual({ before: "x", hit: "ab", after: "yab" });
  });

  test("folds non-ASCII case without misplacing the split", () => {
    expect(splitMatch("Østfold", "ø")).toEqual({ before: "", hit: "Ø", after: "stfold" });
    expect(splitMatch("İstanbul", "stan")).toEqual({ before: "İ", hit: "stan", after: "bul" });
  });

  test("regex metacharacters match literally", () => {
    expect(splitMatch("a.b and axb", "a.b")).toEqual({ before: "", hit: "a.b", after: " and axb" });
  });
});
