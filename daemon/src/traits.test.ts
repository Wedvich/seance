import { describe, expect, test } from "bun:test";
import type { ExclaveInfo } from "@seance/shared";
import { withTraits } from "./traits.ts";

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

  test("a trait scoped to an exclave this machine lacks is on none; the rest of each exclave is untouched", () => {
    const out = withTraits(scan, { ghost: { exclaves: ["nowhere"] } });
    expect(out).toEqual(scan);
  });
});
