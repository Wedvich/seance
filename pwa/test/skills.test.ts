import { describe, expect, test } from "bun:test";
import type { ExclaveInfo, Machine } from "@seance/shared";
import { completeSkill, matchSkills, promptSegments, skillIndex, skillToken } from "../src/skills.ts";

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

/** The query at the caret, the caret written as `|` in `typed` (end of text when absent). */
function queryAt(typed: string): string | null {
  const at = typed.indexOf("|");
  const prompt = typed.replace("|", "");
  return skillToken(prompt, at < 0 ? prompt.length : at)?.query ?? null;
}

describe("skillToken", () => {
  test("a slash at the start, alone or with a partial name", () => {
    expect(queryAt("/")).toBe("");
    expect(queryAt("/sh")).toBe("sh");
    expect(queryAt("/plugin:name")).toBe("plugin:name");
    expect(skillToken("/sh", 3)).toEqual({ start: 0, end: 3, query: "sh" });
  });

  test("mid-input and at the end, after any whitespace", () => {
    expect(queryAt("fix this /sh")).toBe("sh");
    expect(skillToken("fix this /sh", 12)).toEqual({ start: 9, end: 12, query: "sh" });
    expect(queryAt("fix /sh| it")).toBe("sh");
    expect(queryAt("notes\n/re|\nmore")).toBe("re");
    expect(queryAt("a\t/")).toBe("");
    expect(queryAt("/ship /re")).toBe("re");
  });

  test("null for a slash inside a word or URL, or a path", () => {
    expect(queryAt("see https://a/b")).toBeNull();
    expect(queryAt("and/or")).toBeNull();
    expect(queryAt("x/sh")).toBeNull();
    expect(queryAt("open /tmp/foo")).toBeNull();
    expect(queryAt("//")).toBeNull();
  });

  test("null unless the caret ends the token", () => {
    expect(queryAt("")).toBeNull();
    expect(queryAt("sh")).toBeNull();
    expect(queryAt("/sh ")).toBeNull();
    expect(queryAt("/s|h")).toBeNull();
    expect(queryAt("|/sh")).toBeNull();
    expect(queryAt("/sh |more")).toBeNull();
    expect(queryAt("/sh more|")).toBeNull();
    expect(queryAt("/sh\nmore")).toBeNull();
  });

  test("null for a selection range or a caret off the text", () => {
    expect(skillToken("/sh", null)).toBeNull();
    expect(skillToken("/sh", 4)).toBeNull();
    expect(skillToken("/sh", -1)).toBeNull();
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

describe("completeSkill", () => {
  /** Picks `name` for the token at `|` and returns the result with its caret as `|`. */
  function pick(typed: string, name: string): string {
    const at = typed.indexOf("|");
    const prompt = typed.replace("|", "");
    const token = skillToken(prompt, at < 0 ? prompt.length : at);
    if (token === null) throw new Error(`no token in ${typed}`);
    const next = completeSkill(prompt, token, name);
    return `${next.prompt.slice(0, next.caret)}|${next.prompt.slice(next.caret)}`;
  }

  test("replaces the token alone, at the start, mid-input or at the end, caret past one space", () => {
    expect(pick("/sh", "ship")).toBe("/ship |");
    expect(pick("fix this /sh", "ship")).toBe("fix this /ship |");
    expect(pick("fix /sh| it", "ship")).toBe("fix /ship |it");
    expect(pick("fix /sh|  it", "ship")).toBe("fix /ship | it");
    expect(pick("/re|\nnotes", "review")).toBe("/review |\nnotes");
    expect(pick("a /re|\tb", "review")).toBe("a /review |\tb");
  });

  test("the result has no token at its caret, so the picker closes", () => {
    const token = skillToken("do /sh", 6);
    if (token === null) throw new Error("no token");
    const next = completeSkill("do /sh", token, "ship");
    expect(skillToken(next.prompt, next.caret)).toBeNull();
  });
});

describe("promptSegments", () => {
  const skills = ["ship", "review"];
  /** Marked runs in brackets, the anchor as `^`. */
  function painted(prompt: string, anchor: { start: number; end: number } | null = null): string {
    const segments = promptSegments(prompt, skills, anchor);
    expect(segments.map((segment) => segment.text).join("")).toBe(prompt);
    return segments
      .map((segment) => `${segment.anchor ? "^" : ""}${segment.skill ? `[${segment.text}]` : segment.text}`)
      .join("");
  }

  test("marks every known name that starts the text or follows whitespace", () => {
    expect(painted("/ship")).toBe("[/ship]");
    expect(painted("/ship abc")).toBe("[/ship] abc");
    expect(painted("/review\nnotes")).toBe("[/review]\nnotes");
    expect(painted("do /ship then /review")).toBe("do [/ship] then [/review]");
    expect(painted("/ship /review")).toBe("[/ship] [/review]");
    expect(painted("a\t/ship")).toBe("a\t[/ship]");
  });

  test("marks nothing for an unknown or partial name, or one inside a word or URL", () => {
    expect(painted("/shi")).toBe("/shi");
    expect(painted("/shipit now")).toBe("/shipit now");
    expect(painted("/")).toBe("/");
    expect(painted("x/ship and https://a/ship")).toBe("x/ship and https://a/ship");
    expect(promptSegments("/ship", [], null)).toEqual([{ start: 0, text: "/ship", skill: false, anchor: false }]);
    expect(promptSegments("", skills, null)).toEqual([]);
  });

  test("cuts at the anchor, on a marked run or plain text", () => {
    expect(painted("do /re", { start: 3, end: 6 })).toBe("do ^/re");
    expect(painted("do /ship x", { start: 3, end: 8 })).toBe("do ^[/ship] x");
    expect(painted("/re", { start: 0, end: 3 })).toBe("^/re");
  });

  test("the anchored run is the token alone, trailing text stays outside it", () => {
    const segments = promptSegments("do /re then more", skills, { start: 3, end: 6 });
    expect(segments.filter((segment) => segment.anchor).map((segment) => segment.text)).toEqual(["/re"]);
    expect(painted("do /re then more", { start: 3, end: 6 })).toBe("do ^/re then more");
  });
});
