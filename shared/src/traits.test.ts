import { describe, expect, test } from "bun:test";
import type { Machine } from "./app-client.ts";
import {
  fleetTraits,
  isTraitName,
  unknownTraits,
  unknownTraitsText,
  unreachableTraits,
  unreachableTraitsText,
} from "./traits.ts";
import type { ExclaveInfo } from "./types.ts";

function exclave(
  id: string,
  traits: readonly string[] | undefined,
  accountId: string | null = `org:${id}`,
): ExclaveInfo {
  return {
    id,
    accountId,
    extraUsageEnabled: null,
    authOk: accountId !== null,
    skills: [],
    ...(traits === undefined ? {} : { traits }),
  };
}

function machine(name: string, exclaves: readonly ExclaveInfo[] | undefined, connected = true): Machine {
  return {
    deviceId: `dev-${name}`,
    name,
    platform: "linux",
    repos: [],
    scannedAt: 1,
    lastSeen: 1,
    connected,
    ...(exclaves === undefined ? {} : { exclaves }),
  };
}

const macbook = machine("MacBook", [exclave("default", ["atlas", "gpu"]), exclave("work", ["gpu"])]);
const thad = machine("Thad", [exclave("default", ["az"])], false);
const bare = machine("Bare", [exclave("default", undefined)]);
const old = machine("Old", undefined);
const fleet = [thad, macbook, bare, old];

describe("isTraitName", () => {
  test("lowercase, digits and inner dashes, 1 to 32 characters", () => {
    for (const ok of ["a", "0", "atlas", "a-b-c", "9lives", "a".repeat(32)]) expect(isTraitName(ok)).toBe(true);
    for (const bad of ["", "-a", "A", "a b", "a_b", "a/b", "a".repeat(33), "é", " a", "a\n"])
      expect(isTraitName(bad)).toBe(false);
    for (const bad of [1, null, undefined, ["a"], {}]) expect(isTraitName(bad)).toBe(false);
  });
});

describe("fleetTraits", () => {
  test("maps each trait to the sorted, deduped machines carrying it, offline ones included", () => {
    const traits = fleetTraits(fleet);
    expect([...traits.keys()]).toEqual(["atlas", "az", "gpu"]);
    // MacBook carries gpu on two exclaves and is named once.
    expect(traits.get("gpu")).toEqual(["MacBook"]);
    expect(traits.get("az")).toEqual(["Thad"]);
    expect(fleetTraits([macbook, machine("Alpha", [exclave("default", ["gpu"])])]).get("gpu")).toEqual([
      "Alpha",
      "MacBook",
    ]);
  });

  test("a fleet with no traits, or machines with no exclave list, is empty", () => {
    expect(fleetTraits([bare, old]).size).toBe(0);
    expect(fleetTraits([]).size).toBe(0);
  });
});

describe("unknownTraits", () => {
  test("lists the requested names no machine declares, in request order", () => {
    expect(unknownTraits(["nope", "atlas", "also-not", "az"], fleet)).toEqual(["nope", "also-not"]);
    expect(unknownTraits(["atlas"], fleet)).toEqual([]);
  });
});

