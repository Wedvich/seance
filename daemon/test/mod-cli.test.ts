import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));

// `mod install` / `mod uninstall` through the real CLI, as a subprocess, for the
// same reason as mcp-cli.test.ts: the argv handed to Claude's plugin CLI is the
// whole product. The stub answers `marketplace remove` with the real CLI's
// not_configured result when nothing is registered — observed on 2.1.295, and
// the one failure uninstall must read as "nothing to do" rather than an error.
describe("seanced mod install/uninstall through the CLI", () => {
  let root: string;
  let recorded: string;
  let checkout: string;
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "seance-mod-cli-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    recorded = join(root, "argv");
    const marker = join(root, "added");
    checkout = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
    await Bun.write(
      join(bin, "claude"),
      // Builtins only: PATH is just the stub dir plus bun's. One record per call,
      // args space-joined — none of them carry spaces here.
      `#!/bin/sh
echo "$*" >> "${recorded}"
if [ "$1 $2 $3" = "plugin marketplace add" ]; then
  echo added > "${marker}"
elif [ "$1 $2 $3" = "plugin marketplace remove" ]; then
  if [ ! -s "${marker}" ]; then
    echo '{"command":"marketplace-remove","outcome":"failed","failureCode":"not_configured"}'
    exit 1
  fi
  : > "${marker}"
fi
exit 0
`,
    );
    await chmod(join(bin, "claude"), 0o755);
    env = { ...process.env, HOME: root, PATH: `${bin}${delimiter}${dirname(process.execPath)}` };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const run = async (...args: string[]): Promise<{ out: string; err: string; code: number; argv: string[] }> => {
    const proc = Bun.spawn([process.execPath, mainPath, "mod", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const argv = await readFile(recorded, "utf8").catch(() => "");
    return { out, err, code, argv: argv.split("\n").filter((line) => line !== "") };
  };

  test("install adds this checkout as the marketplace, then installs every mod it lists", async () => {
    const { out, code, argv } = await run("install");
    expect(code).toBe(0);
    expect(argv).toEqual([
      `plugin marketplace add ${checkout} --scope user --json`,
      "plugin install tmux-rename@seance --scope user",
    ]);
    expect(out).toContain("installed tmux-rename@seance");
  });

  test("a repeat install never removes first — that would delete the mods' saved data", async () => {
    await run("install");
    const { code, argv } = await run("install");
    expect(code).toBe(0);
    expect(argv.filter((line) => line.includes("remove"))).toEqual([]);
  });

  test("uninstall removes the marketplace, and says so only when there was one", async () => {
    const before = await run("uninstall");
    expect(before.code).toBe(0);
    expect(before.out).toContain("nothing installed");

    await run("install");
    const after = await run("uninstall");
    expect(after.code).toBe(0);
    expect(after.out).toContain("removed the seance marketplace");
    expect(after.argv.at(-1)).toBe("plugin marketplace remove seance --json");
  });

  test("an unknown subcommand fails with the usage line and touches nothing", async () => {
    const { err, code, argv } = await run("reinstall");
    expect(code).not.toBe(0);
    expect(err).toContain("usage: seanced mod install");
    expect(argv).toEqual([]);
  });
});
