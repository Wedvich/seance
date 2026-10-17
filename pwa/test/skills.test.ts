import { describe, expect, test } from "bun:test";
import type { ExclaveInfo, Machine } from "@seance/shared";
import { completeSkill, describeSources, matchSkills, skillIndex, skillQuery } from "../src/skills.ts";

const NOW = 1_800_000_000_000;

function exclave(id: string, skills: readonly string[]): ExclaveInfo {
  return { id, accountId: null, extraUsageEnabled: null, authOk: true, skills };
}

function machine(name: string, exclaves?: readonly ExclaveInfo[], connected = true): Machine {
  return {
    deviceId: `dev-${name}`,
    name,
    platform: "darwin",
    repos: [],
    scannedAt: NOW,
    lastSeen: NOW,
    connected,
    ...(exclaves === undefined ? {} : { exclaves }),
  };
}

const names = (entries: readonly { name: string }[]): readonly string[] => entries.map((e) => e.name);

describe("skillIndex", () => {
  test("unions names across machines and exclaves, once each, with where they come from", () => {
    const index = skillIndex([
      machine("Studio", [exclave("default", ["ship", "dataviz"])]),
      machine("MacBook Pro", [exclave("default", ["ship"]), exclave("work", ["ship", "review"])]),
    ]);
    expect(names(index.skills)).toEqual(["dataviz", "review", "ship"]);
    expect(index.machines).toBe(2);
    expect(index.skills.find((s) => s.name === "ship")?.sources).toEqual([
      { machine: "MacBook Pro", exclaves: ["default", "work"], multiExclave: true },
      { machine: "Studio", exclaves: ["default"], multiExclave: false },
    ]);
  });

  test("machines without exclaves are not counted; offline ones are", () => {
    const index = skillIndex([
      machine("old-daemon"),
      machine("empty", []),
      machine("asleep", [exclave("default", ["ship"])], false),
    ]);
    expect(index.machines).toBe(1);
    expect(names(index.skills)).toEqual(["ship"]);
  });

  test("no machine reports skills: an empty union", () => {
    expect(skillIndex([]).skills).toEqual([]);
    expect(skillIndex([machine("a", [exclave("default", [])])]).skills).toEqual([]);
  });
});

describe("skillQuery", () => {
  test("only the first token after a leading slash", () => {
    expect(skillQuery("/")).toBe("");
    expect(skillQuery("/sh")).toBe("sh");
    expect(skillQuery("/plugin:name")).toBe("plugin:name");
  });

  test("null once the token ends, or with no slash first", () => {
    expect(skillQuery("")).toBeNull();
    expect(skillQuery("sh")).toBeNull();
    expect(skillQuery(" /sh")).toBeNull();
    expect(skillQuery("/sh ")).toBeNull();
    expect(skillQuery("/sh\nmore")).toBeNull();
    expect(skillQuery("/sh\tx")).toBeNull();
  });
});

describe("matchSkills", () => {
  const { skills } = skillIndex([
    machine("m", [exclave("default", ["review", "preview-deploy", "Prettier", "ship", "pr-review"])]),
  ]);

  test("an empty query lists every name", () => {
    expect(names(matchSkills(skills, ""))).toEqual(names(skills));
  });

  test("prefix matches first, then substring ones, case-insensitively", () => {
    expect(names(matchSkills(skills, "pr"))).toEqual(["pr-review", "Prettier", "preview-deploy"]);
    expect(names(matchSkills(skills, "REV"))).toEqual(["review", "pr-review", "preview-deploy"]);
  });

  test("nothing matches: empty", () => {
    expect(matchSkills(skills, "zzz")).toEqual([]);
  });
});

describe("describeSources", () => {
  test("on every reporting machine, more than one: a count", () => {
    const index = skillIndex([
      machine("a", [exclave("default", ["ship"])]),
      machine("b", [exclave("default", ["ship"]), exclave("work", [])]),
      machine("c", [exclave("default", ["ship", "rare"])]),
    ]);
    const [rare, ship] = index.skills;
    expect(ship === undefined ? null : describeSources(ship, index.machines)).toBe("all 3 machines");
    expect(rare === undefined ? null : describeSources(rare, index.machines)).toBe("c");
  });

  test("exclaves named only where a machine has more than one", () => {
    const index = skillIndex([
      machine("MacBook Pro", [exclave("default", ["ship"]), exclave("work", ["ship"]), exclave("oss", [])]),
      machine("Studio", [exclave("default", ["x"])]),
      machine("Tower", [exclave("default", ["ship"])]),
    ]);
    const ship = index.skills.find((s) => s.name === "ship");
    expect(ship === undefined ? null : describeSources(ship, index.machines)).toBe(
      "MacBook Pro (default, work) · Tower",
    );
  });

  test("one reporting machine: its name, not a count", () => {
    const index = skillIndex([machine("Solo", [exclave("default", ["ship"])])]);
    const [ship] = index.skills;
    expect(ship === undefined ? null : describeSources(ship, index.machines)).toBe("Solo");
  });
});

test("completeSkill makes the name the first token and leaves the caret past a space", () => {
  expect(completeSkill("ship")).toBe("/ship ");
  expect(skillQuery(completeSkill("ship"))).toBeNull();
});
