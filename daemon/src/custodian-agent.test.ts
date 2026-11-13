import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgent, NOTES_MAX, parseAgent, ROUND_SEED, roundSeed } from "./custodian-agent.ts";
import { readNotes } from "./custodian-launch.ts";
import { log } from "./log.ts";

const AGENT = `---
name: custodian
description: Does a thing.
tools: Bash, Read
---

Prompt body.
`;

describe("the committed agent definition", () => {
  test("loads as one agent, custodian, with only Bash and Read and a prompt", async () => {
    const parsed: unknown = JSON.parse(await loadAgent());
    expect(parsed).toBeObject();
    const agents = parsed as Record<string, { description: string; prompt: string; tools: string[] }>;
    expect(Object.keys(agents)).toEqual(["custodian"]);
    expect(agents["custodian"]?.tools).toEqual(["Bash", "Read"]);
    expect(agents["custodian"]?.prompt.length).toBeGreaterThan(100);
    expect(agents["custodian"]?.description).not.toBe("");
  });
});

describe("parseAgent", () => {
  test("turns the file into the --agents JSON", () => {
    expect(JSON.parse(parseAgent(AGENT))).toEqual({
      custodian: { description: "Does a thing.", prompt: "Prompt body.", tools: ["Bash", "Read"] },
    });
  });

  test("an extra frontmatter key, a wider tool list, another name or a missing part is refused", () => {
    expect(() => parseAgent(AGENT.replace("tools: Bash, Read", "tools: Bash, Read\nmodel: opus"))).toThrow();
    expect(() => parseAgent(AGENT.replace("tools: Bash, Read", "tools: Bash, Read, Write"))).toThrow(/tools must be/u);
    expect(() => parseAgent(AGENT.replace("tools: Bash, Read", "tools: Read, Bash"))).toThrow(/tools must be/u);
    expect(() => parseAgent(AGENT.replace("name: custodian", "name: other"))).toThrow(/name must be/u);
    expect(() => parseAgent(AGENT.replace("description: Does a thing.\n", ""))).toThrow(/missing/u);
    expect(() => parseAgent(AGENT.replace("name: custodian\n", "name: custodian\nname: custodian\n"))).toThrow(
      /twice/u,
    );
    expect(() => parseAgent("no frontmatter")).toThrow(/frontmatter/u);
    expect(() => parseAgent(AGENT.replace("Prompt body.", ""))).toThrow(/prompt is empty/u);
  });
});

describe("roundSeed", () => {
  test("is the constant with no notes, and carries them after it otherwise", () => {
    expect(roundSeed(null)).toBe(ROUND_SEED);
    expect(roundSeed("  \n")).toBe(ROUND_SEED);
    const seeded = roundSeed("pane %3 is a long build");
    expect(seeded.startsWith(ROUND_SEED)).toBe(true);
    expect(seeded).toContain("pane %3 is a long build");
  });
});

describe("readNotes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "seance-notes-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("null for a missing file, the text for one within the cap", async () => {
    expect(await readNotes(join(dir, "none.md"))).toBeNull();
    await writeFile(join(dir, "notes.md"), "keep an eye on %4");
    expect(await readNotes(join(dir, "notes.md"))).toBe("keep an eye on %4");
  });

  test("over the cap it is not carried, and the log line says its size, never its content", async () => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      await writeFile(join(dir, "big.md"), `SECRET${"x".repeat(NOTES_MAX)}`);
      expect(await readNotes(join(dir, "big.md"))).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain(String(NOTES_MAX + 6));
      expect(line).not.toContain("SECRET");
    } finally {
      warn.mockRestore();
    }
  });
});
