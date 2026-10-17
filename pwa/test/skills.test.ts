import { describe, expect, test } from "bun:test";
import type { ExclaveInfo, Machine } from "@seance/shared";
import { completeSkill, matchSkills, skillIndex, skillQuery, skillTokenLength } from "../src/skills.ts";

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

describe("skillIndex", () => {
  test("names with whitespace are skipped: they can't form a /name token", () => {
    expect(skillIndex([machine("A", [exclave("default", ["ok", "has space", "tab\tname"])])])).toEqual(["ok"]);
  });

  test("unions names across machines and exclaves, once each, sorted", () => {
    const index = skillIndex([
      machine("Studio", [exclave("default", ["ship", "dataviz"])]),
      machine("MacBook Pro", [exclave("default", ["ship"]), exclave("work", ["ship", "review"])]),
    ]);
    expect(index).toEqual(["dataviz", "review", "ship"]);
  });

  test("machines without exclaves add nothing; offline ones still count", () => {
    const index = skillIndex([
      machine("old-daemon"),
      machine("empty", []),
      machine("asleep", [exclave("default", ["ship"])], false),
    ]);
    expect(index).toEqual(["ship"]);
  });

  test("no machine reports skills: an empty union", () => {
    expect(skillIndex([])).toEqual([]);
    expect(skillIndex([machine("a", [exclave("default", [])])])).toEqual([]);
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
  const skills = skillIndex([
    machine("m", [exclave("default", ["review", "preview-deploy", "Prettier", "ship", "pr-review"])]),
  ]);

  test("an empty query lists every name", () => {
    expect(matchSkills(skills, "")).toEqual(skills);
  });

  test("prefix matches first, then substring ones, case-insensitively", () => {
    expect(matchSkills(skills, "pr")).toEqual(["pr-review", "Prettier", "preview-deploy"]);
    expect(matchSkills(skills, "REV")).toEqual(["review", "pr-review", "preview-deploy"]);
  });

  test("nothing matches: empty", () => {
    expect(matchSkills(skills, "zzz")).toEqual([]);
  });
});

test("completeSkill makes the name the first token and leaves the caret past a space", () => {
  expect(completeSkill("ship")).toBe("/ship ");
  expect(skillQuery(completeSkill("ship"))).toBeNull();
});

describe("skillTokenLength", () => {
  const skills = ["ship", "review"];

  test("marks a known name as the first token, alone or before more text", () => {
    expect(skillTokenLength("/ship", skills)).toBe(5);
    expect(skillTokenLength("/ship abc", skills)).toBe(5);
    expect(skillTokenLength("/review\nnotes", skills)).toBe(7);
  });

  test("marks nothing for an unknown or partial name, or one that isn't first", () => {
    expect(skillTokenLength("/shi", skills)).toBe(0);
    expect(skillTokenLength("/shipit now", skills)).toBe(0);
    expect(skillTokenLength("/", skills)).toBe(0);
    expect(skillTokenLength(" /ship", skills)).toBe(0);
    expect(skillTokenLength("do /ship", skills)).toBe(0);
    expect(skillTokenLength("/ship", [])).toBe(0);
  });
});
