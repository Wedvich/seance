import { expect, test } from "bun:test";
import { COMMANDS, USAGE } from "./commands.ts";

const usageCommands = USAGE.split("\n").flatMap((line) => {
  const name = /^ {2}(\S+)\s/u.exec(line)?.[1];
  return name === undefined || name.startsWith("(") ? [] : [name];
});

test("every command has a usage line", () => {
  for (const name of COMMANDS) expect(usageCommands).toContain(name);
});

test("every command line in the usage names a command", () => {
  for (const name of usageCommands) expect(COMMANDS.some((command) => command === name)).toBe(true);
});
