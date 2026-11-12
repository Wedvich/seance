import { describe, expect, test } from "bun:test";
import type { ExclaveInfo } from "@seance/shared";
import { exclaveTraitNames, unmatchedTraitExclaves, withTraits } from "./traits.ts";

const exclave = (id: string): ExclaveInfo => ({
  id,
  accountId: `org:${id}`,
  extraUsageEnabled: null,
  authOk: true,
  skills: [],
});
const scan = [exclave("default"), exclave("work")];

describe("withTraits", () => {
  test("no config is the identity: the same list, so nothing downstream sees a difference", () => {
    expect(withTraits(scan, undefined)).toBe(scan);
    for (const out of withTraits(scan, {})) expect(out).not.toHaveProperty("traits");
  });

  test("a trait without `exclaves` is on every exclave; one with a list only on those", () => {
    const out = withTraits(scan, { atlas: {}, gpu: { exclaves: ["work"] } });
    expect(out.map((e) => [e.id, e.traits])).toEqual([
      ["default", ["atlas"]],
      ["work", ["atlas", "gpu"]],
    ]);
  });

  test("names come out sorted whatever the config order, and an exclave with none carries no field", () => {
    const out = withTraits(scan, { zed: {}, alpha: { exclaves: ["default"] }, mid: {} });
    expect(out[0]?.traits).toEqual(["alpha", "mid", "zed"]);
    expect(withTraits(scan, { only: { exclaves: ["default"] } })[1]).toEqual(exclave("work"));
    expect(withTraits(scan, { only: { exclaves: ["default"] } })[1]).not.toHaveProperty("traits");
  });

  test("`keepFree` is the sorted subset of an exclave's traits marked so, and absent when none is", () => {
    const out = withTraits(scan, {
      zed: { keepFree: true },
      alpha: { keepFree: true, exclaves: ["default"] },
      mid: {},
      gpu: { exclaves: ["work"], keepFree: true },
    });
    expect(out.map((e) => [e.id, e.traits, e.keepFree])).toEqual([
      ["default", ["alpha", "mid", "zed"], ["alpha", "zed"]],
      ["work", ["gpu", "mid", "zed"], ["gpu", "zed"]],
    ]);
    const none = withTraits(scan, { mid: {}, gpu: { exclaves: ["work"] } });
    for (const e of none) expect(e).not.toHaveProperty("keepFree");
  });

  test("a trait scoped to an exclave this machine lacks is on none; the rest of each exclave is untouched", () => {
    const out = withTraits(scan, { ghost: { exclaves: ["nowhere"] } });
    expect(out).toEqual(scan);
  });
});

describe("exclaveTraitNames", () => {
  test("is the order and membership withTraits advertises, for scoped, unscoped and trait-less exclaves", () => {
    const traits = { zed: {}, alpha: { exclaves: ["default"] }, gpu: { exclaves: ["work"] } };
    for (const e of withTraits(scan, traits)) {
      expect(exclaveTraitNames(e.id, traits)).toEqual(e.traits ?? []);
    }
    expect(exclaveTraitNames("other", { alpha: { exclaves: ["default"] } })).toEqual([]);
    expect(exclaveTraitNames("default", undefined)).toEqual([]);
  });
});

describe("unmatchedTraitExclaves", () => {
  test("names each trait's exclave ids the scan lacks, and nothing when all match or none is listed", () => {
    expect(
      unmatchedTraitExclaves(scan, { gpu: { exclaves: ["wrok", "work"] }, ghost: { exclaves: ["x", "y"] } }),
    ).toEqual([
      { trait: "gpu", exclaves: ["wrok"] },
      { trait: "ghost", exclaves: ["x", "y"] },
    ]);
    expect(unmatchedTraitExclaves(scan, { atlas: {}, gpu: { exclaves: ["work"] } })).toEqual([]);
    expect(unmatchedTraitExclaves(scan, undefined)).toEqual([]);
  });
});
