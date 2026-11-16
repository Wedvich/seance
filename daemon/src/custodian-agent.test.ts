import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "@seance/shared";
import { loadAgent, NOTES_MAX, parseAgent, ROUND_SEED, roundSeed } from "./custodian-agent.ts";
import { readNotes } from "./custodian-launch.ts";
import { log } from "./log.ts";

const AGENT = `---
name: custodian
description: Does a thing.
tools: Bash
---

Prompt body.
`;

/** The prompt's fenced examples that feed a verb's stdin, each joined back into the shell text it is. */
const stdinExamples = (prompt: string): string[] =>
  [...prompt.matchAll(/```\n([\s\S]*?)```/gu)]
    .map((match) =>
      (match[1] ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .join("\n"),
    )
    .filter((example) => example.includes("| seanced custodian "));

/**
 * macOS's `/bin/bash` 3.2 makes a here-document's temp file in `/var/tmp`, `/tmp`, `/usr/tmp` or the cwd, never
 * `$TMPDIR`, and the round's sandbox lets it write none of them (the cwd is the write-denied round dir). This profile
 * denies every write, so an example passes here only if it needs no file at all. Linux's bash honours `$TMPDIR`, which
 * the round can write; there the run shows only that the example delivers its text.
 */
const NO_WRITES = "(version 1)(allow default)(deny file-write*)";
const SEANCED_STUB = 'seanced() { printf "%s\\n" "$*"; cat; }';

async function underNoWrites(example: string): Promise<{ readonly code: number; readonly out: string }> {
  const script = `${SEANCED_STUB}\n${example}`;
  const argv =
    process.platform === "darwin"
      ? ["sandbox-exec", "-p", NO_WRITES, "/bin/bash", "-c", script]
      : ["/bin/bash", "-c", script];
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin" } });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, out };
}

describe("the committed agent definition", () => {
  test("loads as one agent, custodian, with only Bash and Read and a prompt", async () => {
    const parsed: unknown = JSON.parse(await loadAgent());
    expect(parsed).toBeObject();
    const agents = parsed as Record<string, { description: string; prompt: string; tools: string[] }>;
    expect(Object.keys(agents)).toEqual(["custodian"]);
    expect(agents["custodian"]?.tools).toEqual(["Bash"]);
    expect(agents["custodian"]?.prompt.length).toBeGreaterThan(100);
    expect(agents["custodian"]?.description).not.toBe("");
  });

  test("feeds every text verb by a pipe, never a heredoc: the round's shell can write no temp file", async () => {
    const parsed: unknown = JSON.parse(await loadAgent());
    const custodian = isRecord(parsed) ? parsed["custodian"] : undefined;
    const prompt = isRecord(custodian) && typeof custodian["prompt"] === "string" ? custodian["prompt"] : "";
    expect(prompt).not.toContain("<<");
    const examples = stdinExamples(prompt);
    expect(examples.map((example) => /\| seanced custodian (\w+)/u.exec(example)?.[1]).toSorted()).toEqual([
      "done",
      "notes",
      "nudge",
    ]);
    for (const { code, out } of await Promise.all(examples.map(underNoWrites))) {
      expect(code).toBe(0);
      const [argv = "", ...stdin] = out.split("\n");
      expect(argv).toStartWith("custodian ");
      expect(stdin.join("\n").trim()).not.toBe("");
    }
    if (process.platform === "darwin") {
      // The control: under the same profile a heredoc fails, so the passes above are not the profile letting writes by.
      expect((await underNoWrites("seanced custodian done <<'EOF'\nx\nEOF")).code).not.toBe(0);
    }
  });
});

describe("parseAgent", () => {
  test("turns the file into the --agents JSON", () => {
    expect(JSON.parse(parseAgent(AGENT))).toEqual({
      custodian: { description: "Does a thing.", prompt: "Prompt body.", tools: ["Bash"] },
    });
  });

  test("an extra frontmatter key, a wider tool list, another name or a missing part is refused", () => {
    expect(() => parseAgent(AGENT.replace("tools: Bash", "tools: Bash\nmodel: opus"))).toThrow();
    expect(() => parseAgent(AGENT.replace("tools: Bash", "tools: Bash, Write"))).toThrow(/tools must be/u);
    expect(() => parseAgent(AGENT.replace("tools: Bash", "tools: Bash, Read"))).toThrow(/tools must be/u);
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