describe("unknownTraitsText", () => {
  test("names the typo and lists what is known", () => {
    expect(unknownTraitsText(["atlsa"], fleet)).toBe("no machine declares the trait atlsa — known: atlas, az, gpu");
    expect(unknownTraitsText(["x", "y"], fleet)).toContain("the traits x, y — known:");
  });

  test("says so when no machine declares any, and cuts a long known list", () => {
    expect(unknownTraitsText(["x"], [bare])).toBe("no machine declares the trait x — no machine declares any traits");
    const names = (prefix: string): readonly string[] =>
      Array.from({ length: 16 }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`);
    const many = machine("Many", [exclave("default", names("t"))]);
    const more = machine("More", [exclave("default", names("u"))]);
    expect(unknownTraitsText(["x"], [many, more])).toContain("and 8 more");
  });
});

describe("unreachableTraits", () => {
  test("a task without `requires` is always reachable, whatever else it says", () => {
    expect(unreachableTraits({}, [])).toEqual({ reachable: true, missing: [] });
    expect(unreachableTraits({ avoid: [macbook.deviceId], pin: { deviceId: "dev-nowhere" } }, fleet)).toEqual({
      reachable: true,
      missing: [],
    });
  });

  test("reachable when one exclave carries every trait; per exclave, never across a machine's exclaves", () => {
    expect(unreachableTraits({ requires: ["atlas", "gpu"] }, fleet)).toEqual({ reachable: true, missing: [] });
    // Each trait exists somewhere reachable, but no single exclave has atlas and az.
    expect(unreachableTraits({ requires: ["atlas", "az"] }, fleet)).toEqual({ reachable: false, missing: [] });
    const split = machine("Split", [exclave("x", ["a"]), exclave("y", ["b"])]);
    expect(unreachableTraits({ requires: ["a", "b"] }, [split])).toEqual({ reachable: false, missing: [] });
  });

  test("a device pin narrows to that machine; an account pin to its exclaves", () => {
    expect(unreachableTraits({ requires: ["az"], pin: { deviceId: macbook.deviceId } }, fleet)).toEqual({
      reachable: false,
      missing: ["az"],
    });
    expect(unreachableTraits({ requires: ["az"], pin: { deviceId: thad.deviceId } }, fleet).reachable).toBe(true);
    // atlas is on MacBook's default exclave only, whose account is org:default.
    expect(unreachableTraits({ requires: ["atlas"], pin: { account: "org:work" } }, fleet)).toEqual({
      reachable: false,
      missing: ["atlas"],
    });
    expect(unreachableTraits({ requires: ["atlas"], pin: { account: "org:default" } }, fleet).reachable).toBe(true);
  });

  test("an avoided machine's exclaves are out; without the avoid the same task is reachable", () => {
    expect(unreachableTraits({ requires: ["atlas"], avoid: [macbook.deviceId] }, fleet)).toEqual({
      reachable: false,
      missing: ["atlas"],
    });
    expect(unreachableTraits({ requires: ["atlas"] }, fleet).reachable).toBe(true);
    expect(unreachableTraits({ requires: ["atlas"], avoid: [thad.deviceId] }, fleet).reachable).toBe(true);
  });

  test("an offline machine still counts, and a machine with no exclave list carries nothing", () => {
    expect(unreachableTraits({ requires: ["az"] }, fleet).reachable).toBe(true);
    expect(unreachableTraits({ requires: ["az"] }, [old]).reachable).toBe(false);
  });
});

describe("unreachableTraitsText", () => {
  test("says where each trait is and what puts it out of reach", () => {
    expect(unreachableTraitsText({ requires: ["atlas"], avoid: [macbook.deviceId] }, fleet)).toBe(
      "no exclave this task can reach carries atlas — atlas is on MacBook (avoided)",
    );
    expect(unreachableTraitsText({ requires: ["atlas", "az"] }, fleet)).toBe(
      "no exclave this task can reach carries atlas and az together — atlas is on MacBook; az is on Thad",
    );
    expect(unreachableTraitsText({ requires: ["az"], pin: { deviceId: macbook.deviceId } }, fleet)).toContain(
      "az is on Thad (pinned elsewhere)",
    );
    expect(unreachableTraitsText({ requires: ["atlas"], pin: { account: "org:work" } }, fleet)).toContain(
      "atlas is on MacBook (other account)",
    );
    expect(unreachableTraitsText({ requires: ["nope"] }, fleet)).toContain("nope is on no machine");
  });

  test("names the exclave where one machine's exclaves each carry only part of what is required", () => {
    const split = machine("Split", [exclave("x", ["a"]), exclave("y", ["b"])]);
    expect(unreachableTraitsText({ requires: ["a", "b"] }, [split])).toBe(
      "no exclave this task can reach carries a and b together — a is on Split/x; b is on Split/y",
    );
    // gpu sits on two of MacBook's exclaves, atlas on one: both are named, since both carry something required.
    expect(unreachableTraitsText({ requires: ["atlas", "gpu", "az"] }, [macbook])).toContain(
      "gpu is on MacBook/default, MacBook/work",
    );
  });
});
