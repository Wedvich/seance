import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RULES = join(ROOT, ".claude", "rules");

// CLAUDE.md loads into every session; it reached 98 kB as a record before the rules moved out.
// Room for a rule or two, not a section: past this, the content belongs in a rules file or a doc.
const CLAUDE_MD_MAX_BYTES = 20_000;
// Claude Code truncates an on-demand memory file past 40k characters.
const RULES_FILE_MAX_CHARS = 40_000;

async function rulesFiles(): Promise<readonly string[]> {
  return (await readdir(RULES)).filter((name) => name.endsWith(".md")).toSorted();
}

function captures(text: string, pattern: RegExp): readonly string[] {
  return [...text.matchAll(pattern)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

function pathGlobs(text: string): readonly string[] {
  const front = /^---\n([\s\S]*?)\n---\n/u.exec(text)?.[1];
  return front === undefined ? [] : captures(front, /^\s+-\s+"([^"]+)"$/gmu);
}

/** One alternative per glob, so a dead name inside `{a,b}` is caught even while its sibling matches. */
function alternatives(glob: string): readonly string[] {
  const brace = /\{([^{}]*)\}/u.exec(glob);
  const inner = brace?.[1];
  if (brace === null || inner === undefined) return [glob];
  const [head, tail] = [glob.slice(0, brace.index), glob.slice(brace.index + brace[0].length)];
  return inner.split(",").flatMap((alt) => alternatives(`${head}${alt}${tail}`));
}

async function trackedFiles(): Promise<readonly string[]> {
  const out = await new Response(Bun.spawn(["git", "ls-files"], { cwd: ROOT }).stdout).text();
  return out.split("\n").filter((line) => line !== "");
}

test("CLAUDE.md stays rules, not record", async () => {
  expect((await Bun.file(join(ROOT, "CLAUDE.md")).bytes()).length).toBeLessThanOrEqual(CLAUDE_MD_MAX_BYTES);
});

test("every rules file is listed in CLAUDE.md and fits one load", async () => {
  const claudeMd = await Bun.file(join(ROOT, "CLAUDE.md")).text();
  const listed = captures(claudeMd, /`\.claude\/rules\/([a-z-]+\.md)`/gu);
  const files = await rulesFiles();
  expect([...new Set(listed)].toSorted()).toEqual([...files]);
  const oversized: string[] = [];
  for (const name of files) {
    if ((await Bun.file(join(RULES, name)).text()).length > RULES_FILE_MAX_CHARS) oversized.push(name);
  }
  expect(oversized).toEqual([]);
});

// A glob that matches nothing never loads its rules: a rename would drop them without a sound.
test("every rules glob matches a tracked file", async () => {
  const tracked = await trackedFiles();
  const dead: string[] = [];
  for (const name of await rulesFiles()) {
    const globs = pathGlobs(await Bun.file(join(RULES, name)).text());
    if (globs.length === 0) dead.push(`${name}: no paths`);
    for (const glob of globs.flatMap(alternatives)) {
      const matcher = new Bun.Glob(glob);
      if (!tracked.some((path) => matcher.match(path))) dead.push(`${name}: ${glob}`);
    }
  }
  expect(dead).toEqual([]);
});
