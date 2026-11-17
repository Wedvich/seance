import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { AUTONOMY_LEVELS, EFFORTS } from "@seance/shared";
import { COMMAND_SPECS, COMMANDS, USAGE, type FlagSpec } from "./commands.ts";
import { zshCompletion } from "./completion.ts";

const usageCommands = USAGE.split("\n").flatMap((line) => {
  const name = /^ {2}(\S+)\s/u.exec(line)?.[1];
  return name === undefined || name.startsWith("(") ? [] : [name];
});

const flagOf = (command: (typeof COMMANDS)[number], flag: string): FlagSpec | undefined =>
  COMMAND_SPECS[command].flags?.find((spec) => spec.flag === flag);

test("every command has a usage line", () => {
  for (const name of COMMANDS) expect(usageCommands).toContain(name);
});

test("every command line in the usage names a command", () => {
  for (const name of usageCommands) expect(COMMANDS.some((command) => command === name)).toBe(true);
});

describe("the table against the parsers", () => {
  test("a flag's choices are the values its parser checks against", () => {
    expect(flagOf("spawn", "--autonomy")?.choices).toEqual([...AUTONOMY_LEVELS]);
    expect(flagOf("amend", "--effort")?.choices).toEqual([...EFFORTS, "default"]);
  });

  // The parsers are hand-rolled per command, so this is the guard against a flag added to one and not to the table:
  // help and completion would not know it.
  test("every flag a CLI module parses is in the table", async () => {
    const declared = new Set<string>(
      COMMANDS.flatMap((name) => {
        const spec = COMMAND_SPECS[name];
        const flags = (spec.flags ?? []).concat(Object.values(spec.verbs ?? {}).flatMap((verb) => verb.flags ?? []));
        return flags.flatMap((flag): readonly string[] =>
          flag.alias === undefined ? [flag.flag] : [flag.flag, flag.alias],
        );
      }),
    );
    // Flags of other programs' argv (`claude mcp add --scope user`, `stty -echo`), never ours.
    const foreign = new Set(["--scope", "--", "-echo"]);
    const modules = ["cli.ts", "custodian-owner-cli.ts", "custodian-cli.ts"];
    const sources = await Promise.all(
      modules.map(async (module) => readFile(new URL(`./${module}`, import.meta.url), "utf8")),
    );
    for (const [index, source] of sources.entries()) {
      const module = modules[index];
      const parsed = [...source.matchAll(/"(-{1,2}[a-z][a-z-]*)"/gu)].map((match) => match[1] ?? "");
      for (const flag of parsed.filter((word) => !foreign.has(word))) {
        expect({ module, flag, declared: declared.has(flag) }).toEqual({ module, flag, declared: true });
      }
    }
  });
});

describe("zsh completion", () => {
  const script = zshCompletion();

  test("offers every command but the ones only another program calls", () => {
    for (const name of COMMANDS) {
      expect(script.includes(`    '${name}:`)).toBe(COMMAND_SPECS[name].internal !== true);
    }
  });

  test("offers every flag of a command, and a verb's", () => {
    expect(script).toContain(`'*--not[keep it off a machine]:machine|here:'`);
    expect(script).toContain(":level:(steer checkpoint auto)'");
    expect(script).toContain(`'(-p --prompt)'{-p,--prompt}'[a note to add]:note:'`);
    expect(script).toContain(`'--for[`);
  });

  test("is valid zsh", async () => {
    if (Bun.which("zsh") === null) return;
    const proc = Bun.spawn(["zsh", "-n"], { stdin: new Blob([script]), stderr: "pipe" });
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(await proc.exited).toBe(0);
  });
});
